import { randomBytes } from 'node:crypto';
import { ACTIVE_KEY_STATUS, mysqlErrno } from '@gatemind/database';
import type { KeyManagement } from '@gatemind/ports';
import { Secret, isTenantId } from '@gatemind/types';
import { KEY_BYTES, open, seal, wipe } from './aes-gcm';
import { EncryptionError } from './errors';
import type { TenantKeyDirectory } from './key-storage';

const ER_NO_REFERENCED_ROW = 1452;
const CREATE_ATTEMPTS = 5;

/** Start of every envelope. `gme1` is the format version of the envelope itself. */
export const ENVELOPE_PREFIX = 'gme1';

const CONTEXT_PATTERN = /^[A-Za-z0-9:_./-]{1,128}$/;
const VERSION_PATTERN = /^[1-9][0-9]{0,8}$/;

/**
 * Authenticated context that a wrapped data-encryption key is bound to. Master key rotation uses
 * the same value, so a re-wrapped key still unwraps.
 */
export function dekWrapAad(tenantId: string, keyVersion: number): string {
  return `gatemind:dek:v1:${tenantId}:${keyVersion}`;
}

function valueAad(tenantId: string, keyVersion: number, context: string | undefined): string {
  return `gatemind:value:v1:${tenantId}:${keyVersion}:${context ?? ''}`;
}

export interface EnvelopeOptions {
  /**
   * Binds the ciphertext to what it is for, for example `provider-connection:abc123`. The same
   * context must be given to decrypt. A value copied to another row then fails to decrypt.
   * 1 to 128 characters: letters, digits and `: _ . / -`.
   */
  readonly context?: string;
}

/**
 * Envelope encryption (SEC-011, SEC-012). Every tenant has its own data-encryption key (DEK).
 * A DEK is stored only wrapped by the master key (`KeyManagement`). A ciphertext envelope is the
 * string `gme1.<key version>.<nonce>.<ciphertext+tag>`: the key version identifies the DEK, so
 * keys can be added or rotated without losing old values.
 *
 * There is deliberately no method that returns decrypted data: a value exists in memory only
 * inside the callback of `withDecrypted` or `withSecret`, and the buffer is zeroed afterwards.
 * Nothing in this service logs, and no error contains plaintext, ciphertext or key material.
 */
export interface EnvelopeEncryption {
  /** Encrypts under the tenant's active key, creating the tenant's first key when needed. */
  encrypt(
    tenantId: string,
    plaintext: Secret | Uint8Array,
    options?: EnvelopeOptions,
  ): Promise<string>;

  /**
   * Decrypts and hands the plaintext to `use`. The buffer is zeroed when `use` returns or throws,
   * so `use` must not keep it or return it. A wrong tenant, context, key or tampered envelope
   * fails with `decryption_failed`.
   */
  withDecrypted<T>(
    tenantId: string,
    envelope: string,
    use: (plaintext: Buffer) => T | Promise<T>,
    options?: EnvelopeOptions,
  ): Promise<T>;

  /**
   * Like `withDecrypted` for UTF-8 text. A JavaScript string cannot be zeroed, so prefer
   * `withDecrypted` when the consumer can work with bytes. The `Secret` prints as a redaction
   * marker if it is logged by mistake.
   */
  withSecret<T>(
    tenantId: string,
    envelope: string,
    use: (secret: Secret) => T | Promise<T>,
    options?: EnvelopeOptions,
  ): Promise<T>;

  /** Key version recorded in an envelope, without decrypting it. */
  keyVersionOf(envelope: string): number;
}

export interface EnvelopeEncryptionOptions {
  readonly keyManagement: KeyManagement;
  readonly keyStores: TenantKeyDirectory;
}

interface ParsedEnvelope {
  readonly version: number;
  readonly nonce: string;
  readonly body: string;
}

function parseEnvelope(envelope: string): ParsedEnvelope {
  const parts = typeof envelope === 'string' ? envelope.split('.') : [];
  const [prefix, version, nonce, body] = parts;
  if (
    parts.length !== 4 ||
    prefix !== ENVELOPE_PREFIX ||
    version === undefined ||
    !VERSION_PATTERN.test(version) ||
    !nonce ||
    !body
  ) {
    throw new EncryptionError('invalid_value', 'The envelope has an unknown format');
  }
  return { version: Number(version), nonce, body };
}

function checkTenant(tenantId: string): void {
  if (!isTenantId(tenantId)) {
    throw new EncryptionError('invalid_value', 'The tenant id is not valid');
  }
}

function checkContext(context: string | undefined): string | undefined {
  if (context !== undefined && !CONTEXT_PATTERN.test(context)) {
    throw new EncryptionError('invalid_value', 'The encryption context is not valid');
  }
  return context;
}

export function createEnvelopeEncryption(options: EnvelopeEncryptionOptions): EnvelopeEncryption {
  const { keyManagement, keyStores } = options;

  /** Unwraps a stored DEK. The caller owns the returned buffer and must wipe it. */
  async function unwrapDek(
    tenantId: string,
    key: { version: number; wrappedKey: string },
  ): Promise<Buffer> {
    const dek = await keyManagement.unwrap(key.wrappedKey, dekWrapAad(tenantId, key.version));
    if (dek.length !== KEY_BYTES) {
      wipe(dek);
      throw new EncryptionError('decryption_failed', 'The stored tenant key is not valid');
    }
    return dek;
  }

  /**
   * The tenant's newest active key, created and stored (wrapped) when the tenant has none. When
   * two processes create the first key together, one insert loses (unique version) and that
   * process reads the winner's key instead, so every envelope of a tenant refers to one key.
   */
  async function activeKey(tenantId: string): Promise<{ version: number; dek: Buffer }> {
    const store = keyStores.forTenant(tenantId);
    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
      const active = await store.findActive();
      if (active !== undefined) {
        return { version: active.version, dek: await unwrapDek(tenantId, active) };
      }

      const existing = await store.listAll();
      // Another process may have stored the first key between findActive() and listAll(): use it
      // instead of adding a second active key next to it.
      if (existing.some((key) => key.status === ACTIVE_KEY_STATUS)) continue;
      const version = existing.reduce((highest, key) => Math.max(highest, key.version), 0) + 1;
      const dek = randomBytes(KEY_BYTES);
      try {
        const wrappedKey = await keyManagement.wrap(dek, dekWrapAad(tenantId, version));
        const created = await store.insertIfAbsent({
          version,
          wrappedKey,
          masterKeyId: keyManagement.keyIdOf(wrappedKey),
          status: ACTIVE_KEY_STATUS,
        });
        if (created) return { version, dek };
      } catch (error) {
        wipe(dek);
        if (mysqlErrno(error) === ER_NO_REFERENCED_ROW) {
          throw new EncryptionError('unknown_tenant', 'The tenant does not exist');
        }
        throw error;
      }
      wipe(dek);
    }
    throw new EncryptionError('tenant_key_unavailable', 'The tenant key could not be created');
  }

  async function withDecrypted<T>(
    tenantId: string,
    envelope: string,
    use: (plaintext: Buffer) => T | Promise<T>,
    opts: EnvelopeOptions = {},
  ): Promise<T> {
    checkTenant(tenantId);
    const context = checkContext(opts.context);
    const parsed = parseEnvelope(envelope);

    const stored = await keyStores.forTenant(tenantId).findVersion(parsed.version);
    if (stored === undefined) {
      throw new EncryptionError('unknown_key_version', 'No key exists for the key version');
    }

    const dek = await unwrapDek(tenantId, stored);
    let plaintext: Buffer | undefined;
    try {
      plaintext = open(
        dek,
        { nonce: parsed.nonce, body: parsed.body },
        valueAad(tenantId, parsed.version, context),
      );
      return await use(plaintext);
    } finally {
      wipe(dek, plaintext);
    }
  }

  return {
    async encrypt(tenantId, plaintext, opts = {}) {
      checkTenant(tenantId);
      const context = checkContext(opts.context);

      const { version, dek } = await activeKey(tenantId);
      const bytes =
        plaintext instanceof Secret ? Buffer.from(plaintext.reveal(), 'utf8') : undefined;
      try {
        const sealed = seal(
          dek,
          bytes ?? (plaintext as Uint8Array),
          valueAad(tenantId, version, context),
        );
        return `${ENVELOPE_PREFIX}.${version}.${sealed.nonce}.${sealed.body}`;
      } finally {
        wipe(dek, bytes);
      }
    },

    withDecrypted,

    withSecret(tenantId, envelope, use, opts) {
      return withDecrypted(
        tenantId,
        envelope,
        (bytes) => use(new Secret(bytes.toString('utf8'))),
        opts,
      );
    },

    keyVersionOf(envelope) {
      return parseEnvelope(envelope).version;
    },
  };
}

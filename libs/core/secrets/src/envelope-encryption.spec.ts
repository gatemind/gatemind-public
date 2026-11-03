import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import type { SecretStore } from '@gatemind/ports';
import { Secret } from '@gatemind/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ENVELOPE_PREFIX,
  type EnvelopeEncryption,
  createEnvelopeEncryption,
  dekWrapAad,
} from './envelope-encryption';
import { EncryptionError } from './errors';
import { createLocalKeyManagement, MASTER_KEY_NAME } from './local-key-management';
import { createMemoryTenantKeyDirectory } from './memory-key-store';

/** Story 1.5: envelope encryption with per-tenant keys and key versions (SEC-011, SEC-012). */
const newKey = (): string => randomBytes(32).toString('base64');

function storeWith(values: Record<string, string>): SecretStore {
  return {
    async get(name) {
      const value = values[name];
      return value === undefined ? undefined : new Secret(value);
    },
  };
}

async function setup(tenants: string[] = ['tenant-a', 'tenant-b']) {
  const masterKey = newKey();
  const keyManagement = await createLocalKeyManagement(storeWith({ [MASTER_KEY_NAME]: masterKey }));
  const keyStores = createMemoryTenantKeyDirectory(tenants);
  const envelope = createEnvelopeEncryption({ keyManagement, keyStores });
  return { masterKey, keyManagement, keyStores, envelope };
}

const read = (
  envelope: EnvelopeEncryption,
  tenantId: string,
  value: string,
  context?: string,
): Promise<string> =>
  envelope.withSecret(tenantId, value, (secret) => secret.reveal(), context ? { context } : {});

async function errorOf(action: Promise<unknown>): Promise<EncryptionError> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(EncryptionError);
    return error as EncryptionError;
  }
  throw new Error('Expected the action to fail');
}

describe('envelope encryption', () => {
  it('records the key version in the ciphertext envelope', async () => {
    const { envelope } = await setup();
    const value = await envelope.encrypt('tenant-a', new Secret('sk-provider-key'));

    expect(value.startsWith(`${ENVELOPE_PREFIX}.1.`)).toBe(true);
    expect(envelope.keyVersionOf(value)).toBe(1);
  });

  it('decrypts a value it encrypted, as a Secret and as bytes', async () => {
    const { envelope } = await setup();
    const value = await envelope.encrypt('tenant-a', new Secret('sk-provider-key'));

    expect(await read(envelope, 'tenant-a', value)).toBe('sk-provider-key');
    expect(await envelope.withDecrypted('tenant-a', value, (bytes) => bytes.toString('utf8'))).toBe(
      'sk-provider-key',
    );

    const raw = randomBytes(40);
    const binary = await envelope.encrypt('tenant-a', raw);
    expect(await envelope.withDecrypted('tenant-a', binary, (bytes) => bytes.equals(raw))).toBe(
      true,
    );
  });

  it('does not show the plaintext in the envelope and never repeats a ciphertext', async () => {
    const { envelope } = await setup();
    const plaintext = `PLAINTEXT-${randomBytes(8).toString('hex')}`;
    const first = await envelope.encrypt('tenant-a', new Secret(plaintext));
    const second = await envelope.encrypt('tenant-a', new Secret(plaintext));
    const bytes = Buffer.from(plaintext);

    expect(first).not.toBe(second);
    for (const form of [
      plaintext,
      bytes.toString('base64'),
      bytes.toString('base64url'),
      bytes.toString('hex'),
    ]) {
      expect(first).not.toContain(form);
    }
  });

  it('stores each tenant key only in wrapped form', async () => {
    const { envelope, keyManagement, keyStores } = await setup();
    await envelope.encrypt('tenant-a', new Secret('x'));
    await envelope.encrypt('tenant-b', new Secret('x'));

    const [a] = await keyStores.forTenant('tenant-a').listAll();
    const [b] = await keyStores.forTenant('tenant-b').listAll();
    expect(a?.wrappedKey.startsWith('gmw1.')).toBe(true);
    expect(a?.masterKeyId).toBe(keyManagement.currentKeyId);
    expect(a?.wrappedKey).not.toBe(b?.wrappedKey);

    const dek = await keyManagement.unwrap(a!.wrappedKey, dekWrapAad('tenant-a', 1));
    for (const form of [dek.toString('hex'), dek.toString('base64'), dek.toString('base64url')]) {
      expect(JSON.stringify(a)).not.toContain(form);
    }
  });

  it('keeps tenants apart: another tenant cannot decrypt the value', async () => {
    const { envelope } = await setup();
    const value = await envelope.encrypt('tenant-a', new Secret('only for a'));

    expect((await errorOf(read(envelope, 'tenant-b', value))).code).toBe('unknown_key_version');

    await envelope.encrypt('tenant-b', new Secret('b has its own key now'));
    expect((await errorOf(read(envelope, 'tenant-b', value))).code).toBe('decryption_failed');
  });

  it('binds a value to its context', async () => {
    const { envelope } = await setup();
    const value = await envelope.encrypt('tenant-a', new Secret('key'), {
      context: 'provider-connection:one',
    });

    expect(await read(envelope, 'tenant-a', value, 'provider-connection:one')).toBe('key');
    expect((await errorOf(read(envelope, 'tenant-a', value, 'provider-connection:two'))).code).toBe(
      'decryption_failed',
    );
    expect((await errorOf(read(envelope, 'tenant-a', value))).code).toBe('decryption_failed');
  });

  it('refuses a tampered, truncated or foreign envelope', async () => {
    const { envelope } = await setup();
    const value = await envelope.encrypt('tenant-a', new Secret('secret'));
    const [prefix, version, nonce, body] = value.split('.') as [string, string, string, string];
    const flipped = `${body.startsWith('A') ? 'B' : 'A'}${body.slice(1)}`;

    expect(
      (await errorOf(read(envelope, 'tenant-a', [prefix, version, nonce, flipped].join('.')))).code,
    ).toBe('decryption_failed');
    expect(
      (await errorOf(read(envelope, 'tenant-a', [prefix, '2', nonce, body].join('.')))).code,
    ).toBe('unknown_key_version');
    for (const bad of [
      '',
      'garbage',
      `${prefix}.${version}.${nonce}`,
      `x.${version}.${nonce}.${body}`,
      `${prefix}.0.${nonce}.${body}`,
    ]) {
      expect((await errorOf(read(envelope, 'tenant-a', bad))).code).toBe('invalid_value');
    }
  });

  it('refuses an invalid tenant id or context', async () => {
    const { envelope } = await setup();
    for (const tenant of ['', 'a.b', 'a:b', '../x', 'a b']) {
      expect((await errorOf(envelope.encrypt(tenant, new Secret('x')))).code).toBe('invalid_value');
    }
    for (const context of ['', 'has space', 'x'.repeat(129)]) {
      expect((await errorOf(envelope.encrypt('tenant-a', new Secret('x'), { context }))).code).toBe(
        'invalid_value',
      );
    }
  });

  it('encrypts under the newest active key and still decrypts values of older key versions', async () => {
    const { envelope, keyManagement, keyStores } = await setup();
    const old = await envelope.encrypt('tenant-a', new Secret('old value'));

    const dekV2 = randomBytes(32);
    await keyStores.forTenant('tenant-a').insertIfAbsent({
      version: 2,
      wrappedKey: await keyManagement.wrap(dekV2, dekWrapAad('tenant-a', 2)),
      masterKeyId: keyManagement.currentKeyId,
      status: 'active',
    });

    const fresh = await envelope.encrypt('tenant-a', new Secret('new value'));
    expect(envelope.keyVersionOf(old)).toBe(1);
    expect(envelope.keyVersionOf(fresh)).toBe(2);
    expect(await read(envelope, 'tenant-a', old)).toBe('old value');
    expect(await read(envelope, 'tenant-a', fresh)).toBe('new value');
  });

  it('creates exactly one key when many requests meet a tenant with no key yet', async () => {
    const { envelope, keyStores } = await setup();
    const values = await Promise.all(
      Array.from({ length: 12 }, (_, i) => envelope.encrypt('tenant-b', new Secret(`value-${i}`))),
    );

    expect(await keyStores.forTenant('tenant-b').listAll()).toHaveLength(1);
    expect(values.every((value) => envelope.keyVersionOf(value) === 1)).toBe(true);
    expect(await Promise.all(values.map((value) => read(envelope, 'tenant-b', value)))).toEqual(
      Array.from({ length: 12 }, (_, i) => `value-${i}`),
    );
  });

  it('refuses a tenant that does not exist', async () => {
    const { envelope } = await setup(['tenant-a']);
    expect((await errorOf(envelope.encrypt('ghost', new Secret('x')))).code).toBe('unknown_tenant');
  });

  describe('decrypted values live only while they are used (SEC-012)', () => {
    it('zeroes the plaintext buffer when the callback returns', async () => {
      const { envelope } = await setup();
      const value = await envelope.encrypt('tenant-a', new Secret('zero me after use'));
      let held: Buffer | undefined;

      await envelope.withDecrypted('tenant-a', value, (bytes) => {
        held = bytes;
        expect(bytes.toString('utf8')).toBe('zero me after use');
      });

      expect(held).toBeDefined();
      expect(held!.every((byte) => byte === 0)).toBe(true);
    });

    it('zeroes the plaintext buffer when the callback throws, and passes that error on', async () => {
      const { envelope } = await setup();
      const value = await envelope.encrypt('tenant-a', new Secret('zero me after failure'));
      let held: Buffer | undefined;

      await expect(
        envelope.withDecrypted('tenant-a', value, (bytes) => {
          held = bytes;
          throw new Error('consumer failed');
        }),
      ).rejects.toThrow('consumer failed');

      expect(held!.every((byte) => byte === 0)).toBe(true);
    });

    it('offers no method that returns decrypted data', async () => {
      const { envelope } = await setup();
      expect(Object.keys(envelope).sort()).toEqual([
        'encrypt',
        'keyVersionOf',
        'withDecrypted',
        'withSecret',
      ]);
    });
  });

  describe('canary value', () => {
    afterEach(() => vi.restoreAllMocks());

    it('never appears in logs, errors, telemetry or printed output (SEC-012, SEC-087)', async () => {
      const { envelope, keyManagement, keyStores, masterKey } = await setup();
      const canary = `CANARY-${randomBytes(12).toString('hex')}`;
      const canaryBytes = Buffer.from(canary);

      const captured: string[] = [];
      const record = (...args: unknown[]): void => {
        captured.push(
          args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg, { depth: 6 }))).join(' '),
        );
      };
      const consoleSpies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map(
        (method) => vi.spyOn(console, method).mockImplementation(record),
      );
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        record(String(chunk));
        return true;
      });
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
        record(String(chunk));
        return true;
      });

      // Happy paths and every failure path push the canary through the service.
      const value = await envelope.encrypt('tenant-a', new Secret(canary), { context: 'canary:1' });
      await envelope.encrypt('tenant-b', new Secret('b'));
      const failures: unknown[] = [];
      for (const attempt of [
        () => envelope.withSecret('tenant-b', value, (s) => s.reveal(), { context: 'canary:1' }),
        () => envelope.withSecret('tenant-a', value, (s) => s.reveal(), { context: 'canary:2' }),
        () =>
          envelope.withSecret('tenant-a', `${value}x`, (s) => s.reveal(), { context: 'canary:1' }),
        () =>
          envelope.withSecret('tenant-a', value.replace('.1.', '.9.'), (s) => s.reveal(), {
            context: 'canary:1',
          }),
        () => envelope.encrypt('ghost', new Secret(canary)),
      ]) {
        failures.push(
          await attempt().then(
            () => undefined,
            (error: unknown) => error,
          ),
        );
      }
      let revealed = '';
      let printed: string[] = [];
      await envelope.withSecret(
        'tenant-a',
        value,
        (secret) => {
          revealed = secret.reveal();
          printed = [String(secret), JSON.stringify({ secret }), inspect(secret), `${secret}`];
        },
        { context: 'canary:1' },
      );

      expect(revealed).toBe(canary);
      expect(failures.every((failure) => failure instanceof EncryptionError)).toBe(true);

      const [stored] = await keyStores.forTenant('tenant-a').listAll();
      const dek = await keyManagement.unwrap(stored!.wrappedKey, dekWrapAad('tenant-a', 1));
      const forbidden = [
        canary,
        canaryBytes.toString('base64'),
        canaryBytes.toString('base64url'),
        canaryBytes.toString('hex'),
        masterKey,
        Buffer.from(masterKey, 'base64').toString('hex'),
        dek.toString('hex'),
        dek.toString('base64'),
        dek.toString('base64url'),
      ];
      const outputs = [
        ...captured,
        ...printed,
        ...failures.flatMap((failure) => {
          const error = failure as EncryptionError;
          return [
            error.message,
            String(error),
            inspect(error, { depth: 6 }),
            JSON.stringify(error),
            error.stack ?? '',
          ];
        }),
      ];

      for (const output of outputs) {
        for (const secret of forbidden) expect(output).not.toContain(secret);
      }
      for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    });
  });
});

import { createHmac, hkdfSync } from 'node:crypto';
import { MIN_MASTER_KEY_BYTES } from '@gatemind/config';
import type { KeyManagement, SecretStore } from '@gatemind/ports';
import type { Secret } from '@gatemind/types';
import { KEY_BYTES, open, seal, wipe } from './aes-gcm';
import { EncryptionError } from './errors';

/** Secret names read through the `SecretStore` (`GATEMIND_<NAME>` or `GATEMIND_<NAME>_FILE`). */
export const MASTER_KEY_NAME = 'MASTER_KEY';
export const PREVIOUS_MASTER_KEY_NAME = 'MASTER_KEY_PREVIOUS';

const WRAP_PREFIX = 'gmw1';
const HKDF_SALT = Buffer.from('gatemind-master-key-v1', 'utf8');
const KEY_ID_LABEL = 'gatemind:master-key-id:v1';

interface MasterKey {
  readonly id: string;
  readonly kek: Buffer;
}

function decodeMasterKey(secret: Secret, label: string): Buffer {
  const value = secret.reveal();
  const decoded = /^[A-Za-z0-9+/_-]+={0,2}$/.test(value) ? Buffer.from(value, 'base64') : undefined;
  if (decoded === undefined || decoded.length < MIN_MASTER_KEY_BYTES) {
    throw new EncryptionError(
      'invalid_master_key',
      `${label} must be base64 text for at least ${MIN_MASTER_KEY_BYTES} bytes`,
    );
  }
  return decoded;
}

/**
 * The master key id is a fingerprint (first 8 bytes of an HMAC under the key), so the key itself
 * cannot be recovered from it. It identifies which key wrapped a value, with no version numbers
 * for the Operator to keep in step with the key (`[PROPOSED]`).
 */
function deriveMasterKey(secret: Secret, label: string): MasterKey {
  const material = decodeMasterKey(secret, label);
  try {
    const kek = Buffer.from(
      hkdfSync('sha256', material, HKDF_SALT, 'gatemind:wrap-key', KEY_BYTES),
    );
    const id = createHmac('sha256', material).update(KEY_ID_LABEL).digest('hex').slice(0, 16);
    return { id, kek };
  } finally {
    wipe(material);
  }
}

/**
 * Self-hosted key management (SEC-011 baseline). The master key comes from the `SecretStore`;
 * it is never written anywhere. `MASTER_KEY_PREVIOUS` is optional and only used during a
 * rotation so values wrapped under the old key can still be unwrapped and re-wrapped.
 *
 * Wrapped value format: `gmw1.<master key id>.<nonce>.<ciphertext+tag>` (base64url parts).
 */
export async function createLocalKeyManagement(secretStore: SecretStore): Promise<KeyManagement> {
  const current = await secretStore.get(MASTER_KEY_NAME);
  if (current === undefined) {
    throw new EncryptionError('missing_master_key', 'The master key is not configured');
  }
  const previous = await secretStore.get(PREVIOUS_MASTER_KEY_NAME);

  const currentKey = deriveMasterKey(current, 'The master key');
  const keys = new Map<string, MasterKey>([[currentKey.id, currentKey]]);
  if (previous !== undefined) {
    const previousKey = deriveMasterKey(previous, 'The previous master key');
    if (!keys.has(previousKey.id)) keys.set(previousKey.id, previousKey);
  }

  const parse = (wrapped: string): { keyId: string; nonce: string; body: string } => {
    const parts = wrapped.split('.');
    const [prefix, keyId, nonce, body] = parts;
    if (parts.length !== 4 || prefix !== WRAP_PREFIX || !keyId || !nonce || !body) {
      throw new EncryptionError('invalid_value', 'The wrapped key has an unknown format');
    }
    return { keyId, nonce, body };
  };

  return {
    currentKeyId: currentKey.id,

    async wrap(plaintext, aad) {
      const sealed = seal(currentKey.kek, plaintext, aad);
      return `${WRAP_PREFIX}.${currentKey.id}.${sealed.nonce}.${sealed.body}`;
    },

    async unwrap(wrapped, aad) {
      const { keyId, nonce, body } = parse(wrapped);
      const key = keys.get(keyId);
      if (key === undefined) {
        throw new EncryptionError(
          'unknown_master_key',
          `No configured master key matches key id ${keyId}. Set the matching key as ` +
            `GATEMIND_${PREVIOUS_MASTER_KEY_NAME}, or restore it. Without it these values cannot be recovered`,
        );
      }
      return open(key.kek, { nonce, body }, aad);
    },

    keyIdOf(wrapped) {
      return parse(wrapped).keyId;
    },
  };
}

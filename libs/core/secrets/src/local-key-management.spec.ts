import { randomBytes } from 'node:crypto';
import type { SecretStore } from '@gatemind/ports';
import { Secret } from '@gatemind/types';
import { describe, expect, it } from 'vitest';
import { EncryptionError } from './errors';
import {
  MASTER_KEY_NAME,
  PREVIOUS_MASTER_KEY_NAME,
  createLocalKeyManagement,
} from './local-key-management';

/** Story 1.5: master key handling behind the `KeyManagement` port (SEC-011). */
const newKey = (): string => randomBytes(32).toString('base64');

function storeWith(values: Record<string, string>): SecretStore {
  return {
    async get(name) {
      const value = values[name];
      return value === undefined ? undefined : new Secret(value);
    },
  };
}

async function errorOf(action: Promise<unknown>): Promise<EncryptionError> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(EncryptionError);
    return error as EncryptionError;
  }
  throw new Error('Expected the action to fail');
}

const plaintext = randomBytes(32);

describe('local key management', () => {
  it('refuses to work without a master key', async () => {
    const error = await errorOf(createLocalKeyManagement(storeWith({})));
    expect(error.code).toBe('missing_master_key');
  });

  it.each([
    ['not base64 text', 'this is not base64 !!!'],
    ['fewer than 32 bytes', randomBytes(16).toString('base64')],
  ])('refuses a master key that is %s, without printing it', async (_label, value) => {
    const error = await errorOf(createLocalKeyManagement(storeWith({ [MASTER_KEY_NAME]: value })));
    expect(error.code).toBe('invalid_master_key');
    expect(error.message).not.toContain(value);
  });

  it('refuses an invalid previous master key too', async () => {
    const error = await errorOf(
      createLocalKeyManagement(
        storeWith({ [MASTER_KEY_NAME]: newKey(), [PREVIOUS_MASTER_KEY_NAME]: 'short' }),
      ),
    );
    expect(error.code).toBe('invalid_master_key');
  });

  it('wraps and unwraps a key, and the wrapped form names the master key that made it', async () => {
    const keys = await createLocalKeyManagement(storeWith({ [MASTER_KEY_NAME]: newKey() }));
    const wrapped = await keys.wrap(plaintext, 'tenant-a:1');

    expect(wrapped.split('.')).toHaveLength(4);
    expect(wrapped.startsWith(`gmw1.${keys.currentKeyId}.`)).toBe(true);
    expect(keys.keyIdOf(wrapped)).toBe(keys.currentKeyId);
    expect((await keys.unwrap(wrapped, 'tenant-a:1')).equals(plaintext)).toBe(true);
  });

  it('never wraps the same key to the same text twice', async () => {
    const keys = await createLocalKeyManagement(storeWith({ [MASTER_KEY_NAME]: newKey() }));
    expect(await keys.wrap(plaintext, 'x')).not.toBe(await keys.wrap(plaintext, 'x'));
  });

  it('only unwraps with the context it was wrapped with', async () => {
    const keys = await createLocalKeyManagement(storeWith({ [MASTER_KEY_NAME]: newKey() }));
    const wrapped = await keys.wrap(plaintext, 'tenant-a:1');

    expect((await errorOf(keys.unwrap(wrapped, 'tenant-b:1'))).code).toBe('decryption_failed');
    expect((await errorOf(keys.unwrap(wrapped, 'tenant-a:2'))).code).toBe('decryption_failed');
  });

  it('detects a changed wrapped value and refuses an unknown format', async () => {
    const keys = await createLocalKeyManagement(storeWith({ [MASTER_KEY_NAME]: newKey() }));
    const wrapped = await keys.wrap(plaintext, 'a');
    const [prefix, id, nonce, body] = wrapped.split('.') as [string, string, string, string];
    const flipped = `${body.startsWith('A') ? 'B' : 'A'}${body.slice(1)}`;

    expect((await errorOf(keys.unwrap([prefix, id, nonce, flipped].join('.'), 'a'))).code).toBe(
      'decryption_failed',
    );
    expect((await errorOf(keys.unwrap('not-a-wrapped-key', 'a'))).code).toBe('invalid_value');
    expect(() => keys.keyIdOf('gmw1.only.three')).toThrow(EncryptionError);
  });

  it('identifies a master key by a fingerprint that does not reveal it', async () => {
    const key = newKey();
    const first = await createLocalKeyManagement(storeWith({ [MASTER_KEY_NAME]: key }));
    const again = await createLocalKeyManagement(storeWith({ [MASTER_KEY_NAME]: key }));
    const other = await createLocalKeyManagement(storeWith({ [MASTER_KEY_NAME]: newKey() }));

    expect(first.currentKeyId).toMatch(/^[0-9a-f]{16}$/);
    expect(again.currentKeyId).toBe(first.currentKeyId);
    expect(other.currentKeyId).not.toBe(first.currentKeyId);
    const keyBytes = Buffer.from(key, 'base64');
    for (const form of [key, keyBytes.toString('hex'), keyBytes.toString('base64url')]) {
      expect(first.currentKeyId).not.toContain(form);
    }
  });

  describe('master key rotation support', () => {
    it('unwraps values of the previous key while wrapping with the new one', async () => {
      const oldKey = newKey();
      const oldKeys = await createLocalKeyManagement(storeWith({ [MASTER_KEY_NAME]: oldKey }));
      const wrappedByOld = await oldKeys.wrap(plaintext, 'ctx');

      const rotated = await createLocalKeyManagement(
        storeWith({ [MASTER_KEY_NAME]: newKey(), [PREVIOUS_MASTER_KEY_NAME]: oldKey }),
      );

      expect(rotated.currentKeyId).not.toBe(oldKeys.currentKeyId);
      expect(rotated.keyIdOf(wrappedByOld)).toBe(oldKeys.currentKeyId);
      expect((await rotated.unwrap(wrappedByOld, 'ctx')).equals(plaintext)).toBe(true);
      expect(rotated.keyIdOf(await rotated.wrap(plaintext, 'ctx'))).toBe(rotated.currentKeyId);
    });

    it('says what to do when the key that wrapped a value is not configured, without printing keys', async () => {
      const oldKey = newKey();
      const newerKey = newKey();
      const oldKeys = await createLocalKeyManagement(storeWith({ [MASTER_KEY_NAME]: oldKey }));
      const wrappedByOld = await oldKeys.wrap(plaintext, 'ctx');
      const keys = await createLocalKeyManagement(storeWith({ [MASTER_KEY_NAME]: newerKey }));

      const error = await errorOf(keys.unwrap(wrappedByOld, 'ctx'));

      expect(error.code).toBe('unknown_master_key');
      expect(error.message).toContain(`GATEMIND_${PREVIOUS_MASTER_KEY_NAME}`);
      expect(error.message).toContain(oldKeys.currentKeyId);
      expect(error.message).not.toContain(oldKey);
      expect(error.message).not.toContain(newerKey);
    });
  });
});

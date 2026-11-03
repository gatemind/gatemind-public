import { timingSafeEqual } from 'node:crypto';
import type { KeyManagement } from '@gatemind/ports';
import { wipe } from './aes-gcm';
import { dekWrapAad } from './envelope-encryption';
import { EncryptionError } from './errors';
import type { TenantKeyDirectory } from './key-storage';

export interface MasterKeyRotationOptions {
  /** Wraps with the NEW master key and still unwraps with the previous one (`MASTER_KEY_PREVIOUS`). */
  readonly keyManagement: KeyManagement;
  readonly keyStores: TenantKeyDirectory;
}

export interface MasterKeyRotationResult {
  readonly tenants: number;
  /** Data-encryption keys looked at. */
  readonly keys: number;
  /** Keys that were wrapped by another master key and are now wrapped by the current one. */
  readonly rewrapped: number;
  /** Keys that were already wrapped by the current master key. */
  readonly alreadyCurrent: number;
}

/**
 * Master key rotation (SEC-011): re-wraps every tenant's data-encryption keys with the current
 * master key. Only the small wrapped keys change; no stored ciphertext is touched or
 * re-encrypted, and every value encrypted before still decrypts afterwards.
 *
 * Each key is unwrapped, wrapped again, checked by unwrapping the new form and comparing, and
 * only then stored. The run is safe to repeat and to resume: a key that is already current is
 * skipped, so a run that stopped half way continues where it stopped. A second run that reports
 * `rewrapped: 0` proves that nothing still depends on the previous master key. It stops at the
 * first failure (for example `unknown_master_key` when the previous key is not configured), and
 * keys it had already re-wrapped stay re-wrapped.
 */
export async function rotateMasterKey(
  options: MasterKeyRotationOptions,
): Promise<MasterKeyRotationResult> {
  const { keyManagement, keyStores } = options;
  const currentKeyId = keyManagement.currentKeyId;

  let tenants = 0;
  let keys = 0;
  let rewrapped = 0;
  let alreadyCurrent = 0;

  for (const tenantId of await keyStores.listTenantIds()) {
    tenants += 1;
    const store = keyStores.forTenant(tenantId);

    for (const key of await store.listAll()) {
      keys += 1;
      const wrappedId = keyManagement.keyIdOf(key.wrappedKey);
      if (wrappedId === currentKeyId && key.masterKeyId === currentKeyId) {
        alreadyCurrent += 1;
        continue;
      }

      const aad = dekWrapAad(tenantId, key.version);
      const dek = await keyManagement.unwrap(key.wrappedKey, aad);
      let check: Buffer | undefined;
      try {
        const newWrapped = await keyManagement.wrap(dek, aad);
        check = await keyManagement.unwrap(newWrapped, aad);
        if (check.length !== dek.length || !timingSafeEqual(check, dek)) {
          throw new EncryptionError(
            'decryption_failed',
            'A re-wrapped key did not unwrap to the same key; it was not stored',
          );
        }
        await store.replaceWrapped(key.version, newWrapped, keyManagement.keyIdOf(newWrapped));
        rewrapped += 1;
      } finally {
        wipe(dek, check);
      }
    }
  }

  return { tenants, keys, rewrapped, alreadyCurrent };
}

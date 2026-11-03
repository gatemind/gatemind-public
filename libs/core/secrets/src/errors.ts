export type EncryptionErrorCode =
  | 'invalid_master_key'
  | 'missing_master_key'
  | 'unknown_master_key'
  | 'invalid_value'
  | 'unknown_key_version'
  | 'unknown_tenant'
  | 'tenant_key_unavailable'
  | 'decryption_failed';

/**
 * Raised by key management and envelope encryption. Messages are fixed text: they never contain
 * plaintext, key material, ciphertext or the value that failed (SEC-012, SEC-087).
 */
export class EncryptionError extends Error {
  readonly code: EncryptionErrorCode;

  constructor(code: EncryptionErrorCode, message: string) {
    super(message);
    this.name = 'EncryptionError';
    this.code = code;
  }
}

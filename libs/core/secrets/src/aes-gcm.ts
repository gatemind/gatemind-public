import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EncryptionError } from './errors';

const ALGORITHM = 'aes-256-gcm';
export const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface Sealed {
  /** base64url nonce */
  readonly nonce: string;
  /** base64url ciphertext followed by the 16-byte authentication tag */
  readonly body: string;
}

/** Zeroes a buffer. Best effort: a JavaScript runtime cannot guarantee zeroization (SEC-012). */
export function wipe(...buffers: (Buffer | undefined)[]): void {
  for (const buffer of buffers) buffer?.fill(0);
}

/** AES-256-GCM with a fresh random 96-bit nonce. `aad` is authenticated but not stored. */
export function seal(key: Buffer, plaintext: Uint8Array, aad: string): Sealed {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    nonce: nonce.toString('base64url'),
    body: Buffer.concat([ciphertext, tag]).toString('base64url'),
  };
}

/** Returns the plaintext, or throws `decryption_failed` for any wrong key, aad or tampering. */
export function open(key: Buffer, sealed: Sealed, aad: string): Buffer {
  const nonce = Buffer.from(sealed.nonce, 'base64url');
  const body = Buffer.from(sealed.body, 'base64url');
  if (nonce.length !== NONCE_BYTES || body.length < TAG_BYTES) {
    throw new EncryptionError('decryption_failed', 'The value could not be decrypted');
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(body.subarray(0, body.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    throw new EncryptionError('decryption_failed', 'The value could not be decrypted');
  }
}

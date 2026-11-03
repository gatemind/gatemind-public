/**
 * Wraps and unwraps data-encryption keys (DEKs) with a master key (SEC-011, ARC-055).
 * The self-hosted implementation uses a master key from the `SecretStore`; another
 * implementation can delegate to an external KMS without changing any caller.
 *
 * Wrapped values are opaque strings that carry the id of the master key that produced them,
 * so after a master key rotation old and new values can be told apart and re-wrapped.
 * `aad` is authenticated context (for example tenant and key version): a wrapped value only
 * unwraps with the same `aad` it was wrapped with.
 * Implementations never log or include key material in an error.
 */
export interface KeyManagement {
  /** Id of the master key used for new wrapping. Not secret, safe to log. */
  readonly currentKeyId: string;
  wrap(plaintext: Uint8Array, aad: string): Promise<string>;
  /** Returns a new Buffer. The caller should `fill(0)` it when done. */
  unwrap(wrapped: string, aad: string): Promise<Buffer>;
  /** Master key id recorded in a wrapped value, without unwrapping it. */
  keyIdOf(wrapped: string): string;
}

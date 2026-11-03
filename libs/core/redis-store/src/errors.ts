export type RedisStoreErrorCode =
  'invalid_url' | 'same_instance' | 'unreachable' | 'queue_may_evict' | 'unsupported_reply';

/**
 * Raised when the Redis-compatible stores cannot be opened safely. Messages name the store and the
 * problem and never contain a URL, a host or a password (SEC-012, SEC-087).
 */
export class RedisStoreError extends Error {
  readonly code: RedisStoreErrorCode;

  constructor(code: RedisStoreErrorCode, message: string) {
    super(message);
    this.name = 'RedisStoreError';
    this.code = code;
  }
}

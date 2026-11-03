import { CompositionError } from '@gatemind/composition';
import { SecretSourceError } from '@gatemind/config';
import { RedisStoreError } from '@gatemind/redis-store';

/**
 * One line for the operator when startup fails. Only errors whose messages are safe by contract
 * (they name a setting or a store, never a value, a URL or a password) are shown; anything else
 * shows its type name only.
 */
export function describeStartupError(error: unknown): string {
  if (
    error instanceof CompositionError ||
    error instanceof RedisStoreError ||
    error instanceof SecretSourceError
  ) {
    return error.message;
  }
  if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
    return 'The HTTP port is already in use (EADDRINUSE)';
  }
  if (error instanceof Error && 'code' in error && error.code === 'EACCES') {
    return 'The HTTP port cannot be opened without more privileges (EACCES)';
  }
  const name = error instanceof Error ? error.name : 'unknown error';
  return `Unexpected ${name}. Run with GATEMIND_LOG_LEVEL=debug for more detail`;
}

import type { Secret } from '@gatemind/types';

/**
 * Source of secrets such as the master key (SEC-011, ARC-055).
 * Implementations read from a file, a secret mount or the environment.
 * `name` is a logical name such as `MASTER_KEY`, never a path or a variable name.
 * Returns `undefined` when the secret is not configured. Implementations must never log
 * or include a secret value in an error.
 */
export interface SecretStore {
  get(name: string): Promise<Secret | undefined>;
}

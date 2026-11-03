import { readFile } from 'node:fs/promises';
import type { SecretStore } from '@gatemind/ports';
import { Secret } from '@gatemind/types';

export const ENV_PREFIX = 'GATEMIND_';

/** Raised when a secret source is misconfigured. Messages never contain secret values. */
export class SecretSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretSourceError';
  }
}

export interface EnvFileSecretStoreOptions {
  env: Readonly<Record<string, string | undefined>>;
  /** Injected for tests. Defaults to reading a UTF-8 file from disk. */
  readTextFile?: (path: string) => Promise<string>;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * Reads a secret from `GATEMIND_<NAME>` (environment) or from the file named by
 * `GATEMIND_<NAME>_FILE` (file or secret mount). Setting both is refused so the operator
 * always knows which source is in use (SEC-011).
 */
export function createEnvFileSecretStore(options: EnvFileSecretStoreOptions): SecretStore {
  const { env } = options;
  const readTextFile = options.readTextFile ?? ((path: string) => readFile(path, 'utf8'));

  return {
    async get(name: string): Promise<Secret | undefined> {
      if (!/^[A-Z0-9_]+$/.test(name)) {
        throw new SecretSourceError(
          'Secret names must be upper-case letters, digits and underscores',
        );
      }
      const variable = `${ENV_PREFIX}${name}`;
      const fileVariable = `${variable}_FILE`;
      const direct = clean(env[variable]);
      const filePath = clean(env[fileVariable]);

      if (direct !== undefined && filePath !== undefined) {
        throw new SecretSourceError(`Set only one of ${variable} and ${fileVariable}`);
      }
      if (filePath !== undefined) {
        let content: string;
        try {
          content = await readTextFile(filePath);
        } catch (error) {
          const code = (error as { code?: unknown }).code;
          const reason = typeof code === 'string' ? code : 'unknown error';
          throw new SecretSourceError(`Cannot read the file named by ${fileVariable} (${reason})`);
        }
        const fromFile = clean(content);
        return fromFile === undefined ? undefined : new Secret(fromFile);
      }
      return direct === undefined ? undefined : new Secret(direct);
    },
  };
}

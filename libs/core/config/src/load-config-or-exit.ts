import type { SecretStore } from '@gatemind/ports';
import { type AppConfig, ConfigError, loadConfig } from './config';
import { createEnvFileSecretStore } from './env-file-secret-store';

export interface LoadConfigOrExitOptions {
  env?: Readonly<Record<string, string | undefined>>;
  secretStore?: SecretStore;
  /** Injected for tests. Defaults to writing to standard error. */
  writeError?: (text: string) => void;
  /** Injected for tests. Defaults to `process.exit`. */
  exit?: (code: number) => never;
}

/**
 * Entrypoint helper: returns the validated configuration, or prints every problem once and
 * exits non-zero (FR-1). Output names the failing setting and never a secret value.
 */
export async function loadConfigOrExit(options: LoadConfigOrExitOptions = {}): Promise<AppConfig> {
  const env = options.env ?? process.env;
  const secretStore = options.secretStore ?? createEnvFileSecretStore({ env });
  const writeError = options.writeError ?? ((text: string) => void process.stderr.write(text));
  const exit = options.exit ?? ((code: number) => process.exit(code));

  try {
    return await loadConfig({ env, secretStore });
  } catch (error) {
    if (error instanceof ConfigError) {
      writeError(`Gatemind cannot start. ${error.message}\n`);
    } else {
      writeError('Gatemind cannot start: configuration could not be loaded.\n');
    }
    return exit(1);
  }
}

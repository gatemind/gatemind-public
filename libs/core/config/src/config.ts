import type { SecretStore } from '@gatemind/ports';
import type { Secret } from '@gatemind/types';
import { ENV_PREFIX } from './env-file-secret-store';
import { isInsecurePlaceholder } from './insecure-placeholder';

export const RUNTIME_MODES = ['production', 'development', 'test'] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const MIN_MASTER_KEY_BYTES = 32;
const MASTER_KEY_NAME = 'MASTER_KEY';
const MASTER_KEY_HELP = `${ENV_PREFIX}${MASTER_KEY_NAME} or ${ENV_PREFIX}${MASTER_KEY_NAME}_FILE`;

export interface AppConfig {
  readonly mode: RuntimeMode;
  readonly logLevel: LogLevel;
  readonly httpPort: number;
  /** How long in-flight requests may finish after a termination signal, in ms (REL-008). */
  readonly shutdownGraceMs: number;
  /** Wrapped so it cannot leak through logs, JSON or inspect output (SEC-012). */
  readonly masterKey: Secret;
}

/** Thrown once with every configuration problem found. Messages never contain secret values. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export interface LoadConfigInput {
  env: Readonly<Record<string, string | undefined>>;
  secretStore: SecretStore;
}

function readEnum<T extends string>(
  env: LoadConfigInput['env'],
  name: string,
  allowed: readonly T[],
  fallback: T,
  problems: string[],
): T {
  const variable = `${ENV_PREFIX}${name}`;
  const raw = env[variable]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  problems.push(`${variable} must be one of: ${allowed.join(', ')}`);
  return fallback;
}

function readPort(env: LoadConfigInput['env'], problems: string[]): number {
  const variable = `${ENV_PREFIX}HTTP_PORT`;
  const raw = env[variable]?.trim();
  if (raw === undefined || raw === '') return 8080;
  if (/^\d+$/.test(raw)) {
    const port = Number(raw);
    if (port >= 1 && port <= 65535) return port;
  }
  problems.push(`${variable} must be an integer from 1 to 65535`);
  return 8080;
}

export const DEFAULT_SHUTDOWN_GRACE_SECONDS = 30;
export const MAX_SHUTDOWN_GRACE_SECONDS = 600;

/** `GATEMIND_SHUTDOWN_GRACE_SECONDS` `[PROPOSED]`: whole seconds from 1 to 600, default 30. */
function readShutdownGraceMs(env: LoadConfigInput['env'], problems: string[]): number {
  const variable = `${ENV_PREFIX}SHUTDOWN_GRACE_SECONDS`;
  const raw = env[variable]?.trim();
  if (raw === undefined || raw === '') return DEFAULT_SHUTDOWN_GRACE_SECONDS * 1000;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    if (seconds >= 1 && seconds <= MAX_SHUTDOWN_GRACE_SECONDS) return seconds * 1000;
  }
  problems.push(
    `${variable} must be a whole number of seconds from 1 to ${MAX_SHUTDOWN_GRACE_SECONDS}`,
  );
  return DEFAULT_SHUTDOWN_GRACE_SECONDS * 1000;
}

/** Master key rule `[PROPOSED]`: base64 text that decodes to at least 32 bytes. */
function isValidMasterKeyFormat(value: string): boolean {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return false;
  return Buffer.from(value, 'base64').length >= MIN_MASTER_KEY_BYTES;
}

/**
 * Validates configuration once and reports every problem together (FR-1, SEC-011, SEC-080).
 * - Mode defaults to production, so a missing setting never selects a weaker mode.
 * - The master key is required in every mode.
 * - Known placeholders and trivially weak keys are refused in production.
 */
export async function loadConfig(input: LoadConfigInput): Promise<AppConfig> {
  const { env, secretStore } = input;
  const problems: string[] = [];

  const mode = readEnum(env, 'ENV', RUNTIME_MODES, 'production', problems);
  const logLevel = readEnum(env, 'LOG_LEVEL', LOG_LEVELS, 'info', problems);
  const httpPort = readPort(env, problems);
  const shutdownGraceMs = readShutdownGraceMs(env, problems);

  let masterKey: Secret | undefined;
  try {
    masterKey = await secretStore.get(MASTER_KEY_NAME);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : 'The master key source is unreadable');
  }

  if (masterKey === undefined) {
    if (!problems.some((p) => p.includes(`${ENV_PREFIX}${MASTER_KEY_NAME}`))) {
      problems.push(`The master key is missing. Set ${MASTER_KEY_HELP}`);
    }
  } else {
    const value = masterKey.reveal();
    if (!isValidMasterKeyFormat(value)) {
      problems.push(
        `The master key must be base64 text for at least ${MIN_MASTER_KEY_BYTES} bytes ` +
          '(generate one with: openssl rand -base64 32)',
      );
    } else if (mode === 'production' && isInsecurePlaceholder(value)) {
      problems.push(
        'The master key is a known placeholder or a weak value, which production refuses. ' +
          'Generate a new one with: openssl rand -base64 32',
      );
    }
  }

  if (problems.length > 0 || masterKey === undefined) {
    throw new ConfigError(problems);
  }
  return { mode, logLevel, httpPort, shutdownGraceMs, masterKey };
}

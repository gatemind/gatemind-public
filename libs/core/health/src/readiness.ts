/**
 * A dependency check answers "can this dependency serve a request right now?". It should never
 * reject, but the checker treats a rejection exactly like `false`.
 */
export type DependencyCheck = () => Promise<boolean>;

export type DependencyStatus = 'up' | 'down';

export interface HealthReport {
  /** True only when every required dependency is up. */
  readonly ready: boolean;
  /** One entry per dependency, by its fixed name. Never an address, a URL or an error text. */
  readonly dependencies: Readonly<Record<string, DependencyStatus>>;
}

export interface ReadinessChecker {
  check(): Promise<HealthReport>;
}

export interface ReadinessCheckerOptions {
  /** Dependency name to check. Names are fixed identifiers such as `database` or `cache`. */
  readonly checks: Readonly<Record<string, DependencyCheck>>;
  /** A check slower than this counts as down. Default 2000 ms. */
  readonly timeoutMs?: number;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 2000;
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

async function runCheck(check: DependencyCheck, timeoutMs: number): Promise<DependencyStatus> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<DependencyStatus>((resolve) => {
    timer = setTimeout(() => resolve('down'), timeoutMs);
    timer.unref();
  });
  const answer = (async (): Promise<DependencyStatus> => {
    try {
      return (await check()) === true ? 'up' : 'down';
    } catch {
      // The reason is deliberately dropped: an error text can hold a host or a password.
      return 'down';
    }
  })();
  try {
    return await Promise.race([answer, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Runs every dependency check in parallel, each with its own timeout (REL-001). The result is a
 * name and `up` or `down`, so a response built from it cannot reveal a secret or a setting.
 */
export function createReadinessChecker(options: ReadinessCheckerOptions): ReadinessChecker {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('The check timeout must be a positive number of milliseconds');
  }
  const entries = Object.entries(options.checks);
  for (const [name] of entries) {
    if (!NAME_PATTERN.test(name)) {
      throw new TypeError('Dependency names must be lower-case letters, digits and underscores');
    }
  }

  return {
    async check(): Promise<HealthReport> {
      const statuses = await Promise.all(
        entries.map(async ([name, check]) => [name, await runCheck(check, timeoutMs)] as const),
      );
      const dependencies = Object.fromEntries(statuses) as Record<string, DependencyStatus>;
      return { ready: statuses.every(([, status]) => status === 'up'), dependencies };
    },
  };
}

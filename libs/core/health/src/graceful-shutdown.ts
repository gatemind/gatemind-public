/** The part of `http.Server` that shutdown needs. Declared here so tests can pass a fake. */
export interface ClosableServer {
  close(callback?: (error?: Error) => void): unknown;
  closeIdleConnections(): void;
  closeAllConnections(): void;
}

export interface GracefulShutdownOptions {
  readonly server: ClosableServer;
  /** In-flight requests get this long to finish before connections are cut. Must be positive. */
  readonly gracePeriodMs: number;
  /** Pause between "readiness fails" and "stop accepting", so a load balancer can notice. */
  readonly drainDelayMs?: number;
  /** Closes the database, the stores and anything else holding a connection. */
  readonly closeResources: () => Promise<void>;
  readonly exit: (code: number) => void;
  /** Receives fixed sentences only: never a value, an address or an error text. */
  readonly log?: (message: string) => void;
}

export interface GracefulShutdown {
  /** True from the first call to `shutdown`. Wire it to the readiness check. */
  isShuttingDown(): boolean;
  /**
   * Starts shutdown once. Later calls return the same promise.
   * 1. readiness fails; 2. the server stops accepting; 3. in-flight requests finish within the
   * grace period; 4. connections close; 5. the process exits 0.
   * If the grace period runs out, remaining connections are cut and the exit code is 1, so an
   * operator can tell a clean stop from a forced one (REL-008).
   */
  shutdown(reason: string): Promise<void>;
  /** Listens for the signals and returns a function that removes the listeners. */
  install(signals?: readonly NodeJS.Signals[]): () => void;
}

const IDLE_SWEEP_MS = 25;

export function createGracefulShutdown(options: GracefulShutdownOptions): GracefulShutdown {
  const { server, closeResources, exit } = options;
  const log = options.log ?? (() => undefined);
  const drainDelayMs = options.drainDelayMs ?? 0;
  if (!Number.isFinite(options.gracePeriodMs) || options.gracePeriodMs <= 0) {
    throw new TypeError('The grace period must be a positive number of milliseconds');
  }
  if (!Number.isFinite(drainDelayMs) || drainDelayMs < 0) {
    throw new TypeError('The drain delay must be zero or a positive number of milliseconds');
  }

  let started: Promise<void> | undefined;

  async function run(): Promise<void> {
    log('Shutdown started. Readiness now fails.');
    if (drainDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, drainDelayMs));

    const stopped = new Promise<void>((resolve) => {
      // An error here means the server was not listening: nothing is left to wait for.
      server.close(() => resolve());
    });

    let forced = false;
    let finished = false;
    void stopped.then(() => {
      finished = true;
    });
    // A keep-alive connection becomes idle only after its response ends, so sweep repeatedly.
    const sweeper = setInterval(() => {
      if (!finished) server.closeIdleConnections();
    }, IDLE_SWEEP_MS);
    sweeper.unref();
    server.closeIdleConnections();

    let graceTimer: NodeJS.Timeout | undefined;
    const graceExpired = new Promise<void>((resolve) => {
      graceTimer = setTimeout(() => {
        if (!finished) {
          forced = true;
          log('Grace period ended. Remaining connections are closed.');
          server.closeAllConnections();
        }
        resolve();
      }, options.gracePeriodMs);
      graceTimer.unref();
    });

    await Promise.race([stopped, graceExpired]);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    clearInterval(sweeper);
    if (forced) await stopped;

    let failed = false;
    try {
      await closeResources();
    } catch {
      failed = true;
      log('A resource did not close cleanly.');
    }

    const code = forced || failed ? 1 : 0;
    log(code === 0 ? 'Shutdown complete.' : 'Shutdown finished with problems.');
    exit(code);
  }

  const self: GracefulShutdown = {
    isShuttingDown: () => started !== undefined,
    shutdown(_reason: string): Promise<void> {
      started ??= run();
      return started;
    },
    install(signals = ['SIGTERM', 'SIGINT']) {
      const handler = (signal: NodeJS.Signals): void => {
        if (started !== undefined) {
          log('Shutdown is already running.');
          return;
        }
        void self.shutdown(signal);
      };
      for (const signal of signals) process.on(signal, handler);
      return () => {
        for (const signal of signals) process.off(signal, handler);
      };
    },
  };
  return self;
}

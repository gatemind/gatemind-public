import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OssRuntime } from '@gatemind/composition';
import {
  type GracefulShutdown,
  createGracefulShutdown,
  createHealthHandler,
  createReadinessChecker,
} from '@gatemind/health';

export interface StartServerOptions {
  /** Only what the server needs: the dependency checks and a way to close everything. */
  readonly runtime: Pick<OssRuntime, 'dependencyChecks' | 'close'>;
  /** 0 picks a free port (tests). */
  readonly port: number;
  /** Default `0.0.0.0`, so a container port mapping works. */
  readonly host?: string;
  readonly shutdownGraceMs: number;
  readonly drainDelayMs?: number;
  /** A dependency check slower than this counts as down. Default 2000 ms. */
  readonly checkTimeoutMs?: number;
  readonly exit: (code: number) => void;
  readonly log?: (message: string) => void;
}

export interface RunningServer {
  readonly server: Server;
  readonly port: number;
  readonly shutdown: GracefulShutdown;
}

const NOT_FOUND = JSON.stringify({ error: 'not_found' });

/**
 * The HTTP entrypoint of the Open Source edition (FR-19). Today it serves only the three health
 * checks; the gateway and control API routes (Epic 3) are added to the same server (ARC-037).
 * The returned `shutdown` is not yet listening for signals: `main.ts` installs that.
 */
export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const readiness = createReadinessChecker({
    checks: options.runtime.dependencyChecks,
    ...(options.checkTimeoutMs === undefined ? {} : { timeoutMs: options.checkTimeoutMs }),
  });

  // The handler needs `shutdown.isShuttingDown`, and `shutdown` needs the server: tie them with a
  // late-bound reference.
  let isShuttingDown: () => boolean = () => false;
  const handleHealth = createHealthHandler({ readiness, isShuttingDown: () => isShuttingDown() });

  const server = createServer((request, response) => {
    if (handleHealth(request, response)) return;
    response.writeHead(404, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(NOT_FOUND),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(NOT_FOUND);
  });

  const shutdown = createGracefulShutdown({
    server,
    gracePeriodMs: options.shutdownGraceMs,
    ...(options.drainDelayMs === undefined ? {} : { drainDelayMs: options.drainDelayMs }),
    closeResources: () => options.runtime.close(),
    exit: options.exit,
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  isShuttingDown = () => shutdown.isShuttingDown();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });

  return { server, port: (server.address() as AddressInfo).port, shutdown };
}

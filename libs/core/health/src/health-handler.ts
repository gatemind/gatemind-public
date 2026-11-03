import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ReadinessChecker } from './readiness';

export const HEALTH_PATHS = {
  /** Liveness: the process runs and can answer. Checks no dependency (REL-001). */
  liveness: '/livez',
  /** Readiness: every required dependency is reachable and the process is not shutting down. */
  readiness: '/readyz',
  /** Health: readiness plus the up or down state of each named dependency. */
  health: '/healthz',
} as const;

export interface HealthHandlerOptions {
  readonly readiness: ReadinessChecker;
  /** True once shutdown began. Readiness then fails at once, without touching a dependency. */
  readonly isShuttingDown: () => boolean;
}

/** Returns true when the request was a health path and the response was written. */
export type HealthHandler = (request: IncomingMessage, response: ServerResponse) => boolean;

function send(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(request.method === 'HEAD' ? undefined : payload);
}

function pathOf(request: IncomingMessage): string {
  const url = request.url ?? '/';
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/**
 * HTTP handler for the three health checks (FR-19, REL-001). It answers `GET` and `HEAD` only.
 * Bodies hold a fixed status word and dependency names with `up` or `down`: never a secret, a
 * setting, an address or an error text. Responses are not cacheable.
 *
 * Liveness stays successful during shutdown (the process is still alive and finishing work);
 * readiness fails first (REL-008).
 */
export function createHealthHandler(options: HealthHandlerOptions): HealthHandler {
  const { readiness, isShuttingDown } = options;

  return (request, response) => {
    const path = pathOf(request);
    const isHealthPath =
      path === HEALTH_PATHS.liveness ||
      path === HEALTH_PATHS.readiness ||
      path === HEALTH_PATHS.health;
    if (!isHealthPath) return false;

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      send(request, response, 405, { status: 'method_not_allowed' });
      return true;
    }

    if (path === HEALTH_PATHS.liveness) {
      send(request, response, 200, { status: 'alive' });
      return true;
    }

    if (isShuttingDown()) {
      send(request, response, 503, { status: 'shutting_down' });
      return true;
    }

    readiness
      .check()
      .then((report) => {
        const status = report.ready ? 200 : 503;
        const word = report.ready ? 'ready' : 'not_ready';
        send(
          request,
          response,
          status,
          path === HEALTH_PATHS.health
            ? { status: word, dependencies: report.dependencies }
            : { status: word },
        );
      })
      .catch(() => {
        // `check()` does not reject; this is a last guard so a request never hangs.
        send(request, response, 503, { status: 'not_ready' });
      });
    return true;
  };
}

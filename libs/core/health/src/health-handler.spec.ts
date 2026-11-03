import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HEALTH_PATHS, createHealthHandler } from './health-handler';
import { type DependencyCheck, createReadinessChecker } from './readiness';

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

async function start(options: {
  checks: Record<string, DependencyCheck>;
  shuttingDown?: () => boolean;
}): Promise<number> {
  const handle = createHealthHandler({
    readiness: createReadinessChecker({ checks: options.checks, timeoutMs: 200 }),
    isShuttingDown: options.shuttingDown ?? (() => false),
  });
  const server = createServer((req, res) => {
    if (!handle(req, res)) {
      res.writeHead(404);
      res.end('not found');
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function call(port: number, path: string, method = 'GET'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

describe('health handler', () => {
  it('liveness succeeds without checking any dependency', async () => {
    let called = false;
    const port = await start({
      checks: {
        database: async () => {
          called = true;
          return false;
        },
      },
    });
    const reply = await call(port, HEALTH_PATHS.liveness);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ status: 'alive' });
    expect(called).toBe(false);
  });

  it('readiness succeeds when every dependency is reachable', async () => {
    const port = await start({ checks: { database: async () => true, cache: async () => true } });
    const reply = await call(port, HEALTH_PATHS.readiness);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ status: 'ready' });
  });

  it('readiness fails when a dependency is unreachable and recovers when it returns', async () => {
    let databaseUp = false;
    const port = await start({
      checks: { database: async () => databaseUp, queue: async () => true },
    });
    expect((await call(port, HEALTH_PATHS.readiness)).status).toBe(503);
    databaseUp = true;
    expect((await call(port, HEALTH_PATHS.readiness)).status).toBe(200);
  });

  it('readiness fails when a check throws, with no error text in the response', async () => {
    const port = await start({
      checks: {
        database: async () => {
          throw new Error('Access denied for user app using password canary-secret-1234');
        },
      },
    });
    const reply = await call(port, HEALTH_PATHS.readiness);
    expect(reply.status).toBe(503);
    expect(reply.body).not.toContain('canary-secret-1234');
    expect(reply.body).not.toContain('Access denied');
  });

  it('health names each dependency as up or down and nothing else', async () => {
    const port = await start({
      checks: { database: async () => true, cache: async () => false },
    });
    const reply = await call(port, HEALTH_PATHS.health);
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body)).toEqual({
      status: 'not_ready',
      dependencies: { database: 'up', cache: 'down' },
    });
  });

  it('readiness fails at once during shutdown, but liveness keeps succeeding', async () => {
    let called = false;
    const port = await start({
      checks: {
        database: async () => {
          called = true;
          return true;
        },
      },
      shuttingDown: () => true,
    });
    const ready = await call(port, HEALTH_PATHS.readiness);
    expect(ready.status).toBe(503);
    expect(JSON.parse(ready.body)).toEqual({ status: 'shutting_down' });
    expect(called).toBe(false);
    expect((await call(port, HEALTH_PATHS.liveness)).status).toBe(200);
  });

  it('ignores a query string and answers HEAD without a body', async () => {
    const port = await start({ checks: { database: async () => true } });
    expect((await call(port, `${HEALTH_PATHS.readiness}?verbose=1`)).status).toBe(200);
    const head = await call(port, HEALTH_PATHS.readiness, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });

  it('refuses other methods with 405 and an Allow header', async () => {
    const port = await start({ checks: {} });
    const reply = await call(port, HEALTH_PATHS.liveness, 'POST');
    expect(reply.status).toBe(405);
    expect(reply.headers.allow).toBe('GET, HEAD');
  });

  it('leaves every other path to the caller', async () => {
    const port = await start({ checks: {} });
    expect((await call(port, '/v1/models')).status).toBe(404);
    expect((await call(port, '/livez/extra')).status).toBe(404);
  });

  it('sends no-store and nosniff headers on every health response', async () => {
    const port = await start({ checks: { database: async () => true } });
    for (const path of Object.values(HEALTH_PATHS)) {
      const reply = await call(port, path);
      expect(reply.headers['cache-control']).toBe('no-store');
      expect(reply.headers['x-content-type-options']).toBe('nosniff');
      expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
    }
  });
});

import { createServer, request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { type RunningServer, startServer } from './server';

interface Reply {
  status: number;
  body: string;
}

const running: RunningServer[] = [];
afterEach(() => {
  for (const item of running.splice(0)) {
    item.server.closeAllConnections();
    item.server.close();
  }
});

function fakeRuntime(state: { database: boolean; closed: number }) {
  return {
    dependencyChecks: {
      database: async () => state.database,
      audit_database: async () => true,
      cache: async () => true,
      queue: async () => true,
    },
    close: async () => void state.closed++,
  };
}

function get(port: number, path: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

async function start(
  state = { database: true, closed: 0 },
  extra: { drainDelayMs?: number; exit?: (code: number) => void } = {},
) {
  const item = await startServer({
    runtime: fakeRuntime(state),
    port: 0,
    host: '127.0.0.1',
    shutdownGraceMs: 2000,
    checkTimeoutMs: 500,
    exit: extra.exit ?? (() => undefined),
    ...(extra.drainDelayMs === undefined ? {} : { drainDelayMs: extra.drainDelayMs }),
  });
  running.push(item);
  return { ...item, state };
}

describe('server entrypoint', () => {
  it('exposes liveness, readiness and health (FR-19)', async () => {
    const { port } = await start();
    expect(await get(port, '/livez')).toEqual({ status: 200, body: '{"status":"alive"}' });
    expect(await get(port, '/readyz')).toEqual({ status: 200, body: '{"status":"ready"}' });
    const health = await get(port, '/healthz');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({
      status: 'ready',
      dependencies: {
        database: 'up',
        audit_database: 'up',
        cache: 'up',
        queue: 'up',
      },
    });
  });

  it('turns readiness off while a dependency is down and on again when it returns', async () => {
    const { port, state } = await start({ database: false, closed: 0 });
    expect((await get(port, '/readyz')).status).toBe(503);
    const health = JSON.parse((await get(port, '/healthz')).body) as {
      dependencies: Record<string, string>;
    };
    expect(health.dependencies).toMatchObject({ database: 'down', cache: 'up' });
    expect((await get(port, '/livez')).status).toBe(200);
    state.database = true;
    expect((await get(port, '/readyz')).status).toBe(200);
  });

  it('answers any other path with a plain JSON 404', async () => {
    const { port } = await start();
    expect(await get(port, '/v1/models')).toEqual({ status: 404, body: '{"error":"not_found"}' });
  });

  it('fails readiness first, keeps liveness, then closes and exits 0 on shutdown', async () => {
    let exitCode: number | undefined;
    const { port, shutdown, state } = await start(undefined, {
      drainDelayMs: 300,
      exit: (code) => void (exitCode = code),
    });
    expect((await get(port, '/readyz')).status).toBe(200);

    const done = shutdown.shutdown('SIGTERM');
    const during = await get(port, '/readyz');
    expect(during.status).toBe(503);
    expect(JSON.parse(during.body)).toEqual({ status: 'shutting_down' });
    expect((await get(port, '/livez')).status).toBe(200);

    await done;
    expect(state.closed).toBe(1);
    expect(exitCode).toBe(0);
    await expect(get(port, '/livez')).rejects.toThrow();
  });

  it('rejects when the port is already in use', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const taken = (blocker.address() as { port: number }).port;
    try {
      const error = await startServer({
        runtime: fakeRuntime({ database: true, closed: 0 }),
        port: taken,
        host: '127.0.0.1',
        shutdownGraceMs: 1000,
        exit: () => undefined,
      }).catch((e: unknown) => e);
      expect((error as NodeJS.ErrnoException).code).toBe('EADDRINUSE');
    } finally {
      blocker.close();
    }
  });
});

import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createGracefulShutdown } from './graceful-shutdown';

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

async function listen(
  handler: (req: IncomingMessage, res: import('node:http').ServerResponse) => void,
) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

function get(port: number, path: string, agent?: import('node:http').Agent) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('graceful shutdown', () => {
  it('lets an in-flight request finish, closes resources, then exits 0', async () => {
    const events: string[] = [];
    const { server, port } = await listen((_req, res) => {
      setTimeout(() => {
        events.push('response');
        res.end('done');
      }, 200);
    });
    let exitCode: number | undefined;
    const shutdown = createGracefulShutdown({
      server,
      gracePeriodMs: 3000,
      closeResources: async () => void events.push('resources'),
      exit: (code) => {
        exitCode = code;
        events.push('exit');
      },
    });

    const inFlight = get(port, '/slow');
    await settle(50);
    expect(shutdown.isShuttingDown()).toBe(false);
    const done = shutdown.shutdown('SIGTERM');
    expect(shutdown.isShuttingDown()).toBe(true);

    const reply = await inFlight;
    await done;
    expect(reply).toEqual({ status: 200, body: 'done' });
    expect(events).toEqual(['response', 'resources', 'exit']);
    expect(exitCode).toBe(0);
  });

  it('stops accepting new connections once shutdown begins', async () => {
    const { server, port } = await listen((_req, res) => {
      setTimeout(() => res.end('ok'), 150);
    });
    const shutdown = createGracefulShutdown({
      server,
      gracePeriodMs: 3000,
      closeResources: async () => undefined,
      exit: () => undefined,
    });
    const inFlight = get(port, '/slow');
    await settle(30);
    const done = shutdown.shutdown('SIGTERM');
    await settle(30);
    await expect(get(port, '/new')).rejects.toThrow();
    await inFlight;
    await done;
  });

  it('closes an idle keep-alive connection so shutdown does not wait for it', async () => {
    const { Agent } = await import('node:http');
    const agent = new Agent({ keepAlive: true });
    const { server, port } = await listen((_req, res) => res.end('ok'));
    let exitCode: number | undefined;
    const shutdown = createGracefulShutdown({
      server,
      gracePeriodMs: 5000,
      closeResources: async () => undefined,
      exit: (code) => void (exitCode = code),
    });
    await get(port, '/', agent);
    const started = Date.now();
    await shutdown.shutdown('SIGTERM');
    agent.destroy();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(exitCode).toBe(0);
  });

  it('cuts a request that outlives the grace period and exits 1', async () => {
    const { server, port } = await listen(() => {
      // never answers
    });
    let exitCode: number | undefined;
    let resourcesClosed = false;
    const shutdown = createGracefulShutdown({
      server,
      gracePeriodMs: 150,
      closeResources: async () => void (resourcesClosed = true),
      exit: (code) => void (exitCode = code),
    });
    const stuck = get(port, '/stuck').catch((error: unknown) => error);
    await settle(30);
    const started = Date.now();
    await shutdown.shutdown('SIGTERM');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await stuck).toBeInstanceOf(Error);
    expect(resourcesClosed).toBe(true);
    expect(exitCode).toBe(1);
  });

  it('runs once, however many times it is asked', async () => {
    const { server } = await listen((_req, res) => res.end('ok'));
    let closed = 0;
    let exits = 0;
    const shutdown = createGracefulShutdown({
      server,
      gracePeriodMs: 1000,
      closeResources: async () => void closed++,
      exit: () => void exits++,
    });
    await Promise.all([shutdown.shutdown('a'), shutdown.shutdown('b'), shutdown.shutdown('c')]);
    expect(closed).toBe(1);
    expect(exits).toBe(1);
  });

  it('exits 1 when a resource fails to close, and still exits', async () => {
    const { server } = await listen((_req, res) => res.end('ok'));
    const messages: string[] = [];
    let exitCode: number | undefined;
    const shutdown = createGracefulShutdown({
      server,
      gracePeriodMs: 1000,
      closeResources: async () => {
        throw new Error('pool failed for mysql://app:canary-password@host/db');
      },
      exit: (code) => void (exitCode = code),
      log: (message) => messages.push(message),
    });
    await shutdown.shutdown('SIGTERM');
    expect(exitCode).toBe(1);
    expect(messages.join(' ')).not.toContain('canary-password');
  });

  it('honours the drain delay: readiness fails before the server stops accepting', async () => {
    const { server, port } = await listen((_req, res) => res.end('ok'));
    const shutdown = createGracefulShutdown({
      server,
      gracePeriodMs: 2000,
      drainDelayMs: 200,
      closeResources: async () => undefined,
      exit: () => undefined,
    });
    const done = shutdown.shutdown('SIGTERM');
    expect(shutdown.isShuttingDown()).toBe(true);
    // Still accepting during the drain delay.
    expect((await get(port, '/')).status).toBe(200);
    await done;
  });

  it('exits cleanly when the server was never listening', async () => {
    const server = createServer();
    let exitCode: number | undefined;
    const shutdown = createGracefulShutdown({
      server,
      gracePeriodMs: 1000,
      closeResources: async () => undefined,
      exit: (code) => void (exitCode = code),
    });
    await shutdown.shutdown('SIGTERM');
    expect(exitCode).toBe(0);
  });

  it('install() reacts to a signal, ignores a second one, and can be removed', async () => {
    const { server } = await listen((_req, res) => res.end('ok'));
    let exits = 0;
    const messages: string[] = [];
    const shutdown = createGracefulShutdown({
      server,
      gracePeriodMs: 1000,
      closeResources: async () => undefined,
      exit: () => void exits++,
      log: (m) => messages.push(m),
    });
    const before = process.listenerCount('SIGUSR2');
    const remove = shutdown.install(['SIGUSR2']);
    expect(process.listenerCount('SIGUSR2')).toBe(before + 1);
    process.emit('SIGUSR2');
    process.emit('SIGUSR2');
    await shutdown.shutdown('again');
    expect(exits).toBe(1);
    expect(messages).toContain('Shutdown is already running.');
    remove();
    expect(process.listenerCount('SIGUSR2')).toBe(before);
  });

  it('rejects an invalid grace period or drain delay', () => {
    const base = {
      server: createServer(),
      closeResources: async () => undefined,
      exit: () => undefined,
    };
    expect(() => createGracefulShutdown({ ...base, gracePeriodMs: 0 })).toThrow(TypeError);
    expect(() =>
      createGracefulShutdown({ ...base, gracePeriodMs: 1000, drainDelayMs: -1 }),
    ).toThrow(TypeError);
  });
});

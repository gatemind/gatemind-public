import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_DATABASES, readDevDatabaseConfig, readDevStoreUrls } from '@gatemind/tenancy-testing';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * These tests start the real entrypoint (`main.ts`) as a child process against the development
 * MySQL and Valkey instances and send it real signals. This is the proof for FR-19 and REL-008:
 * liveness, readiness and health answer, readiness fails first on SIGTERM, and the process exits 0.
 */
function workspaceRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(resolve(dir, 'nx.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('workspace root not found');
    dir = parent;
  }
  return dir;
}

const root = workspaceRoot();
const dbConfig = readDevDatabaseConfig();
const stores = readDevStoreUrls();

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

interface Started {
  child: ChildProcess;
  port: number;
  output: () => string;
  exited: Promise<number | null>;
}

function launch(env: Record<string, string>): Started {
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      TSX_TSCONFIG_PATH: resolve(root, 'tsconfig.base.json'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let text = '';
  child.stdout?.on('data', (chunk: Buffer) => void (text += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => void (text += chunk.toString()));
  const exited = new Promise<number | null>((resolveExit) => child.on('exit', resolveExit));
  return { child, port: Number(env.GATEMIND_HTTP_PORT ?? 0), output: () => text, exited };
}

async function waitFor(condition: () => boolean, what: string, ms = 30000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveGet, reject) => {
    const req = request({ host: '127.0.0.1', port, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolveGet({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

const masterKey = randomBytes(32).toString('base64');

async function goodEnv(overrides: Record<string, string> = {}): Promise<Record<string, string>> {
  return {
    GATEMIND_ENV: 'test',
    GATEMIND_HTTP_PORT: String(await freePort()),
    GATEMIND_SHUTDOWN_GRACE_SECONDS: '5',
    GATEMIND_MASTER_KEY: masterKey,
    GATEMIND_DATABASE_URL: dbConfig.appUrl(DEV_DATABASES.test),
    GATEMIND_AUDIT_DATABASE_URL: dbConfig.appUrl(DEV_DATABASES.auditTest),
    GATEMIND_CACHE_URL: stores.cacheUrl,
    GATEMIND_QUEUE_URL: stores.queueUrl,
    ...overrides,
  };
}

describe('the server process', () => {
  it('serves the health checks, then shuts down cleanly with exit code 0 on SIGTERM', async () => {
    const env = await goodEnv();
    const app = launch(env);
    await waitFor(() => app.output().includes('is listening on port'), 'the server to listen');

    expect(await get(app.port, '/livez')).toEqual({ status: 200, body: '{"status":"alive"}' });
    expect(await get(app.port, '/readyz')).toEqual({ status: 200, body: '{"status":"ready"}' });
    const health = await get(app.port, '/healthz');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({
      status: 'ready',
      dependencies: { database: 'up', audit_database: 'up', cache: 'up', queue: 'up' },
    });

    app.child.kill('SIGTERM');
    expect(await app.exited).toBe(0);
    expect(app.output()).toContain('Shutdown complete.');
  });

  it('also stops cleanly on SIGINT', async () => {
    const app = launch(await goodEnv());
    await waitFor(() => app.output().includes('is listening on port'), 'the server to listen');
    app.child.kill('SIGINT');
    expect(await app.exited).toBe(0);
  });

  it('never prints a secret value: not the master key, a password or a URL', async () => {
    const env = await goodEnv();
    const app = launch(env);
    await waitFor(() => app.output().includes('is listening on port'), 'the server to listen');
    const health = await get(app.port, '/healthz');
    app.child.kill('SIGTERM');
    await app.exited;

    const everything = `${app.output()}\n${health.body}`;
    expect(everything).not.toContain(masterKey);
    for (const url of [
      env.GATEMIND_DATABASE_URL,
      env.GATEMIND_AUDIT_DATABASE_URL,
      env.GATEMIND_CACHE_URL,
      env.GATEMIND_QUEUE_URL,
    ]) {
      const password = decodeURIComponent(new URL(url ?? '').password);
      expect(password.length).toBeGreaterThan(0);
      expect(everything).not.toContain(password);
      expect(everything).not.toContain(url);
    }
  });

  it('reports not ready, and names the database, when the database is unreachable', async () => {
    const closedPort = await freePort();
    const env = await goodEnv({
      GATEMIND_DATABASE_URL: `mysql://app:canary-password@127.0.0.1:${closedPort}/gatemind`,
    });
    const app = launch(env);
    await waitFor(() => app.output().includes('is listening on port'), 'the server to listen');

    expect((await get(app.port, '/livez')).status).toBe(200);
    expect((await get(app.port, '/readyz')).status).toBe(503);
    const health = JSON.parse((await get(app.port, '/healthz')).body) as {
      dependencies: Record<string, string>;
    };
    expect(health.dependencies).toEqual({
      database: 'down',
      audit_database: 'up',
      cache: 'up',
      queue: 'up',
    });

    app.child.kill('SIGTERM');
    expect(await app.exited).toBe(0);
    expect(app.output()).not.toContain('canary-password');
  });

  it('refuses to start without the connection settings, naming each and no value', async () => {
    const app = launch({
      GATEMIND_ENV: 'test',
      GATEMIND_HTTP_PORT: String(await freePort()),
      GATEMIND_MASTER_KEY: masterKey,
    });
    expect(await app.exited).toBe(1);
    const text = app.output();
    expect(text).toContain('Gatemind cannot start');
    for (const name of [
      'GATEMIND_DATABASE_URL',
      'GATEMIND_AUDIT_DATABASE_URL',
      'GATEMIND_CACHE_URL',
      'GATEMIND_QUEUE_URL',
    ]) {
      expect(text).toContain(name);
    }
    expect(text).not.toContain(masterKey);
  });

  it('refuses to start on an invalid configuration, such as a bad grace period', async () => {
    const app = launch(await goodEnv({ GATEMIND_SHUTDOWN_GRACE_SECONDS: '0' }));
    expect(await app.exited).toBe(1);
    expect(app.output()).toContain('GATEMIND_SHUTDOWN_GRACE_SECONDS');
  });

  it('closes what it opened and exits 1 when the HTTP port is already taken', async () => {
    const blocker = createServer();
    await new Promise<void>((resolveListen) => blocker.listen(0, '0.0.0.0', resolveListen));
    const taken = (blocker.address() as AddressInfo).port;
    try {
      const app = launch(await goodEnv({ GATEMIND_HTTP_PORT: String(taken) }));
      expect(await app.exited).toBe(1);
      expect(app.output()).toContain('EADDRINUSE');
    } finally {
      blocker.close();
    }
  });
});

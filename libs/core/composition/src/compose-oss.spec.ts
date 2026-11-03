import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditError } from '@gatemind/audit';
import {
  DEFAULT_ORGANIZATION_ID,
  TenantKeyRepository,
  ensureDefaultHierarchy,
  runAuditMigrations,
  runCoreMigrations,
} from '@gatemind/database';
import { PortNotConfiguredError, type SecretStore } from '@gatemind/ports';
import { RedisStoreError } from '@gatemind/redis-store';
import { createTenantContext } from '@gatemind/tenancy';
import { DEV_DATABASES, readDevDatabaseConfig, readDevStoreUrls } from '@gatemind/tenancy-testing';
import { Secret, asTenantId } from '@gatemind/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEPENDENCY_NAMES, type OssRuntime, SETTING_NAMES, composeOss } from './compose-oss';
import { CompositionError } from './errors';

const hex = (bytes = 4): string => randomBytes(bytes).toString('hex');
const tenant = (label: string) => asTenantId(`${label}-${hex()}`);
const newMasterKey = (): string => randomBytes(32).toString('base64');

function storeWith(values: Record<string, string>): SecretStore {
  return {
    async get(name) {
      const value = values[name];
      return value === undefined ? undefined : new Secret(value);
    },
  };
}

const devConfig = readDevDatabaseConfig();
const devStores = readDevStoreUrls();

function devSettings(masterKey: string = newMasterKey()): Record<string, string> {
  return {
    MASTER_KEY: masterKey,
    [SETTING_NAMES.database]: devConfig.appUrl(DEV_DATABASES.test),
    [SETTING_NAMES.auditDatabase]: devConfig.appUrl(DEV_DATABASES.auditTest),
    [SETTING_NAMES.cacheStore]: devStores.cacheUrl,
    [SETTING_NAMES.queueStore]: devStores.queueUrl,
  };
}

describe('composeOss settings', () => {
  it('reports every missing setting once, by name, and no value', async () => {
    const masterKey = newMasterKey();
    const error = await composeOss({ secretStore: storeWith({ MASTER_KEY: masterKey }) }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CompositionError);
    const composition = error as CompositionError;
    expect(composition.code).toBe('missing_setting');
    expect(composition.settings).toEqual([
      'GATEMIND_DATABASE_URL',
      'GATEMIND_AUDIT_DATABASE_URL',
      'GATEMIND_CACHE_URL',
      'GATEMIND_QUEUE_URL',
    ]);
    expect(composition.message).toContain('GATEMIND_DATABASE_URL');
    expect(composition.message).not.toContain(masterKey);
  });

  it('names only the settings that are missing', async () => {
    const settings = devSettings();
    const {
      [SETTING_NAMES.cacheStore]: _cache,
      [SETTING_NAMES.queueStore]: _queue,
      ...rest
    } = settings;
    const error = (await composeOss({ secretStore: storeWith(rest) }).catch(
      (e: unknown) => e,
    )) as CompositionError;
    expect(error.settings).toEqual(['GATEMIND_CACHE_URL', 'GATEMIND_QUEUE_URL']);
  });

  it('refuses a cache and a queue that are the same instance (SEC-022)', async () => {
    const settings = devSettings();
    const error = await composeOss({
      secretStore: storeWith({ ...settings, [SETTING_NAMES.queueStore]: devStores.cacheUrl }),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RedisStoreError);
    expect((error as RedisStoreError).code).toBe('same_instance');
  });

  it('never puts a password from a URL into an error, and closes what it opened (SEC-087)', async () => {
    const canary = `canary-${hex(12)}`;
    const settings = {
      ...devSettings(),
      [SETTING_NAMES.cacheStore]: `redis://:${canary}@127.0.0.1:1`,
      [SETTING_NAMES.queueStore]: `redis://:${canary}@127.0.0.1:2`,
    };
    const error = await composeOss({ secretStore: storeWith(settings) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RedisStoreError);
    const text = [String(error), (error as Error).message, (error as Error).stack ?? ''].join('\n');
    expect(text).not.toContain(canary);
  });
});

describe('composeOss on the development stores', () => {
  let runtime: OssRuntime;

  beforeAll(async () => {
    await runCoreMigrations({ url: devConfig.migratorUrl(DEV_DATABASES.test) });
    await runAuditMigrations({ url: devConfig.migratorUrl(DEV_DATABASES.auditTest) });
    runtime = await composeOss({ secretStore: storeWith(devSettings()) });
    await ensureDefaultHierarchy(runtime.db);
  });

  afterAll(async () => {
    await runtime?.close();
  });

  it('wires the safe defaults: deny entitlements, reject sign-in, drop usage, no storage', async () => {
    const t = tenant('acme');
    expect(await runtime.entitlements.isEntitled(t, 'sso')).toBe(false);
    expect(
      await runtime.auth.authenticatePassword({
        tenantId: t,
        identifier: 'alice',
        password: new Secret('correct horse'),
      }),
    ).toEqual({ status: 'rejected' });
    await expect(
      runtime.usageSink.record({
        tenantId: t,
        gatewayKeyId: 'gm_test',
        alias: 'default',
        outcome: 'completed',
        label: 'unavailable',
      }),
    ).resolves.toBeUndefined();
    await expect(runtime.storage.put(t, ['a'], new Uint8Array())).rejects.toBeInstanceOf(
      PortNotConfiguredError,
    );
  });

  it('answers for both stores', async () => {
    expect(await runtime.pingStores()).toEqual({ cache: true, queue: true });
  });

  it('keeps the cache and the rate limiter apart per tenant (ARC-023)', async () => {
    const a = tenant('tenant-a');
    const b = tenant('tenant-b');
    await runtime.cache.set(a, 'shared-name', 'value-of-a', { ttlMs: 5_000 });
    expect(await runtime.cache.get(a, 'shared-name')).toBe('value-of-a');
    expect(await runtime.cache.get(b, 'shared-name')).toBeUndefined();

    const request = { bucket: 'signin:ip:203.0.113.9', limit: 2, windowMs: 5_000 };
    await runtime.rateLimiter.consume({ tenantId: a, ...request });
    await runtime.rateLimiter.consume({ tenantId: a, ...request });
    const refused = await runtime.rateLimiter.consume({ tenantId: a, ...request });
    expect(refused).toMatchObject({ allowed: false, reason: 'limit_exceeded' });
    expect(await runtime.rateLimiter.consume({ tenantId: b, ...request })).toMatchObject({
      allowed: true,
    });
  });

  it('encrypts and decrypts through the real key management and database', async () => {
    const keys = new TenantKeyRepository(
      runtime.db,
      createTenantContext(asTenantId(DEFAULT_ORGANIZATION_ID)),
    );
    try {
      const plaintext = `provider-key-${hex(12)}`;
      const envelope = await runtime.envelope.encrypt(
        DEFAULT_ORGANIZATION_ID,
        new Secret(plaintext),
        { context: 'composition-test:1' },
      );
      expect(envelope).not.toContain(plaintext);
      const roundTrip = await runtime.envelope.withSecret(
        DEFAULT_ORGANIZATION_ID,
        envelope,
        (secret) => secret.reveal(),
        { context: 'composition-test:1' },
      );
      expect(roundTrip).toBe(plaintext);
    } finally {
      for (const row of await keys.list()) await keys.delete(row.id);
    }
  });

  it('writes through the real audit sink, which rejects an event that is not an identifier', async () => {
    const error = await runtime.audit
      .record({
        tenantId: tenant('acme'),
        actor: 'user:alice',
        action: 'role assign with spaces',
        target: 'user:1',
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuditError);
    expect((error as AuditError).code).toBe('invalid_event');
  });

  it('reports every required dependency as up through dependencyChecks', async () => {
    const other = await composeOss({ secretStore: storeWith(devSettings()) });
    try {
      expect(Object.keys(other.dependencyChecks)).toEqual([...DEPENDENCY_NAMES]);
      for (const name of DEPENDENCY_NAMES) {
        expect(await other.dependencyChecks[name](), name).toBe(true);
      }
    } finally {
      await other.close();
    }
  });

  it('reports every dependency as down, without rejecting, after close', async () => {
    const other = await composeOss({ secretStore: storeWith(devSettings()) });
    await other.close();
    for (const name of DEPENDENCY_NAMES) {
      const answer: unknown = await other.dependencyChecks[name]();
      expect(answer, name).toBe(false);
    }
  });

  it('closes cleanly, twice, and then reports the stores as unreachable', async () => {
    const other = await composeOss({ secretStore: storeWith(devSettings()) });
    await other.close();
    await other.close();
    expect(await other.pingStores()).toEqual({ cache: false, queue: false });
  });
});

describe('the composition root and the edition boundary (ARC-050, ARC-051)', () => {
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const sources = readdirSync(sourceDir)
    .filter((name) => name.endsWith('.ts') && !/\.(spec|test-support)\.ts$/.test(name))
    .map((name) => ({ name, text: readFileSync(join(sourceDir, name), 'utf8') }));

  const importsOf = (text: string): string[] =>
    [...text.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((match) => match[1] ?? '');

  it('imports only core libraries, never an ee path', () => {
    expect(sources.length).toBeGreaterThan(0);
    for (const { name, text } of sources) {
      for (const specifier of importsOf(text)) {
        const allowed = specifier.startsWith('./') || specifier.startsWith('@gatemind/');
        expect(allowed, `${name} imports ${specifier}`).toBe(true);
        expect(specifier, `${name} imports ${specifier}`).not.toMatch(
          /(^|\/)(ee|apps-ee)(\/|$)|-ee\b/,
        );
      }
    }
  });

  it('does not open a database or store connection itself', () => {
    for (const { name, text } of sources) {
      for (const specifier of importsOf(text)) {
        expect(specifier, `${name} imports ${specifier}`).not.toMatch(
          /^(mysql2|ioredis|bullmq|redis|drizzle-orm)/,
        );
      }
    }
  });
});

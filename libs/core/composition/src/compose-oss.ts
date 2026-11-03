import { createAuditSink } from '@gatemind/audit';
import { ENV_PREFIX } from '@gatemind/config';
import {
  AuditLogStore,
  type Database,
  createDatabase,
  createTenantKeyStores,
} from '@gatemind/database';
import {
  type AuditSink,
  type AuthProvider,
  type CachePort,
  type Clock,
  type EntitlementChecker,
  type KeyManagement,
  type QueuePort,
  type RateLimiterPort,
  type SecretStore,
  type StoragePort,
  type UsageSink,
  denyAllAuthProvider,
  denyAllEntitlementChecker,
  noopUsageSink,
  systemClock,
  unconfiguredStoragePort,
} from '@gatemind/ports';
import { type StorePing, openRedisStore } from '@gatemind/redis-store';
import {
  type EnvelopeEncryption,
  createEnvelopeEncryption,
  createLocalKeyManagement,
} from '@gatemind/secrets';
import type { Secret } from '@gatemind/types';
import { CompositionError } from './errors';

/**
 * Logical names of the connection settings, read through the `SecretStore` like the master key.
 * Each has two forms: `GATEMIND_<NAME>` or `GATEMIND_<NAME>_FILE` (file or secret mount). A URL
 * holds a password, so it is a secret and never appears in a log or an error.
 */
export const SETTING_NAMES = {
  /** `mysql://` URL of the core database, as the application user (no DDL, no DROP). */
  database: 'DATABASE_URL',
  /** `mysql://` URL of the audit database, as the application user (SELECT and INSERT only). */
  auditDatabase: 'AUDIT_DATABASE_URL',
  /** `redis://` URL of the cache instance (cache, rate-limit counters, pub/sub). May evict. */
  cacheStore: 'CACHE_URL',
  /** `redis://` URL of the queue instance (BullMQ). Must use `noeviction`. */
  queueStore: 'QUEUE_URL',
} as const;

/** Fixed dependency names used by the health endpoints. They are identifiers, not settings. */
export const DEPENDENCY_NAMES = ['database', 'audit_database', 'cache', 'queue'] as const;
export type DependencyName = (typeof DEPENDENCY_NAMES)[number];
export type DependencyChecks = Readonly<Record<DependencyName, () => Promise<boolean>>>;

export interface ComposeOssOptions {
  readonly secretStore: SecretStore;
  /** Injected for tests. Defaults to the system clock. */
  readonly clock?: Clock;
}

/**
 * Everything an Open Source entrypoint needs, behind ports (ARC-031, ARC-050, ARC-055).
 * Every member is either a core implementation or a safe default that grants or does nothing.
 */
export interface OssRuntime {
  readonly clock: Clock;
  readonly secretStore: SecretStore;
  readonly keyManagement: KeyManagement;
  readonly envelope: EnvelopeEncryption;
  readonly audit: AuditSink;
  readonly cache: CachePort;
  readonly rateLimiter: RateLimiterPort;
  readonly queue: QueuePort;
  /** Drops every event until Story 4.7. */
  readonly usageSink: UsageSink;
  /** Grants nothing: the Open Source edition has no entitlements beyond its own scope (ARC-050). */
  readonly entitlements: EntitlementChecker;
  /** Rejects every sign-in until Stories 1.9 to 1.12. */
  readonly auth: AuthProvider;
  /** Fails loudly until a story supplies storage. */
  readonly storage: StoragePort;
  /**
   * The tenant-scoped database handle. Build repositories on it; never run SQL through it outside
   * `libs/core/database` (ARC-020).
   */
  readonly db: Database['db'];
  /** Can each Redis-compatible store answer right now? Never rejects (readiness, Story 1.7). */
  pingStores(): Promise<StorePing>;
  /**
   * One check per required dependency, for the readiness and health endpoints (REL-001, Story 1.7).
   * Each answers `true` or `false`, never rejects and never says why. The names are fixed.
   */
  readonly dependencyChecks: DependencyChecks;
  /** Closes every connection. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * The one Open Source composition root (ARC-050). It wires only core implementations and the
 * deny-by-default `EntitlementChecker`, and imports nothing outside `libs/core` and
 * `libs/shared`. It knows nothing about any other edition.
 *
 * All missing settings are reported together, by name. Anything that fails after a connection
 * opened closes what was already opened.
 */
export async function composeOss(options: ComposeOssOptions): Promise<OssRuntime> {
  const { secretStore } = options;
  const clock = options.clock ?? systemClock;

  const settings = new Map<string, Secret>();
  const missing: string[] = [];
  for (const name of Object.values(SETTING_NAMES)) {
    const value = await secretStore.get(name);
    if (value === undefined) missing.push(`${ENV_PREFIX}${name}`);
    else settings.set(name, value);
  }
  if (missing.length > 0) {
    throw new CompositionError(
      'missing_setting',
      `Missing required settings: ${missing.join(', ')} (or the matching ${ENV_PREFIX}<NAME>_FILE)`,
      missing,
    );
  }
  const setting = (name: string): Secret => {
    const value = settings.get(name);
    if (value === undefined) throw new TypeError('A required setting is not available');
    return value;
  };

  const opened: { close(): Promise<void> }[] = [];
  const closeOpened = async (): Promise<void> => {
    await Promise.allSettled(opened.splice(0).map((resource) => resource.close()));
  };

  try {
    const database = createDatabase({ url: setting(SETTING_NAMES.database).reveal() });
    opened.push(database);
    const auditDatabase = createDatabase({ url: setting(SETTING_NAMES.auditDatabase).reveal() });
    opened.push(auditDatabase);

    const keyManagement = await createLocalKeyManagement(secretStore);
    const envelope = createEnvelopeEncryption({
      keyManagement,
      keyStores: createTenantKeyStores(database.db),
    });
    const audit = createAuditSink({ storage: new AuditLogStore(auditDatabase.db), clock });

    const store = await openRedisStore({
      cacheUrl: setting(SETTING_NAMES.cacheStore),
      queueUrl: setting(SETTING_NAMES.queueStore),
    });
    opened.push(store);

    let closed = false;
    return {
      clock,
      secretStore,
      keyManagement,
      envelope,
      audit,
      cache: store.cache,
      rateLimiter: store.rateLimiter,
      queue: store.queue,
      usageSink: noopUsageSink,
      entitlements: denyAllEntitlementChecker,
      auth: denyAllAuthProvider,
      storage: unconfiguredStoragePort,
      db: database.db,
      pingStores: () => store.ping(),
      dependencyChecks: {
        database: () => database.ping(),
        audit_database: () => auditDatabase.ping(),
        cache: async () => (await store.ping()).cache,
        queue: async () => (await store.ping()).queue,
      },
      async close() {
        if (closed) return;
        closed = true;
        await closeOpened();
      },
    };
  } catch (error) {
    await closeOpened();
    throw error;
  }
}

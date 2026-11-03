import type { TenantId } from '@gatemind/types';

export interface CacheSetOptions {
  /** How long the value lives, in milliseconds. Required: nothing is cached forever. */
  readonly ttlMs: number;
}

/** Stops a subscription. Safe to call more than once. */
export type CacheUnsubscribe = () => Promise<void>;

/**
 * Cache and pub/sub port (ARC-055). The default implementation uses a Redis-compatible store
 * (Valkey default, Redis 8 supported) and is the only code that talks to it (ADR 0003).
 *
 * Contract:
 * - Every call names the tenant. Keys and channels are scoped to it by the implementation, so
 *   the same logical key for two tenants never collides and one tenant can never read another's
 *   value (ARC-023, SEC-003). `key` and `channel` are logical names, not store keys.
 * - Values are strings; callers serialize. Nothing secret belongs in the cache unless the value
 *   is itself encrypted.
 * - A call that cannot reach the store rejects with `StoreUnavailableError`. The cache itself has
 *   no opinion on failing open or closed (SEC-022): a caller guarding a security control (for
 *   example the revocation list) must refuse on rejection, a caller using the cache for speed
 *   treats a rejection as a miss.
 * - Pub/sub is best effort: a message is delivered to handlers that are subscribed when it is
 *   published, and to none otherwise.
 */
export interface CachePort {
  get(tenantId: TenantId, key: string): Promise<string | undefined>;
  set(tenantId: TenantId, key: string, value: string, options: CacheSetOptions): Promise<void>;
  delete(tenantId: TenantId, key: string): Promise<void>;
  publish(tenantId: TenantId, channel: string, message: string): Promise<void>;
  /** A handler that throws never affects other handlers or the subscription. */
  subscribe(
    tenantId: TenantId,
    channel: string,
    handler: (message: string) => void,
  ): Promise<CacheUnsubscribe>;
}

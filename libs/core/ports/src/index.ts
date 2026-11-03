import type { EpochMs } from '@gatemind/types';

export type { AuditEvent, AuditReceipt, AuditSink } from './audit-sink';
export type { AuthProvider, AuthResult, AuthSubject, PasswordCredentials } from './auth-provider';
export type { CachePort, CacheSetOptions, CacheUnsubscribe } from './cache-port';
export {
  denyAllAuthProvider,
  denyAllEntitlementChecker,
  noopUsageSink,
  unconfiguredStoragePort,
} from './defaults';
export type { EntitlementChecker } from './entitlement-checker';
export { PortNotConfiguredError, StoreUnavailableError } from './errors';
export type { KeyManagement } from './key-management';
export type {
  QueueHandler,
  QueueJobSpec,
  QueuePort,
  QueueReceipt,
  QueueWorkerOptions,
  ReceivedJob,
} from './queue-port';
export type { RateLimitDecision, RateLimiterPort, RateLimitRequest } from './rate-limiter-port';
export type { SecretStore } from './secret-store';
export type { StoragePort } from './storage-port';
export type { UsageEvent, UsageLabel, UsageSink } from './usage-sink';

/** Time source port (ARC-055). Real implementations are injected; tests use a fake. */
export interface Clock {
  nowMs(): EpochMs;
}

export const systemClock: Clock = {
  nowMs: () => Date.now() as EpochMs,
};

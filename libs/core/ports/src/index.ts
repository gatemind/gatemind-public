import type { EpochMs } from '@gatemind/types';

export type { AuditEvent, AuditReceipt, AuditSink } from './audit-sink';
export type { KeyManagement } from './key-management';
export type { SecretStore } from './secret-store';

/** Time source port (ARC-055). Real implementations are injected; tests use a fake. */
export interface Clock {
  nowMs(): EpochMs;
}

export const systemClock: Clock = {
  nowMs: () => Date.now() as EpochMs,
};

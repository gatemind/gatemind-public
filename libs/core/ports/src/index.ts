import type { EpochMs } from '@gatemind/types';

export type { KeyManagement } from './key-management';
export type { SecretStore } from './secret-store';

/** Time source port (ARC-055). Real implementations are injected; tests use a fake. */
export interface Clock {
  nowMs(): EpochMs;
}

export const systemClock: Clock = {
  nowMs: () => Date.now() as EpochMs,
};

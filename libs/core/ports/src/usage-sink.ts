import type { TenantId } from '@gatemind/types';

/** How a token count was obtained (OBS-001). */
export type UsageLabel = 'measured' | 'provider-reported' | 'estimated' | 'unavailable';

/**
 * One gateway request, finished or not. `[PROPOSED]` shape: Story 4.7 may adjust it, because ports
 * are internal and carry no compatibility promise (ARC-031). There is deliberately no field for a
 * prompt, a response or any payload (SEC-050).
 */
export interface UsageEvent {
  readonly tenantId: TenantId;
  readonly gatewayKeyId: string;
  /** The Route alias that was called. */
  readonly alias: string;
  readonly outcome: 'completed' | 'refused' | 'cut_off' | 'failed' | 'client_disconnected';
  /** Absent when `label` is `unavailable`. */
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly label: UsageLabel;
}

/**
 * Usage recording port (ARC-050 family). Story 4.7 supplies the queue-backed implementation;
 * until then the default silently drops events.
 */
export interface UsageSink {
  record(event: UsageEvent): Promise<void>;
}

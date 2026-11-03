import type { TenantId } from '@gatemind/types';

export interface RateLimitRequest {
  readonly tenantId: TenantId;
  /**
   * What is being limited, for example `signin:ip:203.0.113.7` or `gateway-key:<lookup id>`.
   * Each distinct value has its own counter inside the tenant. It must be a short identifier and
   * never contain a secret, because it is part of a store key.
   */
  readonly bucket: string;
  /** How many operations are allowed per window. Integer, at least 1. */
  readonly limit: number;
  /** Window length in milliseconds. Integer, at least 1. */
  readonly windowMs: number;
}

export type RateLimitDecision =
  | {
      readonly allowed: true;
      /** Operations still allowed in this window. */
      readonly remaining: number;
      readonly resetAfterMs: number;
    }
  | {
      readonly allowed: false;
      readonly reason: 'limit_exceeded';
      /** Use for the `Retry-After` value. */
      readonly retryAfterMs: number;
    }
  | {
      readonly allowed: false;
      /** The limit store could not be reached: the control fails closed (SEC-022). */
      readonly reason: 'store_unavailable';
    };

/**
 * Rate limiter port (ARC-055, SEC-021, SEC-022).
 *
 * Contract:
 * - `consume` counts one operation and decides in a single atomic step, so concurrent callers on
 *   several processes never exceed the limit.
 * - It fails closed by construction: if the store is unreachable the decision is
 *   `{ allowed: false, reason: 'store_unavailable' }`, so a caller that only checks `allowed`
 *   refuses the request. `consume` does not reject for an outage. It throws `TypeError` only for
 *   an invalid request, which is a programming error.
 * - The strategy behind the port can change (a fixed window now, a token bucket in Story 4.2)
 *   without changing this contract: `limit` operations per `windowMs`.
 */
export interface RateLimiterPort {
  consume(request: RateLimitRequest): Promise<RateLimitDecision>;
}

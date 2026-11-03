import type { RateLimiterPort, RateLimitDecision, RateLimitRequest } from '@gatemind/ports';
import { tenantCacheKey } from '@gatemind/tenancy';
import type { Redis } from 'ioredis';

/**
 * Atomic fixed-window counter (SEC-022: "rate limiting uses atomic operations").
 * One script call counts the operation and returns the count and the time left in the window, so
 * concurrent callers on any number of processes can never both slip under the limit.
 * The window starts at the first operation. If a counter ever lacks an expiry, it is repaired
 * here, so a counter cannot become permanent.
 */
const FIXED_WINDOW_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if current == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { current, ttl }
`;

const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const STORE_UNAVAILABLE: RateLimitDecision = { allowed: false, reason: 'store_unavailable' };

function validate(request: RateLimitRequest): void {
  if (request.bucket === '') throw new TypeError('A rate limit bucket must not be empty');
  if (!Number.isInteger(request.limit) || request.limit < 1) {
    throw new TypeError('limit must be an integer of at least 1');
  }
  if (
    !Number.isInteger(request.windowMs) ||
    request.windowMs < 1 ||
    request.windowMs > MAX_WINDOW_MS
  ) {
    throw new TypeError('windowMs must be an integer from 1 to 31 days in milliseconds');
  }
}

/** `RateLimiterPort` on a Redis-compatible store. It fails closed on any store problem (SEC-022). */
export function createRedisRateLimiter(client: Redis): RateLimiterPort {
  return {
    async consume(request) {
      validate(request);
      const key = tenantCacheKey(request.tenantId, 'ratelimit', request.bucket);
      try {
        const reply: unknown = await client.eval(
          FIXED_WINDOW_SCRIPT,
          1,
          key,
          String(request.windowMs),
        );
        if (!Array.isArray(reply) || typeof reply[0] !== 'number' || typeof reply[1] !== 'number') {
          return STORE_UNAVAILABLE;
        }
        const count = reply[0];
        const timeLeftMs = Math.max(1, reply[1]);
        if (count <= request.limit) {
          return { allowed: true, remaining: request.limit - count, resetAfterMs: timeLeftMs };
        }
        return { allowed: false, reason: 'limit_exceeded', retryAfterMs: timeLeftMs };
      } catch {
        return STORE_UNAVAILABLE;
      }
    },
  };
}

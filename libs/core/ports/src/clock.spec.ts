import { describe, expect, it } from 'vitest';
import { systemClock } from './index';

describe('systemClock', () => {
  it('returns the current time in epoch milliseconds', () => {
    const before = Date.now();
    const value = systemClock.nowMs();
    const after = Date.now();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });
});

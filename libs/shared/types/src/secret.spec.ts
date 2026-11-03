import { describe, expect, it } from 'vitest';
import { Secret } from './index';

describe('Secret', () => {
  const value = 'super-secret-canary-value';

  it('reveals the value only through reveal()', () => {
    expect(new Secret(value).reveal()).toBe(value);
  });

  it('never shows the value through string conversion', () => {
    const secret = new Secret(value);
    expect(String(secret)).not.toContain(value);
    expect(`${secret}`).not.toContain(value);
    expect(secret + '').not.toContain(value);
  });

  it('never shows the value through JSON serialization', () => {
    const secret = new Secret(value);
    expect(JSON.stringify(secret)).not.toContain(value);
    expect(JSON.stringify({ nested: { secret } })).not.toContain(value);
  });
});

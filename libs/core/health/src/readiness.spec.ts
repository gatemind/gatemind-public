import { describe, expect, it } from 'vitest';
import { createReadinessChecker } from './readiness';

describe('createReadinessChecker', () => {
  it('is ready only when every dependency is up', async () => {
    const checker = createReadinessChecker({
      checks: { database: async () => true, cache: async () => true },
    });
    expect(await checker.check()).toEqual({
      ready: true,
      dependencies: { database: 'up', cache: 'up' },
    });
  });

  it('is not ready when one dependency answers false, and names it', async () => {
    const checker = createReadinessChecker({
      checks: { database: async () => true, queue: async () => false },
    });
    expect(await checker.check()).toEqual({
      ready: false,
      dependencies: { database: 'up', queue: 'down' },
    });
  });

  it('treats a rejection as down and never keeps the error text', async () => {
    const checker = createReadinessChecker({
      checks: {
        database: async () => {
          throw new Error('connect ECONNREFUSED mysql://app:canary-password@10.0.0.5:3306/x');
        },
      },
    });
    const report = await checker.check();
    expect(report.ready).toBe(false);
    expect(JSON.stringify(report)).not.toContain('canary-password');
    expect(JSON.stringify(report)).not.toContain('10.0.0.5');
  });

  it('treats a hung check as down after the timeout, without hanging the others', async () => {
    const checker = createReadinessChecker({
      timeoutMs: 50,
      checks: { cache: async () => true, database: () => new Promise<boolean>(() => undefined) },
    });
    const started = Date.now();
    const report = await checker.check();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(report.dependencies).toEqual({ cache: 'up', database: 'down' });
  });

  it('runs the checks in parallel', async () => {
    const slow = (): Promise<boolean> =>
      new Promise((resolve) => setTimeout(() => resolve(true), 120));
    const checker = createReadinessChecker({ checks: { a: slow, b: slow, c: slow } });
    const started = Date.now();
    await checker.check();
    expect(Date.now() - started).toBeLessThan(330);
  });

  it('is ready with no dependencies', async () => {
    expect(await createReadinessChecker({ checks: {} }).check()).toEqual({
      ready: true,
      dependencies: {},
    });
  });

  it('refuses a dependency name that could carry an address or a value', () => {
    expect(() => createReadinessChecker({ checks: { 'db@10.0.0.5': async () => true } })).toThrow(
      TypeError,
    );
    expect(() => createReadinessChecker({ checks: { Database: async () => true } })).toThrow(
      TypeError,
    );
  });

  it('refuses a non-positive timeout', () => {
    expect(() => createReadinessChecker({ checks: {}, timeoutMs: 0 })).toThrow(TypeError);
  });
});

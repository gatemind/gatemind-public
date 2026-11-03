import { describe, expect, it } from 'vitest';
import { createAuditSink } from './audit-sink';
import { MemoryAuditStorage } from './memory-storage';
import {
  DATABASE_URL_NAME,
  EXIT_BROKEN,
  EXIT_ERROR,
  EXIT_OK,
  runAuditVerifyCli,
} from './verify-cli';

const URL_WITH_PASSWORD = 'mysql://gatemind_app:S3cretPassw0rd@db.internal:3306/gatemind_audit';

async function run(
  storage: MemoryAuditStorage,
  argv: string[] = [],
  env: Record<string, string | undefined> = { [DATABASE_URL_NAME]: URL_WITH_PASSWORD },
  extra: Partial<Parameters<typeof runAuditVerifyCli>[0]> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  let closed = 0;
  const code = await runAuditVerifyCli({
    argv,
    env,
    openStorage: async () => ({
      storage,
      close: async () => {
        closed += 1;
      },
    }),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    ...extra,
  });
  return { code, out: out.join('\n'), err: err.join('\n'), closed };
}

async function filled(): Promise<MemoryAuditStorage> {
  const storage = new MemoryAuditStorage();
  const sink = createAuditSink({ storage });
  for (let i = 1; i <= 3; i += 1) {
    await sink.record({ tenantId: 'tenant-a', actor: 'user:a', action: 'x.y', target: `t:${i}` });
  }
  await sink.record({ tenantId: 'tenant-b', actor: 'user:b', action: 'x.y', target: 't:1' });
  return storage;
}

describe('audit:verify', () => {
  it('exits 0 and reports the entry count and the chain-head hash per tenant', async () => {
    const storage = await filled();
    const result = await run(storage);

    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain('Audit chain OK: 4 entries in 2 tenants');
    const head = storage.rows.find((r) => r.tenantId === 'tenant-a' && r.seq === 3)?.hash;
    expect(result.out).toContain(`tenant-a: 3 entries, head ${head}`);
    expect(result.closed).toBe(1);
  });

  it('exits non-zero and names the first broken entry', async () => {
    const storage = await filled();
    storage.rows = storage.rows.map((r) =>
      r.tenantId === 'tenant-a' && r.seq === 2 ? { ...r, target: 't:forged' } : r,
    );
    const result = await run(storage);

    expect(result.code).toBe(EXIT_BROKEN);
    expect(result.err).toContain('BROKEN at entry 2 of tenant tenant-a');
    expect(result.err).toContain('content_altered');
    expect(result.closed).toBe(1);
  });

  it('can be limited to one tenant', async () => {
    const storage = await filled();
    storage.rows = storage.rows.map((r) => (r.tenantId === 'tenant-b' ? { ...r, actor: 'x' } : r));

    expect((await run(storage, ['--tenant', 'tenant-a'])).code).toBe(EXIT_OK);
    expect((await run(storage, ['--tenant=tenant-b'])).code).toBe(EXIT_BROKEN);
  });

  it('reads the URL from a file and exits 2 when the file cannot be read', async () => {
    const storage = await filled();
    const env = { [`${DATABASE_URL_NAME}_FILE`]: '/run/secrets/audit_url' };

    const ok = await run(storage, [], env, { readFile: () => `${URL_WITH_PASSWORD}\n` });
    expect(ok.code).toBe(EXIT_OK);

    const missing = await run(storage, [], env, {
      readFile: () => {
        throw new Error('ENOENT /run/secrets/audit_url');
      },
    });
    expect(missing.code).toBe(EXIT_ERROR);
    expect(missing.err).not.toContain('ENOENT');
  });

  it.each([
    ['no URL configured', [], {}],
    [
      'both URL and file configured',
      [],
      { [DATABASE_URL_NAME]: 'a', [`${DATABASE_URL_NAME}_FILE`]: 'b' },
    ],
    ['an unknown option', ['--fix'], { [DATABASE_URL_NAME]: 'a' }],
    ['--tenant without a value', ['--tenant'], { [DATABASE_URL_NAME]: 'a' }],
  ])('exits 2 for %s', async (_name, argv, env) => {
    const result = await run(new MemoryAuditStorage(), argv, env);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).not.toBe('');
  });

  it('prints help with exit 0', async () => {
    const result = await run(new MemoryAuditStorage(), ['--help'], {});
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain('Usage: audit:verify');
  });

  it('never prints the connection URL or its password, even when connecting fails', async () => {
    const connectionFails = await run(new MemoryAuditStorage(), [], undefined, {
      openStorage: async () => {
        throw new Error(`connect failed for ${URL_WITH_PASSWORD}`);
      },
    });
    const readFails = await run(await filled(), [], undefined, {
      openStorage: async () => ({
        storage: {
          head: async () => undefined,
          append: async () => false,
          list: async () => {
            throw Object.assign(new Error(`access denied ${URL_WITH_PASSWORD}`), {
              code: 'ER_ACCESS_DENIED',
            });
          },
          listTenantIds: async () => ['tenant-a'],
        },
        close: async () => undefined,
      }),
    });

    for (const result of [connectionFails, readFails]) {
      expect(result.code).toBe(EXIT_ERROR);
      expect(`${result.out}\n${result.err}`).not.toContain('S3cretPassw0rd');
      expect(`${result.out}\n${result.err}`).not.toContain('db.internal');
    }
    expect(readFails.err).toContain('ER_ACCESS_DENIED');
  });
});

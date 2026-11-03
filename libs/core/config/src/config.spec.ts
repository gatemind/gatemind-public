import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config';
import { createEnvFileSecretStore } from './env-file-secret-store';
import { loadConfigOrExit } from './load-config-or-exit';

const goodKey = () => randomBytes(32).toString('base64');

function load(env: Record<string, string | undefined>, files: Record<string, string> = {}) {
  const secretStore = createEnvFileSecretStore({
    env,
    readTextFile: async (path) => {
      const content = files[path];
      if (content === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return content;
    },
  });
  return loadConfig({ env, secretStore });
}

async function problemsOf(
  env: Record<string, string | undefined>,
  files: Record<string, string> = {},
): Promise<readonly string[]> {
  try {
    await load(env, files);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected configuration to be rejected');
}

describe('loadConfig', () => {
  it('loads a valid production configuration from the environment', async () => {
    const config = await load({ GATEMIND_MASTER_KEY: goodKey() });
    expect(config.mode).toBe('production');
    expect(config.logLevel).toBe('info');
    expect(config.httpPort).toBe(8080);
  });

  it('refuses production start without a master key and names the setting', async () => {
    const problems = await problemsOf({ GATEMIND_ENV: 'production' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('GATEMIND_MASTER_KEY');
  });

  it('defaults to production, so an unset mode never weakens the checks', async () => {
    const problems = await problemsOf({ GATEMIND_MASTER_KEY: 'changeme'.repeat(6) });
    expect(problems.join(' ')).toContain('placeholder');
  });

  it('loads the master key from a file or secret mount', async () => {
    const key = goodKey();
    const config = await load(
      { GATEMIND_MASTER_KEY_FILE: '/run/secrets/master_key' },
      { '/run/secrets/master_key': `${key}\n` },
    );
    expect(config.masterKey.reveal()).toBe(key);
  });

  it('reports an unreadable key file without a secret or a path', async () => {
    const problems = await problemsOf({ GATEMIND_MASTER_KEY_FILE: '/nope/secret' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('GATEMIND_MASTER_KEY_FILE');
    expect(problems[0]).toContain('ENOENT');
    expect(problems[0]).not.toContain('/nope/secret');
  });

  it('refuses a configuration that sets both the variable and the file', async () => {
    const problems = await problemsOf(
      { GATEMIND_MASTER_KEY: goodKey(), GATEMIND_MASTER_KEY_FILE: '/run/secrets/k' },
      { '/run/secrets/k': goodKey() },
    );
    expect(problems.join(' ')).toContain('Set only one of');
  });

  it('lists every problem together, once', async () => {
    const problems = await problemsOf({
      GATEMIND_ENV: 'staging',
      GATEMIND_LOG_LEVEL: 'loud',
      GATEMIND_HTTP_PORT: '99999',
    });
    expect(problems).toHaveLength(4);
    const text = problems.join('\n');
    expect(text).toContain('GATEMIND_ENV');
    expect(text).toContain('GATEMIND_LOG_LEVEL');
    expect(text).toContain('GATEMIND_HTTP_PORT');
    expect(text).toContain('master key is missing');
  });

  it('refuses known placeholders and weak keys in production', async () => {
    const weak = [
      'changeme',
      'change-me-change-me-change-me-change-me',
      Buffer.alloc(32).toString('base64'),
      Buffer.from('your-master-key-goes-here-1234567').toString('base64'),
    ];
    for (const value of weak) {
      const problems = await problemsOf({ GATEMIND_MASTER_KEY: value });
      expect(problems.length).toBeGreaterThan(0);
    }
    const allZero = await problemsOf({ GATEMIND_MASTER_KEY: Buffer.alloc(32).toString('base64') });
    expect(allZero[0]).toContain('placeholder or a weak value');
  });

  it('refuses a key that is too short in every mode', async () => {
    const short = randomBytes(16).toString('base64');
    for (const mode of ['production', 'development', 'test']) {
      const problems = await problemsOf({ GATEMIND_ENV: mode, GATEMIND_MASTER_KEY: short });
      expect(problems[0]).toContain('at least 32 bytes');
    }
  });

  it('allows a weak but well-formed key outside production', async () => {
    const config = await load({
      GATEMIND_ENV: 'development',
      GATEMIND_MASTER_KEY: Buffer.alloc(32).toString('base64'),
    });
    expect(config.mode).toBe('development');
  });

  it('never exposes the master key through strings, JSON or inspect output', async () => {
    const key = goodKey();
    const config = await load({ GATEMIND_MASTER_KEY: key });
    expect(JSON.stringify(config)).not.toContain(key);
    expect(inspect(config, { depth: 5 })).not.toContain(key);
    expect(String(config.masterKey)).not.toContain(key);
  });

  it('never puts the key in an error message, even when the key is rejected', async () => {
    const rejected = 'changeme-changeme-changeme-changeme-12';
    const problems = await problemsOf({ GATEMIND_MASTER_KEY: rejected });
    expect(problems.join(' ')).not.toContain(rejected);
  });
});

describe('loadConfigOrExit', () => {
  class ExitSignal extends Error {
    constructor(readonly code: number) {
      super(`exit ${code}`);
    }
  }
  const exit = (code: number): never => {
    throw new ExitSignal(code);
  };

  it('exits non-zero with a clear message when the master key is missing', async () => {
    let output = '';
    await expect(
      loadConfigOrExit({
        env: { GATEMIND_ENV: 'production' },
        writeError: (t) => (output += t),
        exit,
      }),
    ).rejects.toMatchObject({ code: 1 });
    expect(output).toContain('Gatemind cannot start');
    expect(output).toContain('GATEMIND_MASTER_KEY');
  });

  it('prints nothing and returns the config when everything is valid', async () => {
    let output = '';
    const key = goodKey();
    const config = await loadConfigOrExit({
      env: { GATEMIND_MASTER_KEY: key },
      writeError: (t) => (output += t),
      exit,
    });
    expect(config.mode).toBe('production');
    expect(output).toBe('');
  });

  it('never prints a rejected secret when it exits', async () => {
    let output = '';
    const rejected = 'password-password-password-password-1234';
    await expect(
      loadConfigOrExit({
        env: { GATEMIND_MASTER_KEY: rejected },
        writeError: (t) => (output += t),
        exit,
      }),
    ).rejects.toMatchObject({ code: 1 });
    expect(output).not.toContain(rejected);
  });
});

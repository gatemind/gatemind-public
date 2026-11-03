import { Secret } from '@gatemind/types';
import { describe, expect, it } from 'vitest';
import { RedisStoreError } from './errors';
import { isSameInstance, parseStoreUrl } from './store-url';

const parse = (url: string) => parseStoreUrl(new Secret(url), 'cache');

describe('parseStoreUrl', () => {
  it('reads host, port, password and database', () => {
    expect(parse('redis://:s3cret@cache.internal:6380/2')).toEqual({
      host: 'cache.internal',
      port: 6380,
      username: undefined,
      password: 's3cret',
      db: 2,
      tls: false,
    });
  });

  it('uses the default port and database, and reads a user name', () => {
    const endpoint = parse('redis://gatemind:pw@localhost');
    expect(endpoint.port).toBe(6379);
    expect(endpoint.db).toBe(0);
    expect(endpoint.username).toBe('gatemind');
  });

  it('decodes an encoded password and keeps the TLS scheme', () => {
    const endpoint = parse('rediss://:p%40ss%2Fword@store.example:6380');
    expect(endpoint.password).toBe('p@ss/word');
    expect(endpoint.tls).toBe(true);
  });

  it('accepts an IPv6 host', () => {
    expect(parse('redis://[::1]:6380').host).toBe('::1');
  });

  it('rejects anything that is not a Redis URL, without echoing it', () => {
    const canary = 'canary-password-8f3a';
    for (const url of [
      'not a url',
      `mysql://user:${canary}@localhost:3306/db`,
      `http://:${canary}@localhost`,
      `redis://:${canary}@`,
      `redis://:${canary}@localhost/not-a-number`,
    ]) {
      let thrown: unknown;
      try {
        parse(url);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RedisStoreError);
      expect((thrown as RedisStoreError).code).toBe('invalid_url');
      expect((thrown as RedisStoreError).message).toContain('cache store URL');
      expect((thrown as RedisStoreError).message).not.toContain(canary);
    }
  });
});

describe('isSameInstance', () => {
  it('compares host and port, not the database number', () => {
    expect(isSameInstance(parse('redis://a:1/0'), parse('redis://a:1/5'))).toBe(true);
    expect(isSameInstance(parse('redis://A:1'), parse('redis://a:1'))).toBe(true);
    expect(isSameInstance(parse('redis://a:1'), parse('redis://a:2'))).toBe(false);
    expect(isSameInstance(parse('redis://a:1'), parse('redis://b:1'))).toBe(false);
  });
});

import { CompositionError } from '@gatemind/composition';
import { SecretSourceError } from '@gatemind/config';
import { RedisStoreError } from '@gatemind/redis-store';
import { describe, expect, it } from 'vitest';
import { describeStartupError } from './startup-error';

describe('describeStartupError', () => {
  it('shows the message of errors that are safe by contract', () => {
    expect(
      describeStartupError(
        new CompositionError('missing_setting', 'Missing required settings: GATEMIND_CACHE_URL', [
          'GATEMIND_CACHE_URL',
        ]),
      ),
    ).toContain('GATEMIND_CACHE_URL');
    expect(describeStartupError(new SecretSourceError('Set only one of A and B'))).toContain(
      'Set only one',
    );
    expect(
      describeStartupError(new RedisStoreError('unreachable', 'The cache store did not answer')),
    ).toContain('cache store');
  });

  it('names the port problem for EADDRINUSE and EACCES', () => {
    const inUse = Object.assign(new Error('listen EADDRINUSE: 0.0.0.0:8080'), {
      code: 'EADDRINUSE',
    });
    expect(describeStartupError(inUse)).toBe('The HTTP port is already in use (EADDRINUSE)');
    const denied = Object.assign(new Error('listen EACCES'), { code: 'EACCES' });
    expect(describeStartupError(denied)).toContain('EACCES');
  });

  it('shows only the type name of any other error, never its text', () => {
    const text = describeStartupError(
      new Error('ER_ACCESS_DENIED mysql://app:canary-password@h/db'),
    );
    expect(text).toContain('Error');
    expect(text).not.toContain('canary-password');
    expect(text).not.toContain('mysql://');
    expect(describeStartupError('a string with canary-password')).not.toContain('canary-password');
  });
});

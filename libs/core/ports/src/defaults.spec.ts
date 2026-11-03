import { Secret, asTenantId } from '@gatemind/types';
import { describe, expect, it } from 'vitest';
import {
  PortNotConfiguredError,
  StoreUnavailableError,
  denyAllAuthProvider,
  denyAllEntitlementChecker,
  noopUsageSink,
  unconfiguredStoragePort,
} from './index';

const tenant = asTenantId('acme');

describe('default port implementations', () => {
  it('grant no entitlement, for any tenant or capability (ARC-050)', async () => {
    expect(await denyAllEntitlementChecker.isEntitled(tenant, 'sso')).toBe(false);
    expect(await denyAllEntitlementChecker.isEntitled(tenant, '')).toBe(false);
  });

  it('reject every sign-in without saying why (SEC-081)', async () => {
    const result = await denyAllAuthProvider.authenticatePassword({
      tenantId: tenant,
      identifier: 'someone',
      password: new Secret('correct horse battery staple'),
    });
    expect(result).toEqual({ status: 'rejected' });
  });

  it('drop usage events without failing', async () => {
    await expect(
      noopUsageSink.record({
        tenantId: tenant,
        gatewayKeyId: 'k1',
        alias: 'fast',
        outcome: 'completed',
        label: 'unavailable',
      }),
    ).resolves.toBeUndefined();
  });

  it('refuse storage loudly instead of dropping data', async () => {
    await expect(unconfiguredStoragePort.put(tenant, ['a'], new Uint8Array())).rejects.toThrow(
      PortNotConfiguredError,
    );
    await expect(unconfiguredStoragePort.get(tenant, ['a'])).rejects.toThrow(
      PortNotConfiguredError,
    );
    await expect(unconfiguredStoragePort.delete(tenant, ['a'])).rejects.toThrow(
      PortNotConfiguredError,
    );
  });
});

describe('port errors', () => {
  it('have stable names and a message without connection details', () => {
    const unavailable = new StoreUnavailableError();
    expect(unavailable.name).toBe('StoreUnavailableError');
    expect(unavailable.message).toBe('The store is unavailable');
    expect(new PortNotConfiguredError('StoragePort').message).toContain('StoragePort');
  });
});

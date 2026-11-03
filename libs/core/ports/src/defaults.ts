import type { AuthProvider } from './auth-provider';
import type { EntitlementChecker } from './entitlement-checker';
import { PortNotConfiguredError } from './errors';
import type { StoragePort } from './storage-port';
import type { UsageSink } from './usage-sink';

/**
 * Default implementations for ports whose real implementation arrives in a later story.
 * Each is safe by default: it grants nothing, or does nothing, and never pretends to work.
 */

/** Drops every event, until Story 4.7 supplies the queue-backed sink. */
export const noopUsageSink: UsageSink = {
  record: async () => undefined,
};

/** The open-source edition grants no entitlement beyond its own scope (ARC-050): deny everything. */
export const denyAllEntitlementChecker: EntitlementChecker = {
  isEntitled: async () => false,
};

/** Rejects every sign-in, until Stories 1.9 to 1.12 supply the built-in authentication. */
export const denyAllAuthProvider: AuthProvider = {
  authenticatePassword: async () => ({ status: 'rejected' }),
};

/** Fails loudly instead of silently dropping data, until a story supplies real storage. */
export const unconfiguredStoragePort: StoragePort = {
  put: async () => {
    throw new PortNotConfiguredError('StoragePort');
  },
  get: async () => {
    throw new PortNotConfiguredError('StoragePort');
  },
  delete: async () => {
    throw new PortNotConfiguredError('StoragePort');
  },
};

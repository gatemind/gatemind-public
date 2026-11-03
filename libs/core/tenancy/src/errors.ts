/**
 * Raised when code tries to cross a tenant boundary or change tenant-owned identity
 * (ARC-020, SEC-003). Messages never contain row data.
 */
export class TenantIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantIsolationError';
  }
}

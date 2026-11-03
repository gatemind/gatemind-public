export type AuditErrorCode = 'invalid_event' | 'write_contention';

/**
 * Failure of the audit log. Messages are fixed text: they never include the rejected value,
 * because a rejected value may be exactly the secret that must not reach a log (SEC-050, SEC-087).
 */
export class AuditError extends Error {
  readonly code: AuditErrorCode;

  constructor(code: AuditErrorCode, message: string) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
  }
}

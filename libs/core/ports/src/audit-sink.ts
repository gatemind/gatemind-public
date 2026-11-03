/**
 * What happened, to which tenant, by whom (SEC-070). Every field is a short identifier: there is
 * deliberately no free-text or payload field, so an audit entry cannot carry a password, key,
 * token or personal data beyond the actor identifier (SEC-050).
 */
export interface AuditEvent {
  readonly tenantId: string;
  /** Who acted, as an identifier, for example `user:3f2a` or `system:setup`. Never an e-mail address. */
  readonly actor: string;
  /** What was done, for example `auth.signin.failed`. Lower case words separated by `.`. */
  readonly action: string;
  /** What it was done to, as an identifier, for example `user:3f2a` or `provider-connection:a1`. */
  readonly target: string;
}

/** Proof that an event is stored: its position in the tenant's chain and the entry hash. */
export interface AuditReceipt {
  readonly seq: number;
  readonly hash: string;
}

/**
 * Audit log port (ARC-050 family). The implementation stores entries in a hash chain so that
 * rewriting history can be detected; callers only describe the event and never see or set the
 * timestamp, sequence number or hashes.
 */
export interface AuditSink {
  /** Resolves once the entry is stored. Rejects when it cannot be stored: never drops an event. */
  record(event: AuditEvent): Promise<AuditReceipt>;
}

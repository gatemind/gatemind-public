/** One stored entry of a tenant's chain. */
export interface AuditEntry {
  readonly tenantId: string;
  readonly seq: number;
  readonly occurredAtMs: number;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly prevHash: string;
  readonly hash: string;
}

/**
 * Where the chain is kept. The database library's `AuditLogStore` fits this shape. Nothing here
 * can change or remove an entry: the log is append-only by construction (SEC-070).
 */
export interface AuditStorage {
  head(tenantId: string): Promise<AuditEntry | undefined>;
  /** False when that position or predecessor is already taken (another writer won). */
  append(entry: AuditEntry): Promise<boolean>;
  list(tenantId: string, options: { afterSeq: number; limit: number }): Promise<AuditEntry[]>;
  listTenantIds(): Promise<string[]>;
}

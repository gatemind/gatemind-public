import type { TenantDb } from '@gatemind/tenancy';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { isDuplicateKeyError } from '../db-errors';
import { auditLog } from './audit-log-schema';

/** One stored audit entry. Every field is an identifier or a hash; nothing is free text. */
export interface AuditLogRow {
  readonly tenantId: string;
  readonly seq: number;
  readonly occurredAtMs: number;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly prevHash: string;
  readonly hash: string;
}

export interface AuditListOptions {
  /** Only entries with a higher sequence number. */
  readonly afterSeq: number;
  readonly limit: number;
}

function toRow(row: typeof auditLog.$inferSelect): AuditLogRow {
  return {
    tenantId: row.tenantId,
    seq: row.seq,
    occurredAtMs: row.occurredAtMs,
    actor: row.actor,
    action: row.action,
    target: row.target,
    prevHash: row.prevHash,
    hash: row.hash,
  };
}

/**
 * Storage of the audit chain. It only reads and inserts: the application database user has no
 * `UPDATE` or `DELETE` on this table (SEC-070), and this class has no method that would need one.
 * Every query of one tenant carries its `tenant_id`; only `listTenantIds` looks across tenants,
 * for the verification tool.
 */
export class AuditLogStore {
  constructor(private readonly db: TenantDb) {}

  /** The newest entry of a tenant's chain. */
  async head(tenantId: string): Promise<AuditLogRow | undefined> {
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenantId))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /**
   * Adds an entry. Returns false when another writer already stored that position or extended
   * the same entry (a lost race), so the caller reads the head again and retries.
   */
  async append(entry: AuditLogRow): Promise<boolean> {
    try {
      await this.db.insert(auditLog).values({ ...entry });
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  /** Entries of one tenant in chain order. */
  async list(tenantId: string, options: AuditListOptions): Promise<AuditLogRow[]> {
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), gt(auditLog.seq, options.afterSeq)))
      .orderBy(asc(auditLog.seq))
      .limit(options.limit);
    return rows.map(toRow);
  }

  /** Every tenant that has at least one entry, in a stable order. */
  async listTenantIds(): Promise<string[]> {
    const rows = await this.db
      .select({ tenantId: auditLog.tenantId })
      .from(auditLog)
      .groupBy(auditLog.tenantId)
      .orderBy(asc(auditLog.tenantId));
    return rows.map((row) => row.tenantId);
  }
}

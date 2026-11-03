import type { AuditEntry, AuditStorage } from './storage';

/**
 * In-memory chain for unit tests. `rows` is public on purpose so a test can alter, delete or
 * reorder entries the way someone with direct database access could, and prove the verifier
 * notices. It enforces the same two uniqueness rules as the real table.
 */
export class MemoryAuditStorage implements AuditStorage {
  rows: AuditEntry[] = [];

  async head(tenantId: string): Promise<AuditEntry | undefined> {
    const own = this.rows.filter((row) => row.tenantId === tenantId);
    return own.reduce<AuditEntry | undefined>(
      (best, row) => (best === undefined || row.seq > best.seq ? row : best),
      undefined,
    );
  }

  async append(entry: AuditEntry): Promise<boolean> {
    // Yield once so concurrent writers really interleave, as they do against a database.
    await Promise.resolve();
    const taken = this.rows.some(
      (row) =>
        row.tenantId === entry.tenantId &&
        (row.seq === entry.seq || row.prevHash === entry.prevHash || row.hash === entry.hash),
    );
    if (taken) return false;
    this.rows.push({ ...entry });
    return true;
  }

  async list(
    tenantId: string,
    options: { afterSeq: number; limit: number },
  ): Promise<AuditEntry[]> {
    return this.rows
      .filter((row) => row.tenantId === tenantId && row.seq > options.afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, options.limit)
      .map((row) => ({ ...row }));
  }

  async listTenantIds(): Promise<string[]> {
    return [...new Set(this.rows.map((row) => row.tenantId))].sort();
  }
}

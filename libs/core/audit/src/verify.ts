import { GENESIS_HASH, computeEntryHash } from './chain';
import type { AuditStorage } from './storage';

export type BrokenReason =
  /** The sequence jumps: an entry was deleted (or entries were moved). */
  | 'missing_entry'
  /** The entry does not point at the hash of the entry before it: reordered or an earlier one replaced. */
  | 'link_broken'
  /** The stored hash is not the hash of the stored fields: the entry was altered. */
  | 'content_altered';

export interface BrokenEntry {
  readonly tenantId: string;
  /** Sequence number of the first entry that does not fit the chain. */
  readonly seq: number;
  readonly reason: BrokenReason;
  readonly message: string;
}

export interface TenantChainReport {
  readonly tenantId: string;
  readonly entries: number;
  /** Hash of the newest entry; undefined when the tenant has no entries. */
  readonly headHash: string | undefined;
}

export type VerifyAuditResult =
  | { readonly ok: true; readonly entries: number; readonly tenants: readonly TenantChainReport[] }
  | {
      readonly ok: false;
      readonly broken: BrokenEntry;
      /** Entries that were checked and fine before the break. */
      readonly entriesVerified: number;
    };

export interface VerifyAuditOptions {
  /** Verify only this tenant. Default: every tenant that has entries. */
  readonly tenantId?: string;
  readonly batchSize?: number;
}

const MESSAGES: Record<BrokenReason, string> = {
  missing_entry: 'an entry before it is missing',
  link_broken: 'it does not follow the entry before it',
  content_altered: 'its content does not match its hash',
};

/**
 * Walks every chain from the first entry and recomputes it (FR-5). Stops at the first entry that
 * does not fit and names it. Checked per entry, in this order: the sequence has no gap, the
 * previous-hash is the hash of the entry before, the stored hash is the recomputed hash.
 *
 * What this cannot see: removing the newest entries leaves a shorter but valid chain, and someone
 * who can write to the database could rewrite an entry and every hash after it. Keep the
 * reported entry count and head hash somewhere outside the database (SEC-070 external anchoring).
 */
export async function verifyAuditChain(
  storage: AuditStorage,
  options: VerifyAuditOptions = {},
): Promise<VerifyAuditResult> {
  const batchSize = options.batchSize ?? 500;
  const tenantIds =
    options.tenantId === undefined ? await storage.listTenantIds() : [options.tenantId];

  const tenants: TenantChainReport[] = [];
  let entries = 0;

  for (const tenantId of tenantIds) {
    let expectedSeq = 1;
    let previousHash = GENESIS_HASH;
    let count = 0;

    for (;;) {
      const batch = await storage.list(tenantId, { afterSeq: expectedSeq - 1, limit: batchSize });
      if (batch.length === 0) break;

      for (const entry of batch) {
        let reason: BrokenReason | undefined;
        if (entry.seq !== expectedSeq) reason = 'missing_entry';
        else if (entry.prevHash !== previousHash) reason = 'link_broken';
        else if (computeEntryHash(entry) !== entry.hash) reason = 'content_altered';

        if (reason !== undefined) {
          return {
            ok: false,
            entriesVerified: entries,
            broken: {
              tenantId,
              seq: entry.seq,
              reason,
              message: `Entry ${entry.seq} of tenant ${tenantId}: ${MESSAGES[reason]}`,
            },
          };
        }
        previousHash = entry.hash;
        expectedSeq += 1;
        count += 1;
        entries += 1;
      }
    }

    tenants.push({ tenantId, entries: count, headHash: count === 0 ? undefined : previousHash });
  }

  return { ok: true, entries, tenants };
}

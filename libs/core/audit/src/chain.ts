import { createHash } from 'node:crypto';

/** `prev_hash` of the first entry of every tenant chain. */
export const GENESIS_HASH = '0'.repeat(64);

/** Names the hashed layout. A different layout would get a new name, never reuse this one. */
export const ENTRY_FORMAT = 'gatemind-audit-v1';

/** Everything an entry hash covers. Changing any of these in the database breaks the hash. */
export interface HashedFields {
  readonly tenantId: string;
  readonly seq: number;
  readonly occurredAtMs: number;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly prevHash: string;
}

/**
 * SHA-256 over a JSON array of the fields in a fixed order. JSON quotes and escapes every string,
 * so no two different field combinations can produce the same input (no separator tricks).
 * The previous hash is part of the input, which is what links entries into a chain.
 */
export function computeEntryHash(fields: HashedFields): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        ENTRY_FORMAT,
        fields.tenantId,
        fields.seq,
        fields.occurredAtMs,
        fields.actor,
        fields.action,
        fields.target,
        fields.prevHash,
      ]),
    )
    .digest('hex');
}

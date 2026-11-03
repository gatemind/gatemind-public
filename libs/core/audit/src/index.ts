export { createAuditSink, type AuditSinkOptions } from './audit-sink';
export { ENTRY_FORMAT, GENESIS_HASH, type HashedFields, computeEntryHash } from './chain';
export { AuditError, type AuditErrorCode } from './errors';
export { MemoryAuditStorage } from './memory-storage';
export type { AuditEntry, AuditStorage } from './storage';
export { validateAuditEvent } from './validate';
export {
  type BrokenEntry,
  type BrokenReason,
  type TenantChainReport,
  type VerifyAuditOptions,
  type VerifyAuditResult,
  verifyAuditChain,
} from './verify';
export {
  type AuditVerifyCliOptions,
  DATABASE_URL_NAME,
  EXIT_BROKEN,
  EXIT_ERROR,
  EXIT_OK,
  runAuditVerifyCli,
} from './verify-cli';

import { readFileSync } from 'node:fs';
import type { AuditStorage } from './storage';
import { verifyAuditChain } from './verify';

export const EXIT_OK = 0;
export const EXIT_BROKEN = 1;
export const EXIT_ERROR = 2;

export const DATABASE_URL_NAME = 'GATEMIND_AUDIT_DATABASE_URL';

const USAGE = `Usage: audit:verify [--tenant <tenant id>]

Verifies the hash chain of the audit log (SEC-070, FR-5).
Reads the connection URL of the audit database from ${DATABASE_URL_NAME} or from the file
named by ${DATABASE_URL_NAME}_FILE. The application database user is enough: this only reads.

Exit code 0: every chain is intact. 1: an entry was altered, removed or reordered (the first one
is named). 2: the check could not run (usage, configuration or connection problem).`;

export interface AuditVerifyCliOptions {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Opens the audit storage for a connection URL. The URL holds a password: never print it. */
  openStorage(url: string): Promise<{ storage: AuditStorage; close(): Promise<void> }>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly readFile?: (path: string) => string;
}

function parseArgs(argv: readonly string[]): { tenantId?: string; help: boolean } | undefined {
  let tenantId: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--tenant') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return undefined;
      tenantId = value;
      i += 1;
    } else if (arg?.startsWith('--tenant=')) tenantId = arg.slice('--tenant='.length);
    else return undefined;
  }
  return tenantId === '' ? undefined : { ...(tenantId === undefined ? {} : { tenantId }), help };
}

/**
 * The verification tool (Story 1.6). Returns the process exit code: 0 intact, 1 broken,
 * 2 could not run. Messages never contain the connection URL or any credential.
 */
export async function runAuditVerifyCli(options: AuditVerifyCliOptions): Promise<number> {
  const { stdout, stderr } = options;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));

  const args = parseArgs(options.argv);
  if (args === undefined) {
    stderr(USAGE);
    return EXIT_ERROR;
  }
  if (args.help) {
    stdout(USAGE);
    return EXIT_OK;
  }

  const direct = options.env[DATABASE_URL_NAME];
  const filePath = options.env[`${DATABASE_URL_NAME}_FILE`];
  const hasDirect = direct !== undefined && direct !== '';
  const hasFile = filePath !== undefined && filePath !== '';
  if (hasDirect === hasFile) {
    stderr(`Set exactly one of ${DATABASE_URL_NAME} or ${DATABASE_URL_NAME}_FILE`);
    return EXIT_ERROR;
  }

  let url: string;
  try {
    url = hasFile ? readFile(filePath).trim() : (direct ?? '');
  } catch {
    stderr(`Cannot read the file named by ${DATABASE_URL_NAME}_FILE`);
    return EXIT_ERROR;
  }

  let opened: Awaited<ReturnType<AuditVerifyCliOptions['openStorage']>>;
  try {
    opened = await options.openStorage(url);
  } catch {
    stderr(`The audit database URL in ${DATABASE_URL_NAME} is not valid`);
    return EXIT_ERROR;
  }

  try {
    const result = await verifyAuditChain(opened.storage, {
      ...(args.tenantId === undefined ? {} : { tenantId: args.tenantId }),
    });

    if (!result.ok) {
      stderr(
        `Audit chain BROKEN at entry ${result.broken.seq} of tenant ${result.broken.tenantId}: ` +
          `${result.broken.reason}. ${result.broken.message}`,
      );
      stderr(`Entries verified before the break: ${result.entriesVerified}`);
      return EXIT_BROKEN;
    }

    stdout(
      `Audit chain OK: ${result.entries} ${result.entries === 1 ? 'entry' : 'entries'} in ` +
        `${result.tenants.length} ${result.tenants.length === 1 ? 'tenant' : 'tenants'}.`,
    );
    for (const tenant of result.tenants) {
      stdout(
        `  ${tenant.tenantId}: ${tenant.entries} entries, head ${tenant.headHash ?? '(none)'}`,
      );
    }
    stdout('Record the entry counts and head hashes outside the database to detect truncation.');
    return EXIT_OK;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    stderr(`The audit log could not be read${typeof code === 'string' ? ` (${code})` : ''}`);
    return EXIT_ERROR;
  } finally {
    await opened.close().catch(() => undefined);
  }
}

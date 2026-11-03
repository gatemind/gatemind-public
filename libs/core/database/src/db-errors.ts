const ER_DUP_ENTRY = 1062;

/** MySQL error number, also when the driver error is wrapped as the `cause` of another error. */
export function mysqlErrno(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const { errno, cause } = current as { errno?: unknown; cause?: unknown };
    if (typeof errno === 'number') return errno;
    current = cause;
  }
  return undefined;
}

export function isDuplicateKeyError(error: unknown): boolean {
  return mysqlErrno(error) === ER_DUP_ENTRY;
}

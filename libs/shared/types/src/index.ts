/** Nominal ("branded") typing helper. */
export type Brand<T, B extends string> = T & { readonly __brand: B };

/** Milliseconds since the Unix epoch. */
export type EpochMs = Brand<number, 'EpochMs'>;

const REDACTED = '[redacted]';
const nodeInspect = Symbol.for('nodejs.util.inspect.custom');

/**
 * Wraps a secret value so it cannot leak by accident (SEC-012, SEC-087).
 * String conversion, JSON serialization and console/inspect output all print a redaction
 * marker. The only way to read the value is the explicit `reveal()` call.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [nodeInspect](): string {
    return REDACTED;
  }
}

/**
 * Identifier of the top-level isolation unit, the organization (ARC-024).
 * The format is deliberately narrow so a tenant id is always safe inside cache keys, queue job
 * names, file paths and log fields (ARC-023): no separators, no whitespace, at most 64 characters.
 */
export type TenantId = Brand<string, 'TenantId'>;

const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isTenantId(value: unknown): value is TenantId {
  return typeof value === 'string' && TENANT_ID_PATTERN.test(value);
}

export function asTenantId(value: string): TenantId {
  if (!isTenantId(value)) {
    throw new TypeError(
      'Invalid tenant id: use 1 to 64 letters, digits, "_" or "-", starting with a letter or digit',
    );
  }
  return value;
}

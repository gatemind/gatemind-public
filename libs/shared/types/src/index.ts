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

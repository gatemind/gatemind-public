/** Nominal ("branded") typing helper. */
export type Brand<T, B extends string> = T & { readonly __brand: B };

/** Milliseconds since the Unix epoch. */
export type EpochMs = Brand<number, 'EpochMs'>;

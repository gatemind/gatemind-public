export type CompositionErrorCode = 'missing_setting';

/**
 * Raised when the composition root cannot be built from the configuration. The message names the
 * missing settings and never a value, a URL or a password (SEC-012, SEC-087).
 */
export class CompositionError extends Error {
  readonly code: CompositionErrorCode;
  readonly settings: readonly string[];

  constructor(code: CompositionErrorCode, message: string, settings: readonly string[]) {
    super(message);
    this.name = 'CompositionError';
    this.code = code;
    this.settings = settings;
  }
}

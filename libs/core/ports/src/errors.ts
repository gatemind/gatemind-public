/**
 * Raised (as a rejection) when a store-backed port cannot reach its store (SEC-022).
 * Callers decide what an outage means for their control: security controls (rate limits, caps,
 * revocation) refuse the request, non-security uses such as caching treat it as a miss.
 * The message never contains a connection URL, host or password.
 */
export class StoreUnavailableError extends Error {
  constructor(message = 'The store is unavailable') {
    super(message);
    this.name = 'StoreUnavailableError';
  }
}

/** Raised by the default implementation of a port that a later story has not supplied yet. */
export class PortNotConfiguredError extends Error {
  constructor(port: string) {
    super(`${port} has no implementation configured in this build`);
    this.name = 'PortNotConfiguredError';
  }
}

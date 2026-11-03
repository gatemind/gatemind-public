import type { Secret, TenantId } from '@gatemind/types';

export interface AuthSubject {
  readonly tenantId: TenantId;
  readonly userId: string;
}

export interface PasswordCredentials {
  readonly tenantId: TenantId;
  /** What the user typed to identify themselves. Never logged. */
  readonly identifier: string;
  readonly password: Secret;
}

/**
 * The result never says why a sign-in was rejected, so a caller cannot reveal whether an account
 * exists (SEC-081).
 */
export type AuthResult =
  | { readonly status: 'authenticated'; readonly subject: AuthSubject }
  | { readonly status: 'rejected' };

/**
 * Authentication port (ARC-035). `[PROPOSED]` shape: the OSS addendum to ADR 0004 and Stories 1.9
 * to 1.12 own the final form and the implementation. Until then the default rejects everyone.
 */
export interface AuthProvider {
  authenticatePassword(credentials: PasswordCredentials): Promise<AuthResult>;
}

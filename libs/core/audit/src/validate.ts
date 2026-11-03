import type { AuditEvent } from '@gatemind/ports';
import { isTenantId } from '@gatemind/types';
import { AuditError } from './errors';

// Identifiers only. No space, no `@` (an e-mail address is personal data), no quotes or `=`
// (so a header or a `key=value` pair cannot be pushed through), and bounded to the column size.
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,127}$/;
const ACTION = /^[a-z][a-z0-9_.-]{0,63}$/;
const TARGET = /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,127}$/;

function check(field: string, value: unknown, pattern: RegExp): void {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new AuditError('invalid_event', `The audit event ${field} is not valid`);
  }
}

/**
 * An audit event may only hold identifiers (SEC-050). The error names the field and never the
 * value. Because the event has no free-text field, a password, key, token or e-mail address has
 * nowhere to go, and one that is passed in an identifier field fails the character rules.
 */
export function validateAuditEvent(event: AuditEvent): void {
  if (typeof event !== 'object' || event === null) {
    throw new AuditError('invalid_event', 'The audit event is not valid');
  }
  if (!isTenantId(event.tenantId)) {
    throw new AuditError('invalid_event', 'The audit event tenant id is not valid');
  }
  check('actor', event.actor, ACTOR);
  check('action', event.action, ACTION);
  check('target', event.target, TARGET);
}

const KNOWN_PLACEHOLDERS = new Set([
  'changeme',
  'change-me',
  'change_me',
  'password',
  'passw0rd',
  'secret',
  'default',
  'example',
  'test',
  'testing',
  'dev',
  'development',
  'admin',
  'master',
  'masterkey',
  'master-key',
  'master_key',
  'todo',
  'placeholder',
  'replaceme',
  'replace-me',
  'qwerty',
  '12345678',
  '123456789',
  '1234567890',
]);

const PLACEHOLDER_FRAGMENTS =
  /(change.?me|placeholder|example|replace.?me|your.?(master.?)?key|default|password|passw0rd|secret|todo)/i;

/** A real random key has far more distinct characters than this. */
const MIN_DISTINCT_CHARACTERS = 8;

function looksInsecure(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return true;
  if (KNOWN_PLACEHOLDERS.has(normalized)) return true;
  if (PLACEHOLDER_FRAGMENTS.test(normalized)) return true;
  return new Set(normalized).size < MIN_DISTINCT_CHARACTERS;
}

/**
 * True when a configured secret is a known placeholder, a default or a trivially weak value
 * (SEC-080). The value is also checked after base64 decoding, so an encoded placeholder or an
 * all-zero key is caught too. This function never returns or logs the value.
 */
export function isInsecurePlaceholder(value: string): boolean {
  if (looksInsecure(value)) return true;
  const decoded = Buffer.from(value, 'base64').toString('latin1');
  return decoded.length > 0 && looksInsecure(decoded);
}

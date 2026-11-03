export { EncryptionError, type EncryptionErrorCode } from './errors';
export {
  ENVELOPE_PREFIX,
  type EnvelopeEncryption,
  type EnvelopeEncryptionOptions,
  type EnvelopeOptions,
  createEnvelopeEncryption,
  dekWrapAad,
} from './envelope-encryption';
export type { TenantKeyDirectory, TenantKeyStorage } from './key-storage';
export {
  MASTER_KEY_NAME,
  PREVIOUS_MASTER_KEY_NAME,
  createLocalKeyManagement,
} from './local-key-management';
export {
  type MasterKeyRotationOptions,
  type MasterKeyRotationResult,
  rotateMasterKey,
} from './master-key-rotation';
export { createMemoryTenantKeyDirectory } from './memory-key-store';

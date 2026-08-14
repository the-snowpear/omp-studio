export { Win32PlatformPort } from "./win32-platform-port.js";
export { Win32RuntimeContainment } from "./win32-runtime-containment.js";
export { Win32PrivateEndpoint } from "./private-endpoint.js";
export type { Win32PlatformServices, Win32ProcessController } from "./win32-services.js";
export type { PrivateEndpointLease, Win32EndpointProviders } from "./private-endpoint.js";
export {
  Win32AuthorityLock,
  AuthorityLockError,
  AuthorityAlreadyOwnedError,
  AuthorityLockCorruptError,
  AuthorityLockContentionError,
  assertWin32AuthorityLockServices,
  AUTHORITY_LOCK_MAX_ACQUIRE_RETRIES,
  AUTHORITY_LOCK_METADATA_MAX_BYTES,
} from "./authority-lock.js";
export type {
  AuthorityLease,
  AuthorityLockMetadata,
  Win32AuthorityLockOptions,
  Win32AuthorityLockServices,
  Win32AuthorityLockFilesystem,
  Win32AuthorityLockLiveness,
  Win32AuthorityLockClock,
  Win32AuthorityLockRandom,
} from "./authority-lock.js";

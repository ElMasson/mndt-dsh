/**
 * Host face of the browser package: types and pure rules only.
 *
 * The persisted authority and its service live in `@deepseek-ai/dsh-host-governance`,
 * because this package is browser-pure and must not touch the filesystem. This
 * face stays a no-op so the Cordis row for the browser bundle has something to
 * load on the Host side.
 */

export {
  ALL_CAPABILITIES,
  RbacTable,
  asRole,
  capabilitiesOf,
  compareRoles,
  type Capability,
  type Decision,
  type Grant,
  type RbacSnapshot,
  type Role,
} from './rbac.ts'
export {
  GovernanceController,
  MemoryRbacStorage,
  type RbacStorage,
} from './governance.ts'

/** Node plugin body: the Host authority is provided by the host package. */
export function apply(): void {}

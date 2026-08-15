/** Package-owned invariant companion. @module @deepseek-ai/dsh-rollback/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-rollback'

/** Cordis companion plugin name. */
export const name = 'rollback-invariant'
/** Services required before the companion can reserve and check package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: every rollback rewinds through the agent-loop rewind,
 * whose turn/step enclosure and persisted-prefix contracts are asserted by the
 * agent-loop, session, and persistence companions; the service itself owns no
 * event stream or mutable data beyond the registry lookups it performs.
 */
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['rollback'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

/** Package-owned invariant companion. @module @deepseek-ai/dsh-polish/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-polish'

/** Cordis companion plugin name. */
export const name = 'polish-invariant'
/** Services required before the companion can reserve and check package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: every polish request and its model reply travel
 * through the agent channel as ordinary `user/message` / `assistant/message`
 * session events, whose turn/step enclosure and model-visible reconstruction
 * contracts are asserted by the agent-loop and session companions. The service
 * owns no event stream or mutable data of its own beyond registry lookups.
 */
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['polish'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

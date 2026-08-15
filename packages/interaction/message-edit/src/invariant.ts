/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-message-edit`.
 * @module @deepseek-ai/dsh-message-edit/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-message-edit'

/** Cordis companion plugin name. */
export const name = 'message-edit-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the replacement event is validated by the session
 * surface fold itself (surfaceOp/provenance/contiguity are enforced at
 * append time by dsh-session), which the persistence contract exercises;
 * the service owns no store and emits no cordis events.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

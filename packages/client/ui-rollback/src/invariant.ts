/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-rollback`.
 * @module @deepseek-ai/dsh-client-ui-rollback/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-rollback'

/** Cordis companion plugin name. */
export const name = 'client-ui-rollback-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: a single assistant-leading-actions list entry whose
 * disposal is proven by the HMR-safety spec — the plugin owns no store, emits
 * no cordis events, and holds no cross-plugin mutable state; the rollback
 * turn's durable record is the dsh-rollback companion's subject.
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

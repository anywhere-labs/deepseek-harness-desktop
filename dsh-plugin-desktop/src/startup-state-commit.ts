/** Durable Profile and install-WAL commits for one Desktop startup. */

import type {
  DesktopInstallRecoveryClaim,
  DesktopInstallRecoveryFailureReason,
  DesktopInstallRecoveryStore,
  DesktopInstallRecoveryTransaction,
} from './install-recovery.ts'
import {
  markDesktopProfileFailed,
  markDesktopProfileHealthy,
  type DesktopProfileStartup,
} from './profile-manager.ts'
import {
  routeDesktopStartupFailure,
  type DesktopStartupFailureRoute,
} from './startup-failure-routing.ts'
import type { DesktopStartupFailureStage } from './startup-recovery-window.ts'

const BIN_NAME = 'dsh-plugin-desktop'

export interface DesktopStartupStateCommitLogger {
  error(message: string): void
}

export interface DesktopStartupStateCommitOptions {
  readonly profile: DesktopProfileStartup
  readonly profileStatePath: string
  readonly installRecovery: DesktopInstallRecoveryStore
  readonly quiesceForRecovery: () => Promise<boolean>
  readonly logger: DesktopStartupStateCommitLogger
}

export interface DesktopStartupFailureCommitInput {
  readonly appReady: boolean
  readonly stage: DesktopStartupFailureStage
  readonly failureReason: DesktopInstallRecoveryFailureReason
}

export interface DesktopStartupFailureCommitResult {
  readonly route: DesktopStartupFailureRoute
  readonly recoveryActionsSafe: boolean
  readonly reopenLastKnownGood?: string
}

/** Own the ordered durable state transitions for one selected Profile generation. */
export class DesktopStartupStateCommit {
  private verifyingInstall: DesktopInstallRecoveryTransaction | undefined
  private verifiedInstallToClear: DesktopInstallRecoveryTransaction | undefined

  constructor(private readonly options: DesktopStartupStateCommitOptions) {}

  /** Retain only install recovery state that participates in a later startup commit. */
  observeInstallRecoveryClaim(claim: DesktopInstallRecoveryClaim): void {
    if (claim.action === 'verify') {
      this.verifyingInstall = claim.transaction
    } else if (claim.action === 'terminal' && claim.transaction.phase === 'verified') {
      this.verifiedInstallToClear = claim.transaction
    }
  }

  /** Commit install verification before promoting the selected Profile. */
  async commitHealthy(): Promise<void> {
    if (this.verifyingInstall !== undefined) {
      const verified = await this.options.installRecovery.markHealthy(
        this.verifyingInstall.transactionId,
      )
      this.verifyingInstall = undefined
      this.verifiedInstallToClear = verified
    }
    markDesktopProfileHealthy(
      this.options.profileStatePath,
      this.options.profile.profileName,
    )
    if (this.verifiedInstallToClear === undefined) return
    try {
      await this.options.installRecovery.clear(this.verifiedInstallToClear.transactionId)
      this.verifiedInstallToClear = undefined
    } catch (cause) {
      this.options.logger.error(
        `${BIN_NAME}: failed to clear verified plugin install recovery state: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
  }

  /** Persist an explicit, already-quiesced return to the last healthy Profile. */
  restoreLastKnownGoodProfile(): string {
    return markDesktopProfileFailed(
      this.options.profileStatePath,
      this.options.profile.profileName,
    ).active
  }

  /** Quiesce before persisting a failure for an install that changed this generation. */
  async commitFailure(
    input: DesktopStartupFailureCommitInput,
  ): Promise<DesktopStartupFailureCommitResult> {
    const route = routeDesktopStartupFailure({
      appReady: input.appReady,
      stage: input.stage,
      verifyingProtectedInstall: this.verifyingInstall !== undefined,
      profile: {
        active: this.options.profile.profileName,
        lastKnownGood: this.options.profile.state.lastKnownGood,
      },
    })
    const recoveryActionsSafe = await this.options.quiesceForRecovery()
    if (!recoveryActionsSafe) return { route, recoveryActionsSafe }
    if (route === 'protected-install-recovery' && this.verifyingInstall !== undefined) {
      const transaction = this.verifyingInstall
      this.options.logger.error(
        `${BIN_NAME}: plugin install ${transaction.packageName} (${transaction.transactionId}) requires recovery after ${input.failureReason}`,
      )
      try {
        await this.options.installRecovery.recordFailure(
          transaction.transactionId,
          input.failureReason,
        )
      } catch (cause) {
        this.options.logger.error(
          `${BIN_NAME}: failed to persist plugin recovery choice state for ${transaction.packageName}: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      }
      return { route, recoveryActionsSafe }
    }
    try {
      markDesktopProfileFailed(
        this.options.profileStatePath,
        this.options.profile.profileName,
      )
      if (route === 'last-known-good') {
        return {
          route,
          recoveryActionsSafe,
          reopenLastKnownGood: this.options.profile.state.lastKnownGood,
        }
      }
    } catch (cause) {
      this.options.logger.error(
        `${BIN_NAME}: failed to roll back desktop profile state: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
    return { route, recoveryActionsSafe }
  }
}

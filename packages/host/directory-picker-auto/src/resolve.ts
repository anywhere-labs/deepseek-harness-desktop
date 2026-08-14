/**
 * Boot-time backend resolution for the adaptive directory-picker composition:
 * one pure decision from sampled host facts to a concrete backend kind. The
 * caller samples exactly once per boot, so the mounted capability stays
 * stable for the service lifetime as the seam requires.
 * @module @deepseek-ai/dsh-host-directory-picker-auto/resolve
 */

import type { Config as HttpServerConfig } from '@deepseek-ai/dsh-host-webserver'

/** Concrete interaction backend the resolver chooses between. */
export type DirectoryPickerBackendKind = 'native' | 'browse'

/** Environment keys the resolution reads (a `process.env` subset). */
export type DirectoryPickerEnv = Readonly<
  Partial<Record<'SSH_CONNECTION' | 'SSH_TTY' | 'DISPLAY' | 'WAYLAND_DISPLAY', string>>
>

/** Host facts the backend choice is a pure function of, sampled once at boot. */
export interface DirectoryPickerHostFacts {
  /** Effective webserver bind host (the schema's closed loopback/all-interfaces union). */
  bindHost: HttpServerConfig['host']
  /** Host process platform. */
  platform: NodeJS.Platform
  /** Environment sample; SSH marks a remote operator, DISPLAY/WAYLAND_DISPLAY a Linux display. */
  env: DirectoryPickerEnv
  /** Whether a Linux chooser binary the native backend can drive (zenity/kdialog) is on PATH; consulted only when `platform` is linux. */
  linuxChooser: boolean
}

/** An env value counts only when set and non-blank (an empty export is "unset" by shell convention). */
const present = (value: string | undefined): boolean => value !== undefined && value !== ''

/**
 * Resolve which backend serves this boot. `native` requires every signal that
 * the operator can see the host display and the native backend can serve it:
 * a loopback-only bind (an all-interfaces bind admits remote browsers no OS
 * chooser can reach), no SSH launch (under SSH port-forwarding the chooser
 * would open on the unattended server), and a servable display session —
 * assumed on darwin, requiring `DISPLAY`/`WAYLAND_DISPLAY` plus a
 * chooser binary on linux. Windows currently resolves to `browse` because
 * its native dialog worker is not a reliable path. Anything ambiguous
 * resolves to `browse`, which works everywhere.
 * @param facts - the sampled host facts.
 * @returns the backend kind to mount.
 */
export function resolveDirectoryPickerBackend(facts: DirectoryPickerHostFacts): DirectoryPickerBackendKind {
  if (facts.bindHost !== '127.0.0.1') return 'browse'
  if (present(facts.env.SSH_CONNECTION) || present(facts.env.SSH_TTY)) return 'browse'
  if (facts.platform === 'win32') return 'browse'
  if (facts.platform === 'darwin') return 'native'
  if (facts.platform !== 'linux' || !facts.linuxChooser) return 'browse'
  return present(facts.env.DISPLAY) || present(facts.env.WAYLAND_DISPLAY) ? 'native' : 'browse'
}

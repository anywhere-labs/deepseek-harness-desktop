/** Desktop-owned package-manager capability for the active DSH profile. */

import { createRequire } from 'node:module'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Readable } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { assertDesktopProfileName } from './profile-manager.ts'

const BIN_NAME = 'dsh-plugin-desktop'
const ELECTRON_HEADERS_URL = 'https://electronjs.org/headers'
const TERMINATION_GRACE_MS = 3_000

/** Launcher-resolved values used by the active desktop pnpm generation. */
export interface DesktopPnpmBootstrap {
  /** Profile selected for this immutable Cordis generation. */
  readonly activeProfileName: string
  /** Absolute directory containing the active profile manifest. */
  readonly activeProfileDir: string
  /** Harness home containing every managed profile. */
  readonly homeDir: string
  /** Electron executable reused through RunAsNode. */
  readonly appExecutable: string
  /** Physical JavaScript entry for the packaged pnpm release. */
  readonly pnpmBinPath: string
  /** Electron version used when pnpm installs native dependencies. */
  readonly electronVersion: string
  /** Private directory containing the Electron-backed Node command. */
  readonly nodeBinDir: string
  /** Private Electron-backed Node command used by pnpm lifecycle scripts. */
  readonly nodeShimPath: string
  /** Preloaded module that removes RunAsNode before a JavaScript entry executes. */
  readonly clearEnvironmentPath: string
  /** Desktop bootstrap that clears RunAsNode before importing the packaged DSH CLI. */
  readonly dshBootstrapPath: string
}

/** Exit facts for one desktop-owned package-manager operation. */
export interface DesktopPnpmOutcome {
  /** Process exit code, or `null` when a signal terminated the operation. */
  readonly exitCode: number | null
  /** Terminating signal, or `null` after a normal exit. */
  readonly signal: NodeJS.Signals | null
}

/** Streaming handle for one package-manager operation. */
export interface DesktopPnpmHandle {
  /** Standard output emitted by DSH and pnpm. */
  readonly stdout: Readable
  /** Standard error emitted by DSH and pnpm. */
  readonly stderr: Readable
  /** Settles only after the complete operation process tree has exited. */
  readonly done: Promise<DesktopPnpmOutcome>
  /** Begin termination of the complete operation process tree. */
  cancel(): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Launcher-private inputs from which the Host provider constructs the service. */
    desktopPnpmBootstrap: DesktopPnpmBootstrap
    /** Package-manager operations scoped to the active desktop profile generation. */
    desktopPnpm: DesktopPnpm
  }
}

interface ActiveOperation {
  child: SubprocessHandle
  done: Promise<DesktopPnpmOutcome>
}

/** Read PATH with Windows-compatible environment-name matching. */
function inheritedPath(): string {
  const exact = process.env.PATH
  if (exact !== undefined || process.platform !== 'win32') return exact ?? ''
  return Object.entries(process.env)
    .find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
}

/** Reject an unsafe or unresolved bootstrap path. */
function assertAbsolutePath(label: string, value: string): void {
  if (value.length === 0 || value.includes('\0') || !isAbsolute(value)) {
    throw new Error(`${BIN_NAME}: desktop pnpm ${label} must be an absolute path without NUL`)
  }
}

/** Validate one argv list before it crosses the process boundary. */
function validatedArgs(args: readonly string[]): string[] {
  if (args.length === 0) {
    throw new Error(`${BIN_NAME}: desktop pnpm arguments must not be empty`)
  }
  if (args.some(argument => argument.includes('\0'))) {
    throw new Error(`${BIN_NAME}: desktop pnpm arguments must not contain NUL`)
  }
  return [...args]
}

/** Validate the immutable launcher values once, before the service is published. */
function validateBootstrap(bootstrap: DesktopPnpmBootstrap): void {
  assertDesktopProfileName(bootstrap.activeProfileName)
  for (const [label, value] of [
    ['active profile directory', bootstrap.activeProfileDir],
    ['Harness home', bootstrap.homeDir],
    ['application executable', bootstrap.appExecutable],
    ['pnpm entry', bootstrap.pnpmBinPath],
    ['Node command directory', bootstrap.nodeBinDir],
    ['Node command', bootstrap.nodeShimPath],
    ['environment preloader', bootstrap.clearEnvironmentPath],
    ['DSH bootstrap', bootstrap.dshBootstrapPath],
  ] as const) assertAbsolutePath(label, value)
  if (bootstrap.electronVersion.length === 0 || bootstrap.electronVersion.includes('\0')) {
    throw new Error(`${BIN_NAME}: desktop pnpm Electron version must not be empty or contain NUL`)
  }
}

/**
 * Resolve a node-gyp entry pnpm lifecycle scripts can use.
 *
 * Packaged pnpm ships its own node-gyp at `dist/node_modules/node-gyp`, but
 * Electron Builder prunes nested `node_modules` inside the packaged pnpm
 * release, so that path does not exist in the shipped app (see
 * `node_modules/pnpm/dist`). Point pnpm at the node-gyp we declare as a
 * direct dependency instead; `npm_config_node_gyp` is the npm/pnpm knob
 * that overrides the lifecycle tool without touching the package tree.
 *
 * @returns the absolute node-gyp.js path, or undefined when unavailable
 * (lifecycle scripts then fail loudly with pnpm's own diagnostic).
 */
function resolveNodeGyp(): string | undefined {
  try {
    const requireFromPlugin = createRequire(import.meta.url)
    const packageJson = requireFromPlugin.resolve('node-gyp/package.json')
    return join(dirname(packageJson), 'bin', 'node-gyp.js')
  } catch {
    return undefined
  }
}

/** Host service providing one managed pnpm operation at a time. */
export class DesktopPnpm extends Service {
  private active: ActiveOperation | undefined
  private closed = false

  /**
   * Register the service for one immutable desktop profile generation.
   * @param ctx - Host context providing the managed subprocess capability.
   * @param bootstrap - launcher-resolved profile and packaged runtime paths.
   */
  constructor(ctx: Context, private readonly bootstrap: DesktopPnpmBootstrap) {
    validateBootstrap(bootstrap)
    super(ctx, 'desktopPnpm')
    ctx.effect(
      () => async () => {
        this.closed = true
        const active = this.active
        if (active === undefined) return
        active.child.terminate()
        await active.done.catch(() => {})
      },
      'dsh-plugin-desktop: active pnpm operation teardown',
    )
  }

  /**
   * Run packaged pnpm directly in the active profile.
   * @param args - pnpm arguments following the executable name.
   * @param signal - optional cancellation for this operation.
   * @returns live output streams, completion, and cancellation.
   */
  run(args: readonly string[], signal?: AbortSignal): DesktopPnpmHandle {
    const resolvedArgs = validatedArgs(args)
    return this.start({
      argv: [
        this.bootstrap.appExecutable,
        '--import',
        pathToFileURL(this.bootstrap.clearEnvironmentPath).href,
        this.bootstrap.pnpmBinPath,
        ...resolvedArgs,
      ],
      cwd: this.bootstrap.activeProfileDir,
      ...(signal === undefined ? {} : { signal }),
    })
  }

  /**
   * Run the packaged `dsh plugin` command so upstream profile reconciliation remains authoritative.
   * @param args - pnpm arguments forwarded by `dsh plugin`.
   * @param invokingDir - absolute caller directory used to anchor relative package specifications.
   * @param signal - optional cancellation for this operation.
   * @returns live output streams, completion, and cancellation.
   */
  runPlugin(
    args: readonly string[],
    invokingDir: string,
    signal?: AbortSignal,
  ): DesktopPnpmHandle {
    const resolvedArgs = validatedArgs(args)
    assertAbsolutePath('plugin invoking directory', invokingDir)
    return this.start({
      argv: [
        this.bootstrap.appExecutable,
        '--expose-internals',
        this.bootstrap.dshBootstrapPath,
        'plugin',
        '--profile',
        this.bootstrap.activeProfileName,
        ...resolvedArgs,
      ],
      cwd: invokingDir,
      ...(signal === undefined ? {} : { signal }),
    })
  }

  /** Start one managed child after applying the generation-wide gate. */
  private start(command: {
    argv: readonly string[]
    cwd: string
    signal?: AbortSignal
  }): DesktopPnpmHandle {
    if (this.closed) {
      throw new Error(`${BIN_NAME}: desktop pnpm generation is closed`)
    }
    if (this.active !== undefined) {
      throw new Error(`${BIN_NAME}: another desktop pnpm operation is already running`)
    }
    command.signal?.throwIfAborted()
    const path = inheritedPath()
    const nodeGyp = resolveNodeGyp()
    const spec: SubprocessSpawnSpec = {
      argv: command.argv,
      cwd: command.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
      graceMs: TERMINATION_GRACE_MS,
      ...(command.signal === undefined ? {} : { signal: command.signal }),
      env: {
        PATH: path.length === 0
          ? this.bootstrap.nodeBinDir
          : `${this.bootstrap.nodeBinDir}${delimiter}${path}`,
        NODE: this.bootstrap.nodeShimPath,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_HOME: this.bootstrap.homeDir,
        CI: 'true',
        npm_config_runtime: 'electron',
        npm_config_target: this.bootstrap.electronVersion,
        npm_config_disturl: ELECTRON_HEADERS_URL,
        ...(nodeGyp === undefined ? {} : { npm_config_node_gyp: nodeGyp }),
      },
    }
    const child = this.ctx.subprocess.spawn(spec)
    if (child.stdout === undefined || child.stderr === undefined) {
      child.terminate()
      throw new Error(`${BIN_NAME}: desktop pnpm subprocess did not expose piped output`)
    }
    const active: ActiveOperation = {
      child,
      done: Promise.resolve({ exitCode: null, signal: null }),
    }
    active.done = this.settle(active)
    this.active = active
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      done: active.done,
      cancel: () => { child.terminate() },
    }
  }

  /** Keep the operation gate held until the complete process tree is gone. */
  private async settle(active: ActiveOperation): Promise<DesktopPnpmOutcome> {
    try {
      const outcome: SubprocessOutcome = await active.child.done
      return { exitCode: outcome.exitCode, signal: outcome.signal }
    } finally {
      try {
        await active.child.waitForExit()
      } finally {
        if (this.active === active) this.active = undefined
      }
    }
  }
}

/** Stable Cordis provider name. */
export const name = 'desktop-pnpm'

/** Launcher bootstrap and subprocess service required by this Host provider. */
export const inject = ['desktopPnpmBootstrap', 'subprocess']

/**
 * Provide the active generation's desktop package-manager capability.
 * @param ctx - Host context carrying launcher bootstrap values and subprocess ownership.
 */
export function apply(ctx: Context): void {
  new DesktopPnpm(ctx, ctx.desktopPnpmBootstrap)
}

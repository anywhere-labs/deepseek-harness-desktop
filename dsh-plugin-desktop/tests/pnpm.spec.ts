import { PassThrough } from 'node:stream'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessRuntime,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  inject,
  name,
  type DesktopPnpm,
  type DesktopPnpmBootstrap,
} from '../src/pnpm.ts'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(cause: unknown): void
}

interface ControlledSubprocess extends SubprocessHandle {
  resolveDone(outcome: SubprocessOutcome): void
  rejectDone(cause: unknown): void
  resolveTree(exited?: boolean): void
  terminate: ReturnType<typeof vi.fn<() => void>>
  waitForExit: ReturnType<typeof vi.fn<(signal?: AbortSignal) => Promise<boolean>>>
}

interface PnpmHarness {
  ctx: Context
  service: DesktopPnpm
  spawn: ReturnType<typeof vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>>
  dispose(): Promise<void>
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function controlledSubprocess(): ControlledSubprocess {
  const outcome = deferred<SubprocessOutcome>()
  const tree = deferred<boolean>()
  return {
    pid: 43120,
    stdin: undefined,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    collected: {},
    done: outcome.promise,
    terminate: vi.fn(),
    waitForExit: vi.fn(() => tree.promise),
    resolveDone: value => { outcome.resolve(value) },
    rejectDone: cause => { outcome.reject(cause) },
    resolveTree: (exited = true) => { tree.resolve(exited) },
  }
}

function bootstrap(root = '/desktop runtime'): DesktopPnpmBootstrap {
  return {
    activeProfileName: '工作 profile',
    activeProfileDir: join(root, 'profiles', '工作 profile'),
    homeDir: join(root, 'harness home'),
    appExecutable: join(root, 'DSH Desktop'),
    pnpmBinPath: join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
    electronVersion: '43.4.0',
    nodeBinDir: join(root, 'private', 'node-bin'),
    nodeShimPath: join(root, 'private', 'node-bin', 'node'),
    clearEnvironmentPath: join(root, 'private', 'clear-env.mjs'),
    dshBootstrapPath: join(root, 'app.asar', 'lib', 'desktop-cli.js'),
    installRecoveryStatePath: join(root, 'plugin-install-recovery', 'state.json'),
    generationId: 'test-generation-0001',
    externalMarketInstallEnabled: false,
  }
}

async function createHarness(
  children: ControlledSubprocess[],
  selectedBootstrap: DesktopPnpmBootstrap = bootstrap(),
): Promise<PnpmHarness> {
  const ctx = new Context()
  const spawn = vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>(() => {
    const child = children.shift()
    if (child === undefined) throw new Error('test subprocess queue is empty')
    return child
  })
  ctx.provide('desktopPnpmBootstrap', selectedBootstrap)
  ctx.provide('subprocess', { spawn } as unknown as SubprocessRuntime)
  const fiber = ctx.plugin({ name, inject, apply })
  await fiber
  const service = ctx.get('desktopPnpm')
  if (service === undefined) throw new Error('desktop pnpm service did not mount')
  return {
    ctx,
    service,
    spawn,
    dispose: fiber.dispose,
  }
}

function finish(child: ControlledSubprocess, outcome: SubprocessOutcome = {
  exitCode: 0,
  signal: null,
}): void {
  child.resolveDone(outcome)
  child.resolveTree()
}

describe('desktop pnpm Host service', () => {
  it('runs physical packaged pnpm with the Electron-backed lifecycle environment', async () => {
    const child = controlledSubprocess()
    const harness = await createHarness([child])
    const signal = new AbortController().signal

    const operation = harness.service.run(['list', '--depth=0'], signal)

    expect(harness.spawn).toHaveBeenCalledOnce()
    const spec = harness.spawn.mock.calls[0]?.[0]
    expect(spec).toEqual({
      argv: [
        bootstrap().appExecutable,
        '--import',
        pathToFileURL(bootstrap().clearEnvironmentPath).href,
        bootstrap().pnpmBinPath,
        'list',
        '--depth=0',
      ],
      cwd: bootstrap().activeProfileDir,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 3_000,
      signal,
      env: {
        PATH: `${bootstrap().nodeBinDir}${delimiter}${process.env.PATH ?? ''}`,
        NODE: bootstrap().nodeShimPath,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_HOME: bootstrap().homeDir,
        CI: 'true',
        npm_config_runtime: 'electron',
        npm_config_target: '43.4.0',
        npm_config_disturl: 'https://electronjs.org/headers',
      },
    })
    expect(spec).not.toHaveProperty('shell')
    expect(operation.stdout).toBe(child.stdout)
    expect(operation.stderr).toBe(child.stderr)
    operation.cancel()
    expect(child.terminate).toHaveBeenCalledOnce()

    finish(child)
    await expect(operation.done).resolves.toEqual({ exitCode: 0, signal: null })
    expect(child.waitForExit).toHaveBeenCalledWith()
    await harness.dispose()
    expect(harness.ctx.get('desktopPnpm')).toBeUndefined()
  })

  it('runs the packaged DSH plugin command from the caller directory', async () => {
    const child = controlledSubprocess()
    const harness = await createHarness([child])
    const invokingDir = '/workspace/third-party-plugin'

    const operation = harness.service.runPlugin(['remove', 'dshmarket'], invokingDir)

    const spec = harness.spawn.mock.calls[0]?.[0]
    expect(spec?.argv).toEqual([
      bootstrap().appExecutable,
      '--expose-internals',
      bootstrap().dshBootstrapPath,
      'plugin',
      '--profile',
      '工作 profile',
      'remove',
      'dshmarket',
    ])
    expect(spec?.cwd).toBe(invokingDir)
    expect(spec).not.toHaveProperty('signal')
    expect(spec).not.toHaveProperty('shell')

    finish(child, { exitCode: 7, signal: null })
    await expect(operation.done).resolves.toEqual({ exitCode: 7, signal: null })
    await harness.dispose()
  })

  it('allows an unpatched dsh-market runtime to add through the external boundary', async () => {
    const child = controlledSubprocess()
    const harness = await createHarness([child], { ...bootstrap(), externalMarketInstallEnabled: true })
    const operation = harness.service.runPlugin(
      ['add', 'dshmarket@1.18.0', '--reporter=ndjson'],
      '/workspace/dsh-market',
    )

    expect(harness.spawn.mock.calls[0]?.[0].argv).toContain('dshmarket@1.18.0')
    finish(child)
    await operation.done
    await harness.dispose()
  })

  it('runs the selected dsh-market install without creating a per-install WAL', async () => {
    const child = controlledSubprocess()
    const selectedBootstrap = { ...bootstrap(), externalMarketInstallEnabled: true }
    const harness = await createHarness([child], selectedBootstrap)
    const operation = harness.service.runExternalMarketPluginInstall(
      ['add', '--reporter=ndjson', '@scope/example-plugin@1.2.3'],
      '/workspace/dsh-market',
    )

    expect(harness.spawn.mock.calls[0]?.[0].argv).toEqual([
      selectedBootstrap.appExecutable,
      '--expose-internals',
      selectedBootstrap.dshBootstrapPath,
      'plugin',
      '--profile',
      selectedBootstrap.activeProfileName,
      'add',
      '--reporter=ndjson',
      '@scope/example-plugin@1.2.3',
    ])
    expect(harness.spawn.mock.calls[0]?.[0].cwd).toBe('/workspace/dsh-market')
    expect(existsSync(selectedBootstrap.installRecoveryStatePath)).toBe(false)

    finish(child)
    await operation.done
    await harness.dispose()
  })

  it('rejects the external Market boundary unless dsh-market is selected', async () => {
    const harness = await createHarness([])
    expect(() => harness.service.runExternalMarketPluginInstall(
      ['add', 'example-plugin@1.0.0'],
      '/workspace',
    )).toThrow('unavailable for the selected Market provider')
    await harness.dispose()
  })

  it('accepts only add with one exact npm target and flag options for dsh-market', async () => {
    const harness = await createHarness([], { ...bootstrap(), externalMarketInstallEnabled: true })
    for (const args of [
      ['remove', 'example-plugin@1.0.0'],
      ['add', 'example-plugin'],
      ['add', 'example-plugin@latest'],
      ['add', 'example-plugin@1.0.0', 'other-plugin@1.0.0'],
      ['add', '--registry', 'https://registry.example', 'example-plugin@1.0.0'],
    ]) {
      expect(() => harness.service.runExternalMarketPluginInstall(args, '/workspace')).toThrow()
    }
    await harness.dispose()
  })

  it('reserves the operation gate, snapshots, and seals a recoverable plugin install', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-pnpm-recovery-'))
    const selectedBootstrap = bootstrap(root)
    const manifestPath = join(selectedBootstrap.activeProfileDir, 'package.json')
    const child = controlledSubprocess()
    try {
      mkdirSync(selectedBootstrap.activeProfileDir, { recursive: true })
      writeFileSync(manifestPath, JSON.stringify({ dependencies: {} }))
      const harness = await createHarness([child], selectedBootstrap)

      const pending = harness.service.installPlugin({
        pnpmOptions: ['--save-exact'],
        invokingDir: '/workspace',
        recovery: {
          packageName: 'example-plugin',
          packageVersion: '1.0.0',
          receiptId: 'receipt:test-install-0001',
        },
      })
      expect(() => harness.service.runPlugin(['remove', 'other-plugin'], '/workspace')).toThrow(
        'another desktop pnpm operation is already running',
      )
      const operation = await pending
      writeFileSync(manifestPath, JSON.stringify({ dependencies: { 'example-plugin': '1.0.0' } }))
      finish(child)
      await expect(operation.done).resolves.toEqual({ exitCode: 0, signal: null })

      expect(harness.spawn.mock.calls[0]?.[0].argv).toEqual([
        selectedBootstrap.appExecutable,
        '--expose-internals',
        selectedBootstrap.dshBootstrapPath,
        'plugin',
        '--profile',
        selectedBootstrap.activeProfileName,
        'add',
        '--save-exact',
        'example-plugin@1.0.0',
      ])
      expect(JSON.parse(readFileSync(selectedBootstrap.installRecoveryStatePath, 'utf8'))).toMatchObject({
        packageName: 'example-plugin',
        packageVersion: '1.0.0',
        receiptId: 'receipt:test-install-0001',
        phase: 'awaiting-restart',
      })
      await harness.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores partial profile writes when a recoverable plugin install exits nonzero', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-pnpm-recovery-failure-'))
    const selectedBootstrap = bootstrap(root)
    const manifestPath = join(selectedBootstrap.activeProfileDir, 'package.json')
    const child = controlledSubprocess()
    const originalManifest = JSON.stringify({ dependencies: {} })
    try {
      mkdirSync(selectedBootstrap.activeProfileDir, { recursive: true })
      writeFileSync(manifestPath, originalManifest)
      const harness = await createHarness([child], selectedBootstrap)
      const operation = await harness.service.installPlugin({
        invokingDir: '/workspace',
        recovery: {
          packageName: 'broken-plugin',
          packageVersion: '1.0.0',
          receiptId: 'receipt:test-install-failure-0001',
        },
      })
      writeFileSync(manifestPath, JSON.stringify({ dependencies: { 'broken-plugin': '1.0.0' } }))
      finish(child, { exitCode: 1, signal: null })

      await expect(operation.done).resolves.toEqual({ exitCode: 1, signal: null })
      expect(readFileSync(manifestPath, 'utf8')).toBe(originalManifest)
      expect(existsSync(selectedBootstrap.installRecoveryStatePath)).toBe(false)
      await harness.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the v2.0.1 recoverable install interface for an exact receipt target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-pnpm-legacy-install-'))
    const selectedBootstrap = bootstrap(root)
    const child = controlledSubprocess()
    try {
      mkdirSync(selectedBootstrap.activeProfileDir, { recursive: true })
      writeFileSync(join(selectedBootstrap.activeProfileDir, 'package.json'), '{}\n')
      const harness = await createHarness([child], selectedBootstrap)

      const operation = await harness.service.runPluginInstall(
        ['add', '--save-exact', 'legacy-plugin@1.2.3'],
        '/workspace',
        {
          packageName: 'legacy-plugin',
          packageVersion: '1.2.3',
          receiptId: 'receipt:legacy-install-0001',
        },
      )

      expect(harness.spawn.mock.calls[0]?.[0].argv).toEqual([
        selectedBootstrap.appExecutable,
        '--expose-internals',
        selectedBootstrap.dshBootstrapPath,
        'plugin',
        '--profile',
        selectedBootstrap.activeProfileName,
        'add',
        '--save-exact',
        'legacy-plugin@1.2.3',
      ])
      finish(child)
      await operation.done
      await harness.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects legacy recoverable installs that do not match the receipt target', async () => {
    const harness = await createHarness([])
    const recovery = {
      packageName: 'legacy-plugin',
      packageVersion: '1.2.3',
      receiptId: 'receipt:legacy-install-invalid-0001',
    }

    await expect(harness.service.runPluginInstall(
      ['add', 'other-plugin@1.2.3'],
      '/workspace',
      recovery,
    )).rejects.toThrow('requires the exact receipt target')
    await expect(harness.service.runPluginInstall(
      ['add', 'extra-plugin@1.0.0', 'legacy-plugin@1.2.3'],
      '/workspace',
      recovery,
    )).rejects.toThrow('requires the exact receipt target')
    expect(harness.spawn).not.toHaveBeenCalled()
    await harness.dispose()
  })

  it('validates operation arguments and the plugin invocation directory before spawning', async () => {
    const harness = await createHarness([])

    expect(() => harness.service.run([])).toThrow('arguments must not be empty')
    expect(() => harness.service.run(['add', 'bad\0target'])).toThrow('must not contain NUL')
    expect(() => harness.service.runPlugin(['remove', 'plugin'], 'relative/path')).toThrow(
      'plugin invoking directory must be an absolute path',
    )
    expect(() => harness.service.runPlugin(['remove'], '/workspace/bad\0path')).toThrow(
      'plugin invoking directory must be an absolute path without NUL',
    )
    expect(() => harness.service.runPlugin(['add', 'plugin'], '/workspace')).toThrow(
      'plugin add must use the recoverable install boundary',
    )
    await expect(harness.service.installPlugin({
      pnpmOptions: ['--registry=https://registry.example\0.invalid'],
      invokingDir: '/workspace',
      recovery: {
        packageName: 'plugin',
        packageVersion: '1.0.0',
        receiptId: 'receipt:test-empty-install',
      },
    })).rejects.toThrow('arguments must not contain NUL')
    expect(harness.spawn).not.toHaveBeenCalled()
    await harness.dispose()
  })

  it('holds the generation gate until the first operation process tree exits', async () => {
    const first = controlledSubprocess()
    const second = controlledSubprocess()
    const harness = await createHarness([first, second])
    const firstOperation = harness.service.run(['install'])

    first.resolveDone({ exitCode: 0, signal: null })
    await Promise.resolve()
    expect(first.waitForExit).toHaveBeenCalledOnce()
    expect(() => harness.service.runPlugin(['remove', 'dshmarket'], '/workspace')).toThrow(
      'another desktop pnpm operation is already running',
    )

    first.resolveTree()
    await firstOperation.done
    const secondOperation = harness.service.runPlugin(['remove', 'dshmarket'], '/workspace')
    expect(harness.spawn).toHaveBeenCalledTimes(2)
    finish(second)
    await secondOperation.done
    await harness.dispose()
  })

  it('releases the operation gate after a spawn-level failure and whole-tree wait', async () => {
    const failed = controlledSubprocess()
    const next = controlledSubprocess()
    const harness = await createHarness([failed, next])
    const failedOperation = harness.service.run(['install'])

    failed.rejectDone(new Error('spawn failed'))
    failed.resolveTree()
    await expect(failedOperation.done).rejects.toThrow('spawn failed')

    const nextOperation = harness.service.run(['list'])
    finish(next)
    await nextOperation.done
    await harness.dispose()
  })

  it('terminates and joins the active tree before the provider row disposes', async () => {
    const child = controlledSubprocess()
    const harness = await createHarness([child])
    const operation = harness.service.run(['update'])

    const disposing = harness.dispose()
    await Promise.resolve()
    expect(child.terminate).toHaveBeenCalledOnce()

    finish(child, { exitCode: null, signal: 'SIGTERM' })
    await expect(operation.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
    await disposing
    expect(child.waitForExit).toHaveBeenCalledOnce()
    expect(() => harness.service.run(['list'])).toThrow('generation is closed')
  })
})

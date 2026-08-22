import { describe, expect, it, vi } from 'vitest'
import {
  prepareWslHostRuntime,
  WslHostHandle,
  type WslHostExit,
} from '../src/wsl-supervisor.ts'
import type { DesktopCommandCapture, DesktopCommandResult } from '../src/wsl.ts'
import type { WslRuntimeBundle } from '../src/wsl-runtime-bundle.ts'

function result(stdout = '', exitCode = 0, stderr = ''): DesktopCommandResult {
  return {
    exitCode,
    signal: null,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  }
}

function bundle(): WslRuntimeBundle {
  return {
    root: 'C:\\Program Files\\DSH Desktop\\resources\\wsl-runtime',
    manifest: {
      schemaVersion: 1,
      productVersion: '2.0.2',
      packageCount: 202,
      files: [],
    },
    manifestSha256: 'a'.repeat(64),
    packageJsonPath: 'C:\\Program Files\\DSH Desktop\\resources\\wsl-runtime\\package.json',
    lockfilePath: 'C:\\Program Files\\DSH Desktop\\resources\\wsl-runtime\\package-lock.json',
  }
}

describe('managed WSL Host runtime', () => {
  it('uses an already verified exact-version runtime without npm mutation', async () => {
    const capture = vi.fn<DesktopCommandCapture>(async (_executable, args) => {
      if (args.includes('uname')) return result('Linux\n')
      if (args.includes('--version') && args.includes('node')) return result('v22.19.0\n')
      if (args.includes('--version') && args.includes('npm')) return result('11.6.0\n')
      if (args.includes('--version') && args.includes('bash')) return result('GNU bash, version 5.2.21\n')
      if (args.includes('sh')) return result('/home/alice')
      return result()
    })
    const runtime = await prepareWslHostRuntime({
      distribution: 'Ubuntu-24.04', productVersion: '2.0.2',
      runtimeBundlePath: bundle().root, verifyBundle: () => bundle(), capture,
    })

    expect(runtime.installed).toBe(false)
    expect(runtime.hostEntryPath).toBe(
      '/home/alice/.local/share/dsh-desktop/runtime/2.0.2/node_modules/dsh-plugin-desktop/lib/wsl-host.js',
    )
    expect(capture.mock.calls.some(call => call[1].includes('install'))).toBe(false)
  })

  it('copies an exact bundle, installs its lockfile without a shell, and atomically commits it', async () => {
    let verifyCount = 0
    const capture = vi.fn<DesktopCommandCapture>(async (_executable, args, _options) => {
      if (args.includes('uname')) return result('Linux\n')
      if (args.includes('--version') && args.includes('node')) return result('v24.1.0\n')
      if (args.includes('--version') && args.includes('npm')) return result('11.6.0\n')
      if (args.includes('--version') && args.includes('bash')) return result('GNU bash, version 5.2.21\n')
      if (args.includes('sh')) return result('/home/alice')
      if (args.includes('wslpath')) return result('/mnt/c/Program Files/DSH Desktop/resources/wsl-runtime\n')
      if (args.includes('ci')) return result('added packages')
      const script = args[args.indexOf('-e') + 1]
      if (script?.includes('fs.cpSync') === true
        || script?.includes('fs.renameSync') === true
        || script?.includes('rmSync') === true) return result()
      verifyCount += 1
      return result('', verifyCount === 1 ? 2 : 0)
    })
    const runtime = await prepareWslHostRuntime({
      distribution: 'Ubuntu',
      productVersion: '2.0.2',
      runtimeBundlePath: bundle().root,
      verifyBundle: () => bundle(),
      capture,
    })

    expect(runtime.installed).toBe(true)
    const install = capture.mock.calls.find(call => call[1].includes('ci'))
    expect(install?.[0]).toBe('wsl.exe')
    expect(install?.[1]).not.toContain('sh')
    expect(install?.[1]).toContain('--omit=dev')
    expect(install?.[1]).toContain('--legacy-peer-deps')
    expect(install?.[1]).not.toContain('--omit=peer')
    expect(install?.[2]).toMatchObject({ timeoutMs: 600_000 })
    const copy = capture.mock.calls.find(call => call[1].some(value => value.includes('fs.cpSync')))
    expect(copy?.[1]).toContain('/mnt/c/Program Files/DSH Desktop/resources/wsl-runtime')
    expect(capture.mock.calls.some(call => call[1].includes('wslpath'))).toBe(true)
    expect(verifyCount).toBe(3)
  })

  it('fails closed when npm exits unsuccessfully', async () => {
    const capture = vi.fn<DesktopCommandCapture>(async (_executable, args) => {
      if (args.includes('uname')) return result('Linux\n')
      if (args.includes('--version') && args.includes('node')) return result('v22.19.0\n')
      if (args.includes('--version') && args.includes('npm')) return result('11.6.0\n')
      if (args.includes('--version') && args.includes('bash')) return result('GNU bash, version 5.2.21\n')
      if (args.includes('sh')) return result('/home/alice')
      if (args.includes('wslpath')) return result('/mnt/c/runtime\n')
      if (args.includes('ci')) return result('', 1, 'npm failed safely')
      const script = args[args.indexOf('-e') + 1]
      if (script?.includes('fs.cpSync') === true || script?.includes('rmSync') === true) return result()
      return result('', 2)
    })
    await expect(prepareWslHostRuntime({
      distribution: 'Ubuntu', productVersion: '2.0.2',
      runtimeBundlePath: bundle().root, verifyBundle: () => bundle(), capture,
    })).rejects.toThrow('npm failed safely')
    const cleanup = capture.mock.calls.find(call => call[1].some(value => (
      value.includes('rmSync(process.argv[1]')
    )))
    expect(cleanup?.[1].at(-1)).toContain('.installing-')
  })

  it('removes a staged tree that fails exact runtime verification', async () => {
    let verifyCount = 0
    const capture = vi.fn<DesktopCommandCapture>(async (_executable, args) => {
      if (args.includes('uname')) return result('Linux\n')
      if (args.includes('--version') && args.includes('node')) return result('v24.1.0\n')
      if (args.includes('--version') && args.includes('npm')) return result('11.6.0\n')
      if (args.includes('--version') && args.includes('bash')) return result('GNU bash, version 5.2.21\n')
      if (args.includes('sh')) return result('/home/alice')
      if (args.includes('wslpath')) return result('/mnt/c/runtime\n')
      if (args.includes('ci')) return result()
      const script = args[args.indexOf('-e') + 1]
      if (script?.includes('fs.cpSync') === true || script?.includes('rmSync') === true) return result()
      verifyCount += 1
      return result('', 2)
    })
    await expect(prepareWslHostRuntime({
      distribution: 'Ubuntu', productVersion: '2.0.2',
      runtimeBundlePath: bundle().root, verifyBundle: () => bundle(), capture,
    })).rejects.toThrow('failed version verification')
    expect(verifyCount).toBe(2)
    expect(capture.mock.calls.some(call => call[1].some(value => (
      value.includes('rmSync(process.argv[1]')
    )))).toBe(true)
  })

  it('restores the previous runtime when the atomic commit fails', async () => {
    let verifyCount = 0
    const capture = vi.fn<DesktopCommandCapture>(async (_executable, args) => {
      if (args.includes('uname')) return result('Linux\n')
      if (args.includes('--version') && args.includes('node')) return result('v24.1.0\n')
      if (args.includes('--version') && args.includes('npm')) return result('11.6.0\n')
      if (args.includes('--version') && args.includes('bash')) return result('GNU bash, version 5.2.21\n')
      if (args.includes('sh')) return result('/home/alice')
      if (args.includes('wslpath')) return result('/mnt/c/runtime\n')
      if (args.includes('ci')) return result()
      const script = args[args.indexOf('-e') + 1]
      if (script?.includes('fs.cpSync') === true || script?.includes('rmSync(process.argv[1]') === true) {
        return result()
      }
      if (script?.includes('const hadTarget') === true) return result('', 1)
      if (script?.includes('else if (!fs.existsSync(staging))') === true) return result()
      verifyCount += 1
      return result('', verifyCount === 1 ? 2 : 0)
    })
    await expect(prepareWslHostRuntime({
      distribution: 'Ubuntu', productVersion: '2.0.2',
      runtimeBundlePath: bundle().root, verifyBundle: () => bundle(), capture,
    })).rejects.toThrow('failed to commit')
    const recovery = capture.mock.calls.find(call => call[1].some(value => (
      value.includes('else if (!fs.existsSync(staging))')
    )))
    expect(recovery?.[1].at(-3)).toContain('/runtime/2.0.2')
  })

  it('arms abnormal-exit shutdown only after the remote health commit succeeds', async () => {
    let resolveExit!: (value: WslHostExit) => void
    const exited = new Promise<WslHostExit>(resolve => { resolveExit = resolve })
    const peer = {
      call: vi.fn(async () => null),
      close: vi.fn(),
    }
    const bridge = { dispose: vi.fn(async () => {}) }
    const child = {
      killed: false,
      kill: vi.fn(),
      stdin: { end: vi.fn() },
    }
    const requestQuit = vi.fn()
    const releaseControlHandlers = vi.fn()
    const handle = new WslHostHandle(
      {
        prerequisites: {
          distribution: 'Ubuntu-24.04',
          homeDir: '/home/alice',
          nodeVersion: 'v22.19.0',
          npmVersion: '11.6.0',
          bashVersion: 'GNU bash, version 5.2.21',
        },
        runtimeRoot: '/home/alice/.local/share/dsh-desktop/runtime/2.0.2',
        packageRoot: '/home/alice/.local/share/dsh-desktop/runtime/2.0.2/node_modules/dsh-plugin-desktop',
        hostEntryPath: '/home/alice/.local/share/dsh-desktop/runtime/2.0.2/node_modules/dsh-plugin-desktop/lib/wsl-host.js',
        stateDir: '/home/alice/.local/state/dsh-desktop',
        homeDir: '/home/alice/.local/share/dsh-desktop/home',
        installed: false,
      },
      {
        generationId: 'generation-1',
        profileName: 'desktop',
        profileDir: '/home/alice/.local/share/dsh-desktop/home/profiles/desktop',
        homeDir: '/home/alice/.local/share/dsh-desktop/home',
        port: 43120,
        selectedProfile: 'desktop',
      },
      peer as never,
      bridge as never,
      child as never,
      exited,
      1_000,
      requestQuit,
      releaseControlHandlers,
    )

    await handle.commitHealthy()
    expect(peer.call).toHaveBeenCalledWith('host/health.commit', { generationId: 'generation-1' })
    resolveExit({ exitCode: 0, signal: null })
    await exited
    await Promise.resolve()

    expect(requestQuit).toHaveBeenCalledWith(1)
  })
})

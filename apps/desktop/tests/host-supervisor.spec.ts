import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createHostSupervisor,
  createReadinessParser,
  type HostChild,
} from '../src/host-supervisor.ts'

vi.mock('node:child_process', { spy: true })

type HostExitListener = Parameters<HostChild['onExit']>[0]
type HostExitSignal = Parameters<HostExitListener>[1]

class FakeOutput {
  private readonly listeners = new Set<(chunk: string) => void>()

  onData(listener: (chunk: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(chunk: string): void {
    for (const listener of this.listeners) listener(chunk)
  }
}

class FakeHostChild implements HostChild {
  readonly pid = 123
  readonly stdout = new FakeOutput()
  readonly stderr = new FakeOutput()
  readonly signals: Array<'SIGTERM' | 'SIGKILL'> = []
  private readonly exitListeners = new Set<HostExitListener>()
  private readonly errorListeners = new Set<(error: Error) => void>()

  onExit(listener: HostExitListener): () => void {
    this.exitListeners.add(listener)
    return () => { this.exitListeners.delete(listener) }
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener)
    return () => { this.errorListeners.delete(listener) }
  }

  kill(signal: 'SIGTERM' | 'SIGKILL'): void {
    this.signals.push(signal)
  }

  emitExit(code: number | null = 0, signal: HostExitSignal = null): void {
    for (const listener of this.exitListeners) listener(code, signal)
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error)
  }
}

function observeSettlement<T>(promise: Promise<T>): ReturnType<typeof vi.fn> {
  const settled = vi.fn()
  void promise.then(settled, settled)
  return settled
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('desktop Host readiness', () => {
  it('extracts the canonical URL from arbitrarily chunked output and ignores unrelated URLs', () => {
    const parser = createReadinessParser()

    expect(parser.push('Node warning: see https://nodejs.org/docs\n')).toBeUndefined()
    expect(parser.push('dsh we')).toBeUndefined()
    expect(parser.push('b: http://127.0.')).toBeUndefined()
    expect(parser.push('0.1:4173 (LAN: http://192.0.2.10:4173)')).toBeUndefined()
    expect(parser.push('\nstartup complete\n')).toBe('http://127.0.0.1:4173')
    expect(parser.finalize()).toBe('http://127.0.0.1:4173')
  })

  it('accepts a complete unterminated readiness line when the stream ends', () => {
    const parser = createReadinessParser()

    expect(parser.push('diagnostic\ndsh web: http://localhost:51234')).toBeUndefined()
    expect(parser.finalize()).toBe('http://localhost:51234')
  })

  it.each([
    'dsh web: https://127.0.0.1:4173',
    'dsh web: http://0.0.0.0:4173',
    'dsh web: http://127.0.0.1:0',
    'dsh web: http://127.0.0.1:65536',
    'dsh web: http://127.0.0.1:not-a-port',
  ])('rejects an invalid readiness line: %s', (line) => {
    const parser = createReadinessParser()

    expect(() => parser.push(`${line}\n`)).toThrow(/readiness/iu)
  })

  it('fails when the stream ends before a readiness line arrives', () => {
    const parser = createReadinessParser()

    parser.push('ordinary startup output\n')
    expect(() => parser.finalize()).toThrow(/readiness/iu)
  })

  it('rejects conflicting readiness URLs', () => {
    const parser = createReadinessParser()

    expect(parser.push('dsh web: http://127.0.0.1:4173\n')).toBe('http://127.0.0.1:4173')
    expect(() => parser.push('dsh web: http://127.0.0.1:4174\n')).toThrow(/conflicting readiness URLs/iu)
  })
})

describe('desktop Host supervisor', () => {
  it('starts one child for concurrent callers and returns its stdout readiness URL', async () => {
    const child = new FakeHostChild()
    const spawnHost = vi.fn(() => child)
    const supervisor = createHostSupervisor({ spawnHost })

    const first = supervisor.start()
    const second = supervisor.start()
    expect(second).toBe(first)
    expect(spawnHost).toHaveBeenCalledOnce()

    child.stdout.emit('dsh web: http://127.0.0.1:4567\n')
    await expect(first).resolves.toBe('http://127.0.0.1:4567')
    expect(child.signals).toEqual([])
  })

  it('keeps forwarding Host output after readiness without parsing another readiness URL', async () => {
    const child = new FakeHostChild()
    const log = vi.fn<(chunk: string) => void>()
    const supervisor = createHostSupervisor({ spawnHost: () => child, log })
    const starting = supervisor.start()

    child.stdout.emit('dsh web: http://127.0.0.1:4567\n')
    await expect(starting).resolves.toBe('http://127.0.0.1:4567')
    child.stdout.emit('runtime warning\n')
    child.stderr.emit('runtime failure\n')
    child.stdout.emit('dsh web: http://127.0.0.1:9999\n')

    expect(log.mock.calls.map(([chunk]) => chunk)).toEqual([
      'dsh web: http://127.0.0.1:4567\n',
      'runtime warning\n',
      'runtime failure\n',
      'dsh web: http://127.0.0.1:9999\n',
    ])
    expect(child.signals).toEqual([])
  })

  it('contains observer callback failures without disrupting readiness or exit handling', async () => {
    const child = new FakeHostChild()
    const onCallbackError = vi.fn()
    const supervisor = createHostSupervisor({
      spawnHost: () => child,
      log: () => { throw new Error('log callback failed') },
      onUnexpectedExit: () => { throw new Error('exit callback failed') },
      onCallbackError,
    })
    const starting = supervisor.start()

    child.stdout.emit('dsh web: http://127.0.0.1:4567\n')
    await expect(starting).resolves.toBe('http://127.0.0.1:4567')
    child.emitExit(9)

    expect(onCallbackError).toHaveBeenCalledTimes(2)
    expect(onCallbackError.mock.calls.map(([error]) => (error as Error).message)).toEqual([
      'log callback failed',
      'exit callback failed',
    ])
  })

  it('does not combine stderr and stdout fragments into a readiness line', async () => {
    const child = new FakeHostChild()
    const supervisor = createHostSupervisor({ spawnHost: () => child })
    const starting = supervisor.start()
    const settled = observeSettlement(starting)

    child.stderr.emit('dsh we')
    child.stdout.emit('b: http://127.0.0.1:4567\n')
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    child.stdout.emit('dsh web: http://127.0.0.1:4567\n')
    await expect(starting).resolves.toBe('http://127.0.0.1:4567')
  })

  it('reports output when the Host exits before readiness', async () => {
    const child = new FakeHostChild()
    const supervisor = createHostSupervisor({ spawnHost: () => child })
    const starting = supervisor.start()

    child.stderr.emit('configuration rejected\n')
    child.emitExit(7)

    await expect(starting).rejects.toThrow(/exited before readiness \(code 7, signal null\).*configuration rejected/su)
  })

  it('contains a synchronous spawn failure as a rejected start', async () => {
    const failure = new Error('spawn unavailable')
    const supervisor = createHostSupervisor({
      spawnHost: () => { throw failure },
    })

    await expect(supervisor.start()).rejects.toBe(failure)
  })

  it('forbids starting after shutdown', async () => {
    const spawnHost = vi.fn(() => new FakeHostChild())
    const supervisor = createHostSupervisor({ spawnHost })

    await expect(supervisor.shutdown()).resolves.toBeUndefined()
    await expect(supervisor.start()).rejects.toThrow('desktop Host cannot start after shutdown')
    expect(spawnHost).not.toHaveBeenCalled()
  })

  it('rejects startup when the child exits after an unterminated readiness fragment', async () => {
    const child = new FakeHostChild()
    const supervisor = createHostSupervisor({ spawnHost: () => child })
    const starting = supervisor.start()

    child.stdout.emit('dsh web: http://127.0.0.1:4567')
    child.emitExit(0)

    await expect(starting).rejects.toThrow(/exited before readiness/iu)
  })

  it('times out startup once and terminates the unready child', async () => {
    vi.useFakeTimers()
    const child = new FakeHostChild()
    const supervisor = createHostSupervisor({
      spawnHost: () => child,
      readinessTimeoutMs: 25,
    })
    const starting = supervisor.start()
    const rejected = expect(starting).rejects.toThrow('desktop Host readiness timed out after 25ms')

    await vi.advanceTimersByTimeAsync(24)
    expect(child.signals).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(child.signals).toEqual(['SIGTERM'])

    await vi.advanceTimersByTimeAsync(100)
    expect(child.signals).toEqual(['SIGTERM'])
  })

  it('reports a ready Host exit only when shutdown does not own it', async () => {
    const child = new FakeHostChild()
    const onUnexpectedExit = vi.fn()
    const supervisor = createHostSupervisor({
      spawnHost: () => child,
      onUnexpectedExit,
    })
    const starting = supervisor.start()
    await Promise.resolve()
    child.stdout.emit('dsh web: http://127.0.0.1:4567\n')
    await starting

    child.emitExit(9, null)

    expect(onUnexpectedExit).toHaveBeenCalledOnce()
    expect(onUnexpectedExit).toHaveBeenCalledWith({ code: 9, signal: null })
  })

  it('coalesces shutdown and waits for the ready child to exit after SIGTERM', async () => {
    vi.useFakeTimers()
    const child = new FakeHostChild()
    const onUnexpectedExit = vi.fn()
    const supervisor = createHostSupervisor({
      spawnHost: () => child,
      shutdownTimeoutMs: 25,
      onUnexpectedExit,
    })
    const starting = supervisor.start()
    child.stdout.emit('dsh web: http://127.0.0.1:4567\n')
    await starting

    const first = supervisor.shutdown()
    const second = supervisor.shutdown()
    const settled = observeSettlement(first)
    expect(second).toBe(first)
    expect(child.signals).toEqual(['SIGTERM'])
    expect(onUnexpectedExit).not.toHaveBeenCalled()

    child.emitExit(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toHaveBeenCalledOnce()
    await expect(first).resolves.toBeUndefined()

    await vi.advanceTimersByTimeAsync(25)
    expect(child.signals).toEqual(['SIGTERM'])
  })

  it('escalates a stuck shutdown once and still waits for child exit', async () => {
    vi.useFakeTimers()
    const child = new FakeHostChild()
    const supervisor = createHostSupervisor({
      spawnHost: () => child,
      shutdownTimeoutMs: 25,
    })
    const starting = supervisor.start()
    child.stdout.emit('dsh web: http://127.0.0.1:4567\n')
    await starting

    const closing = supervisor.shutdown()
    const settled = observeSettlement(closing)
    expect(child.signals).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(24)
    expect(child.signals).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(1)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(100)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    child.emitExit(null, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toHaveBeenCalledOnce()
    await expect(closing).resolves.toBeUndefined()
  })
})

describe('desktop Host process', () => {
  it('opts the packaged Electron executable into its Node runtime', async () => {
    const spawned = {
      stdout: { on: vi.fn(), off: vi.fn() },
      stderr: { on: vi.fn(), off: vi.fn() },
      on: vi.fn(),
      off: vi.fn(),
      kill: vi.fn(),
    }
    vi.mocked(spawn).mockReturnValue(spawned as never)

    const { spawnDshWeb } = await import('../src/host-supervisor.ts')
    spawnDshWeb({
      nodeExecutable: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
      cliEntry: '/Applications/DeepSeek Harness.app/Contents/Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js',
      cwd: '/Users/tester',
      env: { DSH_DESKTOP: '1' },
      electronRunAsNode: true,
    })

    expect(spawn).toHaveBeenCalledWith(
      '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
      ['--expose-internals', expect.stringContaining('/Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web', '--host', '127.0.0.1', '--port', '0'],
      expect.objectContaining({ env: { DSH_DESKTOP: '1', ELECTRON_RUN_AS_NODE: '1' } }),
    )
  })

  it('places the safe-mode launcher flag before web app arguments', async () => {
    const spawned = {
      stdout: { on: vi.fn(), off: vi.fn() },
      stderr: { on: vi.fn(), off: vi.fn() },
      on: vi.fn(),
      off: vi.fn(),
      kill: vi.fn(),
    }
    vi.mocked(spawn).mockReturnValue(spawned as never)

    const { spawnDshWeb } = await import('../src/host-supervisor.ts')
    spawnDshWeb({
      nodeExecutable: 'node',
      cliEntry: '/runtime/dsh.js',
      cwd: '/Users/tester',
      env: {},
      safeMode: true,
    })

    expect(spawn).toHaveBeenCalledWith(
      'node',
      ['--expose-internals', '/runtime/dsh.js', 'web', '--safe-mode', '--host', '127.0.0.1', '--port', '0'],
      expect.objectContaining({ windowsHide: true }),
    )
  })
})

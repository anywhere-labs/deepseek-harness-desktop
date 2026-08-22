import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { runTierOneAnalysis } from '../src/ai-diagnostic-analyzer.ts'

interface FakeChild {
  readonly child: EventEmitter & {
    kill: ReturnType<typeof vi.fn>
    stdout: EventEmitter
    stdin: EventEmitter & { end: ReturnType<typeof vi.fn> }
    stderr: EventEmitter
  }
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild['child']
  child.kill = vi.fn(() => true)
  child.stdout = new EventEmitter()
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
  child.stderr = new EventEmitter()
  return { child }
}

const mockState = vi.hoisted(() => ({
  spawn: (() => { throw new Error('no dsh') }) as (...args: unknown[]) => unknown,
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: (...args: unknown[]) => mockState.spawn(...args) }
})

afterEach(() => {
  vi.useRealTimers()
})

it('degrades to undefined when the CLI is unavailable', async () => {
  mockState.spawn = () => { throw new Error('no dsh') }
  await expect(runTierOneAnalysis('Error: Cannot find module \'x\'')).resolves.toBeUndefined()
})

it('kills the tier-1 child and degrades after the analysis timeout', async () => {
  const fake = fakeChild()
  mockState.spawn = () => fake.child
  vi.useFakeTimers()

  const pending = runTierOneAnalysis('input')
  await vi.advanceTimersByTimeAsync(15_000)

  await expect(pending).resolves.toBeUndefined()
  expect(fake.child.kill).toHaveBeenCalledWith('SIGKILL')
})

it('kills the tier-1 child and degrades when the caller aborts', async () => {
  const fake = fakeChild()
  mockState.spawn = () => fake.child
  const controller = new AbortController()

  const pending = runTierOneAnalysis('input', controller.signal)
  controller.abort()

  await expect(pending).resolves.toBeUndefined()
  expect(fake.child.kill).toHaveBeenCalledWith('SIGKILL')
})

it('swallows a stdin EPIPE and degrades when the child exits non-zero', async () => {
  const fake = fakeChild()
  mockState.spawn = () => fake.child

  const pending = runTierOneAnalysis('input')
  fake.child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
  fake.child.emit('exit', 1)

  await expect(pending).resolves.toBeUndefined()
})

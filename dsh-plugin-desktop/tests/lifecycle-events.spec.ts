import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopLogger } from '../src/desktop-logger.ts'
import type { DesktopStartupFailureStage } from '../src/startup-recovery-window.ts'
import {
  createDesktopLifecycleRecorder,
  DESKTOP_LIFECYCLE_SCHEMA_VERSION,
  desktopLifecycleEvidencePath,
  MAX_DESKTOP_LIFECYCLE_EVENT_BYTES,
  MAX_DESKTOP_LIFECYCLE_EVIDENCE_BYTES,
  parseDesktopLifecycleEvent,
  summarizeDesktopLifecycleEvidence,
  type DesktopLifecycleEvent,
  type DesktopLifecycleSummary,
} from '../src/lifecycle-events.ts'

interface CapturedLogger extends DesktopLogger {
  readonly error: ReturnType<typeof vi.fn<(message: string) => void>>
  readonly errorCause: ReturnType<typeof vi.fn<(cause: unknown) => void>>
}

const FIXED_NOW = new Date('2026-08-19T00:00:00.000Z')
const VALID_STAGE: DesktopStartupFailureStage = 'electron-ready'

function createLogger(): CapturedLogger {
  return {
    error: vi.fn<(message: string) => void>(),
    errorCause: vi.fn<(cause: unknown) => void>(),
  }
}

function tempUserData(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function readEvents(userDataDir: string): DesktopLifecycleEvent[] {
  const content = readFileSync(desktopLifecycleEvidencePath(userDataDir), 'utf8')
  return content
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => parseDesktopLifecycleEvent(JSON.parse(line) as unknown))
}

function baseEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: DESKTOP_LIFECYCLE_SCHEMA_VERSION,
    timestamp: FIXED_NOW.toISOString(),
    monotonicMs: 1,
    runId: 'run-1',
    operationId: 'op-1',
    eventName: 'startup.stage.started',
    stageId: VALID_STAGE,
    details: {},
    ...overrides,
  }
}

function eventLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(baseEvent(overrides))
}

describe('desktop lifecycle events', () => {
  it.each([
    ['schema version', { schemaVersion: 2 }],
    ['event name', { eventName: 'startup.stage.skipped' }],
    ['stage id', { stageId: 'network-init' }],
    ['detail key', { details: { unexpected: 'value' } }],
    ['duration', { durationMs: -1 }],
    ['run id', { runId: '../run' }],
    ['operation id', { operationId: 'operation id' }],
  ])('rejects an invalid %s', (_label, overrides) => {
    expect(() => { parseDesktopLifecycleEvent(baseEvent(overrides)) }).toThrow()
  })

  it('uses injected clocks and ids for one correlated startup run', () => {
    const userDataDir = tempUserData('dsh-lifecycle-correlated-')
    const logger = createLogger()
    const ids = ['run-fixed', 'operation-fixed']
    const ticks = [100, 101, 110, 111, 120, 121, 130, 131, 200, 201, 250, 251, 300, 301, 400, 401]
    const recorder = createDesktopLifecycleRecorder({
      userDataDir,
      appVersion: '2.0.1-test',
      platform: 'win32',
      arch: 'x64',
      logger,
      now: () => FIXED_NOW,
      monotonicNow: () => ticks.shift() ?? 401,
      randomId: () => ids.shift() ?? 'unexpected-id',
    })

    recorder.startStartup('electron-ready')
    recorder.transitionStartupStage('shell-environment')
    recorder.startRendererBoot()
    recorder.finishRendererBoot({ status: 'healthy' })
    recorder.completeStartup('shell-environment', { status: 'healthy' })

    const events = readEvents(userDataDir)
    expect(events.map(event => event.runId)).toEqual(Array.from({ length: events.length }, () => 'run-fixed'))
    expect(events.map(event => event.operationId)).toEqual(Array.from({ length: events.length }, () => 'operation-fixed'))
    expect(events.map(event => event.eventName)).toEqual([
      'startup.run.started',
      'startup.stage.started',
      'startup.stage.completed',
      'startup.stage.started',
      'renderer.boot.started',
      'renderer.boot.completed',
      'startup.stage.completed',
      'startup.run.completed',
    ])
    expect(events[2]).toMatchObject({ stageId: 'electron-ready', durationMs: 10 })
    expect(events[5]).toMatchObject({
      eventName: 'renderer.boot.completed',
      durationMs: 50,
      details: { rendererStatus: 'healthy' },
    })
    expect(events[6]).toMatchObject({ stageId: 'shell-environment', durationMs: 170 })
    expect(events[7]).toMatchObject({
      eventName: 'startup.run.completed',
      durationMs: 300,
      details: { finalStage: 'shell-environment', rendererStatus: 'healthy' },
    })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('keeps a newer recorder generation isolated from a delayed older recorder', () => {
    const userDataDir = tempUserData('dsh-lifecycle-generation-')
    const olderLogger = createLogger()
    const olderIds = ['older-run', 'older-operation']
    const older = createDesktopLifecycleRecorder({
      userDataDir,
      appVersion: '2.0.1-test',
      platform: 'win32',
      arch: 'x64',
      logger: olderLogger,
      now: () => FIXED_NOW,
      randomId: () => olderIds.shift() ?? 'older-extra',
    })
    older.startStartup('electron-ready')

    const newerLogger = createLogger()
    const newerIds = ['newer-run', 'newer-operation']
    const newer = createDesktopLifecycleRecorder({
      userDataDir,
      appVersion: '2.0.1-test',
      platform: 'win32',
      arch: 'x64',
      logger: newerLogger,
      now: () => FIXED_NOW,
      randomId: () => newerIds.shift() ?? 'newer-extra',
    })
    newer.startStartup('runtime-bootstrap')

    older.failStartup('electron-ready', 'startup-failed')
    newer.completeStartup('runtime-bootstrap', { status: 'healthy' })

    const evidencePath = desktopLifecycleEvidencePath(userDataDir)
    const events = readEvents(userDataDir)
    expect(events.map(event => event.runId)).toEqual(Array.from({ length: events.length }, () => 'newer-run'))
    expect(events.map(event => event.operationId)).toEqual(Array.from({ length: events.length }, () => 'newer-operation'))
    expect(events.map(event => event.eventName)).toEqual([
      'startup.run.started',
      'startup.stage.started',
      'startup.stage.completed',
      'startup.run.completed',
    ])
    const summary = JSON.parse(summarizeDesktopLifecycleEvidence(readFileSync(evidencePath))?.toString('utf8') ?? '') as DesktopLifecycleSummary
    expect(summary).toMatchObject({
      eventCount: 4,
      parseErrorCount: 0,
      runId: 'newer-run',
      operationId: 'newer-operation',
      finalOutcome: 'completed',
    })
    expect(olderLogger.error).toHaveBeenCalledWith(expect.stringContaining('failed to persist lifecycle evidence'))
    expect(newerLogger.error).not.toHaveBeenCalled()
  })

  it('records renderer start separately from terminal healthy, failed, and timeout outcomes', () => {
    const healthyDir = tempUserData('dsh-lifecycle-healthy-')
    const healthy = createDesktopLifecycleRecorder({
      userDataDir: healthyDir,
      appVersion: '2.0.1-test',
      platform: 'darwin',
      arch: 'arm64',
      logger: createLogger(),
      now: () => FIXED_NOW,
      monotonicNow: (() => {
        let tick = 0
        return () => {
          tick += 10
          return tick
        }
      })(),
      randomId: (() => {
        const ids = ['healthy-run', 'healthy-op']
        return () => ids.shift() ?? 'healthy-extra'
      })(),
    })
    healthy.startStartup('renderer-startup')
    healthy.startRendererBoot()
    expect(readEvents(healthyDir).map(event => event.eventName)).toContain('renderer.boot.started')
    expect(readEvents(healthyDir).map(event => event.eventName)).not.toContain('renderer.boot.completed')
    expect(readEvents(healthyDir).map(event => event.eventName)).not.toContain('startup.run.completed')
    healthy.finishRendererBoot({ status: 'healthy' })
    healthy.completeStartup('health-commit', { status: 'healthy' })
    expect(readEvents(healthyDir).find(event => event.eventName === 'renderer.boot.completed')).toMatchObject({
      eventName: 'renderer.boot.completed',
      details: { rendererStatus: 'healthy' },
    })
    expect(readEvents(healthyDir).at(-1)).toMatchObject({
      eventName: 'startup.run.completed',
      details: { finalStage: 'health-commit', rendererStatus: 'healthy' },
    })

    const failedDir = tempUserData('dsh-lifecycle-failed-')
    const failed = createDesktopLifecycleRecorder({
      userDataDir: failedDir,
      appVersion: '2.0.1-test',
      platform: 'win32',
      arch: 'x64',
      logger: createLogger(),
      now: () => FIXED_NOW,
      randomId: (() => {
        const ids = ['failed-run', 'failed-op']
        return () => ids.shift() ?? 'failed-extra'
      })(),
    })
    failed.startStartup('renderer-startup')
    failed.startRendererBoot()
    failed.finishRendererBoot({
      status: 'failed',
      plugins: ['dsh-vision-router', '@scope/plugin-ok', '../escape', 'UpperBad', 'space bad'],
      error: 'ignored by lifecycle evidence',
    })
    failed.failStartup('renderer-startup', 'renderer-failed')
    expect(readEvents(failedDir).find(event => event.eventName === 'renderer.boot.failed')).toMatchObject({
      details: {
        rendererStatus: 'failed',
        failureReason: 'renderer-failed',
        pluginCount: 5,
        pluginIds: ['dsh-vision-router', '@scope/plugin-ok'],
      },
    })
    expect(readEvents(failedDir).at(-1)).toMatchObject({
      eventName: 'startup.run.failed',
      details: { finalStage: 'renderer-startup', failureReason: 'renderer-failed' },
    })

    const timeoutDir = tempUserData('dsh-lifecycle-timeout-')
    const timeout = createDesktopLifecycleRecorder({
      userDataDir: timeoutDir,
      appVersion: '2.0.1-test',
      platform: 'linux',
      arch: 'x64',
      logger: createLogger(),
      now: () => FIXED_NOW,
      randomId: (() => {
        const ids = ['timeout-run', 'timeout-op']
        return () => ids.shift() ?? 'timeout-extra'
      })(),
    })
    timeout.startStartup('renderer-startup')
    timeout.startRendererBoot()
    timeout.finishRendererBoot({ status: 'failed', plugins: [] }, 'renderer-timeout')
    timeout.failStartup('renderer-startup', 'renderer-timeout')
    expect(readEvents(timeoutDir).find(event => event.eventName === 'renderer.boot.timeout')).toMatchObject({
      details: { rendererStatus: 'timeout', failureReason: 'renderer-timeout', pluginCount: 0, pluginIds: [] },
    })
    expect(readEvents(timeoutDir).at(-1)).toMatchObject({
      eventName: 'startup.run.failed',
      details: { finalStage: 'renderer-startup', failureReason: 'renderer-timeout' },
    })
  })

  it('replaces stale run evidence and keeps current evidence within byte caps', () => {
    const userDataDir = tempUserData('dsh-lifecycle-cap-')
    const evidencePath = desktopLifecycleEvidencePath(userDataDir)
    mkdirSync(join(userDataDir, 'lifecycle-events'))
    writeFileSync(evidencePath, 'stale run evidence\n')
    const recorder = createDesktopLifecycleRecorder({
      userDataDir,
      appVersion: '2.0.1-test',
      platform: 'win32',
      arch: 'x64',
      logger: createLogger(),
      now: () => FIXED_NOW,
      randomId: (() => {
        const ids = ['cap-run', 'cap-op']
        return () => ids.shift() ?? 'cap-extra'
      })(),
    })

    recorder.startStartup('electron-ready')
    expect(readFileSync(evidencePath, 'utf8')).not.toContain('stale run evidence')

    const stages: DesktopStartupFailureStage[] = [
      'shell-environment',
      'runtime-bootstrap',
      'profile-selection',
      'install-recovery',
      'profile-composition',
      'host-boot',
      'renderer-startup',
      'health-commit',
    ]
    for (let index = 0; index < 900; index += 1) {
      recorder.transitionStartupStage(stages[index % stages.length] as DesktopStartupFailureStage)
    }

    const evidence = readFileSync(evidencePath, 'utf8')
    expect(Buffer.byteLength(evidence)).toBeLessThanOrEqual(MAX_DESKTOP_LIFECYCLE_EVIDENCE_BYTES)
    const retainedEvents = evidence.split('\n').filter(item => item.length > 0)
    expect(JSON.parse(retainedEvents[0] ?? '{}')).toMatchObject({
      runId: 'cap-run',
      operationId: 'cap-op',
      eventName: 'startup.run.started',
    })
    for (const line of retainedEvents) {
      expect(Buffer.byteLength(line) + 1).toBeLessThanOrEqual(MAX_DESKTOP_LIFECYCLE_EVENT_BYTES)
      expect(parseDesktopLifecycleEvent(JSON.parse(line) as unknown)).toMatchObject({
        runId: 'cap-run',
        operationId: 'cap-op',
      })
    }
  })

  it('treats linked or unsafe evidence targets as best-effort logger-only failures', () => {
    const linkedParentDir = tempUserData('dsh-lifecycle-parent-link-')
    const linkedParentTarget = join(linkedParentDir, 'target')
    mkdirSync(linkedParentTarget)
    symlinkSync(linkedParentTarget, join(linkedParentDir, 'lifecycle-events'), process.platform === 'win32' ? 'junction' : 'dir')
    const linkedParentLogger = createLogger()
    const linkedParent = createDesktopLifecycleRecorder({
      userDataDir: linkedParentDir,
      appVersion: '2.0.1-test',
      platform: 'win32',
      arch: 'x64',
      logger: linkedParentLogger,
      now: () => FIXED_NOW,
    })
    expect(() => { linkedParent.startStartup('electron-ready') }).not.toThrow()
    expect(linkedParentLogger.error).toHaveBeenCalledWith(expect.stringContaining('failed to persist lifecycle evidence'))

    const linkedFileDir = tempUserData('dsh-lifecycle-file-link-')
    const linkedFileTarget = join(linkedFileDir, 'target.jsonl')
    mkdirSync(join(linkedFileDir, 'lifecycle-events'))
    writeFileSync(linkedFileTarget, '')
    symlinkSync(linkedFileTarget, desktopLifecycleEvidencePath(linkedFileDir), 'file')
    const linkedFileLogger = createLogger()
    const linkedFile = createDesktopLifecycleRecorder({
      userDataDir: linkedFileDir,
      appVersion: '2.0.1-test',
      platform: 'win32',
      arch: 'x64',
      logger: linkedFileLogger,
      now: () => FIXED_NOW,
    })
    expect(() => { linkedFile.startStartup('electron-ready') }).not.toThrow()
    expect(linkedFileLogger.error).toHaveBeenCalledWith(expect.stringContaining('failed to persist lifecycle evidence'))

    const hardlinkDir = tempUserData('dsh-lifecycle-hardlink-')
    const hardlinkTarget = join(hardlinkDir, 'target.jsonl')
    mkdirSync(join(hardlinkDir, 'lifecycle-events'))
    writeFileSync(hardlinkTarget, '')
    linkSync(hardlinkTarget, desktopLifecycleEvidencePath(hardlinkDir))
    const hardlinkLogger = createLogger()
    const hardlink = createDesktopLifecycleRecorder({
      userDataDir: hardlinkDir,
      appVersion: '2.0.1-test',
      platform: 'win32',
      arch: 'x64',
      logger: hardlinkLogger,
      now: () => FIXED_NOW,
    })
    expect(() => { hardlink.startStartup('electron-ready') }).not.toThrow()
    expect(hardlinkLogger.error).toHaveBeenCalledWith(expect.stringContaining('failed to persist lifecycle evidence'))

    const unsafeWriteDir = tempUserData('dsh-lifecycle-unsafe-write-')
    const unsafeWriteLogger = createLogger()
    const unsafeWrite = createDesktopLifecycleRecorder({
      userDataDir: unsafeWriteDir,
      appVersion: '2.0.1-test',
      platform: 'win32',
      arch: 'x64',
      logger: unsafeWriteLogger,
      now: () => FIXED_NOW,
    })
    const unsafeWritePath = desktopLifecycleEvidencePath(unsafeWriteDir)
    expect(existsSync(unsafeWritePath)).toBe(true)
    unlinkSync(unsafeWritePath)
    mkdirSync(unsafeWritePath)
    expect(() => { unsafeWrite.startStartup('electron-ready') }).not.toThrow()
    expect(unsafeWriteLogger.error).toHaveBeenCalledWith(expect.stringContaining('failed to persist lifecycle evidence'))
    expect(unsafeWriteLogger.errorCause).not.toHaveBeenCalled()
  })

  it('summarizes only one correlated run while counting malformed and mismatched lines', () => {
    const summaryBuffer = summarizeDesktopLifecycleEvidence(Buffer.from([
      eventLine(),
      'not-json',
      eventLine({ operationId: 'other-op' }),
      eventLine({ eventName: 'startup.stage.completed', durationMs: 42 }),
      eventLine({
        eventName: 'renderer.boot.completed',
        stageId: undefined,
        details: { rendererStatus: 'healthy' },
      }),
      eventLine({
        eventName: 'startup.run.completed',
        stageId: undefined,
        durationMs: 100,
        details: { finalStage: 'health-commit', rendererStatus: 'healthy' },
      }),
      '',
    ].join('\n'), 'utf8'))

    expect(summaryBuffer).not.toBeUndefined()
    const summary = JSON.parse(summaryBuffer?.toString('utf8') ?? '') as DesktopLifecycleSummary
    expect(summary).toMatchObject({
      schemaVersion: DESKTOP_LIFECYCLE_SCHEMA_VERSION,
      eventCount: 4,
      parseErrorCount: 2,
      runId: 'run-1',
      operationId: 'op-1',
      finalOutcome: 'completed',
      finalStage: 'health-commit',
      rendererStatus: 'healthy',
      totalDurationMs: 100,
      stages: [{ stageId: 'electron-ready', status: 'completed', durationMs: 42 }],
    })
  })
})

import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { DesktopLogger } from './desktop-logger.ts'
import type { RendererBootReport } from './renderer-boot-contract.ts'
import type { DesktopStartupFailureStage } from './startup-recovery-window.ts'

export const DESKTOP_LIFECYCLE_SCHEMA_VERSION = 1
export const DESKTOP_LIFECYCLE_EVIDENCE_ENTRY = 'lifecycle-events/startup.jsonl'
export const DESKTOP_LIFECYCLE_SUMMARY_ENTRY = 'lifecycle-events/summary.json'
export const MAX_DESKTOP_LIFECYCLE_EVIDENCE_BYTES = 256 * 1024
export const MAX_DESKTOP_LIFECYCLE_EVENT_BYTES = 8 * 1024

const EVIDENCE_DIRECTORY_NAME = 'lifecycle-events'
const EVIDENCE_FILENAME = 'startup.jsonl'
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const MAX_DETAIL_STRING_LENGTH = 128
const MAX_PLUGIN_IDS = 16
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const PLUGIN_ID_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,127}$/u

const STARTUP_STAGES = new Set<DesktopStartupFailureStage>([
  'electron-ready',
  'shell-environment',
  'runtime-bootstrap',
  'profile-selection',
  'install-recovery',
  'profile-composition',
  'host-boot',
  'renderer-startup',
  'health-commit',
])

const EVENT_NAMES = new Set<DesktopLifecycleEventName>([
  'startup.run.started',
  'startup.run.completed',
  'startup.run.failed',
  'startup.stage.started',
  'startup.stage.completed',
  'startup.stage.failed',
  'renderer.boot.started',
  'renderer.boot.completed',
  'renderer.boot.failed',
  'renderer.boot.timeout',
])

const RENDERER_STATUSES = new Set(['healthy', 'failed', 'timeout'])
const FAILURE_REASONS = new Set(['startup-failed', 'renderer-failed', 'renderer-timeout'])

export type DesktopLifecycleFailureReason = 'startup-failed' | 'renderer-failed' | 'renderer-timeout'
export type DesktopLifecycleRendererFailureReason = 'renderer-failed' | 'renderer-timeout'
export type DesktopLifecycleRendererStatus = 'healthy' | 'failed' | 'timeout'
export type DesktopLifecycleEventName =
  | 'startup.run.started'
  | 'startup.run.completed'
  | 'startup.run.failed'
  | 'startup.stage.started'
  | 'startup.stage.completed'
  | 'startup.stage.failed'
  | 'renderer.boot.started'
  | 'renderer.boot.completed'
  | 'renderer.boot.failed'
  | 'renderer.boot.timeout'

type DesktopLifecycleDetailValue = string | number | readonly string[]
type DesktopLifecycleDetails = Readonly<Record<string, DesktopLifecycleDetailValue>>

export interface DesktopLifecycleEvent {
  readonly schemaVersion: typeof DESKTOP_LIFECYCLE_SCHEMA_VERSION
  readonly timestamp: string
  readonly monotonicMs: number
  readonly durationMs?: number
  readonly runId: string
  readonly operationId: string
  readonly eventName: DesktopLifecycleEventName
  readonly stageId?: DesktopStartupFailureStage
  readonly details: DesktopLifecycleDetails
}

export interface DesktopLifecycleSummaryStage {
  readonly stageId: DesktopStartupFailureStage
  readonly status: 'started' | 'completed' | 'failed'
  readonly durationMs?: number
}

export interface DesktopLifecycleSummary {
  readonly schemaVersion: typeof DESKTOP_LIFECYCLE_SCHEMA_VERSION
  readonly eventCount: number
  readonly parseErrorCount: number
  readonly runId?: string
  readonly operationId?: string
  readonly finalOutcome?: 'completed' | 'failed'
  readonly finalStage?: DesktopStartupFailureStage
  readonly rendererStatus?: DesktopLifecycleRendererStatus
  readonly totalDurationMs?: number
  readonly stages: readonly DesktopLifecycleSummaryStage[]
}

export interface DesktopLifecycleRecorderOptions {
  readonly userDataDir: string
  readonly appVersion: string
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly logger: DesktopLogger
  readonly now?: () => Date
  readonly monotonicNow?: () => number
  readonly randomId?: () => string
}

export function desktopLifecycleEvidencePath(userDataDir: string): string {
  return join(userDataDir, EVIDENCE_DIRECTORY_NAME, EVIDENCE_FILENAME)
}

export function createDesktopLifecycleRecorder(options: DesktopLifecycleRecorderOptions): DesktopLifecycleRecorder {
  return new DesktopLifecycleRecorder(options)
}

export function parseDesktopLifecycleEvent(value: unknown): DesktopLifecycleEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('event must be an object')
  const event = value as Record<string, unknown>
  if (event.schemaVersion !== DESKTOP_LIFECYCLE_SCHEMA_VERSION) throw new Error('event schemaVersion is invalid')
  if (typeof event.timestamp !== 'string' || event.timestamp.length === 0 || /[\0\r\n]/u.test(event.timestamp)) {
    throw new Error('event timestamp is invalid')
  }
  if (Number.isNaN(Date.parse(event.timestamp))) throw new Error('event timestamp is invalid')
  if (typeof event.monotonicMs !== 'number' || !validDuration(event.monotonicMs)) {
    throw new Error('event monotonicMs is invalid')
  }
  const monotonicMs = event.monotonicMs
  let durationMs: number | undefined
  if (event.durationMs !== undefined) {
    if (typeof event.durationMs !== 'number' || !validDuration(event.durationMs)) {
      throw new Error('event durationMs is invalid')
    }
    durationMs = event.durationMs
  }
  if (typeof event.runId !== 'string' || !ID_PATTERN.test(event.runId)) throw new Error('event runId is invalid')
  const runId = event.runId
  if (typeof event.operationId !== 'string' || !ID_PATTERN.test(event.operationId)) {
    throw new Error('event operationId is invalid')
  }
  const operationId = event.operationId
  if (typeof event.eventName !== 'string' || !EVENT_NAMES.has(event.eventName as DesktopLifecycleEventName)) {
    throw new Error('event name is invalid')
  }
  const eventName = event.eventName as DesktopLifecycleEventName
  const stageId = parseEventStage(eventName, event.stageId)
  const details = parseDetails(eventName, event.details)
  return {
    schemaVersion: DESKTOP_LIFECYCLE_SCHEMA_VERSION,
    timestamp: event.timestamp,
    monotonicMs,
    ...(durationMs === undefined ? {} : { durationMs }),
    runId,
    operationId,
    eventName,
    ...(stageId === undefined ? {} : { stageId }),
    details,
  }
}

export function summarizeDesktopLifecycleEvidence(content: Buffer): Buffer | undefined {
  let eventCount = 0
  let parseErrorCount = 0
  let runId: string | undefined
  let operationId: string | undefined
  let finalOutcome: 'completed' | 'failed' | undefined
  let finalStage: DesktopStartupFailureStage | undefined
  let rendererStatus: DesktopLifecycleRendererStatus | undefined
  let totalDurationMs: number | undefined
  const stages: DesktopLifecycleSummaryStage[] = []

  for (const line of content.toString('utf8').split(/\n/u)) {
    if (line.length === 0) continue
    let event: DesktopLifecycleEvent
    try {
      event = parseDesktopLifecycleEvent(JSON.parse(line) as unknown)
    } catch {
      parseErrorCount += 1
      continue
    }
    if (runId === undefined) {
      runId = event.runId
      operationId = event.operationId
    } else if (event.runId !== runId || event.operationId !== operationId) {
      parseErrorCount += 1
      continue
    }
    eventCount += 1
    if (event.eventName.startsWith('startup.stage.') && event.stageId !== undefined) {
      const status = event.eventName.endsWith('.completed')
        ? 'completed'
        : event.eventName.endsWith('.failed') ? 'failed' : 'started'
      const openStage = [...stages].reverse().find(stage => stage.stageId === event.stageId && stage.status === 'started')
      if (openStage !== undefined && status !== 'started') {
        const index = stages.lastIndexOf(openStage)
        stages[index] = {
          stageId: event.stageId,
          status,
          ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
        }
      } else {
        stages.push({
          stageId: event.stageId,
          status,
          ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
        })
      }
    }
    if (event.eventName === 'renderer.boot.completed') rendererStatus = 'healthy'
    else if (event.eventName === 'renderer.boot.failed') rendererStatus = 'failed'
    else if (event.eventName === 'renderer.boot.timeout') rendererStatus = 'timeout'
    if (event.eventName === 'startup.run.completed' || event.eventName === 'startup.run.failed') {
      finalOutcome = event.eventName === 'startup.run.completed' ? 'completed' : 'failed'
      finalStage = event.details.finalStage as DesktopStartupFailureStage | undefined
      if (event.durationMs !== undefined) totalDurationMs = event.durationMs
    }
  }

  if (eventCount === 0 && parseErrorCount === 0) return undefined
  return Buffer.from(`${JSON.stringify({
    schemaVersion: DESKTOP_LIFECYCLE_SCHEMA_VERSION,
    eventCount,
    parseErrorCount,
    ...(runId === undefined ? {} : { runId }),
    ...(operationId === undefined ? {} : { operationId }),
    ...(finalOutcome === undefined ? {} : { finalOutcome }),
    ...(finalStage === undefined ? {} : { finalStage }),
    ...(rendererStatus === undefined ? {} : { rendererStatus }),
    ...(totalDurationMs === undefined ? {} : { totalDurationMs }),
    stages,
  } satisfies DesktopLifecycleSummary, undefined, 2)}\n`, 'utf8')
}

export class DesktopLifecycleRecorder {
  private readonly evidencePath: string
  private readonly runId: string
  private readonly operationId: string
  private readonly now: () => Date
  private readonly monotonicNow: () => number
  private readonly startTime: number
  private generationLine: Buffer | undefined
  private currentStage: DesktopStartupFailureStage | undefined
  private currentStageStartedAt: number | undefined
  private rendererStartedAt: number | undefined
  private rendererSettled = false
  private startupSettled = false
  private evidenceUnavailable = false
  private readonly options: DesktopLifecycleRecorderOptions

  constructor(options: DesktopLifecycleRecorderOptions) {
    this.options = options
    this.evidencePath = desktopLifecycleEvidencePath(options.userDataDir)
    this.now = options.now ?? (() => new Date())
    this.monotonicNow = options.monotonicNow ?? (() => performance.now())
    this.runId = validateId(options.randomId?.() ?? randomUUID(), 'runId')
    this.operationId = validateId(options.randomId?.() ?? randomUUID(), 'operationId')
    this.startTime = this.monotonicNow()
    this.prepareFreshEvidence()
  }

  startStartup(initialStage: DesktopStartupFailureStage): void {
    if (this.currentStage !== undefined) return
    this.currentStage = initialStage
    this.currentStageStartedAt = this.monotonicNow()
    this.recordStartupStage(initialStage, 'started')
  }

  transitionStartupStage(stage: DesktopStartupFailureStage): void {
    if (this.startupSettled || this.currentStage === stage) return
    this.completeCurrentStage()
    this.currentStage = stage
    this.currentStageStartedAt = this.monotonicNow()
    this.recordStartupStage(stage, 'started')
  }

  startRendererBoot(): void {
    if (this.rendererStartedAt !== undefined || this.rendererSettled) return
    this.rendererStartedAt = this.monotonicNow()
    this.record('renderer.boot.started', {})
  }

  finishRendererBoot(
    report: RendererBootReport,
    failureReason: DesktopLifecycleRendererFailureReason = 'renderer-failed',
  ): void {
    if (this.rendererSettled) return
    this.rendererSettled = true
    const durationMs = this.durationFrom(this.rendererStartedAt)
    if (report.status === 'healthy') {
      this.record('renderer.boot.completed', { rendererStatus: 'healthy' }, durationMs)
      return
    }
    const timeout = failureReason === 'renderer-timeout'
    this.record(timeout ? 'renderer.boot.timeout' : 'renderer.boot.failed', {
      rendererStatus: timeout ? 'timeout' : 'failed',
      failureReason,
      pluginCount: report.plugins.length,
      pluginIds: safePluginIds(report.plugins),
    }, durationMs)
  }

  failRendererBootIfPending(failureReason: DesktopLifecycleRendererFailureReason): void {
    if (this.rendererStartedAt === undefined || this.rendererSettled) return
    this.rendererSettled = true
    const timeout = failureReason === 'renderer-timeout'
    this.record(timeout ? 'renderer.boot.timeout' : 'renderer.boot.failed', {
      rendererStatus: timeout ? 'timeout' : 'failed',
      failureReason,
    }, this.durationFrom(this.rendererStartedAt))
  }

  completeStartup(finalStage: DesktopStartupFailureStage, report: RendererBootReport): void {
    if (this.startupSettled) return
    this.startupSettled = true
    this.completeCurrentStage()
    this.record('startup.run.completed', {
      finalStage,
      rendererStatus: report.status === 'healthy' ? 'healthy' : 'failed',
    }, this.durationFrom(this.startTime))
  }

  failStartup(finalStage: DesktopStartupFailureStage, failureReason: DesktopLifecycleFailureReason): void {
    if (this.startupSettled) return
    this.startupSettled = true
    this.failCurrentStage()
    this.record('startup.run.failed', {
      finalStage,
      failureReason,
    }, this.durationFrom(this.startTime))
  }

  private completeCurrentStage(): void {
    const stage = this.currentStage
    if (stage === undefined) return
    this.recordStartupStage(stage, 'completed', this.durationFrom(this.currentStageStartedAt))
    this.currentStage = undefined
    this.currentStageStartedAt = undefined
  }

  private failCurrentStage(): void {
    const stage = this.currentStage
    if (stage === undefined) return
    this.recordStartupStage(stage, 'failed', this.durationFrom(this.currentStageStartedAt))
    this.currentStage = undefined
    this.currentStageStartedAt = undefined
  }

  private recordStartupStage(
    stageId: DesktopStartupFailureStage,
    outcome: 'started' | 'completed' | 'failed',
    durationMs?: number,
  ): void {
    this.record(
      `startup.stage.${outcome}` as DesktopLifecycleEventName,
      {},
      durationMs,
      stageId,
    )
  }

  private record(
    eventName: DesktopLifecycleEventName,
    details: DesktopLifecycleDetails,
    durationMs?: number,
    stageId?: DesktopStartupFailureStage,
  ): void {
    try {
      this.writeEvent(this.createEvent(eventName, details, durationMs, stageId))
    } catch (cause) {
      this.evidenceUnavailable = true
      this.reportFailure(cause)
    }
  }

  private createEvent(
    eventName: DesktopLifecycleEventName,
    details: DesktopLifecycleDetails,
    durationMs?: number,
    stageId?: DesktopStartupFailureStage,
  ): DesktopLifecycleEvent {
    return parseDesktopLifecycleEvent({
      schemaVersion: DESKTOP_LIFECYCLE_SCHEMA_VERSION,
      timestamp: this.now().toISOString(),
      monotonicMs: this.durationFrom(this.startTime) ?? 0,
      ...(durationMs === undefined ? {} : { durationMs }),
      runId: this.runId,
      operationId: this.operationId,
      eventName,
      ...(stageId === undefined ? {} : { stageId }),
      details,
    })
  }

  private renderEvent(event: DesktopLifecycleEvent): Buffer {
    const line = Buffer.from(`${JSON.stringify(event)}\n`)
    if (line.byteLength > MAX_DESKTOP_LIFECYCLE_EVENT_BYTES) {
      throw new Error('lifecycle event is too large')
    }
    return line
  }

  private durationFrom(startedAt: number | undefined): number | undefined {
    if (startedAt === undefined) return undefined
    const value = this.monotonicNow() - startedAt
    return Number.isFinite(value) && value >= 0 ? Number(value.toFixed(3)) : undefined
  }

  private prepareFreshEvidence(): void {
    try {
      const generationLine = this.renderEvent(this.createEvent('startup.run.started', {
        appVersion: safeLine(this.options.appVersion),
        platform: safeLine(this.options.platform),
        arch: safeLine(this.options.arch),
      }))
      const directory = dirname(this.evidencePath)
      mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
      const directoryStats = lstatSync(directory)
      if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
        throw new Error('lifecycle evidence directory is invalid')
      }
      try { chmodSync(directory, PRIVATE_DIRECTORY_MODE) } catch {}
      if (existsSync(this.evidencePath)) {
        const stats = lstatSync(this.evidencePath)
        if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink > 1) {
          throw new Error('lifecycle evidence file is invalid')
        }
        unlinkSync(this.evidencePath)
      }
      const descriptor = openSync(this.evidencePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(), PRIVATE_FILE_MODE)
      try {
        if (writeSync(descriptor, generationLine) !== generationLine.byteLength) {
          throw new Error('lifecycle evidence generation write was incomplete')
        }
      } finally {
        closeSync(descriptor)
      }
      this.generationLine = generationLine
      try { chmodSync(this.evidencePath, PRIVATE_FILE_MODE) } catch {}
    } catch (cause) {
      this.evidenceUnavailable = true
      this.reportFailure(cause)
    }
  }

  private writeEvent(event: DesktopLifecycleEvent): void {
    if (this.evidenceUnavailable) return
    const generationLine = this.requireGenerationLine()
    const line = this.renderEvent(event)
    const existing = this.readOwned()
    if (existing.byteLength + line.byteLength <= MAX_DESKTOP_LIFECYCLE_EVIDENCE_BYTES) {
      this.appendOwned(line)
      return
    }
    const keepBytes = Math.max(0, MAX_DESKTOP_LIFECYCLE_EVIDENCE_BYTES - generationLine.byteLength - line.byteLength)
    const priorEvents = existing.subarray(generationLine.byteLength)
    const tail = keepBytes === 0 ? Buffer.alloc(0) : priorEvents.subarray(Math.max(0, priorEvents.byteLength - keepBytes))
    const firstNewline = tail.indexOf(0x0a)
    const retained = firstNewline === -1 ? Buffer.alloc(0) : tail.subarray(firstNewline + 1)
    this.replaceOwned(Buffer.concat([generationLine, retained, line]))
  }

  private readOwned(): Buffer {
    const descriptor = openSync(this.evidencePath, constants.O_RDONLY | noFollowFlag())
    try {
      return this.readOwnedDescriptor(descriptor)
    } finally {
      closeSync(descriptor)
    }
  }

  private readOwnedDescriptor(descriptor: number): Buffer {
    const stats = fstatSync(descriptor)
    if (!stats.isFile() || stats.nlink > 1) throw new Error('lifecycle evidence file is invalid')
    const content = readFileSync(descriptor)
    const generationLine = this.requireGenerationLine()
    if (content.byteLength < generationLine.byteLength
      || !content.subarray(0, generationLine.byteLength).equals(generationLine)) {
      throw new Error('lifecycle evidence belongs to another recorder')
    }
    return content
  }

  private appendOwned(line: Buffer): void {
    const descriptor = openSync(this.evidencePath, constants.O_RDWR | constants.O_APPEND | noFollowFlag())
    try {
      this.readOwnedDescriptor(descriptor)
      if (writeSync(descriptor, line) !== line.byteLength) {
        throw new Error('lifecycle evidence append was incomplete')
      }
    } finally {
      closeSync(descriptor)
    }
  }

  private replaceOwned(content: Buffer): void {
    const descriptor = openSync(this.evidencePath, constants.O_RDWR | noFollowFlag())
    try {
      this.readOwnedDescriptor(descriptor)
      ftruncateSync(descriptor)
      if (writeSync(descriptor, content, 0, content.byteLength, 0) !== content.byteLength) {
        throw new Error('lifecycle evidence replacement was incomplete')
      }
    } finally {
      closeSync(descriptor)
    }
  }

  private requireGenerationLine(): Buffer {
    if (this.generationLine === undefined) throw new Error('lifecycle evidence generation is unavailable')
    return this.generationLine
  }

  private reportFailure(cause: unknown): void {
    const code = cause !== null
      && typeof cause === 'object'
      && 'code' in cause
      && typeof cause.code === 'string'
      ? ` (${cause.code})`
      : ''
    this.options.logger.error(`dsh-plugin-desktop: failed to persist lifecycle evidence${code}`)
  }
}

function noFollowFlag(): number {
  return process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
}

function parseEventStage(
  eventName: DesktopLifecycleEventName,
  value: unknown,
): DesktopStartupFailureStage | undefined {
  const stageEvent = eventName.startsWith('startup.stage.')
  if (!stageEvent && value === undefined) return undefined
  if (!stageEvent) throw new Error('event stageId is invalid')
  return parseStage(value)
}

function parseDetails(eventName: DesktopLifecycleEventName, value: unknown): DesktopLifecycleDetails {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('event details are invalid')
  const details = value as Record<string, unknown>
  for (const key of Object.keys(details)) {
    if (!allowedDetailKeys(eventName).has(key)) throw new Error('event detail key is invalid')
  }
  if (eventName === 'startup.run.started') return parseStartupStartedDetails(details)
  if (eventName === 'startup.run.completed') return parseStartupCompletedDetails(details)
  if (eventName === 'startup.run.failed') return parseStartupFailedDetails(details)
  if (eventName === 'renderer.boot.completed') return { rendererStatus: parseRendererStatus(details.rendererStatus) }
  if (eventName === 'renderer.boot.failed' || eventName === 'renderer.boot.timeout') return parseRendererFailedDetails(details)
  return {}
}

function allowedDetailKeys(eventName: DesktopLifecycleEventName): ReadonlySet<string> {
  if (eventName === 'startup.run.started') return new Set(['appVersion', 'arch', 'platform'])
  if (eventName === 'startup.run.completed') return new Set(['finalStage', 'rendererStatus'])
  if (eventName === 'startup.run.failed') return new Set(['failureReason', 'finalStage'])
  if (eventName === 'renderer.boot.completed') return new Set(['rendererStatus'])
  if (eventName === 'renderer.boot.failed' || eventName === 'renderer.boot.timeout') {
    return new Set(['failureReason', 'pluginCount', 'pluginIds', 'rendererStatus'])
  }
  return new Set()
}

function parseStartupStartedDetails(details: Record<string, unknown>): DesktopLifecycleDetails {
  return {
    appVersion: safeLine(details.appVersion),
    platform: safeLine(details.platform),
    arch: safeLine(details.arch),
  }
}

function parseStartupCompletedDetails(details: Record<string, unknown>): DesktopLifecycleDetails {
  return {
    finalStage: parseStage(details.finalStage),
    rendererStatus: parseRendererStatus(details.rendererStatus),
  }
}

function parseStartupFailedDetails(details: Record<string, unknown>): DesktopLifecycleDetails {
  return {
    finalStage: parseStage(details.finalStage),
    failureReason: parseFailureReason(details.failureReason),
  }
}

function parseRendererFailedDetails(details: Record<string, unknown>): DesktopLifecycleDetails {
  const parsed: Record<string, DesktopLifecycleDetailValue> = {
    rendererStatus: parseRendererStatus(details.rendererStatus),
    failureReason: parseFailureReason(details.failureReason),
  }
  if (details.pluginCount !== undefined) parsed.pluginCount = parseCount(details.pluginCount)
  if (details.pluginIds !== undefined) parsed.pluginIds = parsePluginIds(details.pluginIds)
  return parsed
}

function safeLine(value: unknown): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_DETAIL_STRING_LENGTH
    || /[\0\r\n]/u.test(value)) {
    throw new Error('detail string is invalid')
  }
  return value
}

function validateId(value: string, label: string): string {
  if (!ID_PATTERN.test(value)) throw new Error(`lifecycle ${label} is invalid`)
  return value
}

function parseStage(value: unknown): DesktopStartupFailureStage {
  if (typeof value !== 'string' || !STARTUP_STAGES.has(value as DesktopStartupFailureStage)) {
    throw new Error('startup stage is invalid')
  }
  return value as DesktopStartupFailureStage
}

function parseRendererStatus(value: unknown): DesktopLifecycleRendererStatus {
  if (typeof value !== 'string' || !RENDERER_STATUSES.has(value)) throw new Error('renderer status is invalid')
  return value as DesktopLifecycleRendererStatus
}

function parseFailureReason(value: unknown): DesktopLifecycleFailureReason {
  if (typeof value !== 'string' || !FAILURE_REASONS.has(value)) throw new Error('failure reason is invalid')
  return value as DesktopLifecycleFailureReason
}

function parseCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new Error('detail count is invalid')
  }
  return value
}

function parsePluginIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_PLUGIN_IDS) throw new Error('plugin ids are invalid')
  return value.map(item => {
    if (typeof item !== 'string' || !PLUGIN_ID_PATTERN.test(item)) throw new Error('plugin id is invalid')
    return item
  })
}

function safePluginIds(plugins: readonly string[]): readonly string[] {
  return plugins.filter(plugin => PLUGIN_ID_PATTERN.test(plugin)).slice(0, MAX_PLUGIN_IDS)
}

function validDuration(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 24 * 60 * 60 * 1000
}

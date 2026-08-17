import { expect, it, vi } from 'vitest'
import {
  buildStartupFailurePresentation,
  createStartupFailureReport,
  presentStartupFailure,
  serializeStartupFailureReport,
  writeStartupFailureLog,
} from '../src/startup-failure.ts'

const context = {
  profileName: 'desktop',
  platform: 'win32',
  logPath: 'C:\\Users\\test\\AppData\\Roaming\\DSH Desktop\\logs\\dsh-plugin-desktop-startup.log',
  recovery: { kind: 'relaunch' as const, profileName: 'desktop' },
}

it('normalizes an unknown thrown value and records the complete stack', () => {
  const report = createStartupFailureReport(
    new Error('bad patch'),
    context,
    new Date('2026-08-17T13:00:00.000Z'),
  )

  expect(report).toMatchObject({
    timestamp: '2026-08-17T13:00:00.000Z',
    profileName: 'desktop',
    message: 'bad patch',
    recovery: context.recovery,
  })
  expect(report.stack).toContain('bad patch')
})

it('normalizes non-Error thrown values for user-facing diagnostics', () => {
  const report = createStartupFailureReport(
    'string failure',
    context,
    new Date('2026-08-17T13:00:00.000Z'),
  )

  expect(report.message).toBe('string failure')
  expect(report.stack).toBe('string failure')
})

it('serializes bounded context and stack for the latest startup log', () => {
  const report = createStartupFailureReport(
    new Error('bad patch'),
    context,
    new Date('2026-08-17T13:00:00.000Z'),
  )
  const text = serializeStartupFailureReport(report)
  const presentation = buildStartupFailurePresentation(report)

  expect(text).toContain('profile: desktop')
  expect(text).toContain(`log: ${context.logPath}`)
  expect(text).toContain('error: bad patch')
  expect(text).toContain('recovery: relaunch desktop')
  expect(presentation.dialog.content).toContain(context.logPath)
  expect(presentation.dialog.content).not.toContain(report.stack)
})

it('still attempts the dialog when notification presentation fails', () => {
  const report = createStartupFailureReport(
    new Error('bad patch'),
    context,
    new Date('2026-08-17T13:00:00.000Z'),
  )
  const notify = vi.fn(() => { throw new Error('notifications unavailable') })
  const showErrorBox = vi.fn()
  const writeStderr = vi.fn()

  presentStartupFailure(report, { notify, showErrorBox, writeStderr })

  expect(notify).toHaveBeenCalledOnce()
  expect(showErrorBox).toHaveBeenCalledOnce()
  expect(showErrorBox.mock.calls[0]?.[1]).toContain(context.logPath)
  expect(writeStderr).toHaveBeenCalledWith(expect.stringContaining('notifications unavailable'))
})

it('still attempts the notification when dialog presentation fails', () => {
  const report = createStartupFailureReport(
    new Error('bad patch'),
    context,
    new Date('2026-08-17T13:00:00.000Z'),
  )
  const notify = vi.fn()
  const showErrorBox = vi.fn(() => { throw new Error('dialog unavailable') })
  const writeStderr = vi.fn()

  presentStartupFailure(report, { notify, showErrorBox, writeStderr })

  expect(notify).toHaveBeenCalledOnce()
  expect(showErrorBox).toHaveBeenCalledOnce()
  expect(writeStderr).toHaveBeenCalledWith(expect.stringContaining('dialog unavailable'))
})

it('writes the latest report and returns writer failures instead of throwing', () => {
  const report = createStartupFailureReport(
    new Error('bad patch'),
    context,
    new Date('2026-08-17T13:00:00.000Z'),
  )
  const writes: Array<{ path: string; content: string }> = []
  const writer = (path: string, content: string): void => { writes.push({ path, content }) }

  expect(writeStartupFailureLog(report, writer)).toBeUndefined()
  expect(writes).toEqual([{ path: context.logPath, content: serializeStartupFailureReport(report) }])

  const failure = writeStartupFailureLog(report, () => { throw new Error('disk full') })
  expect(failure).toEqual(expect.objectContaining({ message: 'disk full' }))
})

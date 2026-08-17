import { writeFileSync } from 'node:fs'

const STARTUP_FAILURE_TITLE = 'Unable to Start DSH Desktop'

export type StartupFailureRecovery =
  | { kind: 'relaunch'; profileName: string }
  | { kind: 'exit' }

export interface StartupFailureContext {
  profileName: string
  platform: string
  logPath: string
  recovery: StartupFailureRecovery
}

export interface StartupFailureReport extends StartupFailureContext {
  timestamp: string
  message: string
  stack: string
}

export interface StartupFailurePresentation {
  notification: {
    title: string
    body: string
  }
  dialog: {
    title: string
    content: string
  }
}

export interface StartupFailureSinks {
  notify(notification: StartupFailurePresentation['notification']): void
  showErrorBox(title: string, content: string): void
  writeStderr(line: string): void
}

export type StartupFailureLogWriter = (path: string, content: string) => void

function normalizeCause(cause: unknown): { message: string; stack: string } {
  if (cause instanceof Error) {
    const message = cause.message === '' ? cause.name : cause.message
    return {
      message,
      stack: cause.stack ?? message,
    }
  }
  const message = String(cause)
  return { message, stack: message }
}

function recoveryLabel(recovery: StartupFailureRecovery): string {
  return recovery.kind === 'relaunch' ? `relaunch ${recovery.profileName}` : 'exit'
}

function recoverySentence(recovery: StartupFailureRecovery): string {
  return recovery.kind === 'relaunch'
    ? `DSH Desktop will reopen the last-known-good profile "${recovery.profileName}".`
    : 'DSH Desktop will close after this error.'
}

function sinkError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function createStartupFailureReport(
  cause: unknown,
  context: StartupFailureContext,
  now: Date = new Date(),
): StartupFailureReport {
  const normalized = normalizeCause(cause)
  return {
    ...context,
    timestamp: now.toISOString(),
    message: normalized.message,
    stack: normalized.stack,
  }
}

export function serializeStartupFailureReport(report: StartupFailureReport): string {
  return [
    'DSH Desktop startup failure',
    `timestamp: ${report.timestamp}`,
    `platform: ${report.platform}`,
    `profile: ${report.profileName}`,
    `log: ${report.logPath}`,
    `recovery: ${recoveryLabel(report.recovery)}`,
    `error: ${report.message}`,
    '',
    report.stack,
    '',
  ].join('\n')
}

export function buildStartupFailurePresentation(
  report: StartupFailureReport,
): StartupFailurePresentation {
  const recovery = report.recovery.kind === 'relaunch'
    ? `Reopening "${report.recovery.profileName}".`
    : 'The application will close.'
  return {
    notification: {
      title: STARTUP_FAILURE_TITLE,
      body: `Profile "${report.profileName}" failed to start. ${recovery}`,
    },
    dialog: {
      title: STARTUP_FAILURE_TITLE,
      content: [
        'DSH Desktop could not start.',
        '',
        `Profile: ${report.profileName}`,
        `Reason: ${report.message}`,
        recoverySentence(report.recovery),
        '',
        `Full diagnostics: ${report.logPath}`,
      ].join('\n'),
    },
  }
}

export function presentStartupFailure(
  report: StartupFailureReport,
  sinks: StartupFailureSinks,
): void {
  const presentation = buildStartupFailurePresentation(report)
  try {
    sinks.notify(presentation.notification)
  } catch (cause) {
    safelyWriteStderr(
      sinks,
      `dsh-plugin-desktop: failed to show startup failure notification: ${sinkError(cause)}\n`,
    )
  }
  try {
    sinks.showErrorBox(presentation.dialog.title, presentation.dialog.content)
  } catch (cause) {
    safelyWriteStderr(
      sinks,
      `dsh-plugin-desktop: failed to show startup failure dialog: ${sinkError(cause)}\n`,
    )
  }
}

function safelyWriteStderr(sinks: StartupFailureSinks, line: string): void {
  try {
    sinks.writeStderr(line)
  } catch {
    // A diagnostic sink must never mask the original startup failure.
  }
}

export function writeStartupFailureLog(
  report: StartupFailureReport,
  writer: StartupFailureLogWriter = (path, content) => writeFileSync(path, content, 'utf8'),
): unknown {
  try {
    writer(report.logPath, serializeStartupFailureReport(report))
    return undefined
  } catch (cause) {
    return cause
  }
}

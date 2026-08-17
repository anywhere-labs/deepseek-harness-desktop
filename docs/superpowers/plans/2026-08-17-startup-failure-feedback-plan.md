# Startup Failure Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface post-ready DSH Desktop startup failures through a system notification, a native error dialog, and a bounded diagnostic log without changing profile recovery decisions.

**Architecture:** Keep error normalization, report serialization, presentation text, and failure-tolerant sinks in an Electron-independent `startup-failure.ts` module. `main.ts` supplies the active profile, recovery decision, Electron log path, notification adapter, dialog adapter, and existing stderr path, then continues its current mark-failed/relaunch/shutdown flow.

**Tech Stack:** TypeScript, Electron 43 dialog/notification APIs, Node `fs`, Vitest 4, Yarn workspace scripts.

---

## File Map

- Create `dsh-plugin-desktop/src/startup-failure.ts`: typed report model, unknown-error normalization, log serialization, presentation text, and guarded notification/dialog sinks.
- Create `dsh-plugin-desktop/tests/startup-failure.spec.ts`: unit tests for report formatting, bounded log writing, and independent notification/dialog failure handling.
- Modify `dsh-plugin-desktop/src/main.ts`: import `dialog` and the report helpers; report the failure before state mutation; keep existing rollback and shutdown logic.

### Task 1: Write the failing startup-failure tests

**Files:**
- Create: `dsh-plugin-desktop/tests/startup-failure.spec.ts`

- [ ] **Step 1: Add the report contract tests**

Use the following public API in the test so the missing module fails clearly:

```ts
import { describe, expect, it, vi } from 'vitest'
import {
  buildStartupFailurePresentation,
  createStartupFailureReport,
  presentStartupFailure,
  serializeStartupFailureReport,
} from '../src/startup-failure.ts'

const context = {
  profileName: 'desktop',
  platform: 'win32',
  logPath: 'C:\\Users\\test\\AppData\\Roaming\\DSH Desktop\\logs\\dsh-plugin-desktop-startup.log',
  recovery: { kind: 'relaunch' as const, profileName: 'desktop' },
}

it('normalizes an unknown thrown value and records the complete stack', () => {
  const report = createStartupFailureReport(new Error('bad patch'), context, new Date('2026-08-17T13:00:00.000Z'))

  expect(report).toMatchObject({
    timestamp: '2026-08-17T13:00:00.000Z',
    profileName: 'desktop',
    message: 'bad patch',
    recovery: context.recovery,
  })
  expect(report.stack).toContain('bad patch')
})

it('serializes bounded context and stack for the latest startup log', () => {
  const report = createStartupFailureReport('bad patch', context, new Date('2026-08-17T13:00:00.000Z'))
  const text = serializeStartupFailureReport(report)
  const presentation = buildStartupFailurePresentation(report)

  expect(text).toContain('profile: desktop')
  expect(text).toContain('log: ' + context.logPath)
  expect(text).toContain('error: bad patch')
  expect(text).toContain('recovery: relaunch desktop')
  expect(presentation.dialog.content).toContain(context.logPath)
  expect(presentation.dialog.content).not.toContain(report.stack)
})
```

- [ ] **Step 2: Add the presentation and failure-isolation test**

The test must inject both sinks and make the notification sink throw. The dialog sink still has to run, proving the two user-visible channels are independent:

```ts
it('still attempts the dialog when notification presentation fails', () => {
  const report = createStartupFailureReport(new Error('bad patch'), context, new Date('2026-08-17T13:00:00.000Z'))
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
  const report = createStartupFailureReport(new Error('bad patch'), context, new Date('2026-08-17T13:00:00.000Z'))
  const notify = vi.fn()
  const showErrorBox = vi.fn(() => { throw new Error('dialog unavailable') })
  const writeStderr = vi.fn()

  presentStartupFailure(report, { notify, showErrorBox, writeStderr })

  expect(notify).toHaveBeenCalledOnce()
  expect(showErrorBox).toHaveBeenCalledOnce()
  expect(writeStderr).toHaveBeenCalledWith(expect.stringContaining('dialog unavailable'))
})
```

- [ ] **Step 3: Run the focused test and verify the RED failure**

Run:

```bash
yarn workspace dsh-plugin-desktop vitest run tests/startup-failure.spec.ts
```

Expected: FAIL because `src/startup-failure.ts` does not exist yet. Do not alter the test to make this failure pass.

### Task 2: Implement the Electron-independent failure report module

**Files:**
- Create: `dsh-plugin-desktop/src/startup-failure.ts`
- Test: `dsh-plugin-desktop/tests/startup-failure.spec.ts`

- [ ] **Step 1: Define the recovery and report types**

Implement these exact shapes:

```ts
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
```

- [ ] **Step 2: Implement normalization, serialization, and presentation builders**

Use `cause instanceof Error` for message/stack extraction. For non-Error values use `String(cause)` for both message and stack. Keep the log format line-oriented and overwrite-oriented; include timestamp, platform, profile, log path, recovery, message, a blank line, and the complete stack.

Use the fixed user-facing title `Unable to Start DSH Desktop`. The notification body must be one concise sentence. The dialog content must include the failed profile, error message, recovery sentence, and absolute log path, but not the full stack.

- [ ] **Step 3: Implement guarded presentation sinks**

Define:

```ts
export interface StartupFailureSinks {
  notify(notification: { title: string; body: string }): void
  showErrorBox(title: string, content: string): void
  writeStderr(line: string): void
}

export function presentStartupFailure(report: StartupFailureReport, sinks: StartupFailureSinks): void
```

Call `notify` and `showErrorBox` independently. Catch each sink error and send a concise diagnostic to `writeStderr`; never rethrow an error from a presentation sink.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
yarn workspace dsh-plugin-desktop vitest run tests/startup-failure.spec.ts
```

Expected: PASS with all startup-failure tests green.

### Task 3: Add bounded log writing and wire the bootstrap

**Files:**
- Modify: `dsh-plugin-desktop/src/startup-failure.ts`
- Modify: `dsh-plugin-desktop/src/main.ts`
- Test: `dsh-plugin-desktop/tests/startup-failure.spec.ts`

- [ ] **Step 1: Add the log writer test before wiring production code**

Extend the import from `../src/startup-failure.ts` with `writeStartupFailureLog` before adding this test:

Add this test before implementing the writer:

```ts
it('writes the latest report and returns writer failures instead of throwing', () => {
  const report = createStartupFailureReport(new Error('bad patch'), context, new Date('2026-08-17T13:00:00.000Z'))
  const writes: Array<{ path: string; content: string }> = []
  const writer = (path: string, content: string): void => { writes.push({ path, content }) }

  expect(writeStartupFailureLog(report, writer)).toBeUndefined()
  expect(writes).toEqual([{ path: context.logPath, content: serializeStartupFailureReport(report) }])

  const failure = writeStartupFailureLog(report, () => { throw new Error('disk full') })
  expect(failure).toEqual(expect.objectContaining({ message: 'disk full' }))
})
```

- [ ] **Step 2: Implement `writeStartupFailureLog`**

Add:

```ts
export type StartupFailureLogWriter = (path: string, content: string) => void

export function writeStartupFailureLog(
  report: StartupFailureReport,
  writer: StartupFailureLogWriter = (path, content) => writeFileSync(path, content, 'utf8'),
): unknown
```

Return `undefined` on success and the caught failure on write error. Do not create an unbounded append-only log.

- [ ] **Step 3: Import Electron dialog and helpers in `main.ts`**

Change the Electron import to include `dialog`, import the report helpers, and keep `BIN_NAME` as the stderr prefix. Do not move or rewrite the existing profile manager functions.

- [ ] **Step 4: Report before mutating profile state**

At the top of the existing `catch (cause)`:

1. Compute `retryLastKnownGood` from `profileStartup` and its persisted state.
2. Build the recovery union (`relaunch` with the last-known-good name, otherwise `exit`).
3. Resolve `join(app.getPath('logs'), 'dsh-plugin-desktop-startup.log')`.
4. Create the report and write the latest log.
5. Send any log-write failure to the existing stderr stream.
6. Call `presentStartupFailure` with `runtime.updates.notify`, `dialog.showErrorBox`, and a stderr sink.
7. Leave the existing `markDesktopProfileFailed`, relaunch request, exit code, and `shutdown.request` logic unchanged except for reusing the precomputed `retryLastKnownGood`.

Remove only the failure-branch call to `notifyProfileRecovery`; keep the successful `profileStartup.rolledBackFrom` notification after the native shell mounts.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
yarn workspace dsh-plugin-desktop vitest run tests/startup-failure.spec.ts tests/profile-manager.spec.ts tests/electron-runtime.spec.ts
yarn workspace dsh-plugin-desktop typecheck
```

Expected: all selected tests PASS and TypeScript exits with code 0.

### Task 4: Run package-wide verification and review the diff

**Files:**
- Verify: all files changed by Tasks 1-3

- [ ] **Step 1: Run the complete package test suite**

```bash
yarn workspace dsh-plugin-desktop test
```

- [ ] **Step 2: Run profile and loader smoke checks**

```bash
yarn workspace dsh-plugin-desktop verify:profile
yarn workspace dsh-plugin-desktop verify:loader
```

- [ ] **Step 3: Review source and staged diff**

Run `git diff --check`, inspect the complete diff for accidental local paths or full-stack UI leakage, and confirm the only production behavior change is startup failure reporting.

- [ ] **Step 4: Commit the implementation**

```bash
git add dsh-plugin-desktop/src/startup-failure.ts dsh-plugin-desktop/src/main.ts dsh-plugin-desktop/tests/startup-failure.spec.ts
git commit -m "fix(startup): surface profile boot failures"
```

Include the focused tests, typecheck, full test suite, and smoke checks in the handoff.

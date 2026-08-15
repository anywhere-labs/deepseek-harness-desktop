/**
 * Restricted-process spawning: anonymous pipes for stdio, STARTUPINFOW with
 * STARTF_USESTDHANDLES and STARTF_USESHOWWINDOW, CreateProcessAsUserW under the
 * restricted token, then asynchronous pipe draining and exit waiting. SW_HIDE
 * suppresses a visible child window while creation flags continue to omit
 * CREATE_NO_WINDOW / CREATE_NEW_CONSOLE, which break restricted children with
 * STATUS_DLL_INIT_FAILED (0xC0000142). Stdio remains pipe-based.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/spawn
 */

import { allocPtrSlot, allocProcessInfo, allocStartupInfo, allocUint32, decodePtr, decodeProcessInfo, decodeUint32, encodeStartupInfo, isNullPtr, throwLastError, throwWin32 } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import * as abi from './win32-abi.ts'

/**
 * Quote one argument per the CommandLineToArgvW parsing rules: backslashes
 * are doubled only before a quote character — including the closing quote
 * this function appends, so a trailing backslash run is doubled as well
 * (otherwise an odd run would escape the closing quote into a literal
 * character and corrupt the rest of the command line). Mirrors the CRT
 * ArgvQuote behavior Microsoft documents for command-line arguments.
 * @param argument - one argv entry to quote.
 * @returns the quoted entry (bare when quoting is unnecessary).
 */
export function quoteArg(argument: string): string {
  if (argument === '') return '""'
  if (!/[\s"]/u.test(argument)) return argument
  let quoted = '"'
  for (let index = 0; index < argument.length; index++) {
    let backslashes = 0
    while (index < argument.length && argument.charAt(index) === '\\') {
      backslashes++
      index++
    }
    if (index === argument.length) {
      // Trailing backslash run: doubled so it cannot escape the closing quote.
      quoted += '\\'.repeat(backslashes * 2)
    } else if (argument.charAt(index) === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"'
    } else {
      quoted += '\\'.repeat(backslashes) + argument.charAt(index)
    }
  }
  return quoted + '"'
}

/**
 * Build the single command line CreateProcess parses from program + argv.
 * @param program - the executable (argv[0]).
 * @param args - the remaining argv entries.
 * @returns the joined, quoted command line.
 */
export function buildCommandLine(program: string, args: readonly string[]): string {
  return [program, ...args].map(quoteArg).join(' ')
}

interface PipePair {
  read: NativePtr
  write: NativePtr
}

function createPipe(api: Win32Bindings): PipePair {
  const readSlot = allocPtrSlot()
  const writeSlot = allocPtrSlot()
  if (api.createPipe(readSlot, writeSlot, null, 0) === 0) throwLastError(api, 'CreatePipe')
  const read = decodePtr(readSlot)
  const write = decodePtr(writeSlot)
  if (read === null || write === null) throwLastError(api, 'CreatePipe', 'null pipe handle')
  return { read, write }
}

function setInheritable(api: Win32Bindings, handle: NativePtr, label: string): void {
  if (api.setHandleInformation(handle, abi.HANDLE_FLAG_INHERIT, abi.HANDLE_FLAG_INHERIT) === 0) {
    throwLastError(api, 'SetHandleInformation', label)
  }
}

/** A confined child spawned with piped stdio: process handle plus the pipe read ends to drain. */
export interface SpawnedNative {
  pid: number
  process: NativePtr
  stdoutRead: NativePtr
  stderrRead: NativePtr
}

/**
 * Create a process under the restricted token with piped stdio. The child's
 * stdin is closed immediately (EOF), matching the POC; stdout/stderr read ends
 * are returned for draining. The child inherits the caller's environment block
 * (lpEnvironment NULL); the caller rewrites entries through
 * SetEnvironmentVariableW before spawning (the runner's per-session temp
 * contract) — passing an explicit block through koffi trips
 * ERROR_INVALID_PARAMETER in CreateProcessAsUserW (verified empirically).
 * @param api - the binding table.
 * @param token - the restricted token the child runs under.
 * @param options - command, args, and working directory.
 * @returns the spawned child's handles.
 */
export function spawnSandboxed(
  api: Win32Bindings,
  token: NativePtr,
  options: { command: string; args: readonly string[]; cwd: string },
): SpawnedNative {
  const stdIn = createPipe(api)
  const stdOut = createPipe(api)
  const stdErr = createPipe(api)
  // Child side of each pipe must be inheritable (POC lines 262-268).
  setInheritable(api, stdIn.read, 'stdin read end')
  setInheritable(api, stdOut.write, 'stdout write end')
  setInheritable(api, stdErr.write, 'stderr write end')

  const startupInfo = allocStartupInfo()
  encodeStartupInfo(startupInfo, {
    cb: abi.STARTUPINFOW_SIZE,
    dwFlags: abi.STARTF_USESTDHANDLES | abi.STARTF_USESHOWWINDOW,
    wShowWindow: abi.SW_HIDE,
    hStdInput: stdIn.read,
    hStdOutput: stdOut.write,
    hStdError: stdErr.write,
  })

  const processInfo = allocProcessInfo()
  const commandLine = buildCommandLine(options.command, options.args)
  const created = api.createProcessAsUserW(
    token, null, commandLine,
    null, null,
    1, // bInheritHandles: required for redirection
    0, // no creation flags: suspended/no-window variants are unusable under the restriction
    null, options.cwd,
    startupInfo, processInfo,
  )
  // Capture the failure before CloseHandle calls clobber GetLastError, then
  // close every pipe handle created so far — the six-close contract this test
  // surface pins (tests/failure-paths.spec.ts).
  if (created === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(stdIn.read)
    api.closeHandle(stdIn.write)
    api.closeHandle(stdOut.read)
    api.closeHandle(stdOut.write)
    api.closeHandle(stdErr.read)
    api.closeHandle(stdErr.write)
    throwWin32(api, 'CreateProcessAsUserW', win32Code, `command: ${options.command}, cwd: ${options.cwd}`)
  }

  const info = decodeProcessInfo(processInfo)
  const processHandle = info.hProcess
  const threadHandle = info.hThread
  if (processHandle === null || threadHandle === null) {
    throw new Error(`CreateProcessAsUserW succeeded but returned null process/thread handles (pid ${info.dwProcessId})`)
  }

  // Host-side cleanup: child handles are now duplicated in the child; the
  // host closes its copies so ReadFile sees EOF when the child exits.
  api.closeHandle(stdIn.read)
  api.closeHandle(stdOut.write)
  api.closeHandle(stdErr.write)
  api.closeHandle(stdIn.write)
  api.closeHandle(threadHandle)

  return {
    pid: info.dwProcessId,
    process: processHandle,
    stdoutRead: stdOut.read,
    stderrRead: stdErr.read,
  }
}

/**
 * Drain one pipe read end to a Buffer via non-blocking PeekNamedPipe polling.
 * @param api - the binding table.
 * @param handle - the pipe read end to drain (closed when done).
 * @returns the complete pipe contents.
 */
export async function drainPipe(api: Win32Bindings, handle: NativePtr): Promise<Buffer> {
  const chunks: Buffer[] = []
  for (;;) {
    const bytesReadSlot = allocUint32()
    const totalAvailSlot = allocUint32()
    const leftThisMessageSlot = allocUint32()
    const peeked = api.peekNamedPipe(handle, null, 0, bytesReadSlot, totalAvailSlot, leftThisMessageSlot)
    if (peeked === 0) {
      const win32Code = api.getLastError()
      if (win32Code === abi.ERROR_BROKEN_PIPE || win32Code === abi.ERROR_NO_DATA) break // child closed its end: clean EOF
      throwLastError(api, 'PeekNamedPipe', `drain failure after ${chunks.length} chunk(s)`)
    }
    const available = decodeUint32(totalAvailSlot)
    if (available > 0) {
      const chunk = Buffer.alloc(available)
      const readSlot = allocUint32()
      if (api.readFile(handle, chunk, chunk.length, readSlot, null) === 0) {
        throwLastError(api, 'ReadFile', `drain failure after ${chunks.length} chunk(s)`)
      }
      chunks.push(chunk.subarray(0, decodeUint32(readSlot)))
    }
    // Small backoff instead of setImmediate: a bare next-tick would busy-poll
    // the pipe at full event-loop speed while the child produces no output.
    await new Promise<void>(resolve => setTimeout(resolve, 1))
  }
  api.closeHandle(handle)
  return Buffer.concat(chunks)
}

/**
 * Wait for process exit and return its exit code. Call only after both drains
 * have resolved — the drains finish when the child closed its pipe ends, i.e.
 * the child has already exited, so this wait returns immediately. Calling it
 * earlier would block the event loop and starve the drains (the pipe-buffer
 * deadlock the POC comments warn about).
 * @param api - the binding table.
 * @param process - the child process handle (closed when done).
 * @returns the child's exit code.
 */
export function waitForExit(api: Win32Bindings, process: NativePtr): number {
  const waitResult = api.waitForSingleObject(process, abi.INFINITE)
  if (waitResult === 0xFFFFFFFF) throwLastError(api, 'WaitForSingleObject')
  const exitCodeSlot = allocUint32()
  if (api.getExitCodeProcess(process, exitCodeSlot) === 0) throwLastError(api, 'GetExitCodeProcess')
  api.closeHandle(process)
  return decodeUint32(exitCodeSlot)
}

/**
 * Create a kill-on-close job object (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE at
 * LimitFlags offset 16 of JOBOBJECT_EXTENDED_LIMIT_INFORMATION, layout
 * verified by abi-probe.cpp). When the caller dies with the job handle open,
 * Windows terminates every process in the job — the orphan-child backstop.
 * The caller keeps the returned handle open for the child's lifetime.
 */
function createKillOnCloseJob(api: Win32Bindings): NativePtr {
  const job = api.createJobObjectW(null, null)
  if (isNullPtr(job)) throwLastError(api, 'CreateJobObjectW')
  const information = Buffer.alloc(abi.JOBOBJECT_EXTENDED_LIMIT_SIZE)
  information.writeUInt32LE(abi.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, abi.JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET)
  if (api.setInformationJobObject(job, abi.JobObjectExtendedLimitInformation, information, information.length) === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(job)
    throwWin32(api, 'SetInformationJobObject', win32Code)
  }
  return job
}

/** A confined child spawned with inherited stdio: process handle plus its kill-on-close job. */
export interface SpawnedInherited {
  pid: number
  process: NativePtr
  /** Kill-on-close job the child was placed in; caller closes it after the child exits. */
  job: NativePtr
}

/**
 * Create a process under the restricted token whose stdio passes straight
 * through to the caller's pipes. This is the runner shape: the harness spawns
 * the runner with piped stdio, and the runner's confined child writes to
 * those same pipes.
 *
 * Node clears the inheritability of its stdio handles at startup
 * (uv_disable_stdio_inheritance), so raw spawns must re-enable the inherit
 * bit around the call (libuv instead duplicates the handles; re-enabling is
 * equivalent here and cheaper) and pass them explicitly via
 * STARTF_USESTDHANDLES — otherwise the child receives INVALID std handles
 * ("The handle is invalid", verified the hard way). The child starts
 * suspended so it can be assigned to a kill-on-close job before it runs.
 * @param api - the binding table.
 * @param token - the restricted token the child runs under.
 * @param options - command, args, and working directory.
 * @returns the spawned child's handles and job.
 */
export function spawnSandboxedInherited(
  api: Win32Bindings,
  token: NativePtr,
  options: { command: string; args: readonly string[]; cwd: string },
): SpawnedInherited {
  const job = createKillOnCloseJob(api)
  const stdIn = api.getStdHandle(abi.STD_INPUT_HANDLE)
  const stdOut = api.getStdHandle(abi.STD_OUTPUT_HANDLE)
  const stdErr = api.getStdHandle(abi.STD_ERROR_HANDLE)
  if (isNullPtr(stdIn) || isNullPtr(stdOut) || isNullPtr(stdErr)) {
    api.closeHandle(job)
    throwLastError(api, 'GetStdHandle', 'null standard handle')
  }

  const makeInheritable = (handle: NativePtr, label: string): void => {
    if (api.setHandleInformation(handle, abi.HANDLE_FLAG_INHERIT, abi.HANDLE_FLAG_INHERIT) === 0) {
      throwLastError(api, 'SetHandleInformation', `${label} (enable inherit)`)
    }
  }
  const restoreInherit = (handle: NativePtr): void => {
    // Best-effort hygiene: the runner spawns nothing else; failures here must
    // not mask the child outcome, so the result is deliberately unchecked.
    api.setHandleInformation(handle, abi.HANDLE_FLAG_INHERIT, 0)
  }
  makeInheritable(stdIn, 'stdin')
  makeInheritable(stdOut, 'stdout')
  makeInheritable(stdErr, 'stderr')

  const startupInfo = allocStartupInfo()
  encodeStartupInfo(startupInfo, {
    cb: abi.STARTUPINFOW_SIZE,
    dwFlags: abi.STARTF_USESTDHANDLES | abi.STARTF_USESHOWWINDOW,
    wShowWindow: abi.SW_HIDE,
    hStdInput: stdIn,
    hStdOutput: stdOut,
    hStdError: stdErr,
  })

  const processInfo = allocProcessInfo()
  const commandLine = buildCommandLine(options.command, options.args)
  const created = api.createProcessAsUserW(
    token, null, commandLine,
    null, null,
    1, // bInheritHandles: the re-enabled std handles must be inheritable
    abi.CREATE_SUSPENDED, // suspended so job assignment precedes any execution
    null, options.cwd,
    startupInfo, processInfo,
  )
  restoreInherit(stdIn)
  restoreInherit(stdOut)
  restoreInherit(stdErr)
  if (created === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(job)
    throwWin32(api, 'CreateProcessAsUserW', win32Code, `command: ${options.command}, cwd: ${options.cwd}`)
  }

  const info = decodeProcessInfo(processInfo)
  const processHandle = info.hProcess
  const threadHandle = info.hThread
  if (processHandle === null || threadHandle === null) {
    api.closeHandle(job)
    throw new Error(`CreateProcessAsUserW succeeded but returned null process/thread handles (pid ${info.dwProcessId})`)
  }

  if (api.assignProcessToJobObject(job, processHandle) === 0) {
    // The child was created suspended and is NOT in the kill-on-close job:
    // closing handles would leave it suspended forever. Terminate it first,
    // then drop the handles and throw.
    const win32Code = api.getLastError()
    api.terminateProcess(processHandle, 1)
    api.closeHandle(threadHandle)
    api.closeHandle(processHandle)
    api.closeHandle(job)
    throwWin32(api, 'AssignProcessToJobObject', win32Code, `pid ${info.dwProcessId}`)
  }
  if (api.resumeThread(threadHandle) === 0xFFFFFFFF) {
    // Closing the job triggers kill-on-close, so the suspended child dies
    // instead of hanging until this process exits; the process/thread handles
    // must go too.
    const win32Code = api.getLastError()
    api.closeHandle(threadHandle)
    api.closeHandle(processHandle)
    api.closeHandle(job)
    throwWin32(api, 'ResumeThread', win32Code, `pid ${info.dwProcessId}`)
  }
  api.closeHandle(threadHandle)

  return { pid: info.dwProcessId, process: processHandle, job }
}

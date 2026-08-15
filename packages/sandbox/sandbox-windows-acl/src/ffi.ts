/**
 * Lazy koffi bindings for the Win32 ACL-sandbox backend. Koffi loads lazily so
 * non-Windows processes never open Win32 libraries. Every function signature
 * below was verified against the MinGW Windows headers on this machine
 * (winnt.h / accctrl.h / aclapi.h / securitybaseapi.h / sddl.h /
 * processthreadsapi.h / fileapi.h / namedpipeapi.h / synchapi.h / winbase.h);
 * struct layouts are asserted at load time against verify/abi-probe.cpp.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/ffi
 */

import koffi from 'koffi'
import { Win32Error } from './errors.ts'
import * as abi from './win32-abi.ts'

/** Branded koffi 3 native pointer. Koffi 3 pointers are BigInt values; the brand keeps them out of numeric contexts. */
declare const nativePtr: unique symbol
/** Koffi 3 native pointer (a BigInt address), branded so it cannot silently enter numeric contexts. */
export type NativePtr = bigint & { readonly [nativePtr]: true }

/**
 * True for NULL pointers, however koffi returns them (null or 0n).
 * @param value - a pointer as koffi may hand it back (pointer, null, or 0n).
 * @returns a type guard narrowing to the NULL shapes.
 */
export function isNullPtr(value: NativePtr | null | undefined): value is null | undefined {
  return value === null || value === undefined || (value as bigint) === 0n
}

/**
 * True for CreateFileW's INVALID_HANDLE_VALUE failure marker (-1, which
 * koffi hands back as the unsigned 64-bit all-ones pointer).
 * @param handle - the handle CreateFileW returned.
 * @returns whether the handle signals failure.
 */
export function isInvalidHandle(handle: NativePtr | null | undefined): boolean {
  if (isNullPtr(handle)) return true
  return (handle as bigint) === 0xFFFFFFFFFFFFFFFFn || (handle as bigint) === -1n
}

type Ptr = ReturnType<typeof koffi.pointer>

/** Field subset written into a zeroed STARTUPINFOW (layout verified: size 104). */
export interface StartupInfoInput {
  cb: number
  dwFlags: number
  wShowWindow: number
  hStdInput: NativePtr
  hStdOutput: NativePtr
  hStdError: NativePtr
}

/** Decoded PROCESS_INFORMATION (layout verified: size 24). */
export interface ProcessInfoOutput {
  hProcess: NativePtr | null
  hThread: NativePtr | null
  dwProcessId: number
  dwThreadId: number
}

/** The lazy koffi binding table: every Win32 call the ACL backend uses, signature-verified against the real headers. */
export interface Win32Bindings {
  // ---- process / token handles --------------------------------------------
  openProcess(desiredAccess: number, inheritHandle: number, pid: number): NativePtr
  openProcessToken(process: NativePtr, desiredAccess: number, tokenHandle: NativePtr): number
  closeHandle(handle: NativePtr): number
  // ---- errors / diagnostics ------------------------------------------------
  getLastError(): number
  formatMessageW(flags: number, source: null, messageId: number, languageId: number, buffer: Buffer, size: number, args: null): number
  // ---- memory --------------------------------------------------------------
  localAlloc(flags: number, bytes: number): NativePtr
  localFree(memory: NativePtr): NativePtr
  // ---- SIDs ----------------------------------------------------------------
  convertStringSidToSidW(stringSid: string, sid: NativePtr): number
  createWellKnownSid(type: number, domainSid: null, sid: NativePtr, size: NativePtr): number
  isValidSid(sid: NativePtr): number
  getLengthSid(sid: NativePtr): number
  copySid(length: number, destination: NativePtr, source: NativePtr): number
  // ---- token information ---------------------------------------------------
  getTokenInformation(token: NativePtr, cls: number, info: Buffer | null, length: number, needed: NativePtr): number
  setTokenInformation(token: NativePtr, cls: number, info: Buffer, length: number): number
  // ---- restricted token ----------------------------------------------------
  createRestrictedToken(
    existing: NativePtr, flags: number,
    disableCount: number, disableSids: null,
    deletePrivilegeCount: number, privilegesToDelete: null,
    restrictCount: number, restrictingSids: Buffer,
    newToken: NativePtr,
  ): number
  // ---- ACL editing ---------------------------------------------------------
  setEntriesInAclW(count: number, entries: Buffer, oldAcl: NativePtr | null, newAcl: NativePtr): number
  setNamedSecurityInfoW(
    path: string, objectType: number, information: number,
    owner: null, group: null, dacl: NativePtr | null, sacl: null,
  ): number
  getNamedSecurityInfoW(
    path: string, objectType: number, information: number,
    owner: NativePtr, group: NativePtr, dacl: NativePtr, sacl: NativePtr, descriptor: NativePtr,
  ): number
  // ---- environment / io ----------------------------------------------------
  getTempPathW(length: number, buffer: Buffer): number
  createFileW(
    fileName: string, desiredAccess: number, shareMode: number, attributes: null,
    creationDisposition: number, flagsAndAttributes: number, templateFile: null,
  ): NativePtr
  lockFileEx(file: NativePtr, flags: number, reserved: number, bytesLow: number, bytesHigh: number, overlapped: NativePtr): number
  unlockFileEx(file: NativePtr, reserved: number, bytesLow: number, bytesHigh: number, overlapped: NativePtr): number
  createPipe(readHandle: NativePtr, writeHandle: NativePtr, attributes: null, size: number): number
  setHandleInformation(handle: NativePtr, mask: number, flags: number): number
  createProcessAsUserW(
    token: NativePtr, applicationName: null, commandLine: string,
    processAttributes: null, threadAttributes: null,
    inheritHandles: number, creationFlags: number, environment: null,
    currentDirectory: string | null, startupInfo: NativePtr, processInfo: NativePtr,
  ): number
  setEnvironmentVariableW(name: string, value: string): number
  readFile(file: NativePtr, buffer: Buffer, count: number, bytesRead: NativePtr, overlapped: null): number
  peekNamedPipe(
    pipe: NativePtr, buffer: null, size: number,
    bytesRead: NativePtr, totalAvail: NativePtr, leftThisMessage: NativePtr,
  ): number
  waitForSingleObject(handle: NativePtr, milliseconds: number): number
  getExitCodeProcess(process: NativePtr, exitCode: NativePtr): number
  resumeThread(thread: NativePtr): number
  // ---- job object (runner kill-on-close) -----------------------------------
  createJobObjectW(attributes: null, name: null): NativePtr
  setInformationJobObject(job: NativePtr, cls: number, information: Buffer, length: number): number
  assignProcessToJobObject(job: NativePtr, process: NativePtr): number
  // Terminate a suspended child that could not be placed in the kill-on-close
  // job — closing handles alone would leave it hanging forever.
  terminateProcess(process: NativePtr, exitCode: number): number
  // ---- console -------------------------------------------------------------
  // HandlerRoutine=null + add=1 makes this process ignore CTRL+C (wincon.h):
  // the runner survives console Ctrl+C so the child handles its own and the
  // runner can clean up grants after the child exits.
  setConsoleCtrlHandler(handler: null, add: number): number
  getStdHandle(stdHandle: number): NativePtr
}

const PVOID: Ptr = koffi.pointer('void')
const PPVOID: Ptr = koffi.pointer(PVOID)

/** koffi STARTUPINFOW layout; its size is asserted against abi.STARTUPINFOW_SIZE at load. */
export const STARTUPINFOW = koffi.struct('STARTUPINFOW', {
  cb: 'uint32',
  lpReserved: 'str16',
  lpDesktop: 'str16',
  lpTitle: 'str16',
  dwX: 'uint32',
  dwY: 'uint32',
  dwXSize: 'uint32',
  dwYSize: 'uint32',
  dwXCountChars: 'uint32',
  dwYCountChars: 'uint32',
  dwFillAttribute: 'uint32',
  dwFlags: 'uint32',
  wShowWindow: 'uint16',
  cbReserved2: 'uint16',
  lpReserved2: koffi.pointer('uint8'),
  hStdInput: PVOID,
  hStdOutput: PVOID,
  hStdError: PVOID,
})

/** koffi PROCESS_INFORMATION layout; its size is asserted against abi.PROCESS_INFORMATION_SIZE at load. */
export const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', {
  hProcess: PVOID,
  hThread: PVOID,
  dwProcessId: 'uint32',
  dwThreadId: 'uint32',
})

/* v8 ignore start -- layout-mismatch guards fire only on ABI breakage; verify/abi-probe.cpp pins both sizes. */
if (STARTUPINFOW.size !== abi.STARTUPINFOW_SIZE) {
  throw new Error(`STARTUPINFOW layout mismatch: koffi computed ${STARTUPINFOW.size}, header probe says ${abi.STARTUPINFOW_SIZE}`)
}
if (PROCESS_INFORMATION.size !== abi.PROCESS_INFORMATION_SIZE) {
  throw new Error(`PROCESS_INFORMATION layout mismatch: koffi computed ${PROCESS_INFORMATION.size}, header probe says ${abi.PROCESS_INFORMATION_SIZE}`)
}
/* v8 ignore stop */

/**
 * Allocate one pointer-sized slot (for `T **` out-parameters).
 * @returns the allocated slot pointer.
 */
export function allocPtrSlot(): NativePtr {
  const value: unknown = koffi.alloc(PVOID, 1)
  return value as NativePtr
}

/**
 * Allocate one uint32 slot.
 * @returns the allocated slot pointer.
 */
export function allocUint32(): NativePtr {
  const value: unknown = koffi.alloc('uint32', 1)
  return value as NativePtr
}

/**
 * Write a uint32 value into a slot pointer.
 * @param slot - the slot allocated by {@link allocUint32}.
 * @param value - the uint32 to encode.
 */
export function encodeUint32(slot: NativePtr, value: number): void {
  koffi.encode(slot, 'uint32', value)
}

/**
 * Decode the pointer stored in a pointer-sized slot (NULL becomes null).
 * @param slot - the pointer-sized slot holding the out-parameter value.
 * @returns the decoded pointer, or null for NULL.
 */
export function decodePtr(slot: NativePtr): NativePtr | null {
  const value: unknown = koffi.decode(slot, PVOID)
  if (isNullPtr(value as NativePtr | null | undefined)) return null
  return value as NativePtr
}

/**
 * Decode a uint32 at a slot pointer.
 * @param slot - the uint32 slot holding the out-parameter value.
 * @returns the decoded uint32.
 */
export function decodeUint32(slot: NativePtr): number {
  const value: unknown = koffi.decode(slot, 'uint32')
  return value as number
}

/**
 * Cast a koffi pointer to its numeric address (bigint, used for raw struct packing).
 * @param ptr - the koffi pointer.
 * @returns the pointer's numeric address.
 */
export function ptrAddress(ptr: NativePtr): bigint {
  return koffi.address(ptr)
}

/**
 * Allocate a raw byte block (used for SID copies and variable-length arrays).
 * @param length - the block size in bytes.
 * @returns the allocated block pointer.
 */
export function allocBytes(length: number): NativePtr {
  const value: unknown = koffi.alloc('uint8', length)
  return value as NativePtr
}

/**
 * Allocate one zeroed OVERLAPPED (32 bytes on x64: Internal@0, InternalHigh@8,
 * Offset@16, OffsetHigh@20, hEvent@24). LockFileEx/UnlockFileEx receive this
 * instead of a NULL lpOverlapped: koffi 3.1.1 crashes on NULL there, and a
 * zeroed OVERLAPPED on a synchronous file handle is the documented equivalent
 * (the byte range locks from offset 0, hEvent stays NULL).
 * @returns the zeroed block pointer.
 */
export function allocOverlapped(): NativePtr {
  return allocBytes(32)
}

/**
 * Decode a pointer VALUE stored in memory at `buffer[offset]` (e.g. TOKEN_GROUPS entries).
 * @param buffer - the buffer holding the pointer value.
 * @param offset - byte offset of the pointer inside the buffer.
 * @returns the decoded pointer, or null for NULL.
 */
export function decodePtrAt(buffer: Buffer, offset: number): NativePtr | null {
  const value: unknown = koffi.decode(buffer, offset, PVOID)
  if (isNullPtr(value as NativePtr | null | undefined)) return null
  return value as NativePtr
}

/**
 * Decode a uint8 at a native pointer plus byte offset — the ACL walk's
 * field-read primitive (koffi.decode with an offset, no memcpy, no pointer
 * arithmetic).
 * @param ptr - the native pointer to read from.
 * @param offset - byte offset from the pointer.
 * @returns the decoded uint8.
 */
export function decodeUint8At(ptr: NativePtr, offset: number): number {
  const value: unknown = koffi.decode(ptr, offset, 'uint8')
  return value as number
}

/**
 * Decode a uint16 at a native pointer plus byte offset (see {@link decodeUint8At}).
 * @param ptr - the native pointer to read from.
 * @param offset - byte offset from the pointer.
 * @returns the decoded uint16.
 */
export function decodeUint16At(ptr: NativePtr, offset: number): number {
  const value: unknown = koffi.decode(ptr, offset, 'uint16')
  return value as number
}

/**
 * Decode a uint32 at a native pointer plus byte offset (see {@link decodeUint8At}).
 * @param ptr - the native pointer to read from.
 * @param offset - byte offset from the pointer.
 * @returns the decoded uint32.
 */
export function decodeUint32At(ptr: NativePtr, offset: number): number {
  const value: unknown = koffi.decode(ptr, offset, 'uint32')
  return value as number
}

/**
 * Compare two SIDs field-by-field via BOUNDED offset reads (revision, count,
 * identifier authority, subauthorities up to the count) — never a fixed-size
 * struct decode, which would read past a short SID allocation (a SID with
 * fewer than 8 subauthorities is smaller than `SID_STRUCT`). An implausible
 * subauthority count reads as unequal.
 * @param left - pointer to one SID (offset 0).
 * @param leftOffset - byte offset of the SID structure within `left`.
 * @param right - pointer to the other SID.
 * @param rightOffset - byte offset of the SID structure within `right`.
 * @returns whether the SIDs are identical.
 */
export function sameSidAt(left: NativePtr, leftOffset: number, right: NativePtr, rightOffset: number): boolean {
  const leftRevision = decodeUint8At(left, leftOffset)
  const rightRevision = decodeUint8At(right, rightOffset)
  if (leftRevision !== rightRevision) return false
  const leftCount = decodeUint8At(left, leftOffset + 1)
  const rightCount = decodeUint8At(right, rightOffset + 1)
  if (leftCount !== rightCount || leftCount > abi.SID_MAX_SUB_AUTHORITIES) return false
  for (let index = 0; index < 6; index++) {
    if (decodeUint8At(left, leftOffset + 2 + index) !== decodeUint8At(right, rightOffset + 2 + index)) return false
  }
  for (let index = 0; index < leftCount; index++) {
    if (decodeUint32At(left, leftOffset + 8 + index * 4) !== decodeUint32At(right, rightOffset + 8 + index * 4)) return false
  }
  return true
}

/**
 * Allocate a zeroed STARTUPINFOW.
 * @returns the allocated struct pointer.
 */
export function allocStartupInfo(): NativePtr {
  const value: unknown = koffi.alloc(STARTUPINFOW, 1)
  return value as NativePtr
}

/**
 * Write the stdio and window-display fields into a zeroed STARTUPINFOW.
 * @param startupInfo - the allocated STARTUPINFOW to encode into.
 * @param fields - the field subset to write.
 */
export function encodeStartupInfo(startupInfo: NativePtr, fields: StartupInfoInput): void {
  koffi.encode(startupInfo, STARTUPINFOW, fields)
}

/**
 * Allocate a zeroed PROCESS_INFORMATION.
 * @returns the allocated struct pointer.
 */
export function allocProcessInfo(): NativePtr {
  const value: unknown = koffi.alloc(PROCESS_INFORMATION, 1)
  return value as NativePtr
}

/**
 * Decode a PROCESS_INFORMATION after CreateProcessAsUserW.
 * @param processInfo - the PROCESS_INFORMATION filled by the spawn call.
 * @returns the decoded handle/id fields.
 */
export function decodeProcessInfo(processInfo: NativePtr): ProcessInfoOutput {
  const value: unknown = koffi.decode(processInfo, PROCESS_INFORMATION)
  return value as ProcessInfoOutput
}

let cached: Win32Bindings | undefined

function bindings(): Win32Bindings {
  if (cached !== undefined) return cached
  const kernel32 = koffi.load('kernel32.dll')
  const advapi32 = koffi.load('advapi32.dll')

  // Each binding shape is verified by verify/abi-probe.cpp against the real
  // Windows headers and exercised end-to-end by tests/probe.spec.ts; the
  // single cast keeps the per-binding noise out of this table.
  const bind = (lib: ReturnType<typeof koffi.load>, name: string, result: Ptr | string, args: Array<Ptr | string>): unknown =>
    lib.func('__stdcall', name, result, args)

  cached = {
    openProcess: bind(kernel32, 'OpenProcess', PVOID, ['uint32', 'int', 'uint32']),
    openProcessToken: bind(advapi32, 'OpenProcessToken', 'int', [PVOID, 'uint32', PPVOID]),
    closeHandle: bind(kernel32, 'CloseHandle', 'int', [PVOID]),
    getLastError: bind(kernel32, 'GetLastError', 'uint32', []),
    formatMessageW: bind(kernel32, 'FormatMessageW', 'uint32', ['uint32', PVOID, 'uint32', 'uint32', PVOID, 'uint32', PVOID]),
    localAlloc: bind(kernel32, 'LocalAlloc', PVOID, ['uint32', 'size_t']),
    localFree: bind(kernel32, 'LocalFree', PVOID, [PVOID]),
    convertStringSidToSidW: bind(advapi32, 'ConvertStringSidToSidW', 'int', ['str16', PPVOID]),
    createWellKnownSid: bind(advapi32, 'CreateWellKnownSid', 'int', ['int', PVOID, PVOID, koffi.pointer('uint32')]),
    isValidSid: bind(advapi32, 'IsValidSid', 'int', [PVOID]),
    getLengthSid: bind(advapi32, 'GetLengthSid', 'uint32', [PVOID]),
    copySid: bind(advapi32, 'CopySid', 'int', ['uint32', PVOID, PVOID]),
    getTokenInformation: bind(advapi32, 'GetTokenInformation', 'int', [PVOID, 'int', PVOID, 'uint32', koffi.pointer('uint32')]),
    setTokenInformation: bind(advapi32, 'SetTokenInformation', 'int', [PVOID, 'int', PVOID, 'uint32']),
    createRestrictedToken: bind(advapi32, 'CreateRestrictedToken', 'int', [PVOID, 'uint32', 'uint32', PVOID, 'uint32', PVOID, 'uint32', PVOID, PPVOID]),
    setEntriesInAclW: bind(advapi32, 'SetEntriesInAclW', 'uint32', ['uint32', PVOID, PVOID, PPVOID]),
    setNamedSecurityInfoW: bind(advapi32, 'SetNamedSecurityInfoW', 'uint32', ['str16', 'int', 'uint32', PVOID, PVOID, PVOID, PVOID]),
    getNamedSecurityInfoW: bind(advapi32, 'GetNamedSecurityInfoW', 'uint32', ['str16', 'int', 'uint32', PPVOID, PPVOID, PPVOID, PPVOID, PPVOID]),
    getTempPathW: bind(kernel32, 'GetTempPathW', 'uint32', ['uint32', PVOID]),
    // fileapi.h line ~64: HANDLE CreateFileW(LPCWSTR, DWORD, DWORD,
    // LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE).
    createFileW: bind(kernel32, 'CreateFileW', PVOID, ['str16', 'uint32', 'uint32', PVOID, 'uint32', 'uint32', PVOID]),
    // fileapi.h lines ~177/~185: BOOL LockFileEx(HANDLE, DWORD, DWORD, DWORD,
    // DWORD, LPOVERLAPPED); BOOL UnlockFileEx(HANDLE, DWORD, DWORD, DWORD,
    // LPOVERLAPPED). lpOverlapped is NULL for synchronous locking.
    lockFileEx: bind(kernel32, 'LockFileEx', 'int', [PVOID, 'uint32', 'uint32', 'uint32', 'uint32', PVOID]),
    unlockFileEx: bind(kernel32, 'UnlockFileEx', 'int', [PVOID, 'uint32', 'uint32', 'uint32', PVOID]),
    createPipe: bind(kernel32, 'CreatePipe', 'int', [PPVOID, PPVOID, PVOID, 'uint32']),
    setHandleInformation: bind(kernel32, 'SetHandleInformation', 'int', [PVOID, 'uint32', 'uint32']),
    createProcessAsUserW: bind(advapi32, 'CreateProcessAsUserW', 'int', [
      PVOID, 'str16', 'str16', PVOID, PVOID, 'int', 'uint32', PVOID, 'str16',
      koffi.pointer(STARTUPINFOW), koffi.pointer(PROCESS_INFORMATION),
    ]),
    setEnvironmentVariableW: bind(kernel32, 'SetEnvironmentVariableW', 'int', ['str16', 'str16']),
    readFile: bind(kernel32, 'ReadFile', 'int', [PVOID, PVOID, 'uint32', koffi.pointer('uint32'), PVOID]),
    peekNamedPipe: bind(kernel32, 'PeekNamedPipe', 'int', [PVOID, PVOID, 'uint32', koffi.pointer('uint32'), koffi.pointer('uint32'), koffi.pointer('uint32')]),
    waitForSingleObject: bind(kernel32, 'WaitForSingleObject', 'uint32', [PVOID, 'uint32']),
    getExitCodeProcess: bind(kernel32, 'GetExitCodeProcess', 'int', [PVOID, koffi.pointer('uint32')]),
    resumeThread: bind(kernel32, 'ResumeThread', 'uint32', [PVOID]),
    createJobObjectW: bind(kernel32, 'CreateJobObjectW', PVOID, [PVOID, 'str16']),
    setInformationJobObject: bind(kernel32, 'SetInformationJobObject', 'int', [PVOID, 'int', PVOID, 'uint32']),
    assignProcessToJobObject: bind(kernel32, 'AssignProcessToJobObject', 'int', [PVOID, PVOID]),
    terminateProcess: bind(kernel32, 'TerminateProcess', 'int', [PVOID, 'uint32']),
    setConsoleCtrlHandler: bind(kernel32, 'SetConsoleCtrlHandler', 'int', [PVOID, 'int']),
    getStdHandle: bind(kernel32, 'GetStdHandle', PVOID, ['int']),
  } as unknown as Win32Bindings
  return cached
}

/**
 * Resolve the lazy Win32 bindings (throws the first binding failure, fail-closed).
 * @returns the cached binding table.
 */
export function win32(): Promise<Win32Bindings> {
  return Promise.resolve(bindings())
}

/**
 * Resolve the lazy Win32 bindings SYNCHRONOUSLY — the sandbox seam's
 * server-side per-session grant materializes ACEs inside the synchronous
 * `confine()` call, which cannot await. Same cached table as {@link win32}
 * (the underlying koffi loads are synchronous; the async wrapper exists for
 * the runner's await-shaped call sites).
 * @returns the cached binding table.
 */
export function win32Sync(): Win32Bindings {
  return bindings()
}

/**
 * Turn a Win32 error code into readable text via FormatMessageW.
 * @param api - the binding table.
 * @param win32Code - the error code to format.
 * @returns the formatted message text, or '' when formatting fails.
 */
export function errorText(api: Win32Bindings, win32Code: number): string {
  const buffer = Buffer.alloc(1024)
  const length = api.formatMessageW(
    abi.FORMAT_MESSAGE_FROM_SYSTEM | abi.FORMAT_MESSAGE_IGNORE_INSERTS,
    null, win32Code, 0, buffer, buffer.length / 2, null,
  )
  if (length === 0) return ''
  return buffer.subarray(0, length * 2).toString('utf16le').trim()
}

/**
 * Read the process temp directory via GetTempPathW (fileapi.h line ~188).
 * Defensive against an overlong system temp path: GetTempPathW reports the
 * REQUIRED length (including NUL) without writing the buffer when it is too
 * small, so a reported length beyond the buffer's capacity means the buffer
 * was never filled and must not be decoded.
 * @param api - the binding table.
 * @returns the NUL-terminated temp path decoded as a string.
 */
export function getTempPath(api: Win32Bindings): string {
  const buffer = Buffer.alloc((abi.MAX_PATH + 1) * 2)
  const length = api.getTempPathW(buffer.length / 2, buffer)
  if (length === 0) throwLastError(api, 'GetTempPathW')
  if (length > buffer.length / 2) {
    throw new Win32Error('GetTempPathW', abi.ERROR_INSUFFICIENT_BUFFER, `required ${length} chars exceed the ${buffer.length / 2}-char buffer; nothing was written`)
  }
  return buffer.subarray(0, length * 2).toString('utf16le')
}

/**
 * Throw a Win32Error for a BOOL-style API failure. MUST be called immediately
 * after the failed call so GetLastError is not clobbered by other Win32 calls.
 * @param api - the binding table.
 * @param name - the failed API's name for the error message.
 * @param detail - optional detail overriding the formatted system message.
 * @returns never — always throws.
 */
export function throwLastError(api: Win32Bindings, name: string, detail?: string): never {
  const win32Code = api.getLastError()
  throw new Win32Error(name, win32Code, detail ?? errorText(api, win32Code))
}

/**
 * Throw a Win32Error for an HRESULT-style API return value (the value IS the error code).
 * @param api - the binding table.
 * @param name - the failed API's name for the error message.
 * @param win32Code - the API's returned error code.
 * @param detail - optional detail overriding the formatted system message.
 * @returns never — always throws.
 */
export function throwWin32(api: Win32Bindings, name: string, win32Code: number, detail?: string): never {
  throw new Win32Error(name, win32Code, detail ?? errorText(api, win32Code))
}

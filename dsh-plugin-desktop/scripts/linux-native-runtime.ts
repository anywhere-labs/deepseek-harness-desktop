/** Prepare Linux native modules for Electron packaging without a source rebuild. */

import { chmodSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ELF_HEADER_BYTES = 20
const ELF_CLASS_64 = 2
const ELF_LITTLE_ENDIAN = 1
const ELF_MACHINE_X86_64 = 62
const NODE_API_REGISTRATION = Buffer.from('napi_register_module_v1')

/** Native addon produced by Yarn's approved node-pty build. */
export const LINUX_X64_NODE_PTY_SOURCE = 'node_modules/node-pty/build/Release/pty.node'

/** Stable node-pty path selected by its runtime loader and included by Electron Builder. */
export const LINUX_X64_NODE_PTY_DESTINATION = 'node_modules/node-pty/prebuilds/linux-x64/pty.node'

/** Injectable native-runtime preparation boundary. */
export interface LinuxNativeRuntimeOptions {
  /** Desktop package containing node-pty. */
  readonly desktopRoot: string
  /** Read a native-addon candidate. */
  readonly read: (path: string) => Buffer
  /** Create the stable prebuild directory. */
  readonly mkdir: (path: string) => void
  /** Copy the generated addon into the stable prebuild directory. */
  readonly copy: (source: string, destination: string) => void
  /** Set deterministic runtime permissions. */
  readonly chmod: (path: string, mode: number) => void
}

function validateLinuxX64NodePtyAddon(addon: Buffer, path: string): void {
  if (
    addon.byteLength < ELF_HEADER_BYTES
    || !addon.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    || addon[4] !== ELF_CLASS_64
    || addon[5] !== ELF_LITTLE_ENDIAN
    || addon.readUInt16LE(18) !== ELF_MACHINE_X86_64
  ) {
    throw new Error(`Linux node-pty addon is not a little-endian x86-64 ELF file: ${path}`)
  }
  if (!addon.includes(NODE_API_REGISTRATION)) {
    throw new Error(`Linux node-pty addon does not expose the stable Node-API entrypoint: ${path}`)
  }
}

function defaultOptions(desktopRoot: string): LinuxNativeRuntimeOptions {
  return {
    desktopRoot,
    read: path => readFileSync(path),
    mkdir: path => mkdirSync(path, { recursive: true }),
    copy: copyFileSync,
    chmod: chmodSync,
  }
}

/**
 * Validate and stage node-pty's Linux x64 Node-API addon under its stable loader path.
 * @param options - Desktop root and injectable filesystem operations.
 */
export function prepareLinuxNativeRuntime(
  options: LinuxNativeRuntimeOptions,
): void {
  const source = join(options.desktopRoot, LINUX_X64_NODE_PTY_SOURCE)
  const destination = join(options.desktopRoot, LINUX_X64_NODE_PTY_DESTINATION)
  let packagedAddon: Buffer | undefined
  try {
    packagedAddon = options.read(destination)
  } catch {
    // Some node-pty installs produce only build/Release; stage that output below.
  }
  if (packagedAddon !== undefined) {
    validateLinuxX64NodePtyAddon(packagedAddon, destination)
    options.chmod(destination, 0o755)
    return
  }

  let addon: Buffer
  try {
    addon = options.read(source)
  } catch (cause) {
    throw new Error(
      `Linux x64 node-pty addon is unavailable at both loader and build paths: ${destination}, ${source}`,
      { cause },
    )
  }

  validateLinuxX64NodePtyAddon(addon, source)

  options.mkdir(dirname(destination))
  options.copy(source, destination)
  options.chmod(destination, 0o755)
}

/** Prepare the native runtime rooted at the desktop package. */
export function prepareLinuxNativeRuntimeAt(desktopRoot: string): void {
  prepareLinuxNativeRuntime(defaultOptions(desktopRoot))
}

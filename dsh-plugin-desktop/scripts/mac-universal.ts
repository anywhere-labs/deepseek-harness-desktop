/** Shared preparation and verification inventory for universal macOS packages. */

import { chmodSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type MacUniversalArch = 'arm64' | 'x86_64'

/** Thin native files that must be present for each CPU inside app.asar.unpacked. */
export const MACOS_UNIVERSAL_NATIVE_ENTRIES = [
  {
    arch: 'arm64',
    path: 'node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.3.node',
  },
  {
    arch: 'arm64',
    path: 'node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.3.dylib',
  },
  {
    arch: 'arm64',
    path: 'node_modules/@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node',
  },
  {
    arch: 'arm64',
    path: 'node_modules/@vscode/ripgrep-darwin-arm64/bin/rg',
  },
  {
    arch: 'arm64',
    path: 'node_modules/node-addon-require-builtin-darwin-arm64/prebuilt/darwin-arm64-napi-v9.node',
  },
  {
    arch: 'arm64',
    path: 'node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
  },
  {
    arch: 'arm64',
    path: 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  },
  {
    arch: 'x86_64',
    path: 'node_modules/@img/sharp-darwin-x64/lib/sharp-darwin-x64-0.35.3.node',
  },
  {
    arch: 'x86_64',
    path: 'node_modules/@img/sharp-libvips-darwin-x64/lib/libvips-cpp.8.18.3.dylib',
  },
  {
    arch: 'x86_64',
    path: 'node_modules/@koromix/koffi-darwin-x64/darwin_x64/koffi.node',
  },
  {
    arch: 'x86_64',
    path: 'node_modules/@vscode/ripgrep-darwin-x64/bin/rg',
  },
  {
    arch: 'x86_64',
    path: 'node_modules/node-addon-require-builtin-darwin-x64/prebuilt/darwin-x64-napi-v9.node',
  },
  {
    arch: 'x86_64',
    path: 'node_modules/node-pty/prebuilds/darwin-x64/pty.node',
  },
  {
    arch: 'x86_64',
    path: 'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper',
  },
] as const satisfies readonly { readonly arch: MacUniversalArch; readonly path: string }[]

/** Generated host-architecture files that must never shadow the prebuilt pair. */
export const FORBIDDEN_MACOS_UNIVERSAL_ENTRIES = [
  'node_modules/node-pty/build/Release/pty.node',
  'node_modules/node-pty/build/Release/spawn-helper',
] as const

/** Injectable filesystem seam for source-runtime preparation. */
export interface MacUniversalPreparationOptions {
  readonly desktopRoot: string
  readonly exists: (path: string) => boolean
  readonly chmod: (path: string, mode: number) => void
}

/**
 * Validate both CPU runtime trees and restore node-pty helper execute bits.
 * Yarn intentionally disables lifecycle scripts, so the package step owns this
 * deterministic permission repair for both architectures.
 * @param options - Desktop root and injectable filesystem operations.
 */
export function prepareMacUniversalRuntime(
  options: MacUniversalPreparationOptions,
): void {
  const root = resolve(options.desktopRoot)
  const missing = MACOS_UNIVERSAL_NATIVE_ENTRIES
    .map(entry => join(root, entry.path))
    .filter(path => !options.exists(path))
  if (missing.length > 0) {
    throw new Error(
      `universal macOS runtime is missing ${String(missing.length)} native file(s): ${missing.join(', ')}`,
    )
  }

  for (const entry of MACOS_UNIVERSAL_NATIVE_ENTRIES) {
    if (entry.path.endsWith('/spawn-helper')) {
      options.chmod(join(root, entry.path), 0o755)
    }
  }
}

/** Prepare the installed workspace dependency tree for universal packaging. */
export function prepareInstalledMacUniversalRuntime(desktopRoot: string): void {
  prepareMacUniversalRuntime({ desktopRoot, exists: existsSync, chmod: chmodSync })
}

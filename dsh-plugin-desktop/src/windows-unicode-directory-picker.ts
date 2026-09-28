/** Unicode-safe Windows directory picker isolated from Electron's path conversion. */

import { execFile } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { desktopWindowsPwshPath } from './windows-pwsh-sandbox.ts'

const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'
const DIALOG_TITLE = 'DSH_DIALOG_TITLE'

const PICK_DIRECTORY_SCRIPT = String.raw`
Add-Type -AssemblyName System.Windows.Forms
$dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
$dialog.Description = $env:DSH_DIALOG_TITLE
$dialog.ShowNewFolderButton = $true
$dialog.AutoUpgradeEnabled = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  $bytes = [System.Text.Encoding]::Unicode.GetBytes($dialog.SelectedPath)
  [Console]::Out.Write([System.Convert]::ToBase64String($bytes))
}
`

interface PickerProcessOptions {
  readonly env: NodeJS.ProcessEnv
  readonly windowsHide: boolean
}

interface PickerProcessResult {
  readonly stdout: string
  readonly stderr: string
}

type RunPickerProcess = (
  executable: string,
  args: readonly string[],
  options: PickerProcessOptions,
) => Promise<PickerProcessResult>

function defaultPowerShellPath(): string {
  const executable = desktopWindowsPwshPath(process.env, 'win32')
  if (executable === undefined) throw new Error('Windows Unicode directory picker could not find PowerShell')
  return executable
}

async function runPickerProcess(
  executable: string,
  args: readonly string[],
  options: PickerProcessOptions,
): Promise<PickerProcessResult> {
  return await new Promise((resolve, reject) => {
    execFile(executable, [...args], {
      ...options,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        const detail = stderr.trim()
        reject(new Error(`Windows Unicode directory picker failed: ${detail === '' ? error.message : detail}`))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/** Remove Electron Node mode and pass the localized title through the Unicode Windows environment block. */
export function windowsUnicodePickerEnvironment(
  source: NodeJS.ProcessEnv,
  title: string,
): NodeJS.ProcessEnv {
  const env = { ...source }
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === RUN_AS_NODE) delete env[key]
  }
  env[DIALOG_TITLE] = title
  return env
}

/**
 * Open a WinForms folder chooser and return its path through an ASCII-only carrier.
 * PowerShell encodes the UTF-16 path as Base64 so the active console code page is irrelevant.
 */
export async function pickWindowsUnicodeDirectory(
  title: string,
  executable: string = defaultPowerShellPath(),
  run: RunPickerProcess = runPickerProcess,
): Promise<string | null> {
  const encodedCommand = Buffer.from(PICK_DIRECTORY_SCRIPT, 'utf16le').toString('base64')
  const result = await run(executable, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-STA',
    '-EncodedCommand',
    encodedCommand,
  ], {
    env: windowsUnicodePickerEnvironment(process.env, title),
    windowsHide: true,
  })
  const encodedPath = result.stdout.trim()
  if (encodedPath === '') return null
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encodedPath)) {
    throw new Error('Windows Unicode directory picker returned an invalid Base64 path')
  }
  const bytes = Buffer.from(encodedPath, 'base64')
  if (bytes.length % 2 !== 0) throw new Error('Windows Unicode directory picker returned an invalid UTF-16 path')
  const path = bytes.toString('utf16le')
  if (path.length === 0) throw new Error('Windows Unicode directory picker returned an empty path')
  return path
}

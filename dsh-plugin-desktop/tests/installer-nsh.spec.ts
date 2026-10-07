import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DESKTOP_INSTALLER_QUIT_FLAG } from '../src/desktop-installer-quit.ts'

describe('Windows NSIS running-app handoff', () => {
  it('checks for the exact app before requesting orderly shutdown', () => {
    const script = readFileSync(join(process.cwd(), 'build', 'installer.nsh'), 'utf8')
    const firstDetection = script.indexOf('!insertmacro FIND_PROCESS')
    const request = script.indexOf(DESKTOP_INSTALLER_QUIT_FLAG)
    const wait = script.indexOf('dsh_installer_wait_for_exit:')
    const fallback = script.indexOf('dsh_installer_scoped_fallback:')

    expect(script).toContain('!macro customCheckAppRunning')
    expect(script).toContain('Var pid')
    expect(script).toContain('ExecWait')
    expect(script).toContain('$INSTDIR\\${APP_EXECUTABLE_FILENAME}')
    expect(script).toContain('!insertmacro IS_POWERSHELL_AVAILABLE')
    expect(firstDetection).toBeGreaterThanOrEqual(0)
    expect(request).toBeGreaterThan(firstDetection)
    expect(wait).toBeGreaterThan(request)
    expect(fallback).toBeGreaterThan(wait)
  })

  it('waits for graceful disposal before using the scoped builder fallback', () => {
    const script = readFileSync(join(process.cwd(), 'build', 'installer.nsh'), 'utf8')

    expect(script).toContain('$R1 < 120')
    expect(script).toContain('Sleep 500')
    expect(script).toContain('!insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 0')
    expect(script).toContain('!insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 1')
    expect(script).not.toContain('taskkill')
    expect(script).not.toContain('nsProcess::KillProcess')
    expect(script).not.toContain('getProcessInfo.nsh')
  })
})

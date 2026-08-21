import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DESKTOP_QUIT_FLAG } from '../src/desktop-quit-flag.ts'

describe('Windows NSIS running-app check', () => {
  it('asks the running instance to quit, then force-kills the process tree', () => {
    const script = readFileSync(join(process.cwd(), 'build', 'installer.nsh'), 'utf8')

    expect(script).toContain('!macro customCheckAppRunning')
    expect(script).toContain(DESKTOP_QUIT_FLAG)
    expect(script).toContain('taskkill.exe')
    expect(script).toContain('/F /T /IM "${APP_EXECUTABLE_FILENAME}"')
    expect(script).not.toContain('cmd.exe')
  })
})

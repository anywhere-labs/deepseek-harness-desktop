import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

describe('Windows native directory picker patch', () => {
  it('avoids Electron-incompatible external buffers in the published worker', () => {
    const workerPath = require.resolve('@deepseek-ai/dsh-host-directory-picker-native/worker')
    const workerSource = readFileSync(workerPath, 'utf8')

    expect(workerSource).not.toMatch(/Buffer\.from\(koffi\.view\(/u)
    expect(workerSource).toMatch(/koffi\.decode\.string16\(address\)/u)
  })

  it('decodes UTF-16 pointers inside Electron run-as-node', () => {
    const electronPath: unknown = require('electron')
    if (typeof electronPath !== 'string') throw new TypeError('electron did not export its executable path')
    const script = [
      "const koffi = require('koffi')",
      "const expected = 'C:\\\\workspaces\\\\\u6d4b\u8bd5'",
      "const bytes = Buffer.from(expected + '\\0', 'utf16le')",
      'const actual = koffi.decode.string16(koffi.address(bytes))',
      'if (actual !== expected) throw new Error(`decoded ${JSON.stringify(actual)}`)',
    ].join(';')
    const result = spawnSync(electronPath, ['--eval', script], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      shell: false,
    })

    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr || result.stdout).toBe(0)
  })
})

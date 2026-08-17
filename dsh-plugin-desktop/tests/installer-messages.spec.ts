import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

describe('Windows assisted installer messages', () => {
  it('sets a clearer message for the slow install stage', () => {
    const messages = parse(readFileSync(join(process.cwd(), 'build', 'assistedMessages.yml'), 'utf8')) as {
      installing?: Record<string, string>
    }

    expect(messages.installing?.zh_CN).toBe('DSH Desktop 正在安装，可能需要几分钟；请保持此窗口打开。')
    expect(messages.installing?.en).toContain('This may take several minutes')
  })
})

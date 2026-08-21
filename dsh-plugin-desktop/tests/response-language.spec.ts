import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it } from 'vitest'
import {
  registerResponseLanguage,
  RESPONSE_LANGUAGE_SECTION,
  responseLanguagePrompt,
} from '../src/response-language.ts'
import type { DesktopLocale } from '../src/runtime.ts'

describe('Desktop response language', () => {
  it('projects the live locale into main-agent and subagent prompt assemblies', async () => {
    const ctx = new Context()
    let locale: DesktopLocale = 'zh'
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.inject(['systemPrompt'], promptCtx => {
        registerResponseLanguage(promptCtx, () => locale)
      })
    }, {}))
    await ctx.plugin(SystemPrompt)
    const childKey = { agent: 'subagent' }
    const child = createScope(ctx, childKey)

    const mainSection = (await ctx.systemPrompt.assemble()).sections
      .find(section => section.name === RESPONSE_LANGUAGE_SECTION)
    const childSection = (await ctx.systemPrompt.assemble({ scope: childKey })).sections
      .find(section => section.name === RESPONSE_LANGUAGE_SECTION)
    expect(mainSection?.text).toBe(responseLanguagePrompt('zh'))
    expect(childSection?.text).toBe(responseLanguagePrompt('zh'))

    locale = 'en'
    const switchedChildSection = (await ctx.systemPrompt.assemble({ scope: childKey })).sections
      .find(section => section.name === RESPONSE_LANGUAGE_SECTION)
    expect(switchedChildSection?.text).toBe(responseLanguagePrompt('en'))

    await fiber.dispose()
    expect((await ctx.systemPrompt.assemble({ scope: childKey })).sections)
      .not.toContainEqual(expect.objectContaining({ name: RESPONSE_LANGUAGE_SECTION }))
    await child.dispose()
  })
})

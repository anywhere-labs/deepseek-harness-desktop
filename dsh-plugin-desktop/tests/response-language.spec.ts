import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it } from 'vitest'
import {
  registerResponseLanguage,
  RESPONSE_LANGUAGE_SECTION,
  ResponseLanguageSettingsSchema,
  responseLanguagePrompt,
  type ResponseLanguagePreference,
} from '../src/response-language.ts'

describe('Desktop response language', () => {
  it('defaults to automatic language selection and validates explicit choices', () => {
    expect(ResponseLanguageSettingsSchema({} as never)).toEqual({ responseLanguage: 'auto' })
    expect(responseLanguagePrompt('auto')).toBe('')
    expect(responseLanguagePrompt('zh')).toContain('中文')
    expect(responseLanguagePrompt('en')).toContain('English')
    expect(() => ResponseLanguageSettingsSchema({ responseLanguage: 'fr' } as never)).toThrow()
  })

  it('projects the live explicit preference into main-agent and subagent assemblies', async () => {
    const ctx = new Context()
    let preference: ResponseLanguagePreference = 'auto'
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.inject(['systemPrompt'], promptCtx => {
        registerResponseLanguage(promptCtx, () => preference)
      })
    }, {}))
    await ctx.plugin(SystemPrompt)
    const childKey = { agent: 'subagent' }
    const child = createScope(ctx, childKey)

    const automaticSection = (await ctx.systemPrompt.assemble()).sections
      .find(section => section.name === RESPONSE_LANGUAGE_SECTION)
    expect(automaticSection?.text).toBe('')

    preference = 'zh'
    const mainSection = (await ctx.systemPrompt.assemble()).sections
      .find(section => section.name === RESPONSE_LANGUAGE_SECTION)
    const childSection = (await ctx.systemPrompt.assemble({ scope: childKey })).sections
      .find(section => section.name === RESPONSE_LANGUAGE_SECTION)
    expect(mainSection?.text).toBe(responseLanguagePrompt('zh'))
    expect(childSection?.text).toBe(responseLanguagePrompt('zh'))

    preference = 'en'
    const switchedChildSection = (await ctx.systemPrompt.assemble({ scope: childKey })).sections
      .find(section => section.name === RESPONSE_LANGUAGE_SECTION)
    expect(switchedChildSection?.text).toBe(responseLanguagePrompt('en'))

    await fiber.dispose()
    expect((await ctx.systemPrompt.assemble({ scope: childKey })).sections)
      .not.toContainEqual(expect.objectContaining({ name: RESPONSE_LANGUAGE_SECTION }))
    await child.dispose()
  })
})

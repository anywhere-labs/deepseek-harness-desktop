/** Model response-language guidance derived from the active Desktop locale. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { DesktopLocale } from './runtime.ts'

/** Stable prompt-section name shared by main-agent and subagent assemblies. */
export const RESPONSE_LANGUAGE_SECTION = 'desktop:response-language'

/** Prompt order after the deployment persona and before tool guidance. */
export const RESPONSE_LANGUAGE_ORDER = 20

const RESPONSE_LANGUAGE_PROMPTS: Record<DesktopLocale, string> = {
  zh: '除非用户明确要求其他语言，否则所有解释、进度说明和最终答复都使用中文。代码、标识符、命令、文件路径和直接引用保持原样。',
  en: 'Unless the user explicitly requests another language, use English for all explanations, progress updates, and final answers. Preserve code, identifiers, commands, file paths, and direct quotations as written.',
}

/**
 * Resolve the model instruction for one Desktop locale.
 * @param locale - active locale shared by the Web client and native shell.
 * @returns the response-language instruction added to the system prompt.
 */
export function responseLanguagePrompt(locale: DesktopLocale): string {
  return RESPONSE_LANGUAGE_PROMPTS[locale]
}

/**
 * Register live response-language guidance for every agent scope.
 * @param ctx - Desktop Host context carrying the system-prompt registry.
 * @param readLocale - returns the currently active Desktop locale.
 */
export function registerResponseLanguage(ctx: Context, readLocale: () => DesktopLocale): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: RESPONSE_LANGUAGE_SECTION,
    order: RESPONSE_LANGUAGE_ORDER,
    text: () => responseLanguagePrompt(readLocale()),
  }), 'desktop-shell.response-language')
}

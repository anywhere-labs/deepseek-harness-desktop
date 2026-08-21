/** Explicit model response-language preference, independent of the interface locale. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Durable Host settings namespace owned by the Desktop agent preference. */
export const RESPONSE_LANGUAGE_SETTINGS_NAMESPACE = settingsNamespace('dsh-desktop-agent')

/** Available response-language preferences. */
export const RESPONSE_LANGUAGE_PREFERENCES = ['auto', 'zh', 'en'] as const

/** One explicit response-language preference. */
export type ResponseLanguagePreference = typeof RESPONSE_LANGUAGE_PREFERENCES[number]

/** Host settings read by prompt assembly and the Desktop settings page. */
export interface ResponseLanguageSettings {
  /** Preferred language, or `auto` to leave language choice to the conversation. */
  responseLanguage: ResponseLanguagePreference
}

/** Durable response-language settings schema. */
export const ResponseLanguageSettingsSchema: z<ResponseLanguageSettings> = z.object({
  responseLanguage: z.union([...RESPONSE_LANGUAGE_PREFERENCES]).default('auto'),
})

/** Stable prompt-section name shared by main-agent and subagent assemblies. */
export const RESPONSE_LANGUAGE_SECTION = 'desktop:response-language'

/** Prompt order after the deployment persona and before tool guidance. */
export const RESPONSE_LANGUAGE_ORDER = 20

const RESPONSE_LANGUAGE_PROMPTS: Record<ResponseLanguagePreference, string> = {
  auto: '',
  zh: '用户已在 DSH Desktop 中明确选择中文作为代理回复语言。除非用户在当前会话中明确要求其他语言，否则所有解释、进度说明和最终答复都使用中文。代码、标识符、命令、文件路径和直接引用保持原样。',
  en: 'The user explicitly selected English as the agent response language in DSH Desktop. Unless the user explicitly requests another language in the current conversation, use English for all explanations, progress updates, and final answers. Preserve code, identifiers, commands, file paths, and direct quotations as written.',
}

/**
 * Resolve the model instruction for one explicit preference.
 * @param preference - user-selected response language.
 * @returns the response-language instruction, or empty text for automatic choice.
 */
export function responseLanguagePrompt(preference: ResponseLanguagePreference): string {
  return RESPONSE_LANGUAGE_PROMPTS[preference]
}

/**
 * Register live explicit response-language guidance for every agent scope.
 * @param ctx - Desktop Host context carrying the system-prompt registry.
 * @param readPreference - returns the current durable response-language preference.
 */
export function registerResponseLanguage(
  ctx: Context,
  readPreference: () => ResponseLanguagePreference,
): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: RESPONSE_LANGUAGE_SECTION,
    order: RESPONSE_LANGUAGE_ORDER,
    text: () => responseLanguagePrompt(readPreference()),
  }), 'desktop-shell.response-language')
}

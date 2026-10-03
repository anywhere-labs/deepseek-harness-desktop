import type { AuthorizationMethod, AuthorizationNotice, AuthorizationPromptOption } from '@deepseek-ai/dsh-authorization/types'

export const DESKTOP_COPILOT_AUTHORIZATION_PATH = '/api/desktop/copilot-authorization'
export const DESKTOP_COPILOT_AUTHORIZATION_BEGIN_PATH = `${DESKTOP_COPILOT_AUTHORIZATION_PATH}/begin`
export const DESKTOP_COPILOT_AUTHORIZATION_ANSWER_PATH = `${DESKTOP_COPILOT_AUTHORIZATION_PATH}/answer`
export const DESKTOP_COPILOT_AUTHORIZATION_CANCEL_PATH = `${DESKTOP_COPILOT_AUTHORIZATION_PATH}/cancel`
export const DESKTOP_COPILOT_AUTHORIZATION_MODELS_PATH = `${DESKTOP_COPILOT_AUTHORIZATION_PATH}/models`

export interface DesktopCopilotAuthorizationModelsResponse {
  readonly models: readonly { readonly id: string, readonly category?: string, readonly highCost?: boolean }[]
  readonly configured: boolean
}

export type DesktopCopilotAuthorizationPhase = 'idle' | 'authorizing' | 'authorized' | 'cancelled' | 'failed'

export interface DesktopCopilotAuthorizationPrompt {
  readonly id: string
  readonly kind: 'text' | 'secret' | 'select'
  readonly message: string
  readonly placeholder?: string
  readonly options?: readonly AuthorizationPromptOption[]
}

export interface DesktopCopilotAuthorizationView {
  readonly available: boolean
  readonly configured: boolean
  readonly phase: DesktopCopilotAuthorizationPhase
  readonly canCancel: boolean
  readonly methods: readonly AuthorizationMethod[]
  readonly notice?: AuthorizationNotice
  readonly prompt?: DesktopCopilotAuthorizationPrompt
  readonly error?: string
}

export interface DesktopCopilotAuthorizationAnswer {
  readonly promptId: string
  readonly answer: string
}

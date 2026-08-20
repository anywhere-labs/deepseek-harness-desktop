/** Desktop-owned settings namespace shared by the host and client faces. */

import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** Namespace holding desktop shell preferences (mode, port, logLevel, closeBehavior). */
export const DESKTOP_SETTINGS_NAMESPACE: SettingsNamespace = 'dsh-desktop' as SettingsNamespace

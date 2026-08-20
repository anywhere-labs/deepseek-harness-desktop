/** Desktop-owned settings namespace shared by the host and client faces. */

import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** Namespace holding desktop shell preferences (mode, port, logLevel, closeBehavior). */
export const DESKTOP_SETTINGS_NAMESPACE = settingsNamespace('dsh-desktop')

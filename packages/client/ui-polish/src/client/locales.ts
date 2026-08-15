/** `polish` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'polish': '润色',
  'polishing': '润色中…',
  'polish.aria': '润色并扩展输入内容',
  'error.session-not-found': '会话不可用，请稍后重试',
  'error.message-blank': '输入内容为空',
  'error.message-too-long': '输入内容过长，请精简后重试',
  'error.no-result': '没有获得润色结果，请重试',
  'error.polish-session-failed': '润色失败：{message}',
  'error.raw': '{code}: {message}',
} satisfies Record<string, string>

/** The polish namespace key union. */
export type PolishKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'polish': 'Polish',
  'polishing': 'Polishing…',
  'polish.aria': 'Polish and expand the input',
  'error.session-not-found': 'Session unavailable, try again later',
  'error.message-blank': 'Input is empty',
  'error.message-too-long': 'Input is too long, shorten it and retry',
  'error.no-result': 'No polish result, retry',
  'error.polish-session-failed': 'Polish failed: {message}',
  'error.raw': '{code}: {message}',
} satisfies Record<PolishKey, string>

/** `rollback` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'action.aria': '回退到此消息',
  'confirm.title': '回退到此消息',
  'confirm.description': '将删除此消息及其后的所有内容，恢复此前的会话上下文。',
  'confirm.code': '同时回退代码（撤销此后的文件改动）',
  'confirm.cancel': '取消',
  'confirm.accept': '回退',
  'confirm.close': '关闭',
  'result.ok': '已回退，会话恢复到更早状态',
  'result.codeReverted': '已撤销 {count} 处代码改动',
  'result.codeFailures': '{count} 处代码改动未能回退',
  'error.session-not-found': '会话不可用，请稍后重试',
  'error.message-seq-out-of-range': '消息已不在当前会话中',
  'error.no-turn': '无法定位此消息所在的回合',
  'error.rewind-failed': '回退失败：{message}',
  'error.raw': '{code}: {message}',
} satisfies Record<string, string>

/** The rollback namespace key union. */
export type RollbackKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'action.aria': 'Roll back to this message',
  'confirm.title': 'Roll back to this message',
  'confirm.description': 'Deletes this message and everything after it, restoring the earlier session context.',
  'confirm.code': 'Also roll back code (undo the file changes made after this point)',
  'confirm.cancel': 'Cancel',
  'confirm.accept': 'Roll back',
  'confirm.close': 'Close',
  'result.ok': 'Rolled back; the session restored to an earlier state',
  'result.codeReverted': '{count} code change(s) undone',
  'result.codeFailures': '{count} code change(s) could not be undone',
  'error.session-not-found': 'Session unavailable, try again later',
  'error.message-seq-out-of-range': 'The message is no longer in the current session',
  'error.no-turn': 'Could not locate the turn this message belongs to',
  'error.rewind-failed': 'Rollback failed: {message}',
  'error.raw': '{code}: {message}',
} satisfies Record<RollbackKey, string>

// MessageText is the literal-text primitive for user and steering content; assistant output uses MarkdownText.

import css from './MessageText.module.css'
import { textDirection } from './text-direction.ts'

export function MessageText({ text }: { text: string }) {
  return <div className={css.text} dir={textDirection(text)}>{text}</div>
}

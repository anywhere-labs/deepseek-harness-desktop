/** Bounded UTF-8 line assembly keeps credentials split across pipe chunks redactable. */
import { StringDecoder } from 'node:string_decoder'
import { diagnosticLog, developerLoggingEnabled } from './developer-logging.ts'
export function createProcessOutputLogging(stream: 'stdout' | 'stderr', pid: () => number | undefined) {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let truncated = false
  let closed = false
  let interval = Date.now()
  let count = 0
  const emit = () => {
    if (!pending) return
    if (stream === 'stdout' && !developerLoggingEnabled()) return
    if (Date.now() - interval >= 1000) { interval = Date.now(); count = 0 }
    if (++count > 100) {
      if (count === 101) diagnosticLog({ source: `host.${stream}`, event: 'output.rate-limited', level: 'warn' })
      return
    }
    diagnosticLog({ source: `host.${stream}`, event: 'output', level: stream === 'stderr' ? 'warn' : 'info',
      message: pending, developer: stream === 'stdout', fields: { hostPid: pid(), truncated } })
  }
  const consume = (text: string) => {
    const parts = text.split('\n')
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!
      const available = 16384 - pending.length
      pending += part.slice(0, available)
      truncated ||= part.length > available
      if (i < parts.length - 1) { emit(); pending = ''; truncated = false }
    }
  }
  return {
    write(data: Buffer): void { if (!closed) consume(decoder.write(data)) },
    end(): void { if (closed) return; closed = true; consume(decoder.end()); emit(); pending = '' },
  }
}

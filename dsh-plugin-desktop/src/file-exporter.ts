import { Logger, type Exporter, type Message } from '@deepseek-ai/cordis'
import { shouldEmit, type LogLevel } from './log-level.ts'
import { LogFileSink } from './log-files.ts'

function localTimestamp(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

/** Cordis exporter that forwards formatted messages to a `LogFileSink`. */
export class FileExporter implements Exporter {
  formatters = {}
  maxLength = 10240
  // Cordis filters by `levels` before calling `export` (default INFO=1 would drop warn=2
  // and debug=3). Pass everything through and let `shouldEmit` own the threshold.
  levels = { default: 3 }

  constructor(
    private readonly sink: LogFileSink,
    private threshold: LogLevel = 'info',
  ) {}

  /** Update the verbosity threshold in place on a hot-reloaded setting change. */
  setThreshold(level: LogLevel): void {
    this.threshold = level
  }

  export(message: Message): void {
    if (!shouldEmit(message.type, this.threshold)) return
    this.sink.write(message.type, this.render(message))
  }

  /** Close the underlying sink (used by tests and shutdown). */
  close(): void {
    this.sink.close()
  }

  private render(message: Message): string {
    const level = message.type.charAt(0).toUpperCase()
    const body = Logger.format(this, message)
    return `${localTimestamp(message.ts)} [${level}] [${message.name}] ${body}`
  }
}

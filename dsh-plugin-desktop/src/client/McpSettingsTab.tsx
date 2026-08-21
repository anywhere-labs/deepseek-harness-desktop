import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  DESKTOP_MCP_SERVER_TEMPLATES,
  desktopMcpServerFromTemplate,
  parseDesktopMcpSettings,
  type DesktopMcpServerSettings,
  type DesktopMcpServerTemplate,
  type DesktopMcpSettings,
} from '../mcp-settings.ts'
import type { DesktopLocaleKey } from './locales.ts'

export interface McpSettingsTabInjected {
  readonly scope: SettingsScope<DesktopMcpSettings>
}

export type McpSettingsTabProps = PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'dsh-desktop'>
  & InjectFace<McpSettingsTabInjected>

function templateLabel(id: string): DesktopLocaleKey {
  if (id === 'filesystem') return 'mcpTemplateFilesystem'
  if (id === 'custom-http') return 'mcpTemplateHttp'
  return 'mcpTemplateStdio'
}

function lines(value: string): string[] {
  return value.split('\n').map(line => line.trim()).filter(line => line.length > 0)
}

function formatPairs(record: Record<string, string>, separator: string): string {
  return Object.entries(record).map(([key, value]) => `${key}${separator}${value}`).join('\n')
}

function parsePairs(text: string, separator: '=' | ':'): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of lines(text)) {
    const index = line.indexOf(separator)
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (key.length > 0) result[key] = value
  }
  return result
}

function createId(): string {
  return globalThis.crypto.randomUUID()
}

function uniqueServerName(base: string, servers: readonly DesktopMcpServerSettings[]): string {
  const taken = new Set(servers.map(server => server.serverName))
  if (!taken.has(base)) return base
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}${String(index)}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}${createId().slice(0, 6)}`
}

export function McpSettingsTab({ scope, t }: McpSettingsTabProps): ReactNode {
  const snapshot = useSyncExternalStore(listener => scope.subscribe(listener), () => scope.getSnapshot())
  const remoteServers = snapshot.value?.servers ?? []
  const [draft, setDraft] = useState<DesktopMcpServerSettings[] | undefined>(undefined)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const servers = draft ?? remoteServers

  const setServers = (next: DesktopMcpServerSettings[]): void => {
    setDraft(next)
    setStatus('idle')
  }

  const addTemplate = (template: DesktopMcpServerTemplate): void => {
    const created = desktopMcpServerFromTemplate(template, createId())
    setServers([...servers, { ...created, serverName: uniqueServerName(created.serverName, servers) }])
  }

  const update = (id: string, patch: Partial<DesktopMcpServerSettings>): void => {
    setServers(servers.map(server => server.id === id ? { ...server, ...patch } : server))
  }

  const save = (): void => {
    setStatus('saving')
    try {
      const parsed = parseDesktopMcpSettings({ servers })
      void scope.set('servers', parsed.servers).then(
        () => {
          setDraft(undefined)
          setStatus('saved')
        },
        () => { setStatus('error') },
      )
    } catch {
      setStatus('error')
    }
  }

  const templates = useMemo(() => DESKTOP_MCP_SERVER_TEMPLATES, [])

  if (snapshot.status === 'loading') return <p className="dshMcpLead">{t('mcpLoading')}</p>
  if (snapshot.status === 'unavailable' || !snapshot.writable) {
    return <p className="dshMcpLead">{t('mcpUnavailable')}</p>
  }

  return (
    <section className="dshMcpRoot">
      <div className="dshMcpSection">
        <h2>{t('mcpTitle')}</h2>
        <p className="dshMcpLead">{t('mcpBody')}</p>
      </div>
      <div className="dshMcpActions">
        {templates.map(template => (
          <button
            key={template.id}
            type="button"
            className="dshWorkerButton dshWorkerButtonSecondary"
            onClick={() => addTemplate(template)}
          >
            {t('mcpAddTemplate')}: {t(templateLabel(template.id))}
          </button>
        ))}
      </div>
      {servers.length === 0 ? <p className="dshMcpLead">{t('mcpEmpty')}</p> : null}
      {servers.map(server => (
        <article key={server.id} className="dshMcpCard">
          <div className="dshMcpFieldRow">
            <label className="dshMcpField">
              <span>{t('mcpEnabled')}</span>
              <input
                type="checkbox"
                checked={server.enabled}
                onChange={event => update(server.id, { enabled: event.target.checked })}
              />
            </label>
            <label className="dshMcpField">
              <span>{t('mcpServerName')}</span>
              <input
                value={server.serverName}
                onChange={event => update(server.id, { serverName: event.target.value })}
              />
            </label>
            <label className="dshMcpField">
              <span>{t('mcpTransport')}</span>
              <select
                value={server.transport}
                onChange={event => update(server.id, {
                  transport: event.target.value === 'streamable-http' ? 'streamable-http' : 'stdio',
                })}
              >
                <option value="stdio">stdio</option>
                <option value="streamable-http">streamable-http</option>
              </select>
            </label>
          </div>
          {server.transport === 'stdio' ? (
            <>
              <label className="dshMcpField">
                <span>{t('mcpCommand')}</span>
                <input
                  value={server.command}
                  onChange={event => update(server.id, { command: event.target.value })}
                />
              </label>
              <label className="dshMcpField">
                <span>{t('mcpArgs')}</span>
                <textarea
                  value={server.args.join('\n')}
                  onChange={event => update(server.id, { args: lines(event.target.value) })}
                />
              </label>
              <label className="dshMcpField">
                <span>{t('mcpCwd')}</span>
                <input
                  value={server.cwd}
                  onChange={event => update(server.id, { cwd: event.target.value })}
                />
              </label>
              <label className="dshMcpField">
                <span>{t('mcpEnv')}</span>
                <textarea
                  value={formatPairs(server.env, '=')}
                  onChange={event => update(server.id, { env: parsePairs(event.target.value, '=') })}
                />
              </label>
            </>
          ) : (
            <>
              <label className="dshMcpField">
                <span>{t('mcpUrl')}</span>
                <input
                  value={server.url}
                  onChange={event => update(server.id, { url: event.target.value })}
                />
              </label>
              <label className="dshMcpField">
                <span>{t('mcpHeaders')}</span>
                <textarea
                  value={formatPairs(server.headers, ': ')}
                  onChange={event => update(server.id, { headers: parsePairs(event.target.value.replaceAll(': ', ':'), ':') })}
                />
              </label>
            </>
          )}
          <div className="dshMcpActions">
            <button
              type="button"
              className="dshWorkerButton dshWorkerButtonSecondary"
              onClick={() => setServers(servers.filter(entry => entry.id !== server.id))}
            >
              {t('mcpRemove')}
            </button>
          </div>
        </article>
      ))}
      <div className="dshMcpActions">
        <button
          type="button"
          className="dshWorkerButton"
          disabled={status === 'saving'}
          onClick={save}
        >
          {status === 'saving' ? t('mcpSaving') : t('mcpSave')}
        </button>
      </div>
      {status === 'saved' ? <p className="dshMcpStatus" data-tone="ok">{t('mcpSaved')}</p> : null}
      {status === 'error' ? <p className="dshMcpStatus" data-tone="error">{t('mcpSaveError')}</p> : null}
    </section>
  )
}

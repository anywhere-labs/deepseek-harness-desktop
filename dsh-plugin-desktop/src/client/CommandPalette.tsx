import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  collectPaletteCommands,
  isPaletteToggleEvent,
  type PaletteCommand,
} from '../command-palette.ts'
import type { DesktopLocaleKey } from './locales.ts'

export interface CommandPaletteInjected {
  readonly sessions: ClientContext['sessions']
  readonly workspaces: ClientContext['workspaces']
}

export type CommandPaletteProps = PropsLocale<'dsh-desktop'>
  & InjectFace<CommandPaletteInjected>

function builtInTitle(id: string, t: CommandPaletteProps['t']): string | undefined {
  if (id === 'session.new') return t('paletteNewSession')
  if (id === 'session.fork') return t('paletteForkSession')
  if (id === 'session.search') return t('paletteSearchSessions')
  return undefined
}

/** Additive shell.overlay occupant. It never replaces the official conversation surface. */
export function CommandPalette({ sessions, workspaces, t }: CommandPaletteProps): ReactNode {
  const sessionList = useSyncExternalStore(
    listener => sessions.list.subscribe(listener),
    () => sessions.list.getSnapshot(),
  )
  const workspaceList = useSyncExternalStore(
    listener => workspaces.list.subscribe(listener),
    () => workspaces.list.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isPaletteToggleEvent(event)) {
        event.preventDefault()
        setOpen(current => !current)
        return
      }
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const commands = useMemo(() => collectPaletteCommands({
    sessions: sessionList.ids.map((id) => {
      const row = sessionList.byId[id]
      return {
        id,
        displayTitle: row?.displayTitle ?? id,
        blank: row?.blank === true,
      }
    }),
    workspaces: workspaceList.items.map((workspace) => {
      const row = workspace as { id: string; title?: string; name?: string }
      return { id: row.id, title: row.title ?? row.name ?? row.id }
    }),
    ...(sessionList.current === undefined ? {} : { currentSessionId: sessionList.current }),
    query,
    onNewSession: (workspaceId) => { workspaces.startSession(workspaceId) },
    onOpenSession: (sessionId) => { sessions.open(sessionId) },
    onForkSession: async (sessionId) => {
      const child = await sessions.fork({ sessionId })
      sessions.open(child)
    },
    onSearch: async (search) => {
      try {
        const result = await sessions.search(search, new AbortController().signal) as {
          readonly value?: { readonly items?: readonly { readonly sessionId: string }[] }
          readonly items?: readonly { readonly sessionId: string }[]
        }
        const first = result.value?.items?.[0] ?? result.items?.[0]
        if (first !== undefined) sessions.open(first.sessionId)
      } catch {
        return
      }
    },
  }), [query, sessionList, sessions, workspaceList, workspaces])

  if (!open) return null

  const run = (command: PaletteCommand): void => {
    setOpen(false)
    setQuery('')
    void command.run()
  }

  return (
    <div className="dshPaletteRoot" role="dialog" aria-modal="true" aria-label={t('paletteSearch')}>
      <div className="dshPaletteBackdrop" onClick={() => setOpen(false)} />
      <div className="dshPalettePanel">
        <input
          className="dshPaletteInput"
          autoFocus
          value={query}
          placeholder={t('paletteSearch')}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && commands[0] !== undefined) {
              event.preventDefault()
              run(commands[0])
            }
          }}
        />
        <ul className="dshPaletteList">
          {commands.length === 0 ? <li className="dshPaletteEmpty">{t('paletteEmpty')}</li> : null}
          {commands.map(command => (
            <li key={command.id}>
              <button type="button" className="dshPaletteItem" onClick={() => run(command)}>
                {builtInTitle(command.id, t) ?? command.title}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export type { DesktopLocaleKey }

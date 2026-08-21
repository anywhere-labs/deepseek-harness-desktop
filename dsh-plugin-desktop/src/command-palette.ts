/** Command-palette rows. The overlay only calls existing session and workspace actions. */

/** One actionable row shown in the Mod+K overlay. */
export interface PaletteCommand {
  readonly id: string
  readonly title: string
  readonly group: 'session' | 'workspace' | 'search'
  readonly keywords: readonly string[]
  readonly run: () => void | Promise<void>
}

/** Session list facts the palette can navigate without owning conversation. */
export interface PaletteSessionRow {
  readonly id: string
  readonly displayTitle: string
  readonly blank: boolean
}

/** Workspace list facts used by New Session and recent-workspace commands. */
export interface PaletteWorkspaceRow {
  readonly id: string
  readonly title: string
}

export interface PaletteCommandInput {
  readonly sessions: readonly PaletteSessionRow[]
  readonly workspaces: readonly PaletteWorkspaceRow[]
  readonly currentSessionId?: string
  readonly query: string
  readonly onNewSession: (workspaceId?: string) => void
  readonly onOpenSession: (sessionId: string) => void
  readonly onForkSession: (sessionId: string) => void | Promise<void>
  readonly onSearch: (query: string) => void | Promise<void>
}

function matches(query: string, title: string, keywords: readonly string[]): boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return true
  return title.toLowerCase().includes(needle)
    || keywords.some(keyword => keyword.toLowerCase().includes(needle))
}

/**
 * Build the overlay command list from live session and workspace snapshots.
 * The official conversation surface stays in place; these rows only navigate.
 */
export function collectPaletteCommands(input: PaletteCommandInput): PaletteCommand[] {
  const commands: PaletteCommand[] = [
    {
      id: 'session.new',
      title: 'New session',
      group: 'session',
      keywords: ['new', 'session', 'chat'],
      run: () => { input.onNewSession() },
    },
  ]
  if (input.currentSessionId !== undefined) {
    const currentId = input.currentSessionId
    commands.push({
      id: 'session.fork',
      title: 'Fork current session',
      group: 'session',
      keywords: ['fork', 'duplicate', 'session'],
      run: () => input.onForkSession(currentId),
    })
  }
  const query = input.query.trim()
  if (query.length > 0) {
    commands.push({
      id: 'session.search',
      title: `Search sessions for “${query}”`,
      group: 'search',
      keywords: ['search', 'find', query],
      run: () => input.onSearch(query),
    })
  }
  for (const session of input.sessions) {
    if (session.blank) continue
    commands.push({
      id: `session.open.${session.id}`,
      title: session.displayTitle,
      group: 'session',
      keywords: [session.id, session.displayTitle],
      run: () => { input.onOpenSession(session.id) },
    })
  }
  for (const workspace of input.workspaces) {
    commands.push({
      id: `workspace.session.${workspace.id}`,
      title: `New session in ${workspace.title}`,
      group: 'workspace',
      keywords: [workspace.title, workspace.id, 'workspace'],
      run: () => { input.onNewSession(workspace.id) },
    })
  }
  return commands.filter(command => matches(input.query, command.title, command.keywords))
}

/** True for the desktop Command Palette chord: Cmd/Ctrl+K, ignoring repeats. */
export function isPaletteToggleEvent(event: {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly repeat: boolean
}): boolean {
  if (event.repeat || event.altKey) return false
  if (event.key.toLowerCase() !== 'k') return false
  return event.metaKey || event.ctrlKey
}

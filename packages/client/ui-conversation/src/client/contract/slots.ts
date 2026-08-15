/** Conversation slot declarations and their composed component props. */
import type { ReactNode, RefObject } from 'react'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  InjectFace, MaybeSnapshotSelectorHook, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
  SlotHookFactory, SnapshotSelectorHook,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {
  CommandNode, CompactionSummaryNode, ConversationSnapshot, ConversationTurnDataMap,
  ObservableSnapshot, PendingInteraction, PendingWait, SessionId, ToolCallBlock,
  TurnLocation, WorkspaceId,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ComposerBlock } from '../input/blocks.ts'
import type {
  ComposerKeyboard, DraftAttachmentId, EditSelection, InputActions, InputNotice, InputState,
} from '../input/contract.ts'
import type { createChatStore } from '../stores.ts'
import type { ComposerSubmitGesture, InputSubmitMode } from './composer-submission.ts'
import type { ChatNode, ChatNodeKind } from './chat-nodes.ts'
import type { CallId, SelectionTarget, ViewTab } from './views.ts'

/** Browser-owned image that has not crossed the durable host boundary. */
export interface ComposerAttachment {
  kind: 'image'
  id: DraftAttachmentId
  file: File
  previewUrl: string
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The entire body of one session: taking this seat means rendering that
     * session's conversation yourself. The occupant also owns the per-session
     * draft mirror and the active view ring, so a replacement inherits both
     * duties and an empty one leaves a blank session pane — nothing here
     * degrades gracefully. To ADD rather than replace, take a seat inside the
     * flow instead: `conversation.view` for a whole tab, the input regions for
     * composer chrome.
     */
    'conversation.session': { kind: 'single'; scope: 'session' }
    /**
     * The strip above the session's scrollport: title, view tabs, and the
     * action row. Taking this seat means rendering all three yourself, and it
     * also collapses `conversation.session.header.actions` — that additive
     * seat is declared by whoever occupies this one, so replacing the header
     * takes every action entry down with it.
     */
    'conversation.session.header': { kind: 'single'; scope: 'session' }
    /**
     * One button in the session header's action row — the additive way to put
     * a per-session control beside the title without replacing the header.
     * Entries render by ascending `order`; negative values are reserved for
     * static session context that precedes interactive actions. The owner
     * passes nothing: everything a control needs comes from the framework
     * session kit (`sessionId`, `useSession`, `useInput`, `inputActions`) and
     * from the registrant's own inject face, so an empty owner share means
     * self-sufficient, not starved.
     */
    'conversation.session.header.actions': { kind: 'list'; scope: 'session'; owner: ConversationHeaderActionOwnerProps }
    /**
     * Right-aligned Session utilities kept outside the title-adjacent action
     * group, so an optional utility cannot reorder session context or lineage.
     */
    'conversation.session.header.utilities': { kind: 'list'; scope: 'session'; owner: ConversationHeaderActionOwnerProps }
    /**
     * The conversation view ring: one list entry per view tab (chat here;
     * trajectory/waterfall from ui-trajectory), rendered one-at-a-time by
     * the session body via `only: <active id>`. Declared by this package's
     * body entry (declaring is claiming). Session scope: views read the
     * conversation snapshot through the standard kit.
     */
    'conversation.view': { kind: 'list'; scope: 'session'; owner: ConvViewOwnerProps }
    /** Final business node renderer, dispatched by `ChatConversationViewNode.kind`. */
    'conversation.chat.node': {
      kind: 'keyed'
      scope: 'session'
      owner: ChatNodeOwnerProps
      keyProps: { [Kind in ChatNodeKind]: { node: ChatNode<Kind> } }
      hookContext: string
      inject: ChatNodeTurnDataInjected
    }
    /**
     * The chat view's per-command row hole: keyed dispatch on the command
     * name (`command/run.name`; a run-less cross-window node has none and
     * always lands on the fallback). Declared by the chat view entry; the
     * render site dispatches via `entryKey: name` with GenericCommandCard as
     * the `fallback` — a slash command renders durably with zero
     * registration, and a domain upgrades by registering one row component.
     */
    'conversation.chat.commandview': { kind: 'keyed'; scope: 'session'; owner: CommandRowOwnerProps }
    /**
     * The completed Turn Node's extension chain, rendered before that Node's
     * IconActions. Entries derive a match from the engine-owned Turn and
     * closing seq before mounting, so presentation components never mount
     * only to return null; an all-declined chain renders nothing.
     */
    'conversation.chat.turnTail': { kind: 'chain'; scope: 'session'; owner: TurnTailOwnerProps }
    /**
     * Action strip attached to one finalized assistant message, rendered
     * inside that message's IconActions row. The chat entry owns the render
     * site and passes the addressed message identity; contributors add
     * per-message actions without importing the conversation implementation.
     * Entries render by ascending `order`.
     */
    'conversation.chat.assistant-actions': {
      kind: 'list'
      scope: 'session'
      owner: AssistantActionOwnerProps
    }
    /**
     * Action strip attached to one finalized assistant message, rendered
     * before the IconActions row's built-in copy control. Same ownership as
     * the trailing `assistant-actions` strip, plus the message's event seq:
     * the leading seat addresses destructive actions (rollback) that need the
     * durable anchor the message id alone does not carry. Entries render by
     * ascending `order`.
     */
    'conversation.chat.assistant-leading-actions': {
      kind: 'list'
      scope: 'session'
      owner: AssistantLeadingActionOwnerProps
    }
    /**
     * The body of the details panel for the tool call the user selected —
     * one occupant, so taking it means rendering every tool's output, not just
     * the ones you know. The owner passes a frozen `block` whose two lifecycle
     * forms must both be handled: branch on `'kind' in block` (a settled
     * `ToolResultNode` has it, a still-running call does not), and treat
     * `cwd` as display-only, for shortening workspace-rooted paths.
     * A per-tool renderer belongs in the keyed `tool.call.toolview` seat
     * instead; this one is the whole panel.
     */
    'conversation.details.tool': { kind: 'single'; scope: 'session'; owner: DetailsToolOwnerProps }
    /**
     * The composer takeover chain: entries are selector-routed replacements
     * of the default InputBar. Declared by this package's 'conversation'
     * entry; the owner dispatches the {@link ComposerChainProps} currency and
     * routing lives in entry selectors — new takeover kinds register with
     * zero owner changes.
     */
    'conversation.composer': { kind: 'chain'; scope: 'session'; owner: ComposerChainProps }
    /**
     * The hero-phase Workspace picker hole: rendered by ConversationRoot
     * while the session is blank (picking another workspace switches to that
     * workspace's blank session, draft carried). Root scope: the picker
     * reads the global workspace list.
     */
    'conversation.hero.workspace': { kind: 'single'; scope: 'root'; owner: EmptyWorkspaceOwnerProps }
    /**
     * The agent-preset chip beside the workspace picker on the new-session
     * screen. Root scope: no session exists yet, so the choice is staged for
     * the next one rather than applied to a current one.
     */
    'conversation.hero.agentPreset': { kind: 'single'; scope: 'root'; owner: HeroAgentPresetOwnerProps }
    // 'conversation.input.overlay' merges in ui-input-trigger (the dependency
    // direction is the hard constraint — ui-input-trigger cannot import
    // this package, while this package's input contract already imports
    // ui-input-trigger, so the type arrives transitively). The runtime declaration
    // (children table in apply.ts) stays here with the other input slots.
    /**
     * A full-width row of its own, stacked above the composer card — the seat
     * for anything that needs a line to itself (queue rows, a todo strip, a
     * goal bar). Pick this over the three seats below when your content wraps
     * or carries prose; pick `conversation.composer.dock` for an ambient
     * readout under the card, and `conversation.input.left` /
     * `.right` for a small control INSIDE the card's tool row.
     * Read only `session`/`input` off the owner share ({@link InputZone}) —
     * both are point-in-time snapshots re-rendered for you, never subscribe.
     */
    'conversation.input.dock': { kind: 'list'; scope: 'session'; owner: InputZone }
    /**
     * The band under the composer card, inside the bar's width column — the
     * seat for an ambient readout about the conversation (the shipped stats
     * line lives here). Same {@link InputZone} owner share as the other
     * regions. Anything the user must click belongs in the tool row instead
     * (`conversation.input.left` / `.right`); anything needing its own line
     * above the card belongs in `conversation.input.dock`.
     */
    'conversation.composer.dock': { kind: 'list'; scope: 'session'; owner: InputZone }
    /**
     * The left end of the tool row INSIDE the composer card, after the
     * resident chrome (access mode, plan, attach) — the seat for a small
     * always-visible control. Entries sit beside that chrome, never replace
     * it. Same {@link InputZone} owner share; use `.right` for a control that
     * belongs next to the send button, and the docks for anything taller than
     * one row.
     */
    'conversation.input.left': { kind: 'list'; scope: 'session'; owner: InputZone }
    /**
     * The right end of the same tool row, before the primary send button —
     * the seat for a control the user reaches on the way to sending (the
     * model select sits in its own named seat just left of here). Same
     * {@link InputZone} owner share and the same one-row height budget as
     * `conversation.input.left`.
     */
    'conversation.input.right': { kind: 'list'; scope: 'session'; owner: InputZone }
    /**
     * The default composer body: a single slot rendered as the composer
     * chain's fallback (a real entry, not a chain rider, so a
     * takeover election hides rather than unmounts it and the textarea DOM
     * survives). Session-maybe: the bar stays mounted across the
     * no-session/session transition — the no-workspace hero renders the SAME
     * textarea DOM as a read-only Workspace-picker trigger instead of a
     * parallel inert tree — with the machine hooks absent until a session is
     * current. InputBar registers
     * here from this package's apply; its machine state arrives through the
     * standard provide channel (useInput + inputActions), the keyboard
     * command face through its own inject.
     */
    'conversation.composer.bar': { kind: 'single'; scope: 'session-maybe'; owner: ComposerBarOwnerProps }
    /**
     * The named plan-status seat in the composer tool row, immediately right
     * of the access-mode control — one occupant, so taking it means rendering
     * the plan affordance yourself. The owner passes only `locked` (see
     * {@link InputControlOwnerProps}): honour it by refusing interaction, and
     * take everything else from the framework session kit or your own inject.
     * Unoccupied, the seat renders nothing at all — the bar paints no
     * placeholder, so an absent plan plugin costs no layout.
     */
    'conversation.input.plan': { kind: 'single'; scope: 'session'; owner: InputControlOwnerProps }
    /**
     * The named model-select seat at the right end of the composer tool row,
     * left of the send button — one occupant, so taking it means rendering the
     * whole model affordance yourself. Same `locked`-only owner share and same
     * renders-nothing-while-empty contract as the plan seat. Note the composer
     * deliberately keeps this seat LIVE while it refuses text for a
     * model-related block: every such block is one the user clears by picking
     * a model here.
     */
    'conversation.input.model': { kind: 'single'; scope: 'session'; owner: InputControlOwnerProps }
  }

  /**
   * ui-conversation's members of the session standard kit, provided through
   * `sessions.provide`: every session-scope slot component
   * receives the input machine's state hook and the two public actions.
   */
  interface SessionStandardProps {
    /** Selector hook over the session's live input machine state. */
    useInput: SnapshotSelectorHook<InputState>
    /** The public input action face (stable identity per session). */
    inputActions: InputActions
  }

  /** Input members for the resident composer while current session is optional. */
  interface SessionMaybeStandardProps {
    useInput: MaybeSnapshotSelectorHook<InputState>
    inputActions: InputActions | undefined
  }
}

/** Owner share of the hero agent-preset chip: the shell supplies nothing. */
export interface HeroAgentPresetOwnerProps {
  /** Marker field: the chip owns its own roster, staging, and menu state. */
  children?: never
}

/** Owner share of the strict session content seat. */
export interface ConversationSessionOwnerProps {
  /**
   * Wrap the view ring in the transcript scrollport that also hosts the
   * sticky composer seat (whole `'conversation.composer'` chain output).
   * Supplied for every real session (hero/settling/active) so the composer
   * keeps one tree seat across the blank → active flip; the header stays
   * outside that wrapper as ordinary column chrome (`flex: none`), while
   * active CSS sticks the seat to the bottom of the same scrollport so wheel
   * over the footer scrolls the flow.
   * @param view - the session view-ring content (null while blank chrome is hidden).
   * @returns the scrollport containing `view` and the sticky composer seat.
   */
  wrapActiveBody?: (view: ReactNode) => ReactNode
}

/** Header actions derive their state from the standard session/global kit. */
export interface ConversationHeaderActionOwnerProps {}

/**
 * The input-region slot currency: dock/left/right entries read
 * the conversation snapshot and the live input state as owner props (both
 * are point-in-time snapshots — the dispatching skeleton re-renders on
 * either store's change, so entries stay current without subscribing).
 */
export interface InputZone {
  readonly session: ConversationSnapshot
  readonly input: InputState
}

/**
 * View-slot owner share: the cross-view inspect handoff (otherwise views need
 * nothing from the render site — sessionId and the snapshot hook arrive as
 * framework-standard props; tool rows go through each view's own declared
 * toolview hole).
 */
export interface ConvViewOwnerProps {
  /** One-shot inspect request from another view (chat's Inspect button); null when idle. */
  inspect?: { callId: CallId } | null
  /** Acknowledge the inspect request once applied (clears the store field). */
  onInspectDone?: () => void
}

/**
 * Optional prose file-mention provider, consumed via `ctx.get('chatFileMentions')`
 * (optional-service convention): the chat view asks it for a closing message's
 * inline-code vocabulary and threads the result into MarkdownText. Absent
 * service — the providing plugin composed out of cordis.yml — turns the
 * surface off; the prose renders inert code.
 */
export interface ChatFileMentions {
  /**
   * Mention vocabulary for the closing message the owner currency names.
   * @param owner - Turn-tail owner currency (Turn data, closing seq, opener).
   * @returns The resolver MarkdownText consumes, or undefined when the turn
   * produced nothing worth linking.
   */
  forClosing(owner: TurnTailOwnerProps): MarkdownFileMentions | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Prose file-mention provider (ui-deliverables); reach via ctx.get — optional. */
    chatFileMentions: ChatFileMentions
  }
}

/**
 * Owner currency of the chat view's turn-tail hole: the engine-owned Turn and
 * the closing assistant's anchor. Registrants read their own typed Turn data
 * and open files through the same opener the tool rows use.
 */
export interface TurnTailOwnerProps {
  /** Engine-owned closing Turn boundary. */
  turn: TurnLocation
  /** The closing assistant's seq — the anchor the tail renders under. */
  seq: number
  /**
   * Open a filesystem path through the Host (tool-row semantics; the chat
   * view resolves relative paths against the session cwd).
   */
  openFile: (path: string) => void
}

/**
 * Owner currency of the assistant-message action strip: the durable identity
 * of the one finalized message the contributed actions address. Only finalized
 * messages reach this slot, so the id is always present.
 */
export interface AssistantActionOwnerProps {
  /** Stable identity carried from the `assistant/message` event. */
  messageId: MessageId
}

/**
 * Owner currency of the leading assistant-message action strip: the durable
 * message identity plus the message's event seq, the anchor destructive
 * actions truncate the session log at.
 */
export interface AssistantLeadingActionOwnerProps {
  /** Stable identity carried from the `assistant/message` event. */
  messageId: MessageId
  /** The closing assistant message's event seq — the rollback cut anchor. */
  seq: number
}

/** Hook constrained to business data published on the current Chat Node's Turn. */
export type UseChatNodeTurnData = <Key extends Extract<keyof ConversationTurnDataMap, string>>(
  key: Key,
) => Readonly<ConversationTurnDataMap[Key]> | undefined

/** Settled outcome of one in-place message edit, normalized for the UI. */
export type MessageEditOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** The in-place edit verb bound to one session (message id + replacement text). */
export type MessageEditActions = (messageId: MessageId, text: string) => Promise<MessageEditOutcome>

/** Slot-level Hook factory used by renderers reading their Node's Turn data. */
export interface ChatNodeTurnDataInjected {
  hooks: {
    turnData: SlotHookFactory<'conversation.chat.node', UseChatNodeTurnData>
    /** In-place user-message edit verb (session-bound); messages not yet sent are not editable. */
    messageEdit: SlotHookFactory<'conversation.chat.node', () => MessageEditActions>
  }
}

/** Stable owner currency delivered to one keyed Chat business renderer. */
export interface ChatNodeOwnerProps {
  /** Selected Tool call, when the shared details store names one. */
  selectedCallId?: CallId | undefined
  /** Session workspace root; Tool summaries display paths relative to it. */
  cwd?: string | undefined
  openFile: (path: string) => void
  inspectCall: (callId: CallId) => void
  forkAt: (seq: number) => void
  /** Resolve a session-authorized historical image for inline display. */
  loadImage: (attachment: ImageAttachmentRef) => Promise<string>
  fileMentions: (owner: TurnTailOwnerProps) => MarkdownFileMentions | undefined
}

/** Full props of one registered keyed Chat business renderer. */
export type ChatNodeViewProps<Kind extends ChatNodeKind = ChatNodeKind> =
  PropsRuntime<'conversation.chat.node', Kind> & PropsLocale<'conversation'>

/** Owner currency of the details panel's Tool output renderer. */
export interface DetailsToolOwnerProps {
  /** Frozen selected call slice. */
  block: ToolCallBlock
  /** Session workspace root for card cwd and relative-path display. */
  cwd?: string | undefined
}

/**
 * Owner share of the per-command row slot: the frozen {@link CommandNode}
 * slice off the snapshot (cache-stable reference — memo premise). The node
 * carries the whole lifecycle (structured name/args, pairing id, and
 * outcome-or-executing). A successful domain command may also carry the
 * explicitly linked projection node needed to fold two log records into one
 * presentation row.
 */
export interface CommandRowOwnerProps {
  /** Folded command lifecycle node (run + optional done). */
  node: CommandNode
  /** Explicitly linked compaction checkpoint for the settled `/compact` presentation. */
  compaction?: CompactionSummaryNode
}

/** Full props of a registered command-row component. */
export type CommandRowProps = PropsRuntime<'conversation.chat.commandview'>

/**
 * Base props of a conversation view entry: the framework standard kit for the
 * session-scope 'conversation.view' slot (useSession narrowed to the
 * conversation snapshot by the runtime merge, sessionId, useSessions).
 * Entries declaring the shared store or an inject face compose their shares
 * on top (the chat entry's {@link ChatViewSlotProps}); store-less pure
 * readers (ui-trajectory) take this base alone.
 */
export type ConvViewProps = PropsRuntime<'conversation.view'>

/** The shared chat store handle type declared by the Session header/body, details, and chat-view registrations. */
export type ChatStore = ReturnType<typeof createChatStore>

/** Business callbacks injected into the conversation slot. */
export interface ConversationInjected {
  /**
   * Connect the selected Workspace and open its reusable/new blank session.
   * When a blank session is already current, carry its draft to the target.
   */
  selectWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  /**
   * Framework-bound sources. `composerBlock` is this session's block when a
   * plugin raised one; the reason is the blocker's own localized copy, which
   * the root renders as the inert composer's placeholder.
   */
  hooks: { composerBlock: ObservableSnapshot<ComposerBlock | undefined> }
}

/** Business callbacks injected into the strict Session body seat. */
export interface ConversationSessionInjected {
  /** Views projected from the `conversation.view` slot ledger. */
  views: {
    list: () => readonly ViewTab[]
    subscribe: (fn: () => void) => () => void
    version: () => number
  }
  /** Release historical image URLs when this rendered session scope unmounts. */
  releaseSessionImages: (sessionId: SessionId) => void
  /** Bind the input machine's draft persistence mirror to the session store. */
  bindDraftMirror: (write: (text: string) => void) => () => void
}

/** Business callbacks injected into the strict session header seat. */
export interface ConversationSessionHeaderInjected {
  /** Views projected from the `conversation.view` slot ledger. */
  views: {
    list: () => readonly ViewTab[]
    subscribe: (fn: () => void) => () => void
    version: () => number
  }
  /** Select a real Session through the runtime navigation owner. */
  open: (sessionId: SessionId) => void
}

/**
 * Owner share of the composer-bar slot: ConversationRoot's layout-phase
 * inputs plus the input-region child-slot content it renders (the region
 * slots stay declared/rendered by the conversation entry; the bar hosts the
 * results as chrome).
 */
export interface ComposerBarOwnerProps {
  /** Hero = empty-state centered card; composer = resident bottom bar. */
  variant: 'hero' | 'composer'
  /**
   * A block another plugin raised for this session: the bar refuses input and
   * shows the blocker's reason as the placeholder, but — unlike `disabled` —
   * keeps the model seat live. Every block this contract has is one the user
   * clears by choosing a model, so locking that seat too would leave the
   * composer telling them to do the one thing it prevents.
   */
  blocked?: { readonly reason: string }
  /**
   * Inert no-workspace state: the bar locks message actions while preserving
   * its normal DOM so the Workspace pick transitions in place.
   */
  disabled?: boolean
  /** Whether the shared Workspace picker menu is expanded, regardless of which trigger opened it. */
  workspacePickerOpen?: boolean
  /** Open the existing Workspace picker from the inert textarea. */
  onRequestWorkspace?: () => void
  placeholder?: string
  /** Optional content rendered above the textarea. */
  accessory?: ReactNode
  /** Floating overlay anchor content (menu / popup shell entries), rendered inside the card. */
  overlay?: ReactNode
  /** input.left slot entries (tool row, beside the resident chrome). */
  leftItems?: ReactNode
  /** input.right slot entries (tool row, before the primary button). */
  rightItems?: ReactNode
  /** composer.dock entries (stats line), rendered under the card inside the bar's width column. */
  footer?: ReactNode
}

/** Injected share of the composer-bar entry (package-internal faces). */
export interface ComposerBarInjected {
  /** The InputBar-exclusive keyboard/DOM command face (private plane); absent with the session. */
  keyboard: ComposerKeyboard | undefined
  /** Create previews and append image ids to the session input. */
  addImages: ((files: readonly File[]) => string | null) | undefined
  /** Release one preview and remove its id from session input. */
  removeImage: ((id: DraftAttachmentId) => void) | undefined
  /** Resolve ordered input ids to browser-owned draft images. */
  draftImages: ((ids: readonly DraftAttachmentId[]) => readonly ComposerAttachment[]) | undefined
  /** Resolve one keyboard submission gesture against the current running state and persisted preference. */
  resolveSubmitMode: (
    running: boolean,
    gesture: ComposerSubmitGesture,
    steeringAvailable: boolean,
  ) => InputSubmitMode
  /** Toggle the shared slash menu with only its command source; absent without ui-input-trigger or a session. */
  toggleCommandMenu: ((selection: EditSelection) => void) | undefined
  /** Cancel the in-flight turn; absent with the session. */
  stop: (() => void) | undefined
  /**
   * Submit one slash-command line against this session's agent (the chrome
   * controls' write path — the permission chip submits `/permission <preset>`);
   * absent with the session.
   * Resolves admission: false = rejected/unmatched/transport failure.
   */
  command: ((line: string) => Promise<boolean>) | undefined
  /**
   * Registrant hooks compartment: the renderer binds these to
   * useNotices/useLexicon (static absent sources without a session — hook
   * order stays constant).
   */
  hooks: {
    /** Latest surfaced notice (null after none; seq keys re-render of repeats). */
    notices: ObservableSnapshot<InputNotice | null>
    /** Hot plain-text reference lexicon for the decoration scan (plain-text-reference decision;
     *  see .agents/notes/implemented/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md). */
    lexicon: ObservableSnapshot<ReadonlyMap<'/' | '@', readonly string[]>>
    /** Source name opened by the programmatic menu launcher, or null. */
    menuLauncher: ObservableSnapshot<string | null>
  }
}

/**
 * Owner share of the two named composer control seats (plan / model): the
 * bar passes its disable state; the filling entry owns everything else.
 */
export interface InputControlOwnerProps {
  /** Session-removed lock (the bar's chrome disable state). */
  locked: boolean
}

/** Full composer-bar props: standard kit & owner share & control-seat render share & injected share (hooks bound) & locale seat. */
export type ComposerBarProps =
  PropsRuntime<'conversation.composer.bar'>
  & PropsRenderSlots<'conversation.input.plan' | 'conversation.input.model'>
  & InjectFace<ComposerBarInjected>
  & PropsLocale<'conversation'>

/**
 * Composer chain currency: what ConversationRoot dispatches at its
 * renderSlotChain site. The owner declares the currency only — never a
 * per-entry contract; takeover packages narrow it in their own selectors
 * (`interactions.find(i => i.kind === ...)`), so new takeover kinds register
 * with zero owner changes.
 */
export interface ComposerChainProps {
  interactions: readonly PendingInteraction[]
  /** Current conversation facts for feature-owned takeover selectors. */
  session: ConversationSnapshot | undefined
}

/**
 * Full conversation-slot component props: runtime & child-render (view ring
 * + composer chain/bar + input-region + hero picker slots) & store & injected
 * shares & the locale seat.
 */
export type ConversationSlotProps =
  PropsRuntime<'conversation'> & PropsRenderSlots<
    | 'conversation.session' | 'conversation.session.header'
    | 'conversation.composer' | 'conversation.composer.bar'
    | 'conversation.input.overlay'
    | 'conversation.input.dock' | 'conversation.composer.dock'
    | 'conversation.input.left' | 'conversation.input.right'
    | 'conversation.hero.workspace'
    | 'conversation.hero.agentPreset'
  >
  & InjectFace<ConversationInjected>
  & PropsLocale<'conversation'>

/** Full strict-session body props: per-session store, view ring, and draft mirror. */
export type ConversationSessionSlotProps =
  PropsRuntime<'conversation.session'>
  & PropsRenderSlots<'conversation.view'>
  & PropsStore<ChatStore>
  & ConversationSessionInjected

/** Full strict-session header props: shared store, tabs/actions render shares, navigation, and locale. */
export type ConversationSessionHeaderSlotProps =
  PropsRuntime<'conversation.session.header'>
  & PropsRenderSlots<'conversation.session.header.actions' | 'conversation.session.header.utilities'>
  & PropsStore<ChatStore>
  & ConversationSessionHeaderInjected
  & PropsLocale<'conversation'>

/** The pending approval carrier the owner dispatches into the composer chain. */
export type ApprovalWait = PendingWait<'approval'>

/**
 * Approval domain face over the carrier (the ui-user-questions PendingQuestion
 * pattern): render identity and question material forwarded transparently;
 * answer owns the wire encoding — the ApprovalResponsePayload value shape
 * with the audit correlation the host reconciles — and turns a rejected
 * carrier receipt into a thrown error. Minted per carrier via useMemo.
 */
export class PendingApproval {
  /**
   * @param wait - the runtime carrier for one pending approval question.
   */
  constructor(private readonly wait: ApprovalWait) {}

  /** Opaque render identity (React key / one-shot latch remount axis), forwarded from the carrier. */
  get key(): string {
    return this.wait.key
  }

  /** The tool the question is about (headline fallback), forwarded from the carrier payload. */
  get toolName(): string {
    return this.wait.payload.toolName
  }

  /** The asker's human-readable WHY (headline when present), forwarded from the carrier payload. */
  get reason(): string | undefined {
    return this.wait.payload.reason
  }

  /** The paired tool call's id when the ask names one (command-line lookup key), forwarded from the carrier payload. */
  get callId(): string | undefined {
    return this.wait.payload.callId
  }

  /**
   * Deliver the user's decision; a rejected carrier receipt throws. Panel
   * removal stays frame-driven: the broadcast `approval/resolved` settles the
   * wait and drops it from the pending list.
   * @param outcome - the only two client-answerable outcomes.
   */
  async answer(outcome: 'allowed-once' | 'rejected'): Promise<void> {
    const receipt = await this.wait.respond({
      ok: true,
      value: { sessionId: this.wait.sessionId, approvalId: this.wait.payload.approvalId, outcome },
    })
    if (!receipt.accepted) {
      throw new Error(`approval response rejected: ${receipt.reason}`)
    }
  }
}

/**
 * Full approval-composer props: the framework runtime share (chain currency +
 * session/global standard kit) plus the chain `matched` share — the entry's
 * selector result, already narrowed to the approval carrier — plus the
 * standard locale seat. No injected share: the carrier plus the domain face
 * above carry the whole behavior surface; the paired command line derives
 * from useSession in-component.
 */
export type ApprovalComposerProps =
  PropsRuntime<'conversation.composer'> & { matched: ApprovalWait } & PropsLocale<'conversation'>

/** In-memory reader position resilient to transcript width reflow. */
export interface ChatScrollPosition {
  /** Stable rendered node/call identity nearest the visible reading edge. */
  readonly anchorKey: string
  /** Anchor top relative to the transcript scrollport when saved. */
  readonly anchorTop: number
  /** Approximate offset used before the semantic anchor is measured. */
  readonly scrollTop: number
}

/**
 * Injected share of the chat view entry: the two callbacks whose targets live
 * outside the view (layout orchestration; the session object layer).
 */
export interface ChatViewInjected {
  /** Selection write + details panel opening in one gesture (store action + layout orchestration). */
  openDetails: (target: SelectionTarget) => void
  /**
   * Open a tool-arg filesystem path with the host OS default application
   * (relative paths resolve against the session cwd).
   */
  openFile: (path: string) => void
  loadOlder: () => void
  /** Resolve a session-authorized historical image for inline display. */
  loadImage: (attachment: ImageAttachmentRef) => Promise<string>
  /** Hand a call off to the trajectory view: write the one-shot inspect target and switch tabs. */
  inspectCall: (callId: CallId) => void
  /**
   * Per-session scroll memory surviving view switches (in-memory, never
   * persisted): the view saves on every scroll and restores on remount; a
   * fresh page load starts empty and keeps the open-jump-to-bottom default.
   */
  chatScroll: {
    /** Record a semantic reader position; null clears it when pinned. */
    save: (position: ChatScrollPosition | null) => void
    /** Last reader position, or null when pinned or never recorded. */
    read: () => ChatScrollPosition | null
  }
  /** Fork through the completed turn ending at the eligible message `seq`, then open the child. */
  forkAt: (seq: number) => void
  /**
   * Prose file-mention vocabulary for one closing message, from the optional
   * {@link ChatFileMentions} service (resolved lazily per call, so composing
   * the provider in or out takes effect live). Undefined when the service is
   * absent or the turn produced nothing worth linking.
   */
  fileMentions: (owner: TurnTailOwnerProps) => MarkdownFileMentions | undefined
}

/** Full chat-view component props: runtime & its Tool/command/tail render shares & store & injected & locale seat. */
export type ChatViewSlotProps =
  PropsRuntime<'conversation.view'> & PropsRenderSlots<'conversation.chat.node'>
  & PropsStore<ChatStore> & ChatViewInjected & PropsLocale<'conversation'>

/**
 * Injected share of the details slot: the panel is otherwise a pure reader of
 * the shared chat store, but its close button is a layout orchestration call.
 */
export interface DetailsInjected {
  /** Close the details panel (layout geometry stays with ctx.layout). */
  closeDetails: () => void
}

/** Full details-slot props: selection store, Tool output seat, injected close callback, and locale. */
export type DetailsSlotProps = PropsRuntime<'details'> & PropsRenderSlots<'conversation.details.tool'>
  & PropsStore<ChatStore> & DetailsInjected & PropsLocale<'conversation'>

/** Owner share common to the hero / New-Session Workspace pickers. */
export interface EmptyWorkspaceOwnerProps {
  open: boolean
  anchorRef?: RefObject<HTMLElement>
  /** Currently active workspace (renders a trailing check in the picker list). */
  selectedId?: WorkspaceId | undefined
  onPick: (workspaceId: WorkspaceId) => void
  onClose: () => void
}

/**
 * Core contracts for the Desktop orchestrator: task levels, the Pro planning
 * output, the per-executor task card, and the executor/result/error interfaces.
 *
 * The orchestrator is a *plan-and-dispatch* layer on top of the harness agent
 * loop. It never changes the loop; it only classifies one task into a level,
 * then hands the level to the matching executor. Executors are isolated by
 * construction — a `FlashExecutor` subagent receives only its task card, never
 * the caller's full history — which is what enforces the "lower tiers never see
 * the full context" rule.
 *
 * @module dsh-plugin-desktop-beta/orchestrator/types
 */

/** Five difficulty levels; L0–L2 dispatch directly, L3–L4 take the long path. */
export type Level = 'L0' | 'L1' | 'L2' | 'L3' | 'L4'

/** Which executor a plan routes to. `pro_router` and `human` cover L3/L4. */
export type ExecutorName = 'local' | 'flash' | 'marvis' | 'pro_router' | 'human'

/** Per-task cost/step/retry bounds the Pro planner assigns. */
export interface Budget {
  /** Maximum output tokens the executor may spend. */
  maxTokens: number
  /** Maximum model steps the executor may take. */
  maxSteps: number
  /** Maximum re-planning retries before the task reports failure upward. */
  maxRetries: number
}

/**
 * The Pro planner's structured output for one task: the assigned level, the
 * reason, the goal, the budget, the chosen executor, and the task card.
 */
export interface Plan {
  /** Stable task identity stamped on the card and every result. */
  taskId: string
  /** The assigned difficulty level. */
  level: Level
  /** Why this level was chosen; kept for the audit trail. */
  reason: string
  /** The macro goal, in one sentence. */
  goal: string
  /** Cost/step/retry bounds for the executor. */
  budget: Budget
  /** The executor this plan routes to. */
  executor: ExecutorName
  /** The task card handed to the executor (never the caller's full context). */
  taskCard: TaskCard
  /** Sub-goals for L3/L4 long-path routing; empty for direct levels. */
  subGoals: string[]
  /** True when the task needs human confirmation before it can run. */
  requiresHuman: boolean
}

/**
 * The bounded task card an executor receives. This is the whole context an
 * executor sees: it deliberately excludes the caller's history and any global
 * plan, so a lower tier cannot act on information above its level.
 */
export interface TaskCard {
  /** Task identity, stamped so the result can be correlated back. */
  taskId: string
  /** The local goal the executor must achieve. */
  goal: string
  /** The bounded context fragment relevant to this task. */
  context: string
  /** Tool names the executor may use; empty means the executor's defaults. */
  tools: string[]
  /** Expected output format: `json`, `text`, or `markdown`. */
  outputFormat: 'json' | 'text' | 'markdown'
  /** Maximum model steps. */
  maxSteps: number
  /** Maximum output tokens. */
  maxTokens: number
  /** Maximum retries before failing. */
  maxRetries: number
}

/** The terminal outcome of one executor run. */
export interface ExecutorResult {
  /** True when the executor satisfied the task. */
  ok: boolean
  /** The task identity this result belongs to. */
  taskId: string
  /** The level this result came from. */
  level: Level
  /** The executor's output data, when successful. */
  data?: unknown
  /** The failure detail, when not `ok`. */
  error?: ExecutorError
  /** How many attempts the executor spent. */
  attempts: number
  /** Tokens consumed by the executor, when reported. */
  tokensUsed: number
  /** Wall-clock duration in milliseconds. */
  durationMs: number
}

/** Structured failure detail carried back to the Pro planner. */
export interface ExecutorError {
  /** Machine-readable failure code. */
  code: string
  /** Human-readable failure message. */
  message: string
  /** What was attempted before failing; never the caller's raw history. */
  attempted: string[]
  /** The level this failure came from. */
  level: Level
  /** The task identity the failure belongs to. */
  taskId: string
}

/**
 * Runtime context handed to an executor for one run: the caller's cancellation
 * and parent, plus the recursion depth (guards the L3 long path against
 * runaway decomposition).
 */
export interface ExecuteContext {
  /** Caller cancellation, forwarded to sub-work. */
  signal: AbortSignal
  /** The delegating agent, when one exists; subagent executors need it. */
  parent: import('@deepseek-ai/dsh-agent').Agent | undefined
  /** Current recursion depth; the Pro router increments it per sub-goal. */
  depth: number
}

/**
 * One executor: a named handler that claims one or more levels and runs a task
 * card to a result. Executors are deliberately dumb — they do not re-plan,
 * auto-escalate, or modify the plan; they only run and report.
 */
export interface Executor {
  /** Registry name (`local`, `flash`, `marvis`, …). */
  readonly name: ExecutorName
  /** Whether this executor handles the given level. */
  canHandle(level: Level): boolean
  /**
   * Run one task card to completion.
   * @param plan - the plan carrying the task card and budget.
   * @param context - cancellation, parent, and recursion depth.
   */
  execute(plan: Plan, context: ExecuteContext): Promise<ExecutorResult>
}

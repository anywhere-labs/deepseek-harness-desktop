import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import PolishService from '@deepseek-ai/dsh-polish'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Full-loop harness: a scripted mock model answers real turns through the REAL
 * agent loop and the REAL PolishService. Only the model is mocked; the agent,
 * the session log, and the throwaway-session path are the shipping
 * implementations.
 * @param adapter - scripted model responses in arrival order.
 * @param config - optional polish service config overrides.
 * @returns the context (with the loop and polish service mounted) plus the
 * adapter, whose recorded requests the spec asserts on.
 */
export async function harness(
  adapter: MockAdapter,
  config?: Partial<ConstructorParameters<typeof PolishService>[1]>,
): Promise<{ ctx: Context; adapter: MockAdapter }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(PolishService, { maxMessageChars: 20000, ...config })
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter }
}

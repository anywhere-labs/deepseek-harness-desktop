import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import MessageEditService from '@deepseek-ai/dsh-message-edit'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Full-loop harness: a scripted mock model answers real turns through the REAL
 * agent loop and the REAL MessageEditService. Only the model is mocked; the
 * agent, the session log, and the surface fold are the shipping
 * implementations.
 * @param adapter - scripted model responses in arrival order.
 * @param config - optional message-edit service config overrides.
 * @returns a context with the loop and message-edit service mounted.
 */
export async function harness(
  adapter: MockAdapter,
  config?: Partial<ConstructorParameters<typeof MessageEditService>[1]>,
): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(MessageEditService, { maxMessageChars: 20000, ...config })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

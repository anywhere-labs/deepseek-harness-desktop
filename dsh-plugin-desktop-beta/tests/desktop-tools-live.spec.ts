/**
 * REAL-composition coverage for the two product-visible tool plugins:
 * `desktop-orchestrator` (`orchestrate`) and `desktop-marvis`
 * (`marvis_send` / `marvis_collect`).
 *
 * A test-only `cordis.yml` boots the real `systemPrompt` + `tools` registry
 * through the Loader alongside both desktop plugins. Only the external seams
 * are mocked: the `llm` service (the Pro planner's model call) and the
 * `desktopClipboard` seam (an in-memory stand-in for the Electron clipboard).
 * The `tools` registry itself is the real implementation, so registration and
 * dispatch run through the production pipeline.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Orchestrator from '../src/orchestrator/index.ts'
import * as Marvis from '../src/marvis.ts'
import { createMemoryClipboard, type DesktopClipboard } from '../src/desktop-clipboard.ts'

/** The Pro planner's deterministic L0 response, fed by the mock `llm` stream. */
const L0_RESPONSE = JSON.stringify({
  level: 'L0',
  reason: 'Deterministic single-step JSON formatting.',
  goal: 'Format the provided JSON.',
  budget: { maxTokens: 256, maxSteps: 1, maxRetries: 0 },
  subGoals: [],
  requiresHuman: false,
})

/** A minimal `llm` mock: one stream that returns the L0 plan as a text block. */
const mockLlm = {
  stream: async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: L0_RESPONSE }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: L0_RESPONSE } }
  },
}

/** Boot the real Loader with the desktop tool plugins and the provided seams. */
async function bootTools(clipboard: DesktopClipboard, llm: unknown) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-tools-')))
  const configPath = join(home, 'cordis.yml')
  writeFileSync(configPath, [
    '- name: cordis:systemPrompt',
    '- name: cordis:tools',
    '- name: cordis:orchestrator',
    '  config:',
    '    proProvider: mock-provider',
    '- name: cordis:marvis',
    '',
  ].join('\n'))
  const ctx = await boot('desktop-tools-test', configPath, undefined, ctx => {
    ctx.provide('desktopClipboard', clipboard)
    ctx.provide('llm', llm as never)
    Object.assign(ctx.loader.builtins, {
      systemPrompt: SystemPrompt,
      tools: ToolRuntime,
      orchestrator: Orchestrator,
      marvis: Marvis,
    })
  })
  return { ctx, home }
}

it('orchestrate levels an L0 task and pretty-prints JSON through the real tools registry', async () => {
  const clipboard = createMemoryClipboard()
  const { ctx, home } = await bootTools(clipboard, mockLlm)
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  })

  const tools = ctx.get('tools')
  expect(tools).toBeDefined()
  const result = await tools!.execute({
    name: 'orchestrate',
    callId: ToolCallId('orchestrate-l0'),
    arguments: { task: '{"a":1,"b":[2,3]}' },
    signal: new AbortController().signal,
  })

  expect(result.isError).toBe(false)
  if (result.isError) return
  const outcome = result.value as { ok: boolean; taskId: string; level: string; output?: string }
  expect(outcome.ok).toBe(true)
  expect(outcome.level).toBe('L0')
  expect(outcome.taskId).toMatch(/^dsh-\d{8}-\d{3}$/)
  expect(JSON.parse(outcome.output ?? '')).toEqual({ a: 1, b: [2, 3] })
})

it('marvis_send writes the task card to the clipboard and returns a hand-off prompt', async () => {
  const clipboard = createMemoryClipboard()
  const { ctx, home } = await bootTools(clipboard, mockLlm)
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  })

  const tools = ctx.get('tools')
  expect(tools).toBeDefined()
  const result = await tools!.execute({
    name: 'marvis_send',
    callId: ToolCallId('marvis-send-1'),
    arguments: { task: 'Summarize the quarterly report' },
    signal: new AbortController().signal,
  })

  expect(result.isError).toBe(false)
  if (result.isError) return
  const outcome = result.value as { taskId: string; copied: boolean; prompt: string }
  expect(outcome.copied).toBe(true)
  expect(outcome.taskId).toMatch(/^marvis-\d+-\d+$/)
  expect(outcome.prompt).toContain('已复制任务卡')

  const clipboardText = clipboard.readText()
  expect(clipboardText).toContain('===DSH_TASK===')
  expect(clipboardText).toContain('Summarize the quarterly report')
  expect(clipboardText).toContain('===DSH_TASK_END===')
})

it('marvis_collect parses the result envelope the user copied back', async () => {
  const clipboard = createMemoryClipboard()
  const { ctx, home } = await bootTools(clipboard, mockLlm)
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  })

  clipboard.writeText('===DSH_RESULT===\nThe answer is 42.\n===DSH_RESULT_END===')

  const tools = ctx.get('tools')
  expect(tools).toBeDefined()
  const result = await tools!.execute({
    name: 'marvis_collect',
    callId: ToolCallId('marvis-collect-1'),
    arguments: {},
    signal: new AbortController().signal,
  })

  expect(result.isError).toBe(false)
  if (result.isError) return
  const outcome = result.value as { ok: boolean; result?: string }
  expect(outcome.ok).toBe(true)
  expect(outcome.result).toBe('The answer is 42.')
})

it('marvis_collect reports a clear error when the clipboard has no result yet', async () => {
  const clipboard = createMemoryClipboard()
  const { ctx, home } = await bootTools(clipboard, mockLlm)
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  })

  const tools = ctx.get('tools')
  expect(tools).toBeDefined()
  const result = await tools!.execute({
    name: 'marvis_collect',
    callId: ToolCallId('marvis-collect-2'),
    arguments: {},
    signal: new AbortController().signal,
  })

  expect(result.isError).toBe(false)
  if (result.isError) return
  const outcome = result.value as { ok: boolean; error?: string }
  expect(outcome.ok).toBe(false)
  expect(outcome.error).toBe('No Marvis result found in the clipboard yet.')
})

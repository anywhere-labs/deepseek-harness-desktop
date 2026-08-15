import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/** Published-entry acceptance for argument errors, profile lifecycle, and boot-free config dumps. */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
// The release version, including a prerelease such as 0.0.1-rc.1: `--version`
// prints what this manifest carries, so no test may pin it to a literal.
const cliVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
const dshBin = join(repoRoot, 'apps/cli/lib/bin.js')
const invalidProvider = fileURLToPath(new URL('./fixtures/invalid-provider.cordis.yml', import.meta.url))

async function runBuiltBin(
  args: readonly string[] = [],
  env: Readonly<Record<string, string | undefined>> = {},
  cwd?: string,
): Promise<{ stdout: string; code: number; stderr: string }> {
  const childEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env })
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const result = await execa(process.execPath, [dshBin, ...args], {
    input: '',
    timeout: 25_000,
    killSignal: 'SIGKILL',
    reject: false,
    env: childEnv,
    extendEnv: false,
    ...cwd === undefined ? {} : { cwd },
  })
  if (result.timedOut) {
    throw new Error(`dsh built bin did not exit within 25s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  return { stdout: result.stdout, code: result.exitCode ?? -1, stderr: result.stderr }
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`dsh profile lifecycle marker did not appear: ${file}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

interface ProfileLifecycleFixture {
  home: string
  ready: string
  settled: string
  disposed: string
  interrupt: string
}

/**
 * A minimal custom profile: one lifecycle-marker plugin bundle listed in
 * dsh.profile.bundles, no dsh-base — proving out-of-box composition machinery without
 * booting the entire product tree.
 */
function createProfileLifecycleFixture(): ProfileLifecycleFixture {
  const home = mkdtempSync(join(tmpdir(), 'dsh-profile-lifecycle-'))
  const ready = join(home, 'ready')
  const settled = join(home, 'settled')
  const disposed = join(home, 'disposed')
  const interrupt = join(home, 'interrupt')
  const bundleDir = join(home, 'lifecycle-bundle')
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(join(bundleDir, 'plugin.mjs'), [
    "import { existsSync, writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "export const name = 'profile-lifecycle-fixture'",
    'export function apply(ctx, config = {}) {',
    '  let active = true',
    '  // Keep the event loop alive so process lifetime is signal-owned, like a real surface.',
    '  // Windows has no deliverable SIGTERM; the marker emits the same process event there.',
    '  let interrupted = false',
    '  const heartbeat = setInterval(() => {',
    '    if (interrupted || !existsSync(process.env.RAW_INTERRUPT_FILE)) return',
    '    interrupted = true',
    "    process.emit('SIGTERM')",
    '  }, 20)',
    '  // Echo the mounted generation so the hot-reload e2e can assert both an',
    '  // applied override and its removal reverting to this bundle default.',
    "  writeFileSync(join(process.env.DSH_HOME, 'config-echo'), String(config.generation ?? 'bundle-default'))",
    "  writeFileSync(process.env.RAW_READY_FILE, 'ready')",
    '  void ctx.loader.await().then(() => {',
    "    if (active) writeFileSync(process.env.RAW_SETTLED_FILE, 'settled')",
    '  })',
    '  ctx.effect(() => () => {',
    '    active = false',
    '    clearInterval(heartbeat)',
    "    writeFileSync(process.env.RAW_DISPOSED_FILE, 'disposed')",
    '  })',
    '}',
    '',
  ].join('\n'))
  writeFileSync(join(bundleDir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: profile-lifecycle-fixture',
    `      name: ${pathToFileURL(join(bundleDir, 'plugin.mjs')).href}`,
    '',
  ].join('\n'))
  writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
    name: 'dsh-lifecycle-bundle',
    version: '0.0.0',
    type: 'module',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, undefined, 2))
  const profileDir = join(home, 'profiles', 'lifecycle')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-lifecycle',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['dsh-lifecycle-bundle'] } },
  }, undefined, 2))
  // Hand-place the "installed" bundle where profile resolution finds it.
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
  const linkTarget = join(profileDir, 'node_modules', 'dsh-lifecycle-bundle')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  try {
    rmSync(linkTarget, { recursive: true, force: true })
  } catch { /* fresh dir */ }
  // Copy-free: a package.json redirecting via a relative main is enough for require.resolve.
  mkdirSync(linkTarget, { recursive: true })
  for (const file of ['package.json', 'cordis.patch.yml', 'plugin.mjs']) {
    writeFileSync(join(linkTarget, file), readFileSync(join(bundleDir, file)))
  }
  return { home, ready, settled, disposed, interrupt }
}

function startProfileLifecycle(fixture: ProfileLifecycleFixture, args: readonly string[] = []) {
  return execa(process.execPath, [dshBin, '--profile', 'lifecycle', ...args], {
    cwd: fixture.home,
    input: '',
    reject: false,
    env: {
      DSH_HOME: fixture.home,
      RAW_READY_FILE: fixture.ready,
      RAW_SETTLED_FILE: fixture.settled,
      RAW_DISPOSED_FILE: fixture.disposed,
      RAW_INTERRUPT_FILE: fixture.interrupt,
    },
  })
}

function requestProfileShutdown(
  child: Pick<ReturnType<typeof startProfileLifecycle>, 'kill'>,
  fixture: Pick<ProfileLifecycleFixture, 'interrupt'>,
): void {
  if (process.platform === 'win32') {
    writeFileSync(fixture.interrupt, 'interrupt')
    return
  }
  child.kill('SIGTERM')
}

function createEnvironmentProbeProfile(home: string, project: string): void {
  const pluginFile = join(project, 'environment-probe.mjs')
  writeFileSync(pluginFile, [
    "export const name = 'environment-probe'",
    "export const inject = ['llm']",
    'export function apply(ctx) {',
    '  void ctx.loader.await().then(async () => {',
    "    let text = ''",
    '    for await (const chunk of ctx.llm.stream({',
    "      provider: 'deepseek-official',",
    "      model: 'deepseek-v4-flash',",
    '      messages: [],',
    '      maxTokens: 32,',
    '    })) {',
    "      if (chunk.type === 'text-delta') text += chunk.text",
    '    }',
    '    process.stdout.write(`${text}\\n`)',
    "    if (process.platform === 'win32') process.emit('SIGTERM')",
    "    else process.kill(process.pid, 'SIGTERM')",
    '  })',
    '}',
    '',
  ].join('\n'))
  const profileDir = join(home, 'profiles', 'environment-probe')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-environment-probe',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, undefined, 2))
  writeFileSync(join(profileDir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: environment-probe',
    `      name: ${pathToFileURL(pluginFile).href}`,
    '',
  ].join('\n'))
}

interface StartupFixture {
  home: string
  ready: string
  echo: string
  interrupt: string
  /** An always-running row's echo, used to observe that a user patch reload landed. */
  witness: string
}

/**
 * A custom profile whose ordinary provider plugin injects `cmdlineArgs`, plus
 * a row that reads its app-owned service through a `!!js` config expression.
 * Both plugin modules resolve
 * `@deepseek-ai/dsh-cmdline` and `commander` through the profile module
 * fallback, exactly as an installed out-of-tree bundle does.
 */
function createStartupFixture(): StartupFixture {
  const home = mkdtempSync(join(tmpdir(), 'dsh-profile-startup-'))
  const profileDir = join(home, 'profiles', 'startup')
  // Written straight into the installed location: a row module resolves its
  // own imports from where it is installed, and only inside the profile does
  // Node's parent walk reach the installation fallback these plugins need.
  const bundleDir = join(profileDir, 'node_modules', 'dsh-startup-bundle')
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(join(bundleDir, 'startup.mjs'), [
    "import { Command } from 'commander'",
    "import { parseCmdline } from '@deepseek-ai/dsh-cmdline'",
    "export const name = 'fixture-startup'",
    "export const inject = ['cmdlineArgs']",
    'export function apply(ctx) {',
    "  const program = new Command().name('fixture').option('--generation <value>', 'echoed generation')",
    "  program.action(() => ctx.provide('fixtureStartup', { generation: program.opts().generation }))",
    '  parseCmdline(ctx, program)',
    '}',
    '',
  ].join('\n'))
  writeFileSync(join(bundleDir, 'waiting.mjs'), [
    "import { existsSync, writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "export const name = 'startup-fixture'",
    'export function apply(ctx, config = {}) {',
    '  let interrupted = false',
    '  const heartbeat = setInterval(() => {',
    '    if (interrupted || !existsSync(process.env.RAW_INTERRUPT_FILE)) return',
    '    interrupted = true',
    "    process.emit('SIGTERM')",
    '  }, 20)',
    "  writeFileSync(join(process.env.DSH_HOME, 'config-echo'), String(config.generation ?? 'bundle-default'))",
    "  writeFileSync(process.env.RAW_READY_FILE, 'ready')",
    '  ctx.effect(() => () => { clearInterval(heartbeat) })',
    '}',
    '',
  ].join('\n'))
  writeFileSync(join(bundleDir, 'witness.mjs'), [
    "import { writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "export const name = 'reload-witness'",
    'export function apply(ctx, config = {}) {',
    "  writeFileSync(join(process.env.DSH_HOME, 'witness'), String(config.generation ?? 'bundle-default'))",
    '}',
    '',
  ].join('\n'))
  writeFileSync(join(bundleDir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: startup-fixture',
    `      name: ${pathToFileURL(join(bundleDir, 'waiting.mjs')).href}`,
    '      inject: [fixtureStartup]',
    '      config:',
    // Lazy interpolation runs only after the provider's service is injected.
    "        generation: !!js ctx.fixtureStartup.generation ?? 'bundle-default'",
    '    - id: fixture-startup',
    `      name: ${pathToFileURL(join(bundleDir, 'startup.mjs')).href}`,
    '    - id: reload-witness',
    `      name: ${pathToFileURL(join(bundleDir, 'witness.mjs')).href}`,
    '',
  ].join('\n'))
  writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
    name: 'dsh-startup-bundle',
    version: '0.0.0',
    type: 'module',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, undefined, 2))
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-startup',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['dsh-startup-bundle'] } },
  }, undefined, 2))
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
  return {
    home,
    ready: join(home, 'ready'),
    echo: join(home, 'config-echo'),
    interrupt: join(home, 'interrupt'),
    witness: join(home, 'witness'),
  }
}

function startStartupProfile(fixture: StartupFixture, args: readonly string[]) {
  return execa(process.execPath, [dshBin, '--profile', 'startup', ...args], {
    cwd: fixture.home,
    input: '',
    reject: false,
    timeout: 25_000,
    killSignal: 'SIGKILL',
    env: {
      DSH_HOME: fixture.home,
      RAW_READY_FILE: fixture.ready,
      RAW_INTERRUPT_FILE: fixture.interrupt,
    },
  })
}

describe.skipIf(!existsSync(dshBin))('dsh BUILT bin (node lib/bin.js, no tsx)', () => {
  it('requires --profile and rejects removed commands', async () => {
    const bare = await runBuiltBin()
    expect(bare.code).toBe(1)
    expect(bare.stdout).toBe('')
    expect(bare.stderr).toContain('--profile <name> is required')
    const help = await runBuiltBin(['--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('dsh --profile web')
    expect(help.stdout).toContain('dsh plugin --profile')
    expect(help.stdout).not.toMatch(/^\s+(?:tui|meta|upgrade)\b/mu)
    for (const removed of [['tui'], ['--config', 'x.yml'], ['-p', 'task'], ['run', 'task']]) {
      const result = await runBuiltBin(removed)
      expect(result.code).toBe(1)
    }
  }, 30_000)

  it('routes help and usage errors without activating startup-dependent rows', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-app-help-'))
    try {
      const web = await runBuiltBin(['--profile', 'web', '--help'], {
        DSH_HOME: home,
        DSH_TELEMETRY_DISABLED: '1',
      })
      expect(web.code).toBe(0)
      expect(web.stderr).toBe('')
      expect(web.stdout).toContain('Usage: dsh --profile web')
      expect(web.stdout).toContain('--port <port>')
      expect(web.stdout).not.toContain('dsh web: http://')

      const wildcardHost = await runBuiltBin(['web', '--host', '0.0.0.0'], {
        DSH_HOME: home,
        DSH_TELEMETRY_DISABLED: '1',
      })
      expect(wildcardHost.code).toBe(1)
      expect(wildcardHost.stdout).toBe('')
      expect(wildcardHost.stderr).toContain('--host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead')
      expect(wildcardHost.stderr).not.toContain('dsh web: http://')

      const headlessHelp = await runBuiltBin(['--profile', 'headless', '--help'], {
        DSH_HOME: home,
        DSH_TELEMETRY_DISABLED: '1',
      })
      expect(headlessHelp.code).toBe(0)
      expect(headlessHelp.stderr).toBe('')
      expect(headlessHelp.stdout).toContain('Usage: dsh --profile headless')

      const missingTask = await runBuiltBin(['--profile', 'headless'], {
        DSH_HOME: home,
        DSH_TELEMETRY_DISABLED: '1',
      })
      expect(missingTask.code).toBe(1)
      expect(missingTask.stderr).toContain('a task is required')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)

  it('runs the headless profile through its app-owned task positional', async () => {
    const apiKey = 'built-dsh-headless-key'
    const server = await startMockLlmServer({
      sequence: ['success'],
      apiKey,
      successText: 'published headless profile reached the mock',
    })
    const home = mkdtempSync(join(tmpdir(), 'dsh-built-headless-'))
    try {
      const result = await runBuiltBin(['--profile', 'headless', 'answer', 'from', 'the', 'published', 'entry'], {
        DSH_HOME: home,
        DSH_TELEMETRY_DISABLED: '1',
        DEEPSEEK_API_KEY: apiKey,
        DEEPSEEK_BASE_URL: server.baseURL,
      })
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toBe('published headless profile reached the mock')
      expect(result.stderr).toBe('')
      expect(server.requests.length).toBeGreaterThan(0)
      expect(server.requests.every(request => request.path === '/chat/completions')).toBe(true)
      expect(JSON.stringify(server.requests.map(request => request.body))).toContain('answer from the published entry')
    } finally {
      await server.close()
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)

  it('does not load a project environment for --version', async () => {
    const project = mkdtempSync(join(tmpdir(), 'dsh-version-project-'))
    writeFileSync(join(project, '.env'), 'PATH=/project-only-path\n')
    try {
      const result = await runBuiltBin(['--version'], {}, project)
      expect(result).toEqual({ code: 0, stdout: cliVersion, stderr: '' })
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  it('fails loud on a nonexistent profile with the plugin-command hint', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-missing-profile-'))
    try {
      const result = await runBuiltBin(['--profile', 'nope'], { DSH_HOME: home })
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('profile "nope" does not exist')
      expect(result.stderr).toContain('dsh plugin --profile nope add')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)

  it('uses the launching endpoint and managed credential through the published entry', async () => {
    const apiKey = 'built-home-layer-key'
    const server = await startMockLlmServer({
      sequence: ['success'],
      apiKey,
      successText: 'launching endpoint reached the mock',
    })
    const home = mkdtempSync(join(tmpdir(), 'dsh-home-environment-'))
    const project = mkdtempSync(join(tmpdir(), 'dsh-home-project-'))
    writeFileSync(join(home, '.credentials.yaml'), `DEEPSEEK_API_KEY: ${apiKey}\n`, { mode: 0o600 })
    createEnvironmentProbeProfile(home, project)
    try {
      const result = await runBuiltBin(
        ['--profile', 'environment-probe'],
        {
          DSH_HOME: home,
          DSH_TELEMETRY_DISABLED: '1',
          DEEPSEEK_API_KEY: undefined,
          DEEPSEEK_BASE_URL: server.baseURL,
        },
        project,
      )
      expect(
        result.code,
        `${result.stderr}\nstdout:\n${result.stdout}\nmock requests: ${String(server.requests.length)}`,
      ).toBe(0)
      expect(result.stdout).toBe('launching endpoint reached the mock')
      expect(result.stdout).not.toContain(apiKey)
      expect(result.stderr).not.toContain(apiKey)
      expect(server.requests).toHaveLength(1)
      expect(server.requests[0]?.path).toBe('/chat/completions')
      expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${apiKey}`)
      expect(JSON.stringify(server.requests[0]?.body)).not.toContain(apiKey)
    } finally {
      await server.close()
      rmSync(home, { recursive: true, force: true })
      rmSync(project, { recursive: true, force: true })
    }
  }, 30_000)

  it('reports a patch-overlay boot failure without hanging', async () => {
    // The HMR main watcher's initial scan once refreshed the include
    // mid-initial-apply, deadlocking the failing apply's rollback against the
    // refresh drain: dsh exited 13 with no diagnostic instead of settling
    // ([Agent Note](../../../.agents/notes/implemented/bug-fix/2026-08-03-hmr-initial-scan-boot-deadlock.md)).
    const home = mkdtempSync(join(tmpdir(), 'dsh-invalid-patch-'))
    try {
      const result = await runBuiltBin(['--profile', 'web', '--patch', invalidProvider], {
        DSH_HOME: home,
        DEEPSEEK_API_KEY: 'keyless-invalid-config',
        DSH_TELEMETRY_DISABLED: '1',
      })
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('llm-pi-ai')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)

  it('lets a profile without a parser ignore app arguments and dispose on a startup-time signal', async () => {
    const fixture = createProfileLifecycleFixture()
    const child = startProfileLifecycle(fixture, ['--unclaimed'])
    try {
      await waitForFile(fixture.ready)
      requestProfileShutdown(child, fixture)
      const result = await child
      expect(result.exitCode, `${result.stderr}\nstdout:\n${result.stdout}\nsignal: ${String(result.signal)}`).toBe(0)
      expect(result.signal).toBeUndefined()
      expect(existsSync(fixture.disposed)).toBe(true)
    } finally {
      child.kill('SIGKILL')
      rmSync(fixture.home, { recursive: true, force: true })
    }
  }, 30_000)

  it('boots shipped bundle layers in safe mode without reading or changing invalid user patches', async () => {
    const fixture = createProfileLifecycleFixture()
    const profilePatch = join(fixture.home, 'profiles', 'lifecycle', 'cordis.patch.yml')
    const homePatch = join(fixture.home, 'cordis.patch.yml')
    const invalidProfile = 'invalid: [profile\n'
    const invalidHome = 'invalid: [home\n'
    writeFileSync(profilePatch, invalidProfile)
    writeFileSync(homePatch, invalidHome)
    const child = startProfileLifecycle(fixture, ['--safe-mode'])
    try {
      await waitForFile(fixture.ready)
      requestProfileShutdown(child, fixture)
      const result = await child
      expect(result.exitCode, `${result.stderr}\nstdout:\n${result.stdout}\nsignal: ${String(result.signal)}`).toBe(0)
      expect(readFileSync(profilePatch, 'utf8')).toBe(invalidProfile)
      expect(readFileSync(homePatch, 'utf8')).toBe(invalidHome)
    } finally {
      child.kill('SIGKILL')
      rmSync(fixture.home, { recursive: true, force: true })
    }
  }, 30_000)

  it('fully settles a custom profile, hot-reloads its patch layer with removal reverting, and disposes on a signal', async () => {
    const fixture = createProfileLifecycleFixture()
    const child = startProfileLifecycle(fixture)
    const profilePatch = join(fixture.home, 'profiles', 'lifecycle', 'cordis.patch.yml')
    const configFile = join(fixture.home, 'config-echo')
    try {
      await waitForFile(fixture.settled)
      // The live profile layer: even without an hmr row in the composition,
      // the launcher mounts a config-only watcher, so an edited
      // cordis.patch.yml lands in the running tree (the reload disposes the
      // patched row's old fiber — observable as the disposed marker — and
      // mounts the new config, which echoes its generation and re-writes the
      // ready marker).
      rmSync(fixture.ready)
      writeFileSync(profilePatch, [
        '- id: profile-lifecycle-fixture',
        '  config:',
        '    generation: 2',
        '',
      ].join('\n'))
      await waitForFile(fixture.ready)
      expect(readFileSync(configFile, 'utf8')).toBe('2')
      // Removal reverts: the bundle's inserted row must return to its own
      // default config, not keep the removed override — the insert-aliasing
      // regression (a shared patch object mutated in place by a former
      // generation would make this impossible).
      rmSync(fixture.ready)
      writeFileSync(profilePatch, '[]\n')
      await waitForFile(fixture.ready)
      expect(readFileSync(configFile, 'utf8')).toBe('bundle-default')
      // The home-level user layer ($DSH_HOME/cordis.patch.yml) is live too
      // and outranks the per-profile layer.
      rmSync(fixture.ready)
      writeFileSync(join(fixture.home, 'cordis.patch.yml'), [
        '- id: profile-lifecycle-fixture',
        '  config:',
        '    generation: home',
        '',
      ].join('\n'))
      await waitForFile(fixture.ready)
      expect(readFileSync(configFile, 'utf8')).toBe('home')
      requestProfileShutdown(child, fixture)
      const result = await child
      expect(result.exitCode, `${result.stderr}\nstdout:\n${result.stdout}\nsignal: ${String(result.signal)}`).toBe(0)
      expect(result.signal).toBeUndefined()
      expect(existsSync(fixture.disposed)).toBe(true)
    } finally {
      child.kill('SIGKILL')
      rmSync(fixture.home, { recursive: true, force: true })
    }
  }, 30_000)

  it('hands the app arguments to the profile, which applies them before its rows start', async () => {
    const fixture = createStartupFixture()
    const child = startStartupProfile(fixture, ['--generation', 'flagged'])
    try {
      await waitForFile(fixture.ready)
      // The consumer started once, already carrying the flag value: the
      // launcher never saw --generation, and the app provider resolved it first.
      expect(readFileSync(fixture.echo, 'utf8')).toBe('flagged')
      requestProfileShutdown(child, fixture)
      expect((await child).exitCode).toBe(0)
    } finally {
      child.kill('SIGKILL')
      rmSync(fixture.home, { recursive: true, force: true })
    }
  }, 30_000)

  it('starts a consumer on its composed value when the invocation carries no app arguments', async () => {
    const fixture = createStartupFixture()
    const child = startStartupProfile(fixture, [])
    try {
      await waitForFile(fixture.ready)
      expect(readFileSync(fixture.echo, 'utf8')).toBe('bundle-default')
      requestProfileShutdown(child, fixture)
      expect((await child).exitCode).toBe(0)
    } finally {
      child.kill('SIGKILL')
      rmSync(fixture.home, { recursive: true, force: true })
    }
  }, 30_000)

  it('keeps the app arguments across a user patch reload', async () => {
    // A live edit recomposes every row while the provider service remains
    // active, so each config expression reads the same invocation value (a
    // served port does not move back to its composed fallback).
    const fixture = createStartupFixture()
    const profilePatch = join(fixture.home, 'profiles', 'startup', 'cordis.patch.yml')
    const child = startStartupProfile(fixture, ['--generation', 'flagged'])
    try {
      // Both rows: the waiting one carries the flag value, and the witness is
      // what a reload will re-mount. They start independently, so neither
      // marker implies the other.
      await waitForFile(fixture.ready)
      await waitForFile(fixture.witness)
      expect(readFileSync(fixture.echo, 'utf8')).toBe('flagged')
      // An edit to an unrelated row: the witness re-mounts, which is how this
      // test knows the whole tree was recomposed.
      rmSync(fixture.witness)
      writeFileSync(profilePatch, [
        '- id: reload-witness',
        '  config:',
        '    generation: reloaded',
        '',
      ].join('\n'))
      await waitForFile(fixture.witness)
      expect(readFileSync(fixture.witness, 'utf8')).toBe('reloaded')
      expect(readFileSync(fixture.echo, 'utf8')).toBe('flagged')
      requestProfileShutdown(child, fixture)
      expect((await child).exitCode).toBe(0)
    } finally {
      child.kill('SIGKILL')
      rmSync(fixture.home, { recursive: true, force: true })
    }
  }, 30_000)

  it("prints the app's own help, starts none of its rows, and exits", async () => {
    const fixture = createStartupFixture()
    try {
      const result = await startStartupProfile(fixture, ['--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Usage: fixture')
      expect(result.stdout).toContain('--generation')
      expect(existsSync(fixture.ready)).toBe(false)
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  }, 30_000)

  it('anchors a relative add spec to the invoking directory, not the profile', async () => {
    // `dsh plugin --profile x add .` from a plugin checkout must install THAT
    // checkout — pnpm's cwd is the profile directory, so an un-anchored `.`
    // would self-link the profile.
    const home = mkdtempSync(join(tmpdir(), 'dsh-plugin-anchor-'))
    const checkout = mkdtempSync(join(tmpdir(), 'dsh-plugin-checkout-'))
    try {
      writeFileSync(join(checkout, 'package.json'), JSON.stringify({
        name: 'anchored-bundle',
        version: '1.0.0',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }))
      writeFileSync(join(checkout, 'cordis.patch.yml'), '[]\n')
      const result = await execa(process.execPath, [dshBin, 'plugin', '--profile', 'anchor', 'add', '.'], {
        cwd: checkout,
        input: '',
        timeout: 60_000,
        killSignal: 'SIGKILL',
        reject: false,
        env: { DSH_HOME: home },
      })
      expect(result.exitCode).toBe(0)
      const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'anchor', 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>
        dsh: { profile: { bundles: string[] } }
      }
      expect(Object.keys(manifest.dependencies)).toEqual(['anchored-bundle'])
      expect(manifest.dsh.profile.bundles).toContain('anchored-bundle')
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(checkout, { recursive: true, force: true })
    }
  }, 90_000)

  it('activates a dependency that gained dsh.bundle in a later update', async () => {
    // Reconcile runs against the INSTALLED state on every successful pnpm
    // run, so `update` (not only `add`) activates a package whose newer
    // version declares dsh.bundle. Simulated without a registry: hand-place
    // the installed package, flip its manifest, and run a benign pnpm verb.
    const home = mkdtempSync(join(tmpdir(), 'dsh-plugin-update-'))
    try {
      const profileDir = join(home, 'profiles', 'up')
      const installed = join(profileDir, 'node_modules', 'late-bundle')
      mkdirSync(installed, { recursive: true })
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-up',
        private: true,
        dependencies: { 'late-bundle': 'file:./late-bundle' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      }))
      writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
      // v1: no dsh manifest — a plain dependency.
      writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'late-bundle', version: '1.0.0' }))
      const first = await runBuiltBin(['plugin', '--profile', 'up', 'root'], { DSH_HOME: home })
      expect(first.code).toBe(0)
      let manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
      expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base'])
      // v2: the installed package now declares dsh.bundle (an update landed).
      writeFileSync(join(installed, 'package.json'), JSON.stringify({
        name: 'late-bundle', version: '2.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
      }))
      writeFileSync(join(installed, 'cordis.patch.yml'), '[]\n')
      const second = await runBuiltBin(['plugin', '--profile', 'up', 'root'], { DSH_HOME: home })
      expect(second.code).toBe(0)
      manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
      expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'late-bundle'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)

  describe('config dump', () => {
    let home: string
    beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dsh-dump-bin-')) })
    afterEach(() => { rmSync(home, { recursive: true, force: true }) })

    it('prints the web profile bundle layers without a user layer', async () => {
      const { stdout, code, stderr } = await runBuiltBin(['--profile', 'web', '--dump-default-config'], { DSH_HOME: home })
      expect(code).toBe(0)
      expect(stderr).toBe('')
      expect(stdout).toContain("name: '@deepseek-ai/dsh-agent-loop'")
      expect(stdout).toContain('agents: []')
      expect(stdout).toContain('# == @deepseek-ai/dsh-base')
      expect(stdout).toContain("name: '@deepseek-ai/dsh-host-webserver'")
    }, 30_000)

    it('prints the headless profile without Host or browser layers', async () => {
      const { stdout, code, stderr } = await runBuiltBin(
        ['--profile', 'headless', '--dump-default-config'],
        { DSH_HOME: home },
      )
      expect(code).toBe(0)
      expect(stderr).toBe('')
      expect(stdout).toContain("name: '@deepseek-ai/dsh-headless'")
      expect(stdout).not.toMatch(/name: '@deepseek-ai\/dsh-host-/)
      expect(stdout).not.toContain("name: '@deepseek-ai/dsh-web-app'")
      expect(stdout).not.toMatch(/name: '@deepseek-ai\/dsh-client-/)
    }, 30_000)

    it('composes the profile user layer and a --patch overlay in order', async () => {
      // Auto-init the web profile first, then write its user layer.
      const init = await runBuiltBin(['--profile', 'web', '--dump-default-config'], { DSH_HOME: home })
      expect(init.code).toBe(0)
      const profilePatch = join(home, 'profiles', 'web', 'cordis.patch.yml')
      writeFileSync(profilePatch, [
        '- id: agent-loop',
        '  config:',
        '    agents:',
        '      - id: personal',
        '        provider: personal-provider',
        '        model: personal-model',
        '- id: absent-row',
        '  config:',
        '    x: 1',
        '',
      ].join('\n'))
      const overlay = join(home, 'overlay.cordis.yml')
      writeFileSync(overlay, [
        '- id: agent-loop',
        '  config:',
        '    agents:',
        '      - id: configured',
        '        provider: configured-provider',
        '        model: configured-model',
        '',
      ].join('\n'))
      const { stdout, code, stderr } = await runBuiltBin(
        ['--profile', 'web', '--patch', overlay, '--dump-config'],
        { DSH_HOME: home },
      )
      expect(code).toBe(0)
      expect(stdout).toContain('provider: configured-provider')
      expect(stdout).not.toContain('personal-provider')
      // Both layers patched the row; the comment lists them in application order.
      expect(stdout).toContain(`patched by ${profilePatch}, ${overlay}`)
      expect(stderr).toContain('patch: entry "absent-row" not found')
    }, 30_000)
  })
})

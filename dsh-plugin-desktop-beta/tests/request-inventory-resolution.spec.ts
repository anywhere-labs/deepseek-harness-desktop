import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('prepares request inventory for Desktop-owned entries and private-manifest plugins', () => {
  const require = createRequire(import.meta.url)
  const script = `
    import assert from 'node:assert/strict';
    import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const { apply } = await import(pathToFileURL(process.argv[1]).href);
    const { installProfilePackageResolver } = await import(pathToFileURL(process.argv[2]).href);
    const desktop = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    const root = mkdtempSync(join(tmpdir(), 'desktop-inventory-'));
    let release;
    try {
      writeFileSync(join(root, 'package.json'), '{"type":"module"}');
      const baseUrl = pathToFileURL(join(root, 'package.json')).href;
      let warnings = [];
      const collect = async names => {
        let provider;
        warnings = [];
        const tree = { ctx: { baseUrl }, entries: () => names.map(name => ({
          options: { name }, fiber: { state: 2 }, parent: { tree }
        })) };
        // 0.1.6 asks the Host for the active package index. A standalone
        // Profile has none, which keeps the upstream filesystem lookup.
        apply({ baseUrl, get: () => undefined, loader: tree,
          logger: { warn: (format, name, error) => { warnings.push(String(error?.message ?? error)); } },
          deepseekLlmApiExtensions: {
          register: (key, value) => { assert.equal(key, 'dsh_plugin_packages'); provider = value; }
        } }, {});
        return (await provider.prepare({})).value.packages;
      };
      // dsh 0.2.1-alpha.2 omits an unresolvable package with one warning
      // instead of failing the whole request.
      const omitted = async (names, pattern) => {
        assert.deepEqual(await collect(names), []);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], pattern);
      };
      // A standalone Profile has no physical copy of the Desktop package.
      await omitted([desktop.name], /cannot resolve active package/);
      release = installProfilePackageResolver(baseUrl);
      assert.deepEqual(await collect([
        desktop.name, desktop.name + '/terminal', desktop.name + '/pnpm',
        desktop.name + '/diagnostics', desktop.name + '/notifications',
        desktop.name + '/profiles', desktop.name + '/updates'
      ]), [{ name: desktop.name, version: desktop.version }]);
      const plugin = join(root, 'node_modules', 'private-manifest-plugin');
      mkdirSync(plugin, { recursive: true });
      writeFileSync(join(plugin, 'package.json'), JSON.stringify({
        name: 'private-manifest-plugin', version: '1.2.3', exports: './index.js'
      }));
      writeFileSync(join(plugin, 'index.js'), 'throw new Error("inventory evaluated plugin")');
      assert.deepEqual(await collect(['private-manifest-plugin']), [{ name: 'private-manifest-plugin', version: '1.2.3' }]);
      await omitted(['inventory-nonexistent-package'], /cannot resolve.*package/);
      writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'private-manifest-plugin', exports: './index.js' }));
      // 0.2.1-alpha.2 reports a named package without a version instead of rejecting it.
      assert.deepEqual(await collect(['private-manifest-plugin']), [{ name: 'private-manifest-plugin' }]);
      assert.deepEqual(warnings, []);
      release(); release = undefined;
      await omitted([desktop.name], /cannot resolve active package/);
      console.log('request inventory passed');
    } finally { release?.(); rmSync(root, { recursive: true, force: true }); }
  `
  const output = execFileSync(process.execPath, [
    '--input-type=module', '-e', script,
    require.resolve('@deepseek-ai/dsh-plugin-package-inventory-deepseek'),
    fileURLToPath(new URL('../src/module-resolution.ts', import.meta.url)),
    fileURLToPath(new URL('../package.json', import.meta.url)),
  ], { encoding: 'utf8', timeout: 30_000 })
  expect(output).toContain('request inventory passed')
})

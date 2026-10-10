/** Exercise the installed official DevTools reload path without Electron or a Host. */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
const ts = createRequire(resolve('dsh-plugin-desktop-beta/package.json'))('typescript')

function nodes(file, predicate) {
  const matches = []
  const visit = node => {
    if (predicate(node)) matches.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return matches
}

for (const workspace of ['dsh-plugin-desktop-beta', 'dsh-desktop-next']) {
  test(`${workspace}: official Reload DevTools completes through the hosted embedder callback`, () => {
    const require = createRequire(resolve(workspace, 'package.json'))
    const manifest = require.resolve('@deepseek-ai/dsh-experimental-inspector/package.json')
    assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).version, '0.2.1-alpha.2')
    const directory = join(dirname(manifest), 'lib/devtools/chunks')
    const parse = (prefix, marker) => {
      const files = readdirSync(directory).filter(name => name.startsWith(prefix + '-') && name.endsWith('.js')
        && readFileSync(join(directory, name), 'utf8').includes(marker))
      assert.equal(files.length, 1, `Expected one official ${prefix} chunk`)
      return ts.createSourceFile(files[0], readFileSync(join(directory, files[0]), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    }
    const legacy = parse('legacy', 'reattach(')
    const methods = nodes(legacy, node => ts.isMethodDeclaration(node) && node.name.getText(legacy) === 'reattach')
    assert.equal(methods.length, 1)
    // Use the installed method itself, not a fixture reproducing the patch.
    const host = runInNewContext(`({ ${methods[0].getText(legacy)} })`)
    let completions = 0
    host.reattach(() => { completions++ })
    assert.equal(completions, 1)

    const common = parse('common', '/ui/legacy/components/utils/Reload.ts')
    const calls = nodes(common, node => ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'reattach'
      && node.arguments.length === 1 && node.arguments[0].getText(common).includes('window.location.reload()'))
    assert.equal(calls.length, 1, 'Official Reload DevTools must still use the expected embedder contract')
    const receiver = calls[0].expression.expression
    assert.ok(ts.isIdentifier(receiver))
    let reloads = 0
    runInNewContext(calls[0].getText(common), {
      [receiver.text]: host, window: { location: { reload() { reloads++ } } },
    })
    assert.equal(reloads, 1, 'Clicking reload must reload the frontend document')

  })
}

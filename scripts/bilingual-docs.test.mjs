import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import {
  parseBilingualRecord,
  verifyBilingualRecords,
} from './bilingual-docs.mjs'

test('parses exactly two Markdown blob records', () => {
  assert.deepEqual(parseBilingualRecord('docs/topic.i18n.yaml', [
    '# Both languages carry equal authority.',
    `topic.md: ${'a'.repeat(40)}`,
    `topic.zh.md: ${'b'.repeat(40)}`,
    '',
  ].join('\n')), [
    { filename: 'topic.md', hash: 'a'.repeat(40) },
    { filename: 'topic.zh.md', hash: 'b'.repeat(40) },
  ])
})

test('rejects malformed, incomplete, and escaping bilingual records', () => {
  assert.throws(
    () => parseBilingualRecord('docs/topic.i18n.yaml', `topic.md: ${'a'.repeat(40)}\n`),
    /exactly two/u,
  )
  assert.throws(
    () => parseBilingualRecord('docs/topic.i18n.yaml', `topic.md = ${'a'.repeat(40)}\ntopic.zh.md: ${'b'.repeat(40)}\n`),
    /not a filename/u,
  )
  assert.throws(
    () => parseBilingualRecord('docs/topic.i18n.yaml', `../topic.md: ${'a'.repeat(40)}\ntopic.zh.md: ${'b'.repeat(40)}\n`),
    /beside the record/u,
  )
})

test('verifies every recorded document hash', () => {
  const root = resolve('repository')
  const recordPath = 'docs/topic.i18n.yaml'
  const record = `topic.md: ${'a'.repeat(40)}\ntopic.zh.md: ${'b'.repeat(40)}\n`
  const reads = new Map([
    [resolve(root, recordPath), record],
    [resolve(root, 'docs/topic.md'), 'English'],
    [resolve(root, 'docs/topic.zh.md'), 'Chinese'],
  ])
  const result = verifyBilingualRecords({
    root,
    recordPaths: [recordPath],
    readText: path => {
      const value = reads.get(path)
      if (value === undefined) throw new Error(`missing ${path}`)
      return value
    },
    hashDocument: path => path.endsWith('.zh.md') ? 'b'.repeat(40) : 'a'.repeat(40),
  })
  assert.deepEqual(result, { recordCount: 1, documentCount: 2 })
  assert.throws(() => verifyBilingualRecords({
    root,
    recordPaths: [recordPath],
    readText: path => reads.get(path) ?? '',
    hashDocument: () => 'c'.repeat(40),
  }), /is stale/u)
})

test('reports malformed records and missing documents in one failure', () => {
  const root = resolve('repository')
  const records = new Map([
    [resolve(root, 'docs/broken.i18n.yaml'), 'not a record\n'],
    [resolve(root, 'docs/missing.i18n.yaml'), [
      `missing.md: ${'a'.repeat(40)}`,
      `missing.zh.md: ${'b'.repeat(40)}`,
      '',
    ].join('\n')],
  ])

  assert.throws(() => verifyBilingualRecords({
    root,
    recordPaths: ['docs/broken.i18n.yaml', 'docs/missing.i18n.yaml'],
    readText: path => {
      const value = records.get(path)
      if (value === undefined) throw new Error(`missing ${path}`)
      return value
    },
    hashDocument: () => 'a'.repeat(40),
  }), /broken\.i18n\.yaml:1[\s\S]*cannot verify docs\/missing\.md[\s\S]*cannot verify docs\/missing\.zh\.md/u)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAccessTokenResolver } from './oauth-session.js'

function fixture(expiresAt = 0) {
  let record = { kind: 'grant', payload: { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt } }
  let queue = Promise.resolve()
  const credentials = {
    modifyRecord(key, mutate) {
      assert.equal(key, 'anywhere-gateway/session')
      const operation = queue.then(async () => {
        const next = await mutate(record)
        if (next !== undefined) record = next
      })
      queue = operation.catch(() => {})
      return operation
    },
  }
  const next = { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: Math.floor(Date.now() / 1000) + 900 }
  let calls = 0
  const options = { key: 'anywhere-gateway/session', refresh: async token => {
    assert.equal(token, 'old-refresh')
    calls++
    return next
  } }
  return { credentials, options, next, record: () => record, calls: () => calls }
}

test('concurrent expired-token requests rotate once and persist before resolving', async () => {
  const f = fixture()
  const resolve = createAccessTokenResolver(f.options)
  assert.deepEqual(await Promise.all([resolve(f.credentials), resolve(f.credentials)]), ['new-access', 'new-access'])
  assert.equal(f.calls(), 1)
  assert.deepEqual(f.record().payload, f.next)
})

test('concurrent and delayed 401 responses share the replacement token', async () => {
  const f = fixture(Math.floor(Date.now() / 1000) + 900)
  const resolve = createAccessTokenResolver(f.options)
  assert.deepEqual(await Promise.all([
    resolve(f.credentials, 'old-access'), resolve(f.credentials, 'old-access'),
  ]), ['new-access', 'new-access'])
  assert.equal(await resolve(f.credentials, 'old-access'), 'new-access')
  assert.equal(f.calls(), 1)
})

test('a 401 concurrent with a normal read still replaces the rejected token', async () => {
  const f = fixture(Math.floor(Date.now() / 1000) + 900)
  const resolve = createAccessTokenResolver(f.options)
  assert.deepEqual(await Promise.all([resolve(f.credentials), resolve(f.credentials, 'old-access')]), ['old-access', 'new-access'])
  assert.equal(f.calls(), 1)
})

test('independent resolvers re-read credentials inside the provider lock', async () => {
  const f = fixture()
  const first = createAccessTokenResolver(f.options)
  const second = createAccessTokenResolver(f.options)
  assert.deepEqual(await Promise.all([first(f.credentials), second(f.credentials)]), ['new-access', 'new-access'])
  assert.equal(f.calls(), 1)
})

test('refresh failure is shared, preserves credentials, and releases the pending operation', async () => {
  const f = fixture()
  const failure = Object.assign(new Error('invalid grant'), { code: 'invalid_grant' })
  let calls = 0
  const resolve = createAccessTokenResolver({ ...f.options, refresh: async () => { calls++; throw failure } })
  const results = await Promise.allSettled([resolve(f.credentials), resolve(f.credentials)])
  for (const result of results) {
    assert.equal(result.status, 'rejected')
    assert.equal(result.reason, failure)
  }
  assert.equal(calls, 1)
  assert.equal(f.record().payload.refreshToken, 'old-refresh')
  await assert.rejects(resolve(f.credentials), error => error === failure)
  assert.equal(calls, 2)
})

test('signed-out credentials do not trigger refresh or recreate a grant', async () => {
  const f = fixture()
  const resolve = createAccessTokenResolver(f.options)
  assert.equal(await resolve(undefined), undefined)
  assert.equal(await resolve({ modifyRecord: async (_key, mutate) => {
    assert.equal(await mutate(undefined), undefined)
  } }), undefined)
  assert.equal(f.calls(), 0)
})

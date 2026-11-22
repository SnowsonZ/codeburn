import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { quotaServer } from './quota-bridge.mjs'

test('private endpoint projects only quota fields and fails closed without a usable snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeburn-quota-test-'))
  const file = join(dir, 'snapshot.json')
  const key = randomBytes(32).toString('hex')
  const server = quotaServer(key, file).listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const url = `http://127.0.0.1:${server.address().port}/codeburn-quota`
    const headers = { Authorization: `Bearer ${key}` }
    assert.equal((await fetch(url)).status, 401)
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer ' + '0'.repeat(64) } })).status, 401)
    assert.equal((await fetch(url, { method: 'POST', headers })).status, 405)
    assert.equal((await fetch(url + '?all=true', { headers })).status, 404)
    assert.equal((await fetch(url, { headers })).status, 503)
    const usageUrl = new URL('/codeburn-usage', url)
    const artUrl = new URL('/codeburn-vinyl/light-18.png', url)
    const snapshotUrl = new URL('/codeburn-snapshot', url)
    assert.equal((await fetch(snapshotUrl)).status, 401)
    assert.equal((await fetch(usageUrl)).status, 401)
    assert.equal((await fetch(artUrl)).status, 401)
    const art = await fetch(artUrl, { headers })
    assert.equal(art.status, 200)
    assert.equal(art.headers.get('content-type'), 'image/png')
    assert.equal(Buffer.from(await art.arrayBuffer()).subarray(1, 4).toString(), 'PNG')

    const updatedAt = '2026-11-20T01:00:00.000Z'
    const agents = ['codex', 'zcode', 'antigravity']
    const generation = {
      version: 1, updatedAt, usage: {
        sessions: ['example'], updatedAt, day: '2026-11-20',
        agents: agents.map((id, i) => ({ id, tokens: i ? 0 : 500, input: i ? 0 : 400, cached: i ? 0 : 350, extra: 'discard' })),
        days: Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-${14 + i}`, tokens: i === 6 ? 500 : 0, extra: 'discard' })),
      },
      quota: { updatedAt, agents: agents.map((id, i) => ({
        id, extra: 'discard',
        windows: [{ label: 'Weekly', percent: [0.56, 0, 1][i], resetsAt: null, extra: 'discard' }],
      })) },
    }
    const save = async value => writeFile(file, JSON.stringify(value), { mode: 0o600 })
    await save({ ...generation, updatedAt: undefined })
    assert.equal((await fetch(snapshotUrl, { headers })).status, 503) // matching legacy block timestamps insufficient
    await save({ ...generation, quota: { ...generation.quota, updatedAt: '2026-11-19T00:00:00Z' } })
    assert.equal((await fetch(snapshotUrl, { headers })).status, 503)
    await save({ ...generation, quota: { ...generation.quota, agents: generation.quota.agents.slice(1) } })
    assert.equal((await fetch(snapshotUrl, { headers })).status, 503)
    await save({ ...generation, quota: { ...generation.quota, agents: generation.quota.agents.map((agent, i) => ({ ...agent, stale: !i })) } })
    assert.equal((await fetch(snapshotUrl, { headers })).status, 503)
    await save({ ...generation, usage: { ...generation.usage, agents: generation.usage.agents.map((agent, i) => ({ ...agent, cached: i ? 0 : null })) } })
    assert.equal((await fetch(snapshotUrl, { headers })).status, 503)

    await save(generation)
    const response = await fetch(url, { headers })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const quota = await response.json()
    assert.deepEqual(quota, {
      version: 1, updatedAt,
      agents: agents.map((id, i) => ({ id, stale: false, windows: [{ label: 'Weekly', percent: [0.56, 0, 1][i], resetsAt: null }] })),
    })
    const usageResponse = await fetch(usageUrl, { headers })
    assert.equal(usageResponse.status, 200)
    const usage = await usageResponse.json()
    assert.deepEqual(usage, {
      version: 1, updatedAt, day: '2026-11-20',
      agents: agents.map((id, i) => ({ id, tokens: i ? 0 : 500, input: i ? 0 : 400, cached: i ? 0 : 350 })),
      days: Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-${14 + i}`, tokens: i === 6 ? 500 : 0 })),
    })
    const complete = await fetch(snapshotUrl, { headers })
    assert.equal(complete.status, 200)
    assert.deepEqual(await complete.json(), { version: 1, updatedAt, usage, quota })
    await chmod(file, 0o644)
    assert.equal((await fetch(url, { headers })).status, 503)
    await chmod(file, 0o600)
    await writeFile(file, JSON.stringify({ version: 1, quota: null }))
    assert.equal((await fetch(url, { headers })).status, 503)
  } finally {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

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

    const updatedAt = '2026-11-20T01:00:00.000Z'
    await writeFile(file, JSON.stringify({
      version: 1, usage: { sessions: ['example'] },
      quota: { updatedAt, agents: [{
        id: 'codex', stale: true, extra: 'discard',
        windows: [{ label: 'Weekly', percent: 0.56, resetsAt: 'bad date', extra: 'discard' }],
      }] },
    }), { mode: 0o600 })
    const response = await fetch(url, { headers })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), {
      version: 1, updatedAt, agents: [
        { id: 'codex', stale: true, windows: [{ label: 'Weekly', percent: 0.56, resetsAt: null }] },
        { id: 'zcode', stale: false, windows: [] },
        { id: 'antigravity', stale: false, windows: [] },
      ],
    })
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

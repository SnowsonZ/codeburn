// Dependency-free focused regression suite; run on Node 22.18+:
// node app/scripts/verify-widget-snapshots.mjs
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'


registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL && !/\.[cm]?[jt]s$/.test(specifier)) {
      for (const candidate of ['.ts', '/index.ts']) {
        const url = new URL(specifier + candidate, context.parentURL)
        if (existsSync(fileURLToPath(url))) return next(url.href, context)
      }
    }
    return next(specifier, context)
  },
})
const { reportWidgetDiagnostic, startWidgetSnapshots, WIDGET_AGENTS } = await import('../electron/widget-snapshot.ts')
const { createWidgetQuotaReader } = await import('../electron/quota/widget-refresh.ts')
const { fetchCodexQuota } = await import('../electron/quota/codex.ts')
const { spawnCli } = await import('../electron/cli.ts')
const { fetchZcodeQuota } = await import('../electron/quota/zcode.ts')
const base = new Date(2026, 10, 20, 12)
const localDay = '2026-11-20'
const window = { label: 'Weekly', percent: 0, resetsAt: null }
const quota = WIDGET_AGENTS.map(provider => ({ provider, connection: 'connected', primary: window, details: [] }))
const readyQuota = async () => quota
const zeroUsage = async () => ({ history: { daily: [] } })
const usage = inputTokens => ({ history: { daily: [
  { date: localDay, inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
] } })
const forbidden = () => assert.fail('unexpected side effect')
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { resolve, reject, promise }
}
async function until(fn) {
  for (let n = 0; n < 200; n++) { if (await fn()) return; await sleep(5) }
  assert.fail('did not reach expected state')
}
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'codeburn-widget-atomic-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const dir = path.join(home, 'Library', 'Containers', 'local.codeburn.bigmodel.widgets', 'Data', 'Library', 'Application Support', 'CodeBurn Widgets')
  await mkdir(dir, { recursive: true })
  const bytes = () => readFile(path.join(dir, 'snapshot.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  const snapshot = async () => JSON.parse(await bytes())
  const start = (u, q, opts = {}) => {
    const stop = startWidgetSnapshots(home, u, q, { now: () => base, ...opts })
    t.after(stop)
    return stop
  }
  return { home, dir, bytes, snapshot, start }
}
function assertComplete(snapshot) {
  assert.equal(snapshot.version, 1)
  assert.equal(snapshot.updatedAt, snapshot.usage.updatedAt)
  assert.equal(snapshot.updatedAt, snapshot.quota.updatedAt)
  assert.deepEqual(snapshot.usage.agents.map(row => row.id), WIDGET_AGENTS)
  assert.deepEqual(snapshot.quota.agents.map(row => row.id), WIDGET_AGENTS)
  assert.equal(snapshot.usage.days.length, 7)
}
test('absent until full success; same timestamp, real zero, existing v1 shape', async t => {
  const f = await fixture(t)
  const readerOptions = {
    readBackoff: async () => null,
    poll: {
      codex: async () => ({ quota: quota[0] }),
      zcode: async () => ({ quota: quota[1] }),
      antigravity: async () => ({ quota: quota[2] }),
    },
  }
  let failed
  const bad = f.start(zeroUsage, async () => { failed = true; throw Error('fixture failure') })
  await until(() => failed)
  assert.equal(await f.bytes(), null)
  bad()
  f.start(zeroUsage, createWidgetQuotaReader(readerOptions))
  await until(f.bytes)
  const snap = await f.snapshot()
  assertComplete(snap)
  assert.equal(snap.updatedAt, base.toISOString())
  assert.deepEqual(snap.usage.agents.map(row => row.tokens), [0, 0, 0])
  assert.deepEqual(snap.quota.agents.map(row => row.windows[0].percent), [0, 0, 0])

  const observed = await fixture(t)
  const diagnostic = () => {}
  observed.start(zeroUsage, createWidgetQuotaReader({ ...readerOptions, diagnostic }), { diagnostic })
  await until(observed.bytes)
  assert.equal(await observed.bytes(), await f.bytes())
})
test('allowlisted diagnostics retain exact old bytes and isolate throwing or rejecting sinks', async t => {
  const f = await fixture(t)
  const reasons = []
  const diagnostic = reason => {
    reasons.push(reason)
    if (reason.stage === 'write') return Promise.reject(Error('private sink error'))
    throw Error('private sink error')
  }
  const seed = f.start(zeroUsage, readyQuota, { diagnostic })
  await until(() => reasons.some(reason => reason.stage === 'write'))
  assert.deepEqual(reasons.splice(0), [
    { stage: 'startup', result: 'started' },
    { stage: 'container', result: 'ready' },
    { stage: 'write', result: 'success' },
  ])
  const full = await f.snapshot()
  assertComplete(full)
  seed()
  const { updatedAt: _envelope, ...legacy } = full
  legacy.quota.agents[2].windows = []
  const file = path.join(f.dir, 'snapshot.json')
  const baseline = JSON.stringify(legacy)
  await writeFile(file, baseline)
  const { mtimeMs } = await stat(file)
  const assertRetained = async () => {
    assert.equal(await f.bytes(), baseline)
    assert.equal((await stat(file)).mtimeMs, mtimeMs)
  }

  const later = { now: () => new Date(base.getTime() + 1_000), diagnostic }
  const cases = [
    [() => { throw Object.assign(Error('private usage path'), { code: 'private value' }) }, readyQuota,
      { stage: 'usage', result: 'failed', provider: 'codex' }],
    [zeroUsage, async () => [quota[0], quota[1], { ...quota[2], primary: null }],
      { stage: 'quota', result: 'no_usable_windows', provider: 'antigravity' }],
    [zeroUsage, async () => [quota[0], quota[1], { ...quota[2], details: [{ ...window, percent: 0.5 }] }],
      { stage: 'quota', result: 'validation_collision', provider: 'antigravity' }],
  ]
  for (const [readUsage, readQuota, expected] of cases) {
    const stop = f.start(readUsage, readQuota, later)
    await until(() => reasons.length >= 3)
    assert.deepEqual(reasons.splice(0).slice(2), [expected])
    await assertRetained()
    stop()
  }
  const stop = f.start(zeroUsage, readyQuota, { diagnostic })
  await until(() => reasons.length >= 3)
  assert.deepEqual(reasons.splice(0).slice(2), [{ stage: 'fence', result: 'stale' }])
  await assertRetained()
  stop()

  const clock = t.mock.method(Date, 'now', () => 42)
  await writeFile(path.join(f.dir, `.snapshot.json.${process.pid}.42.tmp`), 'private collision')
  const failed = f.start(zeroUsage, readyQuota, later)
  await until(() => reasons.length >= 3)
  assert.deepEqual(reasons.splice(0).slice(2), [{ stage: 'write', result: 'failed', errno: 'EEXIST' }])
  await assertRetained()
  failed()
  clock.mock.restore()

  const missing = startWidgetSnapshots(path.join(f.home, 'missing'), forbidden, forbidden, { diagnostic })
  t.after(missing)
  await until(() => reasons.length === 2)
  assert.deepEqual(reasons, [
    { stage: 'startup', result: 'started' },
    { stage: 'container', result: 'unavailable', errno: 'ENOENT' },
  ])
  reasons.length = 0
  reportWidgetDiagnostic(diagnostic, { stage: 'write', result: 'failed' }, {
    code: 'private errno', message: 'private path and token',
  })
  assert.deepEqual(reasons, [{ stage: 'write', result: 'failed' }])
})
test('a hung usage read reports the round deadline and preserves the old generation', async t => {
  const f = await fixture(t)
  const seed = f.start(zeroUsage, readyQuota)
  await until(f.bytes)
  const baseline = await f.bytes()
  seed()
  const reasons = []
  f.start(() => deferred().promise, readyQuota, {
    timeoutMs: 20,
    diagnostic: reason => { reasons.push(reason) },
    now: () => new Date(base.getTime() + 1_000),
  })
  await until(() => reasons.some(reason => reason.stage === 'round'))
  assert.deepEqual(reasons.slice(2), [{ stage: 'round', result: 'deadline' }])
  assert.equal(await f.bytes(), baseline)
})
test('old bytes unchanged for timeout; retry succeeds; late work cannot replace recovery', async t => {
  const f = await fixture(t)
  const seed = f.start(zeroUsage, readyQuota)
  await until(f.bytes)
  const baseline = await f.bytes()
  seed()
  const late = deferred(), recovery = deferred()
  let rounds = 0, reads = 0, expired
  f.start(async () => {
    // Round-local usage makes old vs replacement analytically distinguishable.
    return usage(++reads > 3 ? 900 : 100)
  }, async signal => {
    rounds++
    if (rounds === 1) { signal.addEventListener('abort', () => { expired = true }, { once: true }); return late.promise }
    return recovery.promise
  }, { now: () => new Date(base.getTime() + 1_000), timeoutMs: 75, cadenceMs: 10 })
  await until(() => rounds === 1)
  assert.equal(await f.bytes(), baseline)
  await until(() => expired && rounds >= 2)
  assert.equal(await f.bytes(), baseline)
  recovery.resolve(quota)
  await until(async () => (await f.bytes()) !== baseline)
  const recovered = await f.bytes()
  const snap = await f.snapshot()
  assertComplete(snap)
  assert.deepEqual(snap.usage.agents.map(row => row.tokens), [900, 900, 900])
  late.resolve(quota)
  await sleep(25)
  assert.equal(await f.bytes(), recovered)
})
test('degraded quota, a malformed or stale usage report and an explicit failure never overwrite', async t => {
  const f = await fixture(t)
  const seed = f.start(zeroUsage, readyQuota)
  await until(f.bytes)
  const baseline = await f.bytes()
  seed()
  const later = { now: () => new Date(base.getTime() + 10_000) }
  const attempts = [
    [zeroUsage, async () => [...quota.slice(0, 2), { ...quota[2], connection: 'stale' }]],
    [zeroUsage, async () => quota.slice(1)],
    [zeroUsage, async () => [quota[0], quota[1], { ...quota[2], connection: 'disconnected' }]],
    [zeroUsage, async () => [quota[0], quota[0], quota[2]]],
    [zeroUsage, async () => [...quota.slice(0, 2), { ...quota[2], primary: null }]],
    [zeroUsage, async () => [...quota.slice(0, 2), { ...quota[2], rateLimited: true }]],
    [zeroUsage, async () => [quota[0], quota[1], { ...quota[2], primary: { ...window, percent: NaN } }]],
    [zeroUsage, async () => [...quota.slice(0, 2), { ...quota[2], details: [
      { ...window, label: 'x'.repeat(120) + ' A' }, { ...window, label: 'x'.repeat(120) + ' B' },
    ] }]],
    [zeroUsage, async () => [...quota.slice(0, 2), { ...quota[2], details: [
      { ...window, percent: 0.5 },
    ] }]],
    [async () => ({ ...usage(500), stale: true }), readyQuota],
    [async () => ({ ...usage(500), hydration: { complete: false } }), readyQuota],
    [async () => usage(undefined), readyQuota],
    [async () => ({ history: { daily: [{ date: '2026-11-31' }] } }), readyQuota],
    [async () => { throw Error('fixture CLI error') }, readyQuota],
  ]
  for (const [readUsage, readQuota] of attempts) {
    let settled
    const stop = f.start(readUsage, async signal => {
      signal.addEventListener('abort', () => { settled = true }, { once: true })
      return readQuota()
    }, later)
    await until(() => settled)
    assert.equal(await f.bytes(), baseline)
    stop()
  }
  // The same unchanged valid data can succeed on a later attempt; equality of the
  // numbers is not a reason to call it stale.
  f.start(zeroUsage, readyQuota, later)
  await until(async () => (await f.bytes()) !== baseline)
  assertComplete(await f.snapshot())
})
test('day rollover, timezone changes, clock rollback and stop fence late commits', async t => {
  const f = await fixture(t)
  const seed = f.start(zeroUsage, readyQuota)
  await until(f.bytes)
  const baseline = await f.bytes()
  seed()
  for (const mode of ['day', 'zone', 'clock', 'stop']) {
    let fake = new Date(base.getTime() + 10_000), zone = 'same', entered, ended
    const gate = deferred()
    const stop = f.start(zeroUsage, async signal => {
      entered = true
      signal.addEventListener('abort', () => { ended = true }, { once: true })
      return gate.promise
    }, { now: () => fake, timeZone: () => zone })
    await until(() => entered)
    if (mode === 'day') fake = new Date(base.getTime() + 86_400_000)
    if (mode === 'zone') zone = 'different'
    if (mode === 'clock') fake = new Date(base.getTime() - 10_000)
    if (mode === 'stop') stop()
    gate.resolve(quota)
    await until(() => ended)
    assert.equal(await f.bytes(), baseline)
    stop()
  }
})
test('quota provider entry precedes polling; cold deadline and retry do not overlap the stuck provider', async t => {
  const f = await fixture(t)
  const options = () => new AbortController().signal
  const entered = deferred(), underway = deferred()
  const deadline = new AbortController()
  const clock = t.mock.method(AbortSignal, 'timeout', () => deadline.signal)
  let zcodeReads = 0, freshReads = 0
  const reasons = []
  const started = { stage: 'quota', result: 'started', provider: 'zcode' }
  const takeZcodeAndDeadline = () => reasons.splice(0).filter(reason =>
    reason.provider === 'zcode' || reason.result === 'deadline')
  const fresh = id => async () => { freshReads++; return { quota: quota.find(row => row.provider === id) } }
  const q = createWidgetQuotaReader({ readBackoff: async () => null,
    diagnostic: reason => { reasons.push(reason) }, poll: {
    codex: fresh('codex'), antigravity: fresh('antigravity'),
    zcode: async () => {
      if (++zcodeReads === 1) {
        entered.resolve(reasons.at(-1))
        return underway.promise
      }
      return { quota: quota[1] }
    },
  } })
  let first
  const stop = f.start(zeroUsage, signal => { first = q(signal); return first })
  const reasonAtEntry = await entered.promise
  deadline.abort(new DOMException('fixture deadline', 'TimeoutError'))
  await assert.rejects(first, { name: 'TimeoutError' })
  clock.mock.restore()
  assert.deepEqual(reasonAtEntry, started)
  assert.deepEqual(takeZcodeAndDeadline(), [started, { stage: 'quota', result: 'deadline' }])
  assert.equal(await f.bytes(), null)
  stop()

  await assert.rejects(q(options()), /not ready/)
  assert.deepEqual(takeZcodeAndDeadline(), [{ stage: 'quota', result: 'in_flight', provider: 'zcode' }])
  assert.equal(zcodeReads, 1)
  underway.resolve({ quota: quota[1] })
  await sleep(0)
  assert.deepEqual(takeZcodeAndDeadline(), [])
  assert.deepEqual(await q(options()), quota)
  assert.deepEqual(takeZcodeAndDeadline(), [started, { stage: 'quota', result: 'fresh', provider: 'zcode' }])
  assert.deepEqual(await q(options()), quota)
  assert.equal(zcodeReads, 3)
  assert.ok(freshReads >= 6)
})
test('quota reasons report provider outcomes without copying provider data', async () => {
  let phase = 'disconnected'
  const reasons = []
  const reader = createWidgetQuotaReader({
    now: () => base.getTime(),
    readBackoff: async () => ({ codex: new Date(base.getTime() + 1_000).toISOString() }),
    diagnostic: reason => { reasons.push(reason) },
    poll: {
      codex: forbidden,
      zcode: async () => ({ quota: { ...quota[1], primary: { ...window, label: 'private label' } } }),
      antigravity: async () => {
        if (phase === 'failed') throw Error('private provider response')
        return { quota: { ...quota[2], connection: phase } }
      },
    },
  })
  for (const result of ['disconnected', 'not_fresh', 'failed']) {
    phase = result === 'not_fresh' ? 'stale' : result
    await assert.rejects(reader(new AbortController().signal), /not ready/)
    assert.deepEqual(reasons.splice(0), [
      { stage: 'quota', result: 'backoff', provider: 'codex' },
      { stage: 'quota', result: 'started', provider: 'zcode' },
      { stage: 'quota', result: 'started', provider: 'antigravity' },
      { stage: 'quota', result: 'fresh', provider: 'zcode' },
      { stage: 'quota', result, provider: 'antigravity' },
    ])
  }
})
test('aborted BigModel decrypt never hands its late credential to network', async () => {
  const decrypt = deferred(), c = new AbortController()
  let entered
  const result = fetchZcodeQuota({ signal: c.signal, readBigModelApiKey: () => { entered = true; return decrypt.promise }, fetch: forbidden, readDir: forbidden })
  await until(() => entered)
  c.abort()
  decrypt.resolve('synthetic.never-used')
  assert.equal((await result).quota.connection, 'transientFailure')
})
test('Codex callers share only token renewal; aborted caller preserves rotation but makes no late quota request', async () => {
  const response = deferred()
  const started = deferred()
  const old = { auth_mode: 'chatgpt', tokens: { access_token: 'synthetic-old', refresh_token: 'synthetic-refresh' }, last_refresh: '2000-01-01' }
  let doc = JSON.stringify(old), grants = 0, quotaGets = 0, writes = 0
  const c = new AbortController()
  const deps = {
    authPath: 'isolated-fixture-auth.json',
    readFile: async () => doc,
    readFileSync: () => doc,
    writeFileSync: (_file, text) => { writes++; doc = text },
    keychain: forbidden,
    fetch: async (_url, opts) => {
      if (opts.method === 'POST') { grants++; started.resolve(); return response.promise }
      quotaGets++
      assert.equal(writes, 1)
      assert.equal(opts.headers.Authorization, 'Bearer synthetic-new')
      return Response.json({ rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18000 } } })
    },
  }
  const first = fetchCodexQuota({ ...deps, signal: c.signal })
  await started.promise
  const second = fetchCodexQuota(deps)
  await sleep(0)
  c.abort()
  response.resolve(Response.json({ access_token: 'synthetic-new', refresh_token: 'synthetic-refresh-new' }))
  assert.equal((await first).quota.connection, 'transientFailure')
  assert.equal((await second).quota.connection, 'connected')
  assert.equal(grants, 1)
  assert.equal(quotaGets, 1)
  assert.equal(JSON.parse(doc).tokens.refresh_token, 'synthetic-refresh-new')
  await fetchCodexQuota(deps)
  assert.equal(quotaGets, 2)
  assert.equal(grants, 1)
})

test('round-owned CLI children: cancel one, never coalesce the replacement', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codeburn-fixture-cli-'))
  const executable = path.join(root, 'codeburn-fixture')
  const previous = process.env.CODEBURN_BIN
  t.after(async () => {
    if (previous === undefined) delete process.env.CODEBURN_BIN
    else process.env.CODEBURN_BIN = previous
    await rm(root, { recursive: true, force: true })
  })
  await writeFile(executable, '#!/bin/sh\nif [ "$MOCK_HANG" = yes ]; then\n  echo READY >&2\n  exec /bin/sleep 60\nfi\nprintf \'{"ok":true}\\n\'\n', { mode: 0o700 })
  process.env.CODEBURN_BIN = executable
  const c = new AbortController()
  const entered = deferred()
  const old = spawnCli(['status'], { signal: c.signal, extraEnv: { MOCK_HANG: 'yes' }, onStderr: entered.resolve })
  const aborted = assert.rejects(old, { name: 'AbortError' })
  await entered.promise
  c.abort()
  await aborted
  const next = new AbortController()
  assert.deepEqual(await spawnCli(['status'], { signal: next.signal, extraEnv: { MOCK_HANG: 'no' } }), { ok: true })
})

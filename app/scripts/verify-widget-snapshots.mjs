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

import antigravityCliUsage from '../electron/quota/fixtures/antigravity-cli-usage.json' with { type: 'json' }

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
const { createWidgetQuotaReader, pollWidgetAntigravityQuota } = await import('../electron/quota/widget-refresh.ts')
const { fetchAntigravityQuota, fetchAntigravityQuotaWithCli } = await import('../electron/quota/antigravity.ts')
const { createAntigravityCliReader } = await import('../electron/quota/antigravity-cli.ts')
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
test('Antigravity status fallback commits valid model windows and preserves the prior generation when quota is missing', async t => {
  const f = await fixture(t)
  const readQuota = (configs, settled = () => {}) => async signal => {
    signal.addEventListener('abort', settled, { once: true })
    const antigravity = await fetchAntigravityQuota({
      platform: 'darwin',
      signal,
      execFile: async file => ({
        stdout: file === 'ps'
          ? '1234 /antigravity/language_server --app_data_dir antigravity --csrf_token fixture --extension_server_port 54321'
          : '',
      }),
      request: async (_port, _tls, route) => ({
        status: 200,
        text: JSON.stringify(route.endsWith('/GetUserStatus')
          ? { userStatus: { cascadeModelConfigData: { clientModelConfigs: configs } } }
          : { response: { groups: [] } }),
      }),
    })
    return [...quota.slice(0, 2), antigravity]
  }

  const missing = [{ modelId: 'missing-fraction', quotaInfo: {} }]
  const first = deferred()
  const stopFirst = f.start(zeroUsage, readQuota(missing, first.resolve))
  await first.promise
  assert.equal(await f.bytes(), null)
  stopFirst()

  const stopComplete = f.start(zeroUsage, readQuota([
    { label: ' ', modelId: 'fixture-id', quotaInfo: { remainingFraction: 1 } },
    { modelOrAlias: { model: 'fixture-alias' }, quotaInfo: { remainingFraction: 0.5 } },
  ]))
  await until(f.bytes)
  const baseline = await f.bytes()
  const snapshot = JSON.parse(baseline)
  assertComplete(snapshot)
  assert.deepEqual(snapshot.quota.agents[2].windows, [
    { label: 'fixture-alias', percent: 0.5, resetsAt: null },
    { label: 'fixture-id', percent: 0, resetsAt: null },
  ])
  stopComplete()

  const later = deferred()
  f.start(async () => usage(500), readQuota(missing, later.resolve), {
    now: () => new Date(base.getTime() + 10_000),
  })
  await later.promise
  assert.equal(await f.bytes(), baseline)
})
const unavailableAntigravity = { platform: 'darwin', execFile: async () => ({ stdout: '' }), request: forbidden }
const officialUsage = JSON.stringify(antigravityCliUsage)
function widgetReader(antigravity, diagnostic, rows = quota) {
  return createWidgetQuotaReader({ readBackoff: async () => null, diagnostic, poll: {
    codex: async () => ({ quota: rows[0] }),
    zcode: async () => ({ quota: rows[1] }),
    antigravity,
  } })
}

test('widget retries Antigravity with a new official command and commits all three providers together', async t => {
  const f = await fixture(t)
  const initial = f.start(zeroUsage, readyQuota)
  await until(f.bytes)
  initial()
  const oldBytes = await f.bytes()

  let output, directReady = false
  const calls = []
  const run = async (_file, args) => {
    calls.push(args[0] === '--version' ? '--version' : args[args.indexOf('-p') + 1])
    if (args[0] === '--version') return '1.5.14'
    if (output === undefined) throw Error('fixture CLI unavailable')
    return output
  }
  const cli = createAntigravityCliReader({ executable: async () => '/fixture/.local/bin/agy', run })
  const deps = { ...unavailableAntigravity, cli,
    execFile: async file => ({ stdout: directReady && file === 'ps'
      ? '1234 /antigravity/language_server --app_data_dir antigravity --csrf_token fixture --extension_server_port 54321' : '' }),
    request: async () => ({ status: 200, text: JSON.stringify({ groups: [{ displayName: 'Direct', buckets: [
      { bucketId: 'week', remainingFraction: 0.25 },
    ] }] }) }),
  }

  const reasons = []
  const diagnostic = event => reasons.push(event)
  const sawAntigravity = result => reasons.some(event => event.stage === 'quota' && event.provider === 'antigravity' && event.result === result)
  const rows = quota.map((row, i) => ({ ...row, primary: { ...window, percent: (i + 1) / 4 } }))
  const reader = widgetReader(signal => pollWidgetAntigravityQuota(signal, deps), diagnostic, rows)
  const recoveredAt = new Date(base.getTime() + 10_000)
  const start = (readQuota, offset = 0) => f.start(async args => usage(500 + WIDGET_AGENTS.indexOf(args[args.indexOf('--provider') + 1])), readQuota, {
    now: () => new Date(recoveredAt.getTime() + offset), diagnostic,
  })
  const invalid = structuredClone(antigravityCliUsage)
  delete invalid.command.data.groups[0].buckets[1].remaining_fraction
  const disabled = structuredClone(antigravityCliUsage)
  disabled.command.data.groups = [{ name: 'Optional', buckets: [{ disabled: true }] }]
  for (const response of [undefined, '{invalid', JSON.stringify(invalid), JSON.stringify(disabled)]) {
    output = response
    reasons.length = 0
    const stop = start(reader)
    await until(() => sawAntigravity('disconnected'))
    stop()
    assert.equal(await f.bytes(), oldBytes)
  }
  assert.deepEqual(calls, Array.from({ length: 4 }, () => ['--version', '/usage']).flat())

  output = officialUsage
  const desktop = await fetchAntigravityQuotaWithCli(deps)
  assert.equal(desktop.source, 'antigravity-cli')
  assert.equal(desktop.details.length, 4)
  for (const cached of [widgetReader(async () => ({ quota: desktop }), diagnostic), async () => [quota[0], quota[1], desktop]]) {
    reasons.length = 0
    const stop = start(cached)
    await until(() => sawAntigravity('not_fresh'))
    stop()
    assert.equal(await f.bytes(), oldBytes)
  }

  const recovered = start(reader)
  await until(async () => (await f.bytes()) !== oldBytes)
  const snapshot = await f.snapshot()
  assertComplete(snapshot)
  assert.equal(snapshot.updatedAt, recoveredAt.toISOString())
  assert.deepEqual(snapshot.usage.agents.map(row => row.tokens), [500, 501, 502])
  assert.deepEqual(snapshot.quota.agents.map(row => row.windows.map(window => window.percent)), [[0.25], [0.5], [1, 0.5, 0.25, 0]])
  assert.equal(snapshot.quota.agents[2].windows[0].resetsAt, '2026-11-24T12:00:00.000Z')
  assert.equal(calls.length, 12)
  recovered()

  directReady = true
  start(reader, 1_000)
  await until(async () => (await f.snapshot()).updatedAt !== snapshot.updatedAt)
  assert.deepEqual((await f.snapshot()).quota.agents[2].windows, [{ label: 'Direct · week', percent: 0.75, resetsAt: null }])
  assert.equal(calls.length, 12)
})

test('widget keeps old bytes while the CLI is busy and after a cancelled command returns late', async t => {
  const f = await fixture(t)
  const seed = f.start(zeroUsage, readyQuota)
  await until(f.bytes)
  seed()
  const baseline = await f.bytes()
  let entered = deferred(), response = deferred()
  let commands = 0
  const cli = createAntigravityCliReader({ executable: async () => '/fixture/.local/bin/agy', run: async (_file, args, signal) => {
    if (args[0] === '--version') return '1.5.14'
    commands++
    entered.resolve(signal)
    return response.promise
  } })
  const deps = { ...unavailableAntigravity, cli }
  const reasons = []
  const diagnostic = event => reasons.push(event)
  const reader = widgetReader(signal => pollWidgetAntigravityQuota(signal, deps), diagnostic)
  const start = (timeoutMs = 90_000) => f.start(async () => usage(500), reader, {
    now: () => new Date(base.getTime() + 10_000), timeoutMs, diagnostic,
  })
  const expectBusy = async () => {
    reasons.length = 0
    const stop = start()
    await until(() => reasons.some(event => event.stage === 'quota' && event.provider === 'antigravity' && event.result === 'disconnected'))
    stop()
    assert.equal(await f.bytes(), baseline)
  }

  const plans = fetchAntigravityQuotaWithCli(deps)
  await entered.promise
  await expectBusy()
  assert.equal(commands, 1)
  response.resolve(officialUsage)
  assert.equal((await plans).source, 'antigravity-cli')
  assert.equal(await f.bytes(), baseline)

  entered = deferred()
  response = deferred()
  const cancelled = start(75)
  const cliSignal = await entered.promise
  await until(() => reasons.some(event => event.stage === 'round' && event.result === 'deadline'))
  assert.equal(cliSignal.aborted, true)
  cancelled()
  await expectBusy()
  assert.equal(commands, 2)
  response.resolve(officialUsage)
  await sleep(0)
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

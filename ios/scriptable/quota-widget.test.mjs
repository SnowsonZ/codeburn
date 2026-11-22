import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

const script = await readFile(new URL('./quota-widget.js', import.meta.url), 'utf8')
const functions = script.slice(script.indexOf('function knownCount('), script.indexOf('function sum('))

test('the usage and quota mastheads keep the right status compact', () => {
  const source = script.slice(script.indexOf('function widgetMasthead('), script.indexOf('function vinylWidget('))
  const { widgetMasthead } = runInNewContext(source + '; ({ widgetMasthead })', {
    palette: {},
    Font: new Proxy({}, { get: () => size => ({ size }) }),
    slot(parent) {
      const row = { children: [], addSpacer() {} }
      parent.children.push(row)
      return row
    },
    text(row, value) { row.children.push(value); return {} },
  })
  const today = { children: [] }
  widgetMasthead(today, 'today', '今日用量', 99, 'small')
  assert.deepEqual(today.children.map(row => row.children), [['今日用量', '命中 99%'], ['TURNTABLE']])
  const quota = { children: [] }
  widgetMasthead(quota, 'quota', '套餐额度', null, 'medium')
  assert.deepEqual(quota.children.map(row => row.children), [['套餐额度', '剩余'], ['DUAL CASSETTE DECK']])
})

test('both usage totals share one baseline and use smaller plural Tokens', () => {
  const functions = script.slice(script.indexOf('function tokenParts('), script.indexOf('function hitRate('))
  const palette = { primary: 'number', secondary: 'caption', accent: 'accent' }
  const font = size => ({ size })
  const { tokenTotal } = runInNewContext(functions + '; ({ tokenTotal })', {
    palette,
    Font: { boldSystemFont: font, semiboldSystemFont: font, mediumSystemFont: font },
    horizontal(parent) {
      const row = { children: [], bottomAlignContent() { this.aligned = 'bottom' },
        addSpacer() {}, setPadding(...padding) { this.padding = padding } }
      parent.children.push(row)
      return row
    },
    text(parent, value, font) { parent.children.push({ value, font }) },
  })
  for (const [count, amount, unit] of [[272_000_000, '272', 'M'], [2_560_000_000, '2.56', 'B']]) {
    const root = { children: [] }
    tokenTotal(root, count, 'small')
    assert.equal(root.children.length, 1)
    const [line] = root.children
    assert.equal(line.aligned, 'bottom')
    const [number, suffix, caption] = line.children
    assert.equal(number.value, amount)
    assert.equal(suffix.children[0].value, unit)
    assert.equal(caption.children[0].value, 'Tokens')
    assert(caption.children[0].font.size < suffix.children[0].font.size)
    assert(caption.padding[2] > suffix.padding[2])
  }
})

test('system dark uses walnut in both the widget and its in-app preview', () => {
  const styles = script.slice(script.indexOf('const requestedFinish'), script.indexOf('const agentIds'))
  function colors(parameter, runsInWidget, systemDark) {
    class Color {
      constructor(hex) { this.hex = hex }
      static dynamic(light, dark) { return { light, dark } }
    }
    return runInNewContext(styles + '; ({ finish, palette })', {
      args: { widgetParameter: parameter }, config: { runsInWidget },
      Device: { isUsingDarkAppearance: () => systemDark }, Color,
    })
  }
  const widget = colors('', true, true)
  assert.equal(widget.palette.surface.dark.hex, '#271a12')
  assert.equal(widget.palette.surface.light.hex, '#ece8e0')
  assert.equal(colors('', false, true).finish, 'walnut')
  assert.equal(colors('', false, false).finish, 'light')
  assert.equal(colors('dark', false, true).finish, 'dark')
})
const agentIds = ['codex', 'zcode', 'antigravity']
const oldStamp = '2026-11-20T15:00:00.000Z'
const newStamp = '2026-11-20T16:00:00.000Z'
const newerStamp = '2026-11-20T17:00:00.000Z'

function fixture(updatedAt, total = 1) {
  return {
    version: 1, updatedAt,
    usage: {
      updatedAt, day: '2026-11-20',
      agents: agentIds.map(id => ({ id, tokens: total, input: total, cached: 0 })),
      days: Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-${14 + i}`, tokens: i === 6 ? 3 * total : 0 })),
    },
    quota: {
      updatedAt, agents: agentIds.map(id => ({ id, windows: [{ label: 'Weekly', percent: total / 10, resetsAt: null }] })),
    },
  }
}

function client(settings, diskFiles = new Map()) {
  const pending = []
  const disk = {
    libraryDirectory: () => '/test',
    joinPath: (a, b) => a + '/' + b,
    listContents: () => [...diskFiles.keys()].map(path => path.slice('/test/'.length)),
    writeString: (path, value) => diskFiles.set(path, value),
    readString: path => diskFiles.get(path),
    remove: path => diskFiles.delete(path),
  }
  const urls = []
  class Request {
    constructor(url) { urls.push(url) }
    async loadJSON() {
      const result = await pending.shift()
      if (result instanceof Error) throw result
      this.response = { statusCode: result.code }
      return result.body
    }
  }
  const api = runInNewContext('(() => {' + functions + '; return { loadData, isCompleteSnapshot } })()',
    { agentIds, settings, FileManager: { local: () => disk }, Request })
  return { api, pending, urls, diskFiles }
}
const settings = { endpoint: 'https://host.ts.net/codeburn-quota', accessKey: 'not-a-secret' }
const ok = body => ({ code: 200, body })

test('coherent shared widgets reject legacy and partial generations and retain last-known whole generation', async () => {
  const c = client(settings)
  assert(c.api.isCompleteSnapshot(fixture(oldStamp, 0)))
  assert.equal(c.api.isCompleteSnapshot({ ...fixture(oldStamp), updatedAt: undefined }), false)
  const missing = fixture(newStamp)
  missing.usage.agents[1].cached = null
  const old = fixture(oldStamp, 4)
  c.pending.push(ok(old), ok(missing), { code: 503, body: {} })
  assert.equal((await c.api.loadData('today')).data.agents[0].tokens, 4)
  const quota = await c.api.loadData('quota')
  assert.equal(quota.status, '显示缓存')
  assert.equal(quota.updatedAt, oldStamp)
  assert.equal(quota.data.agents[0].windows[0].percent, 0.4)
  const trend = await c.api.loadData('trend')
  assert.equal(trend.data.day, old.usage.day)
  assert.equal(trend.updatedAt, oldStamp)
  assert.equal(new Set(c.urls).size, 1)
  assert.equal(c.urls[0], 'https://host.ts.net/codeburn-snapshot')
})

test('older concurrent responses or same-stamp conflicts do not replace a newer complete snapshot', async () => {
  const c = client(settings)
  const other = client(settings, c.diskFiles)
  let respondOlder
  c.pending.push(new Promise(resolve => { respondOlder = resolve }))
  const slow = c.api.loadData('today')
  other.pending.push(ok(fixture(newStamp, 5)))
  assert.equal((await other.api.loadData('quota')).updatedAt, newStamp)
  respondOlder(ok(fixture(oldStamp, 3)))
  assert.equal((await slow).updatedAt, newStamp)
  c.pending.push(ok(fixture(newStamp, 8)))
  assert.equal((await c.api.loadData('today')).data.agents[0].tokens, 5)
  c.pending.push(ok(fixture(newerStamp, 9)))
  assert.equal((await c.api.loadData('today')).data.agents[0].tokens, 9)
  other.pending.push(new Error('offline'))
  assert.equal((await other.api.loadData('quota')).updatedAt, newerStamp)
})

test('unauthorized never falls back; different configured hosts do not share cache', async () => {
  const c = client({ ...settings, endpoint: 'https://a-b.ts.net/codeburn-quota' })
  const other = client({ ...settings, endpoint: 'https://a.b.ts.net/codeburn-quota' }, c.diskFiles)
  c.pending.push(ok(fixture(oldStamp)), { code: 401, body: {} })
  await c.api.loadData('quota')
  assert.equal((await c.api.loadData('quota')).data, null)
  other.pending.push(new Error('offline'))
  assert.equal((await other.api.loadData('today')).data, null)
})

test('Scriptable keeps the snapshot-selected bucket, numerical value and bar after reset', () => {
  const before = Date.parse('2026-11-21T00:59:59.000Z')
  const after = before + 1_000
  const resetsAt = new Date(after).toISOString()
  const exhausted = { label: 'Gemini · Five Hour', percent: 1, resetsAt }
  const roomy = { label: 'Gemini · Weekly', percent: 0.1, resetsAt: null }
  const quota = { updatedAt: new Date(before).toISOString(), agents: [
    { id: 'antigravity', windows: [roomy, exhausted] },
    { id: 'no-data', windows: [] },
  ] }
  const output = []
  const barValues = []
  const stack = { addSpacer() {} }
  const render = runInNewContext('(() => {'
    + script.slice(script.indexOf('function quotaExpired('), script.indexOf('function rule('))
    + script.slice(script.indexOf('function smallQuota('), script.indexOf('function todayPanel('))
    + '; return { quotaCell, smallQuota } })()', {
    slot: () => stack, horizontal: () => stack, identity() {}, bar: (_s, _w, _h, value) => barValues.push(value),
    text: (_s, value) => output.push(value),
    palette: { secondary: 'secondary', primary: 'primary' },
    Font: { mediumSystemFont() {}, semiboldMonospacedSystemFont() {} },
  })
  render.smallQuota(stack, quota, before, 120)
  assert.deepEqual(output, ['5 小时', '0%', '额度暂不可用'])
  assert.deepEqual(barValues, [0])
  output.length = 0
  barValues.length = 0
  render.smallQuota(stack, quota, after, 120)
  assert.deepEqual(output, ['5 小时', '已过期', '0%', '额度暂不可用'])
  assert.deepEqual(barValues, [0])
  output.length = 0
  barValues.length = 0
  render.quotaCell(stack, 100, 16, 11, { ...exhausted, percent: 0.4 }, after)
  assert.deepEqual(output, ['已过期', '60%'])
  assert.deepEqual(barValues, [0.6])
})

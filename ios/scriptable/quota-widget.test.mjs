import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

const script = await readFile(new URL('./quota-widget.js', import.meta.url), 'utf8')
const functions = script.slice(script.indexOf('function knownCount('), script.indexOf('function sum('))

test('status shares the two-line masthead and uses a smaller Max suffix', () => {
  const titleCode = script.slice(script.indexOf('function widgetStatus('), script.indexOf('function widgetSurface('))
  const usageCode = script.slice(script.indexOf('function tokenParts('), script.indexOf('function calendarKey('))
  function stack(width, height) {
    return { children: [], width, height,
      addStack() { const child = stack(); this.children.push(child); return child },
      layoutVertically() { this.direction = 'vertical' },
      bottomAlignContent() { this.baseline = 'bottom' },
      setPadding() {},
      addSpacer(size) { this.children.push({ spacer: size }) },
    }
  }
  const { widgetMasthead, widgetStatus } = runInNewContext(usageCode + titleCode + '; ({ widgetMasthead, widgetStatus })', {
    palette: { accent: 'orange' },
    Font: new Proxy({}, { get: () => size => ({ size }) }),
    sum: values => values.reduce((sum, value) => sum + value, 0),
    slot(parent, width, height) {
      const row = stack(width, height)
      parent.children.push(row)
      return row
    },
    horizontal: parent => parent.addStack(),
    text(row, value, font) { const label = { value, font }; row.children.push(label); return label },
  })
  const stats = { agents: [{ input: 100, cached: 99 }],
    days: [0, 5_000_000, 2_560_000_000, 8, 4, 2, 300_000_000].map(tokens => ({ tokens })) }
  const cases = [
    ['today', '今日用量', 'TURNTABLE', 'Cache 99%', ''],
    ['quota', '套餐额度', 'DUAL CASSETTE DECK', '剩余', ''],
    ['trend', '7 天趋势', 'LP CRATE', 'Max 2.56', 'B'],
  ]
  for (const [card, title, name, label, suffix] of cases) {
    const root = stack()
    const status = widgetStatus(card, stats)
    assert.equal(status.label, label)
    assert.equal(status.unit, suffix)
    assert.equal(widgetMasthead(root, card, title, status, 'medium'), 22)
    assert.equal(root.children.length, 1)
    const [row] = root.children
    const [identity, flexible, dot, gap, readout, tail] = row.children
    assert.equal(identity.direction, 'vertical')
    assert.deepEqual(identity.children.flatMap(child => child.children.map(text => text.value)), [title, name])
    assert.equal(flexible.spacer, undefined)
    assert.equal(dot.backgroundColor, 'orange')
    assert.equal(dot.cornerRadius, 2)
    assert.equal(gap.spacer, 4)
    assert.equal(readout.baseline, 'bottom')
    assert.equal(readout.children[0].value, label)
    if (suffix) {
      const unit = readout.children[2].children[0]
      assert.equal(unit.value, suffix)
      assert(unit.font.size < readout.children[0].font.size)
    }
    assert.equal(tail?.spacer, card === 'quota' ? 10 : undefined)
  }
  assert.equal(widgetStatus('trend', null), null)
  assert.equal(widgetStatus('trend', { days: Array.from({ length: 7 }, () => ({ tokens: 0 })) }).label, 'Max 0')
})

test('automatic cards all put the same grain layer over the dynamic gradient', () => {
  const source = script.slice(script.indexOf('function widgetSurface('), script.indexOf('function vinylWidget('))
  const surface = runInNewContext(source + '; widgetSurface', {
    automatic: true, palette: { surface: 'surface' }, inset: 11,
    chassisStops: { light: [1, 2, 3], walnut: [4, 5, 6] }, systemDarkFinish: 'walnut',
    LinearGradient: class {}, Point: class {}, Color: { dynamic: (...stops) => stops },
    rgb: color => color,
    chassis: (width, height, art, usage, transparent) => ({ width, height, art, transparent }),
  })
  for (const art of ['record', null, null]) {
    const contents = { layoutVertically() {}, setPadding(...padding) { this.padding = padding } }
    const widget = { setPadding(...padding) { this.padding = padding }, addStack: () => contents }
    assert.equal(surface(widget, 152, 152, art, null), contents)
    assert.equal(widget.backgroundGradient.colors.length, 3)
    assert.deepEqual(widget.padding, [0, 0, 0, 0])
    assert.deepEqual(contents.padding, [11, 11, 11, 11])
    assert.equal(contents.backgroundImage.art, art)
    assert.equal(contents.backgroundImage.transparent, true)
  }
})

test('Antigravity groups recognize the same full period suffixes as Mac', () => {
  const source = script.slice(script.indexOf('function gravityRows('), script.indexOf('function bar('))
  const gravityRows = runInNewContext(source + '; gravityRows')
  const week = { label: 'Gemini · Plan window · weekly', percent: 0.8 }
  const short = { label: 'Gemini · Plan window · 5-hour', percent: 0.3 }
  const standalone = { label: 'Claude · Custom period', percent: 0.2 }
  const rows = gravityRows({ id: 'antigravity', windows: [week, standalone, short] })
  assert.equal(rows.length, 3)
  assert.equal(rows[0].rule, true)
  assert.equal(rows[1].group, 'Gemini')
  assert.equal(rows[1].week, week)
  assert.equal(rows[1].short, short)
  assert.equal(rows[2].group, 'Claude')
  assert.equal(rows[2].single, standalone)
  assert.equal(rows[2].label, undefined)
})

test('each Antigravity model row reserves the same two icon slots', () => {
  const source = script.slice(script.indexOf('function identity('), script.indexOf('function accountRows('))
  const identity = runInNewContext(source + '; identity', {
    palette: {},
    Font: { semiboldMonospacedSystemFont: size => size },
    slot(parent, width, height) {
      const child = { width, height, children: [], addSpacer(size) { this.children.push({ width: size }) } }
      parent.children.push(child)
      return child
    },
    icon(parent, name, size) { parent.children.push({ name, width: size }) },
    text(parent, value) { parent.children.push({ value }) },
  })
  for (const [width, height, large, size] of [[33, 14, false, 10], [43, 23, true, 15]]) {
    for (const group of ['Claude and GPT models', 'Gemini models', 'Gemini 4 Argon']) {
      const root = { children: [] }
      identity(root, { group }, height, width, large)
      const [rail] = root.children
      assert.deepEqual(rail.children.map(child => child.width), [6, 1, 3, size, 3, size])
      assert.equal(rail.children[1].height, height)
      assert.equal(rail.children[3].children[0].width, size)
    }
  }
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

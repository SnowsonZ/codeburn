// Variables used by Scriptable.
// icon-color: green; icon-glyph: tachometer-alt;
const settings = null // Replaced when exporting the configured script.

const requestedFinish = String(args.widgetParameter ?? '').trim().toLowerCase()
const fixedFinish = ['light', 'dark', 'walnut'].includes(requestedFinish) ? requestedFinish : null
const automatic = !fixedFinish && config.runsInWidget
const systemDarkFinish = 'walnut'
// Device.isUsingDarkAppearance() is available in the Scriptable app, not on the Home Screen.
const finish = fixedFinish ?? ((!config.runsInWidget && Device.isUsingDarkAppearance()) ? systemDarkFinish : 'light')
const light = finish === 'light'
const walnut = finish === 'walnut'
const chassisStops = {
  light: [0xf6f4ef, 0xece8e0, 0xe3ded4],
  dark: [0x22201f, 0x161514, 0x100f0f],
  walnut: [0x3c281d, 0x271a12, 0x1b120d],
}
const finishes = {
  light: {
    surface:'#ece8e0', primary:'#181614', secondary:'#5b554e', accent:'#d14114',
    used:'#b6a299', cassetteWell:'#ded0c2', eject:'#b51d44', rule:'#c9c0b4', well:'#d3ccc0', badge:'#e7e1d9',
  },
  dark: {
    surface:'#161514', primary:'#f6f1ea', secondary:'#a39a92', accent:'#f9671e',
    used:'#634b41', cassetteWell:'#33251f', eject:'#fb7185', rule:'#50463e', well:'#1a1614', badge:'#39312c',
  },
  walnut: {
    surface:'#271a12', primary:'#faf2e6', secondary:'#c9b096', accent:'#f68646',
    used:'#634b41', cassetteWell:'#33251f', eject:'#fb7185', rule:'#50463e', well:'#1a1614', badge:'#39312c',
  },
}
const paint = Object.fromEntries(Object.entries(finishes[finish]).map(([role, hex]) => [role, new Color(hex)]))
// Only native views resolve dynamic colors. Raster drawing uses a stable artwork palette.
const palette = automatic ? Object.fromEntries(Object.keys(paint).map(role => [
  role, Color.dynamic(paint[role], new Color(finishes[systemDarkFinish][role])),
])) : paint
const agentIds = ['codex', 'zcode', 'antigravity']
const agentColors = ['#06b6d4', '#4387fb', '#d946ef']
const coverColors = light ? ['#dcd4c8','#d2c9bc','#d9cdc0','#cfc4b4','#d7ccbe','#cec6ba']
  : walnut ? ['#b88d60','#af805a','#c6a586','#c89454','#ae917e','#c7a78b']
  : ['#837168','#716159','#998579','#a7917f','#7f6c62','#957f70']
const inset = 11
const railWidth = 42
const refreshInterval = 15 * 60 * 1000

// Medium width, small edge, large height, in portrait points.
const widgetSizes = {
  '320x568': [292, 141, 311],
  '360x780': [329, 155, 345],
  '375x667': [321, 148, 324],
  '375x812': [329, 155, 345],
  '390x844': [338, 158, 354],
  '393x852': [338, 158, 354],
  '414x736': [348, 157, 357],
  '414x896': [360, 169, 379],
  '428x926': [364, 170, 382],
  '430x932': [364, 170, 382],
}

function widgetSize(family) {
  const screen = Device.screenSize()
  const width = Math.min(screen.width, screen.height)
  const height = Math.max(screen.width, screen.height)
  const fallback = Math.min(364, Math.max(260, Math.floor(width) - 66))
  const [wide, small, tall] = widgetSizes[`${Math.round(width)}x${Math.round(height)}`] ??
    [fallback, Math.floor(fallback * 0.46), fallback + 12]
  if (family === 'small') return [small, small]
  return [wide, family === 'large' ? tall : small]
}

function text(stack, value, font, color = palette.primary) {
  const label = stack.addText(value)
  label.font = font
  label.textColor = color
  label.lineLimit = 1
  label.minimumScaleFactor = 0.8
  return label
}

function horizontal(parent) {
  const stack = parent.addStack()
  stack.layoutHorizontally()
  stack.centerAlignContent()
  return stack
}

function slot(parent, width, height) {
  const stack = horizontal(parent)
  stack.size = new Size(width, height)
  return stack
}

function icon(stack, name, size, fallback, color = palette.primary) {
  const encoded = settings?.icons?.[name]
  const image = encoded ? Image.fromData(Data.fromBase64String(encoded)) : SFSymbol.named(fallback)?.image
  if (!image) return
  const view = stack.addImage(image)
  view.imageSize = new Size(size, size)
  view.tintColor = color
}

const quotaProviderAxis = 11

function identity(stack, row, height, width = railWidth, large = false) {
  const rail = slot(stack, width, height)
  rail.spacing = 0
  if (row.id) {
    const providerWidth = quotaProviderAxis * 2
    const size = Math.min(height - 1, row.id === 'zcode' ? providerWidth : 21)
    const provider = slot(rail, providerWidth, height)
    provider.spacing = 0
    const edge = quotaProviderAxis - size / 2
    if (edge > 0) provider.addSpacer(edge)
    icon(provider, row.id, size, 'terminal')
    if (edge > 0) provider.addSpacer(edge)
    const staleSize = row.stale ? Math.min(9, height - 2) : 0
    if (row.stale) {
      rail.addSpacer(4)
      icon(rail, null, staleSize, 'clock.arrow.circlepath', palette.secondary)
    }
    const available = width - providerWidth - (row.stale ? 4 + staleSize : 0)
    if (available > 0) rail.addSpacer(available)
    return
  }

  // A single glyph and a pair occupy the same width so Scriptable cannot
  // recenter one row differently and move the tree line with it.
  const guideWidth = 1
  const gap = 3
  const inset = quotaProviderAxis - guideWidth / 2
  rail.addSpacer(inset)
  slot(rail, guideWidth, height).backgroundColor = palette.rule
  rail.addSpacer(gap)
  const name = row.group.toLowerCase()
  const claude = name.includes('claude')
  const gpt = name.includes('gpt')
  const gemini = name.includes('gemini')
  const model = claude ? 'claude' : gpt ? 'codex' : gemini ? 'gemini' : null
  const size = Math.min(large ? 15 : 10, Math.max(7, height - 2))
  icon(slot(rail, size, height), model, size, claude ? 'sun.max' : gpt ? 'circle.hexagongrid' : gemini ? 'sparkle' : 'cpu')
  rail.addSpacer(gap)
  const extra = slot(rail, size, height)
  if (claude && gpt) {
    icon(extra, 'codex', size, 'circle.hexagongrid')
  } else if (gemini && name.includes('argon')) {
    const badge = slot(extra, size, Math.min(height - 2, 13))
    badge.cornerRadius = 3
    badge.backgroundColor = palette.badge
    badge.addSpacer(2)
    text(badge, 'Ar', Font.semiboldMonospacedSystemFont(Math.min(8, size * 0.7)), palette.secondary)
  } else {
    extra.addSpacer(size)
  }
  const available = width - (inset + guideWidth + 2 * gap + 2 * size)
  if (available > 0) rail.addSpacer(available)
}

function accountRows(agent) {
  if (!agent.windows.length) return [{ ...agent, message: '额度暂不可用' }]
  const short = agent.windows.find(window => window.label === '5-hour')
  const week = agent.windows.find(window => window.label === 'Weekly')
  const other = agent.windows.filter(window => window !== short && window !== week)
  const rows = short || week ? [{ ...agent, short, week }] : []
  return rows.concat(other.map(window => ({ ...agent, single: window, label: window.label })))
}

function gravityRows(agent) {
  if (!agent.windows.length) return [{ ...agent, message: '额度暂不可用' }]
  const groups = new Map()
  const rows = []
  for (const window of agent.windows) {
    const separator = window.label.indexOf(' · ')
    const group = separator < 0 ? window.label : window.label.slice(0, separator)
    const bucket = separator < 0 ? '' : window.label.slice(separator + 3).toLowerCase().replaceAll('-', ' ')
    const period = /(?:five|5) hour/.test(bucket) ? 'short' : /weekly/.test(bucket) ? 'week' : null
    if (!period) {
      rows.push({ group, single: window })
      continue
    }
    if (!groups.has(group)) {
      const row = { group }
      groups.set(group, row)
      rows.push(row)
    }
    groups.get(group)[period] = window
  }
  return [{ ...agent, rule: true }, ...rows]
}

function bar(parent, width, height, remaining, detailed) {
  const view = slot(parent, width, height)
  view.cornerRadius = detailed ? 3 : height / 2
  view.backgroundColor = detailed ? palette.cassetteWell : palette.used
  if (detailed) {
    view.borderWidth = 0.65
    view.borderColor = remaining === 0 ? palette.eject : palette.rule
  }
  if (remaining === 0) {
    if (detailed && width >= 28) {
      view.addSpacer()
      text(view, '耗尽', Font.semiboldSystemFont(Math.min(10, height * 0.72)), palette.eject)
      view.addSpacer()
    }
    return
  }
  const tint = palette.accent
  if (!detailed) {
    const fill = slot(view, Math.max(1, width * remaining), height)
    fill.backgroundColor = tint
    fill.cornerRadius = height / 2
    return
  }
  const canvas = new DrawContext()
  canvas.opaque = false
  canvas.respectScreenScale = true
  canvas.size = new Size(width, height)
  const side = Math.min(height - 3, width * 0.19)
  const left = side / 2 + 3
  const right = width - left
  const centerY = height / 2
  for (const [x, fraction, color] of [[left, remaining, paint.accent], [right, 1 - remaining, paint.secondary]]) {
    const radius = side * (0.20 + 0.27 * fraction)
    canvas.setFillColor(color)
    canvas.fillEllipse(new Rect(x - radius, centerY - radius, radius * 2, radius * 2))
    canvas.setFillColor(paint.cassetteWell)
    canvas.fillEllipse(new Rect(x - side * 0.19, centerY - side * 0.19, side * 0.38, side * 0.38))
    const spokes = new Path()
    for (let index = 0; index < 6; index++) {
      const angle = index * Math.PI / 3
      spokes.move(new Point(x + Math.cos(angle) * side * 0.06, centerY + Math.sin(angle) * side * 0.06))
      spokes.addLine(new Point(x + Math.cos(angle) * side * 0.13, centerY + Math.sin(angle) * side * 0.13))
    }
    canvas.addPath(spokes)
    canvas.setStrokeColor(color)
    canvas.setLineWidth(0.55)
    canvas.strokePath()
  }
  const start = left + side * 0.63 + 1
  const track = Math.max(1, width - 2 * start)
  canvas.setFillColor(paint.used)
  const tapeHeight = Math.min(6, height * 0.34)
  const tapeTop = centerY - tapeHeight / 2
  canvas.fillRect(new Rect(start, tapeTop, track, tapeHeight))
  canvas.setFillColor(paint.accent)
  canvas.fillRect(new Rect(start, tapeTop, track * remaining, tapeHeight))
  canvas.setFillColor(paint.rule)
  for (const part of [0.25, 0.5, 0.75]) canvas.fillRect(new Rect(start + track * part, tapeTop, 0.55, tapeHeight))
  const image = view.addImage(canvas.getImage())
  image.imageSize = new Size(width, height)
}

function quotaExpired(window, now) {
  return !!window.resetsAt && Date.parse(window.resetsAt) <= now
}

function compactQuotaWindow(agent, updatedAt) {
  const atCommit = agent.windows.filter(window => !quotaExpired(window, Date.parse(updatedAt)))
  const windows = agent.id === 'antigravity' ? [...atCommit].sort((a, b) => b.percent - a.percent) : atCommit
  return windows[0] ?? agent.windows[0]
}

const quotaValueGap = 5

function quotaValueWidth(valueSize) {
  // Reserve four monospaced characters plus a small inset for 100%.
  return Math.ceil(valueSize * 3.1 + 3)
}

function quotaCell(parent, width, rowHeight, valueSize, window, now, label) {
  const view = slot(parent, width, rowHeight)
  if (!window) return
  const expired = quotaExpired(window, now)
  const amount = `${Math.round((1 - window.percent) * 100)}%`
  const numberWidth = quotaValueWidth(valueSize)
  const oldWidth = expired ? 30 : 0
  let barWidth = width - numberWidth - quotaValueGap - oldWidth
  if (label) {
    const labelWidth = Math.min(78, Math.floor(width * 0.32))
    const labelSlot = slot(view, labelWidth, rowHeight)
    text(labelSlot, label === 'Session' ? '会话' : label, Font.mediumSystemFont(Math.min(10, valueSize)), palette.secondary)
    labelSlot.addSpacer()
    barWidth -= labelWidth + quotaValueGap
    view.addSpacer(quotaValueGap)
  }
  const barHeight = Math.min(rowHeight - 2, Math.round(valueSize * 1.17))
  bar(view, Math.max(2, barWidth), barHeight, Math.max(0, 1 - window.percent), true)
  view.addSpacer(quotaValueGap)
  if (expired) text(slot(view, oldWidth, rowHeight), '已过期', Font.mediumSystemFont(8), palette.secondary)
  const value = slot(view, numberWidth, rowHeight)
  value.addSpacer()
  text(value, amount, Font.semiboldMonospacedSystemFont(valueSize), expired ? palette.secondary : palette.primary)
}

function rule(parent, width) {
  slot(parent, width, 1).backgroundColor = palette.rule
}

function quotaRows(agents, capacity) {
  const groups = agents.filter(agent => agent.id !== 'antigravity').map(accountRows)
  const antigravity = agents.find(agent => agent.id === 'antigravity')
  if (antigravity) groups.push(gravityRows(antigravity))
  let extraRows = Math.max(0, capacity - groups.length)
  const rows = groups.slice(0, capacity).flatMap(group => {
    const extras = Math.min(extraRows, group.length - 1)
    extraRows -= extras
    return group.slice(0, 1 + extras)
  })
  return { rows, hidden: groups.reduce((total, group) => total + group.length, 0) - rows.length }
}

function quotaTable(widget, quota, now, width, tableBudget, large) {
  const identityWidth = large ? 48 : 38
  const gapWidth = large ? 10 : 7
  const column = Math.floor((width - identityWidth - 2 * gapWidth) / 2)
  const span = column * 2 + gapWidth
  const headerHeight = large ? 17 : 12
  const headerGap = large ? 4 : 3
  const rowBudget = tableBudget - headerHeight - headerGap
  const minPitch = large ? 16 : 10
  const { rows, hidden } = quotaRows(quota.agents, Math.floor(rowBudget / minPitch))
  if (!rows.length) {
    text(widget, '额度暂不可用', Font.mediumSystemFont(10), palette.secondary)
    return
  }
  const pitch = Math.floor(rowBudget / rows.length)
  const gap = large && pitch >= 24 ? 4 : pitch >= 16 ? 2 : 1
  const gapsHeight = gap * (rows.length - 1)
  const dividerCount = rows.filter(row => row.rule).length
  const dividerHeight = Math.min(large ? 24 : 12, pitch - gap)
  const dataRows = rows.length - dividerCount
  const rowHeight = Math.min(large ? 43 : 24, Math.floor(
    (rowBudget - gapsHeight - dividerCount * dividerHeight) / Math.max(1, dataRows),
  ))
  const valueSize = Math.min(large ? 18 : 13, rowHeight - 1.5)

  // Fit a fixed-height table to the card, without stretchable row gaps.
  const table = widget.addStack()
  table.layoutVertically()
  table.spacing = 0
  table.size = new Size(width, headerHeight + headerGap + dataRows * rowHeight +
    dividerCount * dividerHeight + gapsHeight)
  const headers = slot(table, width, headerHeight)
  const identityHeading = slot(headers, identityWidth, headerHeight)
  if (hidden && !dividerCount) text(identityHeading, `+${hidden}`, Font.mediumSystemFont(9), palette.secondary)
  headers.addSpacer(gapWidth)
  const periods = ['5 小时', '每周']
  const valueSpace = quotaValueWidth(valueSize) + quotaValueGap
  for (const title of periods) {
    const heading = slot(headers, column, headerHeight)
    const tapeHeading = slot(heading, Math.max(2, column - valueSpace), headerHeight)
    tapeHeading.addSpacer()
    text(tapeHeading, title, Font.mediumSystemFont(large ? 11 : 9), palette.secondary)
    tapeHeading.addSpacer()
    heading.addSpacer(valueSpace)
    if (title === periods[0]) headers.addSpacer(gapWidth)
  }
  table.addSpacer(headerGap)
  for (const [index, row] of rows.entries()) {
    if (index > 0) table.addSpacer(gap)
    const height = row.rule ? dividerHeight : rowHeight
    const line = slot(table, width, height)
    identity(line, row, height, identityWidth, large)
    line.addSpacer(gapWidth)
    if (row.rule) {
      const divider = slot(line, span, height)
      const moreWidth = hidden ? 26 : 0
      rule(divider, span - moreWidth)
      if (hidden) {
        const more = slot(divider, moreWidth, height)
        more.addSpacer()
        text(more, `+${hidden}`, Font.mediumSystemFont(9), palette.secondary)
      }
    } else if (row.message) {
      const message = slot(line, span, rowHeight)
      message.addSpacer()
      text(message, row.message, Font.mediumSystemFont(valueSize), palette.secondary)
    } else if (row.single) {
      quotaCell(line, span, rowHeight, valueSize, row.single, now, row.label)
    } else {
      quotaCell(line, column, rowHeight, valueSize, row.short, now)
      line.addSpacer(gapWidth)
      quotaCell(line, column, rowHeight, valueSize, row.week, now)
    }
  }
}

function knownCount(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function validDay(value) {
  const at = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(value) : NaN
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value
}

function agentRows(rows) {
  return Array.isArray(rows) && rows.length === agentIds.length &&
    agentIds.every(id => rows.filter(row => row?.id === id).length === 1)
}

function isCompleteSnapshot(value) {
  if (value?.version !== 1 || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) return false
  const { usage, quota } = value
  return usage?.updatedAt === value.updatedAt && quota?.updatedAt === value.updatedAt &&
    validDay(usage.day) && agentRows(usage.agents) &&
    usage.agents.every(row => knownCount(row.tokens) && knownCount(row.input) && knownCount(row.cached) &&
      row.cached <= row.input && row.input <= row.tokens) &&
    Array.isArray(usage.days) && usage.days.length === 7 && usage.days.at(-1)?.day === usage.day &&
    new Set(usage.days.map(row => row?.day)).size === 7 &&
    usage.days.every(row => validDay(row?.day) && knownCount(row.tokens)) &&
    agentRows(quota.agents) && quota.agents.every(row => row.stale !== true &&
      Array.isArray(row.windows) && row.windows.length > 0 &&
      row.windows.length <= (row.id === 'antigravity' ? 24 : 2) &&
      new Set(row.windows.map(window => window?.label)).size === row.windows.length &&
      row.windows.every(window => typeof window?.label === 'string' && window.label.length <= 120 &&
        Number.isFinite(window.percent) && window.percent >= 0 && window.percent <= 1 &&
        (window.resetsAt === null || (typeof window.resetsAt === 'string' && Number.isFinite(Date.parse(window.resetsAt))))))
}

function endpoint(route) {
  return settings.endpoint.replace(/\/codeburn-quota$/, route)
}

function privateRequest(url) {
  const request = new Request(url)
  request.headers = { Authorization: `Bearer ${settings.accessKey}` }
  request.timeoutInterval = 7
  request.onRedirect = () => null
  return request
}

// Each accepted timestamp has its own file. An older completion from another
// Scriptable run cannot overwrite a newer one. A torn save is ignored and
// the last few valid generations are retained. Never mix independent blocks.
function snapshotCache(disk, url) {
  const base = disk.libraryDirectory()
  const prefix = 'codeburn-complete-' + encodeURIComponent(url.toLowerCase()) + '-'
  const nameFor = stamp => prefix + stamp + '.json'
  const fileFor = name => disk.joinPath(base, name)
  const scan = () => {
    const matches = []
    try {
      for (const name of disk.listContents(base)) {
        if (!name.startsWith(prefix) || !/^\d+\.json$/.test(name.slice(prefix.length))) continue
        const stamp = Number(name.slice(prefix.length, -5))
        try {
          const value = JSON.parse(disk.readString(fileFor(name)))
          if (isCompleteSnapshot(value) && Date.parse(value.updatedAt) === stamp) matches.push({ name, stamp, value })
        } catch {}
      }
    } catch {}
    return matches.sort((a, b) => b.stamp - a.stamp)
  }
  return {
    read: () => scan()[0]?.value ?? null,
    accept(value) {
      const stamp = Date.parse(value.updatedAt)
      const existing = scan()[0]
      if (existing && existing.stamp >= stamp) return { value: existing.value, cached: existing.stamp > stamp }
      const name = nameFor(stamp)
      try {
        const path = fileFor(name)
        // If another process finished this commit meanwhile, its copy wins.
        // Same-stamp data conflicts are not authoritative updates.
        let same = null
        try { same = JSON.parse(disk.readString(path)) } catch {}
        if (!isCompleteSnapshot(same) || Date.parse(same.updatedAt) !== stamp) disk.writeString(path, JSON.stringify(value))
      } catch {}
      const all = scan()
      for (const entry of all.slice(3)) {
        try { disk.remove(fileFor(entry.name)) } catch {}
      }
      const best = all[0]
      return best && best.stamp >= stamp ? { value: best.value, cached: best.stamp > stamp }
        : { value, cached: false }
    },
  }
}

async function loadData(card) {
  if (!settings) return { data: null, status: '请先导入已配置的脚本' }
  const url = endpoint('/codeburn-snapshot')
  const cache = snapshotCache(FileManager.local(), url)
  const part = card === 'quota' ? 'quota' : 'usage'
  try {
    const request = privateRequest(url)
    const value = await request.loadJSON()
    if (request.response.statusCode === 401) return { data: null, status: '请重新导入配对脚本' }
    if (request.response.statusCode === 503) {
      const previous = cache.read()
      return previous ? { data: previous[part], updatedAt: previous.updatedAt, status: '显示缓存' }
        : { data: null, status: '等待首次完整同步' }
    }
    if (request.response.statusCode !== 200 || !isCompleteSnapshot(value)) throw new Error('Widget data unavailable')
    const latest = cache.accept(value)
    return { data: latest.value[part], updatedAt: latest.value.updatedAt, status: latest.cached ? '显示缓存' : null }
  } catch {
    const previous = cache.read()
    if (previous) return { data: previous[part], updatedAt: previous.updatedAt, status: '显示缓存' }
    return { data: null, status: '等待同步，请检查 Mac 或 Tailscale' }
  }
}

function sum(values) {
  return values.some(value => value === null || !Number.isFinite(value))
    ? null : values.reduce((total, value) => total + value, 0)
}

function tokenParts(number) {
  if (number === null || !Number.isFinite(number)) return ['—', '']
  const units = ['', 'K', 'M', 'B']
  let index = 0
  let value = number
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000
    index++
  }
  // Use short numbers for the available space and roll over at the next unit.
  const precision = value < 10 ? 2 : value < 100 ? 1 : 0
  let rounded = Number(value.toFixed(index === 0 ? 0 : precision))
  if (rounded >= 1000 && index < units.length - 1) {
    rounded /= 1000
    index++
  }
  return [String(rounded), units[index]]
}

function tokenAmount(parent, count, numberSize, unitSize, labelSize = 0) {
  const [value, unit] = tokenParts(count)
  const line = horizontal(parent)
  line.bottomAlignContent()
  const amountColor = labelSize ? palette.primary : palette.accent
  const unitColor = labelSize ? palette.secondary : palette.accent
  text(line, value, Font.boldSystemFont(numberSize), amountColor)

  // Scriptable aligns the text frames, so compensate for their different descents.
  if (unit) {
    line.addSpacer(2)
    const suffix = horizontal(line)
    suffix.setPadding(0, 0, Math.round((numberSize - unitSize) * 0.20), 0)
    text(suffix, unit, Font.semiboldSystemFont(unitSize), unitColor)
  }
  if (labelSize) {
    line.addSpacer(3)
    const caption = horizontal(line)
    caption.setPadding(0, 0, Math.round((numberSize - labelSize) * 0.20), 0)
    text(caption, 'Tokens', Font.mediumSystemFont(labelSize), palette.secondary)
  }
}

function tokenTotal(parent, count, family) {
  const small = family === 'small'
  tokenAmount(parent, count, small ? 25 : 33, small ? 9.5 : 11, small ? 7 : 8)
}

function hitRate(usage) {
  const input = sum(usage.agents.map(agent => agent.input))
  const cached = sum(usage.agents.map(agent => agent.cached))
  return input > 0 && cached !== null && cached <= input ? Math.round(100 * cached / input) : null
}

function calendarKey(now) {
  const date = new Date(now)
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map(value => String(value).padStart(2, '0')).join('-')
}

async function readVinyl(usage) {
  if (!settings || !usage) return null
  const total = sum(usage.agents.map(agent => agent.tokens)) ?? 0
  const groove = Math.max(2, Math.min(36, Math.round(36 * total / 1e9)))
  const url = endpoint(`/codeburn-vinyl/${finish}-${groove}.png`)
  const disk = FileManager.local()
  const file = disk.joinPath(disk.libraryDirectory(), `codeburn-v3-vinyl-${finish}-${groove}.png`)
  try {
    if (disk.fileExists(file)) return disk.readImage(file)
  } catch {}
  try {
    const request = privateRequest(url)
    const image = await request.loadImage()
    if (request.response.statusCode !== 200 || image.size.width !== 444 || image.size.height !== 444) return null
    try { disk.writeImage(file, image) } catch {}
    return image
  } catch {
    return null
  }
}

function rgb(hex) {
  return new Color('#' + hex.toString(16).padStart(6, '0'))
}

function colorAt(a, b, ratio) {
  const channels = [16, 8, 0].map(shift => {
    const start = (a >> shift) & 255
    const end = (b >> shift) & 255
    return Math.round(start + (end - start) * ratio).toString(16).padStart(2, '0')
  })
  return new Color('#' + channels.join(''))
}

function chassis(width, height, art, usage, transparent = false) {
  const canvas = new DrawContext()
  canvas.size = new Size(width, height)
  canvas.respectScreenScale = true
  canvas.opaque = !transparent
  if (!transparent) {
    const stops = chassisStops[finish]
    const band = 4
    for (let y = 0; y < height; y += band) {
      const progress = (y / height) * 2
      const left = Math.min(1, Math.floor(progress))
      canvas.setFillColor(colorAt(stops[left], stops[left + 1], progress - left))
      canvas.fillRect(new Rect(0, y, width, band))
    }
  }
  canvas.setFillColor(new Color('#ffffff', transparent ? 0.065 : light ? 0.34 : 0.025))
  for (let x = 0; x < width; x += 3) canvas.fillRect(new Rect(x, 0, 0.7, height))
  if (art && usage) {
    const side = Math.min(width, height)
    const left = width - side
    const scale = side / 222
    canvas.drawImageInRect(art, new Rect(left, height - side, side, side))
    const total = sum(usage.agents.map(agent => agent.tokens)) ?? 0
    let angle = -Math.PI / 2
    for (const [index, agent] of agentIds.entries()) {
      const tokens = usage.agents.find(row => row.id === agent)?.tokens ?? 0
      if (total <= 0 || tokens <= 0) continue
      const span = (tokens / total) * Math.PI * 2
      const path = new Path()
      const segments = Math.max(2, Math.ceil(span * 23))
      for (let point = 0; point <= segments; point++) {
        const theta = angle + span * (point / segments)
        const position = new Point(left + (178 + 22.6 * Math.cos(theta)) * scale,
          height - side + (168 + 22.6 * Math.sin(theta)) * scale)
        if (point === 0) path.move(position)
        else path.addLine(position)
      }
      angle += span
      canvas.addPath(path)
      canvas.setStrokeColor(new Color(agentColors[index]))
      canvas.setLineWidth(Math.max(1, 2.4 * scale))
      canvas.strokePath()
    }
  }
  return canvas.getImage()
}

function updatedTime(raw, now) {
  if (!raw) return '—'
  const date = new Date(raw)
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.toDateString() === new Date(now).toDateString()) return time
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`
}

function smallQuota(widget, quota, now, width) {
  for (const agent of quota.agents) {
    widget.addSpacer()
    const row = horizontal(widget)
    const window = compactQuotaWindow(agent, quota.updatedAt)
    identity(row, agent, 14)
    row.addSpacer()
    if (!window) {
      text(row, '额度暂不可用', Font.mediumSystemFont(9), palette.secondary)
      continue
    }
    const expired = quotaExpired(window, now)
    const bucket = window.label.toLowerCase()
    if (bucket.includes('week')) text(row, '每周', Font.mediumSystemFont(8), palette.secondary)
    else if (/(?:five|5)[ -]hour/.test(bucket)) text(row, '5 小时', Font.mediumSystemFont(8), palette.secondary)
    row.addSpacer(4)
    if (expired) {
      text(row, '已过期', Font.mediumSystemFont(8), palette.secondary)
      row.addSpacer(4)
    }
    text(row, `${Math.round(100 * (1 - window.percent))}%`, Font.semiboldMonospacedSystemFont(10), expired ? palette.secondary : palette.primary)
    bar(widget, width, 3.7, 1 - window.percent, false)
  }
}

function todayPanel(widget, usage, family, width) {
  const small = family === 'small'
  tokenTotal(widget, sum(usage.agents.map(agent => agent.tokens)), family)
  widget.addSpacer()
  const ranked = usage.agents.filter(agent => agent.tokens !== 0)
    .sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1))
  for (const agent of ranked) {
    const row = horizontal(widget)
    const ticker = slot(row, small ? Math.max(52, width * 0.47) : 138, 13)
    icon(ticker, agent.id, 9, 'terminal')
    ticker.addSpacer()
    tokenAmount(ticker, agent.tokens, 8.7, 7)
    row.addSpacer()
  }
}

function sleeveImage(usage, width, height, axisHeight) {
  const canvas = new DrawContext()
  canvas.size = new Size(width, height + axisHeight)
  canvas.opaque = false
  canvas.respectScreenScale = true
  const gap = 3
  const column = (width - 6 * gap) / 7
  const days = ['日', '一', '二', '三', '四', '五', '六']
  const max = Math.max(1, ...usage.days.map(row => row.tokens ?? 0))
  const peak = usage.days.findIndex(row => row.tokens === max)
  for (const [index, row] of usage.days.entries()) {
    const x = index * (column + gap)
    const value = row.tokens ?? 0
    const today = row.day === usage.day
    const coverHeight = value > 0 ? Math.max(2, (height - 13) * value / max) : 1
    const y = height - coverHeight
    if (value > 0) {
      const diskHeight = today ? Math.min(12, column * 0.7) : 2
      const left = x + column * 0.1
      canvas.setFillColor(today ? new Color('#f78c47') : paint.well)
      canvas.fillEllipse(new Rect(left, y - diskHeight, column * 0.8, diskHeight * 2))
      if (today) {
        canvas.setFillColor(new Color('#ffd48b'))
        canvas.fillEllipse(new Rect(left + column * 0.23, y - diskHeight * 0.55, column * 0.34, diskHeight))
      }
    }
    canvas.setFillColor(today ? paint.accent : new Color(coverColors[index % coverColors.length]))
    canvas.fillRect(new Rect(x, y, column, coverHeight))
    if (index === peak && !today && y >= 8) {
      canvas.setFillColor(new Color('#f8cc6a'))
      canvas.fillRect(new Rect(x, Math.max(0, y - 8), column, 6))
      canvas.setTextColor(new Color('#251911'))
      canvas.setFont(Font.semiboldMonospacedSystemFont(Math.min(4.8, column / 2.8)))
      canvas.setTextAlignedCenter()
      canvas.drawTextInRect('峰值', new Rect(x, Math.max(0, y - 8), column, 6))
      canvas.setTextAlignedLeft()
    }
    const weekday = days[new Date(row.day + 'T12:00:00').getDay()] ?? '—'
    canvas.setTextAlignedCenter()
    canvas.setTextColor(today ? paint.accent : paint.primary)
    canvas.setFont(Font.semiboldSystemFont(7.2))
    canvas.drawTextInRect(weekday, new Rect(x, height + 0.25, column, axisHeight - 0.25))
    canvas.setTextAlignedLeft()
  }
  canvas.setFillColor(paint.rule)
  canvas.fillRect(new Rect(0, height, width, 0.5))
  return canvas.getImage()
}

function trendPanel(widget, usage, family, width, widgetHeight, mastheadHeight) {
  const small = family === 'small'
  tokenTotal(widget, sum(usage.days.map(day => day.tokens)), family)
  widget.addSpacer()
  const totalHeight = small ? 30 : 39
  const axisHeight = 9.5
  const height = Math.max(27, Math.min(62, widgetHeight - 2 * inset - mastheadHeight - 4 - totalHeight - axisHeight - 13 - 6))
  const chartWidth = Math.floor(width * (small ? 0.86 : 0.88))
  const line = slot(widget, width, height + axisHeight)
  line.addSpacer(Math.floor((width - chartWidth) / 2))
  const display = line.addImage(sleeveImage(usage, chartWidth, height, axisHeight))
  display.imageSize = new Size(chartWidth, height + axisHeight)
}

function widgetStatus(card, data) {
  if (card === 'quota') return { label: '剩余', unit: '' }
  if (!data) return null
  if (card === 'today') {
    const rate = hitRate(data)
    return rate === null ? null : { label: `Cache ${rate}%`, unit: '' }
  }
  const [value, unit] = tokenParts(Math.max(...data.days.map(day => day.tokens)))
  return { label: `Max ${value}`, unit }
}

function widgetMasthead(parent, card, title, status, family) {
  const large = family === 'large'
  const titleHeight = large ? 18 : 13
  const captionHeight = large ? 12 : 9
  const mastheadHeight = titleHeight + captionHeight
  const header = slot(parent, 0, mastheadHeight)
  const identity = header.addStack()
  identity.layoutVertically()
  identity.spacing = 0
  text(slot(identity, 0, titleHeight), title, Font.boldSystemFont(large ? 15 : 11.5), palette.accent)
  const name = { today: 'TURNTABLE', trend: 'LP CRATE', quota: 'DUAL CASSETTE DECK' }[card]
  const caption = slot(identity, 0, captionHeight)
  text(caption, name, Font.mediumMonospacedSystemFont(large ? 9 : 7.5), palette.secondary).minimumScaleFactor = 0.7
  header.addSpacer()
  if (status) {
    const dot = slot(header, 4, 4)
    dot.cornerRadius = 2
    dot.backgroundColor = palette.accent
    header.addSpacer(4)
    const caption = horizontal(header)
    caption.bottomAlignContent()
    text(caption, status.label, Font.mediumSystemFont(large ? 10 : 8.5), palette.secondary)
    if (status.unit) {
      caption.addSpacer(2)
      const unit = horizontal(caption)
      unit.setPadding(0, 0, 0.5, 0)
      text(unit, status.unit, Font.mediumSystemFont(large ? 8 : 6.5), palette.secondary)
    }
    if (card === 'quota') header.addSpacer(family === 'small' ? 6 : 10)
  }
  return mastheadHeight
}

function widgetSurface(widget, width, height, art, usage) {
  widget.backgroundColor = palette.surface
  if (!automatic) {
    widget.setPadding(inset, inset, inset, inset)
    widget.backgroundImage = chassis(width, height, art, usage)
    return widget
  }
  const gradient = new LinearGradient()
  gradient.colors = chassisStops.light.map((hex, index) => Color.dynamic(
    rgb(hex), rgb(chassisStops[systemDarkFinish][index])))
  gradient.locations = [0, 0.56, 1]
  gradient.startPoint = new Point(0, 0)
  gradient.endPoint = new Point(0.7, 1)
  widget.backgroundGradient = gradient
  // Draw the same grain over the dynamic gradient for every card. Only
  // Today adds the record to that full-card transparent layer.
  widget.setPadding(0, 0, 0, 0)
  const content = widget.addStack()
  content.layoutVertically()
  content.spacing = 0
  content.setPadding(inset, inset, inset, inset)
  content.backgroundImage = chassis(width, height, art, usage, true)
  return content
}

function vinylWidget(card, data, updatedAt, status, now, family, art) {
  const widget = new ListWidget()
  widget.spacing = 0
  widget.refreshAfterDate = new Date(now + refreshInterval)
  widget.url = URLScheme.forRunningScript()
  const [width, height] = widgetSize(family)
  const contentWidth = width - 2 * inset
  const content = widgetSurface(widget, width, height, card === 'today' ? art : null, data)

  const pastUsage = card !== 'quota' && data && data.day !== calendarKey(now)
  const title = pastUsage ? (card === 'today' ? '用量 ' : '趋势截至 ') + data.day.slice(5)
    : {today:'今日用量', trend:'7 天趋势', quota:'套餐额度'}[card]
  const mastheadHeight = widgetMasthead(content, card, title, widgetStatus(card, data), family)

  content.addSpacer(4)
  if (!data) {
    content.addSpacer()
    text(content, status ?? '等待数据同步', Font.mediumSystemFont(10), palette.secondary)
    content.addSpacer()
  } else if (card === 'today') {
    todayPanel(content, data, family, contentWidth)
  } else if (card === 'trend') {
    trendPanel(content, data, family, contentWidth, height, mastheadHeight)
  } else if (family === 'small') {
    smallQuota(content, data, now, contentWidth)
  } else {
    const large = family === 'large'
    const tableBudget = height - (2 * inset + mastheadHeight + 4 + 13 + 5)
    quotaTable(content, data, now, contentWidth, tableBudget, large)
  }

  content.addSpacer()
  const foot = slot(content, 0, 13)
  const prefix = status === '显示缓存' ? '上次同步' : '上次刷新'
  const stale = updatedAt && now - Date.parse(updatedAt) > 20 * 60 * 1000
  text(foot, `${prefix} ${updatedTime(updatedAt, now)}${stale ? ' · 待更新' : ''}`,
    Font.mediumSystemFont(8.5), palette.secondary)
  return widget
}

const card = settings?.card ?? 'quota'
const family = config.runsInWidget ? config.widgetFamily : card === 'quota' ? 'large' : 'small'
const { data, updatedAt, status } = await loadData(card)
const art = card === 'today' ? await readVinyl(data) : null
const now = Date.now()
const widget = vinylWidget(card, data, updatedAt, status, now, family, art)
if (config.runsInWidget) Script.setWidget(widget)
else if (family === 'large') await widget.presentLarge()
else await widget.presentSmall()
Script.complete()

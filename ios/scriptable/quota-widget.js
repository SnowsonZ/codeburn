// Variables used by Scriptable.
// icon-color: green; icon-glyph: tachometer-alt;
const settings = null // Replaced when exporting the configured script.

const palette = {
  surface: Color.dynamic(new Color('#ffffff'), new Color('#222224')),
  panel: Color.dynamic(new Color('#f5f6f7'), new Color('#2e2e31')),
  iconTile: Color.dynamic(new Color('#e7f3eb'), new Color('#294137')),
  gauge: Color.dynamic(new Color('#287a51'), new Color('#8fd9ac')),
  primary: Color.dynamic(new Color('#242426'), new Color('#f3f3f4')),
  secondary: Color.dynamic(new Color('#62646b'), new Color('#b2b2b9')),
  used: Color.dynamic(new Color('#b1b1b3'), new Color('#77777c')),
  remaining: new Color('#4bb978'),
  rule: Color.dynamic(new Color('#e2e2e6'), new Color('#46464b')),
  badge: Color.dynamic(new Color('#e7e7e9'), new Color('#414144')),
}
const inset = 16
const railWidth = 50
const columnGap = 10
const panelInset = 10
const refreshInterval = 15 * 60 * 1000

// Large iPhone widget sizes from Apple's Human Interface Guidelines, in points.
const largeWidgetSizes = {
  '320x568': [292, 311],
  '360x780': [329, 345],
  '375x667': [321, 324],
  '375x812': [329, 345],
  '390x844': [338, 354],
  '393x852': [338, 354],
  '414x736': [348, 357],
  '414x896': [360, 379],
  '428x926': [364, 382],
  '430x932': [364, 382],
}

function largeWidgetSize() {
  const screen = Device.screenSize()
  const width = Math.min(screen.width, screen.height)
  const height = Math.max(screen.width, screen.height)
  const documented = largeWidgetSizes[`${Math.round(width)}x${Math.round(height)}`]
  if (documented) return documented
  const conservativeWidth = Math.min(364, Math.max(260, Math.floor(width) - 66))
  return [conservativeWidth, conservativeWidth + 12]
}

function text(stack, value, font, color = palette.primary) {
  const label = stack.addText(value)
  label.font = font
  label.textColor = color
  label.lineLimit = 1
  label.minimumScaleFactor = 0.8
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

function identity(stack, row, height) {
  const rail = slot(stack, railWidth, height)
  if (row.id) {
    const size = Math.min(height, row.id === 'zcode' ? 22 : 18)
    const markWidth = 22
    const offset = (markWidth - size) / 2
    if (offset > 0) rail.addSpacer(offset)
    icon(rail, row.id, size, 'terminal')
    if (row.stale) {
      rail.addSpacer(markWidth - size - offset + 4)
      icon(rail, null, 10, 'clock.arrow.circlepath', palette.secondary)
    }
  } else {
    rail.addSpacer(9)
    const name = row.group.toLowerCase()
    const claude = name.includes('claude')
    const gpt = name.includes('gpt')
    const gemini = name.includes('gemini')
    const model = claude ? 'claude' : gpt ? 'codex' : gemini ? 'gemini' : null
    icon(rail, model, 14, 'cpu')
    if (claude && gpt) {
      rail.addSpacer(4)
      icon(rail, 'codex', 14, 'circle.hexagongrid')
    } else if (gemini && name.includes('argon')) {
      rail.addSpacer(4)
      const badge = slot(rail, 22, 15)
      badge.cornerRadius = 4
      badge.backgroundColor = palette.badge
      badge.addSpacer(5)
      text(badge, 'Ar', Font.semiboldMonospacedSystemFont(9), palette.secondary)
    }
  }
  rail.addSpacer()
}

function accountRows(agent) {
  if (!agent.windows.length) return [{ ...agent, message: '额度暂不可用' }]
  const short = agent.windows.find(window => window.label === '5-hour')
  const week = agent.windows.find(window => window.label === 'Weekly')
  const other = agent.windows.filter(window => window !== short && window !== week)
  const rows = short || week ? [{ ...agent, short, week }] : []
  return rows.concat(other.map(window => ({ ...agent, single: window, label: window.label })))
}

function gravityRows(agent, limit) {
  if (!agent.windows.length) return [{ ...agent, message: '额度暂不可用' }]
  const groups = new Map()
  const rows = []
  for (const window of agent.windows) {
    const [group, bucket = ''] = window.label.split(' · ', 2)
    const period = /(?:five|5)[ -]hour/i.test(bucket) ? 'short' : /weekly/i.test(bucket) ? 'week' : null
    if (!period) {
      rows.push({ group, single: window, label: group })
      continue
    }
    if (!groups.has(group)) {
      const row = { group }
      groups.set(group, row)
      rows.push(row)
    }
    groups.get(group)[period] = window
  }
  return [{ ...agent, rule: true, extra: Math.max(0, rows.length - limit) }, ...rows.slice(0, limit)]
}

function bar(parent, width, height, used) {
  const view = slot(parent, width, height)
  view.cornerRadius = height / 2
  if (used === 0 || used === 1) {
    view.backgroundColor = used === 0 ? palette.remaining : palette.used
    return
  }
  const gradient = new LinearGradient()
  gradient.startPoint = new Point(0, 0.5)
  gradient.endPoint = new Point(1, 0.5)
  gradient.colors = [palette.used, palette.used, palette.remaining, palette.remaining]
  gradient.locations = [0, used, Math.min(1, used + 0.001), 1]
  view.backgroundGradient = gradient
}

function quotaCell(parent, width, rowHeight, valueSize, window, now, label) {
  const view = slot(parent, width, rowHeight)
  if (!window) return
  if (window.resetsAt && Date.parse(window.resetsAt) <= now) {
    view.addSpacer()
    text(view, '待更新', Font.mediumSystemFont(Math.min(13, valueSize)), palette.secondary)
    return
  }
  const numberWidth = Math.ceil(valueSize * 2.5 + 2)
  const numberGap = 7
  let barWidth = width - numberWidth - numberGap
  if (label) {
    const labelWidth = Math.min(82, Math.floor(width * 0.36))
    const labelSlot = slot(view, labelWidth, rowHeight)
    text(labelSlot, label === 'Session' ? '会话' : label, Font.mediumSystemFont(11), palette.secondary)
    labelSlot.addSpacer()
    barWidth -= labelWidth + numberGap
    view.addSpacer(numberGap)
  }
  bar(view, barWidth, valueSize >= 15 ? 7 : 5, window.percent)
  view.addSpacer(numberGap)
  const value = slot(view, numberWidth, rowHeight)
  value.addSpacer()
  text(value, `${Math.round((1 - window.percent) * 100)}%`, Font.semiboldSystemFont(valueSize))
}

function rule(parent, width) {
  slot(parent, width, 1).backgroundColor = palette.rule
}

function quotaTable(widget, quota, now, width, availableHeight) {
  const column = Math.floor((width - railWidth - 2 * columnGap) / 2)
  const span = column * 2 + columnGap
  const byId = new Map(quota.agents.map(agent => [agent.id, agent]))
  const account = id => byId.get(id) ?? { id, windows: [] }
  const accounts = [...accountRows(account('codex')), ...accountRows(account('zcode'))]
  const minRowHeight = 18
  const maxModelCount = Math.min(8, Math.max(1, Math.floor(availableHeight / minRowHeight) - accounts.length - 1))
  const rows = [...accounts, ...gravityRows(account('antigravity'), maxModelCount)]
  const rowHeight = Math.min(34, Math.floor(availableHeight / rows.length))
  const valueSize = rowHeight >= 30 ? 16 : rowHeight >= 23 ? 14 : 12

  const headers = horizontal(widget)
  headers.addSpacer(railWidth + columnGap)
  const periods = ['5 小时', '每周']
  for (const title of periods) {
    const heading = slot(headers, column, 18)
    heading.addSpacer()
    text(heading, title, Font.mediumSystemFont(11), palette.secondary)
    if (title === periods[0]) headers.addSpacer(columnGap)
  }
  widget.addSpacer(2)

  // Distribute the space proposed by WidgetKit between rows so the table
  // expands with the card and the footer stays at the bottom.
  for (const row of rows) {
    widget.addSpacer()
    const line = horizontal(widget)
    const height = row.rule ? Math.min(26, rowHeight) : rowHeight
    identity(line, row, height)
    line.addSpacer(columnGap)
    if (row.rule) {
      const separator = slot(line, span, height)
      rule(separator, row.extra ? span - 29 : span)
      if (row.extra) {
        separator.addSpacer(6)
        text(separator, `+${row.extra}`, Font.mediumSystemFont(10), palette.secondary)
      }
    } else if (row.message) {
      const message = slot(line, span, height)
      message.addSpacer()
      text(message, row.message, Font.mediumSystemFont(11), palette.secondary)
    } else if (row.single) {
      quotaCell(line, span, height, valueSize, row.single, now, row.label)
    } else {
      quotaCell(line, column, height, valueSize, row.short, now)
      line.addSpacer(columnGap)
      quotaCell(line, column, height, valueSize, row.week, now)
    }
  }
}

function isQuota(value) {
  return value?.version === 1 && Number.isFinite(Date.parse(value.updatedAt)) &&
    Array.isArray(value.agents) && value.agents.every(agent => typeof agent?.id === 'string' &&
      Array.isArray(agent.windows) && agent.windows.every(window =>
        typeof window?.label === 'string' && Number.isFinite(window.percent) &&
        window.percent >= 0 && window.percent <= 1))
}

async function loadQuota() {
  if (!settings) return { quota: null, status: '请先导入已配置的脚本' }
  const disk = FileManager.local()
  const source = settings.endpoint.replace(/[^a-z0-9]/gi, '-')
  const cache = disk.joinPath(disk.libraryDirectory(), `codeburn-${source}.json`)
  try {
    const request = new Request(settings.endpoint)
    request.headers = { Authorization: `Bearer ${settings.accessKey}` }
    request.timeoutInterval = 7
    request.onRedirect = () => null
    const value = await request.loadJSON()
    if (request.response.statusCode === 401) return { quota: null, status: '请重新导入配对脚本' }
    if (request.response.statusCode !== 200 || !isQuota(value)) throw new Error('Quota unavailable')
    try { disk.writeString(cache, JSON.stringify(value)) } catch {}
    return { quota: value, status: null }
  } catch {
    try {
      const previous = JSON.parse(disk.readString(cache))
      if (isQuota(previous)) return { quota: previous, status: '显示缓存' }
    } catch {}
    return { quota: null, status: '等待同步，请检查 Mac 或 Tailscale' }
  }
}

function updatedTime(raw, now) {
  if (!raw) return '—'
  const date = new Date(raw)
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.toDateString() === new Date(now).toDateString()) return time
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`
}

function quotaWidget(quota, status, now, family) {
  const widget = new ListWidget()
  widget.setPadding(inset, inset, inset, inset)
  widget.spacing = 0
  widget.backgroundColor = palette.surface
  widget.refreshAfterDate = new Date(now + refreshInterval)
  widget.url = URLScheme.forRunningScript()

  const large = family === 'large'
  const [width, height] = largeWidgetSize()
  const contentWidth = width - 2 * inset
  const headerHeight = large ? 28 : 21
  const headerGap = 11
  const footerHeight = 16
  const footerGap = 9
  const header = slot(widget, 0, headerHeight)
  if (large) {
    const tile = slot(header, 28, 28)
    tile.cornerRadius = 8
    tile.backgroundColor = palette.iconTile
    tile.addSpacer(6)
    icon(tile, null, 16, 'speedometer', palette.gauge)
  } else {
    icon(header, null, 15, 'speedometer')
  }
  header.addSpacer(8)
  text(header, '套餐额度', Font.semiboldSystemFont(large ? 17 : 14))
  header.addSpacer()

  if (large) {
    const dot = slot(header, 5, 5)
    dot.cornerRadius = 2.5
    dot.backgroundColor = palette.remaining
    header.addSpacer(5)
    text(header, '剩余', Font.mediumSystemFont(11), palette.secondary)
  }

  widget.addSpacer(headerGap)
  if (large && quota) {
    const panelHeight = height - 2 * inset - headerHeight - headerGap - footerGap - footerHeight - 3
    const panel = widget.addStack()
    panel.layoutVertically()
    panel.size = new Size(contentWidth, panelHeight)
    panel.setPadding(8, panelInset, 8, panelInset)
    panel.spacing = 0
    panel.cornerRadius = 15
    panel.backgroundColor = palette.panel
    const rowBudget = panelHeight - 16 - 20 - 8 // Insets, column headings, minimum flexible space.
    quotaTable(panel, quota, now, contentWidth - 2 * panelInset, rowBudget)
    panel.addSpacer()
    widget.addSpacer()
    widget.addSpacer(footerGap)
  } else {
    widget.addSpacer()
    text(widget, large ? status : '请选择大号小组件', Font.mediumSystemFont(12), palette.secondary)
    widget.addSpacer()
  }

  const foot = slot(widget, 0, footerHeight)
  text(foot, `上次刷新 ${updatedTime(quota?.updatedAt, now)}`, Font.mediumSystemFont(11), palette.secondary)
  if (large && quota) {
    const freshness = status ?? (now - Date.parse(quota.updatedAt) > 20 * 60 * 1000 ? '数据待同步' : null)
    if (freshness) {
      foot.addSpacer()
      text(foot, freshness, Font.mediumSystemFont(11), palette.secondary)
    }
  }
  return widget
}

const now = Date.now()
const { quota, status } = await loadQuota()
const widget = quotaWidget(quota, status, now, config.runsInWidget ? config.widgetFamily : 'large')
if (config.runsInWidget) Script.setWidget(widget)
else await widget.presentLarge()
Script.complete()

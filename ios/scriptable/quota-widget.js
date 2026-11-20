// Variables used by Scriptable.
// icon-color: green; icon-glyph: tachometer-alt;
const settings = null // Replaced when exporting the configured script.

const palette = {
  surface: Color.dynamic(new Color('#ffffff'), new Color('#272728')),
  primary: Color.dynamic(new Color('#242426'), new Color('#f3f3f4')),
  secondary: Color.dynamic(new Color('#6d6d72'), new Color('#a8a8ac')),
  used: Color.dynamic(new Color('#b1b1b3'), new Color('#7b7b7e')),
  remaining: new Color('#4bb978'),
  rule: Color.dynamic(new Color('#d8d8dc'), new Color('#515154')),
  badge: Color.dynamic(new Color('#e7e7e9'), new Color('#414144')),
}
const railWidth = 48
const gap = 14
const numberWidth = 39
const numberGap = 6
const refreshInterval = 15 * 60 * 1000

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
    const size = Math.min(height, row.id === 'zcode' ? 21 : 17)
    const mark = slot(rail, 21, height)
    if (size < 21) mark.addSpacer((21 - size) / 2)
    icon(mark, row.id, size, 'terminal')
    mark.addSpacer()
    if (row.stale) {
      rail.addSpacer(3)
      icon(rail, null, 10, 'clock.arrow.circlepath', palette.secondary)
    }
    return
  }

  rail.addSpacer(9)
  const name = row.group.toLowerCase()
  const claude = name.includes('claude')
  const gpt = name.includes('gpt')
  const gemini = name.includes('gemini')
  const model = claude ? 'claude' : gpt ? 'codex' : gemini ? 'gemini' : null
  icon(rail, model, 14, 'cpu')
  if (claude && gpt) {
    rail.addSpacer(5)
    icon(rail, 'codex', 14, 'circle.hexagongrid')
  } else if (gemini && name.includes('argon')) {
    rail.addSpacer(5)
    const badge = slot(rail, 16, 13)
    badge.cornerRadius = 3
    badge.backgroundColor = palette.badge
    badge.addSpacer()
    text(badge, 'Ar', Font.semiboldMonospacedSystemFont(8), palette.secondary)
    badge.addSpacer()
  }
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
  return [{ ...agent, rule: true, extra: Math.max(0, rows.length - 8) }, ...rows.slice(0, 8)]
}

function bar(parent, width, used) {
  const view = slot(parent, width, 6)
  view.cornerRadius = 3
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

function quotaCell(parent, width, height, window, now, label) {
  const view = slot(parent, width, height)
  if (!window) return
  if (window.resetsAt && Date.parse(window.resetsAt) <= now) {
    view.addSpacer()
    text(view, '待更新', Font.mediumSystemFont(11), palette.secondary)
    return
  }
  let barWidth = width - numberWidth - numberGap
  if (label) {
    const labelSlot = slot(view, Math.min(95, Math.floor(width * 0.4)), height)
    text(labelSlot, label === 'Session' ? '会话' : label, Font.mediumSystemFont(10), palette.secondary)
    labelSlot.addSpacer()
    barWidth -= labelSlot.size.width + numberGap
    view.addSpacer(numberGap)
  }
  bar(view, barWidth, window.percent)
  view.addSpacer(numberGap)
  const value = slot(view, numberWidth, height)
  value.addSpacer()
  text(value, `${Math.round((1 - window.percent) * 100)}%`, Font.mediumMonospacedSystemFont(13))
}

function quotaTable(widget, quota, now) {
  const screen = Device.screenSize()
  const width = Math.min(390, Math.min(screen.width, screen.height) - 55)
  const column = Math.floor((width - 32 - railWidth - 2 * gap) / 2)
  const span = column * 2 + gap
  const byId = new Map(quota.agents.map(agent => [agent.id, agent]))
  const rows = ['codex', 'zcode', 'antigravity'].flatMap(id => {
    const agent = byId.get(id) ?? { id, windows: [] }
    return id === 'antigravity' ? gravityRows(agent) : accountRows(agent)
  })
  const height = Math.min(35, Math.floor(239 / rows.length))

  const headers = horizontal(widget)
  headers.addSpacer()
  for (const title of ['5 小时', '每周']) {
    const heading = slot(headers, column, 17)
    heading.addSpacer()
    text(heading, title, Font.mediumSystemFont(10), palette.secondary)
    if (title === '5 小时') headers.addSpacer(gap)
  }
  widget.addSpacer(4)

  for (const row of rows) {
    const line = horizontal(widget)
    identity(line, row, height)
    line.addSpacer()
    if (row.rule) {
      const separator = slot(line, span, height)
      const rule = slot(separator, row.extra ? span - 26 : span, 1)
      rule.backgroundColor = palette.rule
      if (row.extra) {
        separator.addSpacer()
        text(separator, `+${row.extra}`, Font.mediumSystemFont(10), palette.secondary)
      }
    } else if (row.message) {
      text(line, row.message, Font.mediumSystemFont(11), palette.secondary)
    } else if (row.single) {
      quotaCell(line, span, height, row.single, now, row.label)
    } else {
      quotaCell(line, column, height, row.short, now)
      line.addSpacer(gap)
      quotaCell(line, column, height, row.week, now)
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
  widget.setPadding(16, 16, 16, 16)
  widget.backgroundColor = palette.surface
  widget.refreshAfterDate = new Date(now + refreshInterval)
  widget.url = URLScheme.forRunningScript()

  const header = horizontal(widget)
  icon(header, null, 15, 'speedometer')
  header.addSpacer(8)
  text(header, '套餐额度', Font.semiboldSystemFont(14))
  header.addSpacer()
  const large = family === 'large'
  if (large) {
    const dot = slot(header, 5, 5)
    dot.cornerRadius = 2.5
    dot.backgroundColor = palette.remaining
    header.addSpacer(4)
    text(header, '剩余', Font.mediumSystemFont(10), palette.secondary)
  }

  widget.addSpacer(5)
  if (large && quota) {
    quotaTable(widget, quota, now)
  } else {
    widget.addSpacer()
    text(widget, large ? status : '请选择大号小组件', Font.mediumSystemFont(12), palette.secondary)
  }
  widget.addSpacer()
  const foot = horizontal(widget)
  text(foot, `上次刷新 ${updatedTime(quota?.updatedAt, now)}`, Font.mediumSystemFont(10), palette.secondary)
  if (large && quota) {
    const freshness = status ?? (now - Date.parse(quota.updatedAt) > 20 * 60 * 1000 ? '数据待同步' : null)
    if (freshness) {
      foot.addSpacer()
      text(foot, freshness, Font.mediumSystemFont(10), palette.secondary)
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

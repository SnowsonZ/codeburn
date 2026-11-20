import AppKit
import Foundation
import SwiftUI
import WidgetKit

private func copy(_ chinese: String, _ english: String) -> String {
    Locale.current.language.languageCode?.identifier == "zh" ? chinese : english
}

private enum Agent: String, Decodable, CaseIterable {
    case codex, zcode, antigravity

    var name: String {
        switch self {
        case .codex: "Codex"
        case .zcode: "ZCode"
        case .antigravity: "Antigravity"
        }
    }

    var color: Color {
        switch self {
        case .codex: .teal
        case .zcode: .blue
        case .antigravity: .purple
        }
    }
}

private struct UsageAgent: Decodable {
    let id: Agent
    let tokens: Int?
    let input: Int?
    let cached: Int?
}

private struct UsageDay: Decodable, Identifiable {
    let day: String
    let tokens: Int?
    var id: String { day }
}

private struct UsageSnapshot: Decodable {
    let day: String
    let updatedAt: String
    let agents: [UsageAgent]
    let days: [UsageDay]

    var total: Int? { sum(agents.map(\.tokens)) }

    var rankedAgents: [UsageAgent] {
        agents.filter { $0.tokens != 0 }.sorted { ($0.tokens ?? -1) > ($1.tokens ?? -1) }
    }

    var cacheRate: Double? {
        guard let input = sum(agents.map(\.input)), input > 0,
              let cached = sum(agents.map(\.cached)), cached <= input else { return nil }
        return Double(cached) / Double(input)
    }
}

private enum QuotaPeriod {
    case fiveHours, weekly

    var title: String {
        switch self {
        case .fiveHours: copy("5 小时", "5h")
        case .weekly: copy("每周", "Week")
        }
    }

}

private struct QuotaWindow: Decodable {
    let label: String
    let percent: Double
    let resetsAt: String?

    var name: String {
        switch label {
        case "5-hour": copy("5 小时", "5h")
        case "Weekly": copy("每周", "Week")
        case "Session": copy("会话", "Session")
        default: label
        }
    }

    var remaining: Double { min(1, max(0, 1 - percent)) }

    var accountPeriod: QuotaPeriod? {
        switch label {
        case "5-hour": .fiveHours
        case "Weekly": .weekly
        default: nil
        }
    }

    var modelGroup: String {
        if let separator = label.range(of: " · ") {
            return String(label[..<separator.lowerBound])
        }
        return label
    }

    var modelPeriod: QuotaPeriod? {
        guard let separator = label.range(of: " · ") else { return nil }
        let bucket = label[separator.upperBound...].lowercased().replacingOccurrences(of: "-", with: " ")
        if bucket.contains("five hour") || bucket.contains("5 hour") { return .fiveHours }
        if bucket.contains("weekly") { return .weekly }
        return nil
    }

    func isActive(at date: Date) -> Bool {
        guard let reset = parseDate(resetsAt) else { return true }
        return reset > date
    }
}

private struct QuotaAgent: Decodable {
    let id: Agent
    let windows: [QuotaWindow]
    var stale: Bool? = nil
}

private struct ModelQuotaRow: Identifiable {
    let id: String
    let group: String
    var fiveHours: QuotaWindow? = nil
    var weekly: QuotaWindow? = nil
    var standalone: QuotaWindow? = nil
}

private func modelQuotaRows(_ windows: [QuotaWindow]) -> [ModelQuotaRow] {
    var rows: [ModelQuotaRow] = []
    for window in windows {
        let group = window.modelGroup
        guard let period = window.modelPeriod else {
            rows.append(.init(id: "other:" + window.label, group: group, standalone: window))
            continue
        }
        let index: Int
        if let existing = rows.firstIndex(where: { $0.group == group && $0.standalone == nil }) {
            index = existing
        } else {
            index = rows.count
            rows.append(.init(id: "group:" + group, group: group))
        }
        switch period {
        case .fiveHours: rows[index].fiveHours = window
        case .weekly: rows[index].weekly = window
        }
    }
    return rows
}

private struct QuotaSnapshot: Decodable {
    let updatedAt: String
    let agents: [QuotaAgent]
}

private struct Snapshot: Decodable {
    let version: Int
    let usage: UsageSnapshot?
    let quota: QuotaSnapshot?

    static func load() -> Self? {
        guard let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return nil
        }
        let file = directory.appending(path: "CodeBurn Widgets/snapshot.json")
        guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 32 * 1024,
              let data = try? Data(contentsOf: file),
              let snapshot = try? JSONDecoder().decode(Self.self, from: data),
              snapshot.version == 1 else { return nil }
        return snapshot
    }

    static func sample(now: Date) -> Self {
        let updated = now.ISO8601Format()
        let counts = [29_400_000, 12_800_000, 760_000]
        let agents = zip(Agent.allCases, counts).map { id, tokens in
            UsageAgent(id: id, tokens: tokens, input: tokens - 1_000, cached: tokens * 9 / 10)
        }
        let days = [16_500_000, 37_900_000, 31_300_000, 48_000_000, 25_600_000, 34_800_000, 42_960_000]
        let week = days.enumerated().map { index, tokens in
            let day = Calendar.current.date(byAdding: .day, value: index - 6, to: now) ?? now
            return UsageDay(day: dayKey(day), tokens: tokens)
        }
        let quotas = [
            QuotaAgent(id: .codex, windows: [
                QuotaWindow(label: "Weekly", percent: 0.55, resetsAt: nil),
            ]),
            QuotaAgent(id: .zcode, windows: [
                QuotaWindow(label: "Weekly", percent: 0.66, resetsAt: nil),
                QuotaWindow(label: "5-hour", percent: 0.01, resetsAt: nil),
            ]),
            QuotaAgent(id: .antigravity, windows: [
                QuotaWindow(label: "Claude and GPT models · Five Hour Limit Remaining", percent: 1, resetsAt: nil),
                QuotaWindow(label: "Claude and GPT models · Weekly Limit Remaining", percent: 0.69, resetsAt: nil),
                QuotaWindow(label: "Gemini 4 Argon · Gemini 4 Argon Weekly Limit Remaining", percent: 0.68, resetsAt: nil),
                QuotaWindow(label: "Gemini Models · Five Hour Limit Remaining", percent: 0.24, resetsAt: nil),
                QuotaWindow(label: "Gemini Models · Weekly Limit Remaining", percent: 0.25, resetsAt: nil),
            ]),
        ]
        return .init(version: 1, usage: .init(day: dayKey(now), updatedAt: updated, agents: agents, days: week),
                     quota: .init(updatedAt: updated, agents: quotas))
    }
}

private var civilCalendar: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .autoupdatingCurrent
    return calendar
}

private func dayKey(_ date: Date) -> String {
    let civil = civilCalendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", civil.year ?? 0, civil.month ?? 0, civil.day ?? 0)
}

private func parseDay(_ day: String) -> Date? {
    let parts = day.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3 else { return nil }
    return civilCalendar.date(from: .init(year: parts[0], month: parts[1], day: parts[2], hour: 12))
}

private func parseDate(_ value: String?) -> Date? {
    guard let value else { return nil }
    return (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value))
        ?? (try? Date.ISO8601FormatStyle().parse(value))
}

private func sum(_ values: [Int?]) -> Int? {
    let known = values.compactMap { $0 }
    return known.count == values.count ? known.reduce(0, +) : nil
}

private func compact(_ value: Int?) -> String {
    value?.formatted(.number.notation(.compactName)) ?? "—"
}

private func percent(_ value: Double) -> String {
    value.formatted(.percent.precision(.fractionLength(0)))
}

private enum Card: String {
    case today, trend, quota

    var title: String {
        switch self {
        case .today: copy("今日用量", "Today’s usage")
        case .trend: copy("7 天趋势", "7-day trend")
        case .quota: copy("套餐额度", "Plan quota")
        }
    }

    var description: String {
        switch self {
        case .today: copy("三款 Agent 的 Token 和缓存命中率。", "Tokens and cache hits for your three agents.")
        case .trend: copy("最近 7 天的 Token 消耗。", "Token usage over the last seven days.")
        case .quota: copy("各 Agent 的套餐窗口及剩余比例。", "Remaining percentage for each agent’s plan windows.")
        }
    }

    var symbol: String {
        switch self {
        case .today: "flame.fill"
        case .trend: "chart.bar.xaxis"
        case .quota: "gauge.with.dots.needle.33percent"
        }
    }
}

private struct Entry: TimelineEntry {
    let date: Date
    let snapshot: Snapshot?
}

private struct SnapshotProvider: TimelineProvider {
    func placeholder(in context: Context) -> Entry {
        let now = Date()
        return .init(date: now, snapshot: .sample(now: now))
    }

    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : .init(date: Date(), snapshot: .load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        let now = Date()
        let snapshot = Snapshot.load()
        let windows = snapshot?.quota?.agents.flatMap(\.windows) ?? []
        let waitingForQuota = windows.contains { !$0.isActive(at: now) }
        let interval: TimeInterval = snapshot == nil || waitingForQuota ? 5 * 60 : 15 * 60
        let midnight = civilCalendar.nextDate(after: now, matching: .init(hour: 0, minute: 0), matchingPolicy: .nextTime)
        let reset = windows.compactMap { parseDate($0.resetsAt) }.filter { $0 > now }.min()
        let next = min(now.addingTimeInterval(interval), midnight ?? .distantFuture, reset ?? .distantFuture)
        completion(Timeline(entries: [.init(date: now, snapshot: snapshot)], policy: .after(next)))
    }
}

private struct QuotaGridMetrics {
    let rowHeight: CGFloat
    let spacing: CGFloat
    let headingHeight: CGFloat
    let modelLimit: Int

    init(height: CGFloat, large: Bool, accountRows: Int, modelRows: Int, hasAntigravity: Bool) {
        headingHeight = large ? 17 : 12
        let budget = max(0, height - headingHeight)
        let fixedRows = accountRows + (hasAntigravity ? 1 : 0)
        let capacity = max(0, Int(budget / (large ? 19 : 11)) - fixedRows)
        modelLimit = min(modelRows, large ? 8 : 3, capacity)
        let rowCount = CGFloat(max(1, fixedRows + modelLimit))
        let pitch = budget / rowCount
        rowHeight = min(large ? 43 : 16, floor(max(0, pitch - (large ? 5 : 1))))
        spacing = min(large ? 13 : 4, max(0, pitch - rowHeight))
    }

    var valueSize: CGFloat { rowHeight >= 28 ? 16 : rowHeight >= 18 ? 13 : 10.5 }
    var barHeight: CGFloat { rowHeight >= 28 ? 7 : rowHeight >= 18 ? 6 : 4 }
    var valueWidth: CGFloat { ceil(valueSize * 2.5 + 2) }
}

private struct WidgetCard: View {
    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let card: Card
    let entry: Entry

    private var wide: Bool { family != .systemSmall }
    private var large: Bool { family == .systemLarge }
    private var dark: Bool { colorScheme == .dark }
    private var cardColor: Color { Color(rgb: dark ? 0x222224 : 0xffffff) }
    private var panelColor: Color { Color(rgb: dark ? 0x2e2e31 : 0xf5f6f7) }
    private var secondaryColor: Color { Color(rgb: dark ? 0xb2b2b9 : 0x62646b) }
    private var ruleColor: Color { Color(rgb: dark ? 0x46464b : 0xe2e2e6) }
    private var remainingColor: Color { Color(rgb: 0x4bb978) }
    private var usedColor: Color { Color(rgb: dark ? 0x77777c : 0xb1b1b3) }
    private var iconColor: Color {
        switch card {
        case .today: Color(rgb: dark ? 0xffb090 : 0xa74624)
        case .trend: Color(rgb: dark ? 0xaac7ff : 0x365b9b)
        case .quota: Color(rgb: dark ? 0x8fd9ac : 0x287a51)
        }
    }
    private var iconTileColor: Color {
        switch card {
        case .today: Color(rgb: dark ? 0x4b342c : 0xfaede6)
        case .trend: Color(rgb: dark ? 0x2d3b56 : 0xe9effb)
        case .quota: Color(rgb: dark ? 0x294137 : 0xe7f3eb)
        }
    }
    private var quotaIconSize: CGFloat { large ? 18 : (wide ? 12 : 13) }
    private let quotaIconGap: CGFloat = 4
    private var quotaIdentityWidth: CGFloat { large ? 50 : 36 }
    private var updateAnimation: Animation? { reduceMotion ? nil : .easeInOut(duration: 0.28) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            panelContent
                .padding(.horizontal, large ? 10 : 7)
                .padding(.vertical, large ? 8 : 4)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(panelColor, in: RoundedRectangle(cornerRadius: large ? 15 : 10))
                .padding(.top, large ? 11 : 4)
            refreshTime
                .padding(.top, large ? 9 : 4)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .containerBackground(for: .widget) { cardColor }
    }

    private var header: some View {
        let tile: CGFloat = large ? 28 : 20
        return HStack(spacing: large ? 8 : 6) {
            Image(systemName: card.symbol)
                .font(.system(size: large ? 16 : 11, weight: .semibold))
                .foregroundStyle(iconColor)
                .frame(width: tile, height: tile)
                .background(iconTileColor, in: RoundedRectangle(cornerRadius: large ? 8 : 6))
                .accessibilityHidden(true)
            Text(card.title)
                .font(.system(size: large ? 17 : 13, weight: .semibold))
                .lineLimit(1).minimumScaleFactor(0.75)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 3)
            if card == .quota {
                HStack(spacing: 4) {
                    Circle().fill(remainingColor).frame(width: 5, height: 5).accessibilityHidden(true)
                    Text(copy("剩余", "Remaining"))
                }
                .font(.system(size: large ? 11 : 9, weight: .medium))
                .foregroundStyle(secondaryColor)
                .lineLimit(1).minimumScaleFactor(0.8)
            }
        }
    }

    @ViewBuilder
    private var panelContent: some View {
        switch card {
        case .today:
            if let usage = entry.snapshot?.usage, usage.day == dayKey(entry.date) { today(usage) }
            else { empty(copy("打开 CodeBurn 同步", "Open CodeBurn to sync")) }
        case .trend:
            if let usage = entry.snapshot?.usage, usage.day == dayKey(entry.date) { trend(usage) }
            else { empty(copy("等待用量同步", "Waiting for usage")) }
        case .quota:
            if let quota = entry.snapshot?.quota { quotas(quota) }
            else { empty(copy("等待额度同步", "Waiting for quota")) }
        }
    }

    private func empty(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(secondaryColor)
            .multilineTextAlignment(.center)
    }

    private var refreshTime: some View {
        let raw = card == .quota ? entry.snapshot?.quota?.updatedAt : entry.snapshot?.usage?.updatedAt
        let updated = parseDate(raw)
        return HStack(spacing: 4) {
            Text(copy("上次刷新", "Updated"))
            if let updated {
                if civilCalendar.isDate(updated, inSameDayAs: entry.date) {
                    Text(updated, style: .time)
                } else {
                    Text(updated, format: .dateTime.month(.defaultDigits).day().hour().minute())
                }
            } else {
                Text("—")
            }
        }
        .font(.system(size: large ? 11 : 9, weight: .medium))
        .monospacedDigit().foregroundStyle(secondaryColor).lineLimit(1).minimumScaleFactor(0.8)
        .accessibilityElement(children: .combine)
    }

    private func today(_ usage: UsageSnapshot) -> some View {
        let agents = usage.rankedAgents
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
                if wide {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        usageTotal(usage.total)
                        tokenUnit
                    }
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        usageTotal(usage.total)
                        tokenUnit
                    }
                }
                Spacer(minLength: 2)
                if let rate = usage.cacheRate {
                    VStack(alignment: .trailing, spacing: 0) {
                        Text(percent(rate))
                            .font(.system(size: wide ? 16 : 14, weight: .semibold))
                            .monospacedDigit().lineLimit(1)
                            .contentTransition(reduceMotion ? .identity : .numericText(value: rate * 100))
                            .animation(updateAnimation, value: rate)
                        Text(copy("缓存命中", "Cache hit"))
                            .font(.system(size: 9, weight: .medium))
                            .foregroundStyle(secondaryColor)
                            .lineLimit(1)
                    }
                    .fixedSize(horizontal: true, vertical: false)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(copy("缓存命中率", "Cache hit rate") + " " + percent(rate))
                }
            }
            if !agents.isEmpty {
                Spacer(minLength: 3)
                ForEach(agents, id: \.id) { row in
                    HStack(spacing: 4) {
                        quotaLogo("provider-" + row.id.rawValue, fallback: "terminal", size: wide ? 10 : 9)
                            .accessibilityHidden(true)
                        Text(row.id.name).lineLimit(1).minimumScaleFactor(0.78)
                        Spacer(minLength: 2)
                        Text(compact(row.tokens)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.78)
                            .layoutPriority(1)
                        if wide {
                            Group {
                                if let input = row.input, input > 0, let cached = row.cached {
                                    let hit = percent(Double(cached) / Double(input))
                                    Text(hit).accessibilityLabel(copy("缓存命中", "Cache hit") + " " + hit)
                                } else {
                                    Color.clear.accessibilityHidden(true)
                                }
                            }
                            .foregroundStyle(secondaryColor)
                            .frame(width: 37, height: 12, alignment: .trailing)
                        }
                    }
                    .font(.system(size: wide ? 11 : 10, weight: .medium))
                    if row.id != agents.last?.id { Spacer(minLength: 2) }
                }
            } else {
                Spacer(minLength: 0)
            }
        }
    }

    private func usageTotal(_ total: Int?) -> some View {
        Text(compact(total))
            .font(.system(size: wide ? 27 : 23, weight: .semibold, design: .rounded))
            .monospacedDigit().lineLimit(1).minimumScaleFactor(0.62)
            .contentTransition(reduceMotion ? .identity : .numericText())
            .animation(updateAnimation, value: total)
    }

    private var tokenUnit: some View {
        Text("Token")
            .font(.system(size: 9, weight: .medium))
            .foregroundStyle(secondaryColor)
    }

    private func trend(_ usage: UsageSnapshot) -> some View {
        let maximum = max(1, usage.days.compactMap(\.tokens).max() ?? 0)
        return VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                usageTotal(sum(usage.days.map(\.tokens)))
                tokenUnit
            }
            GeometryReader { geometry in
                let chartHeight = max(0, geometry.size.height - 14)
                HStack(alignment: .bottom, spacing: wide ? 8 : 4) {
                    ForEach(usage.days) { row in
                        let isToday = row.day == usage.day
                        let ratio = CGFloat(row.tokens ?? 0) / CGFloat(maximum)
                        VStack(spacing: 3) {
                            Spacer(minLength: 0)
                            UnevenRoundedRectangle(topLeadingRadius: 3, topTrailingRadius: 3)
                                .fill(iconColor.opacity(isToday ? 0.9 : 0.33))
                                .frame(height: row.tokens == nil ? 0 : max(2, chartHeight * ratio))
                                .animation(updateAnimation, value: ratio)
                            Text(parseDay(row.day)?.formatted(.dateTime.weekday(.narrow)) ?? "—")
                                .font(.system(size: 9, weight: isToday ? .semibold : .regular))
                                .foregroundStyle(isToday ? iconColor : secondaryColor)
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(row.day + ", " + compact(row.tokens) + " Token")
                    }
                }
                .frame(maxHeight: .infinity, alignment: .bottom)
            }
        }
    }

    @ViewBuilder
    private func quotas(_ quota: QuotaSnapshot) -> some View {
        if wide {
            quotaTable(quota)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(quota.agents, id: \.id) { row in
                    if row.id != quota.agents.first?.id { Spacer(minLength: 2) }
                    let windows = row.windows.filter { $0.isActive(at: entry.date) }
                    let preferred = row.id == .antigravity ? windows.min { $0.remaining < $1.remaining } : windows.first
                    if let window = preferred ?? row.windows.first {
                        let active = window.isActive(at: entry.date)
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 4) {
                                quotaSourceIcon(row)
                                if row.id == .antigravity {
                                    Rectangle().fill(Color.secondary.opacity(0.26)).frame(width: 1, height: 10)
                                        .accessibilityHidden(true)
                                    modelIcon(window.modelGroup, size: quotaIconSize)
                                }
                                Spacer(minLength: 0)
                                if row.id == .antigravity {
                                    if let period = window.modelPeriod { periodLabel(period) }
                                } else if let period = window.accountPeriod {
                                    periodLabel(period)
                                } else {
                                    Text(window.name).font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(1)
                                }
                                if active {
                                    remainingValue(window)
                                } else {
                                    pendingQuotaValue(window.name)
                                }
                            }
                            .font(.system(size: 11.5, weight: .medium))
                            if active { quotaBar(window) }
                        }
                        .accessibilityElement(children: .combine)
                    } else {
                        HStack {
                            quotaSourceIcon(row)
                            Spacer(minLength: 0)
                            unavailableQuotaValue
                        }
                    }
                }
            }
        }
    }

    private func quotaTable(_ quota: QuotaSnapshot) -> some View {
        let accounts = quota.agents.filter { $0.id != .antigravity }
        let antigravity = quota.agents.first { $0.id == .antigravity }
        let models = modelQuotaRows(antigravity?.windows ?? [])
        let accountRowCount = accounts.reduce(0) { count, agent in
            let other = agent.windows.count { $0.accountPeriod == nil }
            return count + max(1, other + (other < agent.windows.count ? 1 : 0))
        }
        return GeometryReader { geometry in
            let metrics = QuotaGridMetrics(height: geometry.size.height, large: large, accountRows: accountRowCount,
                                           modelRows: models.count, hasAntigravity: antigravity != nil)
            let gap: CGFloat = large ? 10 : 7
            let column = max(0, (geometry.size.width - quotaIdentityWidth - 2 * gap) / 2)
            Grid(alignment: .leading, horizontalSpacing: gap, verticalSpacing: metrics.spacing) {
                GridRow {
                    Color.clear.frame(width: quotaIdentityWidth, height: 1).accessibilityHidden(true)
                    periodLabel(.fiveHours).frame(width: column, alignment: .trailing)
                    periodLabel(.weekly).frame(width: column, alignment: .trailing)
                }
                .frame(height: metrics.headingHeight)
                ForEach(accounts, id: \.id) { account in
                    accountQuotaRows(account, metrics: metrics, column: column, gap: gap)
                }
                if let antigravity, models.isEmpty {
                    unavailableQuotaRow(antigravity, metrics: metrics)
                } else if let antigravity {
                    GridRow {
                        quotaIconCell(quotaSourceIcon(antigravity), height: metrics.rowHeight)
                        HStack(spacing: 6) {
                            Rectangle().fill(ruleColor).frame(height: 1).accessibilityHidden(true)
                            if models.count > metrics.modelLimit {
                                let extra = models.count - metrics.modelLimit
                                Text("+\(extra)").font(.system(size: 9)).foregroundStyle(secondaryColor)
                                    .accessibilityLabel(copy("另有 \(extra) 条额度", "\(extra) more quota rows"))
                            }
                        }
                        .frame(width: column * 2 + gap)
                        .gridCellColumns(2)
                    }
                    ForEach(models.prefix(metrics.modelLimit)) { model in
                        GridRow {
                            modelQuotaIconCell(model.group, height: metrics.rowHeight)
                            if let standalone = model.standalone {
                                quotaCell(standalone, metrics: metrics)
                                    .frame(width: column * 2 + gap).gridCellColumns(2)
                            } else {
                                quotaCell(model.fiveHours, metrics: metrics, period: .fiveHours).frame(width: column)
                                quotaCell(model.weekly, metrics: metrics, period: .weekly).frame(width: column)
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private func accountQuotaRows(_ account: QuotaAgent, metrics: QuotaGridMetrics, column: CGFloat, gap: CGFloat) -> some View {
        let windows = account.windows
        let fiveHours = windows.first { $0.accountPeriod == .fiveHours }
        let weekly = windows.first { $0.accountPeriod == .weekly }
        if windows.isEmpty { unavailableQuotaRow(account, metrics: metrics) }
        if fiveHours != nil || weekly != nil {
            GridRow {
                quotaIconCell(quotaSourceIcon(account), height: metrics.rowHeight)
                quotaCell(fiveHours, metrics: metrics, period: .fiveHours).frame(width: column)
                quotaCell(weekly, metrics: metrics, period: .weekly).frame(width: column)
            }
        }
        ForEach(windows.filter { $0.accountPeriod == nil }, id: \.label) { window in
            GridRow {
                quotaIconCell(quotaSourceIcon(account), height: metrics.rowHeight)
                HStack(spacing: 5) {
                    Text(window.name).font(.system(size: 9)).foregroundStyle(secondaryColor).lineLimit(1)
                    quotaCell(window, metrics: metrics)
                }
                .frame(width: column * 2 + gap)
                .gridCellColumns(2)
            }
        }
    }

    private func quotaIconCell<Icon: View>(_ icon: Icon, height: CGFloat) -> some View {
        icon.frame(width: quotaIdentityWidth, height: height, alignment: .leading)
    }

    private var unavailableQuotaValue: some View {
        Text(copy("额度暂不可用", "Quota unavailable"))
            .font(.system(size: large ? 12 : 10, weight: .medium))
            .foregroundStyle(secondaryColor)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
    }

    private func unavailableQuotaRow(_ agent: QuotaAgent, metrics: QuotaGridMetrics) -> some View {
        GridRow {
            quotaIconCell(quotaSourceIcon(agent), height: metrics.rowHeight)
            unavailableQuotaValue
                .frame(maxWidth: .infinity, alignment: .trailing)
                .gridCellColumns(2)
        }
    }

    private func quotaSourceIcon(_ agent: QuotaAgent) -> some View {
        HStack(spacing: 4) {
            harnessIcon(agent.id)
            if agent.stale == true {
                let title = copy("显示上次取得的额度", "Showing last known quota")
                Image(systemName: "clock.arrow.circlepath")
                    .font(.system(size: large ? 10 : 8))
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(title)
                    .help(title)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func modelQuotaIconCell(_ group: String, height: CGFloat) -> some View {
        quotaIconCell(modelIcon(group, size: quotaIconSize - 3).padding(.leading, large ? 9 : 7), height: height)
    }

    private func periodLabel(_ period: QuotaPeriod) -> some View {
        Text(period.title)
            .font(.system(size: large ? 11 : 9, weight: .medium)).foregroundStyle(secondaryColor)
            .lineLimit(1)
    }

    private func harnessIcon(_ agent: Agent) -> some View {
        quotaLogo("provider-" + agent.rawValue, fallback: "terminal", size: quotaIconSize)
            .accessibilityLabel(agent.name)
            .help(agent.name)
    }

    private func modelIcon(_ group: String, size: CGFloat) -> some View {
        let name = group.lowercased()
        let claude = name.contains("claude")
        let gpt = name.contains("gpt")
        let gemini = name.contains("gemini")
        return HStack(spacing: quotaIconGap) {
            Group {
                if claude {
                    quotaLogo("provider-claude", fallback: "sun.max", size: size)
                } else if gpt {
                    quotaLogo("provider-codex", fallback: "circle.hexagongrid", size: size)
                } else if gemini {
                    quotaLogo("provider-gemini", fallback: "sparkle", size: size)
                } else {
                    Image(systemName: "cpu").font(.system(size: size))
                }
            }
            .frame(width: size, height: size)
            Group {
                if claude && gpt {
                    quotaLogo("provider-codex", fallback: "circle.hexagongrid", size: size)
                } else if gemini && name.contains("argon") {
                    Text("Ar")
                        .font(.system(size: min(8, size * 0.7), weight: .semibold, design: .monospaced))
                        .fixedSize()
                        .padding(.horizontal, large ? 2 : 1).padding(.vertical, 1)
                        .background(Color.secondary.opacity(0.2), in: RoundedRectangle(cornerRadius: 3))
                } else {
                    Color.clear
                }
            }
            .frame(width: size, height: size)
        }
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(group)
        .help(group)
    }

    @ViewBuilder
    private func quotaLogo(_ name: String, fallback: String, size: CGFloat) -> some View {
        if let url = Bundle.main.url(forResource: name, withExtension: "svg"),
           let image = NSImage(contentsOf: url) {
            Image(nsImage: image).renderingMode(.template).resizable().scaledToFit()
                .frame(width: size, height: size)
                .scaleEffect(name == "provider-zcode" ? 1.3 : 1)
                .foregroundStyle(.primary)
        } else {
            Image(systemName: fallback).font(.system(size: size))
                .frame(width: size, height: size)
        }
    }

    private func remainingValue(_ window: QuotaWindow) -> some View {
        let rate = percent(window.remaining)
        return Text(rate)
            .monospacedDigit().lineLimit(1).fixedSize()
            .contentTransition(reduceMotion ? .identity : .numericText(value: window.remaining * 100))
            .animation(updateAnimation, value: window.remaining)
            .accessibilityLabel(copy("剩余", "Remaining") + " " + rate)
    }

    private func pendingQuotaValue(_ label: String) -> some View {
        Text(copy("待更新", "Pending"))
            .font(.system(size: large ? 12 : 10, weight: .medium))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .accessibilityLabel(label + " " + copy("已到重置时间，等待额度更新", "reset reached; waiting for updated quota"))
    }

    @ViewBuilder
    private func quotaCell(_ window: QuotaWindow?, metrics: QuotaGridMetrics, period: QuotaPeriod? = nil) -> some View {
        if let window, window.isActive(at: entry.date) {
            HStack(spacing: large ? 7 : 4) {
                quotaBar(window, height: metrics.barHeight)
                remainingValue(window).frame(width: metrics.valueWidth, alignment: .trailing)
            }
            .font(.system(size: metrics.valueSize, weight: .semibold))
            .frame(height: metrics.rowHeight)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel((period?.title ?? window.name) + " " + copy("剩余", "Remaining") + " " + percent(window.remaining))
        } else if let window {
            pendingQuotaValue(period?.title ?? window.name)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .frame(height: metrics.rowHeight)
        } else {
            Color.clear.frame(height: metrics.rowHeight)
                .gridCellUnsizedAxes(.horizontal)
                .accessibilityHidden(true)
        }
    }

    private func quotaBar(_ window: QuotaWindow, height: CGFloat = 4) -> some View {
        GeometryReader { geometry in
            ZStack(alignment: .trailing) {
                Capsule().fill(usedColor)
                Rectangle().fill(remainingColor)
                    .frame(width: geometry.size.width * window.remaining)
                    .animation(updateAnimation, value: window.remaining)
            }
            .clipShape(Capsule())
        }
        .frame(height: height)
        .accessibilityHidden(true)
    }

}


private extension Color {
    init(rgb: UInt32) {
        self.init(red: Double((rgb >> 16) & 0xff) / 255,
                  green: Double((rgb >> 8) & 0xff) / 255,
                  blue: Double(rgb & 0xff) / 255)
    }
}

@MainActor
private func configuration(for card: Card) -> some WidgetConfiguration {
    StaticConfiguration(kind: "codeburn." + card.rawValue, provider: SnapshotProvider()) { entry in
        WidgetCard(card: card, entry: entry)
    }
    .configurationDisplayName(card.title)
    .description(card.description)
    .supportedFamilies(card == .quota ? [.systemSmall, .systemMedium, .systemLarge] : [.systemSmall, .systemMedium])
}

private struct TodayWidget: Widget {
    var body: some WidgetConfiguration { configuration(for: .today) }
}

private struct TrendWidget: Widget {
    var body: some WidgetConfiguration { configuration(for: .trend) }
}

private struct QuotaWidget: Widget {
    var body: some WidgetConfiguration { configuration(for: .quota) }
}

@main
struct CodeBurnWidgets: WidgetBundle {
    var body: some Widget {
        TodayWidget()
        TrendWidget()
        QuotaWidget()
    }
}

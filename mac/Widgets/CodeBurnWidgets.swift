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

private struct WidgetCard: View {
    @Environment(\.widgetFamily) private var family
    let card: Card
    let entry: Entry
    private var wide: Bool { family != .systemSmall }
    private var large: Bool { family == .systemLarge }
    private let accent = Color(red: 0.98, green: 0.39, blue: 0.15)
    private let remainingColor = Color(red: 0.31, green: 0.75, blue: 0.49)
    private let usedColor = Color.gray.opacity(0.66)
    private var quotaIconSize: CGFloat { large ? 18 : (wide ? 13 : 15) }
    private let quotaIconGap: CGFloat = 4
    private var quotaIdentityWidth: CGFloat { quotaIconSize * 2 + quotaIconGap + 8 }
    private var quotaRowHeight: CGFloat { large ? 26 : 13 }


    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Label(card.title, systemImage: card.symbol)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(card == .quota ? Color.primary : accent)
                    .widgetAccentable(card != .quota)
                if card == .quota {
                    Spacer()
                    HStack(spacing: 4) {
                        Circle().fill(remainingColor).frame(width: 5, height: 5).accessibilityHidden(true)
                        Text(copy("剩余", "Remaining"))
                    }
                    .font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
                }
            }
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
            Spacer(minLength: 0)
            refreshTime
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .containerBackground(for: .widget) { Color(nsColor: .windowBackgroundColor) }
    }

    private func empty(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
            .frame(maxHeight: .infinity, alignment: .center)
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
        .font(.system(size: 10, weight: .medium))
        .monospacedDigit().foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.8)
        .accessibilityElement(children: .combine)
    }

    private func today(_ usage: UsageSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
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
                if let rate = usage.cacheRate {
                    Spacer(minLength: 0)
                    VStack(alignment: .trailing, spacing: 0) {
                        Text(percent(rate))
                            .font(.system(size: 15, weight: .semibold, design: .rounded))
                            .monospacedDigit().lineLimit(1)
                        Text(copy("缓存命中", "Cache hit"))
                            .font(.system(size: 9, weight: .medium)).foregroundStyle(.secondary)
                    }
                    .fixedSize(horizontal: true, vertical: false)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(copy("缓存命中率", "Cache hit rate") + " " + percent(rate))
                }
            }
            ForEach(usage.rankedAgents, id: \.id) { row in
                HStack(spacing: 5) {
                    agentName(row.id)
                    Spacer(minLength: 2)
                    Text(compact(row.tokens)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.8)
                    if wide, let input = row.input, input > 0, let cached = row.cached {
                        let hit = percent(Double(cached) / Double(input))
                        Text(hit)
                            .foregroundStyle(.secondary)
                            .frame(width: 43, alignment: .trailing)
                            .accessibilityLabel(copy("缓存命中", "Cache hit") + " " + hit)
                    }
                }
                .font(.system(size: 11.5, weight: .medium))
            }
        }
    }

    private func usageTotal(_ total: Int?) -> some View {
        Text(compact(total))
            .font(.system(size: 31, weight: .semibold, design: .rounded))
            .monospacedDigit().lineLimit(1).minimumScaleFactor(0.62)
    }

    private var tokenUnit: some View {
        Text("Token").font(.system(size: 9, weight: .medium)).foregroundStyle(.secondary)
    }

    private func agentName(_ agent: Agent) -> some View {
        HStack(spacing: 5) {
            Circle().fill(agent.color).frame(width: 5, height: 5).accessibilityHidden(true)
            Text(agent.name).lineLimit(1)
        }
        .layoutPriority(1)
    }

    private func trend(_ usage: UsageSnapshot) -> some View {
        let maximum = max(1, usage.days.compactMap(\.tokens).max() ?? 0)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(compact(sum(usage.days.map(\.tokens))))
                    .font(.system(size: 29, weight: .semibold, design: .rounded))
                    .monospacedDigit().lineLimit(1).minimumScaleFactor(0.65)
                Text("Token").font(.caption2).foregroundStyle(.secondary)
            }
            HStack(alignment: .bottom, spacing: wide ? 7 : 4) {
                ForEach(usage.days) { row in
                    VStack(spacing: 3) {
                        Spacer(minLength: 0)
                        let height = CGFloat(row.tokens ?? 0) / CGFloat(maximum) * 35
                        RoundedRectangle(cornerRadius: 3)
                            .fill(row.day == usage.day ? accent : accent.opacity(0.4))
                            .opacity(row.tokens == nil ? 0 : 1)
                            .frame(height: max(2, height))
                        Text(parseDay(row.day)?.formatted(.dateTime.weekday(.narrow)) ?? "—")
                            .font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(row.day + ", " + compact(row.tokens) + " Token")
                }
            }
            .frame(height: 49)
        }
    }

    @ViewBuilder
    private func quotas(_ quota: QuotaSnapshot) -> some View {
        if wide {
            quotaTable(quota)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(quota.agents, id: \.id) { row in
                    let windows = row.windows.filter { $0.isActive(at: entry.date) }
                    let preferred = row.id == .antigravity ? windows.min { $0.remaining < $1.remaining } : windows.first
                    if let window = preferred ?? row.windows.first {
                        let active = window.isActive(at: entry.date)
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 4) {
                                harnessIcon(row.id)
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
                    }
                }
            }
        }
    }

    private func quotaTable(_ quota: QuotaSnapshot) -> some View {
        let accounts = quota.agents.filter { $0.id != .antigravity }
        let antigravity = quota.agents.first { $0.id == .antigravity }
        let models = modelQuotaRows(antigravity?.windows ?? [])
        let limit = large ? 8 : 3
        return Grid(alignment: .leading, horizontalSpacing: large ? 14 : 8, verticalSpacing: large ? 10 : 2) {
            GridRow {
                Color.clear.frame(width: quotaIdentityWidth, height: 1).accessibilityHidden(true)
                periodLabel(.fiveHours).frame(maxWidth: .infinity, alignment: .trailing)
                periodLabel(.weekly).frame(maxWidth: .infinity, alignment: .trailing)
            }
            ForEach(accounts, id: \.id, content: accountQuotaRows)
            if !models.isEmpty {
                GridRow(alignment: .center) {
                    quotaIconCell(harnessIcon(.antigravity))
                    HStack(spacing: 8) {
                        Rectangle().fill(Color.secondary.opacity(0.25)).frame(height: 1)
                            .accessibilityHidden(true)
                        if models.count > limit {
                            let extra = models.count - limit
                            Text("+\(extra)").font(.system(size: 9)).foregroundStyle(.secondary)
                                .accessibilityLabel(copy("另有 \(extra) 条额度", "\(extra) more quota rows"))
                        }
                    }
                    .gridCellColumns(2)
                }
                ForEach(models.prefix(limit)) { model in
                    if let standalone = model.standalone {
                        GridRow {
                            modelQuotaIconCell(model.group)
                            quotaCell(standalone).gridCellColumns(2)
                        }
                    } else {
                        GridRow {
                            modelQuotaIconCell(model.group)
                            quotaCell(model.fiveHours, period: .fiveHours)
                            quotaCell(model.weekly, period: .weekly)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func accountQuotaRows(_ account: QuotaAgent) -> some View {
        let windows = account.windows
        let fiveHours = windows.first { $0.accountPeriod == .fiveHours }
        let weekly = windows.first { $0.accountPeriod == .weekly }
        if fiveHours != nil || weekly != nil {
            GridRow {
                quotaIconCell(harnessIcon(account.id))
                quotaCell(fiveHours, period: .fiveHours)
                quotaCell(weekly, period: .weekly)
            }
        }
        ForEach(windows.filter { $0.accountPeriod == nil }, id: \.label) { window in
            GridRow {
                quotaIconCell(harnessIcon(account.id))
                HStack(spacing: 5) {
                    Text(window.name).font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(1)
                    quotaCell(window)
                }
                .gridCellColumns(2)
            }
        }
    }

    private func quotaIconCell<Icon: View>(_ icon: Icon) -> some View {
        icon.frame(width: quotaIdentityWidth, height: quotaRowHeight, alignment: .leading)
    }

    private func modelQuotaIconCell(_ group: String) -> some View {
        quotaIconCell(modelIcon(group, size: quotaIconSize - 3).padding(.leading, large ? 9 : 7))
    }

    private func periodLabel(_ period: QuotaPeriod) -> some View {
        Text(period.title)
            .font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
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
    private func quotaCell(_ window: QuotaWindow?, period: QuotaPeriod? = nil) -> some View {
        if let window, window.isActive(at: entry.date) {
            HStack(spacing: 5) {
                quotaBar(window, height: large ? 6 : 4)
                remainingValue(window).frame(width: large ? 39 : 29, alignment: .trailing)
            }
            .font(.system(size: large ? 13 : 10.5, weight: .medium))
            .frame(height: quotaRowHeight)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel((period?.title ?? window.name) + " " + copy("剩余", "Remaining") + " " + percent(window.remaining))
        } else if let window {
            pendingQuotaValue(period?.title ?? window.name)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .frame(height: quotaRowHeight)
        } else {
            Color.clear.frame(height: quotaRowHeight)
                .gridCellUnsizedAxes(.horizontal)
                .accessibilityHidden(true)
        }
    }

    private func quotaBar(_ window: QuotaWindow, height: CGFloat = 4) -> some View {
        GeometryReader { geometry in
            ZStack(alignment: .trailing) {
                Capsule().fill(usedColor)
                if window.remaining > 0 {
                    Rectangle().fill(remainingColor)
                        .frame(width: geometry.size.width * window.remaining)
                }
            }
            .clipShape(Capsule())
        }
        .frame(height: height)
        .accessibilityHidden(true)
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

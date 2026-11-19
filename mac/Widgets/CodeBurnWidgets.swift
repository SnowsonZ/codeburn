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

    var cacheRate: Double? {
        guard let input = sum(agents.map(\.input)), input > 0,
              let cached = sum(agents.map(\.cached)), cached <= input else { return nil }
        return Double(cached) / Double(input)
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

    func isActive(at date: Date) -> Bool {
        guard let reset = parseDate(resetsAt) else { return true }
        return reset > date
    }
}

private struct QuotaAgent: Decodable {
    let id: Agent
    let windows: [QuotaWindow]
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
        let quotas = zip(Agent.allCases, [0.28, 0.61, 0.42]).map { id, percent in
            QuotaAgent(id: id, windows: [
                QuotaWindow(label: "5-hour", percent: percent, resetsAt: nil),
                QuotaWindow(label: "Weekly", percent: percent / 2, resetsAt: nil)
            ])
        }
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
        case .quota: copy("各 Agent 的套餐窗口及已用比例。", "Used percentage for each agent’s plan windows.")
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
        let interval: TimeInterval = snapshot == nil ? 5 * 60 : 15 * 60
        let midnight = civilCalendar.nextDate(after: now, matching: .init(hour: 0, minute: 0), matchingPolicy: .nextTime)
        let reset = snapshot?.quota?.agents.flatMap(\.windows)
            .compactMap { parseDate($0.resetsAt) }.filter { $0 > now }.min()
        let next = min(now.addingTimeInterval(interval), midnight ?? .distantFuture, reset ?? .distantFuture)
        completion(Timeline(entries: [.init(date: now, snapshot: snapshot)], policy: .after(next)))
    }
}

private struct WidgetCard: View {
    @Environment(\.widgetFamily) private var family
    let card: Card
    let entry: Entry
    private var wide: Bool { family == .systemMedium }
    private let accent = Color(red: 0.98, green: 0.39, blue: 0.15)

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Label(card.title, systemImage: card.symbol)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(accent)
                    .widgetAccentable()
                if card == .quota {
                    Spacer()
                    Text(copy("已用", "Used"))
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
            ForEach(usage.agents, id: \.id) { row in
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

    private func quotas(_ quota: QuotaSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(quota.agents, id: \.id) { row in
                let current = row.windows.filter { $0.isActive(at: entry.date) }
                if wide {
                    HStack(alignment: .center, spacing: 10) {
                        agentName(row.id).frame(width: 78, alignment: .leading)
                        quotaColumn(current.first, agent: row.id)
                        quotaColumn(current.dropFirst().first, agent: row.id)
                    }
                } else {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 4) {
                            agentName(row.id)
                            Spacer(minLength: 0)
                            quotaPercentage(current.first, agent: row.id, showName: true)
                        }
                        quotaBar(current.first, agent: row.id)
                    }
                }
            }
            .font(.system(size: 11.5, weight: .medium))
        }
    }

    private func quotaColumn(_ window: QuotaWindow?, agent: Agent) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                if let window {
                    Text(window.name).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.8)
                        .accessibilityHidden(true)
                }
                Spacer(minLength: 0)
                quotaPercentage(window, agent: agent, showName: false)
            }
            quotaBar(window, agent: agent)
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private func quotaPercentage(_ window: QuotaWindow?, agent: Agent, showName: Bool) -> some View {
        if let window {
            let rate = percent(window.percent)
            let value = Text(rate)
                .monospacedDigit()
                .foregroundStyle(window.percent >= 0.9 ? Color.red : Color.primary)
                .fixedSize()
            ViewThatFits(in: .horizontal) {
                if showName && window.name.count <= 8 {
                    HStack(spacing: 3) {
                        Text(window.name).font(.system(size: 10)).foregroundStyle(.secondary)
                        value
                    }
                    .fixedSize()
                }
                value
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(agent.name + " " + window.name + " " + copy("已用", "used") + " " + rate)
        } else {
            Text("—").foregroundStyle(.secondary)
                .accessibilityLabel(copy("暂无额度", "Quota unavailable"))
        }
    }

    private func quotaBar(_ window: QuotaWindow?, agent: Agent) -> some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.20))
                if let window, window.percent > 0 {
                    Capsule().fill(window.percent >= 0.9 ? Color.red : agent.color)
                        .frame(width: geometry.size.width * min(1, window.percent))
                }
            }
        }
        .frame(height: 4)
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
    .supportedFamilies([.systemSmall, .systemMedium])
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

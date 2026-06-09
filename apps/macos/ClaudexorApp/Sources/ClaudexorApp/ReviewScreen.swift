import SwiftUI

struct ReviewScreen: View {
    @Environment(AppModel.self) private var model
    @State private var severityFilter: Severity?

    var body: some View {
        ListScreen(title: "Review Queue") {
            bar
        } content: {
            if findings.isEmpty {
                EmptyStateView(title: "Inbox zero", message: "No open findings across your projects. Cross-family reviewers post blockers and suggestions here.", systemImage: "checkmark.seal")
            } else {
                Panel(padding: 0) {
                    ReviewFindingsGrid(findings: findings)
                        .frame(minHeight: 420)
                }
                .padding(Theme.Spacing.xxl)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
    }

    private var bar: some View {
        FilterBar {
            FilterChip(label: "All", count: model.allFindings.count, isActive: severityFilter == nil) {
                withAnimation(.snappy) { severityFilter = nil }
            }
            ForEach(Severity.allCases, id: \.self) { sev in
                FilterChip(label: sev.label,
                           count: model.allFindings.filter { $0.severity == sev }.count,
                           isActive: severityFilter == sev,
                           tint: sev.color) {
                    withAnimation(.snappy) { severityFilter = sev }
                }
            }
        }
    }

    private var findings: [Finding] {
        var all = model.allFindings
        if let sev = severityFilter { all = all.filter { $0.severity == sev } }
        let q = model.searchQuery
        guard !q.isEmpty else { return all }
        return all.filter {
            $0.title.localizedCaseInsensitiveContains(q)
                || $0.detail.localizedCaseInsensitiveContains(q)
                || $0.taskTitle.localizedCaseInsensitiveContains(q)
        }
    }
}

private enum ReviewGridMetrics {
    static let severity: CGFloat = 150
    static let finding: CGFloat = 270
    static let task: CGFloat = 220
    static let reviewer: CGFloat = 150
    static let evidence: CGFloat = 230
    static let state: CGFloat = 120
    static let rowHeight: CGFloat = 78
}

private struct ReviewGridColumns {
    let severity: CGFloat
    let finding: CGFloat
    let task: CGFloat
    let reviewer: CGFloat
    let evidence: CGFloat
    let state: CGFloat
}

private struct ReviewFindingsGrid: View {
    let findings: [Finding]

    var body: some View {
        GeometryReader { proxy in
            let contentWidth = max(proxy.size.width, 620)
            let columns = columns(for: contentWidth)
            ScrollView([.horizontal, .vertical]) {
                VStack(spacing: 0) {
                    header(columns)
                    ForEach(Array(findings.enumerated()), id: \.element.id) { idx, finding in
                        ReviewFindingRow(finding: finding, shaded: idx.isMultiple(of: 2), columns: columns)
                        if idx < findings.count - 1 { Divider().overlay(Theme.hairline) }
                    }
                }
                .frame(width: contentWidth, alignment: .topLeading)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.surfaceRaised)
    }

    private func columns(for width: CGFloat) -> ReviewGridColumns {
        let available = max(width, 620)
        let fixed = ReviewGridMetrics.severity + ReviewGridMetrics.reviewer + ReviewGridMetrics.state
        let flexible = max(available - fixed, 300)
        return ReviewGridColumns(
            severity: ReviewGridMetrics.severity,
            finding: flexible * 0.38,
            task: flexible * 0.30,
            reviewer: ReviewGridMetrics.reviewer,
            evidence: flexible * 0.32,
            state: ReviewGridMetrics.state
        )
    }

    private func header(_ columns: ReviewGridColumns) -> some View {
        HStack(spacing: 0) {
            ReviewHeaderCell("Severity", width: columns.severity)
            ReviewHeaderCell("Finding", width: columns.finding)
            ReviewHeaderCell("Task", width: columns.task)
            ReviewHeaderCell("Reviewer", width: columns.reviewer)
            ReviewHeaderCell("Evidence", width: columns.evidence)
            ReviewHeaderCell("State", width: columns.state)
        }
        .frame(height: 44)
        .background(Theme.surfaceRaisedHi)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.separator).frame(height: 1) }
    }
}

private struct ReviewHeaderCell: View {
    let title: String
    let width: CGFloat

    init(_ title: String, width: CGFloat) {
        self.title = title
        self.width = width
    }

    var body: some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, Theme.Spacing.md)
            .frame(width: width, alignment: .leading)
    }
}

private struct ReviewFindingRow: View {
    let finding: Finding
    let shaded: Bool
    let columns: ReviewGridColumns

    var body: some View {
        HStack(spacing: 0) {
            severity
                .frame(width: columns.severity, alignment: .leading)
            findingCell
                .frame(width: columns.finding, alignment: .leading)
            Text(finding.taskTitle.isEmpty ? "No task" : finding.taskTitle)
                .font(.callout)
                .foregroundStyle(finding.taskTitle.isEmpty ? .secondary : .primary)
                .lineLimit(1)
                .padding(.horizontal, Theme.Spacing.md)
                .frame(width: columns.task, alignment: .leading)
            reviewer
                .padding(.horizontal, Theme.Spacing.md)
                .frame(width: columns.reviewer, alignment: .leading)
            ReviewEvidenceCell(finding: finding)
                .padding(.horizontal, Theme.Spacing.md)
                .frame(width: columns.evidence, alignment: .leading)
            ReviewStateBadge(finding: finding)
                .padding(.horizontal, Theme.Spacing.md)
                .frame(width: columns.state, alignment: .leading)
        }
        .frame(height: ReviewGridMetrics.rowHeight)
        .background(shaded ? Theme.surfaceRaised.opacity(0.58) : Theme.surfaceBase)
    }

    private var severity: some View {
        Label(finding.severity.label, systemImage: finding.severity.glyph)
            .font(.callout.weight(.semibold))
            .foregroundStyle(finding.severity.color)
            .lineLimit(1)
            .padding(.horizontal, Theme.Spacing.md)
    }

    private var findingCell: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(finding.title)
                .font(.callout.weight(.semibold))
                .lineLimit(1)
            Text(finding.detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(.horizontal, Theme.Spacing.md)
    }

    private var reviewer: some View {
        HStack(spacing: Theme.Spacing.xs) {
            HarnessDot(family: finding.reviewer, size: 7)
            Text(finding.reviewer.label).lineLimit(1)
        }
        .font(.callout)
    }
}

private struct ReviewEvidenceCell: View {
    let finding: Finding

    @ViewBuilder
    var body: some View {
        if let file = finding.evidenceFile {
            Label("\(file)\(finding.evidenceLine.map { ":\($0)" } ?? "")", systemImage: "doc.text.magnifyingglass")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(Theme.link)
                .lineLimit(1)
        } else {
            Label("No evidence", systemImage: "exclamationmark.shield")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }
}

private struct ReviewStateBadge: View {
    let finding: Finding

    var body: some View {
        let tint = finding.status.color
        Text(finding.status.label)
            .font(.caption.weight(.medium))
            .foregroundStyle(tint)
            .padding(.horizontal, Theme.Spacing.sm)
            .padding(.vertical, Theme.Spacing.xxs)
            .background(tint.opacity(0.13), in: Capsule())
            .lineLimit(1)
    }
}

// MARK: - Finding card (solid; shared by task detail + review queue)

struct FindingCard: View {
    let finding: Finding
    var showTask = false

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            Rectangle().fill(finding.severity.color).frame(width: 4)
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                HStack(spacing: Theme.Spacing.sm) {
                    Label(finding.severity.label, systemImage: finding.severity.glyph)
                        .font(.caption.weight(.semibold)).foregroundStyle(finding.severity.color)
                    Text(finding.category).font(.caption2).foregroundStyle(.secondary)
                        .padding(.horizontal, Theme.Spacing.sm).padding(.vertical, 2)
                        .background(Theme.surfaceRaisedHi, in: Capsule())
                    Spacer()
                    HStack(spacing: Theme.Spacing.xs) {
                        HarnessDot(family: finding.reviewer, size: 7)
                        Text(finding.reviewer.label).font(.caption2).foregroundStyle(.secondary)
                    }
                    RouteProofBadge(proof: finding.routeProof)
                }
                Text(finding.title).font(.callout.weight(.semibold))
                if showTask, !finding.taskTitle.isEmpty {
                    Text(finding.taskTitle).font(.caption2).foregroundStyle(Theme.accent)
                }
                Text(finding.detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: Theme.Spacing.md) {
                    if let file = finding.evidenceFile {
                        Label("\(file)\(finding.evidenceLine.map { ":\($0)" } ?? "")", systemImage: "doc.text.magnifyingglass")
                            .font(.system(.caption2, design: .monospaced)).foregroundStyle(Theme.link)
                    } else {
                        Label("No evidence — cannot block", systemImage: "exclamationmark.shield")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(finding.status.label)
                        .font(.caption2.weight(.medium)).foregroundStyle(finding.status.color)
                }
            }
            .padding(Theme.Spacing.md)
        }
        .cardSurface(clip: true)   // clip rounds the leading severity bar
    }
}

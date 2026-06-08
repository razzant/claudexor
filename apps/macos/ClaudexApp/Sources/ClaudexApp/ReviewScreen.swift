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
                    ReviewFindingsTable(findings: findings)
                        .frame(minWidth: ReviewTableMetrics.minWidth, minHeight: 420)
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

private enum ReviewTableMetrics {
    static let minWidth: CGFloat = 980
}

private struct ReviewFindingsTable: View {
    let findings: [Finding]

    var body: some View {
        Table(findings) {
            TableColumn("Severity") { finding in
                Label(finding.severity.label, systemImage: finding.severity.glyph)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(finding.severity.color)
            }
            TableColumn("Finding") { finding in
                VStack(alignment: .leading, spacing: 2) {
                    Text(finding.title)
                        .font(.callout.weight(.semibold))
                        .lineLimit(1)
                    Text(finding.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            TableColumn("Task") { finding in
                Text(finding.taskTitle.isEmpty ? "No task" : finding.taskTitle)
                    .font(.callout)
                    .foregroundStyle(finding.taskTitle.isEmpty ? .secondary : .primary)
                    .lineLimit(1)
            }
            TableColumn("Reviewer") { finding in
                HStack(spacing: Theme.Spacing.xs) {
                    HarnessDot(family: finding.reviewer, size: 7)
                    Text(finding.reviewer.label).lineLimit(1)
                }
                .font(.callout)
            }
            TableColumn("Evidence") { finding in
                ReviewEvidenceCell(finding: finding)
            }
            TableColumn("State") { finding in
                ReviewStateBadge(finding: finding)
            }
        }
        .tableStyle(.inset(alternatesRowBackgrounds: true))
        .scrollContentBackground(.hidden)
        .background(Theme.surfaceRaised)
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
        let label = finding.accepted == true ? "Accepted" : finding.accepted == false ? "Rebutted" : "Proposed"
        let tint: Color = finding.accepted == true ? Theme.status(.succeeded) : finding.accepted == false ? Theme.status(.failed) : .secondary
        Text(label)
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
                    Text(finding.accepted == true ? "Accepted" : finding.accepted == false ? "Rebutted" : "Proposed")
                        .font(.caption2.weight(.medium)).foregroundStyle(.secondary)
                }
            }
            .padding(Theme.Spacing.md)
        }
        .cardSurface(clip: true)   // clip rounds the leading severity bar
    }
}

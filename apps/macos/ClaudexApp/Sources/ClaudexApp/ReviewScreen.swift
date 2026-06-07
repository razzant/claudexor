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
                Table(findings) {
                    TableColumn("Severity") { finding in
                        Label(finding.severity.label, systemImage: finding.severity.glyph)
                            .foregroundStyle(finding.severity.color)
                    }
                    TableColumn("Finding") { finding in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(finding.title).font(.callout.weight(.medium)).lineLimit(1)
                            Text(finding.detail).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                    TableColumn("Task") { finding in
                        Text(finding.taskTitle.isEmpty ? "—" : finding.taskTitle).lineLimit(1)
                    }
                    TableColumn("Reviewer") { finding in
                        HStack(spacing: Theme.Spacing.xs) {
                            HarnessDot(family: finding.reviewer, size: 7)
                            Text(finding.reviewer.label)
                        }
                    }
                    TableColumn("Evidence") { finding in
                        if let file = finding.evidenceFile {
                            Text("\(file)\(finding.evidenceLine.map { ":\($0)" } ?? "")")
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(Theme.link)
                                .lineLimit(1)
                        } else {
                            Text("No evidence").foregroundStyle(.secondary)
                        }
                    }
                    TableColumn("State") { finding in
                        Text(finding.accepted == true ? "Accepted" : finding.accepted == false ? "Rebutted" : "Proposed")
                            .foregroundStyle(.secondary)
                    }
                }
                .tableStyle(.inset(alternatesRowBackgrounds: true))
                .padding(Theme.Spacing.xxl)
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

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
                ScrollView {
                    VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                        ForEach(findings) { FindingCard(finding: $0, showTask: true) }
                    }
                    .padding(Theme.Spacing.xxl)
                    .frame(maxWidth: Theme.Layout.contentMaxWidth, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
                .scrollContentBackground(.hidden)
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
    @State private var decision: Bool?

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
                    acceptControls
                }
            }
            .padding(Theme.Spacing.md)
        }
        .cardSurface(clip: true)   // clip rounds the leading severity bar
        .onAppear { decision = finding.accepted }
    }

    private var acceptControls: some View {
        HStack(spacing: Theme.Spacing.xs) {
            Button { withAnimation { decision = true } } label: {
                Label("Accept", systemImage: "checkmark").font(.caption2)
            }
            .buttonStyle(.bordered)
            .tint(decision == true ? Theme.status(.succeeded) : .secondary)
            Button { withAnimation { decision = false } } label: {
                Label("Rebut", systemImage: "arrow.uturn.left").font(.caption2)
            }
            .buttonStyle(.bordered)
            .tint(decision == false ? Theme.status(.failed) : .secondary)
        }
    }
}

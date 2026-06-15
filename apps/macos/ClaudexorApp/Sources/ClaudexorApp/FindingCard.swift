import SwiftUI

/// One review finding card (severity bar + reviewer + evidence). Used by the run
/// inspector's Review section. Extracted from the deleted Review Queue screen.
struct FindingCard: View {
    let finding: Finding

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

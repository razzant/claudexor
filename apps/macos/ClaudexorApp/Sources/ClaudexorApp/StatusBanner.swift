import AppKit
import SwiftUI

/// The persistent thread status/error banner. Error text is USER EVIDENCE:
/// always selectable, with an explicit copy affordance (DESIGN_SYSTEM §2.9 —
/// no unselectable error surfaces anywhere).
struct StatusBanner: View {
    let message: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.xs) {
            Text(message)
                .font(.callout)
                .foregroundStyle(.orange)
                .textSelection(.enabled)
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(message, forType: .string)
            } label: {
                Image(systemName: "doc.on.doc")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            // QA-003: name the icon-only copy control (else the AX name is the
            // localized `doc.on.doc` description).
            .accessibilityLabel("Copy message")
            .help("Copy message")
        }
        .conversationMeasure()
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.xs)
    }
}

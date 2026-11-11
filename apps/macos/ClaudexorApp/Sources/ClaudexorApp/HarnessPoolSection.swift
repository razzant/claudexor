import SwiftUI

/// The composer "⋯" harness pool (#133): the Auto chip with the harnesses Auto
/// may choose, then a quiet "Manual only" group for harnesses an explicit
/// selection may run but Auto never picks. Pure: the screen supplies the
/// server-derived lanes and the sticky pool; a tap only reports the choice.
struct HarnessPoolSection: View {
    struct Entry: Identifiable, Equatable {
        let family: HarnessFamily
        let lane: HarnessPoolPresentation.Lane
        var id: String { family.rawValue }
    }

    let entries: [Entry]
    let pool: [String]
    let selectAuto: () -> Void
    let toggle: (HarnessFamily) -> Void

    /// Auto's set: what the Auto chip stands for and what a first tap materializes.
    nonisolated static func autoAvailable(_ entries: [Entry]) -> [String] {
        entries.filter { $0.lane == .auto }.map(\.family.rawValue)
    }

    private var available: [String] { Self.autoAvailable(entries) }
    private var manual: [Entry] { entries.filter(\.lane.isManualOnly) }

    var body: some View {
        let auto = HarnessPoolPresentation.isAuto(pool: pool)
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            FlowLayout(spacing: Theme.Spacing.sm) {
                // Leading Auto chip (owner F9): SELECTED by default. Auto = an
                // empty sticky pool = the engine routes across every harness it
                // may choose. Tapping it clears any explicit subset.
                FilterChip(label: "Auto", systemImage: auto ? "checkmark" : "wand.and.stars",
                           isActive: auto, tint: Theme.accent, action: selectAuto)
                    .help("Auto — the engine routes across every available harness. Pick specific harnesses to pin an explicit subset.")
                ForEach(entries.filter { !$0.lane.isManualOnly }) { entry in
                    mainChip(entry)
                }
            }
            // A refusal the user cannot anticipate is said in visible text, not
            // only on hover (a disabled control explains why).
            ForEach(entries.filter { $0.lane == .cannotReadProjectFiles }) { entry in
                PoolReasonLine(text: "\(entry.family.label): \(HarnessPoolPresentation.cannotReadProjectFilesReason)")
            }
            Text(HarnessPoolPresentation.caption(pool: pool))
                .font(.caption2).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if !manual.isEmpty { manualGroup }
        }
    }

    private func mainChip(_ entry: Entry) -> some View {
        let family = entry.family
        let descriptor = HarnessPoolPresentation.chipDescriptor(
            family.rawValue, pool: pool, available: available,
            availability: .init(available: entry.lane == .auto, reason: entry.lane.unavailableReason ?? ""))
        // In Auto every available harness renders highlighted-as-included; never
        // synthesize a "<glyph>.slash" (no such SF Symbol → blank icon): disabled
        // dimming + the hover reason convey unavailability.
        return FilterChip(label: family.label, iconImage: HarnessIconImage.image(for: family),
                          isActive: descriptor.included, tint: family.color, fill: family.fill) { toggle(family) }
            .disabled(entry.lane != .auto)
            .help(descriptor.help)
            .accessibilityValue(descriptor.accessibilityValue)
    }

    private var manualGroup: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text(HarnessPoolPresentation.manualOnlyTitle)
                .font(.caption).foregroundStyle(.secondary)
                .padding(.top, Theme.Spacing.sm)
            FlowLayout(spacing: Theme.Spacing.sm) {
                ForEach(manual) { entry in
                    let reason: String = {
                        if case .manualOnly(let reason) = entry.lane { return reason }
                        return ""
                    }()
                    let descriptor = HarnessPoolPresentation.manualOnlyChipDescriptor(
                        entry.family.rawValue, pool: pool, reason: reason)
                    FilterChip(label: entry.family.label, iconImage: HarnessIconImage.image(for: entry.family),
                               isActive: descriptor.included, tint: entry.family.color,
                               fill: entry.family.fill) { toggle(entry.family) }
                        .help(descriptor.help)
                        .accessibilityValue(descriptor.accessibilityValue)
                }
            }
            // The doctor's own reason, verbatim — never a paraphrase of readiness.
            ForEach(manual) { entry in
                if case .manualOnly(let reason) = entry.lane {
                    Text("\(entry.family.label): \(reason)")
                        .font(.caption2).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

/// One visible refusal line: the caution colour stays on the glyph and the
/// reason reads at full contrast.
private struct PoolReasonLine: View {
    let text: String

    var body: some View {
        Label {
            Text(text).foregroundStyle(.primary)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.status(.caution))
        }
        .font(.caption2)
        .fixedSize(horizontal: false, vertical: true)
    }
}

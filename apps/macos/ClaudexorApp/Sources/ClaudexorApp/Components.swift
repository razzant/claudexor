import SwiftUI

// MARK: - Status pill (solid tinted — content layer)

struct StatusPill: View {
    let status: RunPhase
    var compact = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        HStack(spacing: Theme.Spacing.xs) {
            Image(systemName: status.glyph)
                .imageScale(.small)
            if !compact { Text(status.label) }
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(status.color)
        .padding(.horizontal, compact ? Theme.Spacing.sm : Theme.Spacing.md)
        .padding(.vertical, Theme.Spacing.xs)
        .background(status.color.opacity(0.15), in: Capsule())
        .accessibilityLabel("Status \(status.label)")
    }
}


// MARK: - Harness chip / dot

struct HarnessChip: View {
    let family: HarnessFamily
    var selected = true
    var available = true
    var body: some View {
        HStack(spacing: Theme.Spacing.xs) {
            HarnessIcon(family: family, size: 13).opacity(selected && available ? 1 : 0.45)
            // Chip meta-rule (round-3 item 4): chip label never wraps its text.
            Text(family.label)
                .lineLimit(1).fixedSize(horizontal: true, vertical: false)
            if !available {
                Image(systemName: "slash.circle").imageScale(.small)
            }
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(selected && available ? family.color : .secondary)
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, 5)
        .background(family.color.opacity(selected && available ? 0.16 : 0.0), in: Capsule())
        .overlay(Capsule().stroke(selected && available ? family.color.opacity(0.45) : Theme.separator, lineWidth: 1))
        .opacity(available ? 1 : 0.62)
        .accessibilityLabel("\(family.label) harness\(selected ? ", selected" : "")\(available ? "" : ", unavailable")")
        .help(available ? "\(family.label) harness\(selected ? " is selected." : ".")" : "\(family.label) harness is unavailable for this route.")
    }
}

struct HarnessDot: View {
    let family: HarnessFamily
    var size: CGFloat = 8
    var body: some View {
        Circle().fill(family.color).frame(width: size, height: size)
            .accessibilityLabel(family.label)
    }
}

// MARK: - Solid content panel

/// A solid, elevated content card (per HIG: content on opaque surfaces for contrast; the
/// glass + moving glow live behind it on the chrome/margins). Dense code/diff/transcript
/// use `codeSurface`.
struct Panel<Content: View>: View {
    var padding: CGFloat = Theme.Spacing.lg
    @ViewBuilder var content: Content
    var body: some View {
        content.padding(padding).cardSurface()
    }
}

// MARK: - Section header (balanced, Codex-like: medium weight, muted)

struct SectionLabel: View {
    let title: String
    var systemImage: String?
    var accessory: AnyView?
    init(_ title: String, systemImage: String? = nil, accessory: AnyView? = nil) {
        self.title = title; self.systemImage = systemImage; self.accessory = accessory
    }
    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            if let systemImage {
                Image(systemName: systemImage).imageScale(.small).foregroundStyle(Theme.accent)
            }
            Text(title).font(.subheadline.weight(.semibold))
            Spacer(minLength: Theme.Spacing.sm)
            if let accessory { accessory }
        }
    }
}

// MARK: - Honesty badges

struct RouteProofBadge: View {
    let proof: RouteProof
    var body: some View {
        HStack(spacing: Theme.Spacing.xs) {
            Image(systemName: proof.glyph).imageScale(.small)
            Text(proof.label)
        }
        .font(.caption2.weight(.medium))
        .foregroundStyle(proof.color)
        .padding(.horizontal, Theme.Spacing.sm)
        .padding(.vertical, 3)
        .background(proof.color.opacity(0.13), in: Capsule())
        .help("Route proof records requested vs. observed reviewer provider/model.")
    }
}

struct EstimatedCostBadge: View {
    let cost: Double
    let estimated: Bool
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: estimated ? "wave.3.right.circle" : "checkmark.seal").imageScale(.small)
            Text(String(format: "$%.4f", cost)).monospacedDigit()
            if estimated { Text("est").italic() }
        }
        .font(.caption2)
        .foregroundStyle(estimated ? Theme.status(.caution) : .secondary)
        .help(estimated ? "Estimated spend (native quota best-effort)." : "Exact spend.")
    }
}

// MARK: - Empty state

struct EmptyStateView: View {
    let title: String
    let message: String
    var systemImage: String = "tray"
    var actionTitle: String?
    var action: (() -> Void)?
    var body: some View {
        VStack(spacing: Theme.Spacing.md) {
            Image(systemName: systemImage)
                .font(.system(size: 38, weight: .light))
                .foregroundStyle(Theme.accent)
            Text(title).font(.title3.weight(.semibold))
            Text(message).font(.subheadline).foregroundStyle(.secondary)
                .multilineTextAlignment(.center).frame(maxWidth: 380)
            if let actionTitle, let action {
                Button(actionTitle, action: action).buttonStyle(.borderedProminent).tint(Theme.accent)
            }
        }
        .padding(Theme.Spacing.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Key/value row (left label, right muted value — Codex balance)

struct KeyValueRow: View {
    let key: String
    let value: String
    var valueColor: Color = .primary
    var mono = false
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.md) {
            Text(key).font(.caption).foregroundStyle(.secondary)
            Spacer(minLength: Theme.Spacing.md)
            Text(value)
                .font(mono ? .system(.caption, design: .monospaced) : .caption)
                .foregroundStyle(valueColor)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
        .padding(.vertical, 1)
    }
}

// MARK: - Segmented tabs (solid; content layer)

struct SegmentedTabs<T: Hashable>: View {
    let items: [(value: T, label: String, glyph: String)]
    @Binding var selection: T
    /// Optional trailing count per tab (e.g. plan steps, candidates).
    var badge: ((T) -> Int?)? = nil
    @Namespace private var ns
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        HStack(spacing: Theme.Spacing.xs) {
            ForEach(items, id: \.value) { item in
                let active = item.value == selection
                Button {
                    // Animate ONLY the indicator (matchedGeometry), and only when motion is
                    // allowed — wrapping the whole content swap caused a laggy "second tap".
                    if reduceMotion { selection = item.value }
                    else { withAnimation(.snappy(duration: 0.22)) { selection = item.value } }
                } label: {
                    HStack(spacing: Theme.Spacing.xs) {
                        Image(systemName: item.glyph).imageScale(.small)
                        Text(item.label)
                        if let badge, let n = badge(item.value), n > 0 {
                            Text("\(n)").font(.caption2.weight(.bold)).monospacedDigit()
                                .padding(.horizontal, Theme.Spacing.xs).padding(.vertical, Theme.Spacing.xxs)
                                .background(active ? Theme.accent.opacity(0.22) : Theme.surfaceRaisedHi, in: Capsule())
                        }
                    }
                    .font(.callout.weight(active ? .semibold : .regular))
                    .foregroundStyle(active ? Theme.accent : .secondary)
                    .padding(.horizontal, Theme.Spacing.md)
                    .padding(.vertical, Theme.Spacing.sm)
                    .background {
                        if active {
                            RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous)
                                .fill(Theme.accent.opacity(0.15))
                                .matchedGeometryEffect(id: "seg", in: ns)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(active ? [.isSelected, .isButton] : .isButton)
                .help(active ? "\(item.label) tab is selected." : "Show \(item.label).")
            }
        }
    }
}

// MARK: - Filter chip (ONE canonical selection chip for every filter row)

/// The single source of truth for a selectable filter pill, so typography, padding,
/// and the selected fill are identical wherever filters appear.
struct FilterChip: View {
    let label: String
    var systemImage: String?
    /// A pre-rendered icon (e.g. a brand mark) shown INSTEAD of `systemImage`.
    var iconImage: Image?
    var count: Int?
    let isActive: Bool
    var tint: Color = Theme.accent
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Theme.Spacing.xs) {
                if let iconImage { iconImage.imageScale(.small) }
                else if let systemImage { Image(systemName: systemImage).imageScale(.small) }
                // Chip meta-rule (round-3 item 4): filter-pill label never wraps.
                Text(label)
                    .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                if let count, count > 0 {
                    Text("\(count)").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                }
            }
            .font(.callout.weight(isActive ? .semibold : .regular))
            .foregroundStyle(isActive ? tint : .secondary)
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.sm)
            .selectedChip(active: isActive, tint: tint)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isActive ? [.isSelected, .isButton] : .isButton)
        .help(isActive ? "\(label) filter is selected." : "Filter by \(label).")
    }
}

// MARK: - Flow layout (wrapping chips)

struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for sub in subviews {
            let size = sub.sizeThatFits(.unspecified)
            if x + size.width > maxWidth { x = 0; y += rowHeight + spacing; rowHeight = 0 }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: maxWidth == .infinity ? x : maxWidth, height: y + rowHeight)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for sub in subviews {
            let size = sub.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX { x = bounds.minX; y += rowHeight + spacing; rowHeight = 0 }
            sub.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}


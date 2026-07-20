import SwiftUI

// MARK: - AlignedListRow — the ONE shared control-row component (UI cut 3, §1)
//
// The owner-round-3 bug: account rows broke because the identity cell had no
// single-line discipline (quota/status text wrapped into fragments that flowed
// around the trailing columns) and no component owned the row layout — every
// call site hand-rolled the Grid columns and could get them wrong.
//
// This file is that owning component. A multi-control list row is ALWAYS:
//   AlignedList { ForEach { AlignedListRow(identity:) { <trailing control cells> } } }
// where `AlignedList` owns the ONE shared Grid (so trailing controls share a
// column edge across every sibling row) and `AlignedRowIdentity` owns the
// leading status-dot + title + SINGLE-LINE detail stack (so a detail can never
// wrap into fragments). Hand-rolled row layouts for control rows are forbidden
// (DESIGN_SYSTEM §2.8) — the discipline is folded in here so call sites cannot
// reintroduce the bug.

/// Foreground emphasis for a title badge or a detail line.
enum AlignedRowEmphasis: Equatable {
    case secondary, tertiary, warning, positive, accent

    var style: Color {
        switch self {
        case .secondary: return Color.secondary
        case .tertiary: return Color.secondary.opacity(0.7)
        case .warning: return Theme.status(.caution)
        case .positive: return Theme.status(.positive)
        case .accent: return Theme.accent
        }
    }
}

/// One detail line under a row's title. ALWAYS rendered single-line with tail
/// truncation; the full (possibly multi-line) text is reachable via `.help`.
/// The single-line collapse is the discipline call sites cannot bypass.
struct AlignedRowDetail: Equatable, Identifiable {
    let id: Int
    var text: String
    var emphasis: AlignedRowEmphasis = .secondary
    var monospacedDigit: Bool = false

    init(_ id: Int = 0, _ text: String,
         emphasis: AlignedRowEmphasis = .secondary, monospacedDigit: Bool = false) {
        self.id = id
        self.text = text
        self.emphasis = emphasis
        self.monospacedDigit = monospacedDigit
    }

    /// The rendered form: runs of whitespace (spaces, tabs, newlines) collapse to
    /// one space so the line can never wrap into multiple interleaving fragments.
    var singleLine: String { AlignedRowText.singleLine(text) }
}

/// A quiet inline badge on the title line (e.g. the "Next up" routing hint or a
/// harness id). Informational — NEVER a control column.
struct AlignedRowBadge: Equatable {
    var text: String
    var systemImage: String?
    var emphasis: AlignedRowEmphasis = .secondary

    init(_ text: String, systemImage: String? = nil, emphasis: AlignedRowEmphasis = .secondary) {
        self.text = text
        self.systemImage = systemImage
        self.emphasis = emphasis
    }
}

enum AlignedRowText {
    /// Collapse ALL whitespace runs to a single space and trim the ends — the
    /// tested single-line derivation shared by every ported surface.
    static func singleLine(_ s: String) -> String {
        // `.isWhitespace` covers spaces, tabs, every newline, AND the "\r\n"
        // grapheme cluster (which iterates as a SINGLE Character in Swift).
        s.split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
    }
}

/// The identity block of an aligned row: a leading status dot (a colored circle
/// or a status glyph) + a title line (with optional muted inline badges) + zero
/// or more SINGLE-LINE detail lines. It absorbs the row's horizontal slack so
/// the trailing controls sit on a shared column edge. Reused verbatim by every
/// ported surface — no call site re-implements the dot/title/detail stack.
struct AlignedRowIdentity: View {
    var dotColor: Color?
    /// When set, the leading marker is this SF Symbol tinted `dotColor` instead
    /// of a filled circle (readiness check rows use a pass/fail glyph).
    var dotSystemImage: String?
    var dotHelp: String?
    var title: String
    var titleWeight: Font.Weight = .medium
    /// Override the title font entirely (compact info rows use `.caption`);
    /// nil keeps the default `.callout` at `titleWeight`.
    var titleFont: Font?
    /// Muted inline badges after the title (harness id, "Next up", …).
    var badges: [AlignedRowBadge] = []
    var details: [AlignedRowDetail] = []

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            marker
            VStack(alignment: .leading, spacing: 2) {
                titleLine
                ForEach(details) { detail in
                    Text(detail.singleLine)
                        .font(.caption2)
                        .foregroundStyle(detail.emphasis.style)
                        .modifier(MonospacedDigitIf(on: detail.monospacedDigit))
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .help(detail.text)
                }
            }
        }
    }

    @ViewBuilder private var marker: some View {
        if let dotSystemImage {
            Image(systemName: dotSystemImage)
                .font(.caption2)
                .foregroundStyle(dotColor ?? .secondary)
                .frame(width: 14)
                .padding(.top, 2)
                .help(dotHelp ?? "")
        } else if let dotColor {
            Circle()
                .fill(dotColor)
                .frame(width: 8, height: 8)
                .padding(.top, 4)
                .help(dotHelp ?? "")
        }
    }

    private var titleLine: some View {
        HStack(spacing: Theme.Spacing.xs) {
            Text(title)
                .font(titleFont ?? .callout.weight(titleWeight))
                .lineLimit(1)
                .truncationMode(.tail)
            ForEach(Array(badges.enumerated()), id: \.offset) { _, badge in
                AlignedBadgeView(badge: badge)
            }
        }
    }
}

/// A quiet informational badge chip on the title line. NOT a control.
struct AlignedBadgeView: View {
    let badge: AlignedRowBadge

    var body: some View {
        HStack(spacing: 2) {
            if let systemImage = badge.systemImage {
                Image(systemName: systemImage).font(.caption2)
            }
            Text(badge.text).font(.caption2)
        }
        .foregroundStyle(badge.emphasis.style)
    }
}

private struct MonospacedDigitIf: ViewModifier {
    let on: Bool
    func body(content: Content) -> some View { on ? AnyView(content.monospacedDigit()) : AnyView(content) }
}

/// ONE row of an aligned list. Renders a `GridRow`: the leading cell (which
/// absorbs the slack) followed by the caller's trailing control cells, emitted
/// as real Grid columns so sibling rows share column edges. MUST be hosted
/// inside `AlignedList` (which owns the Grid) — a `GridRow` is meaningless
/// outside a Grid. The common case is `init(identity:)`: the leading cell is the
/// disciplined dot+title+single-line-detail `AlignedRowIdentity`, so a detail
/// can never wrap. The `init(leading:)` escape hatch exists only for a control
/// row whose leading is not that identity (e.g. a HarnessChip) and which carries
/// no wrapping detail; the shared-Grid trailing columns still apply.
struct AlignedListRow<Leading: View, Controls: View>: View {
    let leading: Leading
    @ViewBuilder var controls: () -> Controls

    init(identity: AlignedRowIdentity, @ViewBuilder controls: @escaping () -> Controls)
    where Leading == AlignedRowIdentity {
        self.leading = identity
        self.controls = controls
    }

    init(@ViewBuilder leading: () -> Leading, @ViewBuilder controls: @escaping () -> Controls) {
        self.leading = leading()
        self.controls = controls
    }

    var body: some View {
        GridRow(alignment: .top) {
            leading
                .frame(maxWidth: .infinity, alignment: .leading)
                .gridColumnAlignment(.leading)
            controls()
        }
    }
}

/// The aligned-list container: it owns the ONE shared Grid so call sites cannot
/// reintroduce per-row hand-rolled coordinates (DESIGN_SYSTEM §2.8). Every row
/// is an `AlignedListRow`; use `AlignedColumnSpacer` for a reserved-but-empty
/// trailing control so columns never shift between rows.
struct AlignedList<Content: View>: View {
    var horizontalSpacing: CGFloat = Theme.Spacing.sm
    var verticalSpacing: CGFloat = Theme.Spacing.sm
    @ViewBuilder var content: () -> Content

    var body: some View {
        Grid(alignment: .top, horizontalSpacing: horizontalSpacing, verticalSpacing: verticalSpacing) {
            content()
        }
    }
}

/// A clear spacer that still reserves a trailing control column when a row lacks
/// that control, so the columns to its left never shift between rows.
struct AlignedColumnSpacer: View {
    let width: CGFloat
    var body: some View { Color.clear.frame(width: width, height: 1) }
}

extension View {
    /// Mark this view as a trailing control column of an `AlignedListRow`: a
    /// per-cell minimum-width FLOOR + a shared column alignment. The Grid pins
    /// the true shared edge across rows; the floor only keeps a cell from
    /// collapsing narrower than its siblings.
    func alignedControlColumn(
        minWidth: CGFloat, alignment: HorizontalAlignment = .center
    ) -> some View {
        let frameAlignment: Alignment
        switch alignment {
        case .leading: frameAlignment = .leading
        case .trailing: frameAlignment = .trailing
        default: frameAlignment = .center
        }
        return self
            .frame(minWidth: minWidth, alignment: frameAlignment)
            .gridColumnAlignment(alignment)
    }
}

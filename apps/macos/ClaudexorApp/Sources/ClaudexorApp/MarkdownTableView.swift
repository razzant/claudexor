import SwiftUI
import AppKit

/// The dedicated table renderer: a NON-LAZY `Grid` inside a horizontal
/// `ScrollView` on a solid `codeSurface` (§3 — dense content never sits on
/// glass). No nested lazy layout in the conversation scroll hierarchy (#23).
/// Cell text runs the shared inline AttributedString path, so emphasis / code /
/// links keep working and the parent's file-link `openURL` gate still applies.
struct MarkdownTableView: View {
    let table: MarkdownOutputView.MarkdownTable
    var bodyFont: Font = .callout
    /// Where the rows/columns the caps dropped can still be read.
    var overflowHint = MarkdownTableView.overflowHint(filePreview: false)
    var markdown = ""
    @State private var hiddenColumns = TableHiddenColumns()

    nonisolated static func overflowHint(filePreview: Bool) -> String {
        filePreview ? "choose Show source to inspect the loaded text" : "open the run's full answer artifact"
    }

    private let cellMinWidth: CGFloat = 64
    private let cellMaxWidth: CGFloat = 320

    var body: some View {
        let widths = columnWidths
        ProsePreviewLayout(usesProposedHeight: true, spacing: Theme.Spacing.xs) {
            Button("Copy table", systemImage: "doc.on.doc") { _ = ProseCodeActions.write(markdown) }
                .buttonStyle(.borderless).font(.caption).foregroundStyle(Theme.accent)
                .help("Copy the complete table as Markdown.")
                .accessibilityLabel("Copy table")
            ScrollView(.horizontal, showsIndicators: true) {
                Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                    GridRow {
                        HStack(alignment: .top, spacing: 0) {
                            ForEach(Array(table.header.enumerated()), id: \.offset) { idx, text in
                                cell(text, width: widths[idx], align: alignment(idx), header: true)
                            }
                        }
                        .background(Rectangle().fill(Theme.surfaceRaisedHi))
                        .gridCellColumns(widths.count)
                    }
                    Rectangle().fill(Theme.separator).frame(height: 1).gridCellColumns(widths.count)
                    ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { idx, text in
                                cell(text, width: widths[idx], align: alignment(idx), header: false)
                            }
                        }
                        Rectangle().fill(Theme.separator).frame(height: 1).gridCellColumns(widths.count)
                    }
                }
                // #24 (owner dogfood): fix HORIZONTAL only. A plain `.fixedSize()`
                // (both axes) locked the Grid to its IDEAL height, which is measured
                // with single-line cells — but a cell wider than its 320pt clamp WRAPS
                // to 2+ lines at layout time, so the row rendered taller than its
                // locked slot and OVERLAPPED the next row. Fixing width only lets the
                // Grid keep its natural width (so it scrolls horizontally, preserving
                // the 64–320pt column clamps) while each row's HEIGHT grows to the
                // tallest wrapped cell.
                .fixedSize(horizontal: true, vertical: false)
                .overlay(alignment: .leading) {
                    HStack(spacing: 0) {
                        ForEach(Array(widths.enumerated()), id: \.offset) { _, width in
                            Color.clear.frame(width: width)
                                .overlay(alignment: .trailing) { Rectangle().fill(Theme.separator).frame(width: 1) }
                        }
                    }.allowsHitTesting(false).accessibilityHidden(true)
                }
            }
            .frame(maxWidth: widths.reduce(0, +), alignment: .leading)
            .onScrollGeometryChange(for: TableHiddenColumns.self) { geometry in
                TableHiddenColumns(offset: geometry.contentOffset.x + geometry.contentInsets.leading,
                    content: geometry.contentSize.width, viewport: geometry.containerSize.width)
            } action: { _, hidden in hiddenColumns = hidden }
            .modifier(TableOverflowFade(hidden: hiddenColumns))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
            .codeSurface(Theme.Radius.control)
            .layoutValue(key: ProsePreviewBoundary.self, value: { _, limit in
                previewHeight(widths: widths, limit: limit)
            })
            if let disclosure {
                Text(disclosure)
                    .font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .layoutValue(key: ProsePreviewUsesProposal.self, value: true)
    }

    // Give the grid each column's actual clamped width BEFORE it asks for row
    // heights. An unconstrained ideal-width pass otherwise reports one line,
    // then draws wrapped cell text over the following rows.
    private var columnWidths: [CGFloat] {
        let font = NSFont.preferredFont(forTextStyle: bodyFont == .body ? .body : .callout)
        return table.header.indices.map { column in
            let values = [table.header[column]] + table.rows.map { $0[column] }
            let widest = values.map { value in
                (String(MarkdownOutputView.inlineAttributed(value).characters) as NSString)
                    .size(withAttributes: [.font: font]).width
            }.max() ?? 0
            return min(cellMaxWidth, max(cellMinWidth, ceil(widest) + 2 * Theme.Spacing.md))
        }
    }

    private func alignment(_ idx: Int) -> MarkdownOutputView.MarkdownTable.Alignment {
        idx < table.alignments.count ? table.alignments[idx] : .leading
    }

    @ViewBuilder
    private func cell(_ text: String, width: CGFloat, align: MarkdownOutputView.MarkdownTable.Alignment, header: Bool) -> some View {
        Text(MarkdownOutputView.inlineAttributed(text))
            .font(header ? bodyFont.weight(.semibold) : bodyFont)
            .multilineTextAlignment(textAlignment(align))
            .lineLimit(nil)
            .frame(width: max(1, width - 2 * Theme.Spacing.md), alignment: frameAlignment(align))
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.disabled)
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.sm)
    }

    private func previewHeight(widths: [CGFloat], limit: CGFloat) -> CGFloat {
        let style = ProseStyle(bodySize: NSFont.preferredFont(forTextStyle: bodyFont == .body ? .body : .callout).pointSize)
        var y: CGFloat = 0
        var lastBottom: CGFloat = 0
        for (rowIndex, row) in ([table.header] + table.rows).enumerated() {
            var lineRects: [CGRect] = []
            var rowHeight: CGFloat = 0
            for (column, text) in row.enumerated() {
                let doc = ProseBuilder.tableCell(text, style: style, header: rowIndex == 0)
                let width = max(1, widths[column] - 2 * Theme.Spacing.md)
                rowHeight = max(rowHeight, ProseMeasurer.shared.height(doc, width: width) + 2 * Theme.Spacing.sm)
                lineRects += ProseMeasurer.shared.lines(doc, width: width).map { $0.offsetBy(dx: 0, dy: y + Theme.Spacing.sm) }
            }
            if y + rowHeight > limit {
                let candidates = lineRects.map { ceil($0.maxY) }.filter { $0 <= limit }.sorted().reversed()
                return candidates.first { cut in !lineRects.contains { $0.minY < cut && ceil($0.maxY) > cut } } ?? lastBottom
            }
            y += rowHeight + 1
            lastBottom = y
        }
        return min(limit, lastBottom)
    }

    private func frameAlignment(_ a: MarkdownOutputView.MarkdownTable.Alignment) -> Alignment {
        switch a {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }

    private func textAlignment(_ a: MarkdownOutputView.MarkdownTable.Alignment) -> TextAlignment {
        switch a {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }

    private var disclosure: String? { Self.disclosure(for: table, overflowHint: overflowHint) }

    nonisolated static func disclosure(for table: MarkdownOutputView.MarkdownTable, overflowHint: String) -> String? {
        var parts: [String] = []
        if table.truncatedRows > 0 { parts.append("\(table.truncatedRows) more rows") }
        if table.truncatedColumns > 0 { parts.append("\(table.truncatedColumns) more columns") }
        guard !parts.isEmpty else { return nil }
        return parts.joined(separator: " · ") + " not shown — \(overflowHint)."
    }
}

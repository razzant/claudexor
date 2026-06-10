import SwiftUI

/// Git-scoped diff. Code sits on solid `surface/code` for maximum legibility — glass
/// NEVER goes behind diff text (Apple Liquid Glass guidance + our design system).
struct DiffView: View {
    let files: [DiffFile]

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel("Diff", systemImage: "plusminus.circle",
                         accessory: AnyView(diffSummary))
            if files.isEmpty {
                Panel { Text("No file changes in this run yet.").foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading) }
            } else {
                ForEach(files) { FileDiff(file: $0) }
            }
        }
    }

    private var diffSummary: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Text("\(files.count) files").font(.caption).foregroundStyle(.secondary)
            Text("+\(files.reduce(0) { $0 + $1.added })").font(.caption.weight(.medium)).foregroundStyle(Theme.status(.succeeded))
            Text("−\(files.reduce(0) { $0 + $1.removed })").font(.caption.weight(.medium)).foregroundStyle(Theme.status(.failed))
        }
    }
}

private struct FileDiff: View {
    let file: DiffFile
    @State private var expanded = true

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if expanded {
                ForEach(file.hunks) { hunk in
                    hunkHeader(hunk.header)
                    ForEach(hunk.lines) { line in DiffLineRow(line: line) }
                }
            }
        }
        .background(Theme.surfaceCode, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous).stroke(Theme.separator, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
    }

    private var header: some View {
        HStack(spacing: Theme.Spacing.md) {
            Button { withAnimation(.snappy) { expanded.toggle() } } label: {
                Image(systemName: expanded ? "chevron.down" : "chevron.right").imageScale(.small).foregroundStyle(.secondary)
            }.buttonStyle(.plain)
            Image(systemName: "doc.text").foregroundStyle(.secondary)
            Text(file.path).font(.system(.callout, design: .monospaced)).lineLimit(1).truncationMode(.middle)
            Spacer()
            Text("+\(file.added)").font(.caption.weight(.medium)).foregroundStyle(Theme.status(.succeeded))
            Text("−\(file.removed)").font(.caption.weight(.medium)).foregroundStyle(Theme.status(.failed))
            Image(systemName: "lock.doc")
                .imageScale(.small)
                .foregroundStyle(.secondary)
                .help("Apply uses the server patch artifact. Per-file apply is not exposed yet.")
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, Theme.Spacing.sm)
        .background(Theme.surfaceRaised)
    }

    private func hunkHeader(_ text: String) -> some View {
        Text(text)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.xs)
            .background(Theme.surfaceRaisedHi.opacity(0.5))
    }
}

private struct DiffLineRow: View {
    let line: DiffLine

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            gutter(line.oldNo)
            gutter(line.newNo)
            Text(marker)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(markerColor)
                .frame(width: 16)
            Text(line.text.isEmpty ? " " : line.text)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(textColor)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 1)
        .background(rowBackground)
    }

    private func gutter(_ n: Int?) -> some View {
        Text(n.map(String.init) ?? "")
            .font(.system(.caption2, design: .monospaced))
            .foregroundStyle(.tertiary)
            .frame(width: 38, alignment: .trailing)
            .padding(.trailing, Theme.Spacing.xs)
    }

    private var marker: String { line.kind == .add ? "+" : (line.kind == .remove ? "−" : " ") }
    private var markerColor: Color { line.kind == .add ? Theme.status(.succeeded) : (line.kind == .remove ? Theme.status(.failed) : .clear) }
    private var textColor: Color { line.kind == .context ? .secondary : .primary }
    private var rowBackground: Color {
        switch line.kind {
        case .add: return Theme.status(.succeeded).opacity(0.10)
        case .remove: return Theme.status(.failed).opacity(0.10)
        default: return .clear
        }
    }
}

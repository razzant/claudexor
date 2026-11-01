import Foundation

/// An engine-authored line in a turn's transcript: never model speech and
/// never a tool call. Today one event produces it, `workspace.prepared`
/// (#563): what an isolated directory copy was prepared with, before its
/// executor started.
public struct TranscriptNotice: Sendable, Equatable {
    public var title: String
    public var text: String
    public var warning: Bool

    public init(title: String, text: String, warning: Bool) {
        self.title = title
        self.text = text
        self.warning = warning
    }

    /// The block id one prepared copy keeps across the live stream, a replay
    /// and a restored snapshot row, so the same receipt is never shown twice.
    public static func preparedId(attemptId: String) -> String { "workspace.prepared-\(attemptId)" }

    /// The title the server timeline gives a `workspace.prepared` row.
    public static let preparedTitle = "Isolated workspace copy prepared"

    /// The `workspace.prepared` payload worded as the server timeline words it
    /// (the schema's `workspacePreparationSummary`; pinned by the
    /// `workspace-prepared-parity` fixture): every selected and missing path,
    /// JSON-quoted, and a warning when nothing was copied or a selected path was
    /// not found. Nil for a payload the engine schema would reject.
    public static func prepared(_ payload: JSONValue?) -> (attemptId: String, notice: TranscriptNotice)? {
        func count(_ value: JSONValue?) -> Int? {
            guard let n = value?.doubleValue, n >= 0, n == n.rounded(), n < 1e15 else { return nil }
            return Int(n)
        }
        func paths(_ value: JSONValue?) -> [String]? {
            guard case .array(let items)? = value else { return nil }
            let strings = items.compactMap(\.stringValue)
            return strings.count == items.count ? strings : nil
        }
        guard case .object(let fields)? = payload,
              Set(fields.keys) == ["attempt_id", "source_root", "scope_paths", "copied", "missing_paths"],
              let attemptId = fields["attempt_id"]?.stringValue, !attemptId.isEmpty,
              let root = fields["source_root"]?.stringValue, !root.isEmpty,
              let scope = paths(fields["scope_paths"]), let missing = paths(fields["missing_paths"]),
              case .object(let copied)? = fields["copied"],
              Set(copied.keys) == ["files", "directories", "symlinks"],
              let files = count(copied["files"]), let directories = count(copied["directories"]),
              let symlinks = count(copied["symlinks"])
        else { return nil }
        let list = { (items: [String]) in items.map(jsonQuoted).joined(separator: ", ") }
        let counts = [
            files == 0 ? nil : "\(files) file\(files == 1 ? "" : "s")",
            directories == 0 ? nil : "\(directories) \(directories == 1 ? "directory" : "directories")",
            symlinks == 0 ? nil : "\(symlinks) symbolic link\(symlinks == 1 ? "" : "s")",
        ].compactMap { $0 }
        let from = scope.isEmpty ? "(no input paths were selected)" : "from \(list(scope))"
        var text = "Isolated copy prepared from \(root): "
            + "\(counts.isEmpty ? "nothing" : counts.joined(separator: ", ")) copied \(from)."
        if !missing.isEmpty {
            text += " Not found there when the copy was prepared: \(list(missing))"
                + " (absent in the copy; may be created as new output)."
        }
        if symlinks > 0 { text += " Symbolic links were copied as links, not followed." }
        return (attemptId, TranscriptNotice(
            title: preparedTitle, text: text, warning: counts.isEmpty || !missing.isEmpty))
    }

    /// One string quoted exactly as JavaScript's `JSON.stringify` quotes it, so
    /// a path's quote, backslash, newline or control character stays escaped.
    static func jsonQuoted(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case _ where scalar.value < 0x20: out += String(format: "\\u%04x", scalar.value)
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out + "\""
    }
}

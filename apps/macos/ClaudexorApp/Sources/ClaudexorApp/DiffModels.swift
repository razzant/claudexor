import Foundation

// MARK: - Diff (UI-side projection rendered by the Changes surfaces)

enum DiffLineKind { case context, add, remove, hunk }

struct DiffLine: Identifiable, Hashable {
    let id = UUID()
    var kind: DiffLineKind
    var text: String
    var oldNo: Int?
    var newNo: Int?
}

struct DiffHunk: Identifiable, Hashable {
    let id = UUID()
    var header: String
    var lines: [DiffLine]
}

struct DiffFile: Identifiable, Hashable {
    let id = UUID()
    var path: String
    var added: Int
    var removed: Int
    var hunks: [DiffHunk]
    var accepted: Bool = true
}

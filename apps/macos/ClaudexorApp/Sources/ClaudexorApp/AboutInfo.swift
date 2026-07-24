import Foundation

// MARK: - About metadata (D-11, owner-locked shape)

/// SSOT for the app's authorship/license/link facts, shared by Settings → About
/// and the standard About panel's credits so the two can never drift. The URLs
/// are the exact owner-locked destinations; do not paraphrase the labels.
enum AboutInfo {
    static let author = "Anton Razzhigaev"
    static let license = "MIT"

    static let telegramLabel = "t.me/abstractDL"
    static let telegramURL = URL(string: "https://t.me/abstractDL")!
    static let twitterLabel = "x.com/AbstractDL"
    static let twitterURL = URL(string: "https://x.com/AbstractDL")!
    static let repoLabel = "github.com/razzant/claudexor"
    static let repoURL = URL(string: "https://github.com/razzant/claudexor")!

    /// Short sha for display. "unknown"/empty pass through verbatim — the honest
    /// value a build discloses before packaged sha stamping (Ф4); never faked.
    static func shortSha(_ sha: String) -> String {
        (sha == "unknown" || sha.isEmpty) ? "unknown" : String(sha.prefix(12))
    }
}

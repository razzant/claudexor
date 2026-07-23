import Foundation

/// QA-062 (issue-062): the "Open externally" affordance used to scatter a fresh
/// `claudexor-open-<UUID>` directory directly at the temp-root for EVERY click,
/// with no lifecycle owner. Each private `0700` copy (up to 32 MiB for a binary
/// artifact) then lingered indefinitely, reclaimed only by nondeterministic OS
/// temp purging — an unbounded disk/privacy retention gap.
///
/// This is the minimal owner the report's "safe direction" prescribes: ONE
/// tracked handoff root under the user's temp dir that every external-open copy
/// lives beneath (`$TMPDIR/claudexor-open/`), plus a bounded-age startup sweep of
/// stale copies. It deliberately does NOT delete on open or on app exit — a
/// receiver (Preview, an editor) may keep the handed-off file open for hours,
/// and an editor may modify it — so blind immediate deletion would be data loss.
/// Instead a stale copy is reclaimed on the NEXT launch once it is older than the
/// bound. The write-side hardening is preserved unchanged: a per-copy `0700`
/// UUID subdirectory, basename-only naming (no path traversal), and an atomic
/// write (the v2.1.2 symlink-overwrite fence).
///
/// The sweep fails CLOSED: it only removes real, non-symlink directories whose
/// name is a valid UUID directly under the canonical root and older than
/// `maxAge`. A same-user process could in principle create a matching path, but
/// the root is inside the user's own private temp hierarchy and the UUID-shape +
/// age + no-symlink checks bound what can be deleted to Claudexor's own copies.
/// Injectable root/fileManager/clock keep it unit-testable without touching the
/// real temp dir or opening an external app.
struct ExternalArtifactHandoff {
    /// The single tracked handoff root; every staged copy is a child of this.
    let root: URL
    let fileManager: FileManager

    init(root: URL, fileManager: FileManager = .default) {
        self.root = root
        self.fileManager = fileManager
    }

    /// The standard owner: `<user temp dir>/claudexor-open`.
    static func standard(fileManager: FileManager = .default) -> ExternalArtifactHandoff {
        ExternalArtifactHandoff(
            root: fileManager.temporaryDirectory.appendingPathComponent("claudexor-open", isDirectory: true),
            fileManager: fileManager)
    }

    /// Stage `data` in a fresh `0700` UUID subdirectory of the tracked root and
    /// return the file URL to hand to the system opener. `suggestedName` is
    /// reduced to a basename with an `artifact` fallback (agent-controlled names
    /// never escape the private dir); the write is atomic.
    func stage(data: Data, suggestedName: String) throws -> URL {
        let base = ((suggestedName as NSString).lastPathComponent as NSString).lastPathComponent
        let safeName = base.isEmpty || base == "." || base == ".." ? "artifact" : base
        // The tracked root is shared across copies; each copy still gets its own
        // private UUID dir so two same-basename artifacts can't overwrite.
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        let dir = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fileManager.createDirectory(
            at: dir, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let url = dir.appendingPathComponent(safeName)
        try data.write(to: url, options: [.atomic])
        return url
    }

    /// Reclaim tracked copies older than `maxAge`. Returns the count removed (for
    /// tests/telemetry). Fails closed on every child that is not a plain
    /// UUID-named, non-symlink directory, or that is not yet past the age bound.
    @discardableResult
    func sweepStale(now: Date = Date(), maxAge: TimeInterval = 24 * 60 * 60) -> Int {
        let keys: [URLResourceKey] = [
            .isDirectoryKey, .isSymbolicLinkKey, .contentModificationDateKey, .creationDateKey,
        ]
        guard let entries = try? fileManager.contentsOfDirectory(
            at: root, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]
        ) else { return 0 }
        var reclaimed = 0
        for entry in entries {
            // Only Claudexor's own UUID-shaped copies are eligible.
            guard UUID(uuidString: entry.lastPathComponent) != nil else { continue }
            let values = try? entry.resourceValues(forKeys: Set(keys))
            guard values?.isSymbolicLink != true, values?.isDirectory == true else { continue }
            let stamp = values?.contentModificationDate ?? values?.creationDate ?? .distantFuture
            guard now.timeIntervalSince(stamp) > maxAge else { continue }
            if (try? fileManager.removeItem(at: entry)) != nil { reclaimed += 1 }
        }
        return reclaimed
    }
}

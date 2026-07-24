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
/// Both paths first prove the shared root itself is safe (`ensureSecureRoot`):
/// the tracked root sits in the world-writable temp hierarchy, so before a copy
/// is written THROUGH it or children are swept FROM it, it must be a real,
/// non-symlink directory owned by the current user (created 0700 if absent, then
/// re-validated to close the create-time TOCTOU). A symlinked or foreign-owned
/// root is refused — `stage` throws, `sweepStale` returns 0 — so a planted
/// symlink can never redirect a private artifact copy or a deletion.
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

    /// A refusal to trust the shared handoff root (fails stage; fails sweep
    /// closed). The root lives in the world-writable temp hierarchy, so before
    /// anything writes a private artifact copy THROUGH it — or sweeps children
    /// FROM it — it must be proven a real, non-symlink directory owned by us.
    enum HandoffError: Error, Equatable {
        case insecureRoot(String)
    }

    init(root: URL, fileManager: FileManager = .default) {
        self.root = root
        self.fileManager = fileManager
    }

    /// Fail-closed validation of the tracked root before any stage/sweep touches
    /// it. `$TMPDIR/claudexor-open` sits in a world-writable hierarchy, so a
    /// planted SYMLINK there would otherwise redirect private artifact copies (or
    /// a sweep's deletions) to an attacker-chosen directory. The root must be a
    /// REAL directory (never a symlink) owned by the current user; it is created
    /// 0700 when absent and RE-VALIDATED afterward to close the create-time TOCTOU
    /// (`createDirectory(withIntermediateDirectories:)` silently SUCCEEDS over a
    /// symlink-to-directory planted between the check and the create).
    private func ensureSecureRoot() throws {
        // lstat-not-stat: `.isSymbolicLinkKey` reads the FINAL path component's
        // OWN type without resolving it — even with `root`'s `isDirectory: true`
        // trailing slash — so a symlinked root is seen as the symlink it is, and
        // its target directory is never inspected or trusted. (A `stat`-following
        // read would report the benign target's type and be defeated.)
        if let values = try? root.resourceValues(forKeys: rootTypeKeys) {
            try assertSecureRoot(values, path: root.path)
            return
        }
        // Absent (or unreadable): create OUR private leaf. The intermediate temp
        // dirs are the OS's; only this leaf is created, at 0700.
        try fileManager.createDirectory(
            at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard let values = try? root.resourceValues(forKeys: rootTypeKeys) else {
            throw HandoffError.insecureRoot("handoff root \(root.path) is unreadable after create")
        }
        try assertSecureRoot(values, path: root.path)
    }

    private let rootTypeKeys: Set<URLResourceKey> = [.isSymbolicLinkKey, .isDirectoryKey]

    /// A root is trustworthy only if it is a plain directory (never a symlink)
    /// owned by the current user. Symlink + directory are lstat-not-follow
    /// `resourceValues`; ownership is a direct `lstat` — both read the leaf
    /// itself, never a symlink's target.
    private func assertSecureRoot(_ values: URLResourceValues, path: String) throws {
        if values.isSymbolicLink == true {
            throw HandoffError.insecureRoot("handoff root \(path) is a symlink")
        }
        guard values.isDirectory == true else {
            throw HandoffError.insecureRoot("handoff root \(path) is not a directory")
        }
        var info = stat()
        guard lstat(path, &info) == 0 else {
            throw HandoffError.insecureRoot("handoff root \(path) ownership is unreadable")
        }
        if info.st_uid != getuid() {
            throw HandoffError.insecureRoot("handoff root \(path) is not owned by the current user")
        }
        // MODE is part of the private-0700 contract (round-3 #7): the per-copy
        // hardening is only as private as the SHARED root above it, yet `ownership`
        // and `is a directory` say nothing about the group/other bits. A
        // pre-existing user-owned 0755 root (created by some other tool, or an
        // umask that widened our own create) would otherwise be accepted and every
        // private artifact copy laid down under a world-readable parent. Repair it
        // to 0700 and RE-lstat; if it is STILL group/other-accessible, fail closed.
        if (info.st_mode & 0o077) != 0 {
            _ = chmod(path, 0o700)
            guard lstat(path, &info) == 0 else {
                throw HandoffError.insecureRoot("handoff root \(path) mode is unreadable after repair")
            }
            if (info.st_mode & 0o077) != 0 {
                throw HandoffError.insecureRoot("handoff root \(path) is group/other-accessible (not private 0700)")
            }
        }
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
        // `lastPathComponent` of "/" is "/", which is neither empty nor "."/".." —
        // guard it too so a bare-slash name can never be appended as the file.
        let safeName = base.isEmpty || base == "." || base == ".." || base == "/" ? "artifact" : base
        // Prove the shared root is a real, user-owned, non-symlink directory
        // (created 0700 if absent) BEFORE writing a private copy through it — a
        // symlinked or foreign-owned root is refused, never followed.
        try ensureSecureRoot()
        // The tracked root is shared across copies; each copy still gets its own
        // private UUID dir so two same-basename artifacts can't overwrite.
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
        // Fail CLOSED: a symlinked / foreign-owned / non-directory root is never
        // enumerated or swept (a planted symlink must not redirect deletions).
        // An absent root is created and yields an empty, harmless sweep.
        guard (try? ensureSecureRoot()) != nil else { return 0 }
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

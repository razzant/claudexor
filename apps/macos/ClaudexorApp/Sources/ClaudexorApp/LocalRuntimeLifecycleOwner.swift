import Darwin
import Foundation

public enum LocalRuntimeLifecycleOperation: Sendable, Equatable {
    case reconciliation
    case installation
    case outageRecovery
}

public struct LocalRuntimeLifecycleLease: Sendable, Equatable {
    fileprivate let id: UUID
    public let operation: LocalRuntimeLifecycleOperation
}

/// Why this app could not use the shared lifecycle lock at all. Unlike
/// contention, a refusal names no other owner and persists until the service
/// directory or its lock file is repaired.
public enum LocalRuntimeLifecycleRefusal: Sendable, Equatable {
    case serviceDirectoryUnavailable(path: String, code: Int32)
    case unsafeServiceDirectory(path: String)
    case unsafeLockFile(path: String)
    case lockUnavailable(path: String, code: Int32)

    /// A clause for the consumer's own sentence; it never claims another owner.
    public var reason: String {
        switch self {
        case let .serviceDirectoryUnavailable(path, code):
            return "the engine service directory \(Self.display(path)) could not be opened or created (\(Self.describe(code)))"
        case let .unsafeServiceDirectory(path):
            return "the engine service directory \(Self.display(path)) is not a private directory owned by this user"
        case let .unsafeLockFile(path):
            return "the engine lifecycle lock \(Self.display(path)) is not a private regular file owned by this user"
        case let .lockUnavailable(path, code):
            return "the engine lifecycle lock \(Self.display(path)) could not be locked (\(Self.describe(code)))"
        }
    }

    private static func display(_ path: String) -> String {
        (path as NSString).abbreviatingWithTildeInPath
    }

    private static func describe(_ code: Int32) -> String {
        // strerror's shared buffer is not safe across concurrent consumers.
        var buffer = [CChar](repeating: 0, count: 256)
        guard strerror_r(code, &buffer, buffer.count) == 0 else { return "error \(code)" }
        return String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }
}

/// The admission decision. Contention is ordinary and retried by its caller;
/// a refusal must surface as its own cause, never as another owner's action.
public enum LocalRuntimeLifecycleClaim: Sendable, Equatable {
    case acquired(LocalRuntimeLifecycleLease)
    /// Another lease or app holds the transaction, or one completed in this app
    /// after the caller's observation. Re-observe before any lifecycle action.
    case contended
    case refused(LocalRuntimeLifecycleRefusal)

    public var lease: LocalRuntimeLifecycleLease? {
        if case let .acquired(lease) = self { return lease }
        return nil
    }
}

/// A process-local completion receipt for observations suspended across another
/// action. Cross-process callers must always re-read discovery after admission.
struct LocalRuntimeLifecycleCompletionSnapshot: Sendable, Equatable {
    fileprivate let sequence: UInt64
}

/// A queued launcher must present this at the actual spawn boundary, after its
/// asynchronous probe. Releasing the exact lease cancels pending spawn work.
public struct LocalRuntimeLaunchPermit: Sendable {
    fileprivate let owner: LocalRuntimeLifecycleOwner
    fileprivate let lease: LocalRuntimeLifecycleLease
    fileprivate let deadline: ContinuousClock.Instant

    public func perform(_ spawn: () -> Bool) -> Bool {
        owner.performLaunch(lease, before: deadline, spawn: spawn)
    }

    /// Returns once a spawn this owner already admitted has finished. Past the
    /// deadline or the lease's release, no later spawn can be admitted either.
    func waitForAdmittedSpawn() {
        owner.waitForAdmittedSpawn()
    }
}

/// Serializes app lifecycle transactions, separately from the daemon's writer
/// authority and the installer's pointer lock. Production supplies the canonical
/// discovery directory; tests default to an in-memory owner with no host I/O.
public final class LocalRuntimeLifecycleOwner: @unchecked Sendable {
    private let lock = NSLock()
    private let serviceRoot: URL?
    private var current: LocalRuntimeLifecycleLease?
    private var completionSequence: UInt64 = 0
    private var descriptor: Int32?

    public init(serviceRoot: URL? = nil) {
        self.serviceRoot = serviceRoot
    }

    deinit { if let descriptor { Self.unlockAndClose(descriptor) } }

    public func claim(_ operation: LocalRuntimeLifecycleOperation) -> LocalRuntimeLifecycleClaim {
        lock.withLock { claimWhileLocked(operation) }
    }

    func completionSnapshot() -> LocalRuntimeLifecycleCompletionSnapshot {
        lock.withLock { LocalRuntimeLifecycleCompletionSnapshot(sequence: completionSequence) }
    }

    func launchPermit(
        for lease: LocalRuntimeLifecycleLease, until deadline: ContinuousClock.Instant
    ) -> LocalRuntimeLaunchPermit {
        LocalRuntimeLaunchPermit(owner: self, lease: lease, deadline: deadline)
    }

    fileprivate func performLaunch(
        _ lease: LocalRuntimeLifecycleLease, before deadline: ContinuousClock.Instant,
        spawn: () -> Bool
    ) -> Bool {
        lock.withLock {
            guard current == lease, ContinuousClock.now < deadline else { return false }
            // Exact release cannot interleave between validation and Process.run.
            return spawn()
        }
    }

    fileprivate func waitForAdmittedSpawn() {
        lock.withLock {}
    }

    func claim(
        _ operation: LocalRuntimeLifecycleOperation,
        ifNoCompletionSince snapshot: LocalRuntimeLifecycleCompletionSnapshot
    ) -> LocalRuntimeLifecycleClaim {
        lock.withLock {
            guard completionSequence == snapshot.sequence else { return .contended }
            return claimWhileLocked(operation)
        }
    }

    public func release(_ lease: LocalRuntimeLifecycleLease) {
        lock.withLock {
            guard current == lease else { return }
            if let descriptor { Self.unlockAndClose(descriptor) }
            descriptor = nil
            current = nil
            completionSequence += 1
        }
    }

    private static func unlockAndClose(_ fd: Int32) {
        // dup/fork references share a flock; close alone waits for every copy
        // to close, including a child that has not reached its CLOEXEC yet.
        flock(fd, LOCK_UN)
        close(fd)
    }

    private func claimWhileLocked(
        _ operation: LocalRuntimeLifecycleOperation
    ) -> LocalRuntimeLifecycleClaim {
        guard current == nil else { return .contended }
        if let serviceRoot {
            switch Self.acquireDescriptor(in: serviceRoot) {
            case let .locked(fd): descriptor = fd
            case .heldElsewhere: return .contended
            case let .refused(refusal): return .refused(refusal)
            }
        }
        let lease = LocalRuntimeLifecycleLease(id: UUID(), operation: operation)
        current = lease
        return .acquired(lease)
    }

    private enum Acquisition {
        case locked(Int32)
        case heldElsewhere
        case refused(LocalRuntimeLifecycleRefusal)
    }

    /// Kept local to lifecycle admission: compare the supplied spelling rather
    /// than rewriting it before the descriptor/inode/owner checks.
    static func hasCanonicalServiceDirectoryPath(_ root: URL) -> Bool {
        // POSIX preserves /private/tmp and /private/var, as the engine's
        // realpathSync.native does; Foundation may strip /private on macOS.
        guard let canonical = realpath(root.path, nil) else { return false }
        defer { free(canonical) }
        return String(cString: canonical) == root.path
    }

    /// Engine-style owned-directory validation/repair, then SecureLocalFile's
    /// no-follow openat and singly linked private regular-file validation. No
    /// file contents or process identity are authority; the inode is never unlinked.
    private static func acquireDescriptor(in root: URL) -> Acquisition {
        let unsafeDirectory = Acquisition.refused(.unsafeServiceDirectory(path: root.path))
        let lockPath = root.appendingPathComponent("lifecycle.lock").path
        let flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        var directoryFD = open(root.path, flags)
        if directoryFD < 0 && errno == ENOENT {
            // First app launch may precede daemon directory creation. Foundation
            // supplies the existing private-directory creation pattern; no custom
            // ancestor walker or writer-lease migration is introduced here.
            do {
                try FileManager.default.createDirectory(
                    at: root, withIntermediateDirectories: true,
                    attributes: [.posixPermissions: 0o700])
            } catch {
                let code = ((error as? CocoaError)?.underlying as? POSIXError)?.code.rawValue ?? EIO
                return .refused(.serviceDirectoryUnavailable(path: root.path, code: code))
            }
            directoryFD = open(root.path, flags)
        }
        guard directoryFD >= 0 else {
            // O_NOFOLLOW and O_DIRECTORY report a symlink or non-directory leaf.
            let code = errno
            return code == ELOOP || code == ENOTDIR
                ? unsafeDirectory
                : .refused(.serviceDirectoryUnavailable(path: root.path, code: code))
        }
        defer { close(directoryFD) }
        var directory = stat()
        var named = stat()
        guard fstat(directoryFD, &directory) == 0,
              directory.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
              directory.st_uid == geteuid(),
              lstat(root.path, &named) == 0,
              named.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
              directory.st_dev == named.st_dev, directory.st_ino == named.st_ino,
              hasCanonicalServiceDirectoryPath(root)
        else { return unsafeDirectory }
        // Match the engine's owned-directory admission: prove canonical inode
        // and uid first, then repair permissions through that same descriptor.
        if directory.st_mode & 0o777 != 0o700 {
            guard fchmod(directoryFD, 0o700) == 0 else { return unsafeDirectory }
        }
        guard fstat(directoryFD, &directory) == 0,
              directory.st_mode & 0o777 == 0o700
        else { return unsafeDirectory }
        let fd = openat(directoryFD, "lifecycle.lock",
            O_CREAT | O_RDWR | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else {
            let code = errno
            return code == ELOOP || code == EISDIR
                ? .refused(.unsafeLockFile(path: lockPath))
                : .refused(.lockUnavailable(path: lockPath, code: code))
        }
        var file = stat()
        guard fstat(fd, &file) == 0,
              file.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              file.st_uid == geteuid(), file.st_nlink == 1,
              file.st_mode & 0o777 == 0o600
        else { close(fd); return .refused(.unsafeLockFile(path: lockPath)) }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            // Only the nonblocking lock's own conflict means another owner.
            let code = errno
            close(fd)
            return code == EWOULDBLOCK
                ? .heldElsewhere
                : .refused(.lockUnavailable(path: lockPath, code: code))
        }
        return .locked(fd)
    }
}

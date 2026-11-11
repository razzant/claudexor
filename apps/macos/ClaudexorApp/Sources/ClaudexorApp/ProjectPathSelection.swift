import ClaudexorKit
import Darwin
import Foundation

enum ProjectCheckoutStatus: Equatable, Sendable {
    /// Inside the checkout that holds the repository's own metadata (a clone or `git init`
    /// folder, also with a separate Git directory). Not the main branch.
    case primaryCheckout
    /// Inside a registered linked worktree; the value is that worktree's root folder name.
    case linkedWorktree(String)
    case ordinaryFolder
    case unavailable
}

/// Presentation only: this never resolves a run's execution address or changes selection.
/// Checkout topology is hover and accessibility text; it never changes the chip's glyph or tint.
struct ProjectCheckoutPresentation {
    let name: String
    /// The checkout line and the selected full path; empty when no project is selected.
    let help: String
    private let actionHelp: String

    var chipHelp: String { help.isEmpty ? actionHelp : help + "\n\n" + actionHelp }
    var accessibilityValue: String { help.isEmpty ? name : name + "\n" + help }

    init(
        context: ComposerSelectionContext, observedContext: ComposerSelectionContext?, status: ProjectCheckoutStatus?,
        metadataKnown: Bool = true, recent: [String] = [], connectionName: String? = nil
    ) {
        let path = context.repoRoot
        actionHelp = context.threadID != nil
            ? "Project for this thread (bound). Pick another to start a new thread there."
            : "Project for the new thread — pick a recent project or Browse…"
        if context.threadID != nil && !metadataKnown {
            name = "Project unavailable"
            help = "Project metadata unavailable"
        } else if path.isEmpty {
            if context.threadID != nil, let connectionName {
                name = "\(connectionName) · No project"
            } else {
                name = context.threadID == nil ? "Choose project" : "No project"
            }
            help = ""
        } else {
            let folder = ProjectPathSelection.recentProjectLabel(path, among: recent)
            name = connectionName.map { "\($0) · \(folder)" } ?? folder
            help = Self.checkoutLine(context: context, observedContext: observedContext, status: status) + "\n" + path
        }
    }

    /// Names the selected folder's Git role; a nested folder is "in" its checkout, not its root.
    /// It never names the main branch or where a thread executes.
    private static func checkoutLine(
        context: ComposerSelectionContext, observedContext: ComposerSelectionContext?, status: ProjectCheckoutStatus?
    ) -> String {
        guard context.locationID == ExecutionLocationID.local.rawValue else {
            return "Git checkout status unavailable on remote host"
        }
        if observedContext == nil, status == nil { return "Checking Git checkout…" }
        guard observedContext == context, let status else { return "Git checkout status unavailable" }
        switch status {
        case .primaryCheckout: return "In a primary Git checkout"
        case .linkedWorktree(let root): return "In the linked Git worktree “\(root)”"
        case .ordinaryFolder: return "Not in a Git checkout"
        case .unavailable: return "Git checkout status unavailable"
        }
    }
}

enum ProjectPathSelection {
    /// Lexical only: remote names must not expand against this machine's home/cwd.
    static func recentProjectLabel(_ path: String, among recent: [String]) -> String {
        let components = pathComponents(path)
        let name = components.last ?? path
        let collisions = Set((recent + [path]).map(pathComponents).filter { $0.last == name })
        guard collisions.count > 1 else { return name }
        let parents = Array(components.dropLast())
        for depth in 1...max(1, parents.count) {
            let suffix = Array(parents.suffix(depth))
            if collisions.filter({ $0 != components }).allSatisfy({
                Array($0.dropLast().suffix(depth)) != suffix
            }) {
                let label = suffix.first == "/"
                    ? "/" + suffix.dropFirst().joined(separator: "/")
                    : suffix.joined(separator: "/")
                return "\(name) — \(label.isEmpty ? "." : label)"
            }
        }
        return name
    }

    private static func pathComponents(_ path: String) -> [String] {
        var result: [String] = path.hasPrefix("/") ? ["/"] : []
        for part in path.split(separator: "/").map(String.init) {
            if part == "." { continue }
            if part == "..", let last = result.last, last != ".." {
                if last != "/" { result.removeLast() }
            } else {
                result.append(part)
            }
        }
        return result
    }

    /// The optional boundary confines fixture ancestor discovery; production searches to /.
    /// No Git process, config, registry, initialization or write is involved.
    static func checkoutStatus(
        for path: String, isLocal: Bool, searchBoundary: String = "/"
    ) -> ProjectCheckoutStatus {
        guard isLocal, path.hasPrefix("/"), !Task.isCancelled else { return .unavailable }
        var current = URL(fileURLWithPath: path, isDirectory: true).resolvingSymlinksInPath().standardizedFileURL
        let boundary = URL(fileURLWithPath: searchBoundary, isDirectory: true)
            .resolvingSymlinksInPath().standardizedFileURL
        guard isDirectory(current), boundary.path == "/" || current == boundary
                || current.path.hasPrefix(boundary.path + "/") else { return .unavailable }
        while !Task.isCancelled {
            let marker = current.appendingPathComponent(".git")
            do {
                let attributes = try FileManager.default.attributesOfItem(atPath: marker.path)
                let admin: URL
                switch attributes[.type] as? FileAttributeType {
                case .typeDirectory:
                    admin = marker.resolvingSymlinksInPath()
                case .typeRegular:
                    guard let text = metadataText(marker), text.hasPrefix("gitdir: "),
                          let target = metadataPath(String(text.dropFirst(8)), relativeTo: current)
                    else { return .unavailable }
                    admin = target
                default:
                    return .unavailable
                }
                return gitStatus(admin: admin, marker: marker, checkout: current)
            } catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile {
                // No marker here; a selected subdirectory can belong to an ancestor checkout.
            } catch {
                return .unavailable
            }
            if current == boundary || current.path == "/" { return .ordinaryFolder }
            current.deleteLastPathComponent()
        }
        return .unavailable
    }

    private static func gitStatus(admin: URL, marker: URL, checkout: URL) -> ProjectCheckoutStatus {
        let commonPointer = admin.appendingPathComponent("commondir")
        do {
            _ = try FileManager.default.attributesOfItem(atPath: commonPointer.path)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile {
            return isRepository(admin) ? .primaryCheckout : .unavailable
        } catch {
            return .unavailable
        }
        guard let commonText = metadataText(commonPointer),
              let common = metadataPath(commonText, relativeTo: admin), common.path != admin.path,
              admin.deletingLastPathComponent().path == common.appendingPathComponent("worktrees", isDirectory: true)
                .resolvingSymlinksInPath().path,
              let backlinkText = metadataText(admin.appendingPathComponent("gitdir")),
              let backlink = metadataPath(backlinkText, relativeTo: admin),
              backlink.path == marker.resolvingSymlinksInPath().path,
              isRepository(common), hasValidHead(admin)
        else { return .unavailable }
        return .linkedWorktree(checkout.lastPathComponent)
    }

    private static func isRepository(_ directory: URL) -> Bool {
        isDirectory(directory.appendingPathComponent("objects"))
            && isDirectory(directory.appendingPathComponent("refs"))
            && hasValidHead(directory)
    }

    /// Git's own repository-discovery rule for HEAD: a `ref:` into `refs/` (an unborn branch need
    /// not resolve, and the reftable format's `refs/heads/.invalid` placeholder qualifies) or a
    /// detached 40/64-hex object id. Unlike Git, the value must be one token on one line.
    private static func hasValidHead(_ directory: URL) -> Bool {
        guard let head = metadataText(directory.appendingPathComponent("HEAD")) else { return false }
        if head.hasPrefix("ref:") {
            let reference = head.dropFirst(4).trimmingCharacters(in: .whitespaces)
            return reference.hasPrefix("refs/") && reference.utf8.allSatisfy { $0 > 32 && $0 != 127 }
        }
        return (head.utf8.count == 40 || head.utf8.count == 64) && head.utf8.allSatisfy {
            (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0)
        }
    }

    private static func isDirectory(_ directory: URL) -> Bool {
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory) && isDirectory.boolValue
    }

    private static func metadataPath(_ text: String, relativeTo directory: URL) -> URL? {
        guard !text.isEmpty, !text.contains("\0"), !text.contains("\n"), !text.contains("\r") else { return nil }
        let path = text.hasPrefix("/") ? text : directory.path + "/" + text
        return URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL
    }

    /// A regular-file, no-follow, bounded read; malformed pointers cannot open a device/FIFO.
    private static func metadataText(_ file: URL) -> String? {
        guard !Task.isCancelled else { return nil }
        let descriptor = open(file.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard descriptor >= 0 else { return nil }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              info.st_size > 0, info.st_size <= 8192,
              let data = try? handle.read(upToCount: 8193), data.count <= 8192,
              let text = String(data: data, encoding: .utf8)
        else { return nil }
        var value = text
        while value.last?.isNewline == true { value.removeLast() }
        return value.isEmpty ? nil : value
    }
}

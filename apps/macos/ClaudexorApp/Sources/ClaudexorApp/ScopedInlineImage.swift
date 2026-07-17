import SwiftUI
import AppKit
import ImageIO

/// Inline preview of an agent-produced image (Ф2.5 W-C7, the "он не смог мне
/// скриншот прислать" fix). SECURITY SCOPE: only files inside the thread's
/// repoRoot or the run's directory render — canonical (symlink-resolved)
/// paths, prefix-checked with a path-boundary, image extensions only. Out of
/// scope degrades to the visible markdown text plus a DISCLOSED refusal
/// caption, never a silent blank. Loading is bounded: a CGImageSource
/// thumbnail (max 1200px), source files over 64MB refused, decoded previews
/// pooled in a byte-costed cache (the W23 memory class).
struct ScopedInlineImage: View {
    let target: String
    let alt: String
    let roots: [String]

    /// Decode result, produced OFF the main actor (sol #13): a crafted
    /// compressed image must not stall the chat UI from `body` evaluation.
    private enum Load { case loading, ready(NSImage, String), failed, outOfScope }
    @State private var load: Load = .loading

    /// Off-main handoff of an already-bounded decode. NSImage is read-only
    /// here; the box makes the actor crossing explicit for Swift 6.
    private struct Decoded: @unchecked Sendable {
        enum Kind { case ready, failed, outOfScope }
        let kind: Kind
        let image: NSImage?
        let path: String?
    }

    var body: some View {
        content
            .task(id: target + "|" + roots.joined(separator: ":")) {
                // A new (target, roots) resets to loading so a prior image is
                // never shown for the new identity (confirm #4).
                load = .loading
                // Scope resolution + metadata + thumbnail decode all run off the
                // main actor; only the bounded result publishes back.
                let t = target, r = roots
                let decoded: Decoded = await Task.detached(priority: .userInitiated) {
                    guard let path = Self.scopedImagePath(t, roots: r) else {
                        return Decoded(kind: .outOfScope, image: nil, path: nil)
                    }
                    guard let image = Self.boundedPreview(path) else {
                        return Decoded(kind: .failed, image: nil, path: nil)
                    }
                    return Decoded(kind: .ready, image: image, path: path)
                }.value
                // The detached decode does NOT inherit `.task(id:)` cancellation
                // — a stale slow decode must not overwrite a newer one (confirm
                // #4), so publish only if this task is still current.
                if Task.isCancelled { return }
                switch decoded.kind {
                case .ready: load = .ready(decoded.image!, decoded.path!)
                case .failed: load = .failed
                case .outOfScope: load = .outOfScope
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch load {
        case .loading:
            ProgressView().controlSize(.small)
                .frame(maxWidth: 560, alignment: .leading)
        case .ready(let image, let path):
            Image(nsImage: image)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: 560, maxHeight: 340, alignment: .leading)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.control))
                .onTapGesture { NSWorkspace.shared.open(URL(fileURLWithPath: path)) }
                .help(alt.isEmpty ? path : "\(alt) — \(path). Click to open.")
                .accessibilityLabel(alt.isEmpty ? "agent image" : alt)
        case .failed:
            refusal("image could not be decoded (or exceeds the preview size bound)")
        case .outOfScope:
            refusal("image path is outside this thread's scope, so it is not rendered")
        }
    }

    @ViewBuilder
    private func refusal(_ reason: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("![\(alt)](\(target))")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            Label(reason, systemImage: "eye.slash")
                .font(.caption2).foregroundStyle(.tertiary)
        }
    }

    /// The canonical on-disk path IF the target is an image inside one of the
    /// allowed roots; nil otherwise. Pure given a filesystem — unit-tested
    /// with real symlink/traversal fixtures.
    nonisolated static func scopedImagePath(_ target: String, roots: [String]) -> String? {
        guard let path = scopedFilePath(target, roots: roots),
              imageExtensions.contains(URL(fileURLWithPath: path).pathExtension.lowercased())
        else { return nil }
        return path
    }

    /// Scope resolution for ANY agent-produced file (image previews narrow it
    /// further by extension): absolute local targets only, canonicalized on
    /// BOTH sides — a symlink inside a root must not escape it, and `..`
    /// segments must not sneak past a plain prefix check.
    nonisolated static func scopedFilePath(_ target: String, roots: [String]) -> String? {
        guard !roots.isEmpty else { return nil }
        var raw = target
        if raw.hasPrefix("file://") { raw = String(raw.dropFirst("file://".count)) }
        guard raw.hasPrefix("/") else { return nil }   // relative/remote: never resolved
        let canonical = URL(fileURLWithPath: raw).resolvingSymlinksInPath().standardizedFileURL.path
        guard FileManager.default.fileExists(atPath: canonical) else { return nil }
        for root in roots {
            let canonicalRoot = URL(fileURLWithPath: root).resolvingSymlinksInPath().standardizedFileURL.path
            if canonical == canonicalRoot { continue }  // a root itself is not a product
            if canonical.hasPrefix(canonicalRoot.hasSuffix("/") ? canonicalRoot : canonicalRoot + "/") {
                return canonical
            }
        }
        return nil
    }

    nonisolated static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "tiff", "bmp"]

    /// Documents/images safe to hand to `NSWorkspace.open` directly. Being
    /// inside repoRoot does NOT make agent output trusted — a `.command` /
    /// `.app` / `.sh` link would launch agent-produced CODE on click (sol #11),
    /// so opening is allowed ONLY for this allowlist; anything else is refused
    /// (reveal-in-Finder stays a safe manual fallback). ACTIVE formats that
    /// execute in the default handler — .html/.htm/.svg run JavaScript in the
    /// browser — are deliberately EXCLUDED (confirm #3).
    nonisolated static let openableExtensions: Set<String> = imageExtensions.union([
        "txt", "md", "markdown", "json", "yaml", "yml", "csv", "log",
        "pdf", "rtf", "xml", "toml",
    ])

    /// Decide how a scoped file-link click resolves: `.open` for an in-scope
    /// SAFE-type file, else `.refuse(reason)` — never a silent no-op. Pure
    /// (given the FS) so the policy is unit-tested.
    enum OpenDecision: Equatable { case open(String); case refuse(String) }
    nonisolated static func openDecision(_ target: String, roots: [String]) -> OpenDecision {
        guard let path = scopedFilePath(target, roots: roots) else {
            return .refuse("outside this thread's scope")
        }
        let ext = URL(fileURLWithPath: path).pathExtension.lowercased()
        guard openableExtensions.contains(ext) else {
            return .refuse("unsafe file type “.\(ext)” — reveal it in Finder instead")
        }
        return .open(path)
    }
    /// Refuse absurd source files outright (a 2GB "png" is not a chat preview).
    nonisolated static let maxSourceBytes = 64 * 1024 * 1024
    nonisolated static let maxThumbnailPixels = 1_200

    final class ImageBox { let image: NSImage; init(_ i: NSImage) { image = i } }
    nonisolated(unsafe) private static let previewCache: NSCache<NSString, ImageBox> = {
        // Byte-costed (W23 class): decoded previews must not pool unbounded.
        let c = NSCache<NSString, ImageBox>(); c.countLimit = 64
        c.totalCostLimit = 64 * 1024 * 1024
        return c
    }()

    /// Downsampled preview via CGImageSource — never a full-resolution decode
    /// of an arbitrary agent-produced file on the main thread.
    nonisolated static func boundedPreview(_ path: String) -> NSImage? {
        let attrs = try? FileManager.default.attributesOfItem(atPath: path)
        // Cache key includes size + mtime so an agent OVERWRITING a screenshot
        // at the same path invalidates the stale preview (review sol #15).
        let size = (attrs?[.size] as? Int) ?? -1
        let mtime = (attrs?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? -1
        let key = "\(path)|\(size)|\(mtime)" as NSString
        if let hit = previewCache.object(forKey: key) { return hit.image }
        if size > maxSourceBytes { return nil }
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil)
        else { return nil }
        return cachedThumbnail(source: source, key: key)
    }

    /// The same bounded decode for ALREADY-FETCHED bytes (artifact gallery,
    /// W3.7): identical thumbnail bound and byte-costed cache — a gallery of
    /// full-resolution screenshots must not decode unbounded on the main
    /// actor. `cacheKey` carries the caller's identity (run + path); the byte
    /// count disambiguates a re-produced artifact at the same path.
    nonisolated static func boundedPreview(data: Data, cacheKey: String) -> NSImage? {
        let key = "data|\(cacheKey)|\(data.count)" as NSString
        if let hit = previewCache.object(forKey: key) { return hit.image }
        if data.count > maxSourceBytes { return nil }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return cachedThumbnail(source: source, key: key)
    }

    /// One owner of the thumbnail bound + cache insert for both source kinds.
    private nonisolated static func cachedThumbnail(source: CGImageSource, key: NSString) -> NSImage? {
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maxThumbnailPixels,
            kCGImageSourceCreateThumbnailWithTransform: true,
        ] as CFDictionary)
        else { return nil }
        let image = NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
        previewCache.setObject(ImageBox(image), forKey: key, cost: cg.bytesPerRow * cg.height)
        return image
    }
}

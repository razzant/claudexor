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

    var body: some View {
        if let path = Self.scopedImagePath(target, roots: roots) {
            if let image = Self.boundedPreview(path) {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: 560, maxHeight: 340, alignment: .leading)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.control))
                    .onTapGesture { NSWorkspace.shared.open(URL(fileURLWithPath: path)) }
                    .help(alt.isEmpty ? path : "\(alt) — \(path). Click to open.")
                    .accessibilityLabel(alt.isEmpty ? "agent image" : alt)
            } else {
                refusal("image could not be decoded (or exceeds the preview size bound)")
            }
        } else {
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
    static func scopedImagePath(_ target: String, roots: [String]) -> String? {
        guard let path = scopedFilePath(target, roots: roots),
              imageExtensions.contains(URL(fileURLWithPath: path).pathExtension.lowercased())
        else { return nil }
        return path
    }

    /// Scope resolution for ANY agent-produced file (image previews narrow it
    /// further by extension): absolute local targets only, canonicalized on
    /// BOTH sides — a symlink inside a root must not escape it, and `..`
    /// segments must not sneak past a plain prefix check.
    static func scopedFilePath(_ target: String, roots: [String]) -> String? {
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

    private static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "tiff", "bmp"]
    /// Refuse absurd source files outright (a 2GB "png" is not a chat preview).
    private static let maxSourceBytes = 64 * 1024 * 1024
    private static let maxThumbnailPixels = 1_200

    private final class ImageBox { let image: NSImage; init(_ i: NSImage) { image = i } }
    private static let previewCache: NSCache<NSString, ImageBox> = {
        // Byte-costed (W23 class): decoded previews must not pool unbounded.
        let c = NSCache<NSString, ImageBox>(); c.countLimit = 64
        c.totalCostLimit = 64 * 1024 * 1024
        return c
    }()

    /// Downsampled preview via CGImageSource — never a full-resolution decode
    /// of an arbitrary agent-produced file on the main thread.
    static func boundedPreview(_ path: String) -> NSImage? {
        let key = path as NSString
        if let hit = previewCache.object(forKey: key) { return hit.image }
        let attrs = try? FileManager.default.attributesOfItem(atPath: path)
        if let bytes = attrs?[.size] as? Int, bytes > maxSourceBytes { return nil }
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, [
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

import SwiftUI
import AppKit
import ClaudexorKit
import UniformTypeIdentifiers

// MARK: - Composer attachments (files / images / screen capture)
//
// Extracted from `ThreadsScreen.swift` (INV-124 readability ratchet): staging,
// gating, and capture of composer attachments. Pure move — zero behavior change.

extension ThreadsScreen {
    // MARK: - Composer attachments (D)

    /// True when the current route is both available for this intent and declares
    /// image input. Best-of is pool-wide: every available raced harness must accept
    /// images because each candidate receives the same attachment set.
    var primaryAcceptsImages: Bool {
        let configuredPool = resolvedPoolFamilies.isEmpty ? poolFamilies : resolvedPoolFamilies
        let availablePool = configuredPool.filter { family in
            model.availability(for: family, mode: composerMode).available
        }
        if composerMode == .bestOfN {
            guard !availablePool.isEmpty else { return false }
            return availablePool.allSatisfy { model.harnessInfo(for: $0)?.acceptsImages == true }
        }
        if let primary = primaryFamily {
            return model.availability(for: primary, mode: composerMode).available &&
                model.harnessInfo(for: primary)?.acceptsImages == true
        }
        // No resolved primary: the engine auto-pools and may route to ANY harness
        // in the effective eligible pool, so only offer attach when EVERY routable
        // harness can take images — otherwise the image would be silently dropped
        // on whichever non-vision harness the pool picks.
        guard !availablePool.isEmpty else { return false }
        return availablePool.allSatisfy { model.harnessInfo(for: $0)?.acceptsImages == true }
    }

    /// File attachments ride the shared turn DTO for every intent; image
    /// attachments still require a vision-capable route so the engine will not
    /// silently drop them.
    var fileAttachmentsAllowed: Bool { true }
    var imageAttachmentsAllowed: Bool { primaryAcceptsImages }

    var attachButton: some View {
        Button { pickAttachments() } label: {
            Image(systemName: "paperclip")
                .imageScale(.medium)
                .foregroundStyle(fileAttachmentsAllowed ? Color.secondary : Color.secondary.opacity(0.4))
                .padding(.horizontal, Theme.Spacing.xs)
                .padding(.vertical, Theme.Controls.chipVPadding)
        }
        .buttonStyle(.borderless)
        .disabled(!fileAttachmentsAllowed)
        // QA-003: an icon-only control needs an explicit, locale-independent
        // English NAME — otherwise the AX name falls back to the host-localized
        // `paperclip` SF Symbol description (`Вложенные Файлы`). `.help` stays the
        // separate consequence hint.
        .accessibilityLabel("Attach files")
        .help(attachButtonHelp)
    }

    private var attachButtonHelp: String {
        return primaryAcceptsImages
            ? "Attach files or images"
            : "Attach files; images need an available vision-capable route"
    }

    var attachmentChips: some View {
        HStack(spacing: Theme.Spacing.xs) {
            ForEach(composerAttachments) { att in
                HStack(spacing: 4) {
                    Image(systemName: att.kind == "image" ? "photo" : "doc")
                    Text(att.name).lineLimit(1).truncationMode(.middle)
                    Button { composerAttachments.removeAll { $0.id == att.id } } label: {
                        Image(systemName: "xmark.circle.fill")
                    }
                    .buttonStyle(.borderless)
                    // QA-003: name the icon-only remove control (else the AX name
                    // is the localized `xmark.circle.fill` description).
                    .accessibilityLabel("Remove attachment")
                    .help("Remove \(att.name)")
                }
                .font(.caption)
                .padding(.horizontal, Theme.Spacing.sm)
                .padding(.vertical, 4)
                .background(Color.primary.opacity(0.08), in: Capsule())
            }
        }
    }

    /// Pick files via NSOpenPanel and stage their bytes outside the main actor.
    /// AppModel uploads and finalizes them before the turn sends resource ids.
    private func pickAttachments() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        guard panel.runModal() == .OK else { return }
        let urls = panel.urls
        let acceptsImages = primaryAcceptsImages
        Task {
            let loaded = await Task.detached(priority: .userInitiated) { () -> (attachments: [PendingAttachment], skippedImages: Int) in
                var attachments: [PendingAttachment] = []
                var skippedImages = 0
                for url in urls {
                    guard let data = try? Data(contentsOf: url) else { continue }
                    let mime = Self.mimeType(for: url)
                    let isImage = mime.hasPrefix("image/")
                    if isImage && !acceptsImages {
                        skippedImages += 1
                        continue
                    }
                    attachments.append(PendingAttachment(
                        kind: isImage ? "image" : "file", mime: mime, name: url.lastPathComponent,
                        data: data))
                }
                return (attachments, skippedImages)
            }.value
            composerAttachments.append(contentsOf: loaded.attachments)
            if loaded.skippedImages > 0 {
                model.threadStatus = loaded.skippedImages == 1
                    ? "Image skipped — switch to a vision-capable primary harness to attach it."
                    : "\(loaded.skippedImages) images skipped — switch to a vision-capable primary harness to attach them."
            }
        }
    }

    nonisolated private static func mimeType(for url: URL) -> String {
        if let t = UTType(filenameExtension: url.pathExtension), let m = t.preferredMIMEType { return m }
        return "application/octet-stream"
    }

    var captureButton: some View {
        Button { captureScreenshot() } label: {
            Image(systemName: "camera.viewfinder")
                .imageScale(.medium)
                .foregroundStyle(imageAttachmentsAllowed ? Color.secondary : Color.secondary.opacity(0.4))
                .padding(.horizontal, Theme.Spacing.xs)
                .padding(.vertical, Theme.Controls.chipVPadding)
        }
        .buttonStyle(.borderless)
        .disabled(!imageAttachmentsAllowed)
        // QA-003: stable English name for the icon-only capture control. A
        // disabled capture keeps its NAME and separately announces the vision-
        // capability reason via `.help` (the acceptance-criteria case).
        .accessibilityLabel("Capture screen region")
        .help(captureButtonHelp)
    }

    private var captureButtonHelp: String {
        return primaryAcceptsImages
            ? "Capture a screen region to attach (you pick the area)"
            : "Screen captures need an available vision-capable route"
    }

    /// Grab a screen region via the system `screencapture` (interactive crosshair),
    /// off the main thread so the UI doesn't freeze during selection. macOS gates
    /// this behind Screen Recording permission; a denied/cancelled grab yields no
    /// attachment (honest — never a blank/fake image).
    private func captureScreenshot() {
        Task { @MainActor in
            if let att = await Self.runScreencapture() {
                composerAttachments.append(att)
            }
        }
    }

    private static func runScreencapture() async -> PendingAttachment? {
        await withCheckedContinuation { (cont: CheckedContinuation<PendingAttachment?, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                let tmp = FileManager.default.temporaryDirectory
                    .appendingPathComponent("claudexor-shot-\(UUID().uuidString).png")
                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
                proc.arguments = ["-i", "-x", tmp.path] // interactive region select, silent
                do { try proc.run(); proc.waitUntilExit() }
                catch { cont.resume(returning: nil); return }
                guard let data = try? Data(contentsOf: tmp), !data.isEmpty else {
                    cont.resume(returning: nil); return // cancelled or permission denied
                }
                try? FileManager.default.removeItem(at: tmp)
                cont.resume(returning: PendingAttachment(
                    kind: "image", mime: "image/png", name: "screenshot.png",
                    data: data))
            }
        }
    }
}

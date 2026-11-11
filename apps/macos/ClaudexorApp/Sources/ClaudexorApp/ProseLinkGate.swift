import AppKit
import SwiftUI

/// Shared by native text delegates and SwiftUI table cells. File targets never
/// reach a system opener; the existing scope and safe-preview policy owns them.
@MainActor struct ProseLinkGate {
    var model: AppModel?
    var roots: [String] = []
    var remoteScope: RemoteFileScope?
    var notice: (String?) -> Void = { _ in }
    var preview: (SafeFilePreviewRequest) -> Void = { _ in }
    var openSystem: (URL) -> Void = { NSWorkspace.shared.open($0) }

    func handle(_ url: URL) {
        let raw: String
        switch MarkdownOutputView.linkRoute(for: url) {
        case .system: openSystem(url); return
        case .scoped(let target): raw = target
        }
        guard let model else {
            notice("Link not opened: preview context is unavailable.")
            return
        }
        if model.selectedExecutionLocation != .local {
            if model.remoteProjectFileReference(target: raw, scope: remoteScope) != nil {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(raw, forType: .string)
                notice("Remote path copied. Files stay on the server; images and gallery artifacts load through the scoped SSH tunnel.")
            } else {
                notice("Remote link not opened: outside this thread's project scope.")
                NSSound.beep()
            }
            return
        }
        switch MarkdownOutputView.localFileAction(raw, roots: roots) {
        case .preview(let path, let kind):
            Task {
                do {
                    preview(try await .scopedLocalFile(url: URL(fileURLWithPath: path), roots: roots, kind: kind))
                    notice(nil)
                } catch {
                    notice("Link not opened: the file changed or could not be staged safely.")
                }
            }
        case .reveal(let path):
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
            notice(nil)
        case .refuse(let reason):
            notice(MarkdownOutputView.refusalNotice(reason))
            NSSound.beep()
        }
    }
}

private struct ProseLinkGateKey: EnvironmentKey {
    static let defaultValue: ProseLinkGate? = nil
}

extension EnvironmentValues {
    var proseLinkGate: ProseLinkGate? {
        get { self[ProseLinkGateKey.self] }
        set { self[ProseLinkGateKey.self] = newValue }
    }
}

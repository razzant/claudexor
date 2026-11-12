import ClaudexorKit
import SwiftUI

/// #146: one composer line when an attached image goes to a model whose live
/// catalog declares input modalities without image. Unknown metadata says
/// nothing, and the note never blocks: the engine sends the image unchanged and
/// the provider decides.
enum ComposerImageInputNote {
    struct Lane: Equatable {
        let model: String
        let modalities: [String]
    }

    /// The lane for one harness: its selected model's catalog row, when that row
    /// declares modalities and none is an image. A declared routing variant
    /// (`m:nitro`) reads its listed row from the same response. No selection, no
    /// cached catalog or no matching row = unknown = no lane.
    static func textOnlyLane(selectedModel: String?, catalog: HarnessModelsResponse?) -> Lane? {
        let model = (selectedModel ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !model.isEmpty,
              let row = catalog?.row(forModel: model),
              row.catalogDeclaresNoImageInput,
              let modalities = row.inputModalities
        else { return nil }
        return Lane(model: model, modalities: modalities)
    }

    static func message(attachmentKinds: [String], lanes: [Lane]) -> String? {
        guard attachmentKinds.contains("image"), !lanes.isEmpty else { return nil }
        let models = lanes
            .map { "\($0.model) (input: \($0.modalities.joined(separator: ", ")))" }
            .joined(separator: "; ")
        return "The catalog lists no image input for \(models). The image is still sent; the provider decides."
    }
}

/// The note's line: the caution colour stays on the glyph, the words stay
/// secondary like the composer's other notices.
struct ComposerImageInputNoteView: View {
    let message: String

    var body: some View {
        Label {
            Text(message).foregroundStyle(.secondary)
        } icon: {
            Image(systemName: "photo").foregroundStyle(Theme.status(.caution))
        }
        .font(.caption2)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    }
}

import ClaudexorKit
import Foundation

struct PendingAttachment: Identifiable, Equatable, Sendable {
    let id = UUID()
    let kind: String
    let mime: String
    let name: String
    let data: Data
}

extension AppModel {
    static func acceptsImages(manifest: JSONValue?) -> Bool {
        guard case .array(let inputs) = manifest?["capability_profile"]?["attachment_inputs"] else {
            return false
        }
        return inputs.contains { input in
            guard input["kind"]?.stringValue == "image",
                  let maxBytes = input["max_bytes"]?.doubleValue, maxBytes > 0, maxBytes.isFinite,
                  let maxCount = input["max_count"]?.doubleValue, maxCount > 0, maxCount.isFinite,
                  input["transport"]?.stringValue != nil,
                  case .array(let mimeTypes) = input["mime_types"] else {
                return false
            }
            return mimeTypes.contains { $0.stringValue?.isEmpty == false }
        }
    }

    func uploadAttachments(
        _ attachments: [PendingAttachment],
        client: GatewayClient
    ) async throws -> [ResourceAttachmentRef] {
        var references: [ResourceAttachmentRef] = []
        for attachment in attachments {
            references.append(try await client.uploadResource(
                kind: attachment.kind,
                mime: attachment.mime,
                name: attachment.name,
                data: attachment.data
            ))
        }
        return references
    }
}

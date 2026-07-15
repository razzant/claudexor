import CryptoKit
import Foundation

extension GatewayClient {
    /// Upload immutable bytes through the v2 resource pipeline and return the
    /// only attachment shape accepted by run/turn requests.
    public func uploadResource(
        kind: String,
        mime: String,
        name: String,
        data: Data
    ) async throws -> ResourceAttachmentRef {
        var create = request("uploads", method: "POST")
        create.setValue("application/json", forHTTPHeaderField: "Content-Type")
        create.httpBody = try Self.encoder.encode(UploadCreateRequest(
            kind: kind, mime: mime, name: name, sizeBytes: data.count
        ))
        let (createData, createResponse) = try await session.data(for: create)
        guard let createHTTP = createResponse as? HTTPURLResponse, createHTTP.statusCode == 201 else {
            let status = (createResponse as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: createData, as: UTF8.self))
        }
        let upload = try Self.decoder.decode(UploadStatus.self, from: createData)

        var bytes = request("uploads/\(upload.uploadId)/bytes", method: "PUT")
        bytes.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        bytes.httpBody = data
        let (bytesData, bytesResponse) = try await session.data(for: bytes)
        guard let bytesHTTP = bytesResponse as? HTTPURLResponse, bytesHTTP.statusCode == 200 else {
            let status = (bytesResponse as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: bytesData, as: UTF8.self))
        }

        let digest = "sha256:" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        var finalize = request("uploads/\(upload.uploadId)/finalize", method: "POST")
        finalize.setValue("application/json", forHTTPHeaderField: "Content-Type")
        finalize.httpBody = try Self.encoder.encode(UploadFinalizeRequest(expectedSha256: digest))
        let (finalData, finalResponse) = try await session.data(for: finalize)
        guard let finalHTTP = finalResponse as? HTTPURLResponse, finalHTTP.statusCode == 201 else {
            let status = (finalResponse as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: finalData, as: UTF8.self))
        }
        let resource = try Self.decoder.decode(UploadedResource.self, from: finalData)
        return ResourceAttachmentRef(resourceId: resource.resourceId)
    }
}

private struct UploadCreateRequest: Encodable {
    let kind: String
    let mime: String
    let name: String
    let sizeBytes: Int
}

private struct UploadStatus: Decodable {
    let uploadId: String
}

private struct UploadFinalizeRequest: Encodable {
    let expectedSha256: String
}

private struct UploadedResource: Decodable {
    let resourceId: String
}

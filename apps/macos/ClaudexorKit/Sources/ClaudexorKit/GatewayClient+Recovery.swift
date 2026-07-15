import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public extension GatewayClient {
    func inspectJournal(partition: String) async throws -> JournalInspection {
        try await recoveryRequest(partition: partition, suffix: "", method: "GET", body: Optional<JournalQuarantineRequest>.none, as: JournalInspection.self)
    }

    func validateJournal(partition: String) async throws -> JournalValidation {
        try await recoveryRequest(partition: partition, suffix: "/validate", method: "POST", body: Optional<JournalQuarantineRequest>.none, as: JournalValidation.self)
    }

    func exportJournal(partition: String) async throws -> JournalExportReceipt {
        try await recoveryRequest(partition: partition, suffix: "/export", method: "POST", body: Optional<JournalQuarantineRequest>.none, as: JournalExportReceipt.self)
    }

    func quarantineJournal(partition: String, expectedFingerprint: String) async throws -> JournalQuarantineReceipt {
        try await recoveryRequest(partition: partition, suffix: "/quarantine", method: "POST", body: JournalQuarantineRequest(expectedFingerprint: expectedFingerprint), as: JournalQuarantineReceipt.self)
    }

    private func recoveryRequest<Response: Decodable, Body: Encodable>(
        partition: String,
        suffix: String,
        method: String,
        body: Body?,
        as: Response.Type
    ) async throws -> Response {
        let escaped = partition.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? partition
        var req = request("recovery/partitions/\(escaped)\(suffix)", method: method)
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try Self.encoder.encode(body)
        }
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(Response.self, from: data)
    }
}

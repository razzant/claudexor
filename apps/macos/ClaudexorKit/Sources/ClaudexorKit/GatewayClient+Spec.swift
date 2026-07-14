import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private struct SpecAnswersRequest: Codable {
    let answers: [SpecAnswer]
    let priorDecisions: [SpecPriorDecision]?
}

private struct SpecSessionWire: Decodable {
    let sessionId: String
    let state: String
    let planRunId: String?
    let questions: [SpecQuestion]
    let specId: String?
    let specDir: String?
    let specPath: String?
    let specHash: String?
}

extension GatewayClient {
    public func specQuestions(_ body: SpecQuestionsRequest) async throws -> SpecQuestionsResponse {
        var req = request("spec/sessions", method: "POST", timeout: 1_200)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(body)
        let wire = try await specRequest(req)
        return SpecQuestionsResponse(
            planRunId: wire.planRunId ?? "",
            planDir: wire.sessionId,
            questions: wire.questions
        )
    }

    public func specFreeze(_ body: SpecFreezeRequest) async throws -> SpecFreezeResponse {
        guard let sessionId = body.planDir, !sessionId.isEmpty else {
            throw GatewayError.http(status: 400, body: "durable spec session id is missing")
        }
        let encoded = sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionId
        var answer = request("spec/sessions/\(encoded)/answers", method: "POST")
        answer.setValue("application/json", forHTTPHeaderField: "Content-Type")
        answer.httpBody = try Self.encoder.encode(
            SpecAnswersRequest(answers: body.answers ?? [], priorDecisions: body.priorDecisions)
        )
        _ = try await specRequest(answer)
        let wire = try await specRequest(
            request("spec/sessions/\(encoded)/freeze", method: "POST", timeout: 120)
        )
        guard wire.state == "frozen", let id = wire.specId, let dir = wire.specDir,
              let path = wire.specPath, let hash = wire.specHash else {
            throw GatewayError.decoding("spec session ended as \(wire.state) without frozen output")
        }
        return SpecFreezeResponse(specId: id, specDir: dir, specPath: path, specHash: hash)
    }

    private func specRequest(_ request: URLRequest) async throws -> SpecSessionWire {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(SpecSessionWire.self, from: data)
    }
}

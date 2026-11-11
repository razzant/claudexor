import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

extension GatewayClient {
    public func threadHistory(id: String, limit: Int = 20,
                              selector: ThreadHistorySelector? = nil,
                              expectedStoreId: String? = nil) async throws -> ThreadHistoryPage {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let selector { query.append(selector.queryItem) }
        if let expectedStoreId { query.append(URLQueryItem(name: "expectedStoreId", value: expectedStoreId)) }
        let page = try await historyRead("threads/\(id)/history", query: query, as: ThreadHistoryPage.self)
        guard page.threadId == id, page.turns.count <= limit,
              expectedStoreId == nil || page.storeId == expectedStoreId else {
            throw GatewayError.decoding("History response does not match its requested thread/store.")
        }
        return page
    }

    public func threadPromptPart(id: String, turnId: String, offset: Int = 0,
                                 maxBytes: Int = 32_768,
                                 expectedStoreId: String? = nil) async throws -> ThreadPromptPart {
        var query = [URLQueryItem(name: "offset", value: String(offset)),
                     URLQueryItem(name: "maxBytes", value: String(maxBytes))]
        if let expectedStoreId { query.append(URLQueryItem(name: "expectedStoreId", value: expectedStoreId)) }
        let part = try await historyRead("threads/\(id)/turns/\(turnId)/prompt", query: query, as: ThreadPromptPart.self)
        guard part.threadId == id, part.turnId == turnId, part.offset == offset,
              part.nextOffset >= offset, part.nextOffset <= part.totalBytes,
              part.nextOffset - offset == part.text.utf8.count, part.text.utf8.count <= maxBytes else {
            throw GatewayError.decoding("Prompt response does not match its requested turn/offset.")
        }
        return part
    }

    private func historyRead<T: Decodable>(_ path: String, query: [URLQueryItem], as type: T.Type) async throws -> T {
        let req = request(path, method: "GET", queryItems: query)
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw GatewayError.http(status: (response as? HTTPURLResponse)?.statusCode ?? -1,
                                    body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(type, from: data)
    }
}

extension GatewayError {
    /// True for the engine's reply to a route it does not serve: an engine older
    /// than the history read answers `/threads/:id/history` this way, while the
    /// history read itself reports typed problems.
    public var isUnknownRoute: Bool {
        guard case .http(404, let body) = self,
              let reply = try? JSONDecoder().decode([String: String].self, from: Data(body.utf8)) else { return false }
        return reply == ["error": "not found"]
    }
}

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Artifact + produced-output access (Phase 3 gallery). Split out of the
/// GatewayClient core (complexity ratchet) so the strict-decode / honest-empty
/// fixes live with their own small, testable owner.
extension GatewayClient {
    public func artifactText(runId: String, path: String) async throws -> String {
        let escaped = path.split(separator: "/").map { part in
            String(part).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String(part)
        }.joined(separator: "/")
        let req = request("runs/\(runId)/artifacts/\(escaped)", method: "GET")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        // STRICT decode (X114 class): `String(decoding:as:UTF8.self)` silently
        // REPLACES malformed bytes with U+FFFD and paints corruption as if it were
        // real text — the same asymmetry `producedTextOutcome` already closes on the
        // raw-bytes path. Refuse a non-UTF-8 body (the outcome layer maps it to a
        // path-named `.notRenderable`) so both text surfaces are honest.
        guard let text = String(data: data, encoding: .utf8) else {
            throw GatewayError.decoding("\(path) is not valid UTF-8 text")
        }
        return text
    }

    public func listRunArtifacts(runId: String) async throws -> [ArtifactInfo] {
        let req = request("runs/\(runId)/artifacts", method: "GET")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        struct Resp: Decodable { let artifacts: [ArtifactInfo] }
        // INV-021: a malformed 200 must NOT project as an honest EMPTY gallery —
        // `try?` here would swallow the decode failure and paint "no artifacts"
        // over a real error. Propagate `.decoding` so the load reads as FAILED and
        // the gallery renders its error + Retry instead of a false empty state.
        do { return try Self.decoder.decode(Resp.self, from: data).artifacts }
        catch { throw GatewayError.decoding("\(error)") }
    }

    public func artifactData(runId: String, path: String) async throws -> Data {
        let escaped = path.split(separator: "/").map { part in
            String(part).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String(part)
        }.joined(separator: "/")
        let req = request("runs/\(runId)/artifacts/\(escaped)", method: "GET")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return data
    }

    /// List a run's PRODUCED outputs — the project's `artifacts/` dir, not the run
    /// orchestration tree. Same shape/serving as `GET /runs/:id/artifacts`.
    public func listProducedFiles(runId: String) async throws -> [ArtifactInfo] {
        let req = request("runs/\(runId)/produced", method: "GET")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        struct Resp: Decodable { let artifacts: [ArtifactInfo] }
        // INV-021: same honest-empty trap as listRunArtifacts — a malformed 200
        // propagates as `.decoding` (load FAILED), never a false "no outputs".
        do { return try Self.decoder.decode(Resp.self, from: data).artifacts }
        catch { throw GatewayError.decoding("\(error)") }
    }

    public func producedData(runId: String, path: String) async throws -> Data {
        let escaped = path.split(separator: "/").map { part in
            String(part).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String(part)
        }.joined(separator: "/")
        let req = request("runs/\(runId)/produced/\(escaped)", method: "GET")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return data
    }
}

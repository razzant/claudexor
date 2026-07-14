import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

extension GatewayClient {
    public func listProjects() async throws -> ProjectListResponse {
        let req = request("projects", method: "GET")
        let (data, resp) = try await session.data(for: req)
        try Self.requireOK(resp, data: data)
        return try Self.decoder.decode(ProjectListResponse.self, from: data)
    }

    public func registerProject(root: String) async throws -> RegisteredProject {
        try await mutateProject(path: "projects", root: root)
    }

    public func relinkProject(id: String, root: String) async throws -> RegisteredProject {
        try await mutateProject(path: "projects/\(id)/relink", root: root)
    }

    private func mutateProject(path: String, root: String) async throws -> RegisteredProject {
        var req = request(path, method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(ProjectRootRequest(root: root))
        let (data, resp) = try await session.data(for: req)
        try Self.requireOK(resp, data: data)
        return try Self.decoder.decode(RegisteredProject.self, from: data)
    }

    private static func requireOK(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
    }
}

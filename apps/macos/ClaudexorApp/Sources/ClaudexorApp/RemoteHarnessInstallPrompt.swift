import ClaudexorKit
import Foundation

/// The CLI inside one immutable remote runtime closure.
func remoteRuntimeCLI(_ runtimeTarget: String) -> String {
    "~/.claudexor/remote/" + SSHCommandFactory.posixQuote(runtimeTarget) + "/bin/claudexor"
}

struct RemoteVendorCommand: Decodable, Equatable, Sendable {
    struct Script: Decodable, Equatable, Sendable {
        let url: String
        let size: Int
        let sha256: String
    }
    let binary: String
    let args: [String]
    let env: [String: String]
    let script: Script?

    var valid: Bool {
        guard !binary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        guard let script else { return true }
        return URL(string: script.url)?.scheme == "https"
            && URL(string: script.url)?.host != nil && script.size > 0
            && script.sha256.count == 64 && script.sha256.allSatisfy { $0.isHexDigit }
    }

    var disclosure: String {
        let assignments = env.sorted { $0.key < $1.key }.map {
            $0.key + "=" + SSHCommandFactory.posixQuote($0.value)
        }
        var text = (assignments + ([binary] + args).map(SSHCommandFactory.posixQuote)).joined(separator: " ")
        if let script {
            text += "\nScript: \(script.url) (\(script.size) bytes; SHA-256 \(script.sha256))"
        }
        return text
    }
}

/// Projection of the engine's prepared maintenance receipt. Confirmation uses
/// the same runtime; vendor-current is resolved at execution, never a local pin.
struct RemoteHarnessInstallPrompt: Identifiable, Equatable {
    let lease: RemoteActionLease
    let harness: String
    let runtimeTarget: String
    let commands: [RemoteVendorCommand]
    let installationHome: String
    let requestedVersion: String?

    var id: UUID { lease.token }
    var connectionID: UUID { lease.connectionID }
    var confirmedInstallCommand: String {
        var command = remoteRuntimeCLI(runtimeTarget) + " harness install "
            + SSHCommandFactory.posixQuote(harness)
        if let requestedVersion {
            command += " --vendor-version " + SSHCommandFactory.posixQuote(requestedVersion)
        }
        return command + " --yes --json"
    }
}

extension AppModel {
    nonisolated static func harnessInstallPreparationFailure(
        _ error: Error, harness: String
    ) -> String? {
        guard case let SSHConnectionError.commandFailed(detail) = error else { return nil }
        let vendor = HarnessFamily(rawValue: harness).label
        return detail.isEmpty
            ? "\(vendor) was not installed: the host reported no reason."
            : "\(vendor) was not installed: \(detail)"
    }


    nonisolated static func parseHarnessInstallDisclosure(
        _ data: Data, lease: RemoteActionLease, harness: String, runtimeTarget: String
    ) -> RemoteHarnessInstallPrompt? {
        struct Disclosure: Decodable {
            struct Target: Decodable { let kind: String; let version: String? }
            let ok: Bool
            let dryRun: Bool
            let harness: String
            let target: Target
            let installationHome: String
            let commands: [RemoteVendorCommand]
        }
        guard let parsed = try? JSONDecoder().decode(Disclosure.self, from: data),
              parsed.ok, parsed.dryRun, parsed.harness == harness,
              !parsed.installationHome.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !parsed.commands.isEmpty, parsed.commands.allSatisfy(\.valid)
        else { return nil }
        switch parsed.target.kind {
        case "latest": guard parsed.target.version == nil else { return nil }
        case "version":
            guard parsed.target.version?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else { return nil }
        default: return nil
        }
        return RemoteHarnessInstallPrompt(
            lease: lease, harness: harness, runtimeTarget: runtimeTarget,
            commands: parsed.commands, installationHome: parsed.installationHome,
            requestedVersion: parsed.target.version)
    }
}

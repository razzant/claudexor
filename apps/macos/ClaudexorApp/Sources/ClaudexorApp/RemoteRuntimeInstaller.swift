import ClaudexorKit
import CryptoKit
import Foundation

private let remoteManifestURL = URL(
    string: "https://github.com/razzant/claudexor/releases/latest/download/remote-runtime-manifest.json")!

protocol RemoteRuntimeSSHTransport: Sendable {
    func execute(
        _ connection: RemoteConnection,
        remoteCommand: String,
        stdin: Data?
    ) async throws -> SSHProcessOutput
}

extension RemoteRuntimeSSHTransport {
    func execute(
        _ connection: RemoteConnection,
        remoteCommand: String
    ) async throws -> SSHProcessOutput {
        try await execute(connection, remoteCommand: remoteCommand, stdin: nil)
    }
}

extension SSHConnectionManager: RemoteRuntimeSSHTransport {}

struct RemoteBootstrapResponse: Decodable, Sendable {
    struct Endpoint: Decodable, Sendable {
        let host: String
        let port: Int
        let token: String
    }

    let ok: Bool
    let target: RemoteRuntimeTarget
    let version: String
    let buildSha: String
    let protocolMajor: Int
    let engineVersion: String?
    let engineBuildSha: String?
    let endpoint: Endpoint

    var runtime: RemoteRuntimeProbe {
        RemoteRuntimeProbe(
            target: target, version: version, buildSha: buildSha,
            protocolMajor: protocolMajor)
    }
}

actor RemoteRuntimeInstaller {
    private struct BundledDevelopmentAuthority: Decodable {
        let keyId: String
        let algorithm: String
        let publicKeyPem: String
    }

    private struct RuntimeSnapshot: Sendable {
        let pointerTarget: String?
        let probe: RemoteRuntimeProbe?
    }

    private let ssh: any RemoteRuntimeSSHTransport
    private let session: URLSession
    private let developmentDirectory: URL?
    private var bundledManifest: RemoteRuntimeManifestV1?
    private var bundledAssetsDirectory: URL?
    private var activationState = RemoteRuntimeActivationState()

    init(
        ssh: any RemoteRuntimeSSHTransport,
        session: URLSession = .shared,
        developmentDirectory: URL? = RemoteRuntimeInstaller.defaultDevelopmentDirectory
    ) {
        self.ssh = ssh
        self.session = session
        self.developmentDirectory = developmentDirectory
    }

    func loadManifest() async throws -> RemoteRuntimeManifestV1 {
        if let developmentDirectory {
            return try loadBundledDevelopmentManifest(from: developmentDirectory)
        }
        bundledManifest = nil
        bundledAssetsDirectory = nil
        let (data, response) = try await session.data(from: remoteManifestURL)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw SSHConnectionError.unavailable("remote runtime manifest is unavailable")
        }
        guard let manifest = RemoteRuntimeManifestV1.verified(data) else {
            throw SSHConnectionError.unavailable(
                "remote runtime manifest signature or shape is invalid")
        }
        return manifest
    }

    private static var defaultDevelopmentDirectory: URL? {
        #if CLAUDEXOR_DEV_REMOTE_RUNTIME
        Bundle.main.resourceURL?
            .appendingPathComponent("remote-runtime-dev", isDirectory: true)
        #else
        nil
        #endif
    }

    private func loadBundledDevelopmentManifest(
        from directory: URL
    ) throws -> RemoteRuntimeManifestV1 {
        do {
            let authorityData = try readRegularFile(
                directory.appendingPathComponent("authority.json"))
            let authorityRecord = try JSONDecoder().decode(
                BundledDevelopmentAuthority.self, from: authorityData)
            let authority = RuntimeUpdateAuthority(
                keyId: authorityRecord.keyId,
                algorithm: authorityRecord.algorithm,
                publicKeyPem: authorityRecord.publicKeyPem)
            let manifestData = try readRegularFile(
                directory.appendingPathComponent("remote-runtime-manifest.json"))
            guard let manifest = RemoteRuntimeManifestV1.verified(
                manifestData, authority: authority)
            else {
                throw SSHConnectionError.unavailable(
                    "bundled development remote runtime signature or shape is invalid")
            }
            let assetsDirectory = directory.appendingPathComponent("assets", isDirectory: true)
            for asset in manifest.assets {
                _ = try readRegularFile(
                    assetsDirectory.appendingPathComponent(asset.archiveName),
                    loadBytes: false)
            }
            bundledManifest = manifest
            bundledAssetsDirectory = assetsDirectory
            return manifest
        } catch let error as SSHConnectionError {
            throw error
        } catch {
            throw SSHConnectionError.unavailable(
                "bundled development remote runtime is unavailable: \(error.localizedDescription)")
        }
    }

    func detectTarget(on connection: RemoteConnection) async throws -> RemoteRuntimeTarget {
        let result = try await ssh.execute(
            connection,
            remoteCommand: "printf '%s\\n' \"$(uname -s)\" \"$(uname -m)\"")
        let lines = String(decoding: result.stdout, as: UTF8.self)
            .split(whereSeparator: \.isNewline).map(String.init)
        guard lines.count >= 2 else {
            throw SSHConnectionError.unavailable("remote uname returned no platform identity")
        }
        let platform: String
        switch lines[0].lowercased() {
        case "linux": platform = "linux"
        case "darwin": platform = "darwin"
        default:
            throw SSHConnectionError.unavailable("unsupported remote platform \(lines[0])")
        }
        let architecture: String
        switch lines[1].lowercased() {
        case "x86_64", "amd64": architecture = "x64"
        case "arm64", "aarch64": architecture = "arm64"
        default:
            throw SSHConnectionError.unavailable("unsupported remote architecture \(lines[1])")
        }
        guard let target = RemoteRuntimeTarget(platform: platform, arch: architecture) else {
            throw SSHConnectionError.unavailable("unsupported remote target")
        }
        return target
    }

    func probe(on connection: RemoteConnection) async throws -> RemoteRuntimeProbe {
        let result = try await ssh.execute(
            connection,
            remoteCommand:
                "~/.claudexor/remote/current/bin/claudexor remote probe --json")
        return try JSONDecoder().decode(RemoteRuntimeProbe.self, from: result.stdout)
    }

    func bootstrap(on connection: RemoteConnection) async throws -> RemoteBootstrapResponse {
        let result = try await ssh.execute(
            connection,
            remoteCommand:
                "~/.claudexor/remote/current/bin/claudexor remote bootstrap --json")
        let bootstrap = try JSONDecoder().decode(RemoteBootstrapResponse.self, from: result.stdout)
        guard bootstrap.ok,
              bootstrap.protocolMajor == 3,
              bootstrap.engineVersion == bootstrap.version,
              bootstrap.engineBuildSha == bootstrap.buildSha,
              bootstrap.endpoint.host == "127.0.0.1",
              (1 ... 65_535).contains(bootstrap.endpoint.port),
              !bootstrap.endpoint.token.isEmpty
        else { throw SSHConnectionError.unavailable("remote bootstrap response was invalid") }
        return bootstrap
    }

    private func bootstrap(
        on connection: RemoteConnection,
        expecting expected: RemoteRuntimeProbe
    ) async throws -> RemoteBootstrapResponse {
        let value = try await bootstrap(on: connection)
        guard value.runtime == expected
        else {
            throw SSHConnectionError.unavailable(
                "the restarted daemon does not match the activated runtime")
        }
        return value
    }

    /// Reads the movable `current` pointer. Its validated `versions/<id>` target
    /// names one immutable runtime closure; the harness installer confirms
    /// through the same closure that produced its disclosure. A failed probe
    /// reaches the app only through stderr, so exit 73 names its reason there.
    static let currentPointerProbeCommand = """
        set -eu
        current="$HOME/.claudexor/remote/current"
        if test -L "$current"; then
          readlink "$current"
        elif test -e "$current"; then
          echo "$current exists but is not a symlink to an installed Claudexor runtime; move it aside and install the runtime again" >&2
          exit 73
        fi
        """

    static func currentPointerTarget(fromProbe stdout: Data) throws -> String? {
        let value = String(decoding: stdout, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        guard value.hasPrefix("versions/"),
              !value.dropFirst("versions/".count).contains("/"),
              !value.contains("..")
        else {
            throw SSHConnectionError.unavailable("remote runtime current pointer is unsafe")
        }
        return value
    }

    private func currentPointerTarget(on connection: RemoteConnection) async throws -> String? {
        let result = try await ssh.execute(
            connection, remoteCommand: Self.currentPointerProbeCommand)
        return try Self.currentPointerTarget(fromProbe: result.stdout)
    }

    /// Snapshot the pointer around the probe so the install policy and the
    /// compare-and-swap token always describe the same immutable closure.
    private func snapshot(on connection: RemoteConnection) async throws -> RuntimeSnapshot {
        for _ in 0 ..< 3 {
            let before = try await currentPointerTarget(on: connection)
            let value: RemoteRuntimeProbe?
            if before == nil {
                value = nil
            } else {
                value = try await probe(on: connection)
            }
            let after = try await currentPointerTarget(on: connection)
            if before == after {
                return RuntimeSnapshot(pointerTarget: before, probe: value)
            }
        }
        throw SSHConnectionError.unavailable(
            "remote runtime changed concurrently; retry the installation")
    }

    func install(
        _ manifest: RemoteRuntimeManifestV1,
        target: RemoteRuntimeTarget,
        on connection: RemoteConnection,
        appVersion: String
    ) async throws -> RemoteRuntimeActivationLease {
        // A prior candidate whose rollback could not be proven owns this host
        // until exact recovery succeeds. Retry that recovery before admitting
        // new bytes; never overwrite its compare-and-swap evidence.
        try await recoverPendingActivation(on: connection)
        // Claim synchronously before the first suspension. The actor may admit
        // another task at every await below, but that task sees this lease and
        // refuses instead of overwriting its activation bookkeeping.
        let lease = try activationState.claim(connectionID: connection.id)
        var handedOff = false
        var mutationMayHaveChangedPointer = false
        defer {
            if !handedOff, !mutationMayHaveChangedPointer {
                activationState.abandon(lease)
            }
        }
        let initial = try await snapshot(on: connection)
        switch decideRemoteRuntimeInstall(
            current: initial.probe, target: target, manifest: manifest, appVersion: appVersion)
        {
        case .allow:
            break
        case .appUpdateRequired:
            throw SSHConnectionError.unavailable(
                "this runtime requires a newer Claudexor app")
        case .refuseDowngrade:
            throw SSHConnectionError.unavailable(
                "the host runtime is newer and will not be downgraded")
        }
        guard let asset = manifest.asset(for: target),
              let url = URL(string: asset.archiveUrl),
              asset.archiveName == RemoteRuntimeManifestV1.archiveName(
                version: manifest.version, target: target)
        else { throw SSHConnectionError.unavailable("manifest has no valid asset for \(target.rawValue)") }
        let archive: Data
        if manifest == bundledManifest, let bundledAssetsDirectory {
            archive = try readRegularFile(
                bundledAssetsDirectory.appendingPathComponent(asset.archiveName))
        } else {
            let (temporaryURL, response) = try await session.download(from: url)
            defer { try? FileManager.default.removeItem(at: temporaryURL) }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                throw SSHConnectionError.unavailable("remote runtime download failed")
            }
            archive = try Data(contentsOf: temporaryURL, options: .mappedIfSafe)
        }
        let digest = SHA256.hash(data: archive).map { String(format: "%02x", $0) }.joined()
        guard digest == asset.sha256 else {
            throw SSHConnectionError.unavailable("remote runtime archive digest mismatch")
        }
        // digest == asset.sha256 was proven above, so the name is 64 hex
        // chars; the posixQuote still keeps every remote interpolation on the
        // single audited quoting path.
        let incoming =
            "umask 077; mkdir -p \"$HOME/.claudexor/remote/incoming\"; " +
            "cat > \"$HOME/.claudexor/remote/incoming/\"" +
            SSHCommandFactory.posixQuote("\(asset.sha256).tar.gz")
        _ = try await ssh.execute(connection, remoteCommand: incoming, stdin: archive)

        let installCommand =
            "sh -s -- \(SSHCommandFactory.posixQuote(manifest.version)) " +
            "\(SSHCommandFactory.posixQuote(asset.sha256)) " +
            "\(SSHCommandFactory.posixQuote(initial.pointerTarget ?? "-")) " +
            "\(SSHCommandFactory.posixQuote(initial.probe?.version ?? "-")) " +
            SSHCommandFactory.posixQuote(initial.probe?.buildSha ?? "-")
        let candidate = RemoteRuntimeProbe(
            target: target,
            version: manifest.version,
            buildSha: manifest.buildSha,
            protocolMajor: manifest.protocolMajor)
        let activation = RemoteRuntimeActivationState.Payload(
            candidateTarget: "versions/\(manifest.version)-\(asset.sha256)",
            candidate: candidate,
            previousTarget: initial.pointerTarget,
            previous: initial.probe)
        try activationState.prepareMutation(activation, for: lease)
        mutationMayHaveChangedPointer = true
        do {
            _ = try await ssh.execute(
                connection,
                remoteCommand: installCommand,
                stdin: Data(Self.installScript.utf8))
        } catch {
            // The SSH result can be lost after the atomic rename. Preserve the
            // exact candidate/previous closure before inspecting anything: a
            // failed readlink remains recoverable instead of being collapsed
            // into the same nil value as a proven absent pointer.
            do {
                try activationState.markUncertain(lease)
                try await recoverActivation(lease, on: connection)
            } catch let recoveryError {
                throw RemoteRuntimeRecoveryRequired(
                    lease: lease,
                    primaryMessage: userFacingRemoteRuntimeMessage(error),
                    recoveryMessage: userFacingRemoteRuntimeMessage(recoveryError))
            }
            throw error
        }
        try activationState.confirmMutation(lease)
        do {
            _ = try await bootstrap(on: connection, expecting: candidate)
        } catch {
            do {
                try await rollback(lease, on: connection)
            } catch let rollbackError {
                throw RemoteRuntimeRecoveryRequired(
                    lease: lease,
                    primaryMessage: userFacingRemoteRuntimeMessage(error),
                    recoveryMessage: userFacingRemoteRuntimeMessage(rollbackError))
            }
            throw error
        }
        handedOff = true
        return lease
    }

    /// Retry the only safe action for an activation that failed before the app
    /// accepted its tunneled Control handshake. Connection-only lookup is safe
    /// here because the single-flight state forbids any newer activation while
    /// this exact pending lease exists; recovery can only roll back, never
    /// commit.
    func recoverPendingActivation(on connection: RemoteConnection) async throws {
        guard let lease = activationState.lease(connectionID: connection.id) else { return }
        guard activationState.recoverableLease(connectionID: connection.id) == lease else {
            // An ordinary reconnect must not probe/publish a candidate while
            // the mutating command or its exact settlement is suspended.
            throw SSHConnectionError.unavailable(
                "runtime activation is still in progress for this host")
        }
        try await recoverActivation(lease, on: connection)
    }

    /// Settle either a proven activated candidate or an install whose SSH
    /// completion is uncertain. An uncertain pointer has exactly three safe
    /// outcomes: candidate -> exact rollback; previous -> exact previous-daemon
    /// proof (or proven absence); anything else/unreadable -> retain the lease.
    func recoverActivation(
        _ lease: RemoteRuntimeActivationLease,
        on connection: RemoteConnection
    ) async throws {
        guard lease.connectionID == connection.id else {
            throw SSHConnectionError.unavailable(
                "the runtime activation lease belongs to another host")
        }
        switch activationState.phase(for: lease) {
        case .pending:
            try await rollback(lease, on: connection)
        case .uncertain:
            let activation = try activationState.beginUncertainReconciliation(lease)
            let observed: String?
            do {
                observed = try await currentPointerTarget(on: connection)
            } catch {
                activationState.uncertainReconciliationFailed(lease)
                throw error
            }
            if observed == activation.candidateTarget {
                try activationState.confirmUncertainCandidate(lease)
                try await rollback(lease, on: connection)
                return
            }
            guard observed == activation.previousTarget else {
                activationState.uncertainReconciliationFailed(lease)
                throw SSHConnectionError.unavailable(
                    "remote runtime pointer changed while activation recovery was pending")
            }
            do {
                if let previous = activation.previous {
                    _ = try await bootstrap(on: connection, expecting: previous)
                }
                try activationState.resolveUnchangedPointer(lease)
            } catch {
                activationState.uncertainReconciliationFailed(lease)
                throw error
            }
        case .installing, .reconciling, .settling:
            throw SSHConnectionError.unavailable(
                "runtime activation recovery is already in progress")
        case nil:
            throw SSHConnectionError.unavailable(
                "the runtime activation lease is stale or already settled")
        }
    }

    func rollback(
        _ lease: RemoteRuntimeActivationLease,
        on connection: RemoteConnection
    ) async throws {
        guard lease.connectionID == connection.id else {
            throw SSHConnectionError.unavailable(
                "the runtime activation lease belongs to another host")
        }
        let activation = try activationState.beginSettlement(lease)
        let command =
            "sh -s -- \(SSHCommandFactory.posixQuote(activation.candidateTarget)) " +
            "\(SSHCommandFactory.posixQuote(activation.previousTarget ?? "-")) " +
            "\(SSHCommandFactory.posixQuote(activation.candidate.version)) " +
            "\(SSHCommandFactory.posixQuote(activation.candidate.buildSha)) " +
            "\(SSHCommandFactory.posixQuote(activation.previous?.version ?? "-")) " +
            SSHCommandFactory.posixQuote(activation.previous?.buildSha ?? "-")
        do {
            let result = try await ssh.execute(
                connection,
                remoteCommand: command,
                stdin: Data(Self.rollbackScript.utf8))
            if let previous = activation.previous {
                let bootstrap = try JSONDecoder().decode(
                    RemoteBootstrapResponse.self, from: result.stdout)
                guard bootstrap.target == previous.target,
                      bootstrap.version == previous.version,
                      bootstrap.buildSha == previous.buildSha,
                      bootstrap.protocolMajor == previous.protocolMajor,
                      bootstrap.engineVersion == previous.version,
                      bootstrap.engineBuildSha == previous.buildSha
                else {
                    throw SSHConnectionError.unavailable(
                        "rollback restarted a daemon with the wrong identity")
                }
            }
            try activationState.finishSettlement(lease)
        } catch {
            // Keep the exact lease retryable for its owner. A different caller
            // still cannot commit or replace it while this error is reported.
            activationState.settlementFailed(lease)
            throw error
        }
    }

    /// Commit only after the tunneled Control handshake identifies the exact
    /// candidate and the remote pointer still names the lease-owned directory.
    /// Any failed proof restores `pending`, so the caller can run the existing
    /// exact rollback instead of forgetting an ambiguous activation.
    func commitActivation(
        _ lease: RemoteRuntimeActivationLease,
        serving: RemoteRuntimeProbe,
        on connection: RemoteConnection
    ) async throws {
        guard lease.connectionID == connection.id else {
            throw SSHConnectionError.unavailable(
                "the runtime activation lease belongs to another host")
        }
        let activation = try activationState.beginCommit(lease, serving: serving)
        do {
            let observed = try await currentPointerTarget(on: connection)
            guard observed == activation.candidateTarget else {
                throw SSHConnectionError.unavailable(
                    "remote runtime pointer changed before activation commit")
            }
            try activationState.finishSettlement(lease)
        } catch {
            activationState.settlementFailed(lease)
            throw error
        }
    }

    private func userFacingRemoteRuntimeMessage(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }

    private func readRegularFile(
        _ url: URL,
        loadBytes: Bool = true
    ) throws -> Data {
        let values = try url.resourceValues(
            forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else {
            throw SSHConnectionError.unavailable(
                "bundled development runtime contains a non-regular file")
        }
        return loadBytes ? try Data(contentsOf: url, options: .mappedIfSafe) : Data()
    }

}

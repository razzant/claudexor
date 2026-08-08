import Foundation
import ClaudexorKit

// Runtime update discovery and installation are one AppModel concern. They
// live apart from credential-profile CRUD so both extensions stay readable.
extension AppModel {
    func refreshUpdateAvailability() {
        updateAvailability = updateProvider.current()
    }

    static func appVersionString() -> String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "dev"
    }

    /// The honest status a dev build shows where the update chip would appear.
    static let devBuildUpdateStatus = "Dev build — update check not applicable"

    /// The APP version the update flow reasons about (test seam; production
    /// reads the bundle).
    var updateFlowAppVersion: String {
        appVersionOverrideForUpdates ?? Self.appVersionString()
    }

    var engineVersionDisplay: String { engineIdentity?.version ?? "unknown" }

    var engineShaDisplay: String {
        engineIdentity.map { AboutInfo.shortSha($0.sha) } ?? "unknown"
    }

    private func resolvedRunningEngineVersion() -> String {
        if let serving = engineIdentity?.version { return serving }
        if let installed = RuntimeInstaller().readCurrent()?.version { return installed }
        return Self.appVersionString()
    }

    func checkForRuntimeUpdate(force: Bool = true) async {
        if !force {
            guard !didAutoCheckRuntime else { return }
        }
        didAutoCheckRuntime = true
        let app = updateFlowAppVersion
        // Display-only dev suppression (Р16/F9): a source-built dev app and the
        // installed packaged app both recompute the running-engine fallback from
        // the SHARED ~/.claudexor/runtime/current.json, so an AUTOMATIC check in
        // a dev build would present the installed app's update decision. The dev
        // app therefore never runs the automatic check and presents no chip —
        // only the honest dev status line. Manual Check for Updates (force) and
        // packaged behavior are unchanged.
        if !force, app == "dev" {
            runtimeUpdateStatus = Self.devBuildUpdateStatus
            return
        }
        if runtimeUpdateChecking { return }
        runtimeUpdateChecking = true
        defer { runtimeUpdateChecking = false }

        let updater = runtimeUpdater
            ?? RuntimeUpdater(transport: makeRuntimeTransport())
        runtimeUpdater = updater
        let running = resolvedRunningEngineVersion()
        do {
            let outcome = try await updater.check(
                runningEngineVersion: running, appVersion: app)
            switch outcome {
            case .notModified:
                if let cached = await updater.cachedDecision {
                    applyRuntimeDecision(cached)
                } else {
                    runtimeUpdateStatus = "Up to date"
                }
            case let .decided(decision):
                applyRuntimeDecision(decision)
            }
        } catch {
            runtimeUpdateStatus = (error as? RuntimeUpdateError)?.errorDescription
                ?? "Update check failed: \(error.localizedDescription)"
        }
    }

    private func applyRuntimeDecision(_ decision: RuntimeUpdateDecision) {
        runtimeUpdateProvider.store(decision)
        updateAvailability = decision.chipAvailability
        switch decision {
        case .upToDate:
            runtimeUpdateStatus = "Up to date"
        case let .available(manifest):
            runtimeUpdateStatus = "Update available: v\(manifest.version)"
        case let .appUpdateRequired(minAppVersion, _):
            runtimeUpdateStatus =
                "App update required — install the latest app "
                + "(needs v\(minAppVersion) or newer), then re-check."
        case let .unknown(reason):
            // Keyed on the APP being a dev build (it always is when the
            // resolved running version degrades to appVersionString()'s "dev").
            runtimeUpdateStatus =
                updateFlowAppVersion == "dev"
                ? Self.devBuildUpdateStatus
                : "Update status unknown: \(reason)"
        }
    }

    private func resolveClosureURL(
        transport: RuntimeReleaseTransport,
        archiveName: String
    ) async -> URL? {
        guard let fetch = try? await transport.fetchLatestRelease(etag: nil),
              let body = fetch.data,
              let release = GitHubRelease.parse(body),
              let asset = release.asset(named: archiveName),
              let url = URL(string: asset.browserDownloadURL)
        else { return nil }
        return url
    }

    func installRuntimeUpdate() async {
        guard !runtimeInstalling else { return }
        guard case let .available(manifest)? = await runtimeUpdater?.cachedDecision else {
            runtimeInstallStatus = "No verified update to install."
            return
        }
        runtimeInstalling = true
        runtimeInstallStatus = "Preparing update to v\(manifest.version)…"
        defer { runtimeInstalling = false }

        let transport = makeRuntimeTransport()
        guard let resolved = await resolveClosureURL(
            transport: transport, archiveName: manifest.archiveName)
        else {
            runtimeInstallStatus =
                "Could not locate the runtime download for v\(manifest.version)."
            return
        }
        guard resolved.absoluteString == manifest.archiveUrl,
              let assetURL = URL(string: manifest.archiveUrl)
        else {
            runtimeInstallStatus =
                "Refusing update: the download URL does not match the signed manifest."
            return
        }
        let coordinator = RuntimeInstallCoordinator(
            installer: RuntimeInstaller(),
            transport: transport,
            daemon: makeDaemonControl(),
            lifecycleOwner: localRuntimeLifecycleOwner,
            rollbackSelection: { DaemonLauncher.resolvedRuntime() },
            onPhase: { [weak self] phase in
                Task { @MainActor in self?.applyInstallPhase(phase) }
            })
        do {
            let version = try await coordinator.install(
                manifest: manifest, assetURL: assetURL)
            runtimeInstallStatus = "Updated to engine v\(version)."
            await runtimeUpdater?.recordInstalledVersion(
                version, appVersion: Self.appVersionString())
            applyRuntimeDecision(.upToDate)
        } catch {
            runtimeInstallStatus =
                (error as? RuntimeInstallError)?.errorDescription
                ?? (error as? RuntimeUpdateError)?.errorDescription
                ?? "Update failed: \(error.localizedDescription)"
        }
    }

    private func applyInstallPhase(_ phase: RuntimeInstallPhase) {
        switch phase {
        case .downloading:
            runtimeInstallStatus = "Downloading engine runtime…"
        case .verifying:
            runtimeInstallStatus = "Verifying signature and checksum…"
        case .unpacking:
            runtimeInstallStatus = "Unpacking…"
        case .probing:
            runtimeInstallStatus = "Checking the new runtime…"
        case .awaitingIdle:
            runtimeInstallStatus = "Waiting for running jobs to finish…"
        case .swapping:
            runtimeInstallStatus = "Switching to the new runtime…"
        case .relaunching:
            runtimeInstallStatus = "Relaunching the engine…"
        case let .done(version):
            runtimeInstallStatus = "Updated to engine v\(version)."
        case let .rolledBack(reason):
            runtimeInstallStatus = "Update rolled back: \(reason)."
        case let .failed(reason):
            runtimeInstallStatus = "Update failed: \(reason)."
        }
    }
}

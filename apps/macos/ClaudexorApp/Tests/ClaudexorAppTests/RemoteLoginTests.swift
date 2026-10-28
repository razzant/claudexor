import AppKit
import ClaudexorKit
import SwiftUI
import Testing
@testable import ClaudexorApp

@MainActor @Suite struct RemoteLoginTests {
    @Test(arguments: [SetupHarness.claude, .agy, .cursor, .codex])
    func completionUsesTheExactRemoteJobAndAccount(harness: SetupHarness) async throws {
        let gateway = RemoteLoginFixtureGateway(harness: harness)
        var refreshed: SetupJob?
        let session = RemoteLoginSession(gateway: gateway, jobId: gateway.job.jobId,
            isCurrent: { true }, refreshReadiness: { job in
                refreshed = job
                return RemoteNativeLoginReadiness(nativeSessionVerified: true, harnessRoutable: true)
            })
        let observing = Task { await session.observe() }
        defer { observing.cancel() }
        try await waitUntil { session.lifecycle.deviceCode != nil }
        #expect(gateway.requests == ["snapshot:setup-remote", "events:setup-remote"])
        #expect(session.lifecycle.job?.profileId == "selected-profile")
        if harness == .claude || harness == .agy {
            #expect(session.lifecycle.deviceCode?.flow == .oauthUrlInput)
            #expect(await session.submitInput("one-time-fixture") == nil)
            #expect(gateway.inputs == [("setup-remote", "one-time-fixture")].map { "\($0.0):\($0.1)" })
        } else {
            #expect(session.lifecycle.deviceCode?.flow == (harness == .codex ? .chatgptDeviceCode : .oauthUrl))
            gateway.complete()
        }
        try await waitUntil { refreshed != nil }
        #expect(refreshed?.harness == harness)
        #expect(refreshed?.profileId == "selected-profile")
        #expect(refreshed?.jobId == "setup-remote")
        #expect(session.readiness?.nativeSessionVerified == true)
        #expect(!gateway.requests.contains(where: { $0.hasPrefix("create") || $0.hasPrefix("list") }))
        await observing.value
        #expect(session.lifecycle.connection == .terminal)
        #expect(session.current)
        #expect(session.status == nil)
    }

    @Test func correctedDisclosureReplacesTheLinkAndCloseDoesNotCancelLogin() async throws {
        let gateway = RemoteLoginFixtureGateway(harness: .claude)
        let session = makeSession(gateway)
        let observing = Task { await session.observe() }
        defer { observing.cancel() }
        try await waitUntil { session.lifecycle.deviceCode != nil }
        gateway.updateLink("https://example.invalid/oauth?corrected=complete")
        try await waitUntil { session.lifecycle.deviceCode?.verificationUrl.contains("corrected") == true }
        await session.detach()
        await observing.value
        #expect(session.lifecycle.deviceCode == nil)
        #expect(gateway.inputs.isEmpty)
        #expect(!gateway.requests.contains("cancel:setup-remote"))
    }

    @Test func cancelUsesTheSameJobAndAChangedConnectionSendsNothing() async throws {
        let gateway = RemoteLoginFixtureGateway(harness: .agy)
        let connection = RemoteLoginFixtureConnection()
        let session = RemoteLoginSession(gateway: gateway, jobId: gateway.job.jobId,
            isCurrent: { connection.current }, refreshReadiness: { _ in nil })
        let observing = Task { await session.observe() }
        defer { observing.cancel() }
        try await waitUntil { session.lifecycle.deviceCode != nil }
        connection.current = false
        #expect(await session.submitInput("must-not-send") != nil)
        await session.cancel()
        #expect(gateway.inputs.isEmpty)
        #expect(!gateway.requests.contains("cancel:setup-remote"))
        connection.current = true
        await session.cancel()
        try await waitUntil { session.lifecycle.job?.state == .cancelled }
        #expect(gateway.requests.contains("cancel:setup-remote"))
        await observing.value
    }

    @Test func lateInputCannotReattachADetachedController() async throws {
        let gateway = RemoteLoginFixtureGateway(harness: .claude)
        gateway.delayInput = true
        let controller = SetupLifecycleController(gateway: gateway)
        await controller.observeJob(jobId: "setup-remote")
        let deadline = ContinuousClock.now + .seconds(60)
        while await controller.snapshot().deviceCode == nil, ContinuousClock.now < deadline { await Task.yield() }
        try #require(await controller.snapshot().deviceCode != nil)
        let submission = Task { await controller.submitInput("one-time") }
        try await waitUntil { gateway.inputIsWaiting }
        await controller.detach()
        gateway.releaseInput()
        #expect(await submission.value != nil)
        let after = await controller.snapshot()
        #expect(after.connection == .detached)
        #expect(after.deviceCode == nil)
        #expect(gateway.requests.filter { $0.hasPrefix("snapshot") }.count == 1)
    }

    /// Opt-in render of the production content, with no AppModel/daemon/auth.
    /// Run with CLAUDEXOR_LOGIN_SCREENSHOTS=/absolute/output and this test filter.
    @Test func renderCredentialFreeRemoteLoginFixtures() async throws {
        guard let directory = ProcessInfo.processInfo.environment["CLAUDEXOR_LOGIN_SCREENSHOTS"] else { return }
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        _ = NSApplication.shared
        for harness in [SetupHarness.claude, .agy, .cursor, .codex] {
            let gateway = RemoteLoginFixtureGateway(harness: harness)
            let session = makeSession(gateway)
            let observing = Task { await session.observe() }
            try await waitUntil { session.lifecycle.deviceCode != nil }
            for (dark, height) in [(false, 610), (true, 610), (false, 420), (true, 420)] {
                let view = NSHostingView(rootView: RemoteLoginContent(session: session, close: {})
                    .frame(width: 600, height: CGFloat(height))
                    .background(.background).environment(\.colorScheme, dark ? .dark : .light))
                let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: CGFloat(height)),
                                      styleMask: [.borderless], backing: .buffered, defer: false)
                window.contentView = view
                window.isReleasedWhenClosed = false
                window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
                view.layoutSubtreeIfNeeded()
                let bitmap = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
                view.cacheDisplay(in: view.bounds, to: bitmap)
                let bytes = try #require(bitmap.representation(using: .png, properties: [:]))
                try bytes.write(to: URL(fileURLWithPath: directory)
                    .appendingPathComponent("\(harness.rawValue)-\(dark ? "dark" : "light")-\(height).png"))
                window.close()
            }
            await session.detach()
            await observing.value
        }
    }

    private func makeSession(_ gateway: RemoteLoginFixtureGateway) -> RemoteLoginSession {
        RemoteLoginSession(gateway: gateway, jobId: gateway.job.jobId,
            isCurrent: { true }, refreshReadiness: { _ in nil })
    }

    // Parallel UI suites can hold the main actor for seconds (#527); the deadline only bounds a failing test.
    private func waitUntil(_ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(60)
        while !predicate(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        #expect(predicate())
        try #require(predicate())
    }
}

@MainActor private final class RemoteLoginFixtureConnection { var current = true }

private final class RemoteLoginFixtureGateway: SetupJobGateway, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: AsyncThrowingStream<SetupJobEvent, Error>.Continuation?
    private var inputContinuation: CheckedContinuation<Void, Never>?
    private var recorded: [String] = []
    private var submitted: [String] = []
    private var sequence = 1
    private var disclosure: SetupDeviceCodeDisclosure
    let job: SetupJob
    var delayInput = false
    var requests: [String] { lock.withLock { recorded } }
    var inputs: [String] { lock.withLock { submitted } }
    var inputIsWaiting: Bool { lock.withLock { inputContinuation != nil } }

    init(harness: SetupHarness) {
        job = Self.makeJob(harness: harness)
        disclosure = SetupDeviceCodeDisclosure(
            flow: harness == .codex ? .chatgptDeviceCode : harness == .cursor ? .oauthUrl : .oauthUrlInput,
            verificationUrl: "https://example.invalid/oauth/authorize?state=fixture-and-a-long-link-for-layout",
            userCode: harness == .codex ? "FIXTURE-42" : "")
    }

    private static func makeJob(harness: SetupHarness, state: SetupJobState = .waitingForInput) -> SetupJob {
        SetupJob(jobId: "setup-remote", harness: harness, action: .login, state: state,
            phase: state == .waitingForInput ? .awaitingUser : .completed,
            deadlineAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(900)), message: state == .waitingForInput
                ? "Complete this sign-in for the selected remote account." : "The sign-in has finished.",
            createdAt: "2026-10-04T00:00:00Z", profileId: "selected-profile")
    }

    func createSetupJob(_ body: SetupJobCreateRequest) async throws -> SetupJob {
        lock.withLock { recorded.append("create") }; return job
    }
    func listSetupJobs(filter: SetupJobListFilter) async throws -> [SetupJob] {
        lock.withLock { recorded.append("list") }; return [job]
    }
    func setupJobSnapshot(jobId: String) async throws -> SetupJobSnapshot {
        lock.withLock {
            recorded.append("snapshot:\(jobId)")
            return SetupJobSnapshot(job: job, cursor: "c\(sequence)", sequence: sequence, deviceCode: disclosure)
        }
    }
    func setupJobEvents(jobId: String, lastEventId: String) -> AsyncThrowingStream<SetupJobEvent, Error> {
        AsyncThrowingStream { stream in
            lock.withLock { recorded.append("events:\(jobId)"); continuation = stream }
        }
    }
    func cancelSetupJob(jobId: String) async throws -> SetupJob {
        lock.withLock { recorded.append("cancel:\(jobId)") }
        return Self.makeJob(harness: job.harness, state: .cancelled)
    }
    func reconcileSetupJob(jobId: String) async throws -> SetupJob { job }
    func extendSetupJob(jobId: String) async throws -> SetupJob { job }
    func submitSetupJobInput(jobId: String, value: String) async throws -> SetupJob {
        lock.withLock { submitted.append("\(jobId):\(value)") }
        if delayInput { await withCheckedContinuation { c in lock.withLock { inputContinuation = c } } }
        return Self.makeJob(harness: job.harness, state: .succeeded)
    }
    func releaseInput() { lock.withLock { inputContinuation?.resume(); inputContinuation = nil } }
    func complete() { emit(Self.makeJob(harness: job.harness, state: .succeeded), disclosure: nil) }
    func updateLink(_ url: String) {
        let next = SetupDeviceCodeDisclosure(flow: disclosure.flow, verificationUrl: url, userCode: disclosure.userCode)
        emit(job, disclosure: next)
    }
    private func emit(_ next: SetupJob, disclosure: SetupDeviceCodeDisclosure?) {
        lock.withLock {
            let previous = "c\(sequence)"
            sequence += 1
            continuation?.yield(SetupJobEvent(jobId: job.jobId, cursor: "c\(sequence)", previousCursor: previous,
                sequence: sequence, time: "2026-10-04T00:00:01Z", state: next.state,
                message: next.message, job: next, deviceCode: disclosure))
        }
    }
}

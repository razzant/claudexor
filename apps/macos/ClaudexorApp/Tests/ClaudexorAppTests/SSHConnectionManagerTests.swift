import ClaudexorKit
import Darwin
import Foundation
import Testing
@testable import ClaudexorApp

@Suite struct SSHConnectionManagerTests {
    @Test func defaultControlSocketPathFitsDarwinLimit() async throws {
        let manager = SSHConnectionManager()
        let factory = try await manager.factory(for: RemoteConnection(sshAlias: "example"))
        #expect(factory.controlPath.hasPrefix("/tmp/cx-\(getuid())-"))
        #expect(factory.controlPath.utf8.count <= 103)
        await manager.shutdown()
        #expect(!FileManager.default.fileExists(
            atPath: URL(fileURLWithPath: factory.controlPath).deletingLastPathComponent().path))
    }

    @Test func refusesASymlinkedControlSocketRoot() async throws {
        let temporary = FileManager.default.temporaryDirectory
            .appendingPathComponent("claudexor-ssh-root-\(UUID().uuidString)")
        let target = temporary.appendingPathComponent("target")
        let link = temporary.appendingPathComponent("link")
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        defer { try? FileManager.default.removeItem(at: temporary) }

        let manager = SSHConnectionManager(socketRoot: link)
        do {
            _ = try await manager.factory(for: RemoteConnection(sshAlias: "example"))
            Issue.record("a symlinked SSH socket root must be refused")
        } catch let error as SSHConnectionError {
            #expect(error.localizedDescription.contains("private app-owned"))
        }
    }

    @Test func cancellingAProcessTaskTerminatesTheChildPromptly() async throws {
        let manager = SSHConnectionManager()
        let invocation = SSHInvocation(
            executable: "/bin/sh",
            arguments: ["-c", "trap 'exit 0' TERM; while :; do sleep 1; done"])
        let started = ContinuousClock.now
        let task = Task {
            try await manager.runForTesting(invocation)
        }
        try await Task.sleep(for: .milliseconds(100))
        task.cancel()
        do {
            _ = try await task.value
            Issue.record("cancelled SSH process unexpectedly succeeded")
        } catch is CancellationError {
            // Not a speed SLA (#705): a loaded runner took 3.5 s. A lost cancellation would
            // instead hang this test until the release step's own time limit.
            #expect(ContinuousClock.now - started < .seconds(20))
        }
        await manager.shutdown()
    }

    /// The drains must not ride the width-limited global pool.
    ///
    /// A candidate release build hung here for three hours: every drain blocks
    /// until its child closes, so on a small-core runner a handful of parallel
    /// invocations parked every pooled thread on a blocking read and no thread
    /// was left to finish one. This runs MORE concurrent large-output children
    /// than the machine has cores; with pool-based drains it deadlocks, with
    /// dedicated threads it completes.
    @Test func concurrentLargeOutputInvocationsCannotStarveTheDrainPool() async throws {
        let width = max(8, ProcessInfo.processInfo.activeProcessorCount * 3)
        try await withThrowingTaskGroup(of: Int.self) { group in
            for _ in 0 ..< width {
                group.addTask {
                    let manager = SSHConnectionManager()
                    let invocation = SSHInvocation(
                        executable: "/bin/sh",
                        arguments: [
                            "-c",
                            "/usr/bin/yes x | /usr/bin/head -c 120000; " +
                                "/usr/bin/yes y | /usr/bin/head -c 120000 >&2",
                        ])
                    let result = try await manager.runForTesting(invocation)
                    await manager.shutdown()
                    return result.stdout.count + result.stderr.count
                }
            }
            var total = 0
            for try await bytes in group { total += bytes }
            #expect(total == width * 240_000)
        }
    }

    @Test func drainsLargeStdoutAndStderrWithoutWaitingForProcessExitFirst() async throws {
        let manager = SSHConnectionManager()
        let invocation = SSHInvocation(
            executable: "/bin/sh",
            arguments: [
                "-c",
                "/usr/bin/yes x | /usr/bin/head -c 200000; " +
                    "/usr/bin/yes y | /usr/bin/head -c 200000 >&2",
            ])
        let result = try await manager.runForTesting(invocation)
        #expect(result.status == 0)
        #expect(result.stdout.count == 200_000)
        #expect(result.stderr.count == 200_000)
        await manager.shutdown()
    }

    @Test func writesLargeStdinWhileDrainingChildOutput() async throws {
        let manager = SSHConnectionManager()
        let invocation = SSHInvocation(
            executable: "/bin/sh",
            arguments: ["-c", "/usr/bin/tee /dev/stderr >/dev/null"])
        let input = Data(repeating: 0x78, count: 2_000_000)

        let result = try await manager.runForTesting(invocation, stdin: input)

        #expect(result.status == 0)
        #expect(result.stdout.isEmpty)
        #expect(result.stderr == input)
        await manager.shutdown()
    }

    @Test func earlyChildExitDoesNotHangLargeStdinWrite() async throws {
        let manager = SSHConnectionManager()
        let invocation = SSHInvocation(
            executable: "/bin/sh",
            arguments: ["-c", "exit 0"])
        let started = ContinuousClock.now

        do {
            _ = try await manager.runForTesting(
                invocation, stdin: Data(repeating: 0x78, count: 2_000_000))
            Issue.record("an incomplete stdin write unexpectedly succeeded")
        } catch let error as SSHConnectionError {
            #expect(error.localizedDescription.contains("could not finish sending"))
        }
        // Not a speed SLA (#705): a loaded runner took 3.2 s. A write stuck on a closed
        // pipe would instead hang this test until the release step's own time limit.
        #expect(ContinuousClock.now - started < .seconds(20))
        await manager.shutdown()
    }

    @Test func repeatedlyWaitsForShortLivedChildrenWithoutMissingTermination() async throws {
        // A post-loop stopwatch cannot end a lost termination notification. The
        // kernel alarm belongs only to this exit-test child, never the test runner;
        // it also bounds a blocked executor. This is a hang guard, not a speed SLA.
        let observed = try #require(await #expect(
            processExitsWith: .success,
            observing: [\.standardOutputContent, \.standardErrorContent]
        ) {
            alarm(30)
            let manager = SSHConnectionManager()
            let invocation = SSHInvocation(
                executable: "/bin/sh",
                arguments: ["-c", "printf ready"])
            let started = ContinuousClock.now

            for index in 0 ..< 50 {
                alarm(30)
                FileHandle.standardError.write(Data("Waiting for child \(index + 1)/50 (30s bound)\n".utf8))
                let result = try await manager.runForTesting(invocation)
                #expect(result.status == 0)
                #expect(result.stdout == Data("ready".utf8))
            }

            print("50 child results checked in \(ContinuousClock.now - started)")
            alarm(30)
            FileHandle.standardError.write(Data("Waiting for shutdown (30s bound)\n".utf8))
            await manager.shutdown()
            // Keep the alarm armed through exit-test teardown; SIGALRM is a
            // failed child result. It is not process-tree cleanup for arbitrary commands.
        })
        print(String(decoding: observed.standardOutputContent, as: UTF8.self))
    }

    @Test func batchFailureClassificationOnlyPromptsForUserInput() {
        #expect(sshBatchFailureNeedsInteraction(
            "user@example: Permission denied (publickey,password,keyboard-interactive)."))
        #expect(sshBatchFailureNeedsInteraction(
            "Host key verification failed."))
        #expect(sshBatchFailureNeedsInteraction(
            "Enter passphrase for key '/Users/me/.ssh/id_ed25519':"))

        #expect(!sshBatchFailureNeedsInteraction(
            "unix_listener: path \"/var/folders/long/socket\" too long for Unix domain socket"))
        #expect(!sshBatchFailureNeedsInteraction(
            "unix_listener: cannot bind to path /tmp/cx/master: Permission denied"))
        #expect(!sshBatchFailureNeedsInteraction(
            "ssh: Could not resolve hostname example: nodename nor servname provided"))
        #expect(!sshBatchFailureNeedsInteraction(
            "ssh: connect to host example port 22: Connection refused"))
        #expect(!sshBatchFailureNeedsInteraction(
            "@@@@@@@@@ REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@@@@@@\n"
                + "Host key verification failed."))
        #expect(!sshBatchFailureNeedsInteraction(""))
    }

    // LogLevel=ERROR does not stop a hostile server from reaching stderr:
    // OpenSSH echoes server-supplied text inside its own ERROR-level
    // disconnect / protocol-identification / banner-exchange lines. Those
    // lines are dropped before matching, so injected prompt markers cannot
    // provoke a false interactive trust prompt.
    @Test func serverEchoedStderrLinesCannotProvokeInteraction() {
        #expect(!sshBatchFailureNeedsInteraction(
            "Received disconnect from 203.0.113.7 port 22:2: "
                + "please retype your password: The authenticity of host"))
        #expect(!sshBatchFailureNeedsInteraction(
            "Bad remote protocol version identification: "
                + "'Enter passphrase for key keyboard-interactive'"))
        #expect(!sshBatchFailureNeedsInteraction(
            "banner exchange: Connection to 203.0.113.7 port 22: password:"))
        #expect(!sshBatchFailureNeedsInteraction(
            "Received disconnect from 203.0.113.7 port 22:2: password:\n"
                + "Disconnected from 203.0.113.7 port 22"))
        // A genuine OpenSSH prompt on its own line still classifies even when
        // a server-echo line precedes it.
        #expect(sshBatchFailureNeedsInteraction(
            "Received disconnect from 203.0.113.7 port 22:2: bye\n"
                + "user@example: Permission denied (publickey,password)."))
    }
}

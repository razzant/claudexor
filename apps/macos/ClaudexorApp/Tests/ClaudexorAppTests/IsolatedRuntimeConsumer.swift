import Foundation
import Testing

/// Foundation's temporaryDirectory can ignore TMPDIR on Darwin. These runtime
/// fixtures honor the runner's explicit directory, including re-executed tests.
var runtimeTestTemporaryDirectory: URL {
    if let path = ProcessInfo.processInfo.environment["TMPDIR"], !path.isEmpty {
        return URL(fileURLWithPath: path, isDirectory: true)
    }
    return FileManager.default.temporaryDirectory
}

/// Default discovery and runtime pointers use process-global paths. Re-execute
/// only the named test with fresh homes instead of mutating the test runner's
/// environment (or touching a developer's installed engine).
@MainActor
func isolatedRuntimeConsumer(
    _ test: String, body: @MainActor () async throws -> Void
) async throws {
    let marker = "CLAUDEXOR_RUNTIME_CONSUMER_TEST"
    if ProcessInfo.processInfo.environment[marker] == test {
        try await body()
        print("ISOLATED-CONSUMER-COMPLETED \(test)")
        return
    }
    let root = runtimeTestTemporaryDirectory
        .appendingPathComponent("cx-\(UUID().uuidString.prefix(8))", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    for name in ["h", "c", "t"] {
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent(name), withIntermediateDirectories: true)
    }
    let log = root.appendingPathComponent("test.log")
    FileManager.default.createFile(atPath: log.path, contents: nil)
    let output = try FileHandle(forWritingTo: log)
    defer { try? output.close() }
    var runner = [CommandLine.arguments[0]]
    // SwiftPM loads macOS test bundles through its helper executable.
    if let index = CommandLine.arguments.firstIndex(of: "--test-bundle-path") {
        runner += ["--test-bundle-path", CommandLine.arguments[index + 1]]
    }
    runner += ["--testing-library", "swift-testing", "--filter", test]
    if let index = CommandLine.arguments.firstIndex(of: "--xunit-output") {
        let parentReport = URL(fileURLWithPath: CommandLine.arguments[index + 1])
        let childReport = parentReport.deletingPathExtension().path
            + "-" + test.replacingOccurrences(of: "/", with: "-") + ".xml"
        runner += ["--xunit-output", childReport]
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = [
        "-i", "HOME=\(root.path)/h", "CFFIXED_USER_HOME=\(root.path)/h",
        "CLAUDEXOR_CONFIG_DIR=\(root.path)/c", "TMPDIR=\(root.path)/t", "TMP=\(root.path)/t",
        "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "\(marker)=\(test)",
    ] + ["DYLD_FRAMEWORK_PATH", "DYLD_LIBRARY_PATH"].compactMap { name in
        ProcessInfo.processInfo.environment[name].map { "\(name)=\($0)" }
    } + runner
    process.standardOutput = output
    process.standardError = output
    try process.run()
    // A fixture defect must not hang the complete suite or leave a child behind.
    let deadline = Date().addingTimeInterval(30)
    while process.isRunning, Date() < deadline {
        try await Task.sleep(for: .milliseconds(20))
    }
    if process.isRunning { process.terminate() }
    process.waitUntilExit()
    let text = String(decoding: try Data(contentsOf: log), as: UTF8.self)
    print(text)
    #expect(text.contains("ISOLATED-CONSUMER-COMPLETED \(test)"))
    #expect(process.terminationStatus == 0, "isolated consumer \(test) failed")
}

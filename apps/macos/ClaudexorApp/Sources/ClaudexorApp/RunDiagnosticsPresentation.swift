import Foundation
import ClaudexorKit

/// Lightweight diagnostics presentation (INV-136). Raw event/rollout/log
/// bodies never enter SwiftUI state; the complete evidence stays in runDir.
enum RunDiagnosticsPresentation {
    static func summary(detail: RunDetail, error: String?) -> String {
        var sections: [String] = []
        let failure = detail.failure ?? detail.summary.failure
        if let failure {
            var lines = [
                "phase: \(failure.phase)",
                "category: \(failure.category)",
                "message: \(failure.safeMessage)"
            ]
            if let harness = failure.harnessId { lines.append("harness: \(harness)") }
            if let attempt = failure.attemptId { lines.append("attempt: \(attempt)") }
            if let ref = failure.rawDetailRef { lines.append("detail: \(ref)") }
            if !failure.eventRefs.isEmpty {
                lines.append("events:\n" + failure.eventRefs.map { "- \($0)" }.joined(separator: "\n"))
            }
            if !failure.logRefs.isEmpty {
                lines.append("logs:\n" + failure.logRefs.map { "- \($0)" }.joined(separator: "\n"))
            }
            if let runDir = failure.runDir { lines.append("runDir: \(runDir)") }
            if !failure.nextActions.isEmpty {
                lines.append("next actions:\n" + failure.nextActions.map { "- \($0)" }.joined(separator: "\n"))
            }
            sections.append("# Failure\n\n" + lines.joined(separator: "\n"))
        }
        if let error, !error.isEmpty { sections.append("# Engine Error\n\n\(error)") }
        if let web = detail.summary.webEvidence, web.attempted || web.required {
            var lines = [
                "status: \(web.status)", "mode: \(web.mode)",
                "required: \(web.required)", "attempted: \(web.attempted)",
                "satisfied: \(web.satisfied)"
            ]
            if let tool = web.tool { lines.append("tool: \(tool)") }
            if let target = web.target { lines.append("target: \(target)") }
            if let error = web.errorSummary { lines.append("error: \(error)") }
            if let ref = web.rawDetailRef { lines.append("detail: \(ref)") }
            sections.append("# Web Evidence\n\n" + lines.joined(separator: "\n"))
        }
        if detail.primaryOutput?.kind == "diagnostic",
           let primary = detail.primaryOutput?.text,
           !primary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let bounded = String(primary.prefix(8_000))
            let suffix = primary.count > 8_000
                ? "\n\n[\(primary.count - 8_000) more characters remain in the artifact.]"
                : ""
            sections.append("# Diagnostic Output\n\n\(bounded)\(suffix)")
        }
        let raw = detail.artifacts.filter {
            $0.path.hasSuffix(".jsonl")
                || $0.path.contains("rollout")
                || $0.path.contains("diagnostic")
                || $0.path.contains("/logs/")
        }
        if !raw.isEmpty {
            let paths = raw.map { artifact in
                artifact.bytes.map { bytes in "- \(artifact.path) · \(bytes) bytes" }
                    ?? "- \(artifact.path)"
            }.joined(separator: "\n")
            sections.append("""
            # Raw diagnostics

            Raw event, rollout, and log bodies are not loaded into the UI. Open the run folder for complete evidence:
            \(paths)
            """)
        }
        if sections.isEmpty {
            let paths = detail.artifacts.map(\.path).joined(separator: "\n")
            sections.append(
                paths.isEmpty
                    ? "No diagnostics artifacts are available yet."
                    : "Artifacts:\n\(paths)")
        }
        return sections.joined(separator: "\n\n")
    }
}

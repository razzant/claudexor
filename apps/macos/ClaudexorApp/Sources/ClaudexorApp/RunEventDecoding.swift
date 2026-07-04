/**
 * Pure decoders from canonical run-event payloads (JSONValue) into UI domain
 * values: pending interactions, pipeline phases, activity titles, findings.
 * Extracted from AppModel.swift (INV-124 ratchet) — no state, no side effects.
 */
import Foundation
import ClaudexorKit

extension AppModel {
    /// The server persisted a refusal on a recorded turn when the HTTP error
    /// body names its `turnId` (thread-turn create/replay paths attach it).
    /// `retryable=false` means no job was recorded (enqueue itself threw), so
    /// the composer should KEEP the draft — retry has nothing to replay.
    static func refusedTurn(from error: Error) -> (turnId: String, retryable: Bool)? {
        guard case GatewayError.http(_, let body) = error,
              let data = body.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let turnId = obj["turnId"] as? String, !turnId.isEmpty
        else { return nil }
        return (turnId, (obj["retryable"] as? Bool) ?? true)
    }

    /// Decode a pending interaction from the interaction.requested event payload.
    static func pendingInteraction(from payload: JSONValue, runId: String) -> PendingInteraction? {
        guard let interactionId = payload["interaction_id"]?.stringValue else { return nil }
        var questions: [InteractionQuestion] = []
        if case .array(let raw)? = payload["questions"] {
            for q in raw {
                guard let text = q["question"]?.stringValue, !text.isEmpty else { continue }
                var options: [InteractionOption] = []
                if case .array(let rawOptions)? = q["options"] {
                    for o in rawOptions {
                        guard let label = o["label"]?.stringValue, !label.isEmpty else { continue }
                        options.append(InteractionOption(label: label, description: o["description"]?.stringValue))
                    }
                }
                questions.append(InteractionQuestion(
                    id: q["id"]?.stringValue ?? "q\(questions.count + 1)",
                    question: text,
                    header: q["header"]?.stringValue,
                    options: options,
                    multiSelect: q["multi_select"]?.boolValue ?? false
                ))
            }
        }
        guard !questions.isEmpty else { return nil }
        return PendingInteraction(
            interactionId: interactionId,
            runId: runId,
            attemptId: payload["attempt_id"]?.stringValue,
            harnessId: payload["harness_id"]?.stringValue,
            sourceTool: payload["source_tool"]?.stringValue,
            questions: questions,
            requestedAt: payload["requested_at"]?.stringValue ?? "",
            timeoutAt: payload["timeout_at"]?.stringValue
        )
    }

    static func phase(for type: String) -> Phase? {
        switch type {
        case "run.created", "task.contract.created": return .contract
        case "context.pack.created": return .context
        case "budget.lease.created", "budget.observation": return .budget
        case "harness.started", "harness.event", "harness.completed": return .envelope
        case "gate.started", "gate.completed": return .gates
        case "review.started", "review.finding.proposed", "finding.revalidated": return .review
        case "synthesis.started": return .synthesis
        case "arbitration.completed": return .arbitration
        case "work_product.emitted", "run.completed", "run.failed": return .final
        default: return nil
        }
    }

    static func title(_ payload: JSONValue?) -> String? {
        payload?["title"]?.stringValue ?? payload?["message"]?.stringValue ?? payload?["summary"]?.stringValue
    }

    /// "review.finding.proposed" -> "Review · finding proposed"
    static func pretty(_ type: String) -> String {
        let parts = type.split(separator: ".")
        guard let head = parts.first else { return type }
        let rest = parts.dropFirst().joined(separator: " ")
        return rest.isEmpty ? head.capitalized : "\(head.capitalized) · \(rest)"
    }

    static func finding(from payload: JSONValue?, taskTitle: String) -> Finding? {
        guard let payload else { return nil }
        let sevRaw = (payload["severity"]?.stringValue ?? "minor").lowercased()
        // NEEDS_HUMAN is the review-queue gate: it must read as blocking, never
        // collapse into a low-priority tint.
        let severity: Severity = sevRaw.contains("block") || sevRaw.contains("needs_human") ? .blocker
            : sevRaw.contains("fix_first") || sevRaw.contains("major") || sevRaw.contains("high") ? .major
            : sevRaw.contains("nit") || sevRaw.contains("low") || sevRaw.contains("out_of_scope") || sevRaw.contains("insufficient_evidence") ? .nit : .minor
        let evidenceFile = payload["file"]?.stringValue ?? payload["path"]?.stringValue ?? Self.firstEvidenceFile(payload)?.path
        let evidenceLine = payload["line"]?.doubleValue.map(Int.init) ?? Self.firstEvidenceFile(payload)?.line
        let reviewerRaw = payload["reviewer"]?.stringValue
            ?? payload["reviewer"]?["harness_id"]?.stringValue
            ?? payload["harness"]?.stringValue
        let routeProofRaw = payload["reviewer"]?["route_proof_status"]?.stringValue
        let title = payload["title"]?.stringValue ?? payload["summary"]?.stringValue ?? payload["claim"]?.stringValue ?? "Finding"
        let detail = payload["detail"]?.stringValue ?? payload["body"]?.stringValue ?? payload["claim"]?.stringValue ?? ""
        return Finding(
            id: payload["id"]?.stringValue ?? UUID().uuidString,
            severity: severity,
            category: payload["category"]?.stringValue ?? "Review",
            title: title,
            detail: detail,
            reviewer: reviewerRaw.flatMap { HarnessFamily(rawValue: $0) } ?? .raw,
            routeProof: Self.routeProof(from: routeProofRaw, routeVerified: payload["route_verified"]?.boolValue ?? false),
            evidenceFile: evidenceFile,
            evidenceLine: evidenceLine,
            status: FindingStatus(api: payload["status"]?.stringValue),
            taskTitle: taskTitle
        )
    }

    private static func firstEvidenceFile(_ payload: JSONValue) -> (path: String?, line: Int?)? {
        guard case .array(let files) = payload["evidence"]?["files"], let first = files.first else { return nil }
        let lines = first["lines"]?.stringValue
        let line = lines.flatMap { raw in raw.split(separator: "-").first.map(String.init).flatMap(Int.init) }
        return (first["path"]?.stringValue, line)
    }

    private static func routeProof(from raw: String?, routeVerified: Bool) -> RouteProof {
        if routeVerified { return .verified }
        switch raw {
        case "verified": return .verified
        case "accepted_model_arg": return .acceptedModelArg
        case "same_model_fallback": return .sameModelFallback
        default: return .unverified
        }
    }
}

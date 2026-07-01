import Foundation

public enum ComposerOptionParser {
    private static let efforts: Set<String> = ["low", "medium", "high", "xhigh", "max"]

    public static func splitOptionTokens(_ text: String) -> [String] {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        return text
            .split(omittingEmptySubsequences: false, whereSeparator: { $0 == "," || $0 == "\n" })
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    }

    public static func parseReviewerPanelEntry(_ raw: String) -> ReviewerPanelEntry? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let eq = trimmed.firstIndex(of: "=")
        var effort: String?
        var harness = (eq == nil ? trimmed : String(trimmed[..<eq!]))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        var rest = ""
        if let eq {
            rest = String(trimmed[trimmed.index(after: eq)...])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !rest.isEmpty else { return nil }
        } else if let colon = harness.lastIndex(of: ":") {
            let suffix = String(harness[harness.index(after: colon)...])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard efforts.contains(suffix) else { return nil }
            effort = suffix
            harness = String(harness[..<colon]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard !harness.isEmpty else { return nil }

        var model = rest.isEmpty ? nil : rest
        if let currentModel = model, let colon = currentModel.lastIndex(of: ":") {
            let suffix = String(currentModel[currentModel.index(after: colon)...])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if efforts.contains(suffix) {
                effort = suffix
                let stripped = String(currentModel[..<colon])
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                guard !stripped.isEmpty else { return nil }
                model = stripped
            }
        }
        return ReviewerPanelEntry(harness: harness, model: model, effort: effort)
    }

    public static func parseProtectedPathApproval(_ raw: String) -> ProtectedPathApproval? {
        let parts = raw
            .split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard let path = parts.first, !path.isEmpty else { return nil }
        let reason = parts.count == 2 && !parts[1].isEmpty ? parts[1] : nil
        return ProtectedPathApproval(path: path, reason: reason)
    }
}

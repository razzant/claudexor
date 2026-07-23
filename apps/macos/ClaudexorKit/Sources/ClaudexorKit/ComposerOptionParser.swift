import Foundation

public enum ComposerOptionParser {
    public static func splitOptionTokens(_ text: String) -> [String] {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        return text
            .split(omittingEmptySubsequences: false, whereSeparator: { $0 == "," || $0 == "\n" })
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    }

    /// Split a command line into argv tokens for the composer's optional
    /// Test-command field (QA-010). A minimal POSIX-ish tokenizer — NOT a shell:
    /// whitespace separates tokens; single and double quotes group spaces into
    /// one argument; a backslash escapes the next character. There is no globbing,
    /// no pipes/redirection, and no variable expansion — the tokens become a
    /// `TestCommandInvocation.args` array the engine runs directly. An unbalanced
    /// quote is closed at end-of-input (best-effort, never a crash).
    public static func parseCommandArgv(_ text: String) -> [String] {
        tokenizeArgv(text).tokens
    }

    /// A malformed command line. Surfaced as a typed error instead of the lenient
    /// tokenizer's silent best-effort recovery.
    public enum CommandArgvError: Error, Equatable {
        /// It ended INSIDE an unterminated quote (`go "test`).
        case unterminatedQuote(Character)
        /// It ended on a TRAILING backslash — an escape with nothing to escape
        /// (`run foo\`). The lenient tokenizer silently DROPPED that backslash;
        /// strict parsing rejects the input instead of sending a mangled argv.
        case danglingEscape
    }

    /// Strict tokenizer: an unterminated quote OR a trailing dangling backslash at
    /// end-of-input is a THROWN typed error rather than a best-effort recovery, so a
    /// malformed `go "test` never slips through as `go test` and a trailing `foo\`
    /// never silently loses its backslash. The Create Test-command field uses this;
    /// the lenient `parseCommandArgv` above stays best-effort for any other caller.
    public static func parseCommandArgvStrict(_ text: String) throws -> [String] {
        let result = tokenizeArgv(text)
        if let quote = result.openQuote { throw CommandArgvError.unterminatedQuote(quote) }
        if result.danglingEscape { throw CommandArgvError.danglingEscape }
        return result.tokens
    }

    /// Shared tokenizer. `openQuote` is the quote char still open at end-of-input
    /// (nil when balanced); `danglingEscape` is true when the input ended mid-escape
    /// (a trailing backslash). The lenient API drops BOTH; the strict API throws.
    private static func tokenizeArgv(_ text: String) -> (tokens: [String], openQuote: Character?, danglingEscape: Bool) {
        var tokens: [String] = []
        var current = ""
        var hasToken = false
        var quote: Character? = nil
        var escape = false
        for ch in text {
            if escape {
                current.append(ch); hasToken = true; escape = false; continue
            }
            if ch == "\\" && quote != "'" {
                escape = true; hasToken = true; continue
            }
            if let q = quote {
                if ch == q { quote = nil } else { current.append(ch) }
                hasToken = true
                continue
            }
            if ch == "'" || ch == "\"" {
                quote = ch; hasToken = true; continue
            }
            if ch == " " || ch == "\t" || ch == "\n" {
                if hasToken { tokens.append(current); current = ""; hasToken = false }
                continue
            }
            current.append(ch); hasToken = true
        }
        if hasToken { tokens.append(current) }
        return (tokens, quote, escape)
    }

    /// Build a single `TestCommandInvocation` from the composer Test-command
    /// field. Returns nil when the field is blank (no gate) — the first token is
    /// the program, the rest its args (QA-010). Pure + tested.
    public static func parseTestCommand(_ text: String) -> TestCommandInvocation? {
        let argv = parseCommandArgv(text)
        guard let program = argv.first, !program.isEmpty else { return nil }
        return TestCommandInvocation(program: program, args: Array(argv.dropFirst()))
    }

    /// Strict Test-command parse for the Create field: THROWS `CommandArgvError`
    /// on an unterminated quote (so it's blocked + surfaced, never silently sent),
    /// returns nil for a blank/program-less field (no gate). Pure + tested.
    public static func parseTestCommandStrict(_ text: String) throws -> TestCommandInvocation? {
        let argv = try parseCommandArgvStrict(text)
        guard let program = argv.first, !program.isEmpty else { return nil }
        return TestCommandInvocation(program: program, args: Array(argv.dropFirst()))
    }

    public static func parseNonnegativeFiniteDouble(_ text: String) -> Double? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "$", with: "")
        guard let value = Double(trimmed), value.isFinite, value >= 0 else { return nil }
        return value
    }

    public static func parseReviewerPanelEntry(
        _ raw: String, effortLevels: Set<String> = []
    ) -> ReviewerPanelEntry? {
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
            guard effortLevels.contains(suffix) else { return nil }
            effort = suffix
            harness = String(harness[..<colon]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard !harness.isEmpty else { return nil }

        var model = rest.isEmpty ? nil : rest
        if let currentModel = model, let colon = currentModel.lastIndex(of: ":") {
            let suffix = String(currentModel[currentModel.index(after: colon)...])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if effortLevels.contains(suffix) {
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

    // MARK: - Structured-editor → wire-token mapping (UI cut 3, §3)
    //
    // The humane Advanced pickers build the SAME `harness=model:effort` /
    // `glob:reason` tokens the raw power-syntax fields accept, so one wire
    // grammar has one owner. Pure + tested; the views only bind to these.

    /// Build the reviewer wire token for one structured picker row. Empty
    /// harness ⇒ nil (an incomplete row contributes nothing). Grammar:
    /// `harness`, `harness:effort`, `harness=model`, `harness=model:effort`.
    public static func reviewerWireToken(
        harness: String, model: String?, effort: String?
    ) -> String? {
        let h = harness.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !h.isEmpty else { return nil }
        let m = (model ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let e = (effort ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        var token = h
        if !m.isEmpty { token += "=\(m)" }
        if !e.isEmpty { token += ":\(e)" }
        return token
    }

    /// Serialize a `ReviewerPanelEntry` back to its canonical wire token, so the
    /// raw power-syntax field can be prefilled from the structured picker.
    public static func reviewerWireToken(_ entry: ReviewerPanelEntry) -> String? {
        reviewerWireToken(harness: entry.harness, model: entry.model, effort: entry.effort)
    }

    /// Build the protected-path approval wire token for one list-editor row.
    /// Empty path ⇒ nil (an incomplete row contributes nothing). Grammar:
    /// `glob` or `glob:reason`.
    public static func protectedApprovalWireToken(path: String, reason: String?) -> String? {
        let p = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !p.isEmpty else { return nil }
        let r = (reason ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return r.isEmpty ? p : "\(p):\(r)"
    }

    /// Serialize a `ProtectedPathApproval` back to its wire token.
    public static func protectedApprovalWireToken(_ approval: ProtectedPathApproval) -> String? {
        protectedApprovalWireToken(path: approval.path, reason: approval.reason)
    }

    /// Join structured editor rows into the comma-separated string both the raw
    /// power field and the send path consume (skipping incomplete rows).
    public static func joinReviewerTokens(_ entries: [ReviewerPanelEntry]) -> String {
        entries.compactMap(reviewerWireToken).joined(separator: ", ")
    }

    public static func joinApprovalTokens(_ approvals: [ProtectedPathApproval]) -> String {
        approvals.compactMap(protectedApprovalWireToken).joined(separator: ", ")
    }
}

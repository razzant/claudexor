import Foundation
import ClaudexorKit

/// Registered-project registry access (QA-072): the source of the composer's
/// nesting-overlap disclosure. Split out of the AppModel god-file (complexity
/// ratchet) so the honest-failure fix lives with its own small, testable surface.
extension AppModel {
    /// Load the registered-project registry so the composer can disclose nesting
    /// overlap. Returns whether the fetch SUCCEEDED. A failed GET must NOT keep
    /// presenting the previous registry as current truth — the composer would then
    /// show STALE nesting overlap (contradicting this call's contract that a fetch
    /// failure leaves nesting UNDISCLOSED). On failure the registry is cleared so
    /// nesting is genuinely undisclosed until the next good fetch (round-4 #4).
    /// Best-effort — the path MRU still drives selection; this never blocks.
    @discardableResult
    func refreshProjects() async -> Bool {
        guard let client else { return false }
        guard let list = try? await client.listProjects() else {
            registeredProjects.removeAll()
            return false
        }
        registeredProjects = list.projects
        return true
    }

    /// Disclosed nesting relations for a project ROOT (QA-072); empty when the
    /// root is disjoint or unregistered. Matched on the canonical registry root.
    func projectNesting(forRoot root: String) -> [ProjectNesting] {
        let target = root.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !target.isEmpty else { return [] }
        return registeredProjects.first { $0.root == target }?.nesting ?? []
    }
}

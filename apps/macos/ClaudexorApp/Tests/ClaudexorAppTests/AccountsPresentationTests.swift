import Foundation
import Testing
@testable import ClaudexorApp

/// Owner dogfood: the internal profile id is DERIVED, never typed. The
/// generator must always emit a server-valid slug, unique per harness.
@Suite struct AccountsPresentationTests {
    @MainActor
    @Test func draftAccountSelectionPersistsAndClearsInTheOneAccountsSurface() async {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        await model.setThreadCredentialProfile("work", harnessId: "claude")
        #expect(model.draftCredentialProfileId == "work")
        #expect(model.draftPrimaryHarness == "claude")
        await model.setThreadCredentialProfile(nil)
        #expect(model.draftCredentialProfileId == nil)
    }

    @Test func generatedIdSlugifiesTheDisplayName() {
        #expect(AccountsPresentation.generatedProfileId(displayName: "Work", existing: []) == "work")
        #expect(AccountsPresentation.generatedProfileId(displayName: "Experiment A (max)", existing: [])
            == "experiment-a-max")
        // Non-latin names fall back to the auto id instead of an invalid slug.
        #expect(AccountsPresentation.generatedProfileId(displayName: "個人アカウント", existing: []) == "acct")
        #expect(AccountsPresentation.generatedProfileId(displayName: "", existing: []) == "acct")
    }

    @Test func generatedIdIsUniqueAndAlwaysValid() {
        #expect(AccountsPresentation.generatedProfileId(displayName: "Work", existing: ["work"]) == "work-2")
        #expect(AccountsPresentation.generatedProfileId(displayName: "", existing: ["acct", "acct-2"]) == "acct-3")
        // Every derivation the UI can produce passes the server's slug rule.
        for name in ["Work", "  ", "--weird__", "Ελληνικό όνομα", String(repeating: "x", count: 200)] {
            let id = AccountsPresentation.generatedProfileId(displayName: name, existing: ["acct"])
            #expect(AccountsPresentation.isValidSlug(id), "invalid slug for \(name): \(id)")
        }
    }
}

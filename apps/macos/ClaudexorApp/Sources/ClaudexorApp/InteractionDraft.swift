import SwiftUI

struct InteractionDraft {
    var selections: [String: Set<String>] = [:]
    var freeText: [String: String] = [:]
}

extension ConversationPresentation {
    /// Reading an unedited card allocates no state. Only user edits persist;
    /// neither mounting nor evicting a DTO creates or deletes an answer draft.
    func interactionDraft(runID: String, interactionID: String) -> Binding<InteractionDraft> {
        Binding(get: { self.interactionDrafts[runID]?[interactionID] ?? InteractionDraft() },
            set: { self.interactionDrafts[runID, default: [:]][interactionID] = $0 })
    }

    func resolveInteraction(runID: String, interactionID: String) {
        interactionDrafts[runID]?[interactionID] = nil
        if interactionDrafts[runID]?.isEmpty == true { interactionDrafts[runID] = nil }
    }
}

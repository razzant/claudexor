import SwiftUI
import ClaudexorKit

// Composer routing, selection, and strategy projections. These remain pure
// views over the owning screen's state and AppModel; send availability and the
// actual submission continue to consume the same resolved values.
extension ThreadsScreen {
    var browserPolicy: ComposerBrowserPolicy {
        .init(
            selectedAccess: threadAccessSelection.suggestedAccess,
            selectedWebPolicy: selectedWebPolicy,
            browserArmed: browser,
            browserAvailable: browserAvailableForCurrentTurn)
    }

    var effectiveBrowserArmed: Bool { browserPolicy.effectiveBrowserArmed }
    var effectiveAccess: AccessProfile { browserPolicy.effectiveAccess }
    var effectiveWebPolicy: String { browserPolicy.effectiveWebPolicy }

    func reconcileComposerAccess(_ recordedWire: String?) {
        threadAccessSelection = .resolve(
            recordedWire: recordedWire,
            defaultAccess: model.composerAccessDefault)
        agentStrategy = agentStrategy.reconciling(
            access: threadAccessSelection.suggestedAccess)
    }

    var poolFamilies: [HarnessFamily] { model.selectableHarnesses.filter { $0 != .fake && $0 != .raw } }

    /// The harness that will answer in chat (sticky thread primary > global default).
    var primaryFamily: HarnessFamily? {
        model.effectivePrimaryHarness.flatMap { HarnessFamily(rawValue: $0) }
    }
    /// The eligible pool (Best-of runs this); resolved from thread sticky > global.
    var resolvedPoolFamilies: [HarnessFamily] {
        model.effectiveEligiblePool.map { HarnessFamily(rawValue: $0) }
    }
    /// The families the popover PRESENTS as included in the pool (QA-011): the
    /// Auto sentinel EXPANDED to the currently available/routable families for
    /// this intent (matching the highlighted chips), or the explicit subset when
    /// pinned. The per-harness model rows and the selection pruning both consume
    /// THIS — so the two Auto projections (chips vs rows) can never disagree. The
    /// wire pool stays the empty Auto sentinel; Auto is never materialized into an
    /// explicit harness list merely to render.
    var effectiveIncludedFamilies: [HarnessFamily] {
        // The same lanes the chips render (#133): Auto expands to its own set; an
        // explicit subset, manual lanes included, stays exactly itself.
        HarnessPoolPresentation
            .includedFamilies(pool: model.effectiveEligiblePool, available: HarnessPoolSection.autoAvailable(poolEntries))
            .map { HarnessFamily(rawValue: $0) }
    }
    /// The thread/draft's pinned credential profile (M9-UX item 2): the composer
    /// Harness+Account chip's per-thread override. nil = follow the harness default.
    var composerPinnedProfileId: String? {
        model.selectedThreadId == nil
            ? model.draftCredentialProfileId
            : model.currentThread?.credentialProfileId
    }

    var composerSelectionContext: ComposerSelectionContext {
        let target = model.composerTurnStartTarget
        return .init(
            locationID: target.locationID.rawValue,
            threadID: target.threadID,
            repoRoot: target.repoRoot
        )
    }

    var councilMemberLimit: Int {
        composerCouncilMemberLimit(model.activeSettingsSnapshot)
    }

    var resolvedComposerStrategy: ComposerStrategyResolution {
        resolveComposerStrategy(
            intent: composerMode,
            agentStrategy: agentStrategy,
            delegate: DelegationPresentation.requestedForWire(
                isOn: delegate, control: delegateControlState),
            councilEnabled: councilEnabled,
            councilMembers: councilMembers,
            maxCouncilMembers: councilMemberLimit)
    }

    /// The exact options `send()` passes to AppModel. Availability reads this
    /// same value, so hidden strategy fields cannot classify a different request.
    var resolvedComposerOptions: TurnOptions {
        var options = currentOptions
        let repair = composerRepairWire(
            mode: resolvedComposerStrategy.mode,
            access: effectiveAccess,
            requestedAttempts: options.maxAttempts,
            requestedUntilClean: resolvedComposerStrategy.untilClean)
        options.maxAttempts = repair.attempts
        options.untilClean = repair.untilClean == true
        options.delegate = resolvedComposerStrategy.delegate
        options.council = resolvedComposerStrategy.council
        options.councilN = resolvedComposerStrategy.councilN
        return options
    }

    var composerApplicabilityBlocker: String? {
        model.turnStartAdmission(
            target: model.composerTurnStartTarget,
            mode: resolvedComposerStrategy.mode,
            options: resolvedComposerOptions).interactionBlocker
    }

    var isolatedWorkspaceApplicabilityBlocker: String? {
        model.turnStartAdmission(
            target: model.composerTurnStartTarget.replacingDraftWorkspace(.isolated),
            mode: resolvedComposerStrategy.mode,
            options: resolvedComposerOptions).finalBlocker
    }
}

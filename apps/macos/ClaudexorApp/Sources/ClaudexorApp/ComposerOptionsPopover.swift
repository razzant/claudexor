import SwiftUI
import AppKit
import ClaudexorKit

// MARK: - Composer "⋯" options popover
//
// Extracted from `ThreadsScreen.swift` (INV-124 readability ratchet): the
// advanced per-turn options panel, split out so the composer surface stays a
// small, single-owner unit. Pure move — zero behavior change.

extension ThreadsScreen {
    /// Delegate readiness is one engine projection for the selected primary
    /// route plus the draft's typed access profile. The control stays visible
    /// when unavailable so the user sees the concrete repair/update path.
    var delegateControlState: DelegationPresentation.ControlState {
        let families = primaryFamily.map { [$0] } ?? effectiveIncludedFamilies
        return DelegationPresentation.control(
            capabilities: families.map { model.harnessInfo(for: $0)?.delegation },
            hasFullAccess: effectiveAccess.satisfiesFullAccessRequirement
        )
    }

    /// The effective per-turn credential route for MODEL enumeration (W20):
    /// the thread's sticky auth preference (falling back to the global
    /// default) mapped onto the ?route= vocabulary. Auto = nil = unfiltered —
    /// either route may win at run time, so nothing is hidden.
    var composerModelsRoute: String? {
        // The per-turn Auth route picker (W18) WINS over the sticky thread /
        // global preference: it is the route this very turn will request.
        // Empty = "Thread default" — no override, the sticky preference governs.
        let preference = !authRoutePreference.isEmpty
            ? authRoutePreference
            : (model.currentThread?.authPreference ?? model.activeSettingsSnapshot?.routing.authPreference)
        return modelsRouteParam(forAuthPreference: preference)
    }

    /// The RESOLVED pool's advertised effort ladders merged weakest → strongest;
    /// a sticky primary narrows to its own ladder. One scalar effort rides the
    /// run — adapters resolve it individually against the routed model. Each
    /// manifest ladder is already in the VENDOR's own order, so the picker
    /// ordering is a positional merge (`EffortLadder`), never a rank table —
    /// a level added upstream sorts at its vendor position with no app change.
    ///
    /// Per-turn model selections narrow each family's ladder the same way the
    /// Settings row and the engine do (`effortLevelsForModel`): the chosen
    /// model's own recorded ladder when the manifest has one, else the
    /// harness-wide merged ladder — so picking a model that stops at `xhigh`
    /// no longer offers a sibling-only `ultra` for this turn.
    ///
    /// With NO per-turn selection the turn still runs on a concrete model: the
    /// persisted per-harness `defaultModel` (settings snapshot) when one is
    /// pinned. Its ladder narrows the menu the same way — otherwise the picker
    /// offered (and the run requested) sibling-only levels out of the
    /// harness-wide union that the pinned default model rejects.
    var composerEffortLevels: [String] {
        let families = primaryFamily.map { [$0] }
            ?? (resolvedPoolFamilies.isEmpty ? poolFamilies : resolvedPoolFamilies)
        return EffortLadder.merge(families.map { family in
            guard let info = model.harnessInfo(for: family) else { return [] }
            let chosen = (composerModels[family.rawValue] ?? "")
                .trimmingCharacters(in: .whitespaces)
            let persisted = (model.activeDefaultModel(for: family.rawValue) ?? "")
                .trimmingCharacters(in: .whitespaces)
            let effective = chosen.isEmpty ? persisted : chosen
            if !effective.isEmpty, let perModel = info.modelEffortLevels[effective], !perModel.isEmpty {
                return perModel
            }
            return info.effortLevels
        })
    }

    /// The advanced options popover ("⋯"): clean SOLID sections on the popover's
    /// own material — harness pool, per-turn budget/access/web, agent repair strategies.
    var composerOptions: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            OptionSection(title: "Harness pool — Best-of runs these; the primary answers in chat") {
                // Auto chip + Auto-eligible harnesses, then the Manual only group
                // (#133). The sticky pool is the thread's explicit selection; the
                // primary chip stays a preference that Auto may route around.
                HarnessPoolSection(
                    entries: poolEntries,
                    pool: model.effectiveEligiblePool,
                    selectAuto: {
                        Task { await model.setEligiblePool(HarnessPoolPresentation.selectingAuto()) }
                    },
                    toggle: togglePool)
            }
            OptionSection(title: "Models — per harness for THIS turn") {
                ComposerModelsSection(
                    families: effectiveIncludedFamilies,
                    primary: primaryFamily,
                    route: composerModelsRoute,
                    selections: $composerModels,
                    catalogs: $poolModelCatalogs,
                    fetch: { [route = composerModelsRoute] family in
                        await model.harnessModels(for: family, route: route)
                    }
                )
            }
            OptionRow(label: "Budget") {
                HStack(spacing: Theme.Spacing.xs) {
                    Text("$").foregroundStyle(.secondary)
                    TextField("default", text: $capUsdText)
                        .frame(maxWidth: 90)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                    if capUsdInvalid {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange).font(.caption)
                            .help("Must be a finite non-negative number, or empty for the default")
                    }
                }
                .help("Per-turn budget cap (USD). Empty = engine / thread default.")
            }
            // The Access control moved to the composer's main controls row
            // (AccessChip, W19) — the popover keeps only the secondary knobs.
            OptionRow(label: "Web") {
                Picker("", selection: $selectedWebPolicy) {
                    Text("Auto").tag("auto"); Text("Off").tag("off")
                    Text("Cached").tag("cached"); Text("Live").tag("live")
                }
                .labelsHidden()
                .fixedSize()
                .help("External-context policy for this turn")
            }
            // Per-turn reasoning effort: ONE scalar rides the run and each
            // adapter's normalizer clamps it onto its own declared ladder, so
            // the picker offers the UNION of the resolved pool's ladders (a
            // sticky primary narrows it to that harness). Hidden only when no
            // routable harness declares a ladder (adapter capability truth).
            if !composerEffortLevels.isEmpty {
                OptionRow(label: "Effort") {
                    Picker("", selection: $effortPreference) {
                        Text("Harness default").tag("")
                        ForEach(composerEffortLevels, id: \.self) { Text($0.capitalized).tag($0) }
                    }
                    .labelsHidden()
                    .fixedSize()
                    .help("Requested reasoning effort for THIS turn. Each harness resolves it against the ladder its routed model actually advertises.")
                }
            }
            // Per-turn auth route REQUEST (W18/R20) over the thread preference.
            // Honest language: this is what we ASK for — auto may switch routes
            // (typed fallback), and the run badge discloses the effective route.
            // "Thread default" (empty) sends NO override; every other choice —
            // Auto included — rides the turn explicitly, so Auto genuinely
            // overrides an api_key-pinned thread instead of inheriting it.
            OptionRow(label: "Auth route") {
                Picker("", selection: $authRoutePreference) {
                    Text("Thread default").tag("")
                    Text("Auto").tag("auto")
                    Text("Subscription").tag("subscription")
                    Text("API key").tag("api_key")
                }
                .labelsHidden()
                .fixedSize()
                .help("Requested auth route for THIS turn. Thread default keeps the thread/global preference; Auto prefers the native subscription session with a typed, policy-governed fallback.")
            }
            Text("Requested route: \(Self.authRouteCaption(authRoutePreference)). Auto may switch routes; the run's badge shows the route actually taken.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .padding(.leading, 2)
                .fixedSize(horizontal: false, vertical: true)
            // Per-thread account pinning was REMOVED (INV-135): accounts, their
            // logins, quotas, and the auto-balance toggle all live in the
            // bottom-left accounts popover now. Runs use the default account
            // unless engine auto-balance rotates at a quota limit.
            // Review controls (owner round-3): Reviewers + Approvals moved under
            // a collapsed "Advanced" DisclosureGroup with a structured reviewer
            // picker + an approvals list editor (ComposerReviewControls). One
            // parent-owned draft projects the exact values the send path reads.
            if runControlApplicability.reviewers.applicable {
                OptionSection(title: "Review controls") {
                    let strategyRequiresReview = agentStrategy == .bestOf || agentStrategy == .untilClean
                    let panelRequestsReview = !reviewerPanelEntries.isEmpty
                    Toggle("Review changes", isOn: Binding(
                        get: { reviewChanges || strategyRequiresReview || panelRequestsReview },
                        set: { reviewChanges = $0 }
                    ))
                    .toggleStyle(.switch).tint(Theme.accent)
                    .disabled(strategyRequiresReview || panelRequestsReview)
                    Text(strategyRequiresReview
                         ? "This strategy includes model review."
                         : panelRequestsReview
                            ? "Your reviewer panel enables review. Remove the panel to turn review off."
                            : reviewChanges
                                ? "Claudexor selects an internal reviewer panel automatically."
                                : "No internal reviewers. Completed changes remain applicable and show Not reviewed.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    AdvancedReviewControls(
                        draft: $reviewDraft,
                        harnessChoices: poolFamilies,
                        effortLevels: composerEffortLevels,
                        reviewerRawInvalid: reviewerPanelInvalid)
                }
            }
            // Agent-driven browser (Playwright MCP). Offered only where a pooled
            // harness can inject it. Access remains an independent request axis;
            // the daemon refuses unsupported native harness/access combinations.
            if browserAvailableForCurrentTurn {
                OptionRow(label: "Browser") {
                    Toggle("", isOn: Binding(
                        get: { browser },
                        set: { on in
                            browser = on
                        }
                    ))
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .tint(Theme.accent)
                    .help("Let the agent drive a real browser (navigate / screenshot / read). Runs headed so you watch the real window live; navigation snapshots are recorded in the run.")
                }
                if effectiveBrowserArmed {
                    Text("Agent browses in a real window · keeps \(effectiveAccess.label)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 2)
                }
            }
            // Context depth is engine-owned "auto"; the retired "deep" tier and
            // its picker were removed in the v0.15 triage.
            // Workspace mode is FIXED at thread creation, so it's only editable while
            // drafting the first turn (no thread selected yet). Isolated keeps a thread
            // worktree; in_place (default) mutates the live tree so the next turn sees it.
            if model.selectedThreadId == nil {
                OptionSection(title: "Workspace") {
                    Toggle("Isolated workspace", isOn: Binding(
                        get: { model.draftIsolatedWorkspace },
                        set: { model.draftIsolatedWorkspace = $0 }
                    ))
                    .toggleStyle(.switch).tint(Theme.accent)
                    .disabled(
                        !model.draftIsolatedWorkspace
                            && isolatedWorkspaceApplicabilityBlocker != nil)
                    .help(isolatedWorkspaceApplicabilityBlocker
                        ?? "Turns accumulate in a separate worktree; apply them to the project later with “Apply thread”. Off = in-place (the next turn sees prior edits).")
                    if !model.draftIsolatedWorkspace,
                       let blocker = isolatedWorkspaceApplicabilityBlocker {
                        Label(blocker, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption2)
                            .foregroundStyle(Theme.status(.caution))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            // Agent STRATEGY knob (D24): Single / Best-of / Until-clean / Create
            // — the old distinct intents are now a per-turn knob. Delegate (D32)
            // rides alongside; Max-attempts caps the single/until-clean repair.
            if composerMode == .agent {
                OptionSection(title: "Agent strategy") {
                    Picker("", selection: $agentStrategy) {
                        ForEach(AgentStrategy.composerCases(access: effectiveAccess)) { s in
                            Label(s.label, systemImage: s.glyph).tag(s)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.segmented)
                    .help(agentStrategy.blurb)
                    // Max-attempts caps the single/until-clean repair loop; it is
                    // meaningless for a Best-of race, so it hides there.
                    if effectiveAccess != .readOnly
                        && (agentStrategy == .single || agentStrategy == .untilClean) {
                        HStack(spacing: Theme.Spacing.xl) {
                            Stepper("Max attempts: \(maxAttempts)", value: $maxAttempts, in: 1...8)
                                .disabled(agentStrategy == .untilClean)
                                .help(agentStrategy == .untilClean
                                      ? "Disabled while Until clean is on (no fixed cap)"
                                      : "Hard cap on repair attempts")
                        }
                    }
                    let delegateState = delegateControlState
                    Toggle("Delegate — let the agent spawn bounded sub-runs", isOn: $delegate)
                        .toggleStyle(.switch).tint(Theme.accent)
                        .disabled(!delegateState.available)
                        .help(delegateState.explanation)
                        .accessibilityHint(delegateState.explanation)
                        .onChange(of: delegateState.available) { _, _ in
                            delegate = DelegationPresentation.visibleToggleValue(
                                isOn: delegate,
                                control: delegateState
                            )
                        }
                        .onAppear {
                            delegate = DelegationPresentation.visibleToggleValue(
                                isOn: delegate,
                                control: delegateState
                            )
                        }
                    if !delegateState.available {
                        Label(delegateState.explanation, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption2)
                            .foregroundStyle(Theme.status(.caution))
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityLabel("Delegate unavailable")
                            .accessibilityValue(delegateState.explanation)
                    }
                    // QA-010: Create scaffolds a brand-new project, so its test
                    // script does not exist until the run writes it — yet the
                    // operator already knows the command they expect (`npm test`).
                    // Offer ONE optional typed gate field here to add deterministic
                    // evidence alongside the selected review policy. The engine runs
                    // it after the candidate; it is never inferred from the prompt.
                    if agentStrategy == .create { testCommandField }
                }
            }
            // Plan STRATEGY knob (D31): Council draft-and-merge across N harnesses,
            // presented to the user as ONE plan + ONE question set.
            if composerMode == .plan {
                OptionSection(title: "Plan strategy") {
                    Toggle("Council — N harnesses draft in parallel, primary merges", isOn: $councilEnabled)
                        .toggleStyle(.switch).tint(Theme.accent)
                        .help("Council: each member drafts a plan in its own lane; the primary merges them into one plan and one question set. Solo (off) is the default.")
                    if councilEnabled {
                        let memberSelection = Binding(
                            get: { resolvedComposerStrategy.councilN ?? 2 },
                            set: { councilMembers = $0 }
                        )
                        Stepper("Members: \(memberSelection.wrappedValue)", value: memberSelection, in: 2...councilMemberLimit)
                            .help("How many harnesses draft in parallel (2–\(councilMemberLimit)).")
                    }
                }
            }
            }
            .padding(Theme.Spacing.lg)
        }
        .frame(width: Theme.Layout.composerOptionsWidth, alignment: .leading)
        .frame(maxHeight: ComposerOptionsLayout.currentMaximumHeight)
        .scrollIndicators(.visible)
        // Root-level text selection for the options popover (batch-6 item c / §2.9).
        .textSelection(.enabled)
        // Animated popover resizes SIGSEGV on macOS 26.x: growing the
        // content (expanding "Advanced", strategy sections) makes
        // PopoverHostingView animate `setFrame:` inside windowDidLayout,
        // whose nested run loop hits a dead UpdateCycle observer
        // (crash at pc=0). Non-animated resizes never enter that path,
        // so every in-popover state change must run animation-free.
        .transaction { $0.disablesAnimations = true }
    }

    /// QA-010: the optional Create-turn deterministic test command. ONE honest
    /// field — whitespace-split argv with documented quoting — that rides the
    /// run's typed `tests` gate. Not a full editor.
    @ViewBuilder var testCommandField: some View {
        OptionRow(label: "Test command") {
            HStack(spacing: Theme.Spacing.xs) {
                TextField("e.g. npm test", text: $testCommandText)
                    .frame(maxWidth: 180)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.caption, design: .monospaced))
                if testCommandInvalid {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange).font(.caption)
                        .help("Enter a command (the first word is the program), or leave it empty")
                }
            }
            .help("Optional deterministic gate run AFTER the candidate scaffolds the project (e.g. `npm test`). Whitespace-separated argv — the first word is the program, the rest its arguments; wrap an argument that contains spaces in quotes (\"my dir\"), and backslash-escape a literal quote. Not a shell: no pipes, globs, or variables. Empty adds no test command. Model review follows the review controls above.")
        }
    }

    /// The wire value the per-turn picker sends: empty ("Thread default") is
    /// NO override; everything else — explicit "auto" included — rides the
    /// turn and beats the sticky thread/global preference (sol review #1).
    static func authRouteRequest(_ preference: String) -> String? {
        preference.isEmpty ? nil : preference
    }

    /// Human caption for the requested-route disclosure line. Static + pure
    /// so the request vocabulary has a unit test.
    static func authRouteCaption(_ preference: String) -> String {
        switch preference {
        case "": return "Thread default"
        case "api_key": return "API key"
        default: return preference.capitalized
        }
    }

    /// One lane per pool harness for the current intent and project scope (#133).
    var poolEntries: [HarnessPoolSection.Entry] {
        poolFamilies.map {
            .init(family: $0, lane: model.poolLane(for: $0, mode: composerMode, projectScoped: threadHasProject))
        }
    }

    /// The Auto-eligible harness ids in canonical order — the "all" set Auto
    /// stands for, and the order the explicit-subset wire body follows. Manual
    /// lanes are selectable too but never part of this set.
    private var availablePoolIds: [String] {
        HarnessPoolSection.autoAvailable(poolEntries)
    }

    /// Tapping a harness chip: in Auto this materializes the "all available" set as
    /// an explicit subset (Auto deselects) with this harness toggled; in explicit
    /// mode it toggles within the subset. Emptying it falls back to Auto (empty =
    /// auto — the same wire truth). The wire body is unchanged in Auto mode. A
    /// manual-only harness joins the subset instead of being dropped.
    private func togglePool(_ family: HarnessFamily) {
        let next = HarnessPoolPresentation.toggling(
            family.rawValue, pool: model.effectiveEligiblePool, available: availablePoolIds)
        Task { await model.setEligiblePool(next) }
    }
}

import SwiftUI
import ClaudexorKit

// MARK: - Composer "⋯" options popover
//
// Extracted from `ThreadsScreen.swift` (INV-124 readability ratchet): the
// advanced per-turn options panel, split out so the composer surface stays a
// small, single-owner unit. Pure move — zero behavior change.

extension ThreadsScreen {
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
            : (model.currentThread?.authPreference ?? model.settingsSnapshot?.routing.authPreference)
        return modelsRouteParam(forAuthPreference: preference)
    }

    /// Union of the RESOLVED pool's declared effort ladders in schema order
    /// (weakest → strongest); a sticky primary narrows to its own ladder. One
    /// scalar effort rides the run — adapters clamp it individually.
    var composerEffortLevels: [String] {
        let families = primaryFamily.map { [$0] }
            ?? (resolvedPoolFamilies.isEmpty ? poolFamilies : resolvedPoolFamilies)
        let declared = Set(families.flatMap { model.harnessInfo(for: $0)?.effortLevels ?? [] })
        let canonical = ["low", "medium", "high", "xhigh", "max"].filter { declared.contains($0) }
        // Unknown future levels degrade honestly to the tail, never dropped.
        return canonical + declared.subtracting(canonical).sorted()
    }

    /// The advanced options popover ("⋯"): clean SOLID sections on the popover's
    /// own material — harness pool, per-turn budget/access/web, agent repair strategies.
    var composerOptions: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            OptionSection(title: "Harness pool — Best-of runs these; the primary answers in chat") {
                FlowLayout(spacing: Theme.Spacing.sm) {
                    ForEach(poolFamilies) { family in
                        let avail = model.availability(for: family, mode: composerMode)
                        // Never synthesize "<glyph>.slash" (no such SF Symbol → blank
                        // icon); disabled dimming + hover reason convey unavailability.
                        FilterChip(label: family.label,
                                   systemImage: family.glyph,
                                   isActive: resolvedPoolFamilies.contains(family), tint: family.color) {
                            togglePool(family)
                        }
                        .disabled(!avail.available)
                        .help(avail.available ? "In the eligible pool" : avail.reason)
                    }
                }
            }
            OptionSection(title: "Models — per harness for THIS turn") {
                ComposerModelsSection(
                    families: resolvedPoolFamilies.isEmpty ? [primaryFamily].compactMap { $0 } : resolvedPoolFamilies,
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
                Picker("", selection: $webPolicy) {
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
                    .help("Requested reasoning effort for THIS turn. Each harness clamps it onto its own declared ladder (e.g. codex xhigh, claude max).")
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
            // Per-thread account pinning was REMOVED (INV-135): accounts, their
            // logins, quotas, and the auto-balance toggle all live in the
            // bottom-left accounts popover now. Runs use the default account
            // unless engine auto-balance rotates at a quota limit.
            OptionSection(title: "Review controls") {
                OptionRow(label: "Reviewers") {
                    HStack(spacing: Theme.Spacing.xs) {
                        TextField("claude=opus:max", text: $reviewerPanelText)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.caption, design: .monospaced))
                            .help("Comma or newline entries: harness[=model[:effort]] or harness[:effort]")
                        if reviewerPanelInvalid {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(.orange).font(.caption)
                                .help("Reviewer entries need harness[=model[:effort]] or harness[:effort]; supported effort values come from each harness manifest.")
                        }
                    }
                }
                OptionRow(label: "Approvals") {
                    HStack(spacing: Theme.Spacing.xs) {
                        TextField("test/**:test update", text: $protectedApprovalsText)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.caption, design: .monospaced))
                            .help("Comma or newline entries: path[:reason]")
                        if protectedApprovalsInvalid {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(.orange).font(.caption)
                                .help("Protected path approvals need a non-empty path")
                        }
                    }
                }
            }
            // Agent-driven browser (Playwright MCP). Offered only where a pooled
            // harness can inject it. Arming it forces Full access (codex's sandbox
            // cancels the navigation otherwise) and is disclosed below — never a
            // silent escalation.
            if browserAvailableForCurrentTurn {
                OptionRow(label: "Browser") {
                    Toggle("", isOn: Binding(
                        get: { browser },
                        set: { on in
                            browser = on
                            if on { access = .full }
                            if on { webPolicy = webPolicy == "off" ? "auto" : webPolicy }
                        }
                    ))
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .tint(Theme.accent)
                    .help("Let the agent drive a real browser (navigate / screenshot / read). Runs headed so you watch the real window live; navigation snapshots are recorded in the run.")
                }
                if browser {
                    Text("Agent browses in a real window · runs at Full access")
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
                    .help("Turns accumulate in a separate worktree; apply them to the project later with “Apply thread”. Off = in-place (the next turn sees prior edits).")
                }
            }
            // Agent STRATEGY knob (D24): Single / Best-of / Until-clean / Create
            // — the old distinct intents are now a per-turn knob. Delegate (D32)
            // rides alongside; Max-attempts caps the single/until-clean repair.
            if composerMode == .agent {
                OptionSection(title: "Agent strategy") {
                    Picker("", selection: $agentStrategy) {
                        ForEach(AgentStrategy.allCases) { s in
                            Label(s.label, systemImage: s.glyph).tag(s)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.segmented)
                    .help(agentStrategy.blurb)
                    // Max-attempts caps the single/until-clean repair loop; it is
                    // meaningless for a Best-of race, so it hides there.
                    if agentStrategy == .single || agentStrategy == .untilClean {
                        HStack(spacing: Theme.Spacing.xl) {
                            Stepper("Max attempts: \(maxAttempts)", value: $maxAttempts, in: 1...8)
                                .disabled(agentStrategy == .untilClean)
                                .help(agentStrategy == .untilClean
                                      ? "Disabled while Until clean is on (no fixed cap)"
                                      : "Hard cap on repair attempts")
                        }
                    }
                    Toggle("Delegate — let the agent spawn bounded sub-runs", isOn: $delegate)
                        .toggleStyle(.switch).tint(Theme.accent)
                        .help("Inject the Claudexor delegation belt (ask / plan / isolated sub-run / best-of / status / result). The harness decides when to delegate; sub-runs are isolated, depth-1, budget- and count-capped. Refused server-side on harnesses without MCP injection.")
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
                        Stepper("Members: \(councilMembers)", value: $councilMembers, in: 2...4)
                            .help("How many harnesses draft in parallel (2–4).")
                    }
                }
            }
        }
        .padding(Theme.Spacing.lg)
        .frame(width: Theme.Layout.composerOptionsWidth, alignment: .leading)
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

    private func togglePool(_ family: HarnessFamily) {
        var pool = model.effectiveEligiblePool
        if let idx = pool.firstIndex(of: family.rawValue) { pool.remove(at: idx) } else { pool.append(family.rawValue) }
        Task { await model.setEligiblePool(pool) }
    }
}

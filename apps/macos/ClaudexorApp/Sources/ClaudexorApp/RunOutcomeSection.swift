import SwiftUI
import ClaudexorKit

// MARK: - Run outcome facts (D42)
//
// When a chat receipt is selected, the thread workspace renders that run's
// Outcome FACTS at the top: the server-owned banner (verbatim), the final
// answer, plan readiness/questions, and the review verdict + findings. This is
// the demoted "Run Detail Outcome" — facts only. Decision controls live on the
// receipt (needsDecision); apply lives in the Changes tab (server-eligibility
// gated). Ported from the retired TaskDetailView so no per-run inspector remains.

struct RunOutcomeSection: View {
    let task: TaskRun

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            factsRow
            answerBlock
            if task.planReadiness != nil || !task.planQuestions.isEmpty || !task.plan.isEmpty {
                planSection
            }
            if !task.candidates.isEmpty {
                candidatesSection
            }
            if let council = task.council {
                councilSection(council)
            }
            if task.reviewVerdict != .notRun || task.reviewNeedsDecision || !task.findings.isEmpty {
                reviewContent
            }
        }
    }

    /// Council plan-strategy roster receipt (D31, QA-023b/047): how many members
    /// were requested vs drafted, whether the round degraded, who merged the
    /// unified plan, and the per-member roster (harness · role · status), with a
    /// failed member's redacted error. Rendered from the server projection only.
    private func councilSection(_ council: CouncilInfo) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            SectionLabel("Council", systemImage: "person.3.sequence.fill",
                         accessory: council.degraded
                            ? AnyView(Text("degraded").font(.caption.weight(.medium))
                                .foregroundStyle(Theme.status(.caution))
                                .help("Fewer council members drafted than requested."))
                            : nil)
            Text("\(council.drafted) of \(council.requested) member\(council.requested == 1 ? "" : "s") drafted"
                 + (council.mergedBy.map { " · merged by \($0)" } ?? " · merge did not complete"))
                .font(.caption).foregroundStyle(.secondary)
            ForEach(council.members) { member in
                HStack(spacing: Theme.Spacing.sm) {
                    HarnessIcon(family: HarnessFamily(rawValue: member.harnessId), size: 12)
                    Text(HarnessFamily(rawValue: member.harnessId).label).font(.caption)
                    Text(member.role).font(.caption2).foregroundStyle(.tertiary)
                    Text(member.status)
                        .font(.caption2)
                        .foregroundStyle(member.status == "failed" ? Theme.status(.negative) : .secondary)
                    if let error = member.error {
                        Text(error).font(.caption2).foregroundStyle(Theme.status(.negative))
                            .lineLimit(1).truncationMode(.tail).help(error)
                    }
                    Spacer()
                }
            }
        }
    }

    /// Best-of candidate cards (D11/D24) for the filtered run — the race evidence
    /// that used to live in the retired Run Detail Candidates tab. Run-specific,
    /// so it renders with the run's outcome facts (D42).
    private var candidatesSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel("Candidates", systemImage: "flag.checkered.2.crossed",
                         accessory: RunFacts.bestOfLabel(task).map { bestOf in
                             AnyView(Text(bestOf.text)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(bestOf.degraded ? Theme.status(.caution) : .secondary)
                                .help(bestOf.degraded ? "Fewer candidates than requested — best-of degraded." : "Best-of race count."))
                         })
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: Theme.Spacing.md) {
                    ForEach(task.candidates) { CandidateCard(candidate: $0) }
                }
                .padding(.bottom, Theme.Spacing.xs)
            }
            if let winner = task.candidates.first(where: { $0.reviewState == .winner }) {
                Panel(padding: Theme.Spacing.md) {
                    HStack(spacing: Theme.Spacing.sm) {
                        Image(systemName: "trophy.fill").foregroundStyle(Theme.accent)
                        Text(RunDetailMapping.winnerEvidenceText(winner))
                            .font(.caption).foregroundStyle(.secondary)
                        Spacer()
                    }
                }
            }
        }
    }

    /// The run's material facts (route / apply / attention), composed by the ONE
    /// facts owner (`RunFacts.headerPrimary`) — the demoted Run Detail header row.
    @ViewBuilder
    private var factsRow: some View {
        let primary = RunFacts.headerPrimary(task)
        let details = RunFacts.headerDetails(task)
        if !primary.isEmpty || !details.isEmpty {
            FlowLayout(spacing: Theme.Spacing.md) {
                ForEach(primary) { factLabel($0) }
                ForEach(details) { factLabel($0) }
            }
        }
    }

    private func factLabel(_ fact: RunFacts.Fact) -> some View {
        Label(fact.text, systemImage: fact.glyph ?? "circle")
            .font(fact.tone == .neutral ? .caption : .caption.weight(.medium))
            .foregroundStyle(fact.tone == .neutral ? AnyShapeStyle(.secondary) : AnyShapeStyle(fact.tone.color))
            .help(fact.help ?? fact.text)
    }

    /// Tone for the server-owned banner: a failure-shaped lifecycle or a
    /// review-blocked delivery must never read green.
    private var bannerTone: StatusTone {
        if task.phase.isFailureShaped { return .negative }
        if task.reviewNeedsDecision || task.outcomeFacts?.review == "blocked"
            || task.applyState == "applied_review_blocked" { return .caution }
        return .positive
    }

    private var answerBlock: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel(task.mode == .ask ? "Answer" : "Outcome", systemImage: "text.bubble")
            // D18: the SERVER-OWNED banner is the headline, VERBATIM — it always
            // outranks model prose and is never composed client-side.
            if let banner = task.outcomeBanner,
               !banner.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Label(banner, systemImage: "flag.fill")
                    .font(.headline)
                    .foregroundStyle(Theme.status(bannerTone))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            // D18/item f: apply is server-owned. When a patch is NOT eligible, the
            // honest next action shows here as TEXT — the apply BUTTONS (Changes
            // tab) stay HIDDEN until the gate says eligible.
            if let eligibility = task.applyEligibility, !eligibility.eligible,
               let action = eligibility.requiredAction ?? eligibility.reason {
                Label(action, systemImage: "hand.raised.fill")
                    .font(.caption)
                    .foregroundStyle(Theme.status(.caution))
                    .help("Apply is server-refused until this is resolved (apply eligibility).")
            }
            Panel {
                if let answer = task.answerText, !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    MarkdownOutputView(markdown: answer,
                                       fileScopeRoots: [task.repoRoot, task.runDir].compactMap { $0 },
                                       bodyFont: .body)
                } else {
                    Text(task.outputReadyState == "finalizing"
                         ? "Run is terminal; output is still finalizing. See Evidence for events and artifact paths."
                         : "No answer artifact. See Evidence for engine state, events, and artifact paths.")
                        .font(.callout).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    /// Plan readiness (D17) + open questions + checklist — read-only facts.
    /// Answering stays on the chat receipt (thread-bound).
    @ViewBuilder
    private var planSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel("Plan", systemImage: "checklist",
                         accessory: task.plan.isEmpty ? nil
                            : AnyView(Text("\(task.planDone)/\(task.plan.count) done")
                                .font(.caption).foregroundStyle(.secondary)))
            if let readiness = task.planReadiness {
                let ready = readiness.state == "ready"
                Label(ready ? "Plan is ready to implement" : "Plan needs answers before implementing",
                      systemImage: ready ? "checkmark.seal.fill" : "questionmark.circle.fill")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Theme.status(ready ? .positive : .caution))
            }
            if !task.planQuestions.isEmpty {
                Panel {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        Text("Open questions — answer on the plan turn in chat to continue.")
                            .font(.caption).foregroundStyle(.secondary)
                        ForEach(task.planQuestions) { q in
                            Label(q.prompt, systemImage: "questionmark.circle")
                                .font(.caption).foregroundStyle(.primary)
                        }
                    }
                }
            }
            if !task.plan.isEmpty {
                Panel { PlanListView(items: task.plan) }
            }
        }
    }

    /// Cross-family review verdict + findings, read-only. The decision controls
    /// live on the chat receipt (needsDecision), never duplicated here (D42).
    private var reviewContent: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel("Cross-family review", systemImage: "person.2.badge.gearshape")
            Panel {
                Label(reviewVerdictText(task.reviewVerdict), systemImage: reviewVerdictGlyph(task.reviewVerdict))
                    .foregroundStyle(reviewVerdictColor(task.reviewVerdict))
            }
            if task.reviewNeedsDecision {
                Text("This run needs a decision — decide from its card in the conversation.")
                    .font(.caption).foregroundStyle(Theme.status(.caution))
            } else if let action = task.operatorDecisionAction {
                Label("Operator decision recorded: \(action)", systemImage: "checkmark.seal")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if !task.findings.isEmpty {
                ForEach(task.findings) { FindingCard(finding: $0) }
            }
        }
    }
}

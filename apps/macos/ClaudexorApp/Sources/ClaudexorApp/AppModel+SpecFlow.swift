import Foundation
import ClaudexorKit

extension AppModel {
    // MARK: SPEC-FLOW (server-owned interview)

    /// Set/clear the SPEC-FLOW state for a given thread (keyed per thread so a
    /// thread switch hides a non-current card and a late await records on its own
    /// thread). Writing is unconditional on the current selection: the getter
    /// already gates visibility by `selectedThreadId`.
    func setSpecFlow(_ state: SpecFlowState?, for threadId: String) {
        specFlowByThread[threadId] = state
    }

    /// Bump and return the SPEC-FLOW generation for a thread (called at every
    /// start / submit / cancel so an older in-flight await can detect it is stale).
    private func nextSpecGen(_ tid: String) -> Int {
        let g = (specFlowGen[tid] ?? 0) + 1
        specFlowGen[tid] = g
        return g
    }

    /// True while `gen` is still the live generation for `tid` — i.e. no newer
    /// start/submit/cancel superseded the in-flight request that captured it.
    private func isCurrentSpecGen(_ tid: String, _ gen: Int) -> Bool {
        specFlowGen[tid] == gen
    }

    /// Begin the SPEC-FLOW: resolve/create a thread (reusing the existing draft
    /// bootstrap), require a project, then create a durable spec session.
    /// Empty questions => freeze directly (nothing to ask). The
    /// question card and the frozen card both render off `specFlow`.
    ///
    /// Returns TRUE when the flow was accepted OR an error CARD was established (any
    /// path that left durable UI state for the thread). Returns FALSE on a HARD
    /// failure with no durable state (engine offline / no project / no thread) — the
    /// caller should then RESTORE the composer text, mirroring how composerSend
    /// failures preserve the prompt. The discardable annotation keeps existing
    /// fire-and-forget callers compiling.
    @discardableResult
    func startSpec(prompt: String, model: String = "", options: TurnOptions = .init()) async -> Bool {
        guard let client else {
            threadStatus = "Engine offline — reconnect before starting a spec."
            return false
        }
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        // A spec is project-scoped: the grounding plan reads the repo. Resolve the
        // repo BEFORE materializing a thread (mirrors composerSend's ordering) so the
        // no-project path fails loud WITHOUT leaving an empty orphan draft thread.
        // Prefer the selected thread's bound repo, fall back to the Current Project.
        let repoRoot = currentThread?.repoRoot?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? normalizedProjectRoot
        guard !repoRoot.isEmpty else {
            threadStatus = "Spec needs a project — pick one before starting an interview."
            return false
        }
        // Materialize a thread the same way composerSend does, so spec turns and
        // the eventual Implement turn share one conversation/native session.
        var threadId = selectedThreadId
        if threadId == nil {
            await newThread(title: nil)
            threadId = selectedThreadId
            guard threadId != nil else { return false }  // newThread set threadStatus
        }
        guard let tid = threadId else { return false }
        // Past this point a durable spec CARD exists for `tid` (grounding → questions /
        // freeze / error), so every remaining path returns true: a thread switch leaves
        // that card intact and the engine error surfaces in-card, not via lost text.
        // A fresh generation supersedes any in-flight grounding for this thread.
        let gen = nextSpecGen(tid)
        // Remember the composer's per-turn model + options for the eventual Implement
        // turn (the grounding/freeze run read-only; these apply to the write turn).
        let trimmedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        specPendingModel[tid] = trimmedModel.isEmpty ? nil : trimmedModel
        specPendingOptions[tid] = options
        specPrior[tid] = []  // fresh interview: drop any accumulated decisions
        setSpecFlow(.grounding, for: tid)  // "running the grounding plan" while it runs (minutes)
        threadStatus = nil
        // Honor the user's eligible pool for the grounding plan too (the composer
        // exposes pool chips while Spec is selected) — otherwise the questions could
        // come from a harness outside the pool the Implement turn will use. Empty =>
        // engine default (nil). Same pool a normal turn resolves.
        let pool = effectiveEligiblePool
        do {
            let res = try await client.specQuestions(
                SpecQuestionsRequest(prompt: trimmed, threadId: tid, scope: .project(root: repoRoot),
                                     harnesses: pool.isEmpty ? nil : pool)
            )
            // State is keyed by `tid`, so record the result on its OWNING thread even
            // if the user switched away during the long await (the getter hides a
            // non-current card). This prevents a stranded `.grounding` spinner. But
            // DROP the write if a newer start/cancel superseded this grounding.
            guard isCurrentSpecGen(tid, gen) else {
                _ = try? await client.cancelSpecSession(res.planDir)
                return true
            }
            if res.questions.isEmpty {
                // Nothing to clarify: freeze straight from the grounding plan (no
                // prior questions to preserve — pass them explicitly, not re-read).
                await freezeSpec(prompt: trimmed, repoRoot: repoRoot, planDir: res.planDir,
                                 answers: [], threadId: tid, gen: gen,
                                 priorQuestions: [], priorPlanRunId: "")
            } else {
                setSpecFlow(.askingQuestions(prompt: trimmed, questions: res.questions, planDir: res.planDir,
                                             planRunId: res.planRunId, answers: [], error: nil), for: tid)
            }
        } catch {
            guard isCurrentSpecGen(tid, gen) else { return true }
            setSpecFlow(.error(userMessage(for: error)), for: tid)
        }
        return true
    }

    /// Submit the user's interview answers and freeze the SpecPack. On an
    /// unresolved-clarifications 400 the question card STAYS open with the server's
    /// reason (no silent guessing); on success the flow advances to `.frozen`.
    func submitSpecAnswers(threadId tid: String, answers: [SpecAnswer]) async {
        // Bound to the OWNING thread (passed by the card), not live selection — a
        // thread switch during the freeze can't mis-apply or drop the answers.
        guard case .askingQuestions(let prompt, let questions, let planDir, let planRunId, _, _) = specFlowByThread[tid] else { return }
        guard let repoRoot = threadRepoRoot(tid)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !repoRoot.isEmpty else {
            setSpecFlow(.error("Spec needs a project — the owning thread has no repo."), for: tid)
            return
        }
        // A fresh generation supersedes any in-flight freeze for this thread.
        let gen = nextSpecGen(tid)
        // The freeze prompt is the user's ORIGINAL spec intent, carried on
        // `.askingQuestions` since startSpec; the durable session retains the exact
        // prompt the grounding plan ran on (not the stale head-turn prompt, which on a fresh
        // thread is generic and on an existing thread is the PREVIOUS turn's). The
        // current questions/planRunId are passed EXPLICITLY (not re-read from mutable
        // state) so a 400 can re-open the SAME card.
        await freezeSpec(prompt: prompt, repoRoot: repoRoot, planDir: planDir,
                         answers: answers, threadId: tid, gen: gen,
                         priorQuestions: questions, priorPlanRunId: planRunId)
    }

    /// Shared freeze step (used by both the empty-questions fast path and the
    /// answered path). Keeps the question card open on an unresolved-clarifications
    /// 400 by re-deriving the asking state with the error attached. `priorQuestions`/
    /// `priorPlanRunId` are passed in by the caller (not re-read from mutable state),
    /// and `gen` guards the post-await writes against a superseding start/cancel.
    /// Multi-tier interview: record this tier's answers as prior decisions and
    /// re-run the grounding for the NEXT, DEEPER tier — or freeze if the model has no
    /// further questions. Drives the 8A backend (`priorDecisions`).
    func askDeeperSpec(threadId tid: String, decisions: [SpecPriorDecision]) async {
        guard let client else { setSpecFlow(.error("Engine offline — reconnect before continuing."), for: tid); return }
        guard case .askingQuestions(let prompt, _, _, _, _, _) = specFlowByThread[tid] else { return }
        guard let repoRoot = threadRepoRoot(tid)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !repoRoot.isEmpty else {
            setSpecFlow(.error("Spec needs a project — the owning thread has no repo."), for: tid)
            return
        }
        specPrior[tid] = (specPrior[tid] ?? []) + decisions
        let gen = nextSpecGen(tid)
        setSpecFlow(.grounding, for: tid)  // re-grounding the repo for the deeper tier (minutes)
        let pool = threadEligiblePool(tid)
        do {
            let res = try await client.specQuestions(
                SpecQuestionsRequest(prompt: prompt, threadId: tid, scope: .project(root: repoRoot),
                                     harnesses: pool.isEmpty ? nil : pool, priorDecisions: specPrior[tid])
            )
            guard isCurrentSpecGen(tid, gen) else {
                _ = try? await client.cancelSpecSession(res.planDir)
                return
            }
            if res.questions.isEmpty {
                // The model has no further open decisions: freeze the deeper-grounded plan.
                await freezeSpec(prompt: prompt, repoRoot: repoRoot, planDir: res.planDir,
                                 answers: [], threadId: tid, gen: gen, priorQuestions: [], priorPlanRunId: "")
            } else {
                setSpecFlow(.askingQuestions(prompt: prompt, questions: res.questions, planDir: res.planDir,
                                             planRunId: res.planRunId, answers: [], error: nil), for: tid)
            }
        } catch {
            guard isCurrentSpecGen(tid, gen) else { return }
            setSpecFlow(.error(userMessage(for: error)), for: tid)
        }
    }

    private func freezeSpec(prompt: String, repoRoot: String, planDir: String,
                            answers: [SpecAnswer], threadId tid: String, gen: Int,
                            priorQuestions: [SpecQuestion], priorPlanRunId: String) async {
        guard let client else {
            setSpecFlow(.error("Engine offline — reconnect before freezing the spec."), for: tid)
            return
        }
        setSpecFlow(.freezing(sessionId: planDir), for: tid)
        do {
            let res = try await client.specFreeze(
                // priorDecisions = every EARLIER tier's decisions (the current tier
                // rides `answers`); folded into the frozen SpecPack so a multi-tier
                // spec doesn't lose tiers 0..N-1.
                SpecFreezeRequest(prompt: prompt, scope: .project(root: repoRoot),
                                  planDir: planDir, answers: answers,
                                  priorDecisions: specPrior[tid] ?? [])
            )
            // Keyed by `tid`: record on the owning thread even if the user navigated
            // away during the freeze await (the getter hides a non-current card), so
            // the card never strands at `.freezing`. DROP if superseded.
            guard isCurrentSpecGen(tid, gen) else {
                _ = try? await client.cancelSpecSession(planDir)
                return
            }
            setSpecFlow(.frozen(sessionId: planDir, specId: res.specId, specPath: res.specPath,
                                specHash: res.specHash, changes: res.changes.count,
                                recovered: false), for: tid)
        } catch {
            guard isCurrentSpecGen(tid, gen) else { return }
            let message = userMessage(for: error)
            // Unresolved clarifications (and any freeze refusal): keep the question
            // card OPEN with the reason in its error slot so the user can answer the
            // missing fields — never guess.
            if !priorQuestions.isEmpty {
                setSpecFlow(.askingQuestions(prompt: prompt, questions: priorQuestions, planDir: planDir,
                                             planRunId: priorPlanRunId, answers: answers,
                                             error: message), for: tid)
            } else {
                setSpecFlow(.error(message), for: tid)
            }
        }
    }

    /// Implement a FROZEN spec: send an .agent turn carrying the spec FILE path
    /// (the orchestrator reads it and fails loud if unreadable). Clears the spec
    /// card on a successful send (the new turn renders the run).
    func implementSpec(threadId tid: String, sessionId: String, specPath: String) async {
        // Bound to the OWNING thread (passed by the frozen card): the Implement turn
        // and the card-clear both target that thread, not live selection. Honor the
        // per-turn model + options the user set when they started the spec.
        let sent = await composerSend(prompt: "Implement the frozen spec.", mode: .agent,
                                      specPath: specPath, model: specPendingModel[tid],
                                      options: specPendingOptions[tid] ?? .init(), onThread: tid)
        if sent {
            do {
                guard let client else { throw GatewayError.decoding("Engine disconnected.") }
                _ = try await client.cancelSpecSession(sessionId)
            } catch {
                setSpecFlow(
                    .interrupted(
                        sessionId: sessionId,
                        message: "Implementation started, but the Spec could not be marked consumed: \(userMessage(for: error))"),
                    for: tid)
                return
            }
            setSpecFlow(nil, for: tid)
            specPendingModel[tid] = nil
            specPendingOptions[tid] = nil
        }
    }

    /// Dismiss the SPEC-FLOW (e.g. the user cancels the question card). Bumps the
    /// generation so a grounding/freeze still in flight can't RE-SHOW the dismissed
    /// card when its await returns (its write is dropped as stale).
    func cancelSpec(threadId tid: String) {
        // Thread-bound (the card passes its owning thread) so a dismiss can't clear a
        // different thread's spec if selection changed.
        let sessionId: String? = switch specFlowByThread[tid] {
        case .askingQuestions(_, _, let id, _, _, _): id
        case .freezing(let id), .recovering(let id, _), .interrupted(let id, _): id
        case .frozen(let id, _, _, _, _, _): id
        default: nil
        }
        _ = nextSpecGen(tid)
        setSpecFlow(nil, for: tid)
        specPendingModel[tid] = nil
        specPendingOptions[tid] = nil
        if let sessionId, let client {
            Task {
                do {
                    _ = try await client.cancelSpecSession(sessionId)
                } catch {
                    if specFlowByThread[tid] == nil {
                        setSpecFlow(
                            .interrupted(sessionId: sessionId, message: userMessage(for: error)),
                            for: tid)
                    }
                }
            }
        }
    }
}

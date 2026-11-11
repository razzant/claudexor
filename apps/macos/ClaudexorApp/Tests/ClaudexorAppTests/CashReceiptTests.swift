import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// The native cash element when the engine cannot prove the run's TOTAL cash (an
/// included subscription reports no actual debit) but still knows the part the
/// finite cap governs: unknown is never a number, never a seeded exact $0.00, and
/// the cap-governed amount/remaining is labelled apart from the total.
@Suite(.serialized)
struct CashReceiptTests {
    private static func task(id: String = "run-cash", cap: Double? = 2) -> TaskRun {
        var task = TaskRun(
            id: id, title: "Run", prompt: "", mode: .agent, phase: .running,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: cap ?? 0, spendKnown: false, capKnown: cap != nil,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )
        if cap == nil { task.applyPaidBudget(.unlimited) }
        return task
    }

    private static func cash(_ payload: [String: JSONValue], seq: Int = 1) -> BusEnvelope {
        BusEnvelope(seq: seq, kind: "budget", event: .object([
            "type": .string("budget.cash"), "payload": .object(payload),
        ]))
    }

    @MainActor
    private static func stubbedModel() -> AppModel {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CashReceiptStubURLProtocol.self]
        return AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
    }

    /// A minimal run-detail body carrying the given budget snapshot.
    private static func detail(budget: String) -> Data {
        Data(#"{"summary":{"runId":"run-detail","state":"running","mode":"agent"},"budget":\#(budget),"lastSeq":10}"#.utf8)
    }

    @Test func unknownTotalIsLabelledApartFromTheCapGovernedPart() {
        let exact = CashSpend.receipt(total: 1.5, estimated: false, controllable: 1.5, cap: 2)
        #expect(exact?.text == "$1.50")
        #expect(exact?.help == CashSpend.help(estimated: false))

        let unknown = CashSpend.receipt(total: nil, estimated: false, controllable: 0, cap: 2)
        #expect(unknown?.text == "Cash unknown · $0.00 of $2.00 cap")
        #expect(unknown?.help.contains("$2.00 of $2.00 remaining") == true)
        // Negative: the bounded part is never presented as the total.
        #expect(unknown?.text != "$0.00")
        #expect(unknown?.text.hasPrefix("$") == false)

        let partlySpent = CashSpend.receipt(total: nil, estimated: false, controllable: 0.5, cap: 2)
        #expect(partlySpent?.text == "Cash unknown · $0.50 of $2.00 cap")
        #expect(partlySpent?.help.contains("$1.50 of $2.00 remaining") == true)

        let uncapped = CashSpend.receipt(total: nil, estimated: false, controllable: 0, cap: nil)
        #expect(uncapped?.text == "Cash unknown")

        // Nothing disclosed (or the cap-governed part unknown too): nothing renders.
        #expect(CashSpend.receipt(total: nil, estimated: false, controllable: nil, cap: 2) == nil)
    }

    @MainActor
    @Test func ledgerDisclosureWithUnknownTotalKeepsTheCapGovernedPart() {
        let model = AppModel(requestNotificationAuthorization: false)
        model.liveTasks = [Self.task()]
        model.apply(Self.cash([
            "cash_spend_usd": .number(0), "estimated": .bool(false),
            "cash_knowledge": .string("unknown"),
            "controllable_cash_knowledge": .string("exact"),
        ]), to: "run-cash")
        let box = model.liveBoxes["run-cash"]
        #expect(box?.spendKnown == false)
        #expect(box?.controllableSpendUsd == 0)
        let run = model.liveTasks[0]
        let spend = model.spendDisplay(run)
        #expect(!spend.known)
        #expect(spend.controllableUsd == 0)
        let receipt = CashSpend.receipt(
            total: spend.known ? spend.usd : nil, estimated: spend.estimated,
            controllable: spend.controllableUsd, cap: run.finiteCapUsd)
        #expect(receipt?.text == "Cash unknown · $0.00 of $2.00 cap")

        // Later disclosures are last-wins: spend on a controlled route lowers the
        // remaining cap while the total stays unknown.
        model.apply(Self.cash([
            "cash_spend_usd": .number(0.75), "estimated": .bool(false),
            "cash_knowledge": .string("unknown"),
            "controllable_cash_knowledge": .string("exact"),
        ], seq: 2), to: "run-cash")
        #expect(model.liveBoxes["run-cash"]?.controllableSpendUsd == 0.75)
        #expect(model.liveBoxes["run-cash"]?.spendKnown == false)

        // An exact total remains the ordinary number.
        model.apply(Self.cash([
            "cash_spend_usd": .number(0.75), "estimated": .bool(false),
            "cash_knowledge": .string("exact"),
            "controllable_cash_knowledge": .string("exact"),
        ], seq: 3), to: "run-cash")
        let exact = model.spendDisplay(model.liveTasks[0])
        #expect(exact.known)
        #expect(exact.usd == 0.75)
    }

    @MainActor
    @Test func unknownCapGovernedCashAndLegacyEventsNeverInventIt() {
        let model = AppModel(requestNotificationAuthorization: false)
        model.liveTasks = [Self.task()]
        // Both unknown: nothing to state about the cap either.
        model.apply(Self.cash([
            "cash_spend_usd": .number(0), "estimated": .bool(false),
            "cash_knowledge": .string("unknown"),
            "controllable_cash_knowledge": .string("unknown"),
        ]), to: "run-cash")
        #expect(model.liveBoxes["run-cash"]?.controllableSpendUsd == nil)
        #expect(model.spendDisplay(model.liveTasks[0]).controllableUsd == nil)
        // An older engine carries only the reported knowledge: unknown stays unknown.
        model.apply(Self.cash([
            "cash_spend_usd": .number(0), "estimated": .bool(false),
            "cash_knowledge": .string("unknown"),
        ], seq: 2), to: "run-cash")
        #expect(model.liveBoxes["run-cash"]?.controllableSpendUsd == nil)
        // ...and a known legacy total is its own cap-governed amount.
        model.apply(Self.cash([
            "cash_spend_usd": .number(0.4), "estimated": .bool(false),
            "cash_knowledge": .string("exact"),
        ], seq: 3), to: "run-cash")
        #expect(model.liveBoxes["run-cash"]?.controllableSpendUsd == 0.4)
    }

    @MainActor
    @Test func aFreshStreamDoesNotSeedAnUnprovenTotalAsExactZero() async throws {
        defer { CashReceiptStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CashReceiptStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        model.liveTasks = [Self.task(id: "run-seed")]
        let requested = CashReceiptFlag()
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        CashReceiptStubURLProtocol.handler = { _ in
            requested.raise()
            _ = release.wait(timeout: .now() + 5)
            throw NSError(domain: "stub", code: 1)
        }
        model.stream(runId: "run-seed")
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while !requested.isRaised {
            try #require(ContinuousClock.now <= deadline, "stream never reached the stub")
            try await Task.sleep(for: .milliseconds(10))
        }
        // The attach created the box before the first frame; no settle has said
        // whether the total is exact or unknown, so nothing is claimed.
        let box = try #require(model.liveBoxes["run-seed"])
        #expect(!box.spendKnown)
        #expect(!model.spendDisplay(model.liveTasks[0]).known)
        #expect(CashSpend.receipt(
            total: nil, estimated: false, controllable: box.controllableSpendUsd, cap: 2) == nil)
        model.streamTasks["run-seed"]?.cancel()
    }

    @MainActor
    @Test func hydratedDetailCarriesTheCapGovernedCashThroughAListRefresh() throws {
        let detail = try JSONDecoder().decode(BudgetSnapshot.self, from: Data(#"""
        {"paidBudget":{"kind":"finite","maxUsd":2},"cashKnowledge":"unknown","spendUsd":null,
         "controllableSpendUsd":0,"remainingUsd":2,"valuationKnowledge":"unknown"}
        """#.utf8))
        var hydrated = Self.task()
        hydrated.spendKnown = detail.spendUsd != nil
        hydrated.controllableSpendUsd = detail.controllableSpendUsd
        let summary = try JSONDecoder().decode(
            RunSummary.self, from: Data(#"{"runId":"run-cash","state":"running","mode":"agent"}"#.utf8))
        // The list summary never carries the cap-governed part; the refresh keeps it.
        let merged = AppModel.mergeRefreshedTask(summary: summary, existing: hydrated)
        #expect(!merged.spendKnown)
        #expect(merged.controllableSpendUsd == 0)
    }

    // MARK: Latest disclosure wins (exact → unknown), no-evidence stays distinct

    /// A hydrated task that last showed an exact total.
    private static func exactTask(total: Double = 0.4) -> TaskRun {
        var task = Self.task()
        task.spendKnown = true
        task.spendUsd = total
        task.controllableSpendUsd = total
        return task
    }

    @MainActor
    @Test func anExactSnapshotThenAnUnknownLedgerDisclosureStopsShowingTheOldExactCash() {
        let model = AppModel(requestNotificationAuthorization: false)
        model.liveTasks = [Self.exactTask()]
        let before = model.spendDisplay(model.liveTasks[0])
        #expect(before.known)
        #expect(before.usd == 0.4)
        model.apply(Self.cash([
            "cash_spend_usd": .number(0.4), "estimated": .bool(false),
            "cash_knowledge": .string("unknown"),
            "controllable_cash_knowledge": .string("exact"),
        ]), to: "run-cash")
        // The box said "unknown"; the older task snapshot must not answer for it.
        let after = model.spendDisplay(model.liveTasks[0])
        #expect(!after.known)
        #expect(after.controllableUsd == 0.4)
        let run = model.liveTasks[0]
        #expect(CashSpend.receipt(
            total: after.known ? after.usd : nil, estimated: after.estimated,
            controllable: after.controllableUsd, cap: run.finiteCapUsd)?.text
            == "Cash unknown · $0.40 of $2.00 cap")
    }

    @MainActor
    @Test func aKnownCapGovernedPartIsReplacedByAnUnknownOneOnEveryPath() {
        // Stream: both parts disclosed unknown after an exact snapshot.
        let streamed = AppModel(requestNotificationAuthorization: false)
        streamed.liveTasks = [Self.exactTask()]
        streamed.apply(Self.cash([
            "cash_spend_usd": .number(0.4), "estimated": .bool(false),
            "cash_knowledge": .string("unknown"),
            "controllable_cash_knowledge": .string("unknown"),
        ]), to: "run-cash")
        let afterStream = streamed.spendDisplay(streamed.liveTasks[0])
        #expect(!afterStream.known)
        #expect(afterStream.controllableUsd == nil)

        // Fold at the end of the stream: the task keeps the newest disclosure.
        streamed.foldLiveBox("run-cash")
        #expect(streamed.liveBoxes["run-cash"] == nil)
        #expect(!streamed.liveTasks[0].spendKnown)
        #expect(streamed.liveTasks[0].controllableSpendUsd == nil)
        let folded = streamed.spendDisplay(streamed.liveTasks[0])
        #expect(!folded.known)
        #expect(folded.controllableUsd == nil)
    }

    @MainActor
    @Test func foldingAnUnknownDisclosureOverAnExactTaskLeavesUnknownNotTheOldNumber() {
        let model = AppModel(requestNotificationAuthorization: false)
        model.liveTasks = [Self.exactTask()]
        model.apply(Self.cash([
            "cash_spend_usd": .number(0.4), "estimated": .bool(false),
            "cash_knowledge": .string("unknown"),
            "controllable_cash_knowledge": .string("exact"),
        ]), to: "run-cash")
        model.foldLiveBox("run-cash")
        let run = model.liveTasks[0]
        #expect(!run.spendKnown)
        #expect(run.controllableSpendUsd == 0.4)
        #expect(!model.spendDisplay(run).known)
        #expect(run.budgetLabel == "Unknown · $0.4000 of $2.00 cap")
    }

    @MainActor
    @Test func aBoxWithNoDisclosureStillFollowsTheTaskSnapshot() {
        let model = AppModel(requestNotificationAuthorization: false)
        model.liveTasks = [Self.task()]
        let box = model.ensureLiveBox("run-cash")
        // No evidence yet anywhere: nothing is claimed.
        #expect(!box.cashDisclosed)
        #expect(!model.spendDisplay(model.liveTasks[0]).known)
        // A later list refresh updates the task; a box that never heard cash
        // evidence defers to it (it is not an explicit "unknown").
        model.liveTasks[0].spendKnown = true
        model.liveTasks[0].spendUsd = 0.6
        let display = model.spendDisplay(model.liveTasks[0])
        #expect(display.known)
        #expect(display.usd == 0.6)
    }

    @MainActor
    @Test func anExactBoxThenAnUnknownDetailSnapshotAdoptsTheUnknown() async throws {
        defer { CashReceiptStubURLProtocol.handler = nil }
        let model = Self.stubbedModel()
        model.liveTasks = [Self.task(id: "run-detail")]
        model.apply(Self.cash([
            "cash_spend_usd": .number(0.4), "estimated": .bool(false),
            "cash_knowledge": .string("exact"),
            "controllable_cash_knowledge": .string("exact"),
        ]), to: "run-detail")
        #expect(model.spendDisplay(model.liveTasks[0]).known)

        // The fresh snapshot discloses the total as unknown beside a known cap part.
        CashReceiptStubURLProtocol.handler = { _ in Self.detail(budget: #"""
        {"paidBudget":{"kind":"finite","maxUsd":2},"cashKnowledge":"unknown","spendUsd":null,
         "controllableSpendUsd":0.4,"remainingUsd":1.6,"valuationKnowledge":"unknown"}
        """#) }
        await model.loadRunDetail("run-detail")
        let box = try #require(model.liveBoxes["run-detail"])
        #expect(!box.spendKnown)
        #expect(box.controllableSpendUsd == 0.4)
        let shown = model.spendDisplay(model.liveTasks[0])
        #expect(!shown.known)
        #expect(shown.controllableUsd == 0.4)

        // A newer snapshot discloses BOTH parts unknown: the known cap part is replaced.
        CashReceiptStubURLProtocol.handler = { _ in Self.detail(budget: #"""
        {"paidBudget":{"kind":"finite","maxUsd":2},"cashKnowledge":"unknown","spendUsd":null,
         "controllableSpendUsd":null,"remainingUsd":null,"valuationKnowledge":"unknown"}
        """#) }
        await model.loadRunDetail("run-detail")
        #expect(model.liveBoxes["run-detail"]?.controllableSpendUsd == nil)
        #expect(model.spendDisplay(model.liveTasks[0]).controllableUsd == nil)
        #expect(!model.spendDisplay(model.liveTasks[0]).known)
    }

    @MainActor
    @Test func aSnapshotWithNoCashEvidenceLeavesAnExactBoxAlone() async throws {
        defer { CashReceiptStubURLProtocol.handler = nil }
        let model = Self.stubbedModel()
        model.liveTasks = [Self.task(id: "run-detail")]
        model.apply(Self.cash([
            "cash_spend_usd": .number(0.4), "estimated": .bool(false),
            "cash_knowledge": .string("exact"),
            "controllable_cash_knowledge": .string("exact"),
        ]), to: "run-detail")
        // Nothing known and nothing disclosed unknown (source "unknown"): the
        // snapshot says nothing about cash, so the stream's exact number stands.
        CashReceiptStubURLProtocol.handler = { _ in Self.detail(budget: #"""
        {"paidBudget":{"kind":"finite","maxUsd":2},"spendUsd":null,"controllableSpendUsd":null,
         "remainingUsd":null,"valuationKnowledge":"unknown","source":"unknown","evidence":"unavailable"}
        """#) }
        await model.loadRunDetail("run-detail")
        let shown = model.spendDisplay(model.liveTasks[0])
        #expect(shown.known)
        #expect(shown.usd == 0.4)
    }

    @Test func theExactCashHelpMakesNoRouteClaimAboutZero() {
        let exact = CashSpend.help(estimated: false)
        #expect(!exact.contains("$0.00"))
        #expect(!exact.contains("subscription routes"))
        #expect(exact.contains("unknown"))
        #expect(CashSpend.help(estimated: true).contains("API key"))
    }

    @Test func budgetLabelAndFractionUseTheCapGovernedPartNotAFakeTotal() {
        var run = Self.task()
        // Unknown total, nothing else known: unchanged.
        #expect(run.budgetLabel == "Unknown / $2.00")
        #expect(run.spendFraction == 0)
        // Unknown total, cap-governed $0.50 of $2.00: labelled apart, fraction from it.
        run.controllableSpendUsd = 0.5
        #expect(run.budgetLabel == "Unknown · $0.5000 of $2.00 cap")
        #expect(run.spendFraction == 0.25)
        // Known total: the ordinary label; the cap-governed part still drives the fraction.
        run.spendKnown = true
        run.spendUsd = 0.5
        #expect(run.budgetLabel == "$0.5000 / $2.00")
        #expect(run.spendFraction == 0.25)
        // Older engine without the part: the known total is what the cap governed.
        run.controllableSpendUsd = nil
        #expect(run.spendFraction == 0.25)
        // Unlimited keeps its word.
        var unlimited = Self.task(cap: nil)
        unlimited.controllableSpendUsd = 0
        #expect(unlimited.budgetLabel == "Unknown / Unlimited")
        #expect(unlimited.spendFraction == 0)
    }
}

private final class CashReceiptFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var raised = false
    func raise() { lock.lock(); raised = true; lock.unlock() }
    var isRaised: Bool { lock.lock(); defer { lock.unlock() }; return raised }
}

private final class CashReceiptStubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> Data)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        DispatchQueue.global().async { [self] in
            do {
                guard let handler = Self.handler else { throw NSError(domain: "stub", code: 2) }
                let data = try handler(request)
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"])!
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: data)
                client?.urlProtocolDidFinishLoading(self)
            } catch {
                client?.urlProtocol(self, didFailWithError: error)
            }
        }
    }
    override func stopLoading() {}
}

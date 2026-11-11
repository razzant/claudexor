import ClaudexorKit
import Foundation
import Observation

/// One selected located thread. Transport pages and mounted rows have separate
/// budgets; presentation choices never pin DTOs. No legacy detail reads here.
@MainActor @Observable final class ThreadHistoryStore {
    typealias Read = @MainActor (ThreadHistorySelector?, Int, String?) async throws -> ThreadHistoryPage
    enum State: Equatable { case loading, ready, failed(String) }
    struct Replay { var cursor: String; var ids: Set<String>; var limit: Int }
    struct LiveFact { var task: TaskRun; var throughRead: Int }
    let locationID: ExecutionLocationID
    let threadID: String
    let presentation = ConversationPresentation()
    var state: State = .loading
    var earlierState: HistoryControlState = .ready
    var laterState: HistoryControlState = .ready
    var jumpState: HistoryControlState = .ready
    var errorMessage: String?
    var header: ThreadHistoryHeader?
    var revision: ThreadHistoryRevision?
    var storeID: String?
    var mountedIDs: [String] = []
    var hasOlder = false
    var hasNewer = false
    var newCount: Int? = 0
    var following = true { didSet { if following { readingAnchor = nil; newCount = 0 } } }
    var readingAnchor: String?
    var navigationRevision = 0
    var navigationTarget: String?
    var navigationFollows = true
    var navigationBottom = false
    struct RowSizeKey: Hashable {
        let id: String
        let epoch: String
        let sequence: Int
        init(_ row: ThreadHistoryTurn) { id = row.id; epoch = row.revision.epoch; sequence = row.revision.sequence }
    }
    @ObservationIgnored var rowSizes: [RowSizeKey: Int] = [:]
    @ObservationIgnored var measureRow: (ThreadHistoryTurn) -> Int = { (try? JSONEncoder().encode($0).count) ?? 0 }
    var prepare: (([ThreadHistoryTurn]) -> Void)?
    var didReadHeader: ((ThreadHistoryHeader) -> Void)?
    var records: [String: ThreadHistoryTurn] = [:]
    var retainedPages: [[String]] = []
    var replays: [Replay] = []
    var liveFacts: [String: LiveFact] = [:]
    var liveRunIDs: Set<String> = []
    var metadataAck: (summary: ThreadSummary, throughRead: Int)?
    var delegateReads: Set<String> = []
    @ObservationIgnored var delegateTask: Task<Void, Never>?
    var resolvedInteractions: [String: Set<String>] = [:]
    var interactionRequestSequences: [String: [String: Int]] = [:]
    var oldestID: String?
    var readSerial = 0
    var installedReadSerial = 0
    var intent = 0
    @ObservationIgnored var refreshTask: Task<Void, Never>?
    @ObservationIgnored var trailing = false
    @ObservationIgnored var acceptingTrailing = false
    @ObservationIgnored let read: Read

    init(locationID: ExecutionLocationID, threadID: String, read: @escaping Read) {
        self.locationID = locationID; self.threadID = threadID; self.read = read
    }

    var rows: [ThreadHistoryTurn] { mountedIDs.compactMap { records[$0] } }
    var cacheBytes: Int { records.values.reduce(0) { $0 + encodedSize($1) } }
    var tailMounted: Bool { mountedIDs.last == header?.latestTurnId }

    func cancelNavigation() { intent += 1 }
    func newCountReset() { newCount = 0 }

    func acknowledgeMetadata(_ summary: ThreadSummary) {
        guard summary.id == threadID else { return }
        metadataAck = (summary, readSerial)
        if let updated = header?.thread.applying(summary) { header?.thread = updated }
    }

    func open() async {
        if header == nil { state = .loading; errorMessage = nil }
        await refresh()
    }

    func jump() async {
        intent += 1
        let ticket = intent
        jumpState = .loading
        do {
            var result = try await fetch(nil)
            guard ticket == intent else { jumpState = .ready; return }
            if let revision, result.0.revision.epoch == revision.epoch,
               result.0.revision.sequence < revision.sequence {
                result = try await fetch(nil)
            }
            guard ticket == intent else { jumpState = .ready; return }
            guard install([result.0], ids: result.0.turns.map(\.id), reset: true, serial: result.1) else {
                jumpState = .failed; return
            }
            following = true; readingAnchor = nil; newCount = 0
            navigate(nil, follows: true)
            jumpState = .ready
        } catch { fail(error, control: .jump) }
    }

    func earlier(retaining: Int) async {
        guard let anchor = rows.first?.id, earlierState != .loading else { return }
        let step = max(1, 20 - min(19, retaining))
        await travel(.beforeTurnId(anchor), limit: step, anchor: anchor, earlier: true)
    }

    func later() async {
        guard let anchor = rows.last?.id, laterState != .loading else { return }
        await travel(.afterTurnId(anchor), limit: 10, anchor: anchor, earlier: false)
    }

    private func travel(_ selector: ThreadHistorySelector, limit: Int, anchor: String, earlier: Bool) async {
        intent += 1
        let ticket = intent
        if earlier { earlierState = .loading } else { laterState = .loading }
        do {
            let (page, serial) = try await fetch(selector, limit: limit)
            guard ticket == intent else { finishTravel(); return }
            if changedEpoch(page) { try await resnapshot(anchor: anchor, follows: false); finishTravel(); return }
            let combined = unique(rows + page.turns)
            let window = earlier ? Array(combined.prefix(20)) : Array(combined.suffix(20))
            let chosen = fitting(window, anchor: anchor, earlier: earlier)
            // A boundary page is coverage, never a replacement empty feed.
            guard install([page], ids: chosen.map(\.id), reset: false, serial: serial,
                          limit: limit, countingArrivals: true) else {
                if earlier { earlierState = .failed } else { laterState = .failed }; return
            }
            following = !earlier && tailMounted
            readingAnchor = following ? nil : anchor
            navigate(following ? nil : anchor, follows: following, bottom: !earlier)
            finishTravel()
        } catch {
            if isStale(error) {
                do { try await resnapshot(anchor: anchor, follows: false); finishTravel() }
                catch { fail(error, control: earlier ? .earlier : .later) }
            } else { fail(error, control: earlier ? .earlier : .later) }
        }
    }

    /// INV-136: events in the trailing read do not create a third chained GET.
    /// The independently owned terminal run read publishes through publishLive.
    func refresh() async {
        if let refreshTask {
            if acceptingTrailing { trailing = true }
            await refreshTask.value
            return
        }
        acceptingTrailing = true
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.refreshOnce()
            self.acceptingTrailing = false
            if self.trailing {
                self.trailing = false
                await self.refreshOnce()
            }
        }
        refreshTask = task
        await task.value
        refreshTask = nil
    }

    private func refreshOnce() async {
        do {
            if replays.isEmpty {
                let navigation = navigationRevision
                let (page, serial) = try await fetch(nil)
                if changedEpoch(page) {
                    try await resnapshot(anchor: readingAnchor); return
                }
                installTail(page, serial: serial, navigation: navigation)
                return
            }
            var pages: [ThreadHistoryPage] = []
            var replayLimits: [String: Int] = [:]
            var serial = readSerial
            for range in replays {
                var cursor: String? = range.cursor
                var seen = Set<String>()
                repeat {
                    guard let next = cursor, seen.insert(next).inserted else {
                        throw GatewayError.decoding("History replay repeated a cursor.")
                    }
                    let result = try await fetch(.cursor(next), limit: range.limit)
                    if changedEpoch(result.0) {
                        try await resnapshot(anchor: readingAnchor ?? mountedIDs.first); return
                    }
                    pages.append(result.0); serial = result.1
                    if let replay = result.0.replayCursor { replayLimits[replay] = range.limit }
                    cursor = result.0.replayNextCursor
                } while cursor != nil
            }
            // Gestures cancel navigation, never background facts. Re-check the
            // viewport after the tail await: an explicit travel may have landed.
            if following, let latest = pages.last?.header.latestTurnId, latest != mountedIDs.last {
                let navigation = navigationRevision
                let (page, next) = try await fetch(nil)
                if changedEpoch(page) {
                    try await resnapshot(anchor: readingAnchor ?? mountedIDs.first); return
                }
                installTail(page, serial: next, navigation: navigation)
            } else {
                install(pages, ids: mountedIDs, reset: false, serial: serial, replayLimits: replayLimits)
            }
        } catch {
            if isStale(error) {
                do { try await resnapshot(anchor: readingAnchor ?? mountedIDs.first) }
                catch { fail(error, control: .refresh) }
            } else { fail(error, control: .refresh) }
        }
    }

    /// Membership authority is separate from row freshness. Even a useful late
    /// response cannot undo a completed Jump/Send or a newer installed read.
    private func installTail(_ page: ThreadHistoryPage, serial: Int, navigation: Int) {
        let older = revision.map { $0.epoch == page.revision.epoch && $0.sequence > page.revision.sequence } ?? false
        let replace = following && navigation == navigationRevision && serial >= installedReadSerial && !older
        install([page], ids: replace ? page.turns.map(\.id) : mountedIDs,
            reset: header == nil, serial: serial)
    }

    private func recoveryPosition(fallback: String?) -> (following: Bool, anchor: String?) {
        let messages = presentation.focusedMessages.union(presentation.selectedMessages)
        if following && messages.isEmpty { return (true, nil) }
        let focused = mountedIDs.first { id in messages.contains { $0 == id || $0.hasPrefix(id + ":") } }
        return (false, readingAnchor ?? focused ?? fallback ?? mountedIDs.first)
    }

    private func resnapshot(anchor requestedAnchor: String?, follows: Bool? = nil) async throws {
        let ticket = intent, navigation = navigationRevision
        let position = recoveryPosition(fallback: requestedAnchor)
        let recoveringFollower = follows ?? position.following
        let anchor = recoveringFollower ? nil : (follows == nil ? position.anchor : requestedAnchor)
        let (first, serial) = try await fetch(anchor.map(ThreadHistorySelector.aroundTurnId))
        var pages = [first]
        var chosen = first.turns
        var lastSerial = serial
        // Around is anchor + earlier. Refill below it before the one paint.
        if let anchor, let index = first.turns.firstIndex(where: { $0.id == anchor }) {
            let preceding = rows.firstIndex(where: { $0.id == anchor }) ?? min(index, 10)
            chosen = Array(first.turns.suffix(preceding + 1))
            var cursor = first.newerCursor
            while chosen.count < 20, let next = cursor {
                let result = try await fetch(.cursor(next))
                guard result.0.epoch == first.epoch, result.0.revision.epoch == first.revision.epoch else { throw GatewayError.decoding("History changed during recovery. Retry loading messages.") }
                pages.append(result.0); lastSerial = result.1
                chosen = Array(unique(chosen + result.0.turns).prefix(20))
                cursor = result.0.newerCursor
                if result.0.turns.isEmpty { break }
            }
        }
        guard ticket == intent, navigation == navigationRevision else { return }
        if follows == nil {
            let current = recoveryPosition(fallback: requestedAnchor)
            if current.following != recoveringFollower || current.anchor != anchor {
                // Focus/selection can pause following without a scroll gesture.
                // Keep the painted island until its new anchor has been read.
                try await resnapshot(anchor: current.anchor)
                return
            }
        }
        guard install(pages, ids: chosen.map(\.id), reset: true, serial: lastSerial,
                      countingArrivals: !recoveringFollower) else { return }
        following = recoveringFollower
        readingAnchor = anchor
        if recoveringFollower { navigate(nil, follows: true) }
        else if let anchor, mountedIDs.contains(anchor) { navigate(anchor, follows: false) }
    }

    func fetch(_ selector: ThreadHistorySelector?, limit: Int = 20, expected: Bool = true) async throws -> (ThreadHistoryPage, Int) {
        readSerial += 1
        let serial = readSerial
        return (try await read(selector, limit, expected ? storeID : nil), serial)
    }

    func encodedSize(_ row: ThreadHistoryTurn) -> Int {
        let key = RowSizeKey(row)
        if let size = rowSizes[key] { return size }
        let bytes = measureRow(row)
        rowSizes[key] = bytes
        return bytes
    }

    func changedEpoch(_ page: ThreadHistoryPage) -> Bool {
        revision.map { $0.epoch != page.revision.epoch } ?? false
    }

    /// A byte-limited page can contain fewer than twenty rows. Explicit travel
    /// may reduce the mounted count further, always retaining the chosen anchor.
    /// Background refresh instead keeps the painted island if growth cannot fit.
    func fitting(_ rows: [ThreadHistoryTurn], anchor: String, earlier: Bool) -> [ThreadHistoryTurn] {
        var result = rows
        let sizes = Dictionary(uniqueKeysWithValues: rows.map {
            ($0.id, encodedSize($0))
        })
        var bytes = sizes.values.reduce(0, +)
        while bytes > 4 * 1024 * 1024, result.count > 1 {
            let indices = earlier ? Array(result.indices.reversed()) : Array(result.indices)
            guard let index = indices.first(where: { result[$0].id != anchor }) else { break }
            bytes -= sizes[result[index].id] ?? 0
            result.remove(at: index)
        }
        return result
    }

    private func isStale(_ error: Error) -> Bool {
        guard case GatewayError.http(let status, let body) = error, status == 409 else { return false }
        return body.contains("thread_history_cursor_stale")
    }

    private func navigate(_ anchor: String?, follows: Bool, bottom: Bool = false) {
        navigationTarget = anchor; navigationFollows = follows; navigationBottom = bottom; navigationRevision += 1
    }

    private func finishTravel() { earlierState = .ready; laterState = .ready }
    private enum Control { case jump, earlier, later, refresh }
    static let olderEngineMessage = "This engine is older than the app and cannot show conversation history. "
        + "Claudexor updates it, or offers an update, once its current work finishes; then choose Retry."

    private func fail(_ error: Error, control: Control) {
        let message = (error as? GatewayError)?.isUnknownRoute == true ? Self.olderEngineMessage : error.localizedDescription
        errorMessage = message
        if header == nil { state = .failed(message) }
        switch control {
        case .jump: jumpState = .failed
        case .earlier: earlierState = .failed
        case .later: laterState = .failed
        case .refresh: break
        }
    }

    func unique(_ turns: [ThreadHistoryTurn]) -> [ThreadHistoryTurn] {
        var byID: [String: ThreadHistoryTurn] = [:]
        for turn in turns {
            if let old = byID[turn.id], !turn.revision.isNewer(than: old.revision) { continue }
            byID[turn.id] = turn
        }
        return byID.values.sorted { $0.ordinal < $1.ordinal }
    }
}

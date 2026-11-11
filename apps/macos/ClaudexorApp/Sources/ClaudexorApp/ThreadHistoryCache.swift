import ClaudexorKit
import Foundation

extension ThreadHistoryStore {
    /// Merge before mounting, then reclaim DTOs outside the two-page (40 row /
    /// 4 MiB) cache. Mounted rows have priority; drafts are never consulted.
    @discardableResult
    func install(_ pages: [ThreadHistoryPage], ids: [String], reset: Bool, serial: Int,
                 limit: Int = 20, replayLimits: [String: Int] = [:], countingArrivals: Bool = false) -> Bool {
        defer {
            let kept = Set(records.values.map(RowSizeKey.init))
            rowSizes = rowSizes.filter { kept.contains($0.key) }
        }
        guard let last = pages.last else { return false }
        if reset, let revision, last.revision.epoch == revision.epoch,
           last.revision.sequence < revision.sequence { return false }
        var next = reset ? [:] : records
        for page in pages {
            for row in page.turns {
                if let previous = next[row.id], !row.revision.isNewer(than: previous.revision) { continue }
                next[row.id] = row
            }
        }
        let mounted = Array(ids.prefix(20)).filter { next[$0] != nil }
        let protected = Set(mounted)
        let pageIDs = Array((retainedPages + pages.map { $0.turns.map(\.id) }).suffix(2))
        let allowed = protected.union(pageIDs.flatMap { $0 })
        next = next.filter { allowed.contains($0.key) }
        let sizes = next.mapValues { encodedSize($0) }
        var bytes = sizes.values.reduce(0, +)
        for id in next.values.sorted(by: { $0.revision.sequence < $1.revision.sequence }).map(\.id)
            where !protected.contains(id) && (next.count > 40 || bytes > 4 * 1024 * 1024) {
            next[id] = nil; bytes -= sizes[id] ?? 0
        }
        guard bytes <= 4 * 1024 * 1024 else {
            errorMessage = "Saved history exceeds the display cache limit. The current passage has been kept."
            if header == nil { state = .failed(errorMessage!) }
            return false
        }
        prepare?(mounted.compactMap { next[$0] })
        installedReadSerial = max(installedReadSerial, serial)
        records = next; retainedPages = pageIDs; mountedIDs = mounted
        for row in rows where row.planAnswerComplete && row.answeredByTurnId != nil {
            if let runID = row.runId {
                presentation.planText[runID] = nil
                presentation.planSelections[runID] = nil
            }
        }
        if reset { replays = []; oldestID = nil }
        for page in pages {
            if !page.hasOlder, let first = page.turns.first { oldestID = first.id }
            if let cursor = page.replayCursor {
                let members = Set(page.turns.map(\.id)).intersection(protected)
                for index in replays.indices { replays[index].ids.subtract(members) }
                if let index = replays.firstIndex(where: { $0.cursor == cursor }) {
                    replays[index].ids.formUnion(members)
                } else { replays.append(Replay(cursor: cursor, ids: members, limit: replayLimits[cursor] ?? limit)) }
            }
        }
        replays = replays.compactMap {
            let ids = $0.ids.intersection(protected)
            return ids.isEmpty ? nil : Replay(cursor: $0.cursor, ids: ids, limit: $0.limit)
        }
        if reset || revision == nil || last.revision.isNewer(than: revision!) {
            if !following || countingArrivals, header?.latestTurnId != last.header.latestTurnId {
                if let old = header?.latestOrdinal, let new = last.header.latestOrdinal, new >= old {
                    newCount = newCount.map { $0 + new - old }
                } else { newCount = nil }
            }
            header = last.header; revision = last.revision; storeID = last.storeId
            if let ack = metadataAck {
                if serial <= ack.throughRead { header?.thread = last.header.thread.applying(ack.summary) }
                else { metadataAck = nil }
            }
            presentation.receiveLatest(last.header.latestTurnId)
            if let head = last.header.headRun, RunPhase(api: head.run.state).isActive {
                liveRunIDs.insert(head.runId)
            }
        }
        hasOlder = !mounted.isEmpty && mounted.first != oldestID
        hasNewer = !mounted.isEmpty && mounted.last != header?.latestTurnId
        // Empty edge pages still carry reverse coverage. The mounted island is
        // retained, and further travel addresses its actual first/last IDs.
        if last.turns.isEmpty {
            if !last.hasOlder { hasOlder = false }
            if !last.hasNewer { hasNewer = false }
        }
        let runIDs = Set(rows.compactMap(\.runId)).union(header?.headRun.map { [$0.runId] } ?? [])
        delegateReads.formIntersection(runIDs)
        liveRunIDs.formIntersection(runIDs)
        resolvedInteractions = resolvedInteractions.filter { runIDs.contains($0.key) }
        interactionRequestSequences = interactionRequestSequences.filter { runIDs.contains($0.key) }
        liveFacts = liveFacts.filter { id, fact in
            guard runIDs.contains(id) else { return false }
            guard serial > fact.throughRead,
                  let row = rows.first(where: { $0.runId == id }),
                  row.run.map({ RunPhase(api: $0.state).isTerminal }) == true else { return true }
            // A post-publication page may retire the live overlay. A read that
            // started before publication cannot, even if it completes later.
            return row.primaryOutput?.text == nil && fact.task.answerText != nil
        }
        state = .ready; errorMessage = nil
        if let header { didReadHeader?(header) }
        return true
    }

    func publishLive(_ task: TaskRun) {
        guard liveRunIDs.contains(task.id) || header?.headRun?.runId == task.id else { return }
        liveFacts[task.id] = LiveFact(task: task, throughRead: readSerial)
    }

    func renderedRun(for row: ThreadHistoryTurn, live: TaskRun?) -> TaskRun? {
        guard row.runStatus == "available" else { return nil }
        if let id = row.runId, let fact = liveFacts[id] { return fact.task }
        if let id = row.runId, liveRunIDs.contains(id), let live,
           row.run.map({ RunPhase(api: $0.state).isActive }) == true { return live }
        return HistoryRunPresentation.task(row, thread: header?.thread)
    }
}

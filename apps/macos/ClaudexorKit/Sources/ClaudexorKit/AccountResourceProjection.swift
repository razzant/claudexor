import Foundation

public extension ControlQuotaResponse {
    /// Accounts whose resource binding differs from `previous`: the API key their
    /// row was read with, or whether they have a row. Facet updates under one key
    /// are not binding changes, and a read that omitted resources observed none.
    func resourceBindingChanges(from previous: ControlQuotaResponse?) -> Set<AccountTarget> {
        guard resources != nil else { return [] }
        func bindings(_ response: ControlQuotaResponse?) -> [AccountTarget: String?] {
            Dictionary((response?.resources ?? []).map { ($0.target, $0.credentialFingerprint) },
                       uniquingKeysWith: { first, _ in first })
        }
        let before = bindings(previous), after = bindings(self)
        return Set(before.keys).union(after.keys).filter { before[$0] != after[$0] }
    }

    /// This read as the projection that replaces `previous`. A read that omitted
    /// resources (the legacy quota projection) is no evidence about them: the last
    /// observed rows, with each account's key binding, stay. An empty list removes them.
    func retainingResources(of previous: ControlQuotaResponse?) -> ControlQuotaResponse {
        guard resources == nil, let rows = previous?.resources else { return self }
        var response = ControlQuotaResponse(snapshots: snapshots, absences: absences, refreshedAt: refreshedAt,
                                            refreshSkipped: refreshSkipped, resources: rows)
        response.availabilityScope = availabilityScope
        return response
    }

    /// Commit an exact-account control response into the existing quota owner.
    /// Unaddressed rows keep their data, absence and independent observation age.
    /// A later background read may already own newer facts for THIS account.
    /// Compare provider observation/attempt times; the existing display generation
    /// breaks ties (including undated facts) in favour of an intervening owner.
    /// A resource row read with another API key, or one that appears or goes away,
    /// has no comparable time: it stands unless this account's binding changed after
    /// the request began (`reboundSinceRequest`: a committed snapshot or the app's own
    /// acknowledged write of it), even if it later changed back. Another account's
    /// commit or write, or a display read that admitted nothing, never outranks it.
    /// A reply that omitted resources is no evidence about the row and leaves it.
    func replacingAccount(
        _ target: AccountTarget, in previous: ControlQuotaResponse?,
        reboundSinceRequest: Bool,
        preferPreviousOnTie: Bool = false
    ) -> ControlQuotaResponse {
        guard let previous else { return self }
        func matches(_ subject: QuotaSubject) -> Bool {
            subject.harness == target.harness && subject.subjectId == target.profileId
        }
        func quotaTime(_ response: ControlQuotaResponse) -> Date? {
            (response.snapshots.filter { matches($0.subject) }.map(\.observedAt)
             + response.absences.filter { matches($0.subject) }.map(\.observedAt))
                .compactMap(parseOffsetTimestamp).max()
        }
        let quotaOwner = keepPreviousResourceObservation(incoming: quotaTime(self), previous: quotaTime(previous),
                                                         onTie: preferPreviousOnTie) ? previous : self
        let snapshots = previous.snapshots.filter { !matches($0.subject) }
            + quotaOwner.snapshots.filter { matches($0.subject) }
        let absences = previous.absences.filter { !matches($0.subject) }
            + quotaOwner.absences.filter { matches($0.subject) }
        let oldResource = previous.resources?.first { $0.target == target }
        let incomingResource = resources?.first { $0.target == target }
        let addressedResource: AccountResourceSnapshot?
        if let incoming = incomingResource, let old = oldResource,
           incoming.credentialFingerprint == old.credentialFingerprint {
            addressedResource = incoming.preservingNewer(in: old, preferPreviousOnTie: preferPreviousOnTie)
        } else {
            // A late reply for a replaced or removed key cannot bring its figures back.
            addressedResource = reboundSinceRequest || self.resources == nil ? oldResource : incomingResource
        }
        let resources = (previous.resources ?? []).filter { $0.target != target }
            + [addressedResource].compactMap { $0 }
        let skipped = (previous.refreshSkipped ?? []).filter { $0.subject.map(matches) != true }
            + (quotaOwner.refreshSkipped ?? []).filter { $0.subject.map(matches) == true }
        let refreshedAt = keepPreviousResourceObservation(
            incoming: refreshedAt.flatMap(parseOffsetTimestamp), previous: previous.refreshedAt.flatMap(parseOffsetTimestamp),
            onTie: preferPreviousOnTie) ? previous.refreshedAt : refreshedAt
        return ControlQuotaResponse(snapshots: snapshots, absences: absences,
                                    refreshedAt: refreshedAt, refreshSkipped: skipped.isEmpty ? nil : skipped,
                                    resources: resources)
    }
}

private extension AccountResourceSnapshot {
    /// Facets merge only within one key, each by its own observation time: a
    /// row read with another API key never mixes with the previous key's figures.
    func preservingNewer(in previous: Self, preferPreviousOnTie: Bool) -> Self {
        Self(target: target, credentialFingerprint: credentialFingerprint,
            balances: balances.preservingNewer(in: previous.balances, onTie: preferPreviousOnTie),
            spending: spending.preservingNewer(in: previous.spending, onTie: preferPreviousOnTie),
            resets: resets.preservingNewer(in: previous.resets, onTie: preferPreviousOnTie),
            diagnostics: diagnostics.preservingNewer(in: previous.diagnostics, onTie: preferPreviousOnTie))
    }
}

private extension ResourceFacet {
    var comparisonTime: Date? { [observedAt, lastAttemptAt].compactMap { $0.flatMap(parseOffsetTimestamp) }.max() }
    func preservingNewer(in previous: Self, onTie: Bool) -> Self {
        keepPreviousResourceObservation(incoming: comparisonTime, previous: previous.comparisonTime, onTie: onTie)
            ? previous : self
    }
}

private func keepPreviousResourceObservation(incoming: Date?, previous: Date?, onTie: Bool) -> Bool {
    switch (incoming, previous) {
    case let (incoming?, previous?): return previous > incoming || (previous == incoming && onTie)
    case (nil, _?): return true
    case (_?, nil): return false
    case (nil, nil): return onTie
    }
}

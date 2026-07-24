import SwiftUI
import AppKit
import ClaudexorKit

/// Phase 3 (Feature A): the artifacts gallery — renders a run's produced files
/// as evidence. M9-UX item 8: IMAGES render as large thumbnail cards in a grid;
/// text-like files (md/txt/yaml/json/log) render as COMPACT list rows (name,
/// size, one-line preview) that open a full text viewer with a proper LoadState;
/// everything else opens externally. Reuses the binary-aware
/// `GET /runs/:id/artifacts(/:path)` control-API path. Technical artifacts
/// (events.jsonl, context/, attempts/) stay in Diagnostics, not the gallery.
/// One artifact tagged with the run that produced it — so a gallery aggregated
/// across a thread's runs still fetches each file's bytes from the right run.
struct RunArtifact: Identifiable, Equatable, Sendable {
    let runId: String
    let art: ArtifactInfo
    var id: String { "\(runId)|\(art.path)" }
}

struct ArtifactGalleryView: View {
    @Environment(AppModel.self) private var model
    /// The runs whose artifacts are aggregated (D42): one run for the run-filtered
    /// view, the whole thread's runs for the aggregated Artifacts tab.
    let runIds: [String]
    /// When true, source the project's PRODUCED outputs (`/runs/:id/produced`)
    /// instead of the run's orchestration tree — and skip the run-tree filter.
    var produced: Bool = false
    /// D15: identity-keyed load slot — switching the run set shows loading/empty,
    /// never the previous set's artifact list.
    @State private var slot = PayloadSlot<[RunArtifact]>()
    /// Bounded-evidence disclosure: run ids whose artifact listing FAILED while
    /// others in the set loaded. A nonempty list under a loaded snapshot renders
    /// the partial-results warning (with Retry) so a run's outputs are never
    /// silently omitted from the aggregated view.
    @State private var failedRunIds: [String] = []
    /// Set when a whole-set refresh FAILED (every listing errored) while a nonempty
    /// snapshot is already shown: we keep last-known bytes but MUST disclose they
    /// could not be refreshed — distinct from a partial failure, and never rendered
    /// as if freshly confirmed.
    @State private var refreshFailed = false

    /// Single-run gallery (the run's own tree, or its produced outputs).
    init(runId: String, produced: Bool = false) {
        self.runIds = [runId]
        self.produced = produced
    }
    /// Thread-aggregated gallery across a run list (D42).
    init(runIds: [String], produced: Bool = false) {
        self.runIds = runIds
        self.produced = produced
    }

    private var plane: PayloadPlane { produced ? .produced : .run }
    /// The aggregated identity: the whole ordered run set is the key, so adding a
    /// run or switching threads resets the slot (no stale bytes across sets).
    private var identity: PayloadIdentity {
        PayloadIdentity(runId: runIds.joined(separator: "|"), plane: plane)
    }

    /// Filter the loaded list for display; the raw slot value is the fetch truth.
    private func display(_ artifacts: [RunArtifact]) -> [RunArtifact] {
        // The produced endpoint already returns only project outputs, so show all
        // files it returns. The run-tree filter only applies to the run artifacts.
        if produced {
            return artifacts.filter { $0.art.kind == "file" }
        }
        return artifacts.filter {
            $0.art.kind == "file"
                && !$0.art.path.hasSuffix("events.jsonl")
                && !$0.art.path.hasPrefix("context/")
                && !$0.art.path.hasPrefix("attempts/")
        }
    }

    private var displayArtifacts: [RunArtifact] { display(slot.state.value ?? []) }
    /// Item 8 grouping: image cards vs. the compact document list (text + other).
    private var imageArtifacts: [RunArtifact] {
        displayArtifacts.filter { ArtifactCategory.of(mime: $0.art.mime, path: $0.art.path) == .image }
    }
    private var documentArtifacts: [RunArtifact] {
        displayArtifacts.filter { ArtifactCategory.of(mime: $0.art.mime, path: $0.art.path) != .image }
    }

    /// Images the runs CHANGED anywhere in the project tree (typed diff evidence),
    /// aggregated across the run set and de-duplicated — agents drop screenshots
    /// wherever the task says, so the gallery surfaces every image the diffs
    /// touched, same canonical scope gate as inline chat previews.
    private var runChangedImages: [String] {
        guard produced else { return [] }
        var seen = Set<String>()
        var out: [String] = []
        for runId in runIds {
            guard let run = model.task(runId) else { continue }
            for path in Self.runImagePaths(diffPaths: run.diff.map(\.path), repoRoot: run.repoRoot)
            where seen.insert(path).inserted { out.append(path) }
        }
        return out
    }

    /// The repo roots across the run set (for the scoped inline image gate).
    private var changedImageRoots: [String] {
        runIds.compactMap { model.task($0)?.repoRoot }
    }

    /// Pure derivation (unit-tested): diff-relative paths -> absolute image
    /// paths that pass the thread-scope gate on the real filesystem.
    static func runImagePaths(diffPaths: [String], repoRoot: String?) -> [String] {
        guard let root = repoRoot, !root.isEmpty else { return [] }
        return diffPaths
            .map { ($0 as NSString).isAbsolutePath ? $0 : (root as NSString).appendingPathComponent($0) }
            .compactMap { ScopedInlineImage.scopedImagePath($0, roots: [root]) }
    }

    var body: some View {
        ScrollView {
            if !runChangedImages.isEmpty {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    Label("Images this run changed", systemImage: "photo.badge.checkmark")
                        .font(.caption.weight(.medium)).foregroundStyle(.secondary)
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: Theme.Spacing.md)],
                              alignment: .leading, spacing: Theme.Spacing.md) {
                        ForEach(runChangedImages, id: \.self) { path in
                            ScopedInlineImage(target: path,
                                              alt: (path as NSString).lastPathComponent,
                                              roots: changedImageRoots)
                        }
                    }
                }
                .padding(Theme.Spacing.md)
                Divider()
            }
            // Bounded-evidence disclosure over the shown snapshot. A whole-set
            // refresh FAILURE (every listing errored) keeps last-known bytes on
            // screen — it must say "could not refresh" rather than render stale
            // artifacts as freshly confirmed. Otherwise a PARTIAL failure (some
            // runs loaded, some errored) names the omitted runs. Both offer a
            // Retry that re-fetches the whole set.
            if refreshFailed, slot.state.value != nil {
                evidenceBanner("Could not refresh — showing last-known results.",
                               detail: failedRunIds.isEmpty ? nil
                                   : "Failed to load: \(failedRunIds.joined(separator: ", "))")
            } else if !failedRunIds.isEmpty, slot.state.value != nil {
                evidenceBanner("Some runs' artifacts couldn't be loaded — showing partial results.",
                               detail: "Failed to load: \(failedRunIds.joined(separator: ", "))")
            }
            if case .failed(let error) = slot.state {
                VStack(spacing: Theme.Spacing.sm) {
                    Text(error.message).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                        .multilineTextAlignment(.center)
                    Button("Retry") { Task { await load() } }
                        .buttonStyle(.bordered).controlSize(.small)
                }
                .frame(maxWidth: .infinity).padding(Theme.Spacing.xl)
            } else if case .loading = slot.state, runChangedImages.isEmpty {
                ProgressView("Loading artifacts…").controlSize(.small)
                    .frame(maxWidth: .infinity).padding(Theme.Spacing.xl)
            } else if case .idle = slot.state, runChangedImages.isEmpty {
                ProgressView().controlSize(.small)
                    .frame(maxWidth: .infinity).padding(Theme.Spacing.xl)
            } else if displayArtifacts.isEmpty && runChangedImages.isEmpty {
                Text(produced
                     ? "No project outputs yet — files the run writes into the project's artifacts/ folder (and any images its diff touches) show up here."
                     : "No artifacts produced yet — files appear here as the run finishes its output.")
                    .font(.callout).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity).multilineTextAlignment(.center).padding(Theme.Spacing.xl)
            } else {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    if !imageArtifacts.isEmpty { imagesSection }
                    if !documentArtifacts.isEmpty { documentsSection }
                }
                .padding(Theme.Spacing.md)
            }
        }
        // Loads on appear and whenever the selected run/plane changes. The slot's
        // identity keying (D15) drops the previous run's list the instant `runId`
        // changes, so a stale artifact list can never render under a new run.
        .task(id: identity) { await load() }
    }

    /// A disclosure banner over the shown snapshot: an orange warning with a title,
    /// an optional detail line, and a Retry that re-fetches the whole set (a
    /// recovered run then rejoins the aggregate). Shared by the partial-result and
    /// the failed-refresh (stale last-known) disclosures.
    private func evidenceBanner(_ title: String, detail: String?) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text(title)
                    .font(.caption.weight(.medium))
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let detail {
                    Text(detail)
                        .font(.caption2).foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            Button("Retry") { Task { await load() } }
                .buttonStyle(.bordered).controlSize(.small)
        }
        .padding(Theme.Spacing.sm)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.top, Theme.Spacing.sm)
    }

    /// Images: large thumbnail cards in an adaptive grid.
    private var imagesSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Label("Images", systemImage: "photo.on.rectangle")
                .font(.caption.weight(.medium)).foregroundStyle(.secondary)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: Theme.Spacing.md)],
                      alignment: .leading, spacing: Theme.Spacing.md) {
                ForEach(imageArtifacts) { item in
                    ArtifactImageCard(runId: item.runId, art: item.art, produced: produced)
                }
            }
        }
    }

    /// Text + other files: compact list rows (name, size, one-line preview).
    private var documentsSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Label("Files", systemImage: "doc.on.doc")
                .font(.caption.weight(.medium)).foregroundStyle(.secondary)
            LazyVStack(spacing: Theme.Spacing.xxs) {
                ForEach(documentArtifacts) { item in
                    ArtifactRow(runId: item.runId, art: item.art, produced: produced)
                }
            }
        }
    }

    /// Load + AGGREGATE artifacts across the run set. Each run's fetch is tagged
    /// with its runId (so bytes fetch from the right run) and de-duplicated by
    /// (runId, path). A single failed run does not blank a set that otherwise
    /// loaded; ALL failing (and nothing loaded) surfaces the typed error state.
    private func load() async {
        let id = identity
        slot.begin(id)
        // A6: fan the per-run listing fetches out CONCURRENTLY over the Sendable
        // gateway client — a thread-aggregated gallery otherwise SERIALIZED N
        // produced-endpoint round-trips. Results are reassembled in runIds order
        // and de-duplicated by (runId, path), so the list stays deterministic.
        let byRun = await Self.fetchListings(runIds: runIds, produced: produced, client: model.client)
        let (combined, failed) = Self.aggregate(runIds: runIds, byRun: byRun)
        // Identity-guarded: a value only counts as "already shown" when it belongs
        // to THIS still-current identity (a raced newer `begin` reset the slot).
        let existingNonEmpty = slot.identity == id && !(slot.state.value?.isEmpty ?? true)
        switch Self.loadDecision(combinedIsEmpty: combined.isEmpty, failed: failed,
                                 existingNonEmpty: existingNonEmpty) {
        case .fail:
            // Nothing loaded anywhere over a real transport failure: the typed
            // error state (never a silent "no artifacts").
            slot.commit(.failed(.offline), for: id)
        case .keepStale(let failedRuns):
            // A whole-set refresh FAILED while a nonempty snapshot is shown — keep
            // last-known bytes but disclose they could not be refreshed. A benign
            // transient empty (a live run still producing, no failed runs) keeps
            // the snapshot silently. All state writes are synchronous after the
            // awaits, under the identity guard baked into `existingNonEmpty`.
            refreshFailed = !failedRuns.isEmpty
            if !failedRuns.isEmpty { failedRunIds = failedRuns }
        case .commit(let failedRuns):
            // Commit under the slot's identity guard; only when the snapshot
            // actually painted do we adopt its failed-run disclosure (a raced late
            // result that the slot dropped must not leave a stale banner).
            if slot.commit(combined.isEmpty ? .empty : .loaded(combined), for: id) {
                failedRunIds = failedRuns
                refreshFailed = false
            }
        }
    }

    /// The pure retain-vs-disclose decision (unit-tested), preserving the exact
    /// original branch semantics: fail only when nothing is shown AND the refresh
    /// errored; keep+disclose a nonempty snapshot on an empty refresh; otherwise
    /// commit the fresh aggregate.
    static func loadDecision(
        combinedIsEmpty: Bool, failed: [String], existingNonEmpty: Bool
    ) -> GalleryLoadDecision {
        if combinedIsEmpty && !failed.isEmpty && !existingNonEmpty { return .fail }
        if combinedIsEmpty && existingNonEmpty { return .keepStale(failed: failed) }
        return .commit(failed: failed)
    }

    /// Pure aggregation (unit-tested): reassemble the per-run listings in runIds
    /// order, de-duplicated by (runId, path), and report which runs' listings
    /// FAILED (a nil entry) so the caller discloses a partial result — one run's
    /// outputs are never silently omitted from the aggregated view.
    static func aggregate(
        runIds: [String], byRun: [String: [ArtifactInfo]?]
    ) -> (combined: [RunArtifact], failed: [String]) {
        var combined: [RunArtifact] = []
        var seen = Set<String>()
        var failed: [String] = []
        for runId in runIds {
            guard let list = byRun[runId] ?? nil else { failed.append(runId); continue }
            for art in list where seen.insert("\(runId)|\(art.path)").inserted {
                combined.append(RunArtifact(runId: runId, art: art))
            }
        }
        return (combined, failed)
    }

    /// Fetch every run's artifact listing CONCURRENTLY over the Sendable client
    /// (a nil client or a per-run transport failure yields nil for that run,
    /// matching the AppModel accessors' `try?` semantics). `nonisolated` so only
    /// Sendable values (the client, run ids, the flag) cross into the child
    /// tasks — no MainActor state is captured.
    nonisolated private static func fetchListings(
        runIds: [String], produced: Bool, client: GatewayClient?
    ) async -> [String: [ArtifactInfo]?] {
        guard let client else { return [:] }
        return await withTaskGroup(of: (String, [ArtifactInfo]?).self) { group in
            for runId in runIds {
                group.addTask {
                    let list = produced
                        ? try? await client.listProducedFiles(runId: runId)
                        : try? await client.listRunArtifacts(runId: runId)
                    return (runId, list)
                }
            }
            var out: [String: [ArtifactInfo]?] = [:]
            for await (runId, list) in group { out[runId] = list }
            return out
        }
    }
}

// MARK: - Image card (large thumbnail)

private struct ArtifactImageCard: View {
    @Environment(AppModel.self) private var model
    let runId: String
    let art: ArtifactInfo
    var produced: Bool = false
    /// D15 identity-keyed image slot: a card reused for a different run/path never
    /// shows the previous file's bytes. `DecodedImage` boxes the actor crossing.
    @State private var imageSlot = PayloadSlot<DecodedImage>()

    private var identity: PayloadIdentity {
        PayloadIdentity(runId: runId, plane: produced ? .produced : .run, path: art.path)
    }
    private var image: NSImage? { imageSlot.state.value?.image }
    private var imageLoadFailed: Bool { if case .failed = imageSlot.state { return true }; return false }
    private var fileName: String { (art.path as NSString).lastPathComponent }

    var body: some View {
        Button { Task { await openArtifactExternally(model: model, runId: runId, path: art.path, produced: produced) } } label: {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                preview
                Text(fileName).font(.caption).lineLimit(1).truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(Theme.Spacing.sm)
            .frame(maxWidth: .infinity)
            .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .help("\(art.path) — click to open full size")
        .task(id: identity) { await loadImage() }
    }

    @ViewBuilder private var preview: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().scaledToFit()
            } else if imageLoadFailed {
                Image(systemName: "photo.badge.exclamationmark").font(.system(size: 28)).foregroundStyle(.secondary)
                    .help("Too large to preview — click to open externally")
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .frame(height: 88).frame(maxWidth: .infinity)
        .background(Color.black.opacity(0.04), in: RoundedRectangle(cornerRadius: 6))
    }

    /// Off-main handoff of an already-bounded decode (same Swift 6 actor-
    /// crossing box as ScopedInlineImage). Equatable-by-identity so it can ride
    /// the value-typed load slot.
    struct DecodedImage: @unchecked Sendable, Equatable {
        let image: NSImage?
        static func == (lhs: DecodedImage, rhs: DecodedImage) -> Bool { lhs.image === rhs.image }
    }

    private func loadImage() async {
        let id = identity
        imageSlot.begin(id)
        guard imageSlot.state.value == nil else { return }
        let data = produced
            ? await model.producedBytes(runId: runId, path: art.path)
            : await model.artifactBytes(runId: runId, path: art.path)
        guard let data else {
            imageSlot.commit(.failed(.offline), for: id)
            return
        }
        // W3.7: the SAME bounded decode as inline chat previews, OFF the main
        // actor — a gallery of full-resolution screenshots must not full-decode
        // in `body`'s task.
        let key = "\(runId)|\(produced ? "produced" : "run")|\(art.path)"
        let decoded = await Task.detached(priority: .userInitiated) {
            DecodedImage(image: ScopedInlineImage.boundedPreview(data: data, cacheKey: key))
        }.value
        if decoded.image != nil {
            imageSlot.commit(.loaded(decoded), for: id)
        } else {
            imageSlot.commit(.failed(.notRenderable("Too large to preview — click to open externally")), for: id)
        }
    }
}

// MARK: - Document row (compact: name, size, one-line preview)

private struct ArtifactRow: View {
    @Environment(AppModel.self) private var model
    let runId: String
    let art: ArtifactInfo
    var produced: Bool = false

    /// D15 identity-keyed text slot: a row reused for a different run/path never
    /// shows the previous file's text. Fetched lazily so it both feeds the
    /// one-line preview AND warms the viewer — tapping opens INSTANTLY into
    /// whatever state the fetch is in (loading spinner / text / failed), which is
    /// the M9-UX item-8 bug fix: the viewer no longer blocks on the whole fetch
    /// before appearing.
    @State private var textSlot = PayloadSlot<String>()
    @State private var showViewer = false

    private var category: ArtifactCategory { ArtifactCategory.of(mime: art.mime, path: art.path) }
    private var isText: Bool { category == .text }
    private var identity: PayloadIdentity {
        PayloadIdentity(runId: runId, plane: produced ? .produced : .run, path: art.path)
    }
    private var fileName: String { (art.path as NSString).lastPathComponent }

    var body: some View {
        Button(action: tap) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: glyph).font(.body).foregroundStyle(.secondary)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(fileName).font(.callout).lineLimit(1).truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(subtitle).font(.caption2).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Image(systemName: isText ? "chevron.right" : "arrow.up.forward.app")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            .padding(.vertical, Theme.Spacing.xs)
            .padding(.horizontal, Theme.Spacing.sm)
            .frame(maxWidth: .infinity)
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 7))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(isText ? "\(art.path) — open text viewer" : "\(art.path) — open externally")
        // Lazily fetch text for the preview + viewer (visible rows only).
        .task(id: identity) { if isText { await loadText() } }
        .sheet(isPresented: $showViewer) { textViewer }
    }

    /// The one-line summary: type · size, plus a content preview once loaded.
    private var subtitle: String {
        var parts: [String] = []
        if let size = artifactSizeText(art.bytes) { parts.append(size) }
        if isText, let preview = previewLine {
            parts.append(preview)
        } else if !isText {
            parts.append(art.mime ?? "file")
        }
        return parts.isEmpty ? (art.mime ?? "file") : parts.joined(separator: " · ")
    }

    /// The first non-blank line of the loaded text, bounded — the row preview.
    private var previewLine: String? {
        switch textSlot.state {
        case .loaded(let text):
            let line = text.split(whereSeparator: \.isNewline)
                .first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            return line.map { String($0.prefix(140)) } ?? "(blank)"
        case .empty: return "(empty file)"
        case .loading, .idle: return "Loading…"
        case .failed: return nil
        }
    }

    private var glyph: String {
        if isText {
            let ext = (art.path as NSString).pathExtension.lowercased()
            if ext == "json" || art.mime == "application/json" { return "curlybraces" }
            if ext == "md" || ext == "markdown" { return "doc.text.image" }
            return "doc.text"
        }
        if art.mime == "application/pdf" { return "doc.richtext" }
        return "doc"
    }

    private func tap() {
        if isText {
            showViewer = true                       // opens INSTANTLY; content streams in
        } else {
            Task { await openArtifactExternally(model: model, runId: runId, path: art.path, produced: produced) }
        }
    }

    @ViewBuilder private var textViewer: some View {
        VStack(spacing: 0) {
            HStack {
                Text(fileName).font(.headline)
                Spacer()
                Button("Done") { showViewer = false }
            }
            .padding(Theme.Spacing.md)
            Divider()
            Group {
                switch textSlot.state {
                case .loaded(let text):
                    ScrollView {
                        MarkdownOutputView(markdown: text)
                            .padding(Theme.Spacing.md)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                case .empty:
                    ContentUnavailableView("Empty file", systemImage: "doc")
                case .failed(let error):
                    VStack(spacing: Theme.Spacing.sm) {
                        Text(error.message).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                            .multilineTextAlignment(.center)
                        Button("Retry") { Task { await loadText(force: true) } }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .idle, .loading:
                    ProgressView("Loading \(fileName)…").controlSize(.small)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .frame(minWidth: 520, minHeight: 360)
    }

    private func loadText(force: Bool = false) async {
        let id = identity
        if force { textSlot = PayloadSlot<String>() }
        textSlot.begin(id)
        // Already terminal for this identity (a warmed preview) — don't refetch.
        if !force, textSlot.state.isTerminal { return }
        // QA-067: typed outcome so a 409 sensitive-file refusal renders as its
        // typed reason (not a generic offline blob or a perpetual spinner).
        let outcome = produced
            ? await model.producedTextOutcome(runId: runId, path: art.path)
            : await model.artifactTextOutcome(runId: runId, path: art.path)
        switch outcome {
        case .success(let content):
            textSlot.commit(content.isEmpty ? .empty : .loaded(content), for: id)
        case .failure(let error):
            textSlot.commit(.failed(error), for: id)
        }
    }
}

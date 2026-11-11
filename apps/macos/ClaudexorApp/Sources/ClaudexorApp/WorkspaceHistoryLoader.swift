import Foundation

/// Independent of feed replay: one visible workspace read plus one pending
/// invalidation. Membership changes during a read cannot leave its roster stale.
@MainActor final class WorkspaceHistoryLoader {
    var task: Task<Void, Never>?
    private var key: String?
    private var token = UUID()
    private var dirty = false

    func load(key: String, read: @escaping @MainActor () async -> Void) async {
        if self.key == key, let task {
            dirty = true
            await task.value
            return
        }
        task?.cancel()
        self.key = key
        let ticket = UUID()
        token = ticket
        let request = Task { @MainActor in
            repeat {
                self.dirty = false
                await read()
            } while self.token == ticket && self.dirty && !Task.isCancelled
        }
        task = request
        await request.value
        if token == ticket { task = nil }
    }
}

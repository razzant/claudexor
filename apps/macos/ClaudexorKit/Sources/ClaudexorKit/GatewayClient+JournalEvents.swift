import Foundation

extension GatewayClient {
    /// Durable global journal stream. Project and run streams remain scoped;
    /// callers resnapshot the corresponding scope after a stale cursor.
    public func globalEvents(lastEventId: String? = nil) -> AsyncThrowingStream<JournalEvent, Error> {
        let frames = sseFrames(path: "v2/global/events", lastEventId: lastEventId)
        return AsyncThrowingStream(bufferingPolicy: .bufferingOldest(256)) { continuation in
            let task = Task {
                do {
                    for try await frame in frames {
                        if frame.event == "end" {
                            continuation.finish()
                            return
                        }
                        if frame.event == "error" { throw GatewayError.transport(frame.data) }
                        guard let data = frame.data.data(using: .utf8) else {
                            throw GatewayError.decoding("global SSE payload is not UTF-8")
                        }
                        let event = try Self.decoder.decode(JournalEvent.self, from: data)
                        guard event.schemaVersion == 1, event.partition == "global",
                              frame.id == event.cursor, frame.event == event.type else {
                            throw GatewayError.decoding("global SSE frame does not match its durable event")
                        }
                        guard try Self.yieldChecked(event, to: continuation, context: "global SSE") else { return }
                    }
                    throw GatewayError.transport("global SSE ended without a terminal end event")
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

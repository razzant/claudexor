import Foundation
import Testing
@testable import ClaudexorKit

/// TS↔Swift wire-fixture round-trip (D13, INV-138). Every generated fixture in
/// Fixtures/wire/ is decoded with its Swift DTO, re-encoded, and compared as
/// CANONICALIZED JSON — recursively key-sorted, numbers normalized, and nulls
/// treated as absent (a Swift optional that omits nil on encode is equivalent
/// to an explicit wire null; the generator emits nulls, Foundation omits them).
///
/// The manifest DRIVES coverage: a fixture without a manifest entry, a manifest
/// entry without a decoder, or a fixture file the test never visited all FAIL —
/// a new fixture can never be silently skipped.
@Suite struct WireFixtureRoundTripTests {

    /// Every manifest schema name MUST resolve to a Swift DTO here; an
    /// unhandled schema returns nil and fails `everyManifestSchemaHasADecoder`.
    /// Decode with the DTO, then re-encode — the raw bytes are compared as
    /// canonical JSON by the caller.
    private static func roundTrip(schema: String, _ data: Data) throws -> Data? {
        switch schema {
        case "ControlHandshakeResponse": return try recode(ControlHandshakeResponse.self, data)
        case "ControlProblem": return try recode(ControlProblem.self, data)
        case "ControlThread": return try recode(ThreadSummary.self, data)
        case "ControlThreadTurn": return try recode(ThreadTurnInfo.self, data)
        case "RunOutcomeFacts": return try recode(RunOutcomeFacts.self, data)
        case "ControlBudgetSnapshot": return try recode(BudgetSnapshot.self, data)
        case "PlanReadiness": return try recode(PlanReadiness.self, data)
        case "PlanQuestionsArtifact": return try recode(PlanQuestionsArtifact.self, data)
        case "ApplyEligibility": return try recode(ApplyEligibility.self, data)
        case "ControlQuotaResponse": return try recode(ControlQuotaResponse.self, data)
        case "ControlHarnessSettingsPatch": return try recode(HarnessSettingsPatch.self, data)
        default: return nil
        }
    }

    /// The set of schema names the switch above handles (kept in lockstep with it).
    private static let handledSchemas: Set<String> = [
        "ControlHandshakeResponse", "ControlProblem", "ControlThread", "ControlThreadTurn",
        "RunOutcomeFacts", "ControlBudgetSnapshot", "PlanReadiness", "PlanQuestionsArtifact",
        "ApplyEligibility", "ControlQuotaResponse", "ControlHarnessSettingsPatch",
    ]

    private static func recode<T: Codable>(_ type: T.Type, _ data: Data) throws -> Data {
        try JSONEncoder().encode(try JSONDecoder().decode(T.self, from: data))
    }

    private static func wireDir() throws -> URL {
        try #require(Bundle.module.url(
            forResource: "manifest", withExtension: "json", subdirectory: "Fixtures/wire"
        )).deletingLastPathComponent()
    }

    private static func loadManifest() throws -> [String: String] {
        let url = try #require(Bundle.module.url(
            forResource: "manifest", withExtension: "json", subdirectory: "Fixtures/wire"
        ))
        return try #require(
            JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: String]
        )
    }

    @Test func everyManifestSchemaHasADecoder() throws {
        let manifest = try Self.loadManifest()
        let missing = Set(manifest.values).subtracting(Self.handledSchemas)
        #expect(missing.isEmpty, Comment(rawValue: "manifest schemas without a Swift decoder: \(missing.sorted())"))
    }

    @Test func everyWireFixtureFileIsInTheManifest() throws {
        let manifest = try Self.loadManifest()
        let dir = try Self.wireDir()
        let files = try FileManager.default.contentsOfDirectory(atPath: dir.path)
            .filter { $0.hasSuffix(".json") && $0 != "manifest.json" }
            .map { String($0.dropLast(".json".count)) }
        let orphans = Set(files).subtracting(manifest.keys)
        #expect(orphans.isEmpty, Comment(rawValue: "wire fixtures not listed in manifest.json: \(orphans.sorted())"))
    }

    @Test func everyWireFixtureRoundTrips() throws {
        let manifest = try Self.loadManifest()
        let dir = try Self.wireDir()
        var failures: [String] = []

        for (name, schema) in manifest.sorted(by: { $0.key < $1.key }) {
            let url = dir.appendingPathComponent("\(name).json")
            guard let bytes = try? Data(contentsOf: url) else {
                failures.append("\(name): fixture file missing on disk")
                continue
            }
            guard let wrapper = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
                  let value = wrapper["value"] else {
                failures.append("\(name): fixture is not a {schema,value} wrapper")
                continue
            }
            do {
                let valueData = try JSONSerialization.data(withJSONObject: value)
                guard let reencoded = try Self.roundTrip(schema: schema, valueData) else {
                    failures.append("\(name): no decoder for schema '\(schema)'")
                    continue
                }
                let before = try JSONCanonical.canonical(valueData)
                let after = try JSONCanonical.canonical(reencoded)
                if before != after {
                    failures.append(
                        "\(name) [\(schema)] did not round-trip:\n  in : \(before)\n  out: \(after)"
                        + "\n  diff: \(JSONCanonical.firstDivergingKeyPath(before, after))")
                }
            } catch {
                failures.append("\(name) [\(schema)] threw: \(error)")
            }
        }

        for failure in failures { Issue.record(Comment(rawValue: failure)) }
        #expect(failures.isEmpty)
    }
}

/// Canonical-JSON comparator for the round-trip: recursively key-sorted,
/// numbers normalized to a stable form (integral doubles print without a
/// decimal), and object keys whose value is `null` dropped (absent == null).
enum JSONCanonical {
    static func canonical(_ data: Data) throws -> String {
        let object = try JSONSerialization.jsonObject(
            with: data, options: [.fragmentsAllowed])
        return render(object)
    }

    private static func render(_ value: Any) -> String {
        switch value {
        case is NSNull:
            return "null"
        case let number as NSNumber:
            return renderNumber(number)
        case let string as String:
            return encodeString(string)
        case let array as [Any]:
            return "[" + array.map(render).joined(separator: ",") + "]"
        case let dict as [String: Any]:
            // Drop null-valued keys: an omitted Swift optional equals an
            // explicit wire null (nulls normalized, per the M5a contract).
            let entries = dict
                .filter { !($0.value is NSNull) }
                .sorted { $0.key < $1.key }
                .map { "\(encodeString($0.key)):\(render($0.value))" }
            return "{" + entries.joined(separator: ",") + "}"
        default:
            return encodeString(String(describing: value))
        }
    }

    private static func renderNumber(_ number: NSNumber) -> String {
        // Distinguish JSON booleans (NSNumber bridges Bool with objCType "c").
        if CFGetTypeID(number) == CFBooleanGetTypeID() {
            return number.boolValue ? "true" : "false"
        }
        let d = number.doubleValue
        if d.rounded() == d && abs(d) < 9.007199254740992e15 {
            return String(Int64(d))
        }
        return String(d)
    }

    private static func encodeString(_ string: String) -> String {
        // JSON-escape via the standard encoder so keys/values compare exactly.
        if let data = try? JSONSerialization.data(withJSONObject: [string], options: [.fragmentsAllowed]),
           let text = String(data: data, encoding: .utf8) {
            return String(text.dropFirst().dropLast()) // strip the surrounding [ ]
        }
        return "\"\(string)\""
    }

    /// Best-effort human hint: the first top-level key that differs between two
    /// already-canonical strings (helps localize a mismatch in the report).
    static func firstDivergingKeyPath(_ a: String, _ b: String) -> String {
        let pairs = Array(zip(a, b))
        guard let offset = pairs.firstIndex(where: { $0 != $1 }) else {
            return a.count == b.count ? "(identical)" : "(length differs)"
        }
        let start = max(0, offset - 30)
        let window = { (s: String) -> String in
            let lo = s.index(s.startIndex, offsetBy: start)
            let hi = s.index(lo, offsetBy: min(60, s.distance(from: lo, to: s.endIndex)))
            return String(s[lo..<hi])
        }
        return "…\(window(a))…  vs  …\(window(b))…"
    }
}

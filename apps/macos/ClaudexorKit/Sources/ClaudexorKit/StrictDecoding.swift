import Foundation

protocol StrictCodingKey: CodingKey, CaseIterable where AllCases: Collection, AllCases.Element == Self {}

private struct AnyCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init?(intValue: Int) {
        stringValue = String(intValue)
        self.intValue = intValue
    }
}

func rejectUnknownKeys<Key: StrictCodingKey>(
    in decoder: Decoder,
    allowed: Key.Type
) throws {
    let actual = try decoder.container(keyedBy: AnyCodingKey.self).allKeys.map(\.stringValue)
    let expected = Set(Key.allCases.map(\.stringValue))
    if let unknown = actual.first(where: { !expected.contains($0) }) {
        throw DecodingError.dataCorrupted(.init(
            codingPath: decoder.codingPath,
            debugDescription: "Unknown field '\(unknown)'"
        ))
    }
}

func requireNullable<Value: Decodable, Key: CodingKey>(
    _ type: Value.Type,
    from container: KeyedDecodingContainer<Key>,
    forKey key: Key
) throws -> Value? {
    guard container.contains(key) else {
        throw DecodingError.keyNotFound(key, .init(
            codingPath: container.codingPath,
            debugDescription: "Required nullable field is missing"
        ))
    }
    return try container.decodeIfPresent(type, forKey: key)
}

func decodeOptionalNonNull<Value: Decodable, Key: CodingKey>(
    _ type: Value.Type,
    from container: KeyedDecodingContainer<Key>,
    forKey key: Key
) throws -> Value? {
    guard container.contains(key) else { return nil }
    return try container.decode(type, forKey: key)
}

func require(_ condition: @autoclosure () -> Bool, decoder: Decoder, _ message: String) throws {
    guard condition() else {
        throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: message))
    }
}

func isSHA256(_ value: String) -> Bool {
    value.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil
}

func isSetupExecutionID(_ value: String) -> Bool {
    value.range(of: #"^[A-Za-z0-9-]+$"#, options: .regularExpression) != nil
}

func isUnsignedDecimal(_ value: String) -> Bool {
    value.range(of: #"^[0-9]+$"#, options: .regularExpression) != nil
}

func parseOffsetTimestamp(_ value: String) -> Date? {
    guard value.range(of: #"(?:Z|[+-][0-9]{2}:[0-9]{2})$"#, options: .regularExpression) != nil else {
        return nil
    }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: value) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: value)
}

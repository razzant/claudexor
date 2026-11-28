struct Spec: Identifiable, Hashable {
    let id: String
    var title: String
    var frozen: Bool
    var version: Int
    var runIds: [String]
}

struct Project: Identifiable, Hashable {
    let id: String
    var name: String
    var specs: [Spec]
}

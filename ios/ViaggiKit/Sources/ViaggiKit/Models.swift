// Data as exported to data/*.json by tools/export-data.mjs.
import Foundation

public struct City: Codable, Hashable, Identifiable {
    public let id: String, name: String, country: String
    public let lat: Double, lon: Double, tz: String
    /// 1 major hub, 2 large city, 3 regional, 4 remote
    public let tier: Int
    /// Cost-of-living index, 1.0 = European average
    public let idx: Double
    public let apt: String
    /// Airport to city centre: minutes and pounds, one way
    public let xfer: Int, xferCost: Int
    public let emoji: String, souvenir: String
    /// On the rail and ferry map only: no flights
    public let railOnly: Bool
}

public struct CarrierDef: Codable { public let code: String, name: String, type: String, hubs: [String: Double] }
public struct AirlineDef: Codable { public let code: String, kind: String, shown: String? }
public struct AirRouteDef: Codable { public let a: String, b: String, airline: String, seasonal: Bool }
public struct RailDef: Codable {
    public let a: String, b: String, minutes: Int, perDay: Int, code: String, name: String, premium: Bool, sleeperPerWeek: Int
}
public struct FerryDef: Codable {
    public let a: String, portA: String, linkA: String, minsA: Int
    public let b: String, portB: String, linkB: String, minsB: Int
    public let minutes: Int, summer: Int, winter: Int, code: String, name: String
}

/// A region pack: everything the engine knows about one part of the world.
public struct Region: Codable {
    public let id: String, name: String, currency: String
    public let cities: [City]
    public let countryNames: [String: String]
    public let carriers: [CarrierDef]
    public let airlines: [String: AirlineDef]
    public let airlinesDropped: [String]
    public let winterResorts: [String]
    public let airRoutesDate: String
    public let airRoutes: [AirRouteDef]
    public let rail: [RailDef]
    public let ferries: [FerryDef]
}

public enum Mode: String, Codable, CaseIterable { case air, rail, ferry }

/// A journey the player can choose.
public struct Challenge: Codable, Identifiable {
    public var id: String
    public var pack: String
    public var modes: [Mode]
    public var rail: String?
    public var domestic: [String]?
    public var name: String
    public var blurb: String
    public var home: String
    public var targets: [String]
    /// Start date, local to the home city: [year, month, day]
    public var date: [Int]
    public var hours: Int
    public var budget: Int
    public var parHours: Int
    public var level: String
    public var training: Bool?
    public var seed: String?
    public var key: String?
    public var startMinutes: Int?
    /// No deadline: the aim is the fastest finish.
    public var untimed: Bool?

    public var isTraining: Bool { training ?? false }
    public var isUntimed: Bool { untimed ?? false }
}

public struct ChallengeFile: Codable { public let challenges: [Challenge]; public let training: Challenge }

/// Loads the bundled data files.
public enum GameData {
    public static func load<T: Decodable>(_ name: String, as type: T.Type = T.self) throws -> T {
        guard let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Resources") else {
            throw CocoaError(.fileNoSuchFile)
        }
        return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
    }
    public static func europe() throws -> Region { try load("europe") }
    public static func challenges() throws -> ChallengeFile { try load("challenges") }
    public static func postcards() throws -> [String: String] { try load("postcards") }
}

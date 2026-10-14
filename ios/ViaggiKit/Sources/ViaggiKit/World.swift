// The world: a region pack turned into a queryable timetable. Each transport
// mode is a provider that returns recurring services ("airline X flies A to B
// twice a day"); the world turns them into dated departures on demand.
// Matches src/engine/world.js.
import Foundation

public struct PortLink: Equatable {
    public let name: String
    /// "taxi" or "train"
    public let kind: String
    public let mins: Int
    public let cost: Int
}

public struct Service {
    public let mode: Mode
    public let carrierCode: String, carrierName: String, carrierType: String
    public let km: Double
    public let pair: String
    public let from: String, to: String
    public let freq: Int
    public let dayP: Double
    /// "summer", "winter" or nil for all year
    public let season: String?
    public let durMin: Int
    public let sleeper: Bool
    /// Summer and winter departures per week, for ferries and sleepers
    public let perWeek: [Int]?
    public let cabin: Int
    public let back: Bool
    public let port: PortLink?, portTo: PortLink?
    let fare: (_ tod: Double, _ season: Double, _ scarcity: Double) -> Double

    func reversed() -> Service {
        Service(mode: mode, carrierCode: carrierCode, carrierName: carrierName, carrierType: carrierType, km: km, pair: pair,
                from: to, to: from, freq: freq, dayP: dayP, season: season, durMin: durMin, sleeper: sleeper, perWeek: perWeek,
                cabin: cabin, back: true, port: portTo, portTo: port, fare: fare)
    }
}

public struct Leg: Identifiable {
    public let id: String
    public let mode: Mode
    public let from: String, to: String
    public let dep: Millis, arr: Millis
    public let durMin: Int
    public let km: Double
    public let carrier: String, code: String, kind: String
    public let no: String
    public let port: PortLink?, portTo: PortLink?
    public let berth: Bool, sleeper: Bool
    public let fare: Int
    public let seats: Int?
}

private let SEASON = [0.8, 0.8, 0.9, 1.0, 1.05, 1.2, 1.5, 1.5, 1.15, 1.0, 0.85, 1.2]
private let FIRST_DEP = 6.0 * 60, LAST_DEP = 21.0 * 60 + 30
private let SUMMER_MONTHS: Set<Int> = [5, 6, 7, 8, 9]

private func timeOfDay(_ minutes: Int) -> Double {
    if minutes < 7 * 60 { return 0.8 }
    if minutes < 9 * 60 + 30 { return 1.2 }
    if minutes >= 16 * 60 + 30 && minutes < 19 * 60 + 30 { return 1.2 }
    if minutes >= 20 * 60 { return 0.85 }
    return 1
}

/// Seasonal services: summer is April to October, winter November to April.
public func inSeason(_ s: Service, month: Int) -> Bool {
    guard let season = s.season else { return true }
    return season == "summer" ? (month >= 4 && month <= 10) : (month >= 11 || month <= 4)
}

/// Which surface routes a journey uses: international, one country, or international plus some home networks.
public struct Scope {
    public var rail: String = "international"
    public var domestic: [String] = []
    public var home: String? = nil
    public init(rail: String? = nil, domestic: [String]? = nil, home: String? = nil) {
        self.rail = rail ?? "international"; self.domestic = domestic ?? []; self.home = home
    }
    public init(_ c: Challenge) { self.init(rail: c.rail, domestic: c.domestic, home: c.home) }

    func allows(_ A: City, _ B: City, majorOnly: Bool) -> Bool {
        if A.country == B.country { return rail == A.country || domestic.contains(A.country) }
        return rail == "international" && (!majorOnly || (A.tier <= 2 && B.tier <= 2))
    }
}

// MARK: - Providers

private func airFare(_ km: Double, lowcost: Bool) -> (Double, Double, Double) -> Double {
    { tod, season, scarcity in (15 + 0.35 * pow(km, 0.8)) * season * tod * scarcity * (lowcost ? 0.65 : 1.15) }
}

/// Flights from the real route list. How often each route runs is estimated
/// from the airline's kind and the size of the cities.
private func realAir(_ region: Region, _ cities: [String: City]) -> [Service] {
    var hubs: [String: [String]] = [:]
    for k in region.carriers { hubs[k.code] = Array(k.hubs.keys) }
    struct Merged { let a: String, b: String, code: String, kind: String, name: String; var seasonal: Bool }
    var merged = OrderedMap<String, Merged>()
    for r in region.airRoutes {
        if region.airlinesDropped.contains(r.airline) { continue }
        guard let A = cities[r.a], let B = cities[r.b], !A.railOnly, !B.railOnly else { continue }
        let def = region.airlines[r.airline]
        let code = def?.code ?? String(r.airline.filter { $0.isASCII && $0.isLetter }.prefix(2)).uppercased()
        let kind = def?.kind ?? "lowcost"
        let key = "\(code)-\(r.a)-\(r.b)"
        let old = merged[key]
        // The same pair can be listed under a parent and its subsidiary: year-round wins.
        merged[key] = Merged(a: r.a, b: r.b, code: code, kind: kind, name: def?.shown ?? r.airline,
                             seasonal: old.map { $0.seasonal && r.seasonal } ?? r.seasonal)
    }
    var out: [Service] = []
    for r in merged.values {
        let A = cities[r.a]!, B = cities[r.b]!, km = distKm(A, B)
        let tA = min(3, A.tier), tB = min(3, B.tier), lowcost = r.kind == "lowcost"
        let atHub = (hubs[r.code] ?? []).contains { $0 == r.a || $0 == r.b }
        let remote = A.tier == 4 || B.tier == 4
        let freq = lowcost ? (tA + tB <= 2 ? 2 : 1) : remote ? 2 : atHub ? max(1, 5 - tA - tB) : 1
        let dayP = lowcost ? [1, 1, 1, 0.85, 0.6, 0.45, 0.3][tA + tB] : atHub ? 1 : 0.6
        let season: String? = r.seasonal
            ? (region.winterResorts.contains(r.a) || region.winterResorts.contains(r.b) ? "winter" : "summer") : nil
        let s = Service(mode: .air, carrierCode: r.code, carrierName: r.name, carrierType: r.kind, km: km, pair: "\(r.code)-\(r.a)-\(r.b)",
                        from: r.a, to: r.b, freq: freq, dayP: dayP, season: season, durMin: round5(35 + km / 800 * 60),
                        sleeper: false, perWeek: nil, cabin: 0, back: false, port: nil, portTo: nil, fare: airFare(km, lowcost: lowcost))
        // The return direction is not marked `back` for flights, as in the prototype.
        let r2 = Service(mode: .air, carrierCode: s.carrierCode, carrierName: s.carrierName, carrierType: s.carrierType, km: km, pair: s.pair,
                         from: r.b, to: r.a, freq: freq, dayP: dayP, season: season, durMin: s.durMin, sleeper: false, perWeek: nil,
                         cabin: 0, back: false, port: nil, portTo: nil, fare: s.fare)
        out.append(s); out.append(r2)
    }
    return out
}

private func railServices(_ region: Region, _ cities: [String: City], _ scope: Scope) -> [Service] {
    var out: [Service] = []
    for r in region.rail {
        let A = cities[r.a]!, B = cities[r.b]!
        if !scope.allows(A, B, majorOnly: true) { continue }
        let sleeper = r.sleeperPerWeek > 0, minutes = Double(r.minutes), avg = (A.idx + B.idx) / 2
        // Rail fares rise more slowly than journey time, and only partly with local prices.
        let fare: (Double, Double, Double) -> Double = { tod, _, scarcity in
            (5 + 0.75 * pow(sleeper ? minutes * 0.6 : minutes, 0.75)) * avg.squareRoot() * tod * (1 + (scarcity - 1) * 0.6) * (r.premium ? 1.7 : 1)
        }
        let s = Service(mode: .rail, carrierCode: r.code, carrierName: r.name, carrierType: "rail", km: distKm(A, B), pair: "\(r.code)-\(r.a)-\(r.b)",
                        from: r.a, to: r.b, freq: r.perDay, dayP: 1, season: nil, durMin: r.minutes, sleeper: sleeper,
                        perWeek: sleeper ? [r.sleeperPerWeek, r.sleeperPerWeek] : nil, cabin: jsRound(35 * avg), back: false,
                        port: nil, portTo: nil, fare: fare)
        out.append(s); out.append(s.reversed())
    }
    return out
}

private func ferryServices(_ region: Region, _ cities: [String: City], _ scope: Scope) -> [Service] {
    var out: [Service] = []
    func link(_ city: City, _ name: String, _ kind: String, _ mins: Int) -> PortLink {
        PortLink(name: name, kind: kind, mins: mins, cost: jsRound((kind == "taxi" ? 8 : 0.25 * Double(mins)) * city.idx))
    }
    for f in region.ferries {
        let A = cities[f.a]!, B = cities[f.b]!
        if !scope.allows(A, B, majorOnly: false) { continue }
        let minutes = Double(f.minutes)
        let fare: (Double, Double, Double) -> Double = { _, season, scarcity in
            (10 + 0.03 * minutes) * (season > 1.1 ? 1.3 : 1) * (1 + (scarcity - 1) * 0.5)
        }
        let s = Service(mode: .ferry, carrierCode: f.code, carrierName: f.name, carrierType: "ferry", km: distKm(A, B), pair: "\(f.code)-\(f.a)-\(f.b)",
                        from: f.a, to: f.b, freq: 0, dayP: 1, season: nil, durMin: f.minutes, sleeper: false, perWeek: [f.summer, f.winter],
                        cabin: jsRound(25 * ((A.idx + B.idx) / 2)), back: false,
                        port: link(A, f.portA, f.linkA, f.minsA), portTo: link(B, f.portB, f.linkB, f.minsB), fare: fare)
        out.append(s); out.append(s.reversed())
    }
    return out
}

/// Local departure times (minutes after midnight) for one service on one day.
private func slots(_ s: Service, month: Int, dow: Int) -> [Int] {
    let jitter = Rng.rand("slot|\(s.pair)|\(s.from)")
    guard let perWeekBoth = s.perWeek else {
        return (0..<s.freq).map { i in round5(FIRST_DEP + (Double(i) + jitter) / Double(s.freq) * (LAST_DEP - FIRST_DEP)) }
    }
    let perWeek = perWeekBoth[SUMMER_MONTHS.contains(month) ? 0 : 1]
    if perWeek == 0 { return [] }
    if perWeek < 7 {
        // A few sailings a week: fixed weekdays, the ship returning the day after it arrives.
        let shift = s.back ? 1 + Int((Double(s.durMin) / 1440).rounded(.up)) : 0
        let offset = (Int(Rng.hash("days|\(s.pair)")) + shift) % 7
        let days = (0..<perWeek).map { k in (offset + (k * 7) / perWeek) % 7 }
        if !days.contains(dow) { return [] }
    }
    let perDay = max(1, jsRound(Double(perWeek) / 7))
    if s.durMin >= 480 && perDay <= 2 {
        // Long crossings and sleepers leave in the evening, with a morning one if there are two.
        let evening = round5((s.sleeper ? 19.5 : 18) * 60 + jitter * (s.sleeper ? 110 : 180))
        return Array([evening, round5(8 * 60 + jitter * 120)].prefix(perDay))
    }
    return (0..<perDay).map { i in round5(FIRST_DEP + (Double(i) + jitter) / Double(perDay) * (LAST_DEP - FIRST_DEP)) }
}

// MARK: - World

public final class World {
    public let region: Region
    public let modes: [Mode]
    public let cities: [String: City]
    /// Services leaving each city, in a stable order.
    public private(set) var services: [String: [Service]] = [:]
    private var cache: [String: [Leg]] = [:]

    public init(region: Region, modes: [Mode] = [.air], scope: Scope = Scope()) {
        self.region = region
        self.modes = modes
        var byId: [String: City] = [:]
        for c in region.cities { byId[c.id] = c }
        cities = byId
        var all: [Service] = []
        for mode in modes {
            switch mode {
            case .air: all += realAir(region, byId)
            case .rail: all += railServices(region, byId, scope)
            case .ferry: all += ferryServices(region, byId, scope)
            }
        }
        if let home = scope.home, !modes.contains(.air) {
            // Keep only the part of the surface network that can be reached from home.
            var linked: Set<String> = [home]
            var grew = true
            while grew {
                grew = false
                for s in all where linked.contains(s.from) && !linked.contains(s.to) { linked.insert(s.to); grew = true }
            }
            all = all.filter { linked.contains($0.from) }
        }
        for c in region.cities { services[c.id] = [] }
        for s in all { services[s.from, default: []].append(s) }
    }

    public convenience init(region: Region, challenge: Challenge) {
        self.init(region: region, modes: challenge.modes, scope: Scope(challenge))
    }

    /// Every departure leaving a city on a local calendar day, sorted by time.
    public func departures(_ cityId: String, _ y: Int, _ m: Int, _ d: Int) -> [Leg] {
        let key = "\(cityId)|\(y)-\(m)-\(d)"
        if let hit = cache[key] { return hit }
        let tz = cities[cityId]!.tz, dow = weekday(y, m, d)
        var legs: [Leg] = []
        for s in services[cityId] ?? [] {
            if !inSeason(s, month: m) { continue }
            if s.dayP < 1 && Rng.rand("day|\(s.pair)|\(dow)") >= s.dayP { continue }
            let number = 100 + Int(Rng.hash("no|\(s.pair)") % 880) * 10 + (s.from < s.to ? 0 : 1)
            for (i, minutes) in slots(s, month: m, dow: dow).enumerated() {
                let dep = localToUtc(tz, y, m, d, minutes)
                let id = "\(s.pair)|\(s.from)|\(y)-\(m)-\(d)|\(i)"
                let tight = Rng.rand("seats|\(id)")
                let scarcity = 1 + 0.6 * tight * tight
                // A sailing or sleeper of seven hours or more that runs through the night includes a berth.
                let berth = (s.mode == .ferry || s.sleeper) && s.durMin >= 420 && minutes + s.durMin >= 24 * 60
                let fare = max(9, jsRound(s.fare(timeOfDay(minutes), SEASON[m - 1], scarcity))) + (berth ? s.cabin : 0)
                legs.append(Leg(id: id, mode: s.mode, from: s.from, to: s.to, dep: dep, arr: dep + s.durMin * MIN, durMin: s.durMin,
                                km: s.km, carrier: s.carrierName, code: s.carrierCode, kind: s.carrierType, no: "\(s.carrierCode) \(number + i * 2)",
                                port: s.port, portTo: s.portTo, berth: berth, sleeper: s.sleeper, fare: fare,
                                seats: tight > 0.85 ? 1 + Int((Rng.rand("left|\(id)") * 4).rounded(.down)) : nil))
            }
        }
        legs = legs.stableSorted { $0.dep < $1.dep }
        cache[key] = legs
        return legs
    }

    /// Departures on the local calendar day that contains an instant.
    public func departuresOn(_ cityId: String, _ ms: Millis) -> [Leg] {
        let p = local(cities[cityId]!.tz, ms)
        return departures(cityId, p.y, p.m, p.d)
    }
}

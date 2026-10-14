// Route planning: earliest arrival across the timetable, calibration of
// journeys, route options for the Routes tab, and the daily challenge.
// Matches src/engine/planner.js and dailyChallenge in src/data/challenges.js.
import Foundation

public struct PlanState {
    public let t: Millis
    public let cost: Int
    public let legs: [Leg]
    public let city: String
    public let place: Place
    public let port: PortLink?
}

private let placeFor: [Mode: Place] = [.air: .airport, .rail: .city, .ferry: .port]

/// Earliest-arrival search over the timetable (a time-dependent Dijkstra).
public func earliest(world: World, from: String, place: Place, t0: Millis, to: String, port: PortLink? = nil) -> PlanState? {
    var best = OrderedMap<String, PlanState>()
    best["\(from)|\(place.rawValue)|\(port?.name ?? "")"] = PlanState(t: t0, cost: 0, legs: [], city: from, place: place, port: port)
    var done = Set<String>()
    while true {
        var key: String? = nil, cur: PlanState? = nil
        for (k, v) in best.entries where !done.contains(k) && (cur == nil || v.t < cur!.t) { key = k; cur = v }
        guard let c = cur, let k = key else { return nil }
        if c.city == to { return c }
        done.insert(k)
        let city = world.cities[c.city]!
        let legs = world.departuresOn(c.city, c.t) + world.departuresOn(c.city, c.t + 24 * HOUR)
        for leg in legs {
            let l = Game.lead(city, c.place, leg, c.port)
            if leg.dep < c.t + l.min * MIN { continue }
            let p = placeFor[leg.mode]!, at = leg.mode == .ferry ? leg.portTo : nil
            let nk = "\(leg.to)|\(p.rawValue)|\(at?.name ?? "")"
            if let old = best[nk], leg.arr >= old.t { continue }
            best[nk] = PlanState(t: leg.arr, cost: c.cost + leg.fare + l.cost, legs: c.legs + [leg], city: leg.to, place: p, port: at)
        }
    }
}

public struct PlayedOrder { public let hours: Double; public let cost: Int; public let nights: Int; public let route: [String] }

/// Visits the targets in a given order, always taking the earliest connection.
public func playOrder(world: World, challenge ch: Challenge, order: [String]) -> PlayedOrder? {
    let home = world.cities[ch.home]!
    let start = localToUtc(home.tz, ch.date[0], ch.date[1], ch.date[2], ch.startMinutes ?? 8 * 60)
    var t = start, place: Place = world.modes.contains(.air) ? .airport : .city, at = ch.home, cost = 0
    var port: PortLink? = nil
    var route: [String] = []
    for stop in order + [ch.home] {
        guard let r = earliest(world: world, from: at, place: place, t0: t, to: stop, port: port) else { return nil }
        t = r.t; cost += r.cost; place = r.place; port = r.port; at = stop
        route += r.legs.map(\.to)
        if stop == ch.home { break }
        let c = world.cities[stop]!
        t += ((place == .airport ? c.xfer : place == .port ? port!.mins : 0) + RULES.dwell) * MIN
        cost += (place == .airport ? c.xferCost : place == .port ? port!.cost : 0) + jsRound(8 * c.idx)
        place = .city; port = nil
    }
    let hours = Double(t - start) / Double(HOUR), nights = Int(((hours + 8) / 24).rounded(.down))
    return PlayedOrder(hours: hours, cost: jsRound(Double(cost + nights * 80)), nights: nights, route: route)
}

func permutations<T>(_ a: [T]) -> [[T]] {
    if a.count <= 1 { return [a] }
    return a.indices.flatMap { i -> [[T]] in
        var rest = a; let x = rest.remove(at: i)
        return permutations(rest).map { [x] + $0 }
    }
}

public struct Calibration { public let runs: Int; public let inTime: Int; public let fast: PlayedOrder; public let cheap: PlayedOrder? }

/// Plays every visiting order on the undisrupted timetable: proves a journey is winnable and sets its limits.
public func calibrate(world: World, challenge ch: Challenge) -> Calibration {
    let runs = permutations(ch.targets).compactMap { playOrder(world: world, challenge: ch, order: $0) }
    let fast = runs.stableSorted { $0.hours < $1.hours }[0]
    let inTime = ch.hours > 0 ? runs.filter { $0.hours <= Double(ch.hours) } : runs
    let cheap = inTime.stableSorted { $0.cost < $1.cost }.first
    return Calibration(runs: runs.count, inTime: inTime.count, fast: fast, cheap: cheap)
}

// MARK: - Route options

public struct RouteLeg { public let leg: Leg; public let dep: Millis; public let arr: Millis }
public struct RouteOption {
    public var labels: [String]
    public let t: Millis, money: Int, nights: Int
    public let legs: [RouteLeg]
    let sig: String
}

private func dayNumber(_ tz: String, _ ms: Millis) -> Int { let p = local(tz, ms - 2 * HOUR); return daysFromCivil(p.y, p.m, p.d) }
private func hotelRate(_ city: City, _ place: Place) -> Int { jsRound(87 * city.idx) + (place == .airport ? 6 : 0) }
private let HORIZON = 96 * HOUR

private struct SearchState { let t: Millis, money: Int, nights: Int, key: Double, legs: [RouteLeg], city: String, place: Place, port: PortLink? }

private func search(_ g: Game, perHour: Double, statusOf: (Leg) -> LegStatus) -> OrderedMap<String, SearchState> {
    let world = g.world
    var best = OrderedMap<String, SearchState>()
    best["\(g.city)|\(g.place.rawValue)|\(g.port?.name ?? "")"] =
        SearchState(t: g.clock, money: 0, nights: 0, key: 0, legs: [], city: g.city, place: g.place, port: g.port)
    var done = Set<String>()
    while true {
        var key: String? = nil, cur: SearchState? = nil
        for (k, v) in best.entries where !done.contains(k) && (cur == nil || v.key < cur!.key) { key = k; cur = v }
        guard let c = cur, let k = key else { break }
        done.insert(k)
        let city = world.cities[c.city]!
        for day in 0..<4 {
            for leg in world.departuresOn(c.city, c.t + day * 24 * HOUR) {
                let st = statusOf(leg)
                if st.status == "cancelled" || st.dep > g.clock + HORIZON { continue }
                let l = Game.lead(city, c.place, leg, c.port)
                if st.dep < c.t + l.min * MIN { continue }
                let nights = max(0, dayNumber(city.tz, st.dep) - dayNumber(city.tz, c.t))
                let money = c.money + leg.fare + l.cost + nights * hotelRate(city, c.place)
                let score = Double(money) + perHour * (Double(st.arr - g.clock) / Double(HOUR))
                let place = placeFor[leg.mode]!, port = leg.mode == .ferry ? leg.portTo : nil
                let nk = "\(leg.to)|\(place.rawValue)|\(port?.name ?? "")"
                if let old = best[nk], score >= old.key { continue }
                best[nk] = SearchState(t: st.arr, money: money, nights: c.nights + nights, key: score, legs: c.legs + [RouteLeg(leg: leg, dep: st.dep, arr: st.arr)],
                                       city: leg.to, place: place, port: port)
            }
        }
    }
    var byCity = OrderedMap<String, SearchState>()
    for v in best.values where !v.legs.isEmpty { if let have = byCity[v.city], v.key >= have.key { continue }; byCity[v.city] = v }
    return byCity
}

private let STYLES: [(String, Double)] = [("Fastest", 1000), ("Cheapest", 0.5), ("Best value", 12)]

/// Up to three distinct ways to each city: fastest, cheapest and best value.
/// Costs include an estimate for any hotel night spent waiting.
public func routeOptions(_ g: Game, statusOf: (Leg) -> LegStatus) -> [(city: String, options: [RouteOption])] {
    var out = OrderedMap<String, [RouteOption]>()
    for (label, perHour) in STYLES {
        for (city, r) in search(g, perHour: perHour, statusOf: statusOf).entries {
            var list = out[city] ?? []
            let sig = r.legs.map(\.leg.id).joined(separator: ">")
            if let i = list.firstIndex(where: { $0.sig == sig }) { list[i].labels.append(label) }
            else { list.append(RouteOption(labels: [label], t: r.t, money: r.money, nights: r.nights, legs: r.legs, sig: sig)) }
            out[city] = list
        }
    }
    return out.entries.map { ($0.0, $0.1) }
}

// MARK: - Daily challenge

/// One shared journey per calendar day: same cities, timetable and disruption for everyone.
public func dailyChallenge(world: World, year: Int, month: Int, day: Int) -> Challenge {
    let key = "\(year)-\(month)-\(day)"
    let pool = world.region.cities.filter { $0.id != "LON" && !$0.railOnly && $0.tier <= 3 }
        .map { (Rng.rand("daily|\(key)|\($0.id)"), $0.id) }.stableSorted { $0.0 < $1.0 }
    var ch = Challenge(id: "daily", pack: "air", modes: [.air], rail: nil, domestic: nil, name: "Daily Challenge",
                       blurb: "Four cities, new every day. Everyone gets the same timetable and the same trouble.",
                       home: "LON", targets: pool.prefix(4).map(\.1), date: [year, month, day], hours: 0, budget: 0, parHours: 0,
                       level: "Today", training: nil, seed: "daily-\(key)", key: key, startMinutes: nil, untimed: nil)
    let fast = calibrate(world: world, challenge: ch).fast
    ch.hours = Int((fast.hours * 1.4).rounded(.up))
    ch.parHours = Int((fast.hours * 1.12).rounded(.up))
    ch.budget = Int((Double(fast.cost) * 1.2 / 50).rounded(.up)) * 50
    return ch
}

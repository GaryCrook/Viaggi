// Disruption: strikes, storms and sudden airport closures, generated once per
// game from the seed. Matches src/engine/events.js.
import Foundation

public struct GameEvent: Equatable {
    public enum Kind: String { case strike, storm, closure }
    public let type: Kind
    public var mode: Mode? = nil
    public var country: String? = nil
    public var city: String? = nil
    public var alt: String? = nil
    /// When the news is announced
    public let at: Millis
    public let from: Millis, to: Millis
    public let text: String
}

public struct LegStatus {
    /// "ontime", "delayed" or "cancelled"
    public var status: String = "ontime"
    public var dep: Millis
    public var arr: Millis
    public var divertTo: String? = nil
    public var known: Bool = true
}

private func pick<T>(_ list: [T], _ key: String) -> T { list[Int((Rng.rand(key) * Double(list.count)).rounded(.down))] }

public func generateEvents(world: World, challenge: Challenge, start: Millis, seed: String) -> [GameEvent] {
    let cities = world.cities, region = world.region, modes = world.modes
    let hours = challenge.hours
    let home = cities[challenge.home]!
    let targets = challenge.targets.map { cities[$0]! }
    let all = region.cities.compactMap { cities[$0.id] }.filter { !(world.services[$0.id] ?? []).isEmpty }
    var events: [GameEvent] = []

    // 1. A national strike on day two, announced from the start.
    let strikeCountry: String
    if Rng.rand("\(seed)|strike-where") < 0.6 {
        strikeCountry = pick(targets, "\(seed)|strike-target").country
    } else {
        let pool = Array((all.filter { $0.country != home.country } + all).prefix(all.count))
        strikeCountry = pick(pool, "\(seed)|strike-any").country
    }
    let strikeMode: Mode = !modes.contains(.air) || (modes.contains(.rail) && Rng.rand("\(seed)|strike-mode") < 0.35) ? .rail : .air
    // In a single-country game a full-day strike would stop everything, so it lasts eight hours.
    let national = Set(all.map(\.country)).count == 1
    let strikeFrom = start + (national ? 25 : 22) * HOUR, strikeTo = strikeFrom + (national ? 8 : 24) * HOUR
    let place = region.countryNames[strikeCountry] ?? strikeCountry
    let text = strikeMode == .air
        ? "Air traffic control strike in \(place) on \(fmtDay(home.tz, strikeFrom + 6 * HOUR)). Most flights will be cancelled."
        : "Rail strike in \(place) on \(fmtDay(home.tz, strikeFrom + 6 * HOUR))\(national ? ", \(fmtTime(home.tz, strikeFrom)) to \(fmtTime(home.tz, strikeTo))" : ""). Most trains will be cancelled."
    events.append(GameEvent(type: .strike, mode: strikeMode, country: strikeCountry, at: start, from: strikeFrom, to: strikeTo, text: text))

    // 2. Storms: six hours of delays at one city, forecast five hours ahead.
    // (The prototype keeps fractions of a millisecond here; rounding up gives the same comparisons.)
    let stormCount = hours > 60 ? 2 : 1
    let stormCities = targets + all.filter { $0.tier == 1 }
    for i in 0..<stormCount {
        let city = pick(stormCities, "\(seed)|storm-city|\(i)")
        let from = start + Int(((6 + Rng.rand("\(seed)|storm-time|\(i)") * Double(max(6, hours - 18))) * Double(HOUR)).rounded(.up))
        events.append(GameEvent(type: .storm, city: city.id, at: from - 5 * HOUR, from: from, to: from + 6 * HOUR,
                                text: "Storm warning for \(city.name) from \(fmtTime(city.tz, from)) local on \(fmtDay(city.tz, from)). Expect long delays."))
    }

    // 3. A sudden airport closure: inbound flights divert to the nearest alternative.
    if hours > 30 && modes.contains(.air) {
        let city = pick(targets, "\(seed)|close-city")
        let from = start + Int(((12 + Rng.rand("\(seed)|close-time") * Double(hours - 24)) * Double(HOUR)).rounded(.up))
        let alt = all.filter { $0.id != city.id }.stableSorted { distKm($0, city) < distKm($1, city) }[0]
        events.append(GameEvent(type: .closure, city: city.id, alt: alt.id, at: from - 30 * MIN, from: from, to: from + 5 * HOUR,
                                text: "Security alert at \(city.name) airport. Inbound flights are diverting to \(alt.name)."))
    }
    return events.stableSorted { $0.at < $1.at }
}

/// What the events do to one departure. `now` hides sudden events until they are announced.
public func legStatus(_ events: [GameEvent], _ leg: Leg, world: World, seed: String, now: Millis = .max) -> LegStatus {
    let from = world.cities[leg.from]!, to = world.cities[leg.to]!
    var out = LegStatus(dep: leg.dep, arr: leg.arr)
    for e in events {
        if e.type == .strike, e.mode == leg.mode, leg.dep >= e.from, leg.dep < e.to,
           from.country == e.country || to.country == e.country,
           Rng.rand("\(seed)|strike|\(leg.id)") < 0.75 {
            out.status = "cancelled"
        }
        if e.type == .storm, e.city == leg.from, leg.dep >= e.from, leg.dep < e.to {
            let r = Rng.rand("\(seed)|storm|\(leg.id)")
            if r < 0.15 { out.status = "cancelled" }
            else if out.status != "cancelled" {
                let delay = round5(45 + (r - 0.15) / 0.85 * 135) * MIN
                out.status = "delayed"; out.dep = leg.dep + delay; out.arr = leg.arr + delay
            }
        }
    }
    for e in events where e.type == .closure && leg.mode == .air && e.city == leg.to && out.arr >= e.from && out.arr < e.to && out.status != "cancelled" {
        out.divertTo = e.alt
        out.arr += 35 * MIN
        out.known = now >= e.at
    }
    return out
}

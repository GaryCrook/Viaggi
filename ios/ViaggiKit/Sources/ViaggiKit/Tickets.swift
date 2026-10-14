// Bonus tickets: secret optional objectives. Two are drawn each game; the
// player keeps one or both. Matches src/engine/tickets.js.
import Foundation

public struct Ticket: Equatable, Identifiable {
    public let id: String, icon: String, name: String, text: String
    public var city: String? = nil
    public var cities: [String] = []
    public var count: Int = 0
    public var spare: Int = 0
}

private let COMPASS: [(String, String, String, (City) -> Bool)] = [
    ("north", "Far North", "Touch down north of 60°N", { $0.lat > 59.9 }),
    ("south", "Deep South", "Touch down south of 39°N", { $0.lat < 39 }),
    ("east", "Far East", "Touch down east of 23°E", { $0.lon > 23 }),
]

public func drawTickets(world: World, challenge ch: Challenge, seed: String) -> [Ticket] {
    // Only places this game's transport can actually reach.
    let cities = world.region.cities.compactMap { world.cities[$0.id] }.filter { !(world.services[$0.id] ?? []).isEmpty }
    let air = world.modes.contains(.air), rail = world.modes.contains(.rail)
    let listed = [ch.home] + ch.targets
    var deck: [Ticket] = []

    let detours = cities.filter { $0.tier <= 2 && !listed.contains($0.id) }
    if !detours.isEmpty {
        let d = detours[Int((Rng.rand("\(seed)|detour") * Double(detours.count)).rounded(.down))]
        deck.append(Ticket(id: "detour", icon: d.emoji, name: "Detour to \(d.name)", text: "Get an extra stamp in \(d.name).", city: d.id))
    }
    for (id, name, text, test) in COMPASS {
        let ids = cities.filter(test).map(\.id)
        if !ids.isEmpty && !ids.contains(where: listed.contains) {
            deck.append(Ticket(id: id, icon: "🧭", name: name, text: "\(text).", cities: ids))
        }
    }
    let airlines = ch.targets.count <= 3 ? 3 : 4, spare = max(3, jsRound(Double(ch.hours) * 0.15))
    deck.append(Ticket(id: "pincher", icon: "🪙", name: "Penny Pincher", text: "Finish with at least 30% of the budget left."))
    deck.append(Ticket(id: "early", icon: "⏱", name: "Early Bird", text: "Get home with \(spare) hours to spare.", spare: spare))
    if air { deck.append(Ticket(id: "airlines", icon: "🛫", name: "Frequent Flyer", text: "Fly with \(airlines) different airlines.", count: airlines)) }
    if air { deck.append(Ticket(id: "flag", icon: "🥂", name: "Flag Carrier", text: "Never fly a low-cost airline.")) }
    if air && rail { deck.append(Ticket(id: "rail", icon: "🚆", name: "Rail Fan", text: "Take two trains.")) }

    return deck.map { (Rng.rand("\(seed)|draw|\($0.id)"), $0) }.stableSorted { $0.0 < $1.0 }.prefix(2).map(\.1)
}

/// "done", "failed" or "open". Once the game is over, anything still open has failed.
public func ticketStatus(_ g: Game, _ t: Ticket) -> String {
    let over = g.over != nil, won = g.over == .won
    func settle(_ ok: Bool, _ broken: Bool = false) -> String { broken ? "failed" : ok ? "done" : over ? "failed" : "open" }
    switch t.id {
    case "detour": return settle(g.collected.contains(t.city ?? ""))
    case "north", "south", "east": return settle(g.landed.contains(where: t.cities.contains))
    case "airlines": return settle(g.carriers.count >= t.count)
    case "rail": return settle(g.trains >= 2)
    case "flag": return settle(won, g.lowcost)
    case "pincher": return settle(won && Double(g.challenge.budget - g.spent) >= Double(g.challenge.budget) * 0.3)
    case "early": return settle(won && g.deadline - g.clock >= t.spare * HOUR)
    default: return "open"
    }
}

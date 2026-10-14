// Game state and rules, with no user interface. Matches src/engine/game.js.
import Foundation

public enum RULES {
    public static let dwell = 90             // minutes in town to get the passport stamped
    public static let airConnect = 45        // minutes before a flight when already at the airport
    public static let airFromCity = 60       // check-in buffer on top of the transfer from town
    public static let railFromCity = 20
    public static let ferryCheckIn = 45
    public static let nightFrom = 22 * 60, nightTo = 5 * 60, wake = 6 * 60
    public static let jamChance = 0.18
    public static let costStar = 0.8         // share of the budget to beat for the thrift star
    public static let runMinSlack = 0.45     // you can run with this share of the normal lead time
    public static let flexPremium = 0.25     // flexible ticket supplement
    public static let ticketPoints = 75
}

public enum Place: String { case airport, city, port }
public enum Outcome: String { case won, timeout, broke, quit }

public struct LogEntry: Equatable { public let t: Millis; public let tz: String; public let icon: String; public let text: String; public let cost: Int }
public struct StampVia: Equatable { public let mode: Mode; public let place: String }
public struct PathStep: Equatable { public let from: String, to: String; public let mode: Mode }

/// Time and money to reach the right terminal for a departure.
public struct Lead: Equatable { public let min: Int; public let cost: Int; public let links: [PortLink] }

public struct BoardRow: Identifiable {
    public let leg: Leg
    public let status: String
    public let dep: Millis, arr: Millis
    public let divertTo: String?
    public let known: Bool
    public let lead: Lead
    public let total: Int
    public var flexTotal: Int = 0
    /// nil, "cancelled", "late" or "funds"
    public var why: String? = nil
    /// Chance of making a departure you would have to run for
    public var tight: Double? = nil
    public var bookable: Bool = false
    public var id: String { leg.id }
}

public struct BookResult {
    public var missed = false
    public var notes: [String] = []
    public var skipped: String? = nil
    public var lost = 0, credit = 0, premium = 0, transfer = 0
}

public struct VisitPlan { public let mins: Int, transfer: Int, fee: Int, cost: Int; public let why: String? }
public struct HotelCost { public let room: Int, meals: Int, transfer: Int, total: Int }
public struct Score {
    public let won: Bool, thrift: Bool, speed: Bool
    public let stars: Int, hours: Double, spent: Int
    public let tickets: [(Ticket, String)]
    public let ticketsDone: Int
    public let points: Int
}

public final class Game {
    public let world: World
    public let challenge: Challenge
    public let seed: String
    public let start: Millis
    public var clock: Millis
    /// Int.max when the journey has no time limit
    public let deadline: Millis
    public var spent = 0
    public var city: String
    public var place: Place
    public var port: PortLink? = nil
    public var collected: [String] = []
    public var stampAt: [String: Millis] = [:]
    public var stampVia: [String: StampVia] = [:]
    public var arrivedBy: Mode? = nil
    public var skipped: [String] = []
    public var path: [PathStep] = []
    public var log: [LogEntry] = []
    public var nights = 0, hotels = 0, moves = 0
    public var over: Outcome? = nil
    public var landed: [String]
    public var carriers: [String] = []
    public var trains = 0
    public var lowcost = false
    public var tickets: [Ticket] = []
    public private(set) var events: [GameEvent] = []
    public private(set) var offer: [Ticket] = []

    public init(world: World, challenge: Challenge, seed: String = String(Int(Date().timeIntervalSince1970 * 1000))) {
        self.world = world; self.challenge = challenge; self.seed = seed
        let home = world.cities[challenge.home]!
        start = localToUtc(home.tz, challenge.date[0], challenge.date[1], challenge.date[2], challenge.startMinutes ?? 8 * 60)
        clock = start
        deadline = challenge.isUntimed ? .max : start + challenge.hours * HOUR
        city = challenge.home
        place = world.modes.contains(.air) ? .airport : .city
        landed = [challenge.home]
        // Training is a calm first trip: no disruption and no bonus tickets.
        events = challenge.isTraining ? [] : generateEvents(world: world, challenge: challenge, start: start, seed: seed)
        offer = challenge.isTraining || challenge.isUntimed ? [] : drawTickets(world: world, challenge: challenge, seed: seed)
    }

    public var here: City { world.cities[city]! }
    public var remaining: Int { challenge.budget - spent }
    public var news: [GameEvent] { events.filter { $0.at <= clock } }
    public var isNight: Bool { let m = local(here.tz, clock).minutes; return m >= RULES.nightFrom || m < RULES.nightTo }
    /// Cities where a stamp counts: the list plus any detour ticket kept.
    public var stampCities: [String] { challenge.targets + tickets.compactMap(\.city) }

    // MARK: Board

    public static func lead(_ city: City, _ place: Place, _ leg: Leg, _ port: PortLink?) -> Lead {
        if leg.mode == .air {
            return place == .airport ? Lead(min: RULES.airConnect, cost: 0, links: [])
                : Lead(min: city.xfer + RULES.airFromCity, cost: city.xferCost, links: [])
        }
        let links = place == .port ? [port!] : []
        let min = place == .airport ? city.xfer : place == .port ? port!.mins : 0
        let cost = place == .airport ? city.xferCost : place == .port ? port!.cost : 0
        if leg.mode == .rail { return Lead(min: min + RULES.railFromCity, cost: cost, links: links) }
        if place == .port, port!.name == leg.port!.name { return Lead(min: RULES.ferryCheckIn, cost: 0, links: []) }
        return Lead(min: min + leg.port!.mins + RULES.ferryCheckIn, cost: cost + leg.port!.cost, links: links + [leg.port!])
    }

    private func withStatus(_ leg: Leg, mine: Bool) -> BoardRow {
        let st = legStatus(events, leg, world: world, seed: seed, now: clock)
        let l = mine ? Game.lead(here, place, leg, port) : Lead(min: 0, cost: 0, links: [])
        return BoardRow(leg: leg, status: st.status, dep: st.dep, arr: st.arr, divertTo: st.divertTo, known: st.known, lead: l, total: leg.fare + l.cost)
    }

    /// Today's remaining departures from a city; rows for the city you are in carry booking details.
    public func board(_ cityId: String? = nil) -> [BoardRow] {
        let id = cityId ?? city, mine = id == city
        return world.departuresOn(id, clock).filter { $0.dep >= clock }.map { leg in
            var row = withStatus(leg, mine: mine)
            row.flexTotal = row.total + jsRound(Double(leg.fare) * RULES.flexPremium)
            if row.status == "cancelled" { row.why = "cancelled" }
            else if row.dep < clock + row.lead.min * MIN {
                row.why = "late"
                // Too late to stroll, but maybe not too late to run.
                let slack = Double(row.dep - clock) / Double(row.lead.min * MIN)
                if mine && slack >= RULES.runMinSlack && row.total <= remaining {
                    let p = 0.2 + 0.75 * ((slack - RULES.runMinSlack) / (1 - RULES.runMinSlack))
                    row.tight = min(0.95, max(0.05, Double(jsRound(p * 20)) / 20))
                }
            } else if row.total > remaining { row.why = "funds" }
            row.bookable = mine && row.why == nil
            return row
        }
    }

    /// Tomorrow's board, read-only until you have slept.
    public func tomorrow(_ cityId: String? = nil) -> [BoardRow] {
        world.departuresOn(cityId ?? city, clock + 24 * HOUR).map { withStatus($0, mine: false) }
    }

    public func runSucceeds(_ row: BoardRow) -> Bool {
        guard let p = row.tight else { return true }
        return Rng.rand("\(seed)|run|\(row.leg.id)") < p
    }

    // MARK: Moves

    /// Takes a departure. A tight one can be missed: a standard fare is then lost;
    /// a flexible fare is kept as `credit` towards the next departure, or refunded.
    @discardableResult
    public func book(_ row: BoardRow, flex: Bool = false, credit: Int = 0) -> BookResult {
        let leg = row.leg, from = city, origin = world.cities[from]!
        let terminal: Place = leg.mode == .air ? .airport : leg.mode == .rail ? .city : .port
        let icon = ["air": "✈", "rail": "🚆", "ferry": "⛴️"][leg.mode.rawValue]!
        let premium = flex ? row.flexTotal - row.total : 0
        moves += 1
        if !runSucceeds(row) {
            let lost = flex ? row.lead.cost + premium : row.total
            spent += row.total + premium
            clock = row.dep + 10 * MIN
            place = terminal
            port = leg.mode == .ferry ? leg.port : nil
            log.append(LogEntry(t: row.dep, tz: origin.tz, icon: "🏃", text: "Missed \(leg.no) to \(world.cities[leg.to]!.name)", cost: row.total + premium))
            finish()
            return BookResult(missed: true, lost: lost, credit: flex ? leg.fare : 0, premium: premium, transfer: row.lead.cost)
        }
        let to = row.divertTo ?? leg.to, dest = world.cities[to]!
        // Leaving a city on your list without its stamp means coming back for it later.
        let skippedCity = stampCities.contains(from) && !collected.contains(from) ? from : nil
        if skippedCity != nil && !skipped.contains(from) { skipped.append(from) }
        var notes: [String] = []
        let charge = max(0, row.total - credit) + premium
        spent += charge
        clock = row.arr
        city = to
        place = terminal
        port = leg.mode == .ferry ? leg.portTo : nil
        arrivedBy = leg.mode
        path.append(PathStep(from: from, to: to, mode: leg.mode))
        landed.append(to)
        if leg.mode == .rail { trains += 1 }
        else if leg.mode == .air && !carriers.contains(leg.code) { carriers.append(leg.code) }
        if leg.kind == "lowcost" { lowcost = true }
        log.append(LogEntry(t: row.dep, tz: origin.tz, icon: icon, text: "\(leg.no) \(origin.name) → \(dest.name)\(credit > 0 ? " (rebooked)" : "")", cost: charge))
        if leg.berth && isNight {
            // Docked in the small hours: stay in the cabin until morning.
            clock = nextWake()
            notes.append("You slept on board and stepped ashore in \(dest.name) at 06:00. No hotel needed.")
        } else if leg.berth { notes.append("You slept on board. No hotel needed.") }
        if row.tight != nil { notes.append("Made it! You ran for \(leg.no) and got on.") }
        if row.divertTo != nil { notes.append("Diverted! \(world.cities[leg.to]!.name) airport is closed, so you have landed in \(dest.name).") }
        finish()
        return BookResult(notes: notes, skipped: skippedCity)
    }

    /// Gives back a flexible fare that could not be used on a later departure.
    public func refund(_ amount: Int) {
        spent -= amount
        log.append(LogEntry(t: clock, tz: here.tz, icon: "↩", text: "Flexible fare refunded", cost: -amount))
    }

    public func visitPlan() -> VisitPlan {
        let c = here, fromAirport = place == .airport
        let mins = (fromAirport ? c.xfer : place == .port ? port!.mins : 0) + RULES.dwell
        let transfer = fromAirport ? c.xferCost : place == .port ? port!.cost : 0
        let fee = jsRound(8 * c.idx), cost = transfer + fee
        var why: String? = nil
        if !stampCities.contains(c.id) { why = "Not on your list" }
        else if collected.contains(c.id) { why = "Already stamped" }
        else if cost > remaining { why = "Not enough money" }
        return VisitPlan(mins: mins, transfer: transfer, fee: fee, cost: cost, why: why)
    }

    /// Goes into town and gets the passport stamped.
    @discardableResult
    public func visit() -> [String] {
        let c = here, plan = visitPlan()
        var notes: [String] = []
        var mins = plan.mins
        if place == .airport && !challenge.isTraining && Rng.rand("\(seed)|jam|\(moves)|\(c.id)") < RULES.jamChance {
            let jam = round5(30 + Rng.rand("\(seed)|jam-len|\(moves)") * 45)
            mins += jam
            notes.append("Traffic jam on the way into \(c.name): \(jam) minutes lost.")
        }
        log.append(LogEntry(t: clock, tz: c.tz, icon: c.emoji, text: "\(c.name): passport stamped", cost: plan.cost))
        clock += mins * MIN
        spent += plan.cost
        collected.append(c.id)
        stampAt[c.id] = clock
        // What the border stamp records: how you came in, and through where.
        let via = arrivedBy ?? .air
        stampVia[c.id] = StampVia(mode: via, place: arrivedBy == .ferry && port != nil ? port!.name : arrivedBy == .air ? c.apt : c.name)
        place = .city
        port = nil
        moves += 1
        finish()
        return notes
    }

    public func hotelCost() -> HotelCost {
        let c = here
        let room = jsRound(65 * c.idx), meals = jsRound(22 * c.idx), transfer = place == .airport ? 6 : 0
        return HotelCost(room: room, meals: meals, transfer: transfer, total: room + meals + transfer)
    }

    /// Out of money: nothing you can board, no stamp you can pay for and no room you can afford.
    public var stranded: Bool {
        over == nil && hotelCost().total > remaining && visitPlan().why != nil && !board().contains { $0.bookable || $0.tight != nil }
    }

    public func nextWake() -> Millis {
        let tz = here.tz, p = local(tz, clock)
        return localToUtc(tz, p.y, p.m, p.d + (p.minutes < RULES.wake ? 0 : 1), RULES.wake)
    }

    /// A night in the hotel until 06:00. If you cannot pay for the room, the journey is over.
    public func sleep() {
        let c = here, cost = hotelCost().total
        if cost > remaining { over = .broke; return }
        log.append(LogEntry(t: clock, tz: c.tz, icon: "🛏", text: "Hotel night in \(c.name)", cost: cost))
        spent += cost
        clock = nextWake()
        hotels += 1; nights += 1; moves += 1
        finish()
    }

    public func quit() { over = .quit }

    private func finish() {
        let all = challenge.targets.allSatisfy(collected.contains)
        if all && city == challenge.home && clock <= deadline { over = .won }
        else if clock > deadline { over = .timeout }
    }

    // MARK: Score

    public var ticketStates: [(Ticket, String)] { tickets.map { ($0, ticketStatus(self, $0)) } }

    public func score() -> Score {
        let hours = Double(clock - start) / Double(HOUR)
        let won = over == .won
        let thrift = won && Double(spent) <= Double(challenge.budget) * RULES.costStar
        let speed = won && hours <= Double(challenge.parHours)
        let kept = ticketStates
        let done = kept.filter { $0.1 == "done" }.count
        var points: Int
        if won {
            // An untimed journey has no deadline to beat, so no time bonus.
            let timeBonus = deadline == .max ? 0 : jsRound(Double(deadline - clock) / Double(HOUR)) * 2
            points = 300 + (thrift ? 100 : 0) + (speed ? 100 : 0) + jsRound(Double(remaining) / 10) + timeBonus
        } else {
            points = challenge.targets.filter(collected.contains).count * 40
        }
        points += RULES.ticketPoints * (done - (kept.count - done))
        return Score(won: won, thrift: thrift, speed: speed, stars: (won ? 1 : 0) + (thrift ? 1 : 0) + (speed ? 1 : 0),
                     hours: hours, spent: spent, tickets: kept, ticketsDone: done, points: max(0, points))
    }
}

// Checks the Swift engine against reference results from the web prototype
// (tools/make-fixtures.mjs). If these pass, iOS and the web version produce the
// same timetables, fares, disruption and game outcomes.
import XCTest
@testable import ViaggiKit

private func fixture(_ name: String) throws -> Any {
    let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
    return try JSONSerialization.jsonObject(with: Data(contentsOf: url))
}
private func ms(_ any: Any?) -> Double { (any as? NSNumber)?.doubleValue ?? .nan }

final class ParityTests: XCTestCase {
    static var region: Region!
    static var file: ChallengeFile!
    override class func setUp() {
        region = try! GameData.europe()
        file = try! GameData.challenges()
    }
    func challenge(_ id: String) -> Challenge { id == "training" ? Self.file.training : Self.file.challenges.first { $0.id == id }! }
    func world(_ id: String) -> World { World(region: Self.region, challenge: challenge(id)) }

    func testBasics() throws {
        let f = try fixture("basics") as! [String: Any]
        for h in f["hashes"] as! [[String: Any]] {
            XCTAssertEqual(Rng.hash(h["key"] as! String), (h["hash"] as! NSNumber).uint32Value, "hash of \(h["key"]!)")
        }
        for t in f["times"] as! [[String: Any]] {
            let tz = t["tz"] as! String
            let got = localToUtc(tz, t["y"] as! Int, t["m"] as! Int, t["d"] as! Int, t["mins"] as! Int)
            XCTAssertEqual(Double(got), ms(t["ms"]), "localToUtc \(tz) \(t)")
            XCTAssertEqual(fmtDay(tz, got), t["day"] as? String)
            XCTAssertEqual(fmtTime(tz, got), t["time"] as? String)
        }
        let cities = Dictionary(uniqueKeysWithValues: Self.region.cities.map { ($0.id, $0) })
        for d in f["distances"] as! [[String: Any]] {
            XCTAssertEqual(distKm(cities[d["a"] as! String]!, cities[d["b"] as! String]!), ms(d["km"]), accuracy: 1e-9)
        }
    }

    // The prototype leaves `berth` out (undefined) for flights, so a missing value means false.
    func testBoards() throws {
        var worlds: [String: World] = [:]
        var checked = 0, mismatches: [String] = []
        for b in try fixture("boards") as! [[String: Any]] {
            let id = b["challenge"] as! String
            let w = worlds[id] ?? world(id); worlds[id] = w
            let got = w.departures(b["city"] as! String, b["y"] as! Int, b["m"] as! Int, b["d"] as! Int)
            let want = b["legs"] as! [[String: Any]]
            XCTAssertEqual(got.count, want.count, "number of departures \(id) \(b["city"]!) \(b["m"]!)/\(b["d"]!)")
            for (g, e) in zip(got, want) {
                checked += 1
                let same = g.id == e["id"] as? String && Double(g.dep) == ms(e["dep"]) && Double(g.arr) == ms(e["arr"])
                    && g.fare == e["fare"] as? Int && g.no == e["no"] as? String && g.carrier == e["carrier"] as? String
                    && g.seats == e["seats"] as? Int && g.berth == (e["berth"] as? Bool ?? false) && g.port?.name == e["port"] as? String
                if !same {
                    var why: [String] = []
                    if g.id != e["id"] as? String { why.append("id \(g.id) vs \(e["id"]!)") }
                    if Double(g.dep) != ms(e["dep"]) { why.append("dep") }
                    if Double(g.arr) != ms(e["arr"]) { why.append("arr") }
                    if g.fare != e["fare"] as? Int { why.append("fare \(g.fare) vs \(e["fare"]!)") }
                    if g.no != e["no"] as? String { why.append("no \(g.no) vs \(e["no"]!)") }
                    if g.carrier != e["carrier"] as? String { why.append("carrier \(g.carrier) vs \(e["carrier"]!)") }
                    if g.seats != e["seats"] as? Int { why.append("seats \(String(describing: g.seats)) vs \(e["seats"]!)") }
                    if g.berth != (e["berth"] as? Bool ?? false) { why.append("berth") }
                    if g.port?.name != e["port"] as? String { why.append("port \(String(describing: g.port?.name)) vs \(e["port"]!)") }
                    mismatches.append("\(g.id): \(why.joined(separator: ", "))")
                }
            }
        }
        XCTAssertTrue(mismatches.isEmpty, "\(mismatches.count) of \(checked) departures differ, e.g. \(mismatches.prefix(5))")
    }

    func testEventsAndTickets() throws {
        for set in try fixture("events") as! [[String: Any]] {
            let id = set["challenge"] as! String, seed = set["seed"] as! String
            let w = world(id), g = Game(world: w, challenge: challenge(id), seed: seed)
            let want = set["events"] as! [[String: Any]]
            XCTAssertEqual(g.events.count, want.count)
            for (e, x) in zip(g.events, want) {
                XCTAssertEqual(e.text, x["text"] as? String, "\(id) \(seed)")
                XCTAssertEqual(Double(e.from), ms(x["from"]), accuracy: 1)
                XCTAssertEqual(Double(e.at), ms(x["at"]), accuracy: 1)
            }
            let start = g.start
            for s in set["statuses"] as! [[String: Any]] {
                let leg = w.departuresOn(challenge(id).home, start + 26 * HOUR).first { $0.id == s["id"] as! String }!
                let st = legStatus(g.events, leg, world: w, seed: seed, now: start + 30 * HOUR)
                XCTAssertEqual(st.status, s["status"] as? String, leg.id)
                XCTAssertEqual(Double(st.dep), ms(s["dep"]), leg.id)
                XCTAssertEqual(st.divertTo, s["divertTo"] as? String, leg.id)
            }
        }
        for o in try fixture("offers") as! [[String: Any]] {
            let id = o["challenge"] as! String
            let g = Game(world: world(id), challenge: challenge(id), seed: o["seed"] as! String)
            XCTAssertEqual(g.offer.map(\.text), (o["offer"] as! [[String: Any]]).map { $0["text"] as! String }, "\(id) \(o["seed"]!)")
        }
    }

    /// The same simple player as the fixture script, move for move.
    func testWholeGames() throws {
        for f in try fixture("games") as! [[String: Any]] {
            let id = f["challenge"] as! String, seed = f["seed"] as! String, ch = challenge(id)
            let w = world(id), g = Game(world: w, challenge: ch, seed: seed)
            g.tickets = Array(g.offer.prefix(1))
            for _ in 0..<200 where g.over == nil {
                if g.stranded { g.over = .broke; break }
                if g.visitPlan().why == nil { g.visit(); continue }
                var want = ch.targets.filter { !g.collected.contains($0) }
                if want.isEmpty { want.append(ch.home) }
                let rows = g.isNight ? [] : g.board().filter(\.bookable)
                var row = rows.first { want.contains($0.leg.to) }
                if row == nil, let plan = earliest(world: w, from: g.city, place: g.place, t0: g.clock, to: want[0], port: g.port) {
                    row = rows.first { $0.leg.id == plan.legs.first?.id }
                }
                if let r = row { g.book(r) } else { g.sleep() }
            }
            let s = g.score()
            let label = "\(id) \(seed)"
            XCTAssertEqual(g.over?.rawValue, f["over"] as? String, label)
            XCTAssertEqual(Double(g.clock), ms(f["clock"]), label)
            XCTAssertEqual(g.spent, f["spent"] as? Int, label)
            XCTAssertEqual(g.collected, f["collected"] as? [String], label)
            XCTAssertEqual(g.log.map { "\($0.t)|\($0.icon)|\($0.text)|\($0.cost)" }, f["log"] as? [String], label)
            XCTAssertEqual(s.points, f["points"] as? Int, label)
            XCTAssertEqual(s.tickets.map { "\($0.0.id):\($0.1)" }, f["tickets"] as? [String], label)
        }
    }

    func testPlanning() throws {
        let f = try fixture("plans") as! [String: Any]
        for p in f["plans"] as! [[String: Any]] {
            let id = p["challenge"] as! String
            let c = calibrate(world: world(id), challenge: challenge(id))
            XCTAssertEqual(c.runs, p["runs"] as? Int, id)
            XCTAssertEqual(c.inTime, p["inTime"] as? Int, id)
            XCTAssertEqual(c.fast.hours, ms(p["fastHours"]), accuracy: 1e-9, id)
            XCTAssertEqual(c.fast.cost, p["fastCost"] as? Int, id)
            XCTAssertEqual(c.fast.route, p["fastRoute"] as? [String], id)
            XCTAssertEqual(c.cheap?.route, p["cheapRoute"] as? [String], id)
        }
        for r in f["routes"] as! [[String: Any]] {
            let id = r["challenge"] as! String, w = world(id), g = Game(world: w, challenge: challenge(id), seed: "s1")
            let got = Dictionary(uniqueKeysWithValues: routeOptions(g) { legStatus(g.events, $0, world: w, seed: g.seed, now: g.clock) }.map { ($0.city, $0.options) })
            for (city, list) in r["options"] as! [String: [[String: Any]]] {
                let mine = try XCTUnwrap(got[city], "\(id) \(city)")
                XCTAssertEqual(mine.map(\.labels), list.map { $0["labels"] as! [String] }, "\(id) \(city)")
                XCTAssertEqual(mine.map(\.money), list.map { $0["money"] as! Int }, "\(id) \(city)")
                XCTAssertEqual(mine.map { $0.legs.map(\.leg.id) }, list.map { $0["legs"] as! [String] }, "\(id) \(city)")
            }
        }
        for d in f["dailies"] as! [[String: Any]] {
            let date = d["date"] as! [Int]
            let ch = dailyChallenge(world: World(region: Self.region), year: date[0], month: date[1], day: date[2])
            XCTAssertEqual(ch.targets, d["targets"] as? [String], "\(date)")
            XCTAssertEqual(ch.hours, d["hours"] as? Int, "\(date)")
            XCTAssertEqual(ch.budget, d["budget"] as? Int, "\(date)")
        }
    }
}

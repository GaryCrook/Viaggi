// Deterministic randomness, geography and time zones. Every function here
// matches src/engine/util.js exactly, so iOS and the web prototype produce
// the same timetables for the same date.
import Foundation

/// Milliseconds since 1970, as in the web prototype.
public typealias Millis = Int
public let MIN: Millis = 60_000
public let HOUR: Millis = 60 * MIN

public enum Rng {
    /// FNV-1a with a final mix, over UTF-16 code units like JavaScript strings.
    public static func hash(_ s: String) -> UInt32 {
        var h: UInt32 = 2_166_136_261
        for unit in s.utf16 { h = (h ^ UInt32(unit)) &* 16_777_619 }
        h ^= h >> 16; h = h &* 0x85EB_CA6B
        h ^= h >> 13; h = h &* 0xC2B2_AE35
        h ^= h >> 16
        return h
    }

    /// Uniform 0..1 keyed by a string: the same key always gives the same number.
    public static func rand(_ s: String) -> Double { Double(hash(s)) / 4_294_967_296 }
}

/// JavaScript's Math.round: halves round up, towards +infinity.
@inline(__always) public func jsRound(_ x: Double) -> Int { Int((x + 0.5).rounded(.down)) }
@inline(__always) public func round5(_ m: Double) -> Int { jsRound(m / 5) * 5 }

private let earthRadius = 6371.0
@inline(__always) private func rad(_ d: Double) -> Double { d * .pi / 180 }
@inline(__always) private func deg(_ r: Double) -> Double { r * 180 / .pi }

public func distKm(_ a: City, _ b: City) -> Double {
    let dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon)
    let s = pow(sin(dLat / 2), 2) + cos(rad(a.lat)) * cos(rad(b.lat)) * pow(sin(dLon / 2), 2)
    return 2 * earthRadius * asin(s.squareRoot())
}

/// Great-circle path as (lon, lat) pairs, for drawing routes on the map.
public func arc(_ a: City, _ b: City, points n: Int = 48) -> [(lon: Double, lat: Double)] {
    let la1 = rad(a.lat), lo1 = rad(a.lon), la2 = rad(b.lat), lo2 = rad(b.lon)
    let d = distKm(a, b) / earthRadius
    if d == 0 { return [(a.lon, a.lat)] }
    return (0...n).map { i in
        let f = Double(i) / Double(n)
        let A = sin((1 - f) * d) / sin(d), B = sin(f * d) / sin(d)
        let x = A * cos(la1) * cos(lo1) + B * cos(la2) * cos(lo2)
        let y = A * cos(la1) * sin(lo1) + B * cos(la2) * sin(lo2)
        let z = A * sin(la1) + B * sin(la2)
        return (deg(atan2(y, x)), deg(atan2(z, (x * x + y * y).squareRoot())))
    }
}

// MARK: - Calendar arithmetic

/// Days since 1970-01-01 for a proleptic Gregorian date (month 1...12; day may overflow).
func daysFromCivil(_ y: Int, _ m: Int, _ d: Int) -> Int {
    let y2 = m <= 2 ? y - 1 : y
    let era = (y2 >= 0 ? y2 : y2 - 399) / 400
    let yoe = y2 - era * 400
    let mp = (m + 9) % 12
    let doy = (153 * mp + 2) / 5 + 1 - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146_097 + doe - 719_468 + (d - 1)
}

/// Date.UTC(y, m - 1, d, 0, minutes) from JavaScript, including its overflow rules for day and minutes.
func utcMillis(_ y: Int, _ m: Int, _ d: Int, minutes: Int) -> Millis {
    (daysFromCivil(y, m, d) * 1440 + minutes) * MIN
}

/// Day of the week for a calendar date, 0 = Sunday, as getUTCDay().
func weekday(_ y: Int, _ m: Int, _ d: Int) -> Int {
    let days = daysFromCivil(y, m, d)
    return ((days + 4) % 7 + 7) % 7
}

public struct LocalTime: Equatable {
    public let y: Int, m: Int, d: Int, h: Int, min: Int
    public var minutes: Int { h * 60 + min }
    public let wd: String
}

private let WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
private let MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

private var calendars: [String: Calendar] = [:]
private let calendarLock = NSLock()
private func calendar(_ tz: String) -> Calendar {
    calendarLock.lock(); defer { calendarLock.unlock() }
    if let c = calendars[tz] { return c }
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: tz) ?? TimeZone(secondsFromGMT: 0)!
    calendars[tz] = c
    return c
}

/// Wall-clock time in a time zone.
public func local(_ tz: String, _ ms: Millis) -> LocalTime {
    let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
    let c = calendar(tz).dateComponents([.year, .month, .day, .hour, .minute, .weekday], from: date)
    return LocalTime(y: c.year!, m: c.month!, d: c.day!, h: c.hour!, min: c.minute!, wd: WEEKDAYS[c.weekday! - 1])
}

/// The instant a local wall-clock time occurs, using the same one-step offset
/// correction as the web prototype (so daylight-saving edges match too).
public func localToUtc(_ tz: String, _ y: Int, _ m: Int, _ d: Int, _ minutes: Int) -> Millis {
    let guess = utcMillis(y, m, d, minutes: minutes)
    let p = local(tz, guess)
    let offset = utcMillis(p.y, p.m, p.d, minutes: p.h * 60 + p.min) - guess
    return guess - offset
}

private func pad(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }
public func fmtTime(_ tz: String, _ ms: Millis) -> String { let p = local(tz, ms); return "\(pad(p.h)):\(pad(p.min))" }
public func fmtDay(_ tz: String, _ ms: Millis) -> String { let p = local(tz, ms); return "\(p.wd) \(p.d) \(MONTHS[p.m - 1])" }
public func fmtDur(_ minutes: Double) -> String {
    let mins = max(0, jsRound(minutes)), h = mins / 60, m = mins % 60
    return h > 0 ? "\(h)h \(pad(m))m" : "\(m)m"
}

/// A sort that keeps equal elements in their original order, as JavaScript's does.
extension Array {
    func stableSorted(by less: (Element, Element) -> Bool) -> [Element] {
        enumerated().sorted { a, b in
            if less(a.element, b.element) { return true }
            if less(b.element, a.element) { return false }
            return a.offset < b.offset
        }.map(\.element)
    }
}

/// A dictionary that remembers insertion order, like a JavaScript Map.
struct OrderedMap<Key: Hashable, Value> {
    private(set) var keys: [Key] = []
    private var store: [Key: Value] = [:]
    subscript(key: Key) -> Value? {
        get { store[key] }
        set {
            if store[key] == nil, newValue != nil { keys.append(key) }
            if newValue == nil { keys.removeAll { $0 == key } }
            store[key] = newValue
        }
    }
    var values: [Value] { keys.map { store[$0]! } }
    var entries: [(Key, Value)] { keys.map { ($0, store[$0]!) } }
}

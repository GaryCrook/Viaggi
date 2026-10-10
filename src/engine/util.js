// Deterministic randomness, geography and timezone helpers.

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// Uniform 0..1 keyed by a string: the same key always gives the same number,
// so timetables are identical for every player and every session.
export const rand = (key) => hash(key) / 4294967296;

export const MIN = 60000;
export const HOUR = 60 * MIN;
export const round5 = (m) => Math.round(m / 5) * 5;

const R = 6371;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function distKm(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Great-circle path as [lon, lat] pairs.
export function arc(a, b, n = 48) {
  const [la1, lo1, la2, lo2] = [rad(a.lat), rad(a.lon), rad(b.lat), rad(b.lon)];
  const d = distKm(a, b) / R;
  if (d === 0) return [[a.lon, a.lat]];
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
    const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
    const z = A * Math.sin(la1) + B * Math.sin(la2);
    pts.push([deg(Math.atan2(y, x)), deg(Math.atan2(z, Math.hypot(x, y)))]);
  }
  return pts;
}

const fmts = new Map();
function fmt(tz) {
  if (!fmts.has(tz)) {
    fmts.set(tz, new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', weekday: 'short',
    }));
  }
  return fmts.get(tz);
}

// Wall-clock time in a timezone: { y, m, d, h, min, minutes (since midnight), wd }.
export function local(tz, ms) {
  const p = {};
  for (const { type, value } of fmt(tz).formatToParts(ms)) p[type] = value;
  const h = +p.hour, min = +p.minute;
  return { y: +p.year, m: +p.month, d: +p.day, h, min, minutes: h * 60 + min, wd: p.weekday };
}

export function localToUtc(tz, y, m, d, minutes) {
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const p = local(tz, guess);
  const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - guess;
  return guess - offset;
}

const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtTime(tz, ms) { const p = local(tz, ms); return `${pad(p.h)}:${pad(p.min)}`; }
export function fmtDay(tz, ms) { const p = local(tz, ms); return `${p.wd} ${p.d} ${MONTHS[p.m - 1]}`; }
export function fmtDur(mins) {
  mins = Math.max(0, Math.round(mins));
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h}h ${pad(m)}m` : `${m}m`;
}

// Earliest-arrival search over the timetable (time-dependent Dijkstra), plus
// calibration: play a challenge on the undisrupted timetable to prove it is
// winnable and to set its limits. Used by tools/solve.mjs and the daily challenge.

import { local, localToUtc, MIN, HOUR } from './util.js';
import { lead, RULES } from './game.js';

export function earliest(world, from, place, t0, to, port = null) {
  const best = new Map([[`${from}|${place}|${port?.name || ''}`, { t: t0, cost: 0, legs: [], city: from, place, port }]]);
  const done = new Set();
  for (;;) {
    let key = null, cur = null;
    for (const [k, v] of best) if (!done.has(k) && (!cur || v.t < cur.t)) { key = k; cur = v; }
    if (!cur) return null;
    if (cur.city === to) return cur;
    done.add(key);
    const city = world.cities.get(cur.city);
    const legs = [...world.departuresOn(cur.city, cur.t), ...world.departuresOn(cur.city, cur.t + 24 * HOUR)];
    for (const leg of legs) {
      const l = lead(city, cur.place, leg, cur.port);
      if (leg.dep < cur.t + l.min * MIN) continue;
      const p = { air: 'airport', rail: 'city', ferry: 'port' }[leg.mode];
      const at = leg.mode === 'ferry' ? leg.portTo : null;
      const k = `${leg.to}|${p}|${at?.name || ''}`, old = best.get(k);
      if (!old || leg.arr < old.t) {
        best.set(k, { t: leg.arr, cost: cur.cost + leg.fare + l.cost, legs: [...cur.legs, leg], city: leg.to, place: p, port: at });
      }
    }
  }
}

// Visit the targets in the given order, always taking the earliest connection.
export function playOrder(world, ch, order) {
  const home = world.cities.get(ch.home);
  const start = localToUtc(home.tz, ...ch.date, ch.startMinutes ?? 8 * 60);
  let t = start, place = world.modes.includes('air') ? 'airport' : 'city', at = ch.home, cost = 0, port = null;
  const route = [];
  for (const stop of [...order, ch.home]) {
    const r = earliest(world, at, place, t, stop, port);
    if (!r) return null;
    t = r.t; cost += r.cost; place = r.place; port = r.port; at = stop;
    route.push(...r.legs.map((l) => l.to));
    if (stop === ch.home) break;
    const c = world.cities.get(stop), p = local(c.tz, t);
    if (p.minutes >= RULES.officeClose) t = localToUtc(c.tz, p.y, p.m, p.d + 1, RULES.officeOpen);
    else if (p.minutes < RULES.officeOpen) t = localToUtc(c.tz, p.y, p.m, p.d, RULES.officeOpen);
    t += ((place === 'airport' ? c.xfer : place === 'port' ? port.mins : 0) + RULES.dwell) * MIN;
    cost += (place === 'airport' ? c.xferCost : place === 'port' ? port.cost : 0) + Math.round(8 * c.idx);
    place = 'city'; port = null;
  }
  const hours = (t - start) / HOUR, nights = Math.floor((hours + 8) / 24);
  return { hours, cost: Math.round(cost + nights * 80), nights, route };
}

const perms = (a) => a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));

export function calibrate(world, ch) {
  const runs = perms(ch.targets).map((o) => playOrder(world, ch, o)).filter(Boolean);
  const fast = [...runs].sort((a, b) => a.hours - b.hours)[0];
  const inTime = ch.hours ? runs.filter((r) => r.hours <= ch.hours) : runs;
  const cheap = [...inTime].sort((a, b) => a.cost - b.cost)[0];
  return { runs: runs.length, inTime: inTime.length, fast, cheap };
}

// ---------------------------------------------------------------- route options
// Different ways to reach each city from where the player stands now: the
// fastest, the cheapest and the best value. Costs include an estimate for any
// hotel night spent waiting, so a sleeper or an overnight ferry shows its saving.

const dayNumber = (tz, ms) => { const p = local(tz, ms - 2 * HOUR); return Date.UTC(p.y, p.m - 1, p.d) / (24 * HOUR); };
const hotelRate = (city, place) => Math.round(87 * city.idx) + (place === 'airport' ? 6 : 0);
const HORIZON = 96 * HOUR;

function search(g, perHour, statusOf) {
  const { world } = g;
  const start = { t: g.clock, money: 0, nights: 0, key: 0, legs: [], city: g.city, place: g.place, port: g.port };
  const best = new Map([[`${g.city}|${g.place}|${g.port?.name || ''}`, start]]);
  const done = new Set();
  for (;;) {
    let key = null, cur = null;
    for (const [k, v] of best) if (!done.has(k) && (!cur || v.key < cur.key)) { key = k; cur = v; }
    if (!cur) break;
    done.add(key);
    const city = world.cities.get(cur.city);
    for (let day = 0; day < 4; day++) {
      for (const leg of world.departuresOn(cur.city, cur.t + day * 24 * HOUR)) {
        const st = statusOf(leg);
        if (st.status === 'cancelled' || st.dep > g.clock + HORIZON) continue;
        const l = lead(city, cur.place, leg, cur.port);
        if (st.dep < cur.t + l.min * MIN) continue;
        const nights = Math.max(0, dayNumber(city.tz, st.dep) - dayNumber(city.tz, cur.t));
        const money = cur.money + leg.fare + l.cost + nights * hotelRate(city, cur.place);
        const score = money + perHour * ((st.arr - g.clock) / HOUR);
        const place = { air: 'airport', rail: 'city', ferry: 'port' }[leg.mode];
        const port = leg.mode === 'ferry' ? leg.portTo : null;
        const k = `${leg.to}|${place}|${port?.name || ''}`, old = best.get(k);
        if (!old || score < old.key) {
          best.set(k, { t: st.arr, money, nights: cur.nights + nights, key: score, city: leg.to, place, port,
            legs: [...cur.legs, { leg, dep: st.dep, arr: st.arr }] });
        }
      }
    }
  }
  const byCity = new Map();
  for (const v of best.values()) if (v.legs.length && (!byCity.has(v.city) || v.key < byCity.get(v.city).key)) byCity.set(v.city, v);
  return byCity;
}

const STYLES = [['Fastest', 1000], ['Cheapest', 0.5], ['Best value', 12]];

// Map of cityId -> [{ labels, t, money, nights, legs }], at most three distinct routes each.
export function routeOptions(g, statusOf) {
  const out = new Map();
  for (const [label, perHour] of STYLES) {
    for (const [city, r] of search(g, perHour, statusOf)) {
      if (!out.has(city)) out.set(city, []);
      const sig = r.legs.map((x) => x.leg.id).join('>');
      const same = out.get(city).find((x) => x.sig === sig);
      if (same) same.labels.push(label);
      else out.get(city).push({ ...r, sig, labels: [label] });
    }
  }
  return out;
}

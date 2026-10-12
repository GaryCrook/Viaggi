// The world: a region pack turned into a queryable timetable.
//
// Each transport mode is a provider that returns recurring "services"
// (carrier X runs A -> B, N times a day). The world turns services into dated
// departures on demand. To add ferries, coaches or a live API snapshot,
// register another provider here – nothing else in the game needs to change.

import { rand, hash, distKm, round5, MIN, local, localToUtc } from './util.js';

const SEASON = [0.8, 0.8, 0.9, 1.0, 1.05, 1.2, 1.5, 1.5, 1.15, 1.0, 0.85, 1.2];   // Jan..Dec
const FIRST_DEP = 6 * 60, LAST_DEP = 21 * 60 + 30;                                   // local minutes

function timeOfDay(minutes) {
  if (minutes < 7 * 60) return 0.8;
  if (minutes < 9 * 60 + 30) return 1.2;
  if (minutes >= 16 * 60 + 30 && minutes < 19 * 60 + 30) return 1.2;
  if (minutes >= 20 * 60) return 0.85;
  return 1;
}

const airFare = (km, lowcost) => (tod, season, scarcity) =>
  (15 + 0.35 * km ** 0.8) * season * tod * scarcity * (lowcost ? 0.65 : 1.15);

// Flights from the real route list: which airline flies between which cities,
// and whether only for part of the year. How often each route runs is not in
// the data, so it is estimated from the airline's kind and the size of the cities.
function realAir(region, cities) {
  const hubs = new Map(region.carriers.map((k) => [k.code, Object.keys(k.hubs)]));
  const merged = new Map();
  for (const [a, b, name, seasonal] of region.airRoutes) {
    if (region.airlinesDropped.includes(name)) continue;
    const A = cities.get(a), B = cities.get(b);
    if (!A || !B || A.railOnly || B.railOnly) continue;
    const [code, kind, shown] = region.airlines[name]
      || [name.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase(), 'lowcost'];
    const key = `${code}-${a}-${b}`, old = merged.get(key);
    // The same pair can be listed under a parent and its subsidiary: year-round wins.
    merged.set(key, { a, b, code, kind, name: shown || name, seasonal: old ? old.seasonal && !!seasonal : !!seasonal });
  }
  const out = [];
  for (const r of merged.values()) {
    const A = cities.get(r.a), B = cities.get(r.b), km = distKm(A, B);
    const tA = Math.min(3, A.tier), tB = Math.min(3, B.tier), lowcost = r.kind === 'lowcost';
    const atHub = (hubs.get(r.code) || []).some((h) => h === r.a || h === r.b);
    const remote = A.tier === 4 || B.tier === 4;
    const base = {
      mode: 'air', carrier: { code: r.code, name: r.name, type: r.kind }, km, pair: `${r.code}-${r.a}-${r.b}`,
      freq: lowcost ? (tA + tB <= 2 ? 2 : 1) : remote ? 2 : atHub ? Math.max(1, 5 - tA - tB) : 1,
      // Low-cost routes between smaller places run a few days a week, not daily.
      dayP: lowcost ? [1, 1, 1, 0.85, 0.6, 0.45, 0.3][tA + tB] : atHub ? 1 : 0.6,
      season: r.seasonal ? (region.winterResorts.includes(r.a) || region.winterResorts.includes(r.b) ? 'winter' : 'summer') : null,
      durMin: round5(35 + (km / 800) * 60),
      fare: airFare(km, lowcost),
    };
    out.push({ ...base, from: r.a, to: r.b }, { ...base, from: r.b, to: r.a });
  }
  return out;
}

// Seasonal services: summer is April to October, winter is November to April.
export const inSeason = (service, month) => !service.season
  || (service.season === 'summer' ? month >= 4 && month <= 10 : month >= 11 || month <= 4);

function inScope({ rail: scope = 'international', domestic = [] }, A, B, majorOnly) {
  if (A.country === B.country) return scope === A.country || domestic.includes(A.country);
  return scope === 'international' && (!majorOnly || (A.tier <= 2 && B.tier <= 2));
}

const PROVIDERS = {
  air(region, cities) {
    if (region.airRoutes) return realAir(region, cities);
    const out = [], seen = new Set();
    // Every city keeps a link to its nearest major hub, so thinning the network
    // never cuts a place off: it only means more journeys need a connection.
    const majors = region.carriers.filter((k) => k.type === 'network')
      .flatMap((k) => Object.entries(k.hubs).filter(([, reach]) => reach === 1).map(([id]) => id));
    const anchor = new Map(region.cities.map((c) => [c.id,
      majors.filter((h) => h !== c.id && distKm(cities.get(h), c) >= 220)
        .sort((a, b) => distKm(cities.get(a), c) - distKm(cities.get(b), c))[0]]));
    for (const carrier of region.carriers) {
      for (const [hubId, reach] of Object.entries(carrier.hubs)) {
        const hub = cities.get(hubId);
        for (const c of region.cities) {
          if (c.id === hubId || c.railOnly || hub.tier === 4) continue;
          // A remote city is flown only by its own country's network carrier, from the home hub.
          const remote = c.tier === 4;
          if (remote && (carrier.type !== 'network' || hub.country !== c.country)) continue;
          const pair = `${carrier.code}-${[hubId, c.id].sort().join('-')}`;
          if (seen.has(pair)) continue;
          const km = distKm(hub, c);
          if (km < 220) continue;                       // too short to fly
          const network = carrier.type === 'network';
          // How likely the route exists. Big hubs reach most large cities but only some
          // regional ones; low-cost carriers concentrate on big cities from big bases.
          // Nearer places are favoured: about twice as likely at 600 km as at 1,200 km,
          // and half as likely again by 2,400 km. A major hub's links to large cities are fixed.
          // A network carrier always serves its own neighbourhood (within 700 km of the hub).
          const near = Math.min(2.5, Math.max(0.3, (1100 / km) ** 1.3));
          const fixed = remote || (network && (km <= 700 || anchor.get(c.id) === hubId || (reach === 1 && c.tier <= 2)));
          const p = fixed ? 1
            : network ? reach * [0, 1.3, 0.7, 0.28][c.tier] * near
            : reach * [0, 1.2, 0.55, 0.22][c.tier] * [0, 1, 0.7, 0.35][hub.tier] * near;
          if (rand(`route|${carrier.code}|${hubId}|${c.id}`) >= p) continue;
          seen.add(pair);
          const freq = remote ? 2 : network
            ? Math.max(1, 5 - c.tier - hub.tier - (reach < 0.5 ? 1 : 0))
            : (hub.tier === 1 && c.tier === 1 ? 2 : 1);
          const base = {
            mode: 'air', carrier, freq, km, pair,
            dayP: network ? 1 : 0.7,                    // low-cost routes don't fly every day
            durMin: round5(35 + (km / 800) * 60),
            fare: (tod, season, scarcity) =>
              (15 + 0.35 * km ** 0.8) * season * tod * scarcity * (network ? 1.15 : 0.65),
          };
          out.push({ ...base, from: hubId, to: c.id }, { ...base, from: c.id, to: hubId });
        }
      }
    }
    return out;
  },

  // scope 'international': only cross-border trains between major cities.
  // scope 'IT' (any country code): only that country's domestic network.
  // `domestic` opens the full home network of the listed countries inside an
  // international game, e.g. ['ES'] for a journey from London into Spain.
  rail(region, cities, opts = {}) {
    const out = [];
    for (const [a, b, durMin, freq, code, name, premium, sleeper] of region.rail || []) {
      const A = cities.get(a), B = cities.get(b);
      if (!inScope(opts, A, B, true)) continue;
      const base = {
        mode: 'rail', carrier: { code, name, type: 'rail' }, freq, km: distKm(A, B), pair: `${code}-${a}-${b}`,
        dayP: 1, durMin, sleeper: !!sleeper, perWeek: sleeper ? [sleeper, sleeper] : null,
        cabin: Math.round(35 * ((A.idx + B.idx) / 2)),
        // Rail fares rise more slowly than journey time, and only partly with local prices.
        // A sleeper is slow for its distance, so its seat fare is below a day train of the same length.
        fare: (tod, _season, scarcity) =>
          (5 + 0.75 * (sleeper ? durMin * 0.6 : durMin) ** 0.75) * Math.sqrt((A.idx + B.idx) / 2) * tod * (1 + (scarcity - 1) * 0.6) * (premium ? 1.7 : 1),
      };
      out.push({ ...base, from: a, to: b }, { ...base, from: b, to: a, back: true });
    }
    return out;
  },

  // Ferries follow the same scope as rail. `perWeek` holds summer and winter sailings.
  // Each end has a link between station and port: a short taxi for a nominal
  // fee, or a train at a per-minute fare.
  ferry(region, cities, opts = {}) {
    const out = [];
    const link = (city, name, kind, mins) =>
      ({ name, kind, mins, cost: Math.round((kind === 'taxi' ? 8 : 0.25 * mins) * city.idx) });
    for (const [a, portA, kindA, minsA, b, portB, kindB, minsB, durMin, summer, winter, code, name] of region.ferries || []) {
      const A = cities.get(a), B = cities.get(b);
      if (!inScope(opts, A, B, false)) continue;
      const base = {
        mode: 'ferry', carrier: { code, name, type: 'ferry' }, km: distKm(A, B), pair: `${code}-${a}-${b}`,
        perWeek: [summer, winter], durMin, cabin: Math.round(25 * ((A.idx + B.idx) / 2)),
        fare: (_tod, season, scarcity) => (10 + 0.03 * durMin) * (season > 1.1 ? 1.3 : 1) * (1 + (scarcity - 1) * 0.5),
      };
      const pa = link(A, portA, kindA, minsA), pb = link(B, portB, kindB, minsB);
      out.push({ ...base, from: a, to: b, port: pa, portTo: pb }, { ...base, from: b, to: a, port: pb, portTo: pa, back: true });
    }
    return out;
  },
};

const SUMMER = [5, 6, 7, 8, 9];

// Local departure times (minutes after midnight) for one service on one day.
function slots(s, month, dow) {
  if (!s.perWeek) {
    const jitter = rand(`slot|${s.pair}|${s.from}`);
    return Array.from({ length: s.freq }, (_, i) => round5(FIRST_DEP + ((i + jitter) / s.freq) * (LAST_DEP - FIRST_DEP)));
  }
  const perWeek = s.perWeek[SUMMER.includes(month) ? 0 : 1];
  if (!perWeek) return [];
  if (perWeek < 7) {
    // A few sailings a week: fixed weekdays, the ship returning the day after it arrives.
    const offset = (hash(`days|${s.pair}`) + (s.back ? 1 + Math.ceil(s.durMin / 1440) : 0)) % 7;
    const days = Array.from({ length: perWeek }, (_, k) => (offset + Math.floor((k * 7) / perWeek)) % 7);
    if (!days.includes(dow)) return [];
  }
  const perDay = Math.max(1, Math.round(perWeek / 7)), jitter = rand(`slot|${s.pair}|${s.from}`);
  if (s.durMin >= 480 && perDay <= 2) {
    // Long crossings sail in the evening, with a morning sailing if there are two.
    return [round5((s.sleeper ? 19.5 : 18) * 60 + jitter * (s.sleeper ? 110 : 180)), round5(8 * 60 + jitter * 120)].slice(0, perDay);
  }
  return Array.from({ length: perDay }, (_, i) => round5(FIRST_DEP + ((i + jitter) / perDay) * (LAST_DEP - FIRST_DEP)));
}

export const MODES = {
  air: { label: 'Flights', icon: '✈' },
  rail: { label: 'Trains', icon: '🚆' },
  ferry: { label: 'Ferries', icon: '⛴️' },
};

// `opts` is usually the challenge: it supplies the rail scope and the home city.
export function createWorld(region, modes = ['air'], opts = {}) {
  const cities = new Map(region.cities.map((c) => [c.id, c]));
  const services = new Map(region.cities.map((c) => [c.id, []]));
  let all = modes.flatMap((mode) => PROVIDERS[mode](region, cities, opts));
  if (opts.home && !modes.includes('air')) {
    // Keep only the part of the surface network that can be reached from home.
    const linked = new Set([opts.home]);
    for (let grew = true; grew;) {
      grew = false;
      for (const s of all) if (linked.has(s.from) && !linked.has(s.to)) { linked.add(s.to); grew = true; }
    }
    all = all.filter((s) => linked.has(s.from));
  }
  for (const s of all) services.get(s.from).push(s);

  const cache = new Map();

  // Every departure leaving `cityId` on the given local calendar day, sorted by time.
  function departures(cityId, y, m, d) {
    const key = `${cityId}|${y}-${m}-${d}`;
    if (cache.has(key)) return cache.get(key);
    const tz = cities.get(cityId).tz;
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const legs = [];
    for (const s of services.get(cityId)) {
      if (!inSeason(s, m)) continue;
      if (s.dayP < 1 && rand(`day|${s.pair}|${dow}`) >= s.dayP) continue;
      const number = 100 + (hash(`no|${s.pair}`) % 880) * 10 + (s.from < s.to ? 0 : 1);
      for (const [i, minutes] of slots(s, m, dow).entries()) {
        const dep = localToUtc(tz, y, m, d, minutes);
        const id = `${s.pair}|${s.from}|${y}-${m}-${d}|${i}`;
        const tight = rand(`seats|${id}`);
        const scarcity = 1 + 0.6 * tight * tight;
        // A sailing of seven hours or more that runs through the night includes a berth.
        const berth = (s.mode === 'ferry' || s.sleeper) && s.durMin >= 420 && minutes + s.durMin >= 24 * 60;
        legs.push({
          id, mode: s.mode, from: s.from, to: s.to, dep, arr: dep + s.durMin * MIN, durMin: s.durMin, km: s.km,
          carrier: s.carrier.name, code: s.carrier.code, kind: s.carrier.type, no: `${s.carrier.code} ${number + i * 2}`,
          port: s.port || null, portTo: s.portTo || null, berth, sleeper: !!s.sleeper,
          fare: Math.max(9, Math.round(s.fare(timeOfDay(minutes), SEASON[m - 1], scarcity))) + (berth ? s.cabin : 0),
          seats: tight > 0.85 ? 1 + Math.floor(rand(`left|${id}`) * 4) : null,
        });
      }
    }
    legs.sort((a, b) => a.dep - b.dep);
    cache.set(key, legs);
    return legs;
  }

  // Departures on the local calendar day that contains `ms`.
  function departuresOn(cityId, ms) {
    const p = local(cities.get(cityId).tz, ms);
    return departures(cityId, p.y, p.m, p.d);
  }

  return { region, modes, cities, services, departures, departuresOn };
}

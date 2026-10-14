// Reference results from the JavaScript engine, used by the Swift package's
// tests to prove the port behaves identically: same timetables, same fares,
// same disruption, same game outcomes.
//   node tools/make-fixtures.mjs
import { writeFileSync } from 'node:fs';
import { EUROPE } from '../src/data/europe.js';
import { CHALLENGES, TRAINING, dailyChallenge } from '../src/data/challenges.js';
import { createWorld } from '../src/engine/world.js';
import * as G from '../src/engine/game.js';
import { legStatus } from '../src/engine/events.js';
import { earliest, calibrate, routeOptions } from '../src/engine/planner.js';
import { hash, rand, local, localToUtc, fmtDay, fmtTime, distKm } from '../src/engine/util.js';

const out = 'ios/ViaggiKit/Tests/ViaggiKitTests/Fixtures';
const save = (name, value) => writeFileSync(`${out}/${name}.json`, JSON.stringify(value));
const byId = (id) => [...CHALLENGES, TRAINING].find((c) => c.id === id);

// 1. Hashing, time zones and formatting.
const keys = ['', 'a', 'route|BA|LON|PAR', 'slot|U2-AMS-LON|AMS', 'daily|2026-10-14|PAR', 'Kraków', 'seats|FR-LIS-OPO|OPO|2026-7-13|0'];
const times = [];
for (const tz of ['Europe/London', 'Europe/Paris', 'Europe/Helsinki', 'Atlantic/Reykjavik', 'Atlantic/Azores', 'Europe/Istanbul']) {
  for (const [y, m, d, mins] of [[2026, 3, 29, 90], [2026, 3, 29, 180], [2026, 7, 13, 480], [2026, 10, 25, 150], [2026, 12, 31, 1430], [2027, 1, 31, 1500]]) {
    const ms = localToUtc(tz, y, m, d, mins);
    times.push({ tz, y, m, d, mins, ms, local: local(tz, ms), day: fmtDay(tz, ms), time: fmtTime(tz, ms) });
  }
}
const city = (id) => EUROPE.cities.find((c) => c.id === id);
save('basics', {
  hashes: keys.map((k) => ({ key: k, hash: hash(k), rand: rand(k) })),
  times,
  distances: [['LON', 'PAR'], ['LIS', 'HEL'], ['REK', 'IST'], ['PDL', 'TOS']].map(([a, b]) => ({ a, b, km: distKm(city(a), city(b)) })),
});

// 2. Departure boards for several kinds of world.
const legOf = (l) => ({ id: l.id, mode: l.mode, from: l.from, to: l.to, dep: l.dep, arr: l.arr, durMin: l.durMin, carrier: l.carrier,
  code: l.code, kind: l.kind, no: l.no, fare: l.fare, seats: l.seats, berth: l.berth, sleeper: l.sleeper, port: l.port?.name || null });
const boards = [];
for (const [chId, cities, dates] of [
  ['training', ['LON', 'PAR', 'TLL', 'DBV', 'TOS', 'PDL'], [[2026, 6, 2], [2027, 1, 12], [2026, 10, 25]]],
  ['triangle', ['LON', 'PAR', 'BRU', 'AMS', 'BER'], [[2026, 5, 9], [2026, 12, 3]]],
  ['italia', ['MIL', 'ROM', 'NAP', 'PMO', 'GOA'], [[2026, 4, 20], [2026, 8, 3]]],
  ['biscay', ['LON', 'SDR', 'MAD', 'BCN', 'PMI'], [[2026, 6, 22], [2026, 6, 24]]],
  ['baltic', ['STO', 'HEL', 'TLL', 'HAM', 'GDN'], [[2026, 7, 6], [2027, 2, 2]]],
]) {
  const ch = byId(chId), world = createWorld(EUROPE, ch.modes, ch);
  for (const c of cities) for (const [y, m, d] of dates) boards.push({ challenge: chId, city: c, y, m, d, legs: world.departures(c, y, m, d).map(legOf) });
}
save('boards', boards);

// 3. Disruption and bonus tickets.
const events = [], offers = [];
for (const chId of ['dash', 'grand', 'edges', 'triangle', 'italia', 'baltic']) {
  const ch = byId(chId), world = createWorld(EUROPE, ch.modes, ch);
  for (const seed of ['s1', 's2', 'demo7', 'free-tg-times-dash']) {
    const g = G.newGame(world, ch, seed);
    events.push({ challenge: chId, seed, events: g.events.map((e) => ({ ...e })) });
    offers.push({ challenge: chId, seed, offer: g.offer.map((t) => ({ id: t.id, name: t.name, text: t.text, city: t.city || null })) });
    const sample = world.departuresOn(ch.home, g.start + 26 * 3600e3).slice(0, 25);
    events.at(-1).statuses = sample.map((l) => ({ id: l.id, ...legStatus(g.events, l, world, seed, g.start + 30 * 3600e3) }));
  }
}
save('events', events);
save('offers', offers);

// 4. Whole games played by a simple bot: exercises boards, booking, stamps, hotels and scoring.
function bot(ch, seed) {
  const world = createWorld(EUROPE, ch.modes, ch), g = G.newGame(world, ch, seed);
  g.tickets = g.offer.slice(0, 1);
  for (let i = 0; i < 200 && !g.over; i++) {
    if (G.stranded(g)) { g.over = 'broke'; break; }
    if (!G.visitPlan(g).why) { G.visit(g); continue; }
    const want = ch.targets.filter((t) => !g.collected.includes(t));
    if (!want.length) want.push(ch.home);
    const rows = G.isNight(g) ? [] : G.board(g).filter((r) => r.bookable);
    let row = rows.find((r) => want.includes(r.leg.to));
    if (!row) {
      const plan = earliest(world, g.city, g.place, g.clock, want[0], g.port);
      row = plan && rows.find((r) => r.leg.id === plan.legs[0]?.id);
    }
    if (row) G.book(g, row); else G.sleep(g);
  }
  const s = G.score(g);
  return { challenge: ch.id, seed, over: g.over, clock: g.clock, spent: g.spent, collected: g.collected, nights: g.nights,
    log: g.log.map((l) => `${l.t}|${l.icon}|${l.text}|${l.cost}`), points: s.points, stars: s.stars,
    tickets: s.tickets.map((t) => `${t.id}:${t.status}`) };
}
save('games', ['dash', 'grand', 'edges', 'triangle', 'alpine', 'italia', 'biscay', 'baltic', 'training']
  .flatMap((id) => ['s1', 's2', 's3'].map((seed) => bot(byId(id), seed))));

// 5. Planning: calibration, route options and the daily challenge.
const plans = ['dash', 'triangle', 'italia', 'training'].map((id) => {
  const ch = byId(id), c = calibrate(createWorld(EUROPE, ch.modes, ch), ch);
  return { challenge: id, runs: c.runs, inTime: c.inTime, fastHours: c.fast.hours, fastCost: c.fast.cost, fastRoute: c.fast.route,
    cheapCost: c.cheap?.cost ?? null, cheapRoute: c.cheap?.route ?? null };
});
const routes = [];
for (const id of ['grand', 'biscay']) {
  const ch = byId(id), world = createWorld(EUROPE, ch.modes, ch), g = G.newGame(world, ch, 's1');
  const opts = routeOptions(g, (leg) => legStatus(g.events, leg, world, g.seed, g.clock));
  routes.push({ challenge: id, options: Object.fromEntries([...opts].filter(([c]) => ch.targets.includes(c))
    .map(([c, list]) => [c, list.map((r) => ({ labels: r.labels, t: r.t, money: r.money, nights: r.nights, legs: r.legs.map((x) => x.leg.id) }))])) });
}
const dailies = ['2026-10-14', '2026-12-25', '2027-03-01'].map((iso) => {
  const [y, m, d] = iso.split('-').map(Number), ch = dailyChallenge(createWorld(EUROPE), new Date(y, m - 1, d, 12));
  return { date: [y, m, d], targets: ch.targets, hours: ch.hours, budget: ch.budget, parHours: ch.parHours };
});
save('plans', { plans, routes, dailies });
console.log(`fixtures: ${boards.length} boards, ${events.length} event sets, ${boards.reduce((a, b) => a + b.legs.length, 0)} departures`);

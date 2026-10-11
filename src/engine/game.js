// Game state and rules. No DOM in here: the same engine drives the web
// prototype, the solver in tools/, and later the iOS app.

import { local, localToUtc, rand, round5, MIN, HOUR } from './util.js';
import { generateEvents, legStatus } from './events.js';
import { drawTickets, ticketStatus } from './tickets.js';

export const RULES = {
  dwell: 90,             // minutes in town to get the passport stamped
  airConnect: 45,        // minimum minutes before a flight when already at the airport
  airFromCity: 60,       // check-in buffer on top of the transfer when coming from town
  railFromCity: 20,
  ferryCheckIn: 45,
  officeOpen: 6 * 60, officeClose: 20 * 60,
  nightFrom: 22 * 60, nightTo: 5 * 60, wake: 6 * 60,
  lookupsPerDay: 2,
  jamChance: 0.18,
  costStar: 0.8,         // share of budget to beat for the thrift star
  runMinSlack: 0.45,     // you can run for a departure with at least this share of the normal lead time
  flexPremium: 0.25,     // flexible ticket: fare back if you miss it
  ticketPoints: 75,
};

export function newGame(world, challenge, seed = String(Date.now())) {
  const home = world.cities.get(challenge.home);
  const [y, m, d] = challenge.date;
  const start = localToUtc(home.tz, y, m, d, challenge.startMinutes ?? 8 * 60);
  const g = {
    world, challenge, seed, start, clock: start,
    // `untimed` challenges have no deadline: the aim is simply the fastest finish.
    deadline: challenge.untimed ? Infinity : start + challenge.hours * HOUR,
    spent: 0, city: challenge.home, place: world.modes.includes('air') ? 'airport' : 'city', collected: [], stampAt: {},
    lookups: RULES.lookupsPerDay, path: [], log: [], nights: 0, hotels: 0, moves: 0, over: null,
    port: null, landed: [challenge.home], carriers: [], trains: 0, lowcost: false, tickets: [],
  };
  // Training is a calm first trip: no disruption and no bonus tickets.
  g.events = challenge.training ? [] : generateEvents(world, challenge, start, seed);
  g.offer = challenge.training || challenge.untimed ? [] : drawTickets(world, challenge, seed);
  return g;
}

export const here = (g) => g.world.cities.get(g.city);
export const remaining = (g) => g.challenge.budget - g.spent;
export const news = (g) => g.events.filter((e) => e.at <= g.clock);
export const isNight = (g) => {
  const { minutes } = local(here(g).tz, g.clock);
  return minutes >= RULES.nightFrom || minutes < RULES.nightTo;
};
// Cities where a stamp counts: the challenge list plus any detour ticket you kept.
export const stampCities = (g) => [...g.challenge.targets, ...g.tickets.filter((t) => t.city).map((t) => t.city)];

// Time and money needed to get from where you are to the right terminal.
// Airports cost a transfer. A ferry port is linked to the station by a short
// taxi or a train, which also costs time and money. `port` is the port you are
// standing in, if any. `links` lists the port connections used, for display.
export function lead(city, place, leg, port) {
  if (leg.mode === 'air') {
    return place === 'airport' ? { min: RULES.airConnect, cost: 0, links: [] }
      : { min: city.xfer + RULES.airFromCity, cost: city.xferCost, links: [] };
  }
  const links = place === 'port' ? [port] : [];
  let min = place === 'airport' ? city.xfer : place === 'port' ? port.mins : 0;
  let cost = place === 'airport' ? city.xferCost : place === 'port' ? port.cost : 0;
  if (leg.mode === 'rail') return { min: min + RULES.railFromCity, cost, links };
  if (place === 'port' && port.name === leg.port.name) return { min: RULES.ferryCheckIn, cost: 0, links: [] };
  return { min: min + leg.port.mins + RULES.ferryCheckIn, cost: cost + leg.port.cost, links: [...links, leg.port] };
}
export const leadFor = (g, leg) => lead(here(g), g.place, leg, g.port);

function withStatus(g, leg, mine) {
  const st = legStatus(g.events, leg, g.world, g.seed, g.clock);
  const l = mine ? leadFor(g, leg) : { min: 0, cost: 0, links: [] };
  return { leg, ...st, lead: l, total: leg.fare + l.cost };
}

// Today's remaining departures from a city. Rows for the city you are in carry
// booking details; rows for any other city are a read-only peek.
export function board(g, cityId = g.city) {
  const mine = cityId === g.city;
  return g.world.departuresOn(cityId, g.clock).filter((leg) => leg.dep >= g.clock).map((leg) => {
    const row = withStatus(g, leg, mine);
    row.flexTotal = row.total + Math.round(leg.fare * RULES.flexPremium);
    row.why = null; row.tight = null;
    if (row.status === 'cancelled') row.why = 'cancelled';
    else if (row.dep < g.clock + row.lead.min * MIN) {
      row.why = 'late';
      // Too late to stroll, but maybe not too late to run.
      const slack = (row.dep - g.clock) / (row.lead.min * MIN);
      if (mine && slack >= RULES.runMinSlack && row.total <= remaining(g)) {
        const p = 0.2 + 0.75 * ((slack - RULES.runMinSlack) / (1 - RULES.runMinSlack));
        row.tight = { p: Math.min(0.95, Math.max(0.05, Math.round(p * 20) / 20)) };
      }
    } else if (row.total > remaining(g)) row.why = 'funds';
    row.bookable = mine && !row.why;
    return row;
  });
}

// First look at tomorrow's board: read-only until you have slept.
export function tomorrow(g, cityId = g.city) {
  return g.world.departuresOn(cityId, g.clock + 24 * HOUR).map((leg) => withStatus(g, leg, false));
}

export const hasBerth = (leg) => !!leg.berth;

export const runSucceeds = (g, row) => !row.tight || rand(`${g.seed}|run|${row.leg.id}`) < row.tight.p;

// Returns { missed, notes }. A tight departure can be missed: the fare is lost
// unless the ticket was flexible.
export function book(g, row, { flex = false } = {}) {
  const { leg } = row;
  const from = g.city, origin = g.world.cities.get(from);
  const terminal = { air: 'airport', rail: 'city', ferry: 'port' }[leg.mode];
  const port = leg.mode === 'ferry' ? leg.portTo : null;
  const icon = { air: '✈', rail: '🚆', ferry: '⛴️' }[leg.mode];
  const premium = flex ? row.flexTotal - row.total : 0;
  g.moves++;
  if (!runSucceeds(g, row)) {
    const lost = flex ? row.lead.cost + premium : row.total;
    g.spent += lost;
    g.clock = row.dep + 10 * MIN;
    // You got as far as the departure point, not onto the ship.
    g.place = terminal;
    g.port = leg.mode === 'ferry' ? leg.port : null;
    g.log.push({ t: row.dep, tz: origin.tz, icon: '🏃', text: `Missed ${leg.no} to ${g.world.cities.get(leg.to).name}`, cost: lost });
    finish(g);
    return { missed: true, notes: [flex
      ? `The doors closed on ${leg.no}. Your flexible fare is refunded.`
      : `The doors closed on ${leg.no}. The ${leg.fare} pound fare is gone.`] };
  }
  const to = row.divertTo ?? leg.to, dest = g.world.cities.get(to);
  const notes = [];
  g.spent += row.total + premium;
  g.clock = row.arr;
  g.city = to;
  g.place = terminal;
  g.port = port;
  g.path.push({ from, to, mode: leg.mode });
  g.landed.push(to);
  if (leg.mode === 'rail') g.trains++;
  else if (leg.mode === 'air' && !g.carriers.includes(leg.code)) g.carriers.push(leg.code);
  if (leg.kind === 'lowcost') g.lowcost = true;
  g.log.push({ t: row.dep, tz: origin.tz, icon, text: `${leg.no} ${origin.name} → ${dest.name}`, cost: row.total + premium });
  if (hasBerth(leg) && isNight(g)) {
    // Docked in the small hours: stay in the cabin until morning.
    g.clock = nextWake(g);
    notes.push(`You slept on board and stepped ashore in ${dest.name} at 06:00. No hotel needed.`);
  } else if (hasBerth(leg)) notes.push(`You slept on board. No hotel needed.`);
  if (row.tight) notes.push(`Made it! You ran for ${leg.no} and got on.`);
  if (row.divertTo) notes.push(`Diverted! ${g.world.cities.get(leg.to).name} airport is closed, so you have landed in ${dest.name}.`);
  finish(g);
  return { missed: false, notes };
}

export function visitPlan(g) {
  const c = here(g);
  const { minutes } = local(c.tz, g.clock);
  const fromAirport = g.place === 'airport';
  const plan = {
    mins: (fromAirport ? c.xfer : g.place === 'port' ? g.port.mins : 0) + RULES.dwell,
    transfer: fromAirport ? c.xferCost : g.place === 'port' ? g.port.cost : 0,
    fee: Math.round(8 * c.idx),
    why: null,
  };
  plan.cost = plan.transfer + plan.fee;
  if (!stampCities(g).includes(c.id)) plan.why = 'Not on your list';
  else if (g.collected.includes(c.id)) plan.why = 'Already stamped';
  else if (minutes < RULES.officeOpen || minutes >= RULES.officeClose) plan.why = 'Stamp office shut until 06:00';
  else if (plan.cost > remaining(g)) plan.why = 'Not enough money';
  return plan;
}

export function visit(g) {
  const c = here(g), plan = visitPlan(g);
  const notes = [];
  let mins = plan.mins;
  if (g.place === 'airport' && !g.challenge.training && rand(`${g.seed}|jam|${g.moves}|${c.id}`) < RULES.jamChance) {
    const jam = round5(30 + rand(`${g.seed}|jam-len|${g.moves}`) * 45);
    mins += jam;
    notes.push(`Traffic jam on the way into ${c.name}: ${jam} minutes lost.`);
  }
  g.log.push({ t: g.clock, tz: c.tz, icon: c.emoji, text: `${c.name}: passport stamped`, cost: plan.cost });
  g.clock += mins * MIN;
  g.spent += plan.cost;
  g.collected.push(c.id);
  g.stampAt[c.id] = g.clock;
  g.place = 'city';
  g.port = null;
  g.moves++;
  finish(g);
  return notes;
}

export function hotelCost(g) {
  const c = here(g);
  const room = Math.round(65 * c.idx), meals = Math.round(22 * c.idx), transfer = g.place === 'airport' ? 6 : 0;
  return { room, meals, transfer, total: room + meals + transfer };
}

export function nextWake(g) {
  const tz = here(g).tz, p = local(tz, g.clock);
  return localToUtc(tz, p.y, p.m, p.d + (p.minutes < RULES.wake ? 0 : 1), RULES.wake);
}

// A night in the hotel: the clock jumps to 06:00. If you cannot pay for the
// room, the journey is over.
export function sleep(g) {
  const c = here(g), cost = hotelCost(g).total;
  if (cost > remaining(g)) { g.over = 'broke'; return; }
  g.log.push({ t: g.clock, tz: c.tz, icon: '🛏', text: `Hotel night in ${c.name}`, cost });
  g.spent += cost;
  g.clock = nextWake(g);
  g.hotels++;
  g.lookups = RULES.lookupsPerDay;
  g.nights++;
  g.moves++;
  finish(g);
}

export function usePeek(g) {
  if (g.lookups <= 0) return false;
  g.lookups--;
  return true;
}

function finish(g) {
  const all = g.challenge.targets.every((t) => g.collected.includes(t));
  if (all && g.city === g.challenge.home && g.clock <= g.deadline) g.over = 'won';
  else if (g.clock > g.deadline) g.over = 'timeout';
}

export const tickets = (g) => g.tickets.map((t) => ({ ...t, status: ticketStatus(g, t) }));

export function score(g) {
  const hours = (g.clock - g.start) / HOUR;
  const won = g.over === 'won';
  const thrift = won && g.spent <= g.challenge.budget * RULES.costStar;
  const speed = won && hours <= g.challenge.parHours;
  const kept = tickets(g);
  const done = kept.filter((t) => t.status === 'done').length;
  let points = won
    ? 300 + 100 * thrift + 100 * speed + Math.round(remaining(g) / 10) + Math.round((g.deadline - g.clock) / HOUR) * 2
    : g.challenge.targets.filter((t) => g.collected.includes(t)).length * 40;
  points += RULES.ticketPoints * (done - (kept.length - done));
  return { won, thrift, speed, stars: won + thrift + speed, hours, spent: g.spent, tickets: kept, ticketsDone: done, points: Math.max(0, points) };
}

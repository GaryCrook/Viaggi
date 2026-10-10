// Disruption: strikes, storms and sudden closures.
// Events are generated once per game from the seed. Each has an announce time
// (`at`) – forecast events give the player time to route around them, sudden
// ones don't.

import { rand, distKm, round5, HOUR, MIN, fmtDay, fmtTime } from './util.js';

const pick = (list, key) => list[Math.floor(rand(key) * list.length)];

export function generateEvents(world, challenge, start, seed) {
  const { cities, region, modes } = world;
  const hours = challenge.hours;
  const home = cities.get(challenge.home);
  const targets = challenge.targets.map((id) => cities.get(id));
  const all = [...cities.values()].filter((c) => world.services.get(c.id).length);
  const events = [];

  // 1. A national strike on day two, announced from the start.
  const strikeCountry = rand(`${seed}|strike-where`) < 0.6
    ? pick(targets, `${seed}|strike-target`).country
    : pick(all.filter((c) => c.country !== home.country).concat(all).slice(0, all.length), `${seed}|strike-any`).country;
  const strikeMode = !modes.includes('air') || (modes.includes('rail') && rand(`${seed}|strike-mode`) < 0.35) ? 'rail' : 'air';
  // In a single-country game a full-day national strike would stop everything,
  // so it runs for eight hours instead, as real strikes with protected hours do.
  const national = new Set(all.map((c) => c.country)).size === 1;
  const strikeFrom = start + (national ? 25 : 22) * HOUR, strikeTo = strikeFrom + (national ? 8 : 24) * HOUR;
  const where = region.countryNames[strikeCountry] || strikeCountry;
  events.push({
    type: 'strike', mode: strikeMode, country: strikeCountry, at: start, from: strikeFrom, to: strikeTo,
    text: strikeMode === 'air'
      ? `Air traffic control strike in ${where} on ${fmtDay(home.tz, strikeFrom + 6 * HOUR)}. Most flights will be cancelled.`
      : `Rail strike in ${where} on ${fmtDay(home.tz, strikeFrom + 6 * HOUR)}${national ? `, ${fmtTime(home.tz, strikeFrom)} to ${fmtTime(home.tz, strikeTo)}` : ''}. Most trains will be cancelled.`,
  });

  // 2. Storms: six hours of delays at one city, forecast five hours ahead.
  const stormCount = hours > 60 ? 2 : 1;
  const stormCities = [...targets, ...all.filter((c) => c.tier === 1)];
  for (let i = 0; i < stormCount; i++) {
    const city = pick(stormCities, `${seed}|storm-city|${i}`);
    const from = start + (6 + rand(`${seed}|storm-time|${i}`) * Math.max(6, hours - 18)) * HOUR;
    events.push({
      type: 'storm', city: city.id, at: from - 5 * HOUR, from, to: from + 6 * HOUR,
      text: `Storm warning for ${city.name} from ${fmtTime(city.tz, from)} local on ${fmtDay(city.tz, from)}. Expect long delays.`,
    });
  }

  // 3. A sudden airport closure: inbound flights divert to the nearest alternative.
  if (hours > 30 && modes.includes('air')) {
    const city = pick(targets, `${seed}|close-city`);
    const from = start + (12 + rand(`${seed}|close-time`) * (hours - 24)) * HOUR;
    const alt = all.filter((c) => c.id !== city.id).sort((a, b) => distKm(a, city) - distKm(b, city))[0];
    events.push({
      type: 'closure', city: city.id, alt: alt.id, at: from - 30 * MIN, from, to: from + 5 * HOUR,
      text: `Security alert at ${city.name} airport. Inbound flights are diverting to ${alt.name}.`,
    });
  }

  return events.sort((a, b) => a.at - b.at);
}

// What the events do to one departure. `now` hides sudden events until announced.
export function legStatus(events, leg, world, seed, now = Infinity) {
  const from = world.cities.get(leg.from), to = world.cities.get(leg.to);
  const out = { status: 'ontime', dep: leg.dep, arr: leg.arr, divertTo: null, known: true };
  for (const e of events) {
    if (e.type === 'strike' && e.mode === leg.mode && leg.dep >= e.from && leg.dep < e.to
        && (from.country === e.country || to.country === e.country)
        && rand(`${seed}|strike|${leg.id}`) < 0.75) {
      out.status = 'cancelled';
    }
    if (e.type === 'storm' && e.city === leg.from && leg.dep >= e.from && leg.dep < e.to) {
      const r = rand(`${seed}|storm|${leg.id}`);
      if (r < 0.15) out.status = 'cancelled';
      else if (out.status !== 'cancelled') {
        const delay = round5(45 + ((r - 0.15) / 0.85) * 135) * MIN;
        out.status = 'delayed'; out.dep = leg.dep + delay; out.arr = leg.arr + delay;
      }
    }
  }
  for (const e of events) {
    if (e.type === 'closure' && leg.mode === 'air' && e.city === leg.to && out.arr >= e.from && out.arr < e.to
        && out.status !== 'cancelled') {
      out.divertTo = e.alt;
      out.arr += 35 * MIN;
      out.known = now >= e.at;
    }
  }
  return out;
}

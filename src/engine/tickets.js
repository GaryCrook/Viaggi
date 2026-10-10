// Bonus tickets: secret optional objectives, in the spirit of Ticket to Ride's
// destination tickets. Two are drawn each game; the player keeps one or both.
// A kept ticket scores points if completed and costs points if not.

import { rand, HOUR } from './util.js';

const COMPASS = [
  ['north', 'Far North', 'Touch down north of 60°N', (c) => c.lat > 59.9],
  ['south', 'Deep South', 'Touch down south of 39°N', (c) => c.lat < 39],
  ['east', 'Far East', 'Touch down east of 23°E', (c) => c.lon > 23],
];

export function drawTickets(world, ch, seed) {
  // Only places this game's transport can actually reach.
  const cities = [...world.cities.values()].filter((c) => world.services.get(c.id).length);
  const air = world.modes.includes('air'), rail = world.modes.includes('rail');
  const listed = [ch.home, ...ch.targets];
  const deck = [];

  const detours = cities.filter((c) => c.tier <= 2 && !listed.includes(c.id));
  const d = detours[Math.floor(rand(`${seed}|detour`) * detours.length)];
  if (d) deck.push({ id: 'detour', icon: d.emoji, name: `Detour to ${d.name}`, text: `Get an extra stamp in ${d.name}.`, city: d.id });

  for (const [id, name, text, test] of COMPASS) {
    const ids = cities.filter(test).map((c) => c.id);
    if (ids.length && !ids.some((i) => listed.includes(i))) deck.push({ id, icon: '🧭', name, text: `${text}.`, cities: ids });
  }
  const airlines = ch.targets.length <= 3 ? 3 : 4, spare = Math.max(3, Math.round(ch.hours * 0.15));
  deck.push({ id: 'pincher', icon: '🪙', name: 'Penny Pincher', text: 'Finish with at least 30% of the budget left.' });
  deck.push({ id: 'early', icon: '⏱', name: 'Early Bird', text: `Get home with ${spare} hours to spare.`, spare });
  if (air) deck.push({ id: 'airlines', icon: '🛫', name: 'Frequent Flyer', text: `Fly with ${airlines} different airlines.`, count: airlines });
  if (air) deck.push({ id: 'flag', icon: '🥂', name: 'Flag Carrier', text: 'Never fly a low-cost airline.' });
  if (air && rail) deck.push({ id: 'rail', icon: '🚆', name: 'Rail Fan', text: 'Take two trains.' });

  return deck.map((t) => [rand(`${seed}|draw|${t.id}`), t]).sort((a, b) => a[0] - b[0]).slice(0, 2).map((x) => x[1]);
}

// 'done' | 'failed' | 'open'. Once the game is over, anything still open has failed.
export function ticketStatus(g, t) {
  const over = !!g.over, won = g.over === 'won';
  const settle = (ok, broken = false) => (broken ? 'failed' : ok ? 'done' : over ? 'failed' : 'open');
  switch (t.id) {
    case 'detour': return settle(g.collected.includes(t.city));
    case 'north': case 'south': case 'east': return settle(g.landed.some((id) => t.cities.includes(id)));
    case 'airlines': return settle(g.carriers.length >= t.count);
    case 'rail': return settle(g.trains >= 2);
    case 'flag': return settle(won, g.lowcost);
    case 'pincher': return settle(won && g.challenge.budget - g.spent >= g.challenge.budget * 0.3);
    case 'early': return settle(won && g.deadline - g.clock >= t.spare * HOUR);
    default: return 'open';
  }
}

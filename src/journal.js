// The traveller's journal: a lifelong record kept across games on this device.
// Every stamp ever collected, special stamps for unusual feats, running totals,
// and the daily-challenge results that make up the streak.

const KEY = 'tg-journal';

export const FEATS = [
  { id: 'run', icon: '🏃', name: 'Made the gate', hint: 'Make a departure you had to run for' },
  { id: 'diverted', icon: '🌀', name: 'Diverted', hint: 'Land somewhere you did not plan to' },
  { id: 'sleeper', icon: '🌙', name: 'Night train', hint: 'Sleep in a berth on a sleeper train' },
  { id: 'ferrynight', icon: '⛴️', name: 'Overnight crossing', hint: 'Sleep in a cabin on an overnight ferry' },
  { id: 'nightowl', icon: '🦉', name: 'Night owl', hint: 'Get a passport stamp after 22:00' },
  { id: 'fullhouse', icon: '⭐', name: 'Three stars', hint: 'Win a journey with all three stars' },
  { id: 'shoestring', icon: '🪙', name: 'Shoestring', hint: 'Win a journey spending under 60% of the budget' },
  { id: 'tencountries', icon: '🌍', name: 'Ten countries', hint: 'Collect stamps in ten different countries' },
  { id: 'streak7', icon: '🔥', name: 'Seven in a row', hint: 'Complete the daily challenge seven days running' },
];

const blank = () => ({
  stamps: {},        // cityId -> { first, tz, mode, place, journey, count }
  feats: {},         // featId -> { first, count }
  totals: { journeys: 0, wins: 0, km: 0, air: 0, rail: 0, ferry: 0, hotels: 0, onBoard: 0 },
  dailies: {},       // 'y-m-d' -> { won, wonOnDay, points, stars, hours, spent }
});

export function loadJournal() {
  try {
    const j = JSON.parse(localStorage.getItem(KEY));
    if (j) return { ...blank(), ...j, totals: { ...blank().totals, ...j.totals } };
  } catch { /* private mode or damaged data: start afresh */ }
  return blank();
}

export function saveJournal(j) {
  try { localStorage.setItem(KEY, JSON.stringify(j)); } catch { /* private mode */ }
}

/** Marks a feat; returns true the first time it is earned. */
export function earn(j, id, when) {
  const had = !!j.feats[id];
  j.feats[id] = { first: j.feats[id]?.first ?? when, count: (j.feats[id]?.count ?? 0) + 1 };
  return !had;
}

/** Records a stamp; returns true if this city is new to the passport. */
export function recordStamp(j, city, when, via, journey) {
  const had = !!j.stamps[city.id];
  const old = j.stamps[city.id];
  j.stamps[city.id] = old ? { ...old, count: old.count + 1 }
    : { first: when, tz: city.tz, mode: via.mode, place: via.place, journey, count: 1 };
  return !had;
}

export const countries = (j, cityById) => new Set(Object.keys(j.stamps).map((id) => cityById(id)?.country).filter(Boolean));

// ------------------------------------------------------------------ daily streak

export const dayKey = (date) => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
const dayNumber = (key) => { const [y, m, d] = key.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };

/** Days won on the day itself (archive replays do not count). */
const wonDays = (j) => new Set(Object.entries(j.dailies).filter(([, r]) => r.wonOnDay).map(([k]) => dayNumber(k)));

/** The current streak, counting today if it has been completed, otherwise from yesterday. */
export function streak(j, today = new Date()) {
  const won = wonDays(j), t = dayNumber(dayKey(today));
  let day = won.has(t) ? t : t - 1, n = 0;
  while (won.has(day)) { n++; day--; }
  return { current: n, today: won.has(t), best: bestStreak(won) };
}

function bestStreak(won) {
  let best = 0;
  for (const d of won) {
    if (won.has(d - 1)) continue;
    let n = 0;
    while (won.has(d + n)) n++;
    best = Math.max(best, n);
  }
  return best;
}

export function recordDaily(j, key, result) {
  const old = j.dailies[key];
  // Keep the better result, and remember whether it was ever won on the day itself.
  const better = !old || result.points > old.points ? result : old;
  j.dailies[key] = { ...better, won: !!(result.won || old?.won), wonOnDay: !!((result.won && result.onDay) || old?.wonOnDay) };
}

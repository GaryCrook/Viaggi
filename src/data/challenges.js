// Challenges. `budget` and `parHours` come from tools/solve.mjs, which plays
// each challenge on the undisrupted timetable.
//   date: [year, month, day] of the start, in the home city's local time

export const CHALLENGES = [
  {
    id: 'dash', pack: 'air', modes: ['air'], name: 'Weekend Dash', blurb: 'Three northern capitals and home in time for Monday.',
    home: 'LON', targets: ['AMS', 'CPH', 'BER'], date: [2026, 10, 17], hours: 40, budget: 780, parHours: 31, level: 'Easy',
  },
  {
    id: 'grand', pack: 'air', modes: ['air'], name: 'The Grand Tour', blurb: 'Six great cities at the height of summer, when every seat costs more.',
    home: 'LON', targets: ['BCN', 'ROM', 'ATH', 'VIE', 'BER', 'STO'], date: [2026, 7, 13], hours: 80, budget: 2150, parHours: 64, level: 'Medium',
  },
  {
    id: 'edges', pack: 'air', modes: ['air'], name: 'Edges of Europe', blurb: 'The four corners of the map in midwinter. Thin timetables, long nights.',
    home: 'LON', targets: ['REK', 'LIS', 'IST', 'HEL', 'MLA'], date: [2027, 2, 8], hours: 96, budget: 1750, parHours: 78, level: 'Hard',
  },
  // Rail expansion: train-only journeys. `rail` is the timetable in play:
  // 'international' shows only cross-border trains between major cities;
  // a country code shows only that country's domestic network.
  {
    id: 'triangle', pack: 'rail', modes: ['rail', 'ferry'], rail: 'international', name: 'The Channel Triangle',
    blurb: 'Under the sea and round the Low Countries.',
    home: 'LON', targets: ['PAR', 'BRU', 'AMS'], date: [2026, 5, 9], hours: 40, budget: 760, parHours: 31, level: 'Easy',
  },
  {
    id: 'alpine', pack: 'rail', modes: ['rail', 'ferry'], rail: 'international', name: 'The Alpine Loop',
    blurb: 'Out of Paris, across Switzerland to Milan, then Munich and Vienna.',
    home: 'PAR', targets: ['GVA', 'MIL', 'ZRH', 'MUC', 'VIE'], date: [2026, 9, 7], hours: 80, budget: 1350, parHours: 68, level: 'Medium',
  },
  {
    id: 'iron', pack: 'rail', modes: ['rail', 'ferry'], rail: 'international', name: 'The Iron Road',
    blurb: 'Barcelona to Warsaw by way of Berlin and Budapest. The long way round the continent.',
    home: 'LON', targets: ['BCN', 'BER', 'WAW', 'BUD'], date: [2026, 6, 15], hours: 144, budget: 2600, parHours: 124, level: 'Hard',
  },
  {
    id: 'italia', pack: 'rail', modes: ['rail', 'ferry'], rail: 'IT', name: 'Il Bel Paese',
    blurb: 'One country, one network: Italy from Turin to Palermo, by high-speed train or the overnight boat.',
    home: 'MIL', targets: ['TRN', 'VCE', 'FLR', 'ROM', 'NAP', 'PMO'], date: [2026, 4, 20], hours: 112, budget: 1300, parHours: 80, level: 'Medium',
  },
  {
    id: 'biscay', pack: 'rail', modes: ['rail', 'ferry'], rail: 'international', domestic: ['ES'], name: 'Biscay or Barcelona',
    blurb: 'Sail from Portsmouth to the north coast or take the fast train through Paris. Then Spain is yours to cross.',
    home: 'LON', targets: ['SDR', 'MAD', 'SVQ', 'VLC', 'BCN'], date: [2026, 6, 22], hours: 108, budget: 1250, parHours: 90, level: 'Hard',
  },
  {
    id: 'espana', pack: 'rail', modes: ['rail', 'ferry'], rail: 'ES', name: 'Sol y Sombra',
    blurb: 'Spain by high-speed train from Madrid, with a night boat to Mallorca.',
    home: 'MAD', targets: ['BCN', 'VLC', 'SVQ', 'AGP', 'BIO', 'PMI'], date: [2026, 5, 18], hours: 88, budget: 950, parHours: 72, level: 'Medium',
  },
  {
    id: 'baltic', pack: 'rail', modes: ['rail', 'ferry'], rail: 'international', name: 'The Baltic Run',
    blurb: 'North by train, then island-hopping by ship: Copenhagen, Stockholm, Helsinki and Tallinn.',
    home: 'BER', targets: ['CPH', 'STO', 'HEL', 'TLL'], date: [2026, 7, 6], hours: 132, budget: 1150, parHours: 110, level: 'Medium',
  },
];

// One shared challenge per calendar day: same cities, same timetable and same
// disruption for everyone, with limits calibrated on the spot.
import { rand } from '../engine/util.js';
import { calibrate } from '../engine/planner.js';

export function dailyChallenge(world, now = new Date()) {
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()], key = date.join('-');
  const pool = [...world.cities.values()].filter((c) => c.id !== 'LON' && !c.railOnly)
    .map((c) => [rand(`daily|${key}|${c.id}`), c.id]).sort((a, b) => a[0] - b[0]);
  const ch = {
    id: 'daily', pack: 'air', modes: ['air'], name: 'Daily Challenge', level: 'Today', key, seed: `daily-${key}`,
    blurb: 'Four cities, new every day. Everyone gets the same timetable and the same trouble.',
    home: 'LON', targets: pool.slice(0, 4).map((x) => x[1]), date, hours: 0, budget: 0, parHours: 0,
  };
  const { fast } = calibrate(world, ch);
  ch.hours = Math.ceil(fast.hours * 1.4);
  ch.parHours = Math.ceil(fast.hours * 1.12);
  ch.budget = Math.ceil((fast.cost * 1.2) / 50) * 50;
  return ch;
}

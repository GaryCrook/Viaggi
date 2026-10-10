// Plays every challenge on the undisrupted timetable and reports the fastest
// and cheapest visiting orders. Run: npm run solve
import { EUROPE } from '../src/data/europe.js';
import { CHALLENGES, dailyChallenge } from '../src/data/challenges.js';
import { createWorld } from '../src/engine/world.js';
import { calibrate } from '../src/engine/planner.js';

for (const ch of [...CHALLENGES, dailyChallenge(createWorld(EUROPE))]) {
  const { runs, inTime, fast, cheap } = calibrate(createWorld(EUROPE, ch.modes, ch), ch);
  console.log(`${ch.name} [${ch.modes.join('+')}]: ${inTime}/${runs} orders finish inside ${ch.hours}h (budget £${ch.budget})`);
  console.log(`  fastest  ${fast.hours.toFixed(1)}h  £${fast.cost}  ${fast.nights} nights  ${fast.route.join('>')}`);
  if (cheap) console.log(`  cheapest £${cheap.cost}  ${cheap.hours.toFixed(1)}h  ${cheap.route.join('>')}`);
}

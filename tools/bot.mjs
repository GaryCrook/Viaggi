// A naive player: takes the first direct departure to a city it still needs,
// or the first leg of the quickest connection, and a hotel every night. Run across seeds to sanity-check difficulty.
import { EUROPE } from '../src/data/europe.js';
import { CHALLENGES } from '../src/data/challenges.js';
import { createWorld } from '../src/engine/world.js';
import * as G from '../src/engine/game.js';
import { earliest } from '../src/engine/planner.js';

for (const ch of CHALLENGES) {
  const world = createWorld(EUROPE, ch.modes, ch), out = [];
  for (let seed = 1; seed <= 30; seed++) {
    const g = G.newGame(world, ch, `s${seed}`);
    for (let i = 0; i < 200 && !g.over; i++) {
      if (!G.visitPlan(g).why) { G.visit(g); continue; }
      const want = ch.targets.filter((t) => !g.collected.includes(t));
      if (!want.length) want.push(ch.home);
      // Direct if possible; otherwise the first leg of the quickest connection.
      const rows = G.isNight(g) ? [] : G.board(g).filter((r) => r.bookable);
      let row = rows.find((r) => want.includes(r.leg.to));
      if (!row) {
        const plan = earliest(world, g.city, g.place, g.clock, want[0], g.port);
        row = plan && rows.find((r) => r.leg.id === plan.legs[0]?.id);
      }
      if (row) G.book(g, row);
      else G.sleep(g);
    }
    out.push(G.score(g));
  }
  const wins = out.filter((s) => s.won);
  const avg = (f) => wins.length ? Math.round(wins.reduce((a, s) => a + f(s), 0) / wins.length) : '-';
  console.log(`${ch.modes.join('+').padEnd(9)} ${ch.name.padEnd(20)} wins ${String(wins.length).padStart(2)}/30  avg ${avg((s) => s.hours)}h £${avg((s) => s.spent)}  stars ${out.map((s) => s.stars).join('')}`);
}

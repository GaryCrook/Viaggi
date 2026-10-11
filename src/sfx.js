// Quiet travel sounds, synthesised in the browser: a jet's rush for a flight,
// wheels on rails for a train, slow swell and a horn for a sea crossing.
// They play only during the travel time-lapse and can be switched off.

let ctx, noise;
let on = true;
try { on = localStorage.getItem('tg-sound') !== '0'; } catch { /* private mode */ }

function setup() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  ctx.resume();
}

const hiss = (t, secs) => { const n = ctx.createBufferSource(); n.buffer = noise; n.loop = true; n.start(t); n.stop(t + secs); return n; };
const filter = (type, freq, q = 0.7) => { const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; return f; };
const gain = (v) => { const x = ctx.createGain(); x.gain.value = v; return x; };

const SOUNDS = {
  // Broad rushing air that rises and settles, over a low engine drone.
  air(out, t, secs) {
    const band = filter('bandpass', 420, 0.5);
    band.frequency.linearRampToValueAtTime(900, t + secs * 0.35);
    band.frequency.linearRampToValueAtTime(520, t + secs);
    hiss(t, secs).connect(band).connect(filter('lowpass', 1800)).connect(out);
    const drone = ctx.createOscillator(), level = gain(0.18);
    drone.type = 'sawtooth'; drone.frequency.value = 82;
    drone.connect(filter('lowpass', 220)).connect(level).connect(out);
    drone.start(t); drone.stop(t + secs);
  },
  // Low rumble with the two-beat click of wheels over rail joints.
  rail(out, t, secs) {
    hiss(t, secs).connect(filter('lowpass', 260)).connect(gain(1.6)).connect(out);
    for (let beat = 0.15; beat < secs - 0.2; beat += 0.52) {
      for (const offset of [0, 0.11]) {
        const click = gain(0), at = t + beat + offset;
        click.gain.setValueAtTime(0.0001, at);
        click.gain.exponentialRampToValueAtTime(offset ? 0.45 : 0.7, at + 0.008);
        click.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
        hiss(at, 0.09).connect(filter('bandpass', 1300, 1.2)).connect(click).connect(out);
      }
    }
  },
  // Slow waves, with one soft blast of the ship's horn on leaving.
  ferry(out, t, secs) {
    const swell = gain(0.25), waves = ctx.createOscillator(), depth = gain(0.6);
    waves.frequency.value = 0.32;
    waves.connect(depth).connect(swell.gain);
    waves.start(t); waves.stop(t + secs);
    hiss(t, secs).connect(filter('lowpass', 650)).connect(swell).connect(out);
    const horn = gain(0);
    horn.gain.setValueAtTime(0, t + 0.1);
    horn.gain.linearRampToValueAtTime(0.5, t + 0.25);
    horn.gain.setValueAtTime(0.5, t + 0.8);
    horn.gain.linearRampToValueAtTime(0, t + 1.1);
    for (const hz of [110, 164]) {
      const o = ctx.createOscillator();
      o.type = 'triangle'; o.frequency.value = hz;
      o.connect(horn); o.start(t); o.stop(t + 1.2);
    }
    horn.connect(filter('lowpass', 500)).connect(out);
  },
};

export const sfx = {
  get on() { return on; },
  toggle() {
    on = !on;
    try { localStorage.setItem('tg-sound', on ? '1' : '0'); } catch { /* private mode */ }
  },
  // Call straight from a click: browsers only let audio start on a user gesture.
  unlock() { if (on) try { setup(); } catch { /* no audio available */ } },
  travel(mode, ms) {
    if (!on || !SOUNDS[mode]) return;
    try {
      setup();
      const t = ctx.currentTime + 0.02, secs = ms / 1000, out = gain(0);
      out.gain.setValueAtTime(0, t);
      out.gain.linearRampToValueAtTime(0.07, t + 0.35);        // kept deliberately quiet
      out.gain.setValueAtTime(0.07, t + Math.max(0.4, secs - 0.6));
      out.gain.linearRampToValueAtTime(0, t + secs);
      out.connect(ctx.destination);
      SOUNDS[mode](out, t, secs);
    } catch { /* sound is a nicety; never let it stop the game */ }
  },
};

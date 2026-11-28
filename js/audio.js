// Descent audio: procedural wind, canopy flutter and a touchdown thump.
//
// Everything is synthesized with the Web Audio API from a looping noise buffer,
// so the site keeps its no-downloads rule. The context is created on the first
// user gesture because browsers block audio before interaction. The wind bed
// follows airspeed and altitude, the canopy layer flutters with speed, and a
// one-shot impact plays when the subject reaches the ground.

const STORAGE_KEY = 'atlas.sound';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function readEnabled() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'off') return false;
    if (stored === 'on') return true;
  } catch {
    // Storage can be disabled; fall back to sound on.
  }
  return true;
}

function writeEnabled(enabled) {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // Not being able to remember the choice is not a reason to break.
  }
}

// Pink-ish noise from Paul Kellet's filter. It sounds much closer to moving air
// than white noise. The tail is crossfaded into the head and the loop stops
// before the fade, so the loop point is continuous instead of ticking.
function makeNoise(ctx, seconds = 4) {
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);

  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  let peak = 0;

  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    const value = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    b6 = white * 0.115926;
    data[i] = value;
    peak = Math.max(peak, Math.abs(value));
  }

  const scale = peak > 0 ? 0.62 / peak : 0;
  for (let i = 0; i < length; i++) data[i] *= scale;

  const fade = Math.min(Math.floor(sampleRate * 0.12), Math.floor(length / 4));
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    data[i] = data[i] * t + data[length - fade + i] * (1 - t);
  }

  return { buffer, loopEnd: (length - fade) / sampleRate };
}

export class DescentAudio {
  constructor() {
    this.enabled = readEnabled();
    this.gestureSeen = false;
    this.ctx = null;
    this.noise = null;
    this.nodes = null;
    this.failed = false;
    this.intensity = 0;
    this.last = { active: false, altitude: 0, fallRate: 0, speed: 0, dive: false };

    this.onGesture = (event) => {
      this.gestureSeen = true;
      if (!this.enabled) return;
      // Clicking the sound button is about to toggle the choice; do not start
      // a burst of wind on the way to muting it.
      const target = event?.target;
      if (target instanceof Element && target.closest?.('#sound')) return;
      if (event?.type === 'keydown' && String(event.key).toLowerCase() === 'u') return;
      this.ensure();
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('pointerdown', this.onGesture, { passive: true });
      window.addEventListener('keydown', this.onGesture);
      window.addEventListener('touchstart', this.onGesture, { passive: true });
      document.addEventListener('visibilitychange', () => {
        if (!this.ctx) return;
        if (document.hidden) {
          const paused = this.ctx.suspend?.();
          paused?.catch(() => {});
        } else if (this.enabled && this.last.active) {
          this.resume();
        }
      });
    }
  }

  get supported() {
    return Boolean(
      typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext),
    );
  }

  get status() {
    if (!this.enabled) return 'muted';
    return this.ctx ? this.ctx.state : 'idle';
  }

  // Build the graph on demand, only inside a user gesture. Returns null until
  // then so a page that is never touched makes no audio work at all.
  ensure() {
    if (this.ctx) {
      this.resume();
      return this.ctx;
    }
    if (!this.gestureSeen || !this.enabled || this.failed || !this.supported) return null;

    const Ctor = window.AudioContext || window.webkitAudioContext;
    let ctx;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      this.failed = true;
      return null;
    }

    this.ctx = ctx;
    try {
      this.#build(ctx);
    } catch {
      const failed = ctx.close?.();
      failed?.catch(() => {});
      this.ctx = null;
      this.failed = true;
      return null;
    }

    this.resume();
    return ctx;
  }

  #build(ctx) {
    const noise = makeNoise(ctx, 4);
    this.noise = noise;

    const master = ctx.createGain();
    master.gain.value = 0;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -20;
    limiter.knee.value = 24;
    limiter.ratio.value = 4;
    limiter.attack.value = 0.005;
    limiter.release.value = 0.25;

    master.connect(limiter);
    limiter.connect(ctx.destination);

    // One-shots bypass the wind fade so a touchdown still lands while the bed
    // is fading out.
    const fx = ctx.createGain();
    fx.gain.value = 1;
    fx.connect(limiter);

    const layer = (type, frequency, q) => {
      const source = ctx.createBufferSource();
      source.buffer = noise.buffer;
      source.loop = true;
      source.loopEnd = noise.loopEnd;

      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = frequency;
      filter.Q.value = q;

      const gain = ctx.createGain();
      gain.gain.value = 0;

      source.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      source.start();
      return { source, filter, gain };
    };

    const wind = layer('lowpass', 420, 0.7);
    const whistle = layer('bandpass', 1100, 2.2);
    const flap = layer('bandpass', 300, 0.9);

    // Slow gusts keep the bed from sounding like a static hiss.
    const gust = ctx.createOscillator();
    gust.type = 'sine';
    gust.frequency.value = 0.12;
    const gustDepth = ctx.createGain();
    gustDepth.gain.value = 140;
    gust.connect(gustDepth);
    gustDepth.connect(wind.filter.frequency);
    gust.start();

    // Canopy fabric flutter: a shallow amplitude wobble on the flap layer.
    const flutter = ctx.createOscillator();
    flutter.type = 'sine';
    flutter.frequency.value = 4.2;
    const flutterDepth = ctx.createGain();
    flutterDepth.gain.value = 0;
    flutter.connect(flutterDepth);
    flutterDepth.connect(flap.gain.gain);
    flutter.start();

    this.nodes = { master, limiter, fx, wind, whistle, flap, gust, gustDepth, flutter, flutterDepth };
  }

  resume() {
    if (!this.ctx || this.ctx.state !== 'suspended') return;
    const resumed = this.ctx.resume();
    resumed?.catch(() => {});
  }

  #fade(value, time = 0.3) {
    if (!this.ctx || !this.nodes) return;
    this.nodes.master.gain.setTargetAtTime(value, this.ctx.currentTime, time);
  }

  // Called every animation frame with the current descent state. `active` is
  // false in the atlas or the 3D orbit view, which fades the wind out.
  update(state = {}) {
    this.last = {
      active: Boolean(state.active),
      altitude: Number(state.altitude) || 0,
      fallRate: Number(state.fallRate) || 0,
      speed: Number(state.speed) || 0,
      dive: Boolean(state.dive),
    };

    if (!this.enabled || !this.last.active) {
      this.intensity = 0;
      this.#fade(0, 0.4);
      return;
    }

    const ctx = this.ensure();
    if (!ctx || !this.nodes) return;

    const { altitude, fallRate, speed, dive } = this.last;
    const air = clamp(Math.hypot(speed, fallRate) / 38, 0, 1);
    this.intensity = air;

    // High up the air is a deeper roar; close to the ground it gains a little
    // more edge. Dive adds a touch of extra wind noise.
    const high = clamp(altitude / 640, 0, 1);
    const t = ctx.currentTime;
    const smooth = 0.16;
    const { master, wind, whistle, flap, flutterDepth } = this.nodes;

    master.gain.setTargetAtTime(0.85, t, smooth);

    const windGain = 0.06 + air * 0.62 + high * 0.04;
    wind.gain.gain.setTargetAtTime(windGain, t, smooth);
    wind.filter.frequency.setTargetAtTime(
      260 + air * 1500 + (1 - high) * 220 + (dive ? 160 : 0),
      t,
      smooth,
    );

    const whistleGain = 0.012 + air * air * 0.1;
    whistle.gain.gain.setTargetAtTime(whistleGain, t, smooth);
    whistle.filter.frequency.setTargetAtTime(
      700 + air * 1500 + (dive ? 250 : 0),
      t,
      smooth,
    );

    const flapGain = 0.01 + air * 0.11;
    flap.gain.gain.setTargetAtTime(flapGain, t, smooth);
    flutterDepth.gain.setTargetAtTime(flapGain * 0.55, t, smooth);
  }

  // A short low thump plus a filtered noise burst: fabric and ground meeting.
  land() {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx || !this.nodes || !this.noise) return;

    const { fx } = this.nodes;
    const t = ctx.currentTime;
    const buffer = this.noise.buffer;

    const burst = ctx.createBufferSource();
    burst.buffer = buffer;
    const burstFilter = ctx.createBiquadFilter();
    burstFilter.type = 'lowpass';
    burstFilter.frequency.setValueAtTime(1200, t);
    burstFilter.frequency.exponentialRampToValueAtTime(140, t + 0.5);
    const burstGain = ctx.createGain();
    burstGain.gain.setValueAtTime(0.0001, t);
    burstGain.gain.exponentialRampToValueAtTime(0.45, t + 0.018);
    burstGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    burst.connect(burstFilter);
    burstFilter.connect(burstGain);
    burstGain.connect(fx);
    burst.start(t, Math.random() * Math.max(0, buffer.duration - 0.7));
    burst.stop(t + 0.6);

    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(96, t);
    thump.frequency.exponentialRampToValueAtTime(44, t + 0.28);
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(0.0001, t);
    thumpGain.gain.exponentialRampToValueAtTime(0.5, t + 0.012);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    thump.connect(thumpGain);
    thumpGain.connect(fx);
    thump.start(t);
    thump.stop(t + 0.5);
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    writeEnabled(this.enabled);
    if (this.enabled) {
      // This is normally reached from a click or key press, which is exactly
      // the gesture the browser needs before audio may start.
      this.gestureSeen = true;
      this.ensure();
    } else {
      this.#fade(0, 0.12);
    }
    return this.enabled;
  }

  toggle() {
    return this.setEnabled(!this.enabled);
  }
}

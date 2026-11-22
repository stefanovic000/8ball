import type { SimEvent } from './core/physics';

/**
 * Table sounds, synthesised: no assets, and each contact gets its own voice.
 *
 * Everything is scheduled against the AudioContext clock the moment a shot is
 * known, so a hidden tab still plays the whole shot — browsers keep audio
 * running when they stop animation frames.
 */
export class TableAudio {
  enabled = true;

  private ctx: AudioContext | null = null;
  private bus: AudioNode | null = null;
  private noise: AudioBuffer | null = null;

  /** Browsers only allow audio after a gesture, so this runs on the first shot. */
  private ensure(): AudioContext | null {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 12;
      comp.ratio.value = 6;
      const bus = this.ctx.createGain();
      bus.gain.value = 0.85;
      comp.connect(bus).connect(this.ctx.destination);
      this.bus = comp;

      const len = Math.floor(this.ctx.sampleRate * 0.25);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.noise = buf;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** The cue hitting the ball. */
  cue(power: number): void {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime + 0.01;
    this.burst(t, 0.055, 1400 + power * 900, 0.1 + power * 0.22, 'band');
  }

  /**
   * A whole shot at once. Contacts are bucketed in 60ms windows and capped per
   * window, because a break is 30-odd contacts in a third of a second and
   * uncapped that is a buzz, not a sound.
   */
  play(events: SimEvent[], delay = 0.02): void {
    if (!this.enabled || events.length === 0) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const start = ctx.currentTime + delay;

    const buckets = new Map<number, SimEvent[]>();
    for (const e of events) {
      const k = Math.floor(e.t / 0.06);
      const list = buckets.get(k);
      if (list) list.push(e);
      else buckets.set(k, [e]);
    }

    for (const list of buckets.values()) {
      const loud = list
        .slice()
        .sort((a, b) => speedOf(b) - speedOf(a))
        .slice(0, 5);
      for (const e of loud) this.contact(start + e.t, e);
    }
  }

  private contact(when: number, e: SimEvent): void {
    switch (e.type) {
      case 'ball':
        this.burst(when, 0.07, 1800 + Math.min(1, e.speed / 4) * 1600, 0.06 + e.speed * 0.1, 'band');
        this.tone(when, 520 + e.speed * 90, 0.05, 0.03 + e.speed * 0.05);
        break;
      case 'rail':
        this.burst(when, 0.1, 420, 0.08 + e.speed * 0.12, 'low');
        this.tone(when, 130, 0.09, 0.05 + e.speed * 0.06);
        break;
      case 'jaw':
        this.burst(when, 0.06, 1200, 0.09 + e.speed * 0.1, 'band');
        break;
      case 'pocket':
        this.drop(when);
        break;
      default:
        break;
    }
  }

  /** Filtered noise: the click of two balls, the thud of a rail. */
  private burst(
    when: number,
    dur: number,
    freq: number,
    amp: number,
    shape: 'band' | 'low',
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.bus || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 1;
    const filter = ctx.createBiquadFilter();
    filter.type = shape === 'low' ? 'lowpass' : 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = shape === 'low' ? 0.7 : 1.6;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(Math.min(0.9, Math.max(0.04, amp)), when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(filter).connect(gain).connect(this.bus);
    src.start(when);
    src.stop(when + dur + 0.01);
  }

  private tone(when: number, freq: number, dur: number, amp: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.bus) return;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, when);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(Math.min(0.5, Math.max(0.02, amp)), when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(gain).connect(this.bus);
    osc.start(when);
    osc.stop(when + dur + 0.01);
  }

  /** Ball dropping into a pocket: a short fall in pitch, then a rattle. */
  private drop(when: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.bus) return;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(240, when);
    osc.frequency.exponentialRampToValueAtTime(70, when + 0.22);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.16, when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.28);
    osc.connect(gain).connect(this.bus);
    osc.start(when);
    osc.stop(when + 0.3);
  }
}

function speedOf(e: SimEvent): number {
  return e.type === 'pocket' ? 1 : e.speed;
}

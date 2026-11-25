// audio.js — Helicarriers at Sea v1.3.0: WebAudio synth, no audio files
// (Hurricane's ~25-line pattern: lazy AudioContext, blip/noise helpers,
// master mute). Every method is a no-op until the first user gesture
// creates the context, and every call is try/catch-guarded so a headless
// probe (no AudioContext / no gesture) never throws.
export class GameAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    try { this.muted = localStorage.getItem('helicarriers_muted') === '1'; } catch (_) { /* no storage */ }
    this._alarmT = -1e9;
    this._now = 0; // game time, fed by game.js so throttling is in game seconds
  }
  ensure() {
    if (this.ctx || this.muted) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch (_) { this.ctx = null; }
  }
  setMuted(m) {
    this.muted = !!m;
    try { localStorage.setItem('helicarriers_muted', this.muted ? '1' : '0'); } catch (_) {}
    if (this.ctx) { try { this.ctx.suspend(); } catch (_) {} }
  }
  _blip(freq, dur, type, gain) {
    if (!this.ctx || this.muted) return;
    try {
      const a = this.ctx, o = a.createOscillator(), g = a.createGain();
      o.type = type || 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(gain || 0.08, a.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
      o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + dur + 0.02);
    } catch (_) {}
  }
  _noise(dur, gain, freq, q) {
    if (!this.ctx || this.muted) return;
    try {
      const a = this.ctx, len = Math.max(1, Math.floor(a.sampleRate * dur));
      const buf = a.createBuffer(1, len, a.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = a.createBufferSource(); src.buffer = buf;
      const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq || 400; f.Q.value = q || 0.8;
      const g = a.createGain(); g.gain.setValueAtTime(gain || 0.25, a.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
      src.connect(f); f.connect(g); g.connect(a.destination); src.start();
    } catch (_) {}
  }
  click() { this._blip(880, 0.06, 'square', 0.04); }
  // v1.4.0 rotor hum: a continuous low drone whose pitch and level
  // follow the selected carrier's mean rotor spin (0..~1.15). Created
  // lazily on the first call after the AudioContext exists; a no-op
  // until then (headless probes never create a context). Muting silences
  // it with everything else.
  rotor(spinFrac) {
    if (!this.ctx) return;
    try {
      if (!this._rotor) {
        const a = this.ctx;
        const o = a.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 55;
        const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 220; f.Q.value = 0.7;
        const g = a.createGain(); g.gain.value = 0;
        o.connect(f); f.connect(g); g.connect(a.destination); o.start();
        this._rotor = { o, f, g };
      }
      const s = Math.max(0, Math.min(1.15, spinFrac || 0));
      const t = this.ctx.currentTime;
      this._rotor.o.frequency.setTargetAtTime(38 + s * 42, t, 0.2);
      this._rotor.g.gain.setTargetAtTime(this.muted ? 0 : 0.012 + s * 0.04, t, 0.2);
    } catch (_) { /* audio must never break the sim */ }
  }
  whoosh() { this._noise(0.7, 0.18, 900, 1.2); this._blip(220, 0.5, 'sawtooth', 0.03); }
  samLaunch() { this._noise(0.5, 0.2, 1400, 1); this._blip(440, 0.4, 'sawtooth', 0.05); }
  boom(big) { this._noise(big ? 1.4 : 0.9, big ? 0.5 : 0.35, 220, 0.6); this._blip(55, big ? 1.2 : 0.8, 'sine', 0.3); }
  thunder() { this._noise(2.2, 0.3, 120, 0.5); this._blip(40, 2.0, 'sine', 0.2); }
  alarm(now) {
    // Throttled: at most one alarm per 5 game-seconds, so a flagship
    // under sustained fire does not become a siren loop.
    if (now - this._alarmT < 5) return;
    this._alarmT = now;
    this._blip(660, 0.18, 'square', 0.06);
    try { setTimeout(() => this._blip(520, 0.18, 'square', 0.06), 220); } catch (_) {}
  }
}

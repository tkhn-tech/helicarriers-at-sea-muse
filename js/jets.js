// jets.js — air wings: steerJetTo flight model (Hurricane Fleet L5679-5832,
// converted to metric: 1 unit = 1 m), squadron state machine (L6513-7106),
// ASM + bomb attack, and the wingman-bomb fix.
//
// THE WINGMAN-BOMB BUG (REUSE_MAP §3f) and the fix, in full:
//   Hurricane had three compounding defects:
//   1. Frozen aim: the wingman's diveAimPt was computed ONCE at dive start
//      and never updated, while the target (up to 14 u/s) moved 70-140 m
//      during the dive. 2. Release-altitude mismatch: the wingman released
//      at sea+40 through the leader's dj<=45 gate — same 80 u/s 30 deg dive
//      from 10 higher travels ~60, not 45, so bombs landed ~15 long even
//      with perfect aim. 3. A 2 s hold that flew the wingman onto the target
//      (22 out) and overshot, forcing a long flat re-attack on stale aim.
//   The fix in this file:
//   * ONE release geometry for both jets, re-derived from AirBomb
//     ballistics: dive 190 m/s at 30 deg, release 60 m above the target
//     deck and 100 m out horizontally. Check: vy = -95 m/s; fall 60 m
//     takes t = (-95 + sqrt(95^2 + 4*4.905*60)) / 9.81 = 0.61 s;
//     horizontal travel = 190*cos(30 deg)*0.61 = 100.4 m. Release
//     distance == travel, so the bomb lands on the aim point.
//   * The dive aim is recomputed EVERY FRAME for both jets (leader and
//     wingman alike), with a 0.5 s target-velocity lead. Nothing is frozen.
//   * The stagger is time-only: the wingman enters the dive 1.5 s after
//     the leader, from the same geometry, at the same release gate
//     (horizDist <= 105, alt <= deckAlt+70, |roll| < 0.35). No altitude
//     offset, no separate gate.
//   * bombBallisticsProbe() below replays the exact release numbers
//     (20 drops per jet, moving target) — run it from ?probe=bombs or
//     the debug panel before trusting the dive.
import * as THREE from 'three';

export const JET_CRUISE_SPEED = 140;
export const JET_ATTACK_SPEED = 170;
export const JET_CATAPULT_SPEED = 75;
export const JET_DIVE_SPEED = 190;
export const JET_TRAP_SPEED = 65;
export const JET_STALL_SPEED = 65;   // ~126 kt
export const JET_RECOVER_SPEED = 78;
export const JET_MIN_ALT = 15;       // above the sea
export const JET_MAX_ALT = 1200;
export const BOMB_RELEASE_ALT = 60;  // m above target deck at release
export const BOMB_RELEASE_DIST = 100; // m horizontal from target at release
export const BOMB_DMG = 30;
export const MISSILE_SPEED = 260;
export const MISSILE_DMG = 25;
export const AIR_WING_TOTAL = 12;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

// steerJetTo — Hurricane Arrive steering, metric numbers. Mutates jet.
// jet fields: x,y,z,vx,vy,vz,heading,pitch,roll,speed,stalled,turnSide.
export function steerJetTo(jet, aim, slowingR, maxSpeed, dt, opts = {}) {
  const dx = aim.x - jet.x, dy = aim.y - jet.y, dz = aim.z - jet.z;
  const d = Math.hypot(dx, dy, dz) || 0.001;
  const ux = dx / d, uy = dy / d, uz = dz / d;
  jet.speed = Math.hypot(jet.vx, jet.vy, jet.vz);
  // v1.3.0 zone effects (B): damaged engines cut speed/turn, a lost
  // wing cuts lift — applied here so every steering path feels them.
  const speedMul = jet.speedMul !== undefined ? jet.speedMul : 1;
  const turnMul = jet.turnMul !== undefined ? jet.turnMul : 1;
  if (!jet.stalled && jet.speed < JET_STALL_SPEED) { jet.stalled = true; jet.stallSide = Math.random() < 0.5 ? 1 : -1; }
  if (jet.stalled && jet.speed > JET_RECOVER_SPEED) jet.stalled = false;
  let tx = ux, ty = uy, tz = uz;
  // v1.3.0 SAM evasion (Hurricane v11.45 F5): while the defensive timer
  // runs the jet breaks 90 deg to its evasion side — the aim vector is
  // rotated, so the jet actually turns away from the SAM, not just banks.
  if (jet.defensiveT > 0 && !jet.stalled) {
    const s = jet.defSide || 1;
    const rx = Math.cos(jet.heading), rz = Math.sin(jet.heading);
    tx = rx * s; ty = 0; tz = rz * s;
  }
  let sp = maxSpeed * Math.min(1, d / slowingR) * speedMul;
  if (jet.stalled) {
    // Dive ~34 deg, gain speed by falling, mushy controls.
    const fx = Math.sin(jet.heading), fz = -Math.cos(jet.heading);
    tx = fx; ty = -0.55; tz = fz;
    sp = 0;
  } else {
    // Aim-behind override: turn instead of decelerating through zero.
    const vLen = Math.max(1, jet.speed);
    const dot = (jet.vx * ux + jet.vy * uy + jet.vz * uz) / vLen;
    if (dot < 0 && !opts.noTurnAround) {
      const side = jet.turnSide || 1;
      const rx = Math.cos(jet.heading), rz = Math.sin(jet.heading);
      tx = rx * side; ty = 0; tz = rz * side;
    }
    // Bank bleed
    if (Math.abs(jet.roll) > 0.5) sp -= Math.min(30, 20 * (1 / Math.cos(jet.roll) - 1));
    sp = Math.max(80, sp); // commanded floor (not stalled)
  }
  // Longitudinal accel toward desired speed along aim
  const curAlong = jet.vx * tx + jet.vy * ty + jet.vz * tz;
  const accel = jet.stalled ? 0 : 50;
  let dAlong = clamp(sp - curAlong, -accel * dt, accel * dt);
  jet.vx += tx * dAlong; jet.vy += ty * dAlong; jet.vz += tz * dAlong;
  // Lateral (turn) accel — cap order: longitudinal first, then lateral.
  const latCap = (jet.stalled ? 15 : 45) * turnMul;
  const pvx = jet.vx - tx * (jet.vx * tx + jet.vy * ty + jet.vz * tz);
  const pvy = jet.vy - ty * (jet.vx * tx + jet.vy * ty + jet.vz * tz);
  const pvz = jet.vz - tz * (jet.vx * tx + jet.vy * ty + jet.vz * tz);
  const pl = Math.hypot(pvx, pvy, pvz);
  if (pl > latCap * dt * 60 * 0.016) { /* scale below */ }
  const latMax = latCap * dt;
  if (pl > 0.001) {
    const k = Math.min(1, latMax / pl);
    jet.vx -= pvx * (1 - k); jet.vy -= pvy * (1 - k); jet.vz -= pvz * (1 - k);
  }
  // Vertical accel: pullout 4 g, dive pushover, else normal.
  const vAcc = jet.stalled ? 15 : opts.pullout ? 39 : opts.dive ? 60 : 35;
  const wantVy = ty * sp;
  jet.vy += clamp(wantVy - jet.vy, -vAcc * dt, vAcc * dt);
  // Actual-speed floor in flight states (v11.46/50 fix: 259 stall-sea
  // deaths -> 1). Never applied while stalled (stall recovers by falling).
  if (!jet.stalled && opts.flight) {
    const s = Math.hypot(jet.vx, jet.vy, jet.vz);
    if (s < 80 && s > 0.01) { const k = 80 / s; jet.vx *= k; jet.vy *= k; jet.vz *= k; }
  }
  jet.speed = Math.hypot(jet.vx, jet.vy, jet.vz);
  // Integrate
  jet.x += jet.vx * dt; jet.y += jet.vy * dt; jet.z += jet.vz * dt;
  // Altitude floor / ceiling (sea only; deck altitude handled by caller)
  const seaH = opts.seaH !== undefined ? opts.seaH : 0;
  if (!jet.stalled && jet.y < seaH + JET_MIN_ALT) { jet.y = seaH + JET_MIN_ALT; if (jet.vy < 0) jet.vy = 0; }
  if (jet.y > JET_MAX_ALT) { jet.y = JET_MAX_ALT; if (jet.vy > 0) jet.vy = 0; }
  // Attitude
  const vHeading = Math.atan2(jet.vx, -jet.vz);
  let dh = vHeading - jet.heading;
  dh = ((dh + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  jet.heading += clamp(dh, -3 * dt, 3 * dt);
  const omega = dh / Math.max(dt, 1e-3);
  jet.omegaSm = (jet.omegaSm || 0) + (clamp(omega, -1.5, 1.5) - (jet.omegaSm || 0)) * Math.min(1, dt * 6);
  let pitchT;
  if (jet.stalled) pitchT = -0.6;
  else pitchT = clamp(Math.asin(clamp(jet.vy / Math.max(jet.speed, 1), -1, 1)) + (opts.trap ? 0.14 : opts.attack ? 0 : 0.05), -1.05, 1.05);
  jet.pitch += clamp(pitchT - jet.pitch, -3 * dt, 3 * dt);
  let rollT;
  if (opts.pullout) rollT = 0;
  else if (opts.defensive) rollT = opts.defSide * 1.05;
  else if (jet.stalled) rollT = jet.stallSide * 0.5;
  else rollT = clamp(-Math.atan2(jet.speed * jet.omegaSm, 9.81), -1.31, 1.31);
  // v1.3.0: a damaged wing rolls the jet toward the dead side even in
  // level flight (roll bias), and SAM evasion is driven from the jet's
  // own defensive timer when the squadron did not pass opts.defensive.
  if (jet.rollBias) rollT += jet.rollBias;
  if (jet.defensiveT > 0 && !opts.pullout) rollT = (jet.defSide || 1) * 1.05;
  jet.roll += clamp(rollT - jet.roll, -3.8 * dt, 3.8 * dt);
}

// ---------------- Ordnance ----------------
export class AirBomb {
  constructor(x, y, z, vx, vy, vz, target, ctx, by) {
    this.x = x; this.y = y; this.z = z; this.vx = vx; this.vy = vy; this.vz = vz;
    this.target = target; this.ctx = ctx; this.alive = true; this.t = 0;
    this.by = by || null; // e.g. 'player/leader' — carried into bombStats.log for per-jet attribution
  }
  update(dt) {
    if (!this.alive) return;
    this.t += dt;
    this.vy -= 9.81 * dt; // AirBomb ballistics: g = 9.81 (Hurricane used 15 in game units)
    this.x += this.vx * dt; this.y += this.vy * dt; this.z += this.vz * dt;
    const tgt = this.target;
    if (!tgt || tgt.state === 'gone') { this.alive = false; return; }
    const deckY = tgt.deckTopY();
    const l0 = tgt.localFromWorld(this.x, this.z);
    // Only resolve a deck hit while the bomb is over/near the deck
    // footprint; a bomb passing beside the carrier keeps falling to the sea.
    if (this.y <= deckY + 5 && Math.abs(l0.lz) < 166 * 1.1 && Math.abs(l0.lx) < 34 * 1.5) {
      const l = l0;
      if (Math.abs(l.lz) < 166 * 0.95 && Math.abs(l.lx) < 34 * 1.2) {
        tgt.damage(BOMB_DMG, l.lx, l.lz, true, this.ctx);
        this.ctx.bombLog && this.ctx.bombLog(true, l.lz, l.lx, this.by); // along=lz (bow/stern), across=lx
      } else {
        const seaH = this.ctx.sea.waveHeight(this.x, this.z, this.ctx.time);
        this.ctx.vfx.splash(this.x, Math.max(seaH, deckY), this.z, 12);
        this.ctx.bombLog && this.ctx.bombLog(false, l.lz, l.lx, this.by);
      }
      this.alive = false; return;
    }
    const seaH = this.ctx.sea.waveHeight(this.x, this.z, this.ctx.time);
    if (this.y <= seaH) {
      this.ctx.vfx.splash(this.x, seaH, this.z, 10);
      this.ctx.bombLog && this.ctx.bombLog(false, 999, 999, this.by);
      this.alive = false;
    }
    if (this.t > 30) this.alive = false;
  }
}

export class AntiShipMissile {
  constructor(x, y, z, vx, vy, vz, target, ctx) {
    this.x = x; this.y = y; this.z = z; this.vx = vx; this.vy = vy; this.vz = vz;
    this.target = target; this.ctx = ctx; this.alive = true; this.t = 0;
    const ax = (Math.random() - 0.5) * 0.7 * 333, az = (Math.random() - 0.5) * 0.7 * 70;
    this.aimAlong = ax; this.aimAcross = az;
    this.trailT = 0;
  }
  // v1.3.0: intercepted by CIWS/SAM — geyser splash, no damage dealt.
  splash() {
    if (!this.alive) return;
    this.alive = false;
    const seaH = this.ctx.sea.waveHeight(this.x, this.z, this.ctx.time);
    this.ctx.vfx.splash(this.x, Math.max(seaH, this.y), this.z, 12);
  }
  update(dt) {
    if (!this.alive) return;
    this.t += dt;
    const tgt = this.target;
    if (!tgt || tgt.state === 'gone') { this.alive = false; return; }
    // Lead 0.5 s, aim point recomputed every frame on the target's
    // CURRENT heading (the ASM aim logic was sound in Hurricane — keep it).
    const fx = Math.sin(tgt.heading), fz = -Math.cos(tgt.heading);
    const rx = Math.cos(tgt.heading), rz = Math.sin(tgt.heading);
    const px = tgt.x + tgt.vx * 0.5 + fx * this.aimAlong + rx * this.aimAcross;
    const pz = tgt.z + tgt.vz * 0.5 + fz * this.aimAlong + rz * this.aimAcross;
    const py = tgt.y;
    const dx = px - this.x, dy = py - this.y, dz = pz - this.z;
    const d = Math.hypot(dx, dy, dz) || 0.001;
    // Turn authority 2.5 rad/s toward the aim point.
    const sp = MISSILE_SPEED;
    const ux = dx / d, uy = dy / d, uz = dz / d;
    const cvx = this.vx / sp, cvy = this.vy / sp, cvz = this.vz / sp;
    const ang = Math.acos(clamp(cvx * ux + cvy * uy + cvz * uz, -1, 1));
    const maxTurn = 2.5 * dt;
    const k = ang > 1e-6 ? Math.min(1, maxTurn / ang) : 1;
    const nx = cvx + (ux - cvx) * k, ny = cvy + (uy - cvy) * k, nz = cvz + (uz - cvz) * k;
    const nl = Math.hypot(nx, ny, nz) || 1;
    this.vx = nx / nl * sp; this.vy = ny / nl * sp; this.vz = nz / nl * sp;
    this.x += this.vx * dt; this.y += this.vy * dt; this.z += this.vz * dt;
    this.trailT -= dt;
    if (this.trailT <= 0) {
      this.trailT = 0.05;
      this.ctx.vfx.spawnParticle(this.x, this.y, this.z, 0, 0, 0, 0.5, 1, 0.8, 0.5, 0);
    }
    if (d < 18) {
      const l = tgt.localFromWorld(this.x, this.z);
      tgt.damage(MISSILE_DMG, l.lx, l.lz, true, this.ctx);
      this.alive = false; return;
    }
    if (this.t > 30 || d > 9000) {
      const seaH = this.ctx.sea.waveHeight(this.x, this.z, this.ctx.time);
      this.ctx.vfx.splash(this.x, seaH, this.z, 8);
      this.alive = false;
    }
  }
}

// ---------------- Jets ----------------
let _jetSeq = 0;
export class FighterJet {
  constructor(wing, template) {
    this.id = ++_jetSeq;
    this.wing = wing;
    this.group = template.group.clone(true);
    this.x = 0; this.y = 0; this.z = 0; this.vx = 0; this.vy = 0; this.vz = 0;
    this.heading = 0; this.pitch = 0; this.roll = 0; this.speed = 0;
    this.stalled = false; this.stallSide = 1; this.omegaSm = 0; this.turnSide = 1;
    this.state = 'deck';
    this.ordnance = 2; this.hp = 100;
    // v1.3.0 (B) per-zone jet damage (Pandora DamageZones /
    // DamageableEntity pattern): wing hits x1.2, engine hits x1.5.
    // Zone HP is set so one SAM (55) cannot one-shot a zone: wing
    // 80 (55*1.2=66), engine 90 (55*1.5=82), fuel 50 (a SAM fuel hit
    // starts a fire instead of killing outright). Dying rule: lose a
    // wing, lose both engines, or lose all HP -> spin-out fall.
    this.zones = {
      wingL: { hp: 80, max: 80 }, wingR: { hp: 80, max: 80 },
      engineL: { hp: 90, max: 90 }, engineR: { hp: 90, max: 90 },
      fuselage: { hp: 100, max: 100 }, fuel: { hp: 50, max: 50 },
    };
    this.zoneMult = { wingL: 1.2, wingR: 1.2, engineL: 1.5, engineR: 1.5, fuselage: 1, fuel: 1 };
    this.fire = null; // {zone, intensity, t, spreadT}
    this.spinOut = false; this.spinRate = 0; this.spinT = 0;
    this.defensiveT = 0; this.defSide = 1; this.flareT = 0;
    this.rollBias = 0; this.speedMul = 1; this.turnMul = 1;
    this.deckLocal = null; // {lx,lz} — deck coupling (J): jets parked /
    // taxiing / rearming ride the carrier's deck when she climbs/descends
    this.formOffset = { x: 0, z: 0 };
    this.aimPoint = { x: 0, y: 0, z: 0 };
    this.diveT = 0; this.fired = false; this.catT = 0; this.parkSpot = 0;
    this.rolloutV = 0; this.rolloutZ = 0; this.patLeg = 0;
    this.group.visible = false;
  }
  placeOnDeck(carrier, lx, lz) {
    const p = carrier.deckPoint(lx, lz);
    this.deckLocal = { lx, lz, carrier };
    this.x = p.x; this.y = p.y + 2.4; this.z = p.z;
    this.heading = carrier.heading; this.pitch = carrier.pitch; this.roll = carrier.roll;
    this.vx = carrier.vx; this.vy = 0; this.vz = carrier.vz;
    this.group.visible = true;
    this.syncModel();
  }
  // v1.3.0 (J) deck coupling: a jet sitting on the deck rides it. Called
  // from update() for deck/taxi/rearm jets — the carrier's climb/descent
  // and motion carry the jet, so it never clips through a moving deck.
  rideDeck() {
    const d = this.deckLocal;
    if (!d || !d.carrier || !d.carrier.alive) return;
    const p = d.carrier.deckPoint(d.lx, d.lz);
    this.x = p.x; this.y = p.y + 2.4; this.z = p.z;
    this.heading = d.carrier.heading; this.pitch = d.carrier.pitch; this.roll = d.carrier.roll;
    this.vx = d.carrier.vx; this.vy = d.carrier.vy || 0; this.vz = d.carrier.vz;
  }
  // v1.3.0 (B): apply damage to one jet zone. Returns 'lost' (zone just
  // destroyed), 'spinout' (dying rule met), 'fire' (fuel ignited) or null.
  damageZone(amount, zoneKey, source, ctx) {
    if (this.state === 'crashed' || this.state === 'sinking' || this.state === 'spinout') return null;
    const z = this.zones[zoneKey] || this.zones.fuselage;
    const key = this.zones[zoneKey] ? zoneKey : 'fuselage';
    const mult = this.zoneMult[key] || 1;
    const before = z.hp;
    z.hp = Math.max(0, z.hp - amount * mult);
    this._syncZoneEffects();
    let out = null;
    if (before > 0 && z.hp <= 0) {
      out = 'lost';
      if (ctx && ctx.msg && this.wing) ctx.msg(`✈ ${this.wing.side === 'player' ? 'Your' : 'Enemy'} jet: ${key} destroyed (${source || 'hit'})`);
      if (key === 'fuel') { this.ignite(key, ctx); out = 'fire'; }
    }
    if (key === 'fuel' && z.hp <= 0 && !this.fire) this.ignite(key, ctx);
    // Dying rule: a wing, both engines, or all HP.
    const wingLost = this.zones.wingL.hp <= 0 || this.zones.wingR.hp <= 0;
    const bothEngines = this.zones.engineL.hp <= 0 && this.zones.engineR.hp <= 0;
    const total = Object.values(this.zones).reduce((a, zz) => a + zz.hp, 0);
    if (wingLost || bothEngines || total <= 0) {
      this.startSpinOut(ctx, `${key} destroyed by ${source || 'damage'}`);
      return 'spinout';
    }
    return out;
  }
  _syncZoneEffects() {
    // Roll bias toward the dead wing, lift/speed/turn penalties.
    const wingL = this.zones.wingL.hp <= 0, wingR = this.zones.wingR.hp <= 0;
    this.rollBias = (wingL ? 0.35 : 0) + (wingR ? -0.35 : 0);
    const engLost = (this.zones.engineL.hp <= 0 ? 1 : 0) + (this.zones.engineR.hp <= 0 ? 1 : 0);
    const wingDmg = (1 - this.zones.wingL.hp / 80) + (1 - this.zones.wingR.hp / 80);
    this.speedMul = Math.max(0.55, 1 - 0.22 * engLost - 0.08 * wingDmg);
    this.turnMul = Math.max(0.6, 1 - 0.18 * engLost);
    const total = Object.values(this.zones).reduce((a, z) => a + z.hp, 0);
    const max = Object.values(this.zones).reduce((a, z) => a + z.max, 0);
    this.hp = total / max * 100;
  }
  ignite(zoneKey, ctx) {
    if (this.fire) return;
    this.fire = { zone: zoneKey, intensity: 0.3, t: 0, spreadT: 0 };
    if (ctx && ctx.msg && this.wing) ctx.msg(`✈ ${this.wing.side === 'player' ? 'Your' : 'Enemy'} jet on FIRE — ${zoneKey}`);
  }
  // v1.3.0 (B): spin-out fall instead of vanishing. Yaw-rate spin,
  // nose-down bias, lift scale ~0.15 — the jet tumbles down and only
  // becomes a crash when it reaches the sea (update()).
  startSpinOut(ctx, reason) {
    if (this.state === 'crashed' || this.state === 'sinking' || this.state === 'spinout') return;
    this.state = 'spinout';
    this.spinOut = true;
    this.spinT = 0;
    this.spinRate = (Math.random() < 0.5 ? -1 : 1) * (1.5 + Math.random());
    this.spinReason = reason;
    if (ctx && ctx.vfx) ctx.vfx.burst(this.x, this.y, this.z, 20, [1, 0.6, 0.2], 6, 3);
    if (ctx && ctx.msg && this.wing) ctx.msg(`✈ ${this.wing.side === 'player' ? 'Your' : 'Enemy'} jet spinning out — ${reason}`);
  }
  // v1.3.0 (A): SAM-evasion flare dump (Hurricane v11.45 F5). Bright
  // decoy particles behind the jet; the SAM checks flareT in flight.
  dumpFlares(ctx) {
    this.flareT = 2.0;
    if (!ctx || !ctx.vfx) return;
    for (let i = 0; i < 12; i++) {
      ctx.vfx.spawnParticle(this.x + (Math.random() - 0.5) * 10, this.y - 2, this.z + (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 8, -6 - Math.random() * 6, (Math.random() - 0.5) * 8, 1.2, 1, 0.8, 0.2, 0);
    }
  }
  syncModel() {
    this.group.position.set(this.x, this.y, this.z);
    this.group.rotation.set(this.pitch, -this.heading, this.roll);
  }
  crash(reason, ctx) {
    if (this.state === 'crashed' || this.state === 'sinking') return;
    this.state = 'crashed';
    this.crashT = 0;
    this.crashReason = reason;
    ctx.vfx.burst(this.x, this.y, this.z, 30, [1, 0.6, 0.2], 8, 4);
    if (this.wing) this.wing.onJetLost(this);
    // (c) A lost jet is announced, never silent: the HUD message names
    // the loss and the wing's remaining strength, so the player always
    // knows a jet went down and what it cost.
    if (ctx.msg && this.wing) ctx.msg(`✈ ${this.wing.side === 'player' ? 'Your' : 'Enemy'} jet lost — ${reason} (${this.wing.remaining} jets left in wing)`);
  }
  update(dt, ctx) {
    if (this.defensiveT > 0) this.defensiveT -= dt;
    if (this.flareT > 0) this.flareT -= dt;
    // v1.3.0 (B) fire state machine: intensity ramps, spreads to an
    // adjacent zone after ~8 s, can be blown out by high airspeed
    // (>175 m/s airflow) or — for an engine fire — by cutting throttle
    // (slow flight, speed < 100 m/s, throttle back).
    if (this.fire && this.state !== 'crashed' && this.state !== 'sinking') {
      const f = this.fire;
      f.t += dt; f.spreadT += dt;
      f.intensity = Math.min(1, f.intensity + dt * 0.08);
      const spd = Math.hypot(this.vx, this.vy, this.vz);
      if (spd > 175) f.intensity -= dt * 0.15; // blown out by airflow
      if (f.zone.startsWith('engine') && spd < 100) f.intensity -= dt * 0.10; // throttle cut
      if (f.intensity <= 0) { this.fire = null; }
      else {
        const z = this.zones[f.zone];
        if (z) {
          z.hp = Math.max(0, z.hp - f.intensity * 2.0 * dt);
          this._syncZoneEffects();
          const wingLost = this.zones.wingL.hp <= 0 || this.zones.wingR.hp <= 0;
          const bothEngines = this.zones.engineL.hp <= 0 && this.zones.engineR.hp <= 0;
          if (wingLost || bothEngines) this.startSpinOut(ctx, 'fire burned through ' + f.zone);
        }
        if (Math.random() < dt * 12) ctx.vfx.spawnParticle(this.x, this.y, this.z, 0, 1, 0, 0.8, 1, 0.5, 0.1, -0.5);
        if (Math.random() < dt * 8) ctx.vfx.spawnParticle(this.x, this.y, this.z, 0, 1, 0, 1.2, 0.15, 0.15, 0.15, 0.5);
        if (f.spreadT > 8) {
          f.spreadT = 0;
          const adj = { fuel: 'fuselage', fuselage: 'engineL', engineL: 'wingL', engineR: 'wingR', wingL: 'fuselage', wingR: 'fuselage' };
          const next = adj[f.zone];
          if (next && this.zones[next].hp > 0) {
            this.fire = { zone: next, intensity: 0.3, t: 0, spreadT: 0 };
            if (ctx.msg && this.wing) ctx.msg(`✈ ${this.wing.side === 'player' ? 'Your' : 'Enemy'} jet fire spread to ${next}`);
          }
        }
      }
    }
    // v1.3.0 (B) spin-out fall: yaw-rate spin, nose-down bias, lift
    // scale ~0.15 (gravity wins, the jet falls). Ends as a crash at the sea.
    if (this.state === 'spinout') {
      this.spinT += dt;
      this.heading += this.spinRate * dt;
      this.roll += this.spinRate * 0.8 * dt;
      this.pitch += (-0.55 - this.pitch) * Math.min(1, dt * 2);
      this.vy -= 9.81 * (1 - 0.15) * dt;
      this.vx *= (1 - dt * 0.1); this.vz *= (1 - dt * 0.1);
      this.x += this.vx * dt; this.y += this.vy * dt; this.z += this.vz * dt;
      if (Math.random() < dt * 10) ctx.vfx.spawnParticle(this.x, this.y, this.z, 0, 0, 0, 0.7, 1, 0.5, 0.1, 0);
      const seaH = ctx.sea.waveHeight(this.x, this.z, ctx.time);
      if (this.y <= seaH) {
        this.state = 'crashed'; this.crashT = 0;
        this.crashReason = this.spinReason || 'spun out';
        ctx.vfx.burst(this.x, this.y, this.z, 30, [1, 0.6, 0.2], 8, 4);
        ctx.vfx.splash(this.x, seaH, this.z, Math.abs(this.vy));
        this.group.visible = false;
        if (this.wing) this.wing.onJetLost(this);
        if (ctx.msg && this.wing) ctx.msg(`✈ ${this.wing.side === 'player' ? 'Your' : 'Enemy'} jet lost — ${this.crashReason} (${this.wing.remaining} jets left in wing)`);
      }
      this.syncModel();
      return;
    }
    if (this.state === 'crashed') {
      this.crashT += dt;
      this.vy -= 9.81 * dt * 0.5;
      this.x += this.vx * dt; this.y += this.vy * dt; this.z += this.vz * dt;
      this.roll += dt * 2;
      if (Math.random() < dt * 8) ctx.vfx.spawnParticle(this.x, this.y, this.z, 0, 0, 0, 0.7, 1, 0.5, 0.1, 0);
      const seaH = ctx.sea.waveHeight(this.x, this.z, ctx.time);
      if (this.y <= seaH) {
        this.state = 'sinking';
        ctx.vfx.splash(this.x, seaH, this.z, Math.abs(this.vy));
        this.group.visible = false;
      }
      this.syncModel();
      return;
    }
    if (this.state === 'sinking' || this.state === 'deck' || this.state === 'rearm') {
      // v1.3.0 (J): parked / rearming jets ride the deck.
      if (this.state !== 'sinking') this.rideDeck();
      this.syncModel(); return;
    }
    // v1.3.0 (J): taxiing jets ride the deck too.
    if (this.state === 'taxi') this.rideDeck();
    // Damaged-jet FX
    if (this.hp < 50 && Math.random() < dt * 10) {
      ctx.vfx.spawnParticle(this.x, this.y, this.z, 0, 1, 0, 1.2, 0.15, 0.15, 0.15, 0.5);
    }
    if (this.hp < 25 && Math.random() < dt * 10) {
      ctx.vfx.spawnParticle(this.x, this.y, this.z, 0, 1, 0, 0.6, 1, 0.5, 0.1, -0.5);
    }
    this.syncModel();
  }
}

const CATAPULTS = [{ x: -6, z0: 110, z1: -110 }, { x: 6, z0: 110, z1: -110 }];
const WIRE = { x: -8, z: 120 };
// CATAPULT_CLEAR_S — catapult/climb-out reservation, game seconds. A
// launch reserves the wing's catapults until the flight is clear of the
// deck and climb-out (stroke ~6 s + climb to deck+60 m ~4 s, plus margin).
// A second launch inside this window is QUEUED, never fired on top of
// the first flight: two squadrons on the same tracks with identical
// timing sat on the identical climb point and died to the 10 m mid-air
// rule, deterministically, on a double-click.
const CATAPULT_CLEAR_S = 12;

export class AirSquadron {
  constructor(wing, id) {
    this.wing = wing; this.id = id;
    this.state = 'deckReady';
    this.jets = [new FighterJet(wing, wing.jetTemplate), new FighterJet(wing, wing.jetTemplate)];
    this.jets[0].formOffset = { x: 0, z: 0 };
    this.jets[1].formOffset = { x: 60, z: -40 }; // echelon right and behind (metric)
    this.target = null; this.loadout = 'bomb';
    this.t = 0; this.attackPhase = 'popup'; this.diveT = 0;
    this.patLeg = 0; this.rearmT = 0; this.waypoint = null;
    this.queuedLoadout = null; this.queuedTarget = null; // launchQueued state
  }
  get leader() { return this.jets[0]; }
  get wingman() { return this.jets[1]; }
  get homeCarrier() { return this.wing.carrier; }
  get aliveJets() { return this.jets.filter(j => j.state !== 'crashed' && j.state !== 'sinking' && j.state !== 'spinout'); }

  launch(loadout, target, ctx) {
    if (this.state !== 'deckReady' && this.state !== 'launchQueued') return false;
    const carrier = this.homeCarrier;
    if (!carrier || !carrier.alive || !carrier.canLaunch) return false;
    if (!target || target.state === 'gone') return false;
    const avail = this.wing.availableToLaunch();
    if (avail <= 0) return false;
    const n = Math.min(2, avail);
    this.loadout = loadout; this.target = target;
    this.queuedLoadout = null; this.queuedTarget = null;
    this.state = 'catapult'; this.t = 0; this.diveT = 0; this.attackPhase = 'popup';
    // Reserve the catapult / climb-out for CATAPULT_CLEAR_S: no other
    // squadron of this wing launches until this flight is clear
    // (enforced in AirWing.launch).
    this.wing.catapultClearAt = ctx.time + CATAPULT_CLEAR_S;
    for (let i = 0; i < this.jets.length; i++) {
      let j = this.jets[i];
      if (i >= n) {
        // A jet NOT flying this sortie stays as it is. A dead jet is
        // never silently reset to 'deck' here — that was a resurrection.
        if (j.state !== 'crashed' && j.state !== 'sinking') { j.state = 'deck'; j.group.visible = false; }
        continue;
      }
      if (j.state === 'crashed' || j.state === 'sinking') {
        // Honest accounting (c): a crashed jet is dead. Its slot is
        // refilled from the wing pool (remaining was already decremented
        // at the crash) with a FRESH jet object; the wreck is gone,
        // not revived.
        ctx.scene.remove(j.group);
        j = new FighterJet(this.wing, this.wing.jetTemplate);
        this.jets[i] = j;
      }
      j.formOffset = i === 0 ? { x: 0, z: 0 } : { x: 60, z: -40 };
      j.state = 'catapult'; j.catT = i === 0 ? 0 : -1; // wingman fires 1 s later
      j.ordnance = 2; j.hp = 100; j.fired = false; j.stalled = false;
      // v1.3.0 (B): a fresh sortie starts with fresh zones — a jet that
      // trapped with damage is repaired on rearm; a refilled slot is a
      // new jet object with fresh zones already.
      for (const k in j.zones) j.zones[k].hp = j.zones[k].max;
      j.fire = null; j.spinOut = false; j.spinT = 0;
      j.defensiveT = 0; j.flareT = 0; j.rollBias = 0; j.speedMul = 1; j.turnMul = 1;
      j._syncZoneEffects();
      j.parkSpot = i;
      j.placeOnDeck(carrier, CATAPULTS[i].x, CATAPULTS[i].z0);
      j.group.visible = true;
      ctx.scene.add(j.group);
    }
    if (ctx.audio) ctx.audio.whoosh();
    return true;
  }
  // (d) Hold a launch until the catapult is clear. The squadron waits in
  // 'launchQueued'; AirWing.update fires it once catapultClearAt passes.
  queueLaunch(loadout, target) {
    this.loadout = loadout; this.target = target;
    this.queuedLoadout = loadout; this.queuedTarget = target;
    this.state = 'launchQueued'; this.t = 0;
  }
  recall() {
    if (this.state === 'launchQueued') {
      this.state = 'deckReady'; this.queuedLoadout = null; this.queuedTarget = null;
      return;
    }
    if (['deckReady', 'rearm'].includes(this.state)) return;
    this.state = 'rtb'; this.t = 0; this.patLeg = 0;
  }
  // Dive aim, recomputed EVERY FRAME for both jets (the wingman fix):
  // 0.5 s target lead, release point 100 m out / 60 m above the deck on a
  // 30 deg line through the target. Same numbers for leader and wingman.
  diveAimPoint(jet, ctx) {
    const tgt = this.target;
    const tx = tgt.x + tgt.vx * 0.5, tz = tgt.z + tgt.vz * 0.5;
    const dx = tx - jet.x, dz = tz - jet.z;
    const d = Math.hypot(dx, dz) || 0.001;
    const ux = dx / d, uz = dz / d;
    const deckY = tgt.deckTopY();
    return {
      x: tx - ux * BOMB_RELEASE_DIST,
      y: deckY + BOMB_RELEASE_ALT,
      z: tz - uz * BOMB_RELEASE_DIST,
      deckY, horizDist: d,
    };
  }
  update(dt, ctx) {
    // v1.3.0 (B): a spinning-out jet is as dead as a crashed one for
    // sortie purposes — the wingman takes the lead, and a squadron with
    // no live jets aborts. Spin-out jets are never steered.
    const _down = j => j.state === 'crashed' || j.state === 'sinking' || j.state === 'spinout';
    if (_down(this.leader) &&
        ! _down(this.wingman)) {
      this.jets.reverse();
    }
    // No ghost sorties (b): a squadron with no live jets aborts to a
    // failed-sortie state instead of flying attack -> egress -> rtb ->
    // trap -> rearm as if it had flown. 'lost' waits for the wrecks to
    // reach the sea, then the squadron stands down to deckReady with its
    // losses already recorded (remaining was decremented at each crash).
    if (this.state !== 'deckReady' && this.state !== 'launchQueued' && this.state !== 'lost' && this.aliveJets.length === 0) {
      this.state = 'lost'; this.t = 0; this.target = null;
      if (ctx.msg) ctx.msg(`✈ ${this.wing.side === 'player' ? 'Your' : 'Enemy'} flight lost — all jets down (${this.wing.carrier.name})`);
    }
    const carrier = this.homeCarrier;
    const L = this.leader, W = this.wingman;
    const seaH = ctx.sea.waveHeight(L.x, L.z, ctx.time);
    const deckY = carrier && carrier.alive ? carrier.deckTopY() : seaH;
    const tgt = this.target;
    const tgtAlive = tgt && tgt.state !== 'gone' && tgt.state !== 'sinking';
    switch (this.state) {
      case 'launchQueued': {
        this.t += dt;
        // Safety valve: a queue that never fires (carrier/target died
        // and AirWing.update missed it) stands down instead of waiting
        // forever.
        if (this.t > 120) { this.state = 'deckReady'; this.queuedLoadout = null; this.queuedTarget = null; }
        break;
      }
      case 'lost': {
        this.t += dt;
        // Stand down once every wreck is in the sea (group hidden), or
        // on timeout — the jets stay dead; fresh ones are drawn from the
        // wing pool at the next launch.
        if (this.jets.every(j => j.state === 'sinking') || this.t > 15) {
          this.state = 'deckReady'; this.t = 0;
        }
        break;
      }
      case 'catapult': {
        this.t += dt;
        let allClimbing = true;
        this.jets.forEach((j, i) => {
          if (j.state !== 'catapult') return;
          if (j.catT < 0) { j.catT += dt; if (j.catT < 0) { allClimbing = false; return; } j.catT = 0; }
          j.catT += dt;
          const a = JET_CATAPULT_SPEED * JET_CATAPULT_SPEED / (2 * 220);
          const along = Math.min(220, 0.5 * a * j.catT * j.catT);
          const spd = Math.min(JET_CATAPULT_SPEED, a * j.catT);
          const p = carrier.deckPoint(CATAPULTS[i].x, CATAPULTS[i].z0 - along);
          j.x = p.x; j.y = p.y + 2.4; j.z = p.z;
          j.heading = carrier.heading;
          const fx = Math.sin(j.heading), fz = -Math.cos(j.heading);
          j.vx = fx * spd; j.vz = fz * spd; j.vy = 0;
          j.speed = spd;
          if (Math.random() < dt * 8) ctx.vfx.spawnParticle(j.x, j.y - 1, j.z, 0, 1, 0, 0.8, 0.9, 0.9, 0.9, 0.5);
          if (along >= 220 || j.catT >= 6) {
            j.state = 'climb'; j.vy = 12; j.pitch = 0.35;
          } else allClimbing = false;
        });
        if (allClimbing) { this.state = 'climb'; this.t = 0; }
        break;
      }
      case 'climb': {
        this.t += dt;
        // Climb-out lane (a): each squadron climbs out on its own
        // lateral lane and altitude, so two flights can never sit on the
        // identical climb point even if their timing ever coincides.
        const laneX = this.id === 1 ? -120 : 120;
        const aim = carrier.deckPoint(laneX, -160);
        aim.y = deckY + 120 + (this.id - 1) * 60;
        L.turnSide = 1;
        steerJetTo(L, aim, 120, JET_CRUISE_SPEED, dt, { flight: true, seaH });
        this._formFly(W, L, dt, ctx, JET_CRUISE_SPEED, seaH);
        if (L.y > deckY + 60 || this.t > 20) { this.state = 'ingress'; this.t = 0; }
        break;
      }
      case 'ingress': {
        this.t += dt;
        if (!tgtAlive) { this.state = 'rtb'; this.t = 0; this.patLeg = 0; break; }
        const dx = tgt.x - L.x, dz = tgt.z - L.z;
        const d = Math.hypot(dx, dz);
        const ux = dx / d, uz = dz / d;
        if (this.loadout === 'asm') {
          const ax = tgt.x - ux * 800, az = tgt.z - uz * 800;
          steerJetTo(L, { x: ax, y: tgt.deckTopY() + 150, z: az }, 150, JET_CRUISE_SPEED, dt, { flight: true, seaH });
          this._formFly(W, L, dt, ctx, JET_CRUISE_SPEED, seaH);
          if (d < 1000) { this.state = 'attack'; this.t = 0; }
        } else {
          const ax = tgt.x - ux * 500, az = tgt.z - uz * 500;
          steerJetTo(L, { x: ax, y: tgt.deckTopY() + 60, z: az }, 120, JET_CRUISE_SPEED, dt, { flight: true, seaH });
          this._formFly(W, L, dt, ctx, JET_CRUISE_SPEED, seaH);
          if (d < 600) { this.state = 'attack'; this.t = 0; this.attackPhase = 'popup'; this.diveT = 0; }
        }
        if (this.t > 120) { this.state = 'rtb'; this.t = 0; this.patLeg = 0; }
        break;
      }
      case 'attack': {
        this.t += dt;
        if (!tgtAlive) { this.state = 'egress'; this.t = 0; break; }
        if (this.loadout === 'asm') {
          const dx = tgt.x - L.x, dz = tgt.z - L.z;
          const d = Math.hypot(dx, dz);
          const ux = dx / d, uz = dz / d;
          const hold = { x: tgt.x - ux * 800, y: tgt.deckTopY() + 150, z: tgt.z - uz * 800 };
          steerJetTo(L, hold, 150, JET_ATTACK_SPEED, dt, { flight: true, seaH, attack: true });
          this._formFly(W, L, dt, ctx, JET_ATTACK_SPEED, seaH);
          if (d < 1000 && !L.fired) {
            for (const j of this.aliveJets) {
              if (j.ordnance <= 0) continue;
              ctx.missiles.push(new AntiShipMissile(j.x, j.y, j.z, j.vx, j.vy, j.vz, tgt, ctx));
              j.ordnance = 0; j.fired = true;
            }
          }
          if ((this.aliveJets.length > 0 && this.aliveJets.every(j => j.ordnance <= 0)) || this.t > 15) { this.state = 'egress'; this.t = 0; }
          break;
        }
        // Bomb attack: popup -> dive -> pullout. Both jets use the same
        // per-frame dive aim and the same release gate.
        if (this.attackPhase === 'popup') {
          const dx = tgt.x - L.x, dz = tgt.z - L.z;
          const d = Math.hypot(dx, dz) || 0.001;
          const ux = dx / d, uz = dz / d;
          const aim = { x: L.x + ux * 150, y: tgt.deckTopY() + 180, z: L.z + uz * 150 };
          steerJetTo(L, aim, 100, JET_CRUISE_SPEED, dt, { flight: true, seaH, attack: true });
          this._formFly(W, L, dt, ctx, JET_CRUISE_SPEED, seaH);
          if (L.y > tgt.deckTopY() + 150 || this.t > 6) { this.attackPhase = 'dive'; this.diveT = 0; }
        } else if (this.attackPhase === 'dive') {
          this.diveT += dt;
          // Leader dives at once; wingman 1.5 s later (time stagger only).
          const diveJets = this.aliveJets.filter(j => j === L || this.diveT >= 1.5);
          for (const j of this.aliveJets) {
            if (diveJets.includes(j)) {
              const aim = this.diveAimPoint(j, ctx);
              steerJetTo(j, aim, 60, JET_DIVE_SPEED, dt, { flight: true, seaH, attack: true, dive: true });
              // Release gate — identical for both jets. Predicted-impact
              // gate (v1 fix): release only when the bomb, if dropped
              // now, would land on the target deck. The old gate checked
              // position only (hd, height, roll) and never whether the
              // velocity pointed at the target, so jets still turning
              // onto the dive — or flying away after overshooting the
              // release point — dropped into the sea. A pure
              // velocity-alignment gate proved too strict in live testing
              // (the jet banks and turns while passing the small release
              // window, so align + pitch + roll rarely coincide even on
              // a good dive, and the wingman almost never qualified).
              // The impact prediction subsumes all of it: integrate the
              // exact AirBomb ballistics (vy -= 9.81 dt, no drag) to the
              // target deck level, lead the target by the fall time, and
              // require the impact inside the deck footprint, with
              // margin for the +/-3 m spawn offset and target motion
              // (|lx| < 34 vs the 40.8 hit bound, |lz| < 150 vs 157.7).
              // Roll is irrelevant — the bomb inherits velocity only.
              // Checked against the TARGET: past the release point the
              // recomputed aim point sits behind the jet, so an
              // aim-point check would also block the legitimate second
              // bomb on the same pass.
              const deckY2 = tgt.deckTopY();
              const dy = j.y - deckY2;
              let impactOnDeck = false;
              if (dy > 5 && j.vy < -5) {
                const tFall = (j.vy + Math.sqrt(j.vy * j.vy + 19.62 * dy)) / 9.81;
                if (tFall > 0) {
                  const ix = j.x + j.vx * tFall, iz = j.z + j.vz * tFall;
                  const tx = tgt.x + tgt.vx * tFall, tz = tgt.z + tgt.vz * tFall;
                  const dx = ix - tx, dz = iz - tz;
                  const h = tgt.heading;
                  const lx = dx * Math.cos(h) + dz * Math.sin(h);
                  const lz = -dx * Math.sin(h) + dz * Math.cos(h);
                  impactOnDeck = Math.abs(lx) < 34 && Math.abs(lz) < 150;
                }
              }
              const hd = Math.hypot(tgt.x - j.x, tgt.z - j.z);
              if (!j.fired && j.ordnance > 0 && impactOnDeck && hd <= 300) {
                j.fired = true; j.ordnance -= 1;
                const err = this.wing.skill ? this.wing.skill.aimErr : 3;
                const ex = (Math.random() - 0.5) * 2 * err, ez = (Math.random() - 0.5) * 2 * err;
                ctx.bombs.push(new AirBomb(j.x + ex, j.y, j.z + ez, j.vx, j.vy, j.vz, tgt, ctx, this.wing.side + '/' + (j === L ? 'leader' : 'wingman')));
                if (j.ordnance > 0) { /* second bomb next pass */ j.fired = false; }
              }
            } else {
              // Wingman holds on the echelon slot until its dive starts.
              this._formFly(j, L, dt, ctx, JET_CRUISE_SPEED, seaH);
            }
          }
          if (this.diveT > 3.5 || (this.aliveJets.length > 0 && this.aliveJets.every(j => j.ordnance <= 0))) { this.attackPhase = 'pullout'; this.t = 0; }
          if (this.diveT > 20) { this.attackPhase = 'pullout'; this.t = 0; }
        } else { // pullout
          const dx = tgt.x - L.x, dz = tgt.z - L.z;
          const d = Math.hypot(dx, dz) || 0.001;
          const ux = dx / d, uz = dz / d;
          const aim = { x: tgt.x + ux * 600, y: tgt.deckTopY() + 200, z: tgt.z + uz * 600 };
          steerJetTo(L, aim, 100, JET_ATTACK_SPEED, dt, { flight: true, seaH, pullout: true, attack: true });
          this._formFly(W, L, dt, ctx, JET_ATTACK_SPEED, seaH);
          if (Math.random() < dt * 6) for (let i = 0; i < 3; i++) ctx.vfx.spawnParticle(L.x, L.y, L.z, (Math.random() - 0.5) * 6, -2, (Math.random() - 0.5) * 6, 0.5, 1, 0.6, 0.2, 0);
          if (this.t > 3) { this.state = 'egress'; this.t = 0; }
        }
        break;
      }
      case 'egress': {
        this.t += dt;
        if (tgtAlive) {
          const dx = L.x - tgt.x, dz = L.z - tgt.z;
          const d = Math.hypot(dx, dz) || 0.001;
          steerJetTo(L, { x: tgt.x + dx / d * 800, y: tgt.deckTopY() + 200, z: tgt.z + dz / d * 800 }, 150, JET_CRUISE_SPEED, dt, { flight: true, seaH });
        } else {
          steerJetTo(L, { x: L.x + 500, y: deckY + 150, z: L.z }, 150, JET_CRUISE_SPEED, dt, { flight: true, seaH });
        }
        this._formFly(W, L, dt, ctx, JET_CRUISE_SPEED, seaH);
        if (this.t > 8 || !tgtAlive) { this.state = 'rtb'; this.t = 0; this.patLeg = 0; }
        break;
      }
      case 'rtb': {
        this.t += dt;
        if (!carrier || !carrier.alive) {
          // Re-home to another live carrier of the same side, else divert.
          const other = this.wing.findOtherCarrier();
          if (other) { this.wing.rehomeTo(other, ctx); break; }
          this.state = 'divert'; this.t = 0; break;
        }
        // Per-squadron pattern offset: squadrons of one wing must not
        // fly the identical rtb legs to the same carrier, or their jets
        // converge on the same points and die to the mid-air rule (seen
        // in 2v2 runs: two wingmen collided in rtb, and two leaders +
        // two wingmen collided on the shared trap final). The offset is
        // per squadron index within the wing, so it stays unique even
        // after rehoming moves squadrons between wings.
        const rtbIdx = this.wing.squadrons.indexOf(this);
        const latOff = (rtbIdx % 2 === 0 ? -1 : 1) * Math.ceil(rtbIdx / 2) * 220;
        const altOff = rtbIdx * 45;
        const legs = [
          { lx: -500, lz: -150, alt: 120 }, { lx: -500, lz: 500, alt: 120 },
          { lx: 150, lz: 600, alt: 100 }, { lx: -8, lz: 350, alt: 60 },
        ];
        const leg = legs[Math.min(this.patLeg, 3)];
        const pt = carrier.deckPoint(leg.lx + latOff, leg.lz);
        pt.y = carrier.deckTopY() + leg.alt + altOff;
        steerJetTo(L, pt, 90, JET_CRUISE_SPEED, dt, { flight: true, seaH });
        this._formFly(W, L, dt, ctx, JET_CRUISE_SPEED, seaH);
        const dP = Math.hypot(pt.x - L.x, pt.y - L.y, pt.z - L.z);
        if (dP < (this.patLeg === 2 ? 120 : 90)) this.patLeg++;
        if (this.patLeg >= 3) {
          const dC = Math.hypot(carrier.x - L.x, carrier.z - L.z);
          if (dC < 700 && !this._trapBusy()) { this.state = 'trap'; this.t = 0; }
        }
        if (this.t > 180 && !this._trapBusy()) { this.state = 'trap'; this.t = 0; }
        break;
      }
      case 'trap': {
        this.t += dt;
        if (!carrier || !carrier.alive) { this.state = 'divert'; this.t = 0; break; }
        // 5.7 deg glide slope, 300 m behind the carrier.
        const back = carrier.deckPoint(0, 300);
        back.y = carrier.deckTopY() + 30;
        const wire = carrier.deckPoint(WIRE.x, WIRE.z);
        wire.y = carrier.deckTopY() + 1;
        const dW = Math.hypot(wire.x - L.x, wire.z - L.z);
        const k = 1 - Math.min(1, dW / 300);
        const aim = {
          x: back.x + (wire.x - back.x) * k,
          y: back.y + (wire.y - back.y) * k,
          z: back.z + (wire.z - back.z) * k,
        };
        steerJetTo(L, aim, 30, JET_TRAP_SPEED, dt, { flight: true, seaH, trap: true });
        this._formFly(W, L, dt, ctx, JET_TRAP_SPEED, seaH);
        if (dW < 12 && Math.abs(L.y - wire.y) < 15) {
          // Caught the wire — but only LIVE jets trap. A crashed jet is
          // dead: it never taxis, never rearms, and is never resurrected
          // by this handler (c).
          this.state = 'taxi'; this.t = 0;
          this.aliveJets.forEach((j, i) => {
            j.state = 'taxi'; j.rolloutV = 28; j.rolloutZ = WIRE.z + i * 25;
            const p = carrier.deckPoint(WIRE.x, j.rolloutZ);
            j.x = p.x; j.y = p.y + 2.4; j.z = p.z; j.heading = carrier.heading; j.vx = 0; j.vy = 0; j.vz = 0;
            j.deckLocal = { lx: WIRE.x, lz: j.rolloutZ, carrier }; // v1.3.0 (J): taxi rides the deck
          });
        } else {
          const l = carrier.localFromWorld(L.x, L.z);
          // Bolter: overshoot PAST the wire toward the bow. Final comes
          // from astern (lz 300 -> 120, wire at 120, bow at -lz), so a
          // missed wire is lz BELOW the wire, not above it. (The old
          // `lz > WIRE.z + 60` was true for the whole approach, so every
          // trap attempt boltered on entry.)
          if (l.lz < WIRE.z - 60) { this.state = 'rtb'; this.t = 0; this.patLeg = 1; } // bolter
        }
        if (this.t > 90) { this.state = 'rtb'; this.t = 0; this.patLeg = 1; }
        break;
      }
      case 'taxi': {
        this.t += dt;
        if (this.t > 2) { this.state = 'rearm'; this.rearmT = 20; }
        break;
      }
      case 'rearm': {
        this.rearmT -= dt;
        this.jets.forEach(j => { if (j.state === 'taxi') j.state = 'rearm'; });
        if (this.rearmT <= 0) {
          this.state = 'deckReady';
          // Only jets that actually trapped come back. A crashed jet
          // stays dead here too — its slot is refilled from the wing
          // pool at the next launch, never silently revived (c).
          this.jets.forEach(j => { if (j.state === 'taxi' || j.state === 'rearm') { j.ordnance = 2; j.hp = 100; j.state = 'deck'; j.group.visible = false; for (const k in j.zones) j.zones[k].hp = j.zones[k].max; j.fire = null; j.spinOut = false; j.rollBias = 0; j.speedMul = 1; j.turnMul = 1; } });
        }
        break;
      }
      case 'divert': {
        this.t += dt;
        const cx = carrier ? carrier.x : L.x, cz = carrier ? carrier.z : L.z;
        const ang = this.t * 0.05;
        // Per-squadron divert circle: two squadrons diverting together
        // would otherwise circle the identical point (same angle, same
        // radius) and converge on the mid-air rule — same family as the
        // rtb/trap fix. Opposite side of the circle + wider radius per
        // squadron index keeps every diverting flight hundreds of metres
        // from the others.
        const dvIdx = this.wing.squadrons.indexOf(this);
        const dvAng = ang + dvIdx * Math.PI;
        const dvR = 400 + dvIdx * 150;
        steerJetTo(L, { x: cx + Math.cos(dvAng) * dvR, y: (carrier ? carrier.deckTopY() : seaH) + 150, z: cz + Math.sin(dvAng) * dvR }, 100, JET_CRUISE_SPEED, dt, { flight: true, seaH });
        this._formFly(W, L, dt, ctx, JET_CRUISE_SPEED, seaH);
        if (this.t > 30) {
          const other = this.wing.findOtherCarrier();
          if (other) this.wing.rehomeTo(other, ctx);
          else this.jets.forEach(j => { if (j.state !== 'crashed') j.crash('ditched — no deck left', ctx); });
        }
        break;
      }
    }
    for (const j of this.jets) j.update(dt, ctx);
  }
  // One squadron on the trap final at a time per wing: the glide slope
  // is a single line to a single wire, and two squadrons on it together
  // converge on the same point. A squadron holds in rtb until the final
  // is free (the trapping squadron always leaves 'trap' within 90 s —
  // catch, bolter, timeout, or 'lost' — so the hold cannot deadlock).
  _trapBusy() {
    return this.wing.squadrons.some(s => s !== this && s.state === 'trap');
  }
  _formFly(wingman, leader, dt, ctx, speed, seaH) {
    if (!wingman || wingman.state === 'crashed' || wingman.state === 'sinking' || wingman.state === 'spinout') return;
    if (wingman.state === 'deck' || wingman.state === 'catapult' || wingman.state === 'taxi' || wingman.state === 'rearm') return;
    const fx = Math.sin(leader.heading), fz = -Math.cos(leader.heading);
    const rx = Math.cos(leader.heading), rz = Math.sin(leader.heading);
    const o = wingman.formOffset;
    const aim = {
      x: leader.x + rx * o.x + fx * o.z,
      y: leader.y,
      z: leader.z + rz * o.x + fz * o.z,
    };
    // Formation separation: the slot swings around the leader whenever
    // the leader turns, and a wingman chasing it can cut the corner
    // straight through the leader's position — inside the 10 m mid-air
    // radius (seen: 12 m in climb, and a leader/wingman trap-phase
    // collision that killed a whole squadron). Inside 60 m of the
    // leader the wingman aims AWAY from the leader instead of at the
    // slot, so the pair can never close to the kill radius. The 60 m
    // trigger leaves margin for one long (0.8 s) step at trap speed.
    const dx = wingman.x - leader.x, dy = wingman.y - leader.y, dz = wingman.z - leader.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 60) {
      const ux = d > 0.01 ? dx / d : rx, uy = d > 0.01 ? dy / d : 0, uz = d > 0.01 ? dz / d : rz;
      const push = 60 - d + 20;
      aim.x = wingman.x + ux * push;
      aim.y = wingman.y + uy * push;
      aim.z = wingman.z + uz * push;
    }
    wingman.turnSide = leader.turnSide;
    steerJetTo(wingman, aim, 60, speed, dt, { flight: true, seaH });
    wingman.state = leader.state;
  }
}

export class AirWing {
  constructor(carrier, jetTemplate, side, skill) {
    this.carrier = carrier;
    this.jetTemplate = jetTemplate;
    this.side = side;
    this.skill = skill || null; // enemy skill tiers only; player wings: null (aimErr 3 m)
    this.remaining = AIR_WING_TOTAL;
    this.squadrons = [new AirSquadron(this, 1), new AirSquadron(this, 2)];
    this.catapultClearAt = 0; // game time until which the catapults are reserved (see launch)
    this.lostLog = []; // {reason, remaining} per jet lost — honest loss accounting
    carrier.wing = this;
  }
  airborneCount() {
    let n = 0;
    for (const s of this.squadrons) for (const j of s.jets) if (['climb', 'ingress', 'attack', 'egress', 'rtb', 'trap', 'divert', 'spinout'].includes(j.state)) n++;
    return n;
  }
  availableToLaunch() { return Math.max(0, this.remaining - this.airborneCount()); }
  launch(loadout, target, ctx) {
    // (d) Catapult guard: while a squadron of this wing is still on its
    // catapult stroke / in the first seconds of climb, a second launch
    // is QUEUED, not fired — the player can no longer kill their own
    // wing by double-clicking Launch. Returns true (launched now),
    // 'queued' (will launch when the catapult clears), or false.
    const now = ctx && typeof ctx.time === 'number' ? ctx.time : 0;
    if (this.squadrons.some(s => s.state === 'launchQueued')) return 'queued';
    const busy = now < this.catapultClearAt;
    for (const s of this.squadrons) {
      if (s.state !== 'deckReady') continue;
      if (busy) { s.queueLaunch(loadout, target); return 'queued'; }
      return s.launch(loadout, target, ctx);
    }
    return false;
  }
  recallAll() { for (const s of this.squadrons) s.recall(); }
  onJetLost(jet) {
    this.remaining = Math.max(0, this.remaining - 1);
    this.lostLog.push({ reason: jet.crashReason || 'lost', remaining: this.remaining });
  }
  findOtherCarrier() {
    if (!this._fleet) return null;
    return this._fleet.find(c => c.side === this.side && c.alive && c !== this.carrier) || null;
  }
  rehomeTo(other, ctx) {
    const sq = this.squadrons.find(s => s.state !== 'deckReady');
    if (!sq) return;
    // Move the squadron's live jets to the other carrier's wing.
    const otherWing = other.wing;
    if (!otherWing) return;
    const aliveN = sq.aliveJets.length;
    otherWing.remaining += aliveN; // may exceed 12 — allowed (Hurricane rule)
    sq.wing = otherWing;
    sq.jets.forEach(j => { j.wing = otherWing; }); // loss accounting follows the jet
    otherWing.squadrons.push(sq);
    this.squadrons = this.squadrons.filter(s => s !== sq);
    sq.state = 'rtb'; sq.t = 0; sq.patLeg = 0;
  }
  handleCarrierFalling(ctx) {
    for (const s of this.squadrons) {
      if (['deckReady', 'rearm', 'taxi', 'catapult', 'launchQueued'].includes(s.state)) {
        // Jets on the deck go down with the ship — through crash(), so
        // the loss is counted in remaining and announced like any other
        // jet loss, not silently dropped.
        s.jets.forEach(j => { if (j.state !== 'crashed' && j.state !== 'sinking') { j.crash('lost with ' + this.carrier.name, ctx); j.vy = -5; j.vx = 0; j.vz = 0; } });
        s.state = 'deckReady';
        s.queuedLoadout = null; s.queuedTarget = null;
      } else if (['rtb', 'trap'].includes(s.state)) {
        s.state = 'divert'; s.t = 0;
      }
    }
  }
  handleCarrierSinking(ctx) { this.handleCarrierFalling(ctx); }
  update(dt, ctx) {
    for (const s of this.squadrons.slice()) s.update(dt, ctx);
    // Fire queued launches once the catapult is clear. If the launch no
    // longer works (carrier/target dead, wing exhausted) the queue is
    // cancelled, never left hanging.
    for (const s of this.squadrons) {
      if (s.state !== 'launchQueued') continue;
      if (ctx.time < this.catapultClearAt) continue;
      const ok = s.launch(s.queuedLoadout, s.queuedTarget, ctx);
      if (!ok) {
        s.state = 'deckReady'; s.queuedLoadout = null; s.queuedTarget = null;
        if (ctx.msg) ctx.msg(`${this.carrier.name}: queued launch cancelled — cannot launch`);
      }
    }
    // Mid-air collisions (Hurricane L7168): flying jets within 10 m crash.
    // Same-squadron pairs are EXEMPT: a leader + wingman fly as one
    // formation (slot 25–150 m), and the leader turns into the wingman's
    // slot at rtb waypoints and in the attack pullout — the leader is
    // steered to fixed waypoints with no awareness of the wingman, so at
    // the sim's dt the pair can tunnel through the reactive 60 m
    // separation in a single frame (measured: 29.7 m → 7.2 m in one
    // 0.2 s step, both dead). A formation collision is a modelling
    // artifact, not a game event the player can control or prevent; the
    // rule still applies to every cross-squadron pair in the wing
    // (cross-wing pairs were never checked — this loop is per wing).
    const flying = [];
    for (const s of this.squadrons) for (const j of s.jets) if (['climb', 'ingress', 'attack', 'egress', 'rtb', 'trap', 'divert'].includes(j.state)) flying.push({ j, s });
    for (let i = 0; i < flying.length; i++) for (let k = i + 1; k < flying.length; k++) {
      const a = flying[i], b = flying[k];
      if (a.s === b.s) continue;
      const aj = a.j, bj = b.j;
      const d2 = (aj.x - bj.x) ** 2 + (aj.y - bj.y) ** 2 + (aj.z - bj.z) ** 2;
      if (d2 < 100) {
        const mx = (aj.x + bj.x) / 2, my = (aj.y + bj.y) / 2, mz = (aj.z + bj.z) / 2;
        ctx.vfx.burst(mx, my, mz, 30, [1, 0.6, 0.2], 8, 4);
        // v1.3.0 (B): collision losses go through the spin-out fall,
        // not an instant vanish.
        aj.startSpinOut(ctx, 'mid-air collision'); bj.startSpinOut(ctx, 'mid-air collision');
      }
    }
  }
}

// ---------------- CCIP bomb-impact predictor (v1.3.0, I) ----------------
// Pure projection math using the SAME ballistics AirBomb integrates
// (vy -= 9.81 dt, no drag): given a jet in its attack dive and a target,
// return the predicted impact point {x, y, z, valid, tFall} on the
// target deck level, leading the target by the fall time. No balance
// change — this only draws where the bomb would land if dropped now.
// Returns valid:false when the jet is climbing or too low to drop.
export function predictBombImpact(jet, target) {
  if (!jet || !target || target.state === 'gone') return { valid: false, x: 0, y: 0, z: 0, tFall: 0 };
  const deckY = target.deckTopY();
  const dy = jet.y - deckY;
  if (dy <= 5 || jet.vy >= -5) return { valid: false, x: jet.x, y: deckY, z: jet.z, tFall: 0 };
  const tFall = (jet.vy + Math.sqrt(jet.vy * jet.vy + 19.62 * dy)) / 9.81;
  if (!(tFall > 0)) return { valid: false, x: jet.x, y: deckY, z: jet.z, tFall: 0 };
  return {
    valid: true,
    x: jet.x + jet.vx * tFall,
    y: deckY,
    z: jet.z + jet.vz * tFall,
    tFall,
  };
}

// ---------------- Bomb ballistics probe ----------------
// Replays the exact live release geometry (dive 190 m/s at 30 deg,
// release 60 m above the target deck, 100 m out) with the real AirBomb
// integration step, 20 drops per jet, target moving at targetSpeed m/s.
// The wingman's release is recomputed 1.5 s later (same geometry, fresh
// aim) — that is the whole point of the fix: identical numbers, fresh aim.
export function bombBallisticsProbe(targetSpeed = 20, aimErr = 3) {
  const run = (stagger) => {
    const hits = [];
    for (let n = 0; n < 20; n++) {
      // Target starts at origin, moving +X at targetSpeed.
      const tRel = stagger; // wingman releases 1.5 s after the leader's geometry
      const tx = targetSpeed * tRel, tz = 0;
      const deckY = 350;
      // Jet on the 30 deg dive line through the release point, heading at the target.
      const rx = tx - BOMB_RELEASE_DIST, rz = 0;
      const ry = deckY + BOMB_RELEASE_ALT;
      const dirx = 1, diry = -Math.tan(Math.PI / 6), dirz = 0;
      const dl = Math.hypot(dirx, diry, dirz);
      const vx = JET_DIVE_SPEED * dirx / dl, vy = JET_DIVE_SPEED * diry / dl, vz = 0;
      const ex = (Math.random() - 0.5) * 2 * aimErr, ez = (Math.random() - 0.5) * 2 * aimErr;
      let bx = rx + ex, by = ry, bz = rz + ez, bvx = vx, bvy = vy, bvz = vz;
      let hit = false, along = 0, across = 0;
      for (let t = 0; t < 5; t += 0.005) {
        bvy -= 9.81 * 0.005;
        bx += bvx * 0.005; by += bvy * 0.005; bz += bvz * 0.005;
        const ttx = targetSpeed * (tRel + t);
        if (by <= deckY + 5) {
          along = bx - ttx; across = bz;
          hit = Math.abs(along) < 166 * 0.95 && Math.abs(across) < 34 * 1.2;
          break;
        }
        if (by <= 0) { along = bx - ttx; across = bz; break; }
      }
      hits.push({ hit, along, across });
    }
    const h = hits.filter(x => x.hit).length;
    const meanAlong = hits.reduce((a, x) => a + x.along, 0) / hits.length;
    const meanAcross = hits.reduce((a, x) => a + x.across, 0) / hits.length;
    return { drops: 20, hits: h, rate: h / 20, meanAlong, meanAcross };
  };
  return { leader: run(0), wingman: run(1.5), geometry: { releaseAlt: BOMB_RELEASE_ALT, releaseDist: BOMB_RELEASE_DIST, diveSpeed: JET_DIVE_SPEED, targetSpeed, aimErr } };
}

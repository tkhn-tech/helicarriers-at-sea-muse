// airdefense.js — Helicarriers at Sea v1.4.0: NavalAirDefenseSystem
// (Hurricane v11.25, rescaled to metres — Hurricane ran 1 unit ≈ 5.74 m,
// so its constants are NOT copied literally):
//   CIWS_RANGE 120u -> 120*5.74 = 689 m -> 700 m
//   SAM_RANGE  280u -> 280*5.74 = 1607 m -> 1600 m
//   SAM_SPEED  85 u/s -> 85*5.74 = 488 m/s -> 480 m/s
//   CIWS_BURST_T 0.14 s, CIWS_DMG 12 — verbatim numbers (CIWS_HIT_P_JET
//   was 0.08 verbatim, cut to 0.06 in the v1.4.0 retune below),
//   only the ranges/speeds are rescaled (they were distances).
// v1.4.0 (items 2+4) AD retune — SAMs more numerous and reliable but
// less spiky, so per-flight jet losses stop being a lottery (v1.3.0
// baseline: 0,0,0,0,0,2,1,0,1,2 per flight — 6/10 untouched, 2/10 wiped):
//   SAM_DMG 55 -> 40: one SAM no longer primes a wing/engine for a
//     single CIWS follow-up kill (wing 48+14.4=62 < 80; engine 60+18=78
//     < 90; fuel 40 < 50, so no ignite). A kill now needs two SAMs on
//     one zone, or a SAM plus several CIWS hits on the same zone.
//   SAM turn authority 3 -> 3.5 rad/s, flare decoy 0.5 -> 0.4: SAMs
//     connect more often than v1.3.0's ~27% without becoming unavoidable.
// PASS 2 (measured): volume back at v1.3.0 levels (reload 6, max-out 2,
//   prox 25) with SAM_DMG 40 + turn 3.5 + decoy 0.4 — SAM damage events
//   4.2/flight (vs 2.9 baseline), connect 39% (vs 27%). AD losses
//   0.90/flight (2,0,0,1,1,2,1,1,0,1), still above baseline 0.6, and
//   flights 7–8 showed the remaining killer is pure CIWS concentration:
//   the nearest jet eats ~16 of ~22 CIWS hits and 6–8 of them land on
//   one wing (6 × 14.4 = 86 > 80). So PASS 3 cuts CIWS_HIT_P_JET
//   0.08 -> 0.06 (ordnance probability untouched at 0.04): fewer hits
//   overall, and P(≥6 hits on one wing) falls ~3×. CIWS damage stays 12.
//   CIWS range / burst time / ordnance probability are unchanged.
// Active on BOTH sides (Hurricane's player-side code existed but was
// never exercised — here enemy jets exist, so player carriers defend
// too). SAM/CIWS damage feeds the jet zone model, never instant-kills.
import * as THREE from 'three';

export const CIWS_RANGE = 700;
export const SAM_RANGE = 1600;
export const CIWS_BURST_T = 0.14;
export const CIWS_HIT_P_JET = 0.06;
export const CIWS_HIT_P_ORD = 0.04;
export const CIWS_DMG = 12;
export const SAM_DMG = 40;
export const SAM_SPEED = 480;
export const SAM_RELOAD_T = 6;
export const SAM_MAX_OUT = 2;
export const SAM_PROX = 25; // proximity detonation radius, m
export const SAM_TURN_RATE = 3.5; // rad/s steering authority
export const SAM_FLARE_DECOY_P = 0.4; // chance a flaring jet decoys a SAM

// One VLS SAM in flight (Hurricane SamMissile): vertical launch, then
// homes with predictive lead (0.3 s), proximity detonation. Flares can
// decoy it: when the target dumps flares, the SAM has a chance
// (SAM_FLARE_DECOY_P, v1.4.0: 0.4, was 0.5) to chase the flare burst
// instead and fizzle.
export class SamMissile {
  constructor(scene, fromCarrier, target, ctx, adSys) {
    this.fromCarrier = fromCarrier;
    this.target = target;
    this.ctx = ctx;
    this.adSys = adSys || null; // AirDefenseSystem — owns stats.samsHit
    this.x = fromCarrier.x; this.y = fromCarrier.y + 10; this.z = fromCarrier.z;
    this.vx = 0; this.vy = 60; this.vz = 0;
    this.speed = SAM_SPEED;
    this.t = 0; this.trailT = 0; this.alive = true;
    this.decoyed = false; this.decoyPt = null;
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.6, 0.6, 7, 6),
      new THREE.MeshStandardMaterial({ color: 0xeeeeee, metalness: 0.5, roughness: 0.4 }));
    body.rotation.x = Math.PI / 2;
    this.group = new THREE.Group();
    this.group.add(body);
    this.group.position.set(this.x, this.y, this.z);
    scene.add(this.group);
  }
  remove() {
    if (this.group) { this.ctx.scene.remove(this.group); this.group = null; }
    this.alive = false;
    const ad = this.fromCarrier.ad;
    if (ad) ad.samsOut = Math.max(0, (ad.samsOut || 1) - 1);
  }
  targetAlive() {
    const t = this.target;
    if (!t) return false;
    if (t.alive === false) return false; // carrier target gone
    if (t.state === 'crashed' || t.state === 'sinking') return false;
    if (t.state === 'spinout') return false; // already dying — no point chasing
    return true;
  }
  update(dt) {
    if (!this.alive) return;
    this.t += dt;
    if (!this.targetAlive()) { this.fizzle(); return; }
    const tgt = this.target;
    // Flare decoy check: a jet that just dumped flares may pull the SAM
    // off. Decided once, at the moment the SAM is inside 600 m.
    if (!this.decoyed && tgt.flareT > 0 && this.t > 0.5) {
      const d0 = Math.hypot(tgt.x - this.x, tgt.y - this.y, tgt.z - this.z);
      if (d0 < 600 && Math.random() < SAM_FLARE_DECOY_P) {
        this.decoyed = true;
        this.decoyPt = { x: tgt.x, y: tgt.y - 20, z: tgt.z };
      }
    }
    let tx, ty, tz;
    if (this.decoyed && this.decoyPt) { tx = this.decoyPt.x; ty = this.decoyPt.y; tz = this.decoyPt.z; }
    else {
      tx = tgt.x + (tgt.vx || 0) * 0.3;
      ty = tgt.y || 0;
      tz = tgt.z + (tgt.vz || 0) * 0.3;
    }
    const dx = tx - this.x, dy = ty - this.y, dz = tz - this.z;
    const d = Math.hypot(dx, dy, dz) || 0.001;
    // Turn authority: the SAM cannot turn instantly — it steers toward
    // the aim point at up to SAM_TURN_RATE rad/s, so a hard-breaking jet
    // can out-turn it.
    const sp = this.speed;
    const ux = dx / d, uy = dy / d, uz = dz / d;
    const cl = Math.hypot(this.vx, this.vy, this.vz) || 1;
    const cvx = this.vx / cl, cvy = this.vy / cl, cvz = this.vz / cl;
    const ang = Math.acos(Math.max(-1, Math.min(1, cvx * ux + cvy * uy + cvz * uz)));
    const k = ang > 1e-6 ? Math.min(1, (SAM_TURN_RATE * dt) / ang) : 1;
    let nx = cvx + (ux - cvx) * k, ny = cvy + (uy - cvy) * k, nz = cvz + (uz - cvz) * k;
    const nl = Math.hypot(nx, ny, nz) || 1;
    this.vx = nx / nl * sp; this.vy = ny / nl * sp; this.vz = nz / nl * sp;
    this.x += this.vx * dt; this.y += this.vy * dt; this.z += this.vz * dt;
    this.group.position.set(this.x, this.y, this.z);
    this.group.lookAt(this.x + this.vx, this.y + this.vy, this.z + this.vz);
    this.trailT -= dt;
    if (this.trailT <= 0) {
      this.trailT = 0.05;
      this.ctx.vfx.spawnParticle(this.x, this.y, this.z, 0, 0, 0, 0.6, 1, 1, 1, 0);
    }
    // Proximity detonation.
    if (d < SAM_PROX) { this.detonate(); return; }
    if (this.decoyed && this.decoyPt && Math.hypot(this.decoyPt.x - this.x, this.decoyPt.y - this.y, this.decoyPt.z - this.z) < 20) {
      this.fizzle(); return;
    }
    if (this.t > 20 || d > 9000) { this.fizzle(); return; }
  }
  detonate() {
    const tgt = this.target;
    // v1.4.0: proximity detonation IS a hit — count it. (stats.samsHit
    // was always 0 before: detonate() never incremented it.)
    if (this.adSys) this.adSys.stats.samsHit++;
    this.ctx.vfx.burst(this.x, this.y, this.z, 30, [1, 0.7, 0.3], 8, 4);
    this.ctx.vfx.spawnSprite(this.x, this.y, this.z, 0.5, 18, 18, 2, 0xff8c2e, 0.9);
    if (this.ctx.audio) this.ctx.audio.boom(false);
    if (this.ctx.noteDetonation) this.ctx.noteDetonation(this.x, this.y, this.z, 'sam');
    if (tgt && tgt.damageZone) {
      // SAM damage feeds the jet zone model (jets.js): random zone,
      // never an instant kill. v1.4.0: one SAM (40) leaves a wing at
      // 32 HP / an engine at 30 HP — dangerous, but it takes a second
      // hit on the same zone (or several CIWS hits) to finish it.
      const zones = ['wingL', 'wingR', 'engineL', 'engineR', 'fuselage', 'fuel'];
      tgt.damageZone(SAM_DMG, zones[Math.floor(Math.random() * zones.length)], 'sam', this.ctx);
    } else if (tgt && tgt.splash) {
      tgt.splash(); // ASM intercepted
    } else if (tgt && tgt.alive !== undefined && tgt.alive) {
      tgt.alive = false; // bomb destroyed in the air
      this.ctx.vfx.spawnSprite(tgt.x, tgt.y, tgt.z, 0.5, 10, 10, 0.8, 0xffffff, 0.6);
    }
    this.remove();
  }
  fizzle() {
    this.ctx.vfx.spawnSprite(this.x, this.y, this.z, 0.6, 8, 8, 0.8, 0xffffff, 0.5);
    this.remove();
  }
}

export class AirDefenseSystem {
  constructor() {
    this.sams = [];
    this.stats = { ciwsBursts: 0, ciwsHits: 0, samsFired: 0, samsHit: 0, ordIntercepted: 0, jetsHit: 0 };
  }
  adState(carrier) {
    if (!carrier.ad) carrier.ad = { ciwsT: 0, samT: 0, samsOut: 0 };
    return carrier.ad;
  }
  // Threats a carrier defends against: enemy jets airborne, enemy ASMs,
  // enemy bombs. Jets on the deck / catapult / taxi / rearm are not targets.
  threatsFor(carrier, G) {
    const jets = [], missiles = [], bombs = [];
    for (const c of G.allCarriers) {
      if (c.side === carrier.side || !c.wing) continue;
      for (const s of c.wing.squadrons) for (const j of s.jets) {
        if (['climb', 'ingress', 'attack', 'egress', 'rtb', 'trap', 'divert', 'spinout'].includes(j.state)) jets.push(j);
      }
    }
    for (const m of G.missiles) if (m.alive) missiles.push(m);
    for (const b of G.bombs) if (b.alive) bombs.push(b);
    return { jets, missiles, bombs };
  }
  nearestThreat(carrier, threats, range) {
    let best = null, bd = range;
    const consider = (t) => {
      const d = Math.hypot(t.x - carrier.x, t.z - carrier.z);
      if (d < bd) { bd = d; best = t; }
    };
    // Jets first (they are the persistent threat), then ordnance.
    threats.jets.forEach(consider);
    threats.missiles.forEach(consider);
    threats.bombs.forEach(consider);
    return best;
  }
  engageCIWS(carrier, threats, dt, ctx) {
    const ad = this.adState(carrier);
    ad.ciwsT -= dt;
    if (ad.ciwsT > 0) return;
    const tgt = this.nearestThreat(carrier, threats, CIWS_RANGE);
    if (!tgt) return;
    ad.ciwsT = CIWS_BURST_T;
    this.stats.ciwsBursts++;
    const gx = carrier.x, gy = carrier.deckTopY() + 5, gz = carrier.z;
    const dx = tgt.x - gx, dy = (tgt.y || gy) - gy, dz = tgt.z - gz;
    const d = Math.hypot(dx, dy, dz) || 1;
    for (let i = 0; i < 4; i++) {
      const k = 0.3 + Math.random() * 0.6;
      ctx.vfx.spawnParticle(gx + dx * k + (Math.random() - 0.5) * 4, gy + dy * k, gz + dz * k,
        dx / d * 300, dy / d * 300, dz / d * 300, 0.25, 1, 0.75, 0.25, 0);
    }
    const isJet = !!tgt.damageZone;
    const p = isJet ? CIWS_HIT_P_JET : CIWS_HIT_P_ORD;
    if (Math.random() < p) {
      this.stats.ciwsHits++;
      if (isJet) {
        this.stats.jetsHit++;
        const zones = ['wingL', 'wingR', 'engineL', 'engineR', 'fuselage', 'fuel'];
        tgt.damageZone(CIWS_DMG, zones[Math.floor(Math.random() * zones.length)], 'ciws', ctx);
      } else if (tgt.splash) { // ASM intercepted — geyser
        this.stats.ordIntercepted++;
        tgt.splash();
      } else if (tgt.alive !== undefined) { // bomb destroyed in the air
        this.stats.ordIntercepted++;
        ctx.vfx.spawnSprite(tgt.x, tgt.y, tgt.z, 0.5, 10, 10, 0.8, 0xffffff, 0.6);
        tgt.alive = false;
      }
    }
  }
  engageSAM(carrier, threats, dt, ctx, G) {
    const ad = this.adState(carrier);
    ad.samT -= dt;
    if (ad.samT > 0 || ad.samsOut >= SAM_MAX_OUT) return;
    // SAMs prefer jets; ordnance only when no jet is in range.
    let tgt = this.nearestThreat(carrier, { jets: threats.jets, missiles: [], bombs: [] }, SAM_RANGE);
    if (!tgt) tgt = this.nearestThreat(carrier, { jets: [], missiles: threats.missiles, bombs: threats.bombs }, SAM_RANGE);
    if (!tgt) return;
    ad.samT = SAM_RELOAD_T;
    ad.samsOut++;
    this.stats.samsFired++;
    const sam = new SamMissile(ctx.scene, carrier, tgt, ctx, this);
    this.sams.push(sam);
    ctx.vfx.spawnSprite(carrier.x, carrier.deckTopY() + 4, carrier.z, 0.8, 20, 20, 0.8, 0xffffff, 0.7);
    if (ctx.audio) ctx.audio.samLaunch();
    // SAM-evasion trigger: the targeted jet breaks 90 deg for ~2.5 s at
    // steep bank and dumps flares (Hurricane v11.45 F5). The SAM itself
    // checks the flare decoy in flight.
    // v1.5.0 M5: the break side comes from the SAM's ACTUAL bearing
    // (Hurricane L6225) — break INTO the incoming missile — not a
    // coin flip. The SAM spawns at the firing carrier, so its bearing
    // at trigger time is the carrier's bearing from the jet.
    if (tgt.damageZone && tgt.defensiveT <= 0) {
      tgt.defensiveT = 2.5;
      const sbx = sam.x - tgt.x, sbz = sam.z - tgt.z;
      let db = Math.atan2(sbx, -sbz) - tgt.heading;
      db = ((db + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      tgt.defSide = db >= 0 ? 1 : -1; // threat on the right -> break right, INTO it (Hurricane L6225)
      tgt.dumpFlares(ctx);
    }
  }
  update(dt, ctx, G) {
    if (!G.started || G.over || G.paused) return;
    for (const c of G.allCarriers) {
      if (!c.alive) continue;
      const threats = this.threatsFor(c, G);
      if (!threats.jets.length && !threats.missiles.length && !threats.bombs.length) continue;
      this.engageCIWS(c, threats, dt, ctx);
      this.engageSAM(c, threats, dt, ctx, G);
    }
    for (let i = this.sams.length - 1; i >= 0; i--) {
      const m = this.sams[i];
      if (!m.alive) { this.sams.splice(i, 1); continue; }
      const wasAlive = m.alive;
      m.update(dt);
      if (wasAlive && !m.alive) this.sams.splice(i, 1);
    }
  }
}

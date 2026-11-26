// vfx.js — damage / explosion / fire VFX pools, adapted from Hurricane Fleet
// L2317-2444, L3231-3243, L3355-3372, L2355-2370.
//
// POOL BUDGETS (raised for v1 — Hurricane's 600 particles / 160 sprites are
// shared round-robin stealers and exhaust with several helicarriers burning
// at once; the stock-take flagged this):
//   P_MAX = 1600 particles, S_MAX = 420 sprites.
// Both pools still round-robin and can steal the oldest live entry when
// full — callers must never assume a spawn survives.
//
// v1.5.0 worst-case budget (live counts = emission rate x life; all new
// emitters are pool-guarded — see the guards in carrier.js and below):
//   detonation magazineSecondary + hitFX (pre-existing peak) ~900-1100 P / ~30 S
//   D7 pulverisation burst (1 segment, capped)                ~100 P / 8 S
//   D10 slam sheet (1 impact)                                  ~60 P / 3 S
//   D11 cook-offs (8 max, staggered, ~25 P + 2 S each, life ~1 s) ~50 P / 6 S live
//   cut-face venting (6 pieces x 2 faces, 0.5 s cadence)        ~60 P / 12 S
//   shedding sparks (~10/s/piece)                               ~60 P
//   travelling deck fire (4 fires, 0.15 s cadence)             ~100 P / 8 S
//   burning slick (1 field, 6/s)                                ~12 P
//   downwash spray (pre-existing, guarded)                     ~100 P / 32 S
//   TOTAL worst live (build-time estimate)                 ~1450 P / ~100 S
// MEASURED v1.5.0 probes (2026-11-26): the particle estimate
// holds — liveP sits at the 1600 cap during multi-breakup action
// — but the sprite estimate was ~4x too low. liveS reached 415/420
// (longitudinal + crippled pages) and 399-412 on slam/crippled
// snapshots. The big sprite consumers are the long-lived smoke
// sprites (2.5-4 s life): cut-face venting on every piece, piece
// smoke trails, fire/hurt smoke, sinking smoke, downwash. The new
// v1.5.0 emitters are all guarded at liveSprites() < 300 /
// liveParticles() < 1200, but several pre-existing emitters
// (detonation/hit smoke, fire smoke, sinking smoke, splash rings)
// spawn unguarded, so the pool still saturates when several kills
// overlap. That is graceful, not a crash: spawnSprite() is a ring
// cursor that recycles the oldest sprite, and no probe run showed
// an error or a failed request. During saturation, the newest
// effects (slam sheet, cook-off) can be throttled or steal an old
// smoke sprite — accepted for v1.5.0; raising S_MAX or guarding the
// pre-existing smoke emitters is a follow-up, not a blocker.
// The slam sheet (D10) and pulverisation burst (D7) are budgeted FIRST
// as the largest new consumers; every new emitter checks liveParticles()
// < 1200 / liveSprites() < 300 before emitting and halves or skips under
// pressure, so the pools can never be blown out by one kill.
import * as THREE from 'three';

export const P_MAX = 1600;
export const S_MAX = 420;

function makeSoftTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
}

export class VFX {
  constructor(scene) {
    this.scene = scene;
    this.softTex = makeSoftTexture();
    this.parts = [];
    const pGeo = new THREE.BufferGeometry();
    this.pPos = new Float32Array(P_MAX * 3);
    this.pCol = new Float32Array(P_MAX * 3);
    for (let i = 0; i < P_MAX; i++) {
      this.parts.push({ life: 0, max: 1, x: 0, y: -999, z: 0, vx: 0, vy: 0, vz: 0, r: 1, g: 1, b: 1, grav: 0 });
      this.pPos[i * 3 + 1] = -999;
    }
    pGeo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    pGeo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    const pMat = new THREE.PointsMaterial({ size: 2.2, map: this.softTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    this.points = new THREE.Points(pGeo, pMat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.pCursor = 0;

    this.spritePool = [];
    for (let i = 0; i < S_MAX; i++) {
      const m = new THREE.SpriteMaterial({ map: this.softTex, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
      const sp = new THREE.Sprite(m);
      sp.visible = false;
      scene.add(sp);
      this.spritePool.push({ sp, life: 0, max: 1, vx: 0, vy: 0, vz: 0, grow: 0, fade: 1 });
    }
    this.spCursor = 0;
    this.boomLight = new THREE.PointLight(0xff8c2e, 0, 900);
    scene.add(this.boomLight);
    this.shake = 0;
  }
  // v1.4.0: live-pool counts, for emission guards (cut-face venting
  // halves/stops under pool pressure — research §5). Cheap scans of
  // the pool state; callers check before emitting, never assume a
  // spawn survives.
  liveParticles() { let n = 0; for (const p of this.parts) if (p.life > 0) n++; return n; }
  liveSprites() { let n = 0; for (const s of this.spritePool) if (s.life > 0) n++; return n; }
  spawnParticle(x, y, z, vx, vy, vz, life, r, g, b, grav = 0) {
    const p = this.parts[this.pCursor];
    this.pCursor = (this.pCursor + 1) % P_MAX;
    p.life = life; p.max = life; p.x = x; p.y = y; p.z = z;
    p.vx = vx; p.vy = vy; p.vz = vz; p.r = r; p.g = g; p.b = b; p.grav = grav;
  }
  burst(x, y, z, n, col, spd, up) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, e = (Math.random() - 0.3) * Math.PI;
      const s = spd * (0.4 + Math.random() * 0.8);
      this.spawnParticle(x, y, z, Math.cos(a) * Math.cos(e) * s, Math.sin(e) * s + up, Math.sin(a) * Math.cos(e) * s,
        0.6 + Math.random() * 0.7, col[0], col[1], col[2], -3);
    }
  }
  spawnSprite(x, y, z, life, sx, sy, grow, color, opacity) {
    const s = this.spritePool[this.spCursor];
    this.spCursor = (this.spCursor + 1) % S_MAX;
    s.sp.visible = true;
    s.sp.position.set(x, y, z);
    s.sp.scale.set(sx, sy, 1);
    s.sp.material.color.setHex(color);
    s.sp.material.opacity = opacity;
    s.life = life; s.max = life; s.vx = 0; s.vy = 0; s.vz = 0; s.grow = grow; s.fade = opacity;
    return s;
  }
  update(dt) {
    for (let i = 0; i < P_MAX; i++) {
      const p = this.parts[i];
      if (p.life <= 0) { this.pPos[i * 3 + 1] = -999; continue; }
      p.life -= dt;
      p.vy += p.grav * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const f = Math.max(0, p.life / p.max);
      this.pPos[i * 3] = p.x; this.pPos[i * 3 + 1] = p.y; this.pPos[i * 3 + 2] = p.z;
      this.pCol[i * 3] = p.r * f; this.pCol[i * 3 + 1] = p.g * f; this.pCol[i * 3 + 2] = p.b * f;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
    for (const s of this.spritePool) {
      if (s.life <= 0) { s.sp.visible = false; continue; }
      s.life -= dt;
      s.sp.position.x += s.vx * dt; s.sp.position.y += s.vy * dt; s.sp.position.z += s.vz * dt;
      const f = Math.max(0, s.life / s.max);
      s.sp.material.opacity = s.fade * f;
      const k = 1 + s.grow * dt;
      s.sp.scale.x *= k; s.sp.scale.y *= k;
    }
    this.boomLight.intensity = Math.max(0, this.boomLight.intensity - dt * 18);
    this.shake *= Math.pow(0.02, dt);
  }
  // Hurricane magazineSecondary (L3231) rescaled: szF = len/42 ≈ 7.9 for 333 m.
  magazineSecondary(x, y, z, szF) {
    this.boomLight.position.set(x, y, z);
    this.boomLight.intensity = 14;
    this.spawnSprite(x, y, z, 0.5, 14, 14, 0, 0xffffff, 1);
    const fb = this.spawnSprite(x, y, z, 0.9, 20 * szF, 20 * szF, 2, 0xff7a1e, 0.95); fb.vy = 4;
    this.spawnSprite(x, y, z, 0.6, 8 * szF, 8 * szF, 8, 0xffd27a, 0.8);
    this.burst(x, y, z, Math.min(100, Math.round(80 * szF)), [1, 0.8, 0.4], 9, 6);
    this.burst(x, y, z, Math.min(80, Math.round(50 * szF)), [1, 0.5, 0.1], 10, 7);
    this.burst(x, y, z, Math.min(60, Math.round(30 * szF)), [0.2, 0.2, 0.2], 5, 3);
    this.shake = Math.min(18, this.shake + 14);
  }
  hitFX(x, y, z, dmg, szF, magHit) {
    const fbSize = Math.max((6 + dmg * 0.35) * szF, magHit ? 10 * szF : 0);
    this.spawnSprite(x, y, z, 0.5, fbSize, fbSize, 3, 0xff8c2e, 0.9);
    this.spawnSprite(x, y, z, 0.6, 4 * szF, 4 * szF, 6, 0xffe0a0, 0.7);
    this.burst(x, y, z, Math.round(22 * szF), [1, 0.7, 0.25], 8, 4);
    this.burst(x, y, z, Math.round(12 * szF), [0.25, 0.25, 0.25], 5, 3);
    this.spawnSprite(x, y, z, 2.5, 10 * szF, 10 * szF, 1.5, 0x141414, 0.55);
    this.boomLight.position.set(x, y, z);
    this.boomLight.intensity = 6 + Math.min(8, dmg * 0.4);
    this.shake = Math.min(18, this.shake + 10);
  }
  splash(x, y, z, speed) {
    // Velocity-scaled impact splash: plume height and count grow with |vy|.
    const k = Math.min(3, Math.max(0.4, speed / 25));
    const n = Math.round(40 * k);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = (4 + Math.random() * 10) * k;
      this.spawnParticle(x, y, z, Math.cos(a) * s, (6 + Math.random() * 14) * k, Math.sin(a) * s,
        0.8 + Math.random() * 0.8, 0.85, 0.95, 1, -9.81);
    }
    this.spawnSprite(x, y + 4 * k, z, 1.6, 30 * k, 30 * k, 2.5, 0xffffff, 0.8);
    this.spawnSprite(x, y + 2, z, 3.0, 45 * k, 12 * k, 1.2, 0xbfe3f0, 0.5);
    this.shake = Math.min(18, this.shake + 4 * k);
  }
  // v1.5.0 D10 slamming shatter: the impact is a hammer blow, then a
  // vibration. A white slam ring races outward from the contact point
  // and a spray SHEET is thrown up along the hull side (not just a
  // splash — a sheet). Budgeted first with the D7 burst: ~60 particles
  // + 3 sprites, pool-guarded (skipped entirely under pool pressure).
  // (x, z) = impact point, heading = hull heading, len = hull length
  // in the water, side = +1/-1 (which side the sheet climbs) or 0 for both.
  slamSheet(x, y, z, heading, len, side = 0) {
    if (this.liveParticles() > 1200 || this.liveSprites() > 300) return;
    const fx = Math.sin(heading), fz = -Math.cos(heading);
    const rx = Math.cos(heading), rz = Math.sin(heading);
    // Slam ring: a wide flat white sprite racing outward (grow 6/s).
    const ring = this.spawnSprite(x, y + 1, z, 2.2, 30, 30, 6, 0xffffff, 0.7);
    ring.vx = 0; ring.vz = 0;
    const ring2 = this.spawnSprite(x, y + 0.5, z, 3.0, 60, 60, 2, 0xbfe3f0, 0.4);
    ring2.vx = 0; ring2.vz = 0;
    // Spray sheet: particles thrown up along BOTH hull sides (or one
    // side when the entry is a side entry), densest near the impact
    // point, falling off along the hull — a wall of water climbing the
    // steel, not a radial plume.
    const sides = side === 0 ? [1, -1] : [side];
    for (let i = 0; i < 60; i++) {
      const s = sides[i % sides.length];
      const along = (Math.random() * 2 - 1) * len * 0.5;
      const px = x + fx * along + rx * s * 34;
      const pz = z + fz * along + rz * s * 34;
      const w = 1 - Math.abs(along) / (len * 0.5); // densest at impact
      this.spawnParticle(px, y + Math.random() * 2, pz,
        rx * s * (4 + Math.random() * 6), (10 + Math.random() * 16) * (0.4 + 0.6 * w),
        rz * s * (4 + Math.random() * 6),
        0.9 + Math.random() * 0.7, 0.85, 0.95, 1, -9.81);
    }
    this.spawnSprite(x, y + 6, z, 1.8, 50, 18, 2, 0xd8ecf2, 0.55);
    this.shake = Math.min(18, this.shake + 6);
  }
  // v1.5.0 D11 cook-off: one round cooking off — a small sharp burst
  // with its own fireball sprite, visual/audio only, no damage.
  // Pool-guarded like everything else in v1.5.0.
  cookoffBurst(x, y, z, size = 1) {
    if (this.liveParticles() > 1200) return;
    this.burst(x, y, z, Math.round(18 * size), [1, 0.55, 0.15], 9, 5);
    this.spawnSprite(x, y, z, 0.4, 12 * size, 12 * size, 3, 0xff8c2e, 0.9);
    this.boomLight.position.set(x, y, z);
    this.boomLight.intensity = 4 + 4 * size;
  }
  // v1.5.0 D12/D14: a few orange flame particles at the water surface
  // (burning slick) or a bubble/debris burst at depth (implosion).
  // Both are small, pool-guarded, and short-lived.
  slickFlame(x, y, z, n = 6) {
    if (this.liveParticles() > 1200) return;
    for (let i = 0; i < n; i++) {
      this.spawnParticle(x + (Math.random() - 0.5) * 20, y + 1 + Math.random() * 2, z + (Math.random() - 0.5) * 20,
        (Math.random() - 0.5) * 2, 2 + Math.random() * 3, (Math.random() - 0.5) * 2,
        0.7 + Math.random() * 0.6, 1, 0.55, 0.15, 1.5);
    }
  }
  implosionBurst(x, y, z) {
    if (this.liveParticles() > 1200) return;
    this.bubbles(x, y, z, 60, 30);
    this.burst(x, y, z, 20, [0.5, 0.55, 0.6], 4, 2);
    this.spawnSprite(x, y + 2, z, 2.0, 40, 40, 1.5, 0xd8ecf2, 0.5);
  }
  bubbles(x, y, z, n, spread) {
    for (let i = 0; i < n; i++) {
      this.spawnParticle(x + (Math.random() - 0.5) * spread, y + Math.random() * 2, z + (Math.random() - 0.5) * spread,
        (Math.random() - 0.5) * 1.5, 2.5 + Math.random() * 2, (Math.random() - 0.5) * 1.5,
        4.0, 0.8, 0.9, 1, 2);
    }
  }
  boil(x, y, z, size) {
    const s = this.spawnSprite(x, y + 1, z, 3.0, size, size, 0.8, 0xd8ecf2, 0.5);
    s.vx = (Math.random() - 0.5) * 2; s.vz = (Math.random() - 0.5) * 2;
  }
  addScorch(parent, lx, ly, lz, scale) {
    const m = new THREE.SpriteMaterial({ map: this.softTex, color: 0x050505, transparent: true, opacity: 0.9, depthWrite: false });
    const sp = new THREE.Sprite(m);
    sp.position.set(lx, ly, lz);
    sp.scale.set(scale, scale, 1);
    parent.add(sp);
    return sp;
  }
}

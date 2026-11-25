// vfx.js — damage / explosion / fire VFX pools, adapted from Hurricane Fleet
// L2317-2444, L3231-3243, L3355-3372, L2355-2370.
//
// POOL BUDGETS (raised for v1 — Hurricane's 600 particles / 160 sprites are
// shared round-robin stealers and exhaust with several helicarriers burning
// at once; the stock-take flagged this):
//   P_MAX = 1600 particles, S_MAX = 420 sprites.
// Both pools still round-robin and can steal the oldest live entry when
// full — callers must never assume a spawn survives.
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

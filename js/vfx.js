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
      // v1.6.0 perf: the pool entries keep their old shape (sp stub
      // with position/scale/material/visible, life/max, vx/vy/vz,
      // grow/fade) so every spawnSprite caller is untouched — but
      // there is no THREE.Sprite per entry any more. All live sprites
      // render as ONE THREE.Points draw call (see _spritePoints
      // below); the stub only carries the per-sprite state the update
      // loop and the batch writer read.
      const sp = {
        position: new THREE.Vector3(), scale: new THREE.Vector3(1, 1, 1),
        material: { color: new THREE.Color(0xffffff), opacity: 0 }, visible: false,
      };
      this.spritePool.push({ sp, life: 0, max: 1, vx: 0, vy: 0, vz: 0, grow: 0, fade: 1 });
    }
    this.spCursor = 0;
    // v1.6.0 perf: live-index lists — update() iterates live entries
    // only instead of scanning all 1600 particles / 420 sprites every
    // frame. _pPos/_sPos map slot -> position in the live list (-1 =
    // dead) so spawn/remove are O(1). The list lengths ARE the live
    // counts, so liveParticles()/liveSprites() are O(1) too (guards
    // used to pay a full scan per call, dozens of times per frame).
    this._pLive = []; this._pPos = new Int32Array(P_MAX).fill(-1);
    this._sLive = []; this._sPos = new Int32Array(S_MAX).fill(-1);
    this._sSorted = new Int32Array(S_MAX);
    this._sDepth = new Float32Array(S_MAX);
    this._renderer = null; this._camera = null;
    // Batched sprite cloud: one Points draw for the whole pool.
    // Per-sprite attributes: position (world), aColor, aSize (sx, sy
    // world metres), aOpacity. The shader draws a soft-textured
    // ellipse — a circular sprite is the old sprite exactly; a
    // non-square one (e.g. splash 45x12) is the same ellipse the old
    // quad showed, sampled from the same texture. Live sprites are
    // depth-sorted far-to-near per frame (the old per-sprite sort
    // order) before the attributes are written, so normal blending
    // composites in the same order as before.
    const sGeo = new THREE.BufferGeometry();
    this._sPosAttr = new Float32Array(S_MAX * 3);
    this._sColAttr = new Float32Array(S_MAX * 3);
    this._sSizeAttr = new Float32Array(S_MAX * 2);
    this._sOpAttr = new Float32Array(S_MAX);
    sGeo.setAttribute('position', new THREE.BufferAttribute(this._sPosAttr, 3).setUsage(THREE.DynamicDrawUsage));
    sGeo.setAttribute('aColor', new THREE.BufferAttribute(this._sColAttr, 3).setUsage(THREE.DynamicDrawUsage));
    sGeo.setAttribute('aSize', new THREE.BufferAttribute(this._sSizeAttr, 2).setUsage(THREE.DynamicDrawUsage));
    sGeo.setAttribute('aOpacity', new THREE.BufferAttribute(this._sOpAttr, 1).setUsage(THREE.DynamicDrawUsage));
    const sMat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: this.softTex },
        uScale: { value: 1 },
        fogColor: { value: new THREE.Color(0x9fc3d8) },
        fogNear: { value: 800 }, fogFar: { value: 6000 },
        // v1.6.1 HOTFIX: fogDensity MUST be declared. This material has
        // fog:true, so when the scene fog flips linear -> FogExp2 (the
        // camera goes underwater, game.js updateCamera) Three's
        // refreshFogUniforms sets uniforms.fogDensity.value
        // (three.module.js:27531) — without this entry that is
        // "Cannot set properties of undefined (setting 'value')" and
        // the game shows the "Failed to start" overlay mid-round.
        // The value is overwritten from the scene fog on every program
        // switch; 0.005 matches the underwater murk density.
        fogDensity: { value: 0.005 },
      },
      vertexShader: `
        attribute vec3 aColor; attribute vec2 aSize; attribute float aOpacity;
        varying vec3 vColor; varying vec2 vEllipse; varying float vOpacity;
        uniform float uScale;
        #include <fog_pars_vertex>
        void main(){
          vColor = aColor; vOpacity = aOpacity;
          float m = max(aSize.x, aSize.y);
          vEllipse = aSize / max(m, 1e-6);
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = m * (uScale / max(0.1, -mvPosition.z));
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        uniform sampler2D map;
        varying vec3 vColor; varying vec2 vEllipse; varying float vOpacity;
        #include <fog_pars_fragment>
        void main(){
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          vec2 e = p / vEllipse;
          if (dot(e, e) > 1.0) discard;
          vec4 tex = texture2D(map, e * 0.5 + 0.5);
          gl_FragColor = vec4(vColor, tex.a * vOpacity);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
      transparent: true, depthWrite: false, fog: true,
    });
    this._spriteMat = sMat;
    this.spritePoints = new THREE.Points(sGeo, sMat);
    this.spritePoints.frustumCulled = false;
    scene.add(this.spritePoints);
    // v1.6.0 perf: external sprite batch — nav lights + blob shadows
    // (jets.js) are own sprites, not pool entries, but the same
    // soft-textured quads: 4 per jet, ~100-190 draw calls in combat.
    // They render as ONE more Points draw call through the same shader
    // and material (NAV_TEX is pixel-identical to softTex, same 64 px
    // radial gradient). Slots are allocated once per jet and rewritten
    // every frame by the owner (allocExt/setExt); invisible slots cost
    // nothing (drawRange covers visible slots only). Entries share the
    // pool entry shape so the same sort/write helpers serve both.
    this.EXT_MAX = 400; // 96 jets x 4 (port/stbd/strobe/shadow) = 384
    this.extPool = [];
    for (let i = 0; i < this.EXT_MAX; i++) {
      const sp = {
        position: new THREE.Vector3(), scale: new THREE.Vector3(1, 1, 1),
        material: { color: new THREE.Color(0xffffff), opacity: 0 }, visible: false,
      };
      this.extPool.push({ sp });
    }
    this._extNext = 0;
    this._eSorted = new Int32Array(this.EXT_MAX);
    this._eDepth = new Float32Array(this.EXT_MAX);
    this._extColor = new THREE.Color();
    const eGeo = new THREE.BufferGeometry();
    this._ePosAttr = new Float32Array(this.EXT_MAX * 3);
    this._eColAttr = new Float32Array(this.EXT_MAX * 3);
    this._eSizeAttr = new Float32Array(this.EXT_MAX * 2);
    this._eOpAttr = new Float32Array(this.EXT_MAX);
    eGeo.setAttribute('position', new THREE.BufferAttribute(this._ePosAttr, 3).setUsage(THREE.DynamicDrawUsage));
    eGeo.setAttribute('aColor', new THREE.BufferAttribute(this._eColAttr, 3).setUsage(THREE.DynamicDrawUsage));
    eGeo.setAttribute('aSize', new THREE.BufferAttribute(this._eSizeAttr, 2).setUsage(THREE.DynamicDrawUsage));
    eGeo.setAttribute('aOpacity', new THREE.BufferAttribute(this._eOpAttr, 1).setUsage(THREE.DynamicDrawUsage));
    this.extPoints = new THREE.Points(eGeo, sMat);
    this.extPoints.frustumCulled = false;
    scene.add(this.extPoints);
    this.boomLight = new THREE.PointLight(0xff8c2e, 0, 900);
    scene.add(this.boomLight);
    this.shake = 0;
  }
  // v1.6.0 perf: external sprite slots (nav lights / blob shadows).
  // Returns a slot index, or -1 when exhausted (caller then skips
  // that sprite — same graceful degradation as the pool stealers).
  allocExt() { if (this._extNext >= this.EXT_MAX) return -1; return this._extNext++; }
  setExt(i, x, y, z, sx, sy, colorHex, opacity, visible) {
    if (i < 0 || i >= this.EXT_MAX) return;
    const s = this.extPool[i].sp;
    s.position.set(x, y, z);
    s.scale.set(sx, sy, 1);
    this._extColor.setHex(colorHex);
    s.material.color.copy(this._extColor);
    s.material.opacity = opacity;
    s.visible = visible;
  }
  // v1.6.0 perf: view binding for the batched sprite cloud — the
  // point-size scale needs the drawing-buffer height and the camera
  // fov (gl_PointSize is in physical pixels). Called once from
  // initScene; update() recomputes uScale from these each frame.
  bindView(renderer, camera) { this._renderer = renderer; this._camera = camera; }
  // v1.6.0: live-pool counts, for emission guards (cut-face venting
  // halves/stops under pool pressure — research §5). O(1) from the
  // live lists maintained by spawn/update (was a full pool scan per
  // call); values are at most one frame stale, which is immaterial
  // for threshold guards.
  liveParticles() { return this._pLive.length; }
  liveSprites() { return this._sLive.length; }
  spawnParticle(x, y, z, vx, vy, vz, life, r, g, b, grav = 0) {
    const idx = this.pCursor;
    const p = this.parts[idx];
    this.pCursor = (idx + 1) % P_MAX;
    const wasLive = p.life > 0;
    p.life = life; p.max = life; p.x = x; p.y = y; p.z = z;
    p.vx = vx; p.vy = vy; p.vz = vz; p.r = r; p.g = g; p.b = b; p.grav = grav;
    if (!wasLive) { this._pPos[idx] = this._pLive.length; this._pLive.push(idx); }
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
    const idx = this.spCursor;
    const s = this.spritePool[idx];
    this.spCursor = (idx + 1) % S_MAX;
    const wasLive = s.life > 0;
    s.sp.visible = true;
    s.sp.position.set(x, y, z);
    s.sp.scale.set(sx, sy, 1);
    s.sp.material.color.setHex(color);
    s.sp.material.opacity = opacity;
    s.life = life; s.max = life; s.vx = 0; s.vy = 0; s.vz = 0; s.grow = grow; s.fade = opacity;
    if (!wasLive) { this._sPos[idx] = this._sLive.length; this._sLive.push(idx); }
    return s;
  }
  update(dt) {
    // Particles: live entries only (swap-remove on death).
    for (let i = this._pLive.length - 1; i >= 0; i--) {
      const idx = this._pLive[i];
      const p = this.parts[idx];
      if (p.life <= 0) { this.pPos[idx * 3 + 1] = -999; this._pLive[i] = this._pLive[this._pLive.length - 1]; this._pLive.pop(); if (i < this._pLive.length) this._pPos[this._pLive[i]] = i; this._pPos[idx] = -1; continue; }
      p.life -= dt;
      if (p.life <= 0) { this.pPos[idx * 3 + 1] = -999; const last = this._pLive.pop(); if (i < this._pLive.length) { this._pLive[i] = last; this._pPos[last] = i; } this._pPos[idx] = -1; continue; }
      p.vy += p.grav * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const f = Math.max(0, p.life / p.max);
      this.pPos[idx * 3] = p.x; this.pPos[idx * 3 + 1] = p.y; this.pPos[idx * 3 + 2] = p.z;
      this.pCol[idx * 3] = p.r * f; this.pCol[idx * 3 + 1] = p.g * f; this.pCol[idx * 3 + 2] = p.b * f;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
    // Sprites: live entries only; dead slots leave the live list and
    // are never written to the batch. The stub state (position/scale/
    // opacity) is kept in sync exactly as the old per-sprite loop did.
    for (let i = this._sLive.length - 1; i >= 0; i--) {
      const idx = this._sLive[i];
      const s = this.spritePool[idx];
      if (s.life <= 0) { s.sp.visible = false; const last = this._sLive.pop(); if (i < this._sLive.length) { this._sLive[i] = last; this._sPos[last] = i; } this._sPos[idx] = -1; continue; }
      s.life -= dt;
      if (s.life <= 0) { s.sp.visible = false; const last = this._sLive.pop(); if (i < this._sLive.length) { this._sLive[i] = last; this._sPos[last] = i; } this._sPos[idx] = -1; continue; }
      s.sp.position.x += s.vx * dt; s.sp.position.y += s.vy * dt; s.sp.position.z += s.vz * dt;
      const f = Math.max(0, s.life / s.max);
      s.sp.material.opacity = s.fade * f;
      const k = 1 + s.grow * dt;
      s.sp.scale.x *= k; s.sp.scale.y *= k;
    }
    this._writeSpriteBatch();
    this.boomLight.intensity = Math.max(0, this.boomLight.intensity - dt * 18);
    this.shake *= Math.pow(0.02, dt);
  }
  // Depth-sort `idx[0..n)` (slot indices into `entries`) far to near
  // — the old per-sprite transparent sort order. Insertion sort: the
  // list is nearly sorted frame to frame, so it runs near-linear.
  _sortByDepth(entries, idx, depth, n) {
    const cam = this._camera;
    if (!cam) return;
    const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
    for (let i = 0; i < n; i++) {
      const p = entries[idx[i]].sp.position;
      const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
      depth[idx[i]] = dx * dx + dy * dy + dz * dz;
    }
    for (let i = 1; i < n; i++) {
      const v = idx[i]; let j = i - 1;
      while (j >= 0 && depth[idx[j]] < depth[v]) { idx[j + 1] = idx[j]; j--; }
      idx[j + 1] = v;
    }
  }
  // Write `entries[idx[0..n)]` into a batched Points geometry's
  // attributes, in sort order. drawRange covers live entries only, so
  // dead slots cost nothing on the GPU.
  _writeBatch(geo, posA, colA, sizeA, opA, entries, idx, n) {
    for (let i = 0; i < n; i++) {
      const s = entries[idx[i]];
      const p = s.sp.position, sc = s.sp.scale, c = s.sp.material.color;
      posA[i * 3] = p.x; posA[i * 3 + 1] = p.y; posA[i * 3 + 2] = p.z;
      colA[i * 3] = c.r; colA[i * 3 + 1] = c.g; colA[i * 3 + 2] = c.b;
      sizeA[i * 2] = sc.x; sizeA[i * 2 + 1] = sc.y;
      opA[i] = s.sp.material.opacity;
    }
    geo.setDrawRange(0, n);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aColor.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    geo.attributes.aOpacity.needsUpdate = true;
  }
  // Write the live pool sprites and the visible external sprites into
  // their batched Points attributes.
  _writeSpriteBatch() {
    const n = this._sLive.length;
    for (let i = 0; i < n; i++) this._sSorted[i] = this._sLive[i];
    this._sortByDepth(this.spritePool, this._sSorted, this._sDepth, n);
    this._writeBatch(this.spritePoints.geometry, this._sPosAttr, this._sColAttr, this._sSizeAttr, this._sOpAttr, this.spritePool, this._sSorted, n);
    let en = 0;
    for (let i = 0; i < this._extNext; i++) if (this.extPool[i].sp.visible) this._eSorted[en++] = i;
    this._sortByDepth(this.extPool, this._eSorted, this._eDepth, en);
    this._writeBatch(this.extPoints.geometry, this._ePosAttr, this._eColAttr, this._eSizeAttr, this._eOpAttr, this.extPool, this._eSorted, en);
    if (this._renderer && this._camera) {
      const h = this._renderer.getDrawingBufferSize(new THREE.Vector2()).y;
      this._spriteMat.uniforms.uScale.value = (h * 0.5) / Math.tan(THREE.MathUtils.degToRad(this._camera.fov * 0.5));
    }
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
    // v1.6.0 mass discipline (27 Nov): a magazine detonation on a
    // 120,000 t ship is a tremor, not a jolt (was +14).
    this.shake = Math.min(18, this.shake + 5);
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
    // v1.6.0 mass discipline (27 Nov): a bomb hit on a 120,000 t ship
    // is a tremor, not a jolt (was +10).
    this.shake = Math.min(18, this.shake + 3);
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

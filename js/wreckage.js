// wreckage.js — v1.4.0 (item 6): floating wreckage / persistent debris.
//
// Hurricane's version (index.html v11.5/v11.27, and the jet wreck in
// v11.28) left dark debris sprites on the surface where a ship went
// down — but only for 30 s (spawnSprite life 30), plus one oil slick
// for a crashed jet. Helicarriers inherited the short end of that:
// an intact carrier's sinking branch left six dark sprites with life
// 30, and breakup pieces simply vanished when their 30 s sink
// finished. This module replaces the vanishing with wreckage that
// persists for the rest of the round.
//
// What a wreck leaves:
//   - debris chunks: low-poly scorched/rust/grey hull fragments
//     (boxes, flat plates, a few jagged tetrahedra), half-submerged,
//     bobbing on the Gerstner waves, slowly tumbling;
//   - an oil slick: a flat radial-gradient sheen on the water that
//     grows (spreads) and thins over minutes, never vanishing;
//   - drift: the whole field rides a steady surface current
//     (~0.3 m/s, a touch faster in rougher stages — Hurricane's
//     debris rode state.curX/curZ at half rate; here the current is
//     a fixed vector plus the local wave push) and spreads as the
//     chunks' initial outward velocities decay slowly.
// Breakup pieces each leave their own field where they sank, so a
// shattered carrier leaves several separate wreck sites along her
// track instead of one pile.
//
// Scale: Hurricane ran 1 unit ≈ 5.74 m, so its 3.5 x szF debris
// sprite (szF = len/42 ≈ 7.9 for a 333 m carrier) was ~28 units ≈
// 160 m across — a whole debris FIELD, not one chunk. Here the field
// is built from real chunks instead: 6–20 m fragments scattered over
// an ellipse ~240 m long (intact) or ~50 m across (per piece), with
// the oil slick at Hurricane's field scale (radius 45–55 m intact,
// growing to ~2x).
//
// Performance / caps: chunk and slick meshes are PREALLOCATED pools
// (96 chunks, 12 slicks — shared geometries/materials, so a wreck
// costs no new GPU resources) and fields are capped at 12 (one per
// slick). When a new field would overflow the pools, the OLDEST
// field is reclaimed whole — wreckage never accumulates unboundedly
// across many kills in a long round, and a fresh kill always has
// room. Total extra draw calls ≤ 108, and only while wrecks exist.
//
// Interaction: visual + drift only. Wreckage is NOT in
// collisions.js (which already treats breakup pieces as debris, not
// obstacles, and only hulls while alive/falling/sinking as solid) —
// a live carrier or jet sails straight through a wreck field
// untouched, exactly as it sailed through the old debris sprites.
import * as THREE from 'three';

export const WRECK_MAX_CHUNKS = 96;
export const WRECK_MAX_SLICKS = 12;
export const WRECK_MAX_FIELDS = 12; // one per slick in the pool —
// a full 8-carrier breakup round spawns far more fields than this,
// so the oldest are still reclaimed, but a normal round (one field
// per sunk carrier, intact or in pieces) keeps every wreck.
// Intact carrier: 10 chunks over a hull-length ellipse. Per breakup
// piece: 4 chunks in a tight cluster at the piece's sink point.
export const WRECK_CHUNKS_INTACT = 10;
export const WRECK_CHUNKS_PER_PIECE = 4;

function makeOilTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 8, 128, 128, 128);
  grad.addColorStop(0, 'rgba(8,8,14,0.92)');
  grad.addColorStop(0.45, 'rgba(16,12,10,0.78)');
  grad.addColorStop(0.75, 'rgba(24,18,22,0.45)');
  grad.addColorStop(1, 'rgba(20,16,20,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  // Iridescent streaks: a few thin pale-blue/violet arcs near the rim,
  // and dark blotches so the sheen reads as oil, not a flat disc.
  g.globalAlpha = 0.35;
  for (let i = 0; i < 9; i++) {
    const a0 = Math.random() * Math.PI * 2;
    g.strokeStyle = i % 2 ? '#5a6a8a' : '#7a5a7a';
    g.lineWidth = 2 + Math.random() * 4;
    g.beginPath();
    g.arc(128, 128, 70 + Math.random() * 45, a0, a0 + 0.6 + Math.random() * 0.9);
    g.stroke();
  }
  g.globalAlpha = 0.5;
  for (let i = 0; i < 14; i++) {
    g.fillStyle = '#050508';
    g.beginPath();
    g.arc(40 + Math.random() * 176, 40 + Math.random() * 176, 4 + Math.random() * 14, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  return t;
}

export class WreckageField {
  constructor(scene, sea) {
    this.scene = scene;
    this.sea = sea;
    this.group = new THREE.Group();
    this.group.name = 'wreckage';
    scene.add(this.group);
    this.oilTex = makeOilTexture();
    // Shared chunk geometries/materials — one draw setup per chunk,
    // no per-chunk GPU allocation.
    this.chunkGeos = [
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.BoxGeometry(1, 1, 1), // flat plate (scaled thin)
      new THREE.TetrahedronGeometry(1),
    ];
    this.chunkMats = [
      new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9, metalness: 0.3 }), // scorched black
      new THREE.MeshStandardMaterial({ color: 0x33383d, roughness: 0.9, metalness: 0.3 }), // scorched steel (breakup cap colour)
      new THREE.MeshStandardMaterial({ color: 0x4a2c1a, roughness: 0.95, metalness: 0.2 }), // rust
      new THREE.MeshStandardMaterial({ color: 0x5a646e, roughness: 0.8, metalness: 0.4 }), // bare hull grey
    ];
    this.chunkPool = [];
    for (let i = 0; i < WRECK_MAX_CHUNKS; i++) {
      const m = new THREE.Mesh(this.chunkGeos[i % this.chunkGeos.length], this.chunkMats[i % this.chunkMats.length]);
      m.visible = false;
      m.userData.wreck = null;
      this.group.add(m);
      this.chunkPool.push(m);
    }
    this.slickGeo = new THREE.CircleGeometry(1, 40);
    this.slickPool = [];
    for (let i = 0; i < WRECK_MAX_SLICKS; i++) {
      const mat = new THREE.MeshBasicMaterial({ map: this.oilTex, transparent: true, opacity: 0.55, depthWrite: false });
      const m = new THREE.Mesh(this.slickGeo, mat);
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = 1;
      m.visible = false;
      m.userData.wreck = null;
      this.group.add(m);
      this.slickPool.push(m);
    }
    this.fields = []; // {name, born, chunks:[rec], slick, x, z, heading, r0}
    this.spawned = 0; // lifetime count (probes / dbgInfo)
  }
  // Current the fields drift on: steady, ~0.3 m/s in Calm, a touch
  // faster as the stage wind rises (STAGES wind 5/10/15/20). The
  // local wave push is added per chunk in update() for variation.
  current() {
    const wind = this.sea && this.sea.stageIdx !== undefined
      ? [5, 10, 15, 20][this.sea.stageIdx] || 5 : 5;
    return { x: 0.20 + wind * 0.012, z: 0.10 + wind * 0.004 };
  }
  _allocChunk() {
    for (const m of this.chunkPool) if (!m.visible) return m;
    return null;
  }
  _allocSlick() {
    for (const m of this.slickPool) if (!m.visible) return m;
    return null;
  }
  _reclaimOldest() {
    const f = this.fields.shift();
    if (!f) return false;
    for (const rec of f.chunks) { rec.mesh.visible = false; rec.mesh.userData.wreck = null; }
    if (f.slick) { f.slick.visible = false; f.slick.userData.wreck = null; }
    return true;
  }
  // Spawn one wreck field. opts: {name, heading, along (field half-length
  // along the hull, m), across (half-width, m), chunks, slickR0 (oil
  // radius at birth, m), vx, vz (inherited surface velocity, m/s)}.
  // Returns the field record, or null if the pools are exhausted even
  // after reclaiming (cannot happen while fields exist — reclaim frees
  // whole fields — but a single huge request is clamped, never fatal).
  spawn(x, z, opts = {}) {
    const n = Math.min(opts.chunks || WRECK_CHUNKS_INTACT, WRECK_MAX_CHUNKS);
    // Make room: reclaim oldest fields until the pool holds this field.
    let free = this.chunkPool.filter(m => !m.visible).length;
    let guard = 0;
    while (free < n && this.fields.length && guard++ < WRECK_MAX_FIELDS + 1) {
      this._reclaimOldest();
      free = this.chunkPool.filter(m => !m.visible).length;
    }
    if (this.fields.length >= WRECK_MAX_FIELDS) this._reclaimOldest();
    const heading = opts.heading || 0;
    const along = opts.along || 120, across = opts.across || 35;
    const fx = Math.sin(heading), fz = -Math.cos(heading);
    const rx = Math.cos(heading), rz = Math.sin(heading);
    const field = {
      name: opts.name || 'wreck', born: opts.born !== undefined ? opts.born : 0,
      chunks: [], slick: null, x, z, heading, r0: opts.slickR0 || 45,
    };
    for (let i = 0; i < n; i++) {
      const mesh = this._allocChunk();
      if (!mesh) break;
      // Scatter along the hull axis (elongated ellipse), denser near
      // the centre; a couple of big hull plates, the rest small frags.
      const a = (Math.random() * 2 - 1), b = (Math.random() * 2 - 1);
      const da = a * along * (0.35 + 0.65 * Math.abs(a));
      const db = b * across * (0.4 + 0.6 * Math.abs(b));
      const cx = x + fx * da + rx * db;
      const cz = z + fz * da + rz * db;
      const big = i < 2;
      const len = big ? 22 + Math.random() * 12 : 5 + Math.random() * 13;
      const wid = big ? 8 + Math.random() * 5 : 3 + Math.random() * 6;
      const thk = 1.5 + Math.random() * 2;
      mesh.scale.set(len, thk, wid);
      mesh.position.set(cx, 0, cz);
      mesh.rotation.set((Math.random() - 0.5) * 0.25, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.25);
      mesh.visible = true;
      mesh.userData.wreck = field;
      // Outward spread velocity (decays slowly) + inherited velocity
      // from the sinking hull/piece, so the field visibly spreads in
      // the first minutes instead of sitting as one pile.
      const oa = Math.atan2(cx - x, cz - z);
      const spread = 0.3 + Math.random() * 1.2;
      field.chunks.push({
        mesh, x: cx, z: cz,
        vx: (opts.vx || 0) * 0.3 + Math.sin(oa) * spread,
        vz: (opts.vz || 0) * 0.3 + Math.cos(oa) * spread,
        yaw: mesh.rotation.y, yawRate: Math.max(-0.2 / len, Math.min(0.2 / len, (Math.random() - 0.5) * 0.05)),
        bobPhase: Math.random() * Math.PI * 2, bobAmp: 0.25 + Math.random() * 0.35,
        thk, len, wid,
      });
    }
    const slick = this._allocSlick();
    if (slick) {
      slick.position.set(x, 0.3, z);
      slick.scale.set(field.r0, field.r0, 1);
      slick.material.opacity = 0.55;
      slick.visible = true;
      slick.userData.wreck = field;
      field.slick = slick;
    }
    this.fields.push(field);
    this.spawned++;
    return field;
  }
  update(dt, time) {
    if (!this.fields.length || dt <= 0) return;
    // Throttle: stepSim substeps (up to 16/frame at timescale 8) must
    // not each pay the wave-field cost — update at most every 0.1 s
    // of game time, with the elapsed game time as the effective dt.
    if (this._lastT !== undefined && time - this._lastT < 0.1) return;
    const effDt = this._lastT === undefined ? dt : Math.min(1, time - this._lastT);
    this._lastT = time;
    dt = effDt;
    const cur = this.current();
    for (const f of this.fields) {
      const age = Math.max(0, time - f.born);
      // Oil spreads and thins: radius grows ~0.10 m/s to ~2.2x birth
      // radius over ~10 min, opacity eases 0.55 -> 0.42 and holds —
      // it never fades out (persistence is the point).
      if (f.slick && f.slick.visible) {
        const r = Math.min(f.r0 * 2.2, f.r0 + age * 0.10);
        f.slick.scale.set(r, r, 1);
        f.slick.material.opacity = Math.max(0.42, 0.55 - age * 0.0002);
        const sh = this.sea.waveHeight(f.slick.position.x, f.slick.position.z, time);
        f.slick.position.y = sh + 0.35;
        // The slick drifts with the current too (slower than chunks —
        // oil rides the surface film, not the chop).
        f.slick.position.x += cur.x * 0.6 * dt;
        f.slick.position.z += cur.z * 0.6 * dt;
        f.x = f.slick.position.x; f.z = f.slick.position.z;
      }
      let sx = 0, sz = 0;
      for (const rec of f.chunks) {
        // Spread velocity decays with a ~60 s time constant; the
        // steady current + a whisper of the local wave push keep the
        // field moving after the spread dies away.
        const drag = Math.exp(-dt / 60);
        rec.vx *= drag; rec.vz *= drag;
        const push = this.sea.wavePush(rec.x, rec.z, time);
        rec.x += (rec.vx + cur.x + push.x * 0.3) * dt;
        rec.z += (rec.vz + cur.z + push.z * 0.3) * dt;
        // v1.4.0 mass (audit F12): NO fixed-frequency bob term — the
        // old sin(time·0.5) forced every chunk, 6 m or 26 m, onto one
        // 12.6 s period. Instead the wave is sampled at 2–3 points
        // along the chunk's length and averaged: a 26 m plate does
        // not rise and fall with a 12 m wavelength wave, a 6 m
        // fragment does. Tilt comes from the local wave slope, scaled
        // down with size; freeboard from thickness (a 3 m plate sits
        // ~1.8 m down, ~1.2 m showing); yaw rate capped at 0.2/L.
        const len = rec.len || 10;
        const fx = Math.sin(rec.yaw), fz = Math.cos(rec.yaw);
        const wh0 = this.sea.waveHeight(rec.x, rec.z, time);
        const whA = this.sea.waveHeight(rec.x + fx * len * 0.25, rec.z + fz * len * 0.25, time);
        const whB = this.sea.waveHeight(rec.x - fx * len * 0.25, rec.z - fz * len * 0.25, time);
        const wh = (wh0 + whA + whB) / 3;
        const od = this.sea.getOceanDataAt(rec.x, rec.z, time);
        const tiltScale = Math.min(1, 10 / len); // small fragments follow the slope, big plates average it out
        rec.yaw += Math.max(-0.2 / len, Math.min(0.2 / len, rec.yawRate)) * dt;
        rec.mesh.position.set(rec.x, wh - rec.thk * 0.6, rec.z);
        rec.mesh.rotation.y = rec.yaw;
        rec.mesh.rotation.x = od.slopeZ * tiltScale;
        rec.mesh.rotation.z = -od.slopeX * tiltScale;
        sx += rec.x; sz += rec.z;
      }
      if (f.chunks.length) { f.cx = sx / f.chunks.length; f.cz = sz / f.chunks.length; }
      else if (f.slick) { f.cx = f.slick.position.x; f.cz = f.slick.position.z; }
    }
  }
  get chunkCount() { return this.chunkPool.filter(m => m.visible).length; }
  get slickCount() { return this.slickPool.filter(m => m.visible).length; }
  clear() {
    for (const f of this.fields) {
      for (const rec of f.chunks) { rec.mesh.visible = false; rec.mesh.userData.wreck = null; }
      if (f.slick) { f.slick.visible = false; f.slick.userData.wreck = null; }
    }
    this.fields.length = 0;
  }
  // Probe/debug summary: per-field centroid (drift-measurable),
  // chunk/slick counts, slick radii, ages.
  summary(time) {
    return {
      fields: this.fields.length, chunks: this.chunkCount, slicks: this.slickCount,
      spawned: this.spawned,
      caps: { chunks: WRECK_MAX_CHUNKS, slicks: WRECK_MAX_SLICKS, fields: WRECK_MAX_FIELDS },
      list: this.fields.map(f => ({
        name: f.name, age: time !== undefined ? +(time - f.born).toFixed(1) : null,
        chunks: f.chunks.length, slick: !!f.slick,
        slickR: f.slick ? +f.slick.scale.x.toFixed(1) : 0,
        cx: f.cx !== undefined ? +f.cx.toFixed(1) : +f.x.toFixed(1),
        cz: f.cz !== undefined ? +f.cz.toFixed(1) : +f.z.toFixed(1),
        x: +f.x.toFixed(1), z: +f.z.toFixed(1),
      })),
    };
  }
}

// carrier.js — SHIELD helicarrier: GLB load/normalise, per-zone damage model,
// lift layer, gravity freefall, multi-piece breakup, sinking.
// Scale: 1 unit = 1 m. Helicarrier normalised to 333 m (Pandora), bow -Z
// (GLB bow is +Z, so the inner group is rotated PI — the Hurricane
// convention: heading 0 = -Z, forward = (sin h, 0, -cos h), mesh yaw = -heading).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
// Models are embedded as base64 JS modules (Pandora-style) because the
// GitHub snapshot-push route only accepts UTF-8 text files — no binary .glb
// files are shipped. See assets/ASSETS.md.
import { HELICARRIER_B64 } from '../assets/helicarrier.b64.js';
import { FA18_B64 } from '../assets/fa18.b64.js';

export const CARRIER_LEN = 333;
export const GRAV = 9.81;
const ZONE_HP = { pod: 100, reactor: 150, magazine: 120, bridge: 100, deck: 120, engines: 150 };

let _loader = null;
function loader() {
  if (!_loader) { _loader = new GLTFLoader(); _loader.setMeshoptDecoder(MeshoptDecoder); }
  return _loader;
}

function hideBadSlabs(obj) {
  obj.traverse(o => {
    if (o.name === 'detail_0' || o.name === 'detail_7') o.visible = false; // Pandora: giant interior shells above the deck
    if (o.isMesh && o.name.startsWith('deck_top')) {
      o.material.side = THREE.DoubleSide;
      o.material.polygonOffset = true; o.material.polygonOffsetFactor = -2;
    }
  });
}

// Normalise a loaded helicarrier GLB scene to 333 m, centred, bow -Z.
// Returns { group, deckLocalY, deckHalfX, deckHalfZ, podLocals }.
export function normalizeHelicarrier(sceneObj) {
  const box = new THREE.Box3().setFromObject(sceneObj);
  const size = box.getSize(new THREE.Vector3());
  const ctr = box.getCenter(new THREE.Vector3());
  const scale = CARRIER_LEN / size.z;
  const inner = new THREE.Group();
  inner.add(sceneObj);
  sceneObj.position.set(-ctr.x, -ctr.y, -ctr.z);
  inner.scale.setScalar(scale);
  inner.rotation.y = Math.PI; // bow +Z (GLB) -> bow -Z (game)
  const group = new THREE.Group();
  group.add(inner);
  group.updateMatrixWorld(true);
  hideBadSlabs(group);
  // Deck geometry measured from the deck_top_* meshes in group coords.
  let deckBox = null;
  const podLocals = [];
  group.traverse(o => {
    if (o.isMesh && o.name.startsWith('deck_top')) {
      const b = new THREE.Box3().setFromObject(o);
      deckBox = deckBox ? deckBox.union(b) : b;
    }
  });
  const deckLocalY = deckBox ? deckBox.max.y : (29.78 - ctr.y) * scale;
  const deckHalfX = deckBox ? (deckBox.max.x - deckBox.min.x) / 2 : 34;
  const deckHalfZ = deckBox ? (deckBox.max.z - deckBox.min.z) / 2 : 160;
  // Pod centres from the duct_ring_* meshes (group coords).
  const rings = [];
  group.traverse(o => {
    if (o.isMesh && o.name.startsWith('duct_ring')) {
      const b = new THREE.Box3().setFromObject(o);
      rings.push(b.getCenter(new THREE.Vector3()));
    }
  });
  rings.sort((a, b) => (a.z - b.z) || (a.x - b.x));
  for (const r of rings) podLocals.push({ x: r.x, z: r.z });
  while (podLocals.length < 4) podLocals.push({ x: (podLocals.length % 2 ? -40 : 40), z: (podLocals.length < 2 ? -70 : 70) });
  return { group, deckLocalY, deckHalfX, deckHalfZ, podLocals: podLocals.slice(0, 4), scale };
}

export function normalizeJet(sceneObj) {
  const box = new THREE.Box3().setFromObject(sceneObj);
  const size = box.getSize(new THREE.Vector3());
  const ctr = box.getCenter(new THREE.Vector3());
  const scale = 18.79 / size.z;
  const inner = new THREE.Group();
  inner.add(sceneObj);
  sceneObj.position.set(-ctr.x, -ctr.y, -ctr.z);
  inner.scale.setScalar(scale);
  inner.rotation.y = Math.PI; // nose +Z (GLB) -> nose -Z (game)
  const group = new THREE.Group();
  group.add(inner);
  group.traverse(o => { if (o.name === 'helmet.002') o.visible = false; });
  return { group, scale };
}

// Decode a base64 string to an ArrayBuffer (atob -> binary string -> bytes).
function b64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export async function loadModels() {
  const [heli, jet] = await Promise.all([
    loader().parseAsync(b64ToArrayBuffer(HELICARRIER_B64), ''),
    loader().parseAsync(b64ToArrayBuffer(FA18_B64), ''),
  ]);
  return { heli: normalizeHelicarrier(heli.scene), jet: normalizeJet(jet.scene) };
}

// Tint a cloned carrier group for the enemy side (crimson hull/island/pods).
export function applyEnemyLivery(group) {
  group.traverse(o => {
    if (!o.isMesh) return;
    o.material = o.material.clone();
    const n = o.name;
    if (n.startsWith('hull_') || n.startsWith('island_') || n.startsWith('pod_housing_')) {
      o.material.color.setHex(0x7a2e26);
    } else if (n.startsWith('duct_ring_')) {
      o.material.color.setHex(0x4a1a16);
    }
  });
}

export class BreakupPiece {
  constructor(scene, group, vy, rollRate, pitchRate, yawRate) {
    this.group = group; this.scene = scene;
    this.vy = vy; this.rollRate = rollRate; this.pitchRate = pitchRate; this.yawRate = yawRate;
    this.state = 'falling'; this.sinkT = 0; this.y = group.position.y;
    this.roll = group.rotation.z; this.pitch = group.rotation.x; this.heading = -group.rotation.y;
    this.impactY = 0; this.bubbleT = 0; this.boilT = 0;
    scene.add(group);
  }
  update(dt, ctx) {
    if (this.state === 'falling') {
      const vt = 45;
      this.vy += (-vt - this.vy) * Math.min(1, dt / 2.5);
      this.y += this.vy * dt;
      this.roll += this.rollRate * dt; this.pitch += this.pitchRate * dt; this.heading += this.yawRate * dt;
      this.group.position.y = this.y;
      this.group.rotation.set(this.pitch, -this.heading, this.roll);
      const seaH = ctx.sea.waveHeight(this.group.position.x, this.group.position.z, ctx.time);
      if (this.y <= seaH + 1) {
        this.state = 'sinking'; this.sinkT = 0; this.impactY = seaH;
        ctx.vfx.splash(this.group.position.x, seaH, this.group.position.z, Math.abs(this.vy));
        ctx.vfx.burst(this.group.position.x, seaH + 2, this.group.position.z, 30, [0.9, 0.9, 0.9], 8, 6);
      }
    } else if (this.state === 'sinking') {
      this.sinkT += dt / 30;
      const f = Math.min(1, this.sinkT);
      this.group.position.y = this.impactY - f * f * 55;
      this.roll += (0.4 - this.roll) * dt * 0.5;
      this.group.rotation.z = this.roll;
      this.bubbleT -= dt;
      if (this.bubbleT <= 0) { this.bubbleT = 0.12; ctx.vfx.bubbles(this.group.position.x, this.impactY, this.group.position.z, 4, 60); }
      this.boilT -= dt;
      if (this.boilT <= 0 && f > 0.1 && f < 0.9) { this.boilT = 0.4; ctx.vfx.boil(this.group.position.x, this.impactY, this.group.position.z, 40); }
      if (f >= 1) { this.state = 'gone'; this.group.visible = false; }
    }
  }
  get gone() { return this.state === 'gone'; }
}

let _carrierSeq = 0;

export class Helicarrier {
  constructor(opts) {
    // opts: { template, side:'player'|'enemy', name, x, z, heading, alt, vfx }
    this.id = ++_carrierSeq;
    this.side = opts.side;
    this.name = opts.name;
    this.template = opts.template;
    this.group = opts.template.group.clone(true);
    if (opts.side === 'enemy') applyEnemyLivery(this.group);
    this.deckLocalY = opts.template.deckLocalY;
    this.deckHalfX = opts.template.deckHalfX;
    this.deckHalfZ = opts.template.deckHalfZ;
    this.x = opts.x; this.z = opts.z; this.y = opts.alt;
    this.heading = opts.heading;
    this.targetAlt = opts.alt;
    this.vy = 0; this.vx = 0; this.vz = 0;
    this.forwardSpeed = 0; this.rudder = 0; // -1..1
    this.rudderDeg = 0;
    this.telegraphIdx = 5; // ALL STOP
    this.spoolSpeed = 0;
    this.roll = 0; this.pitch = 0; this.list = 0;
    this.yawRate = 0;
    this.slot = { dx: 0, dz: 0, dy: 0 };
    this.avoidUntil = 0; this.avoidOther = null; // post-impact avoidance window (collisions.js NEW-1)
    this.state = 'alive'; // alive | falling | sinking | gone
    this.fallT = 0; this.sinkT = 0; this.impactY = 0;
    this.fallRollRate = 0; this.fallPitchRate = 0; this.fallYawRate = 0;
    this.breakupT = 0; this.pieces = [];
    this.scorches = [];
    // Zones
    this.pods = opts.template.podLocals.map(p => ({ hp: ZONE_HP.pod, alive: true, local: p, meshes: [], disc: null }));
    this._assignPodMeshes();
    this.zones = {
      reactor: { hp: ZONE_HP.reactor, max: ZONE_HP.reactor },
      magazine: { hp: ZONE_HP.magazine, max: ZONE_HP.magazine },
      bridge: { hp: ZONE_HP.bridge, max: ZONE_HP.bridge },
      deck: { hp: ZONE_HP.deck, max: ZONE_HP.deck },
      engines: { hp: ZONE_HP.engines, max: ZONE_HP.engines },
    };
    this.fires = []; // {zone, lx, lz, intensity, t}
    this.fireT = 0; this.hurtT = 0;
    this.group.position.set(this.x, this.y, this.z);
    this.group.rotation.set(0, -this.heading, 0);
    this.group.userData.carrier = this;
    this.wing = null; // set by game (AirWing)
  }
  _assignPodMeshes() {
    const podMeshes = [];
    this.group.traverse(o => {
      if (o.isMesh && (o.name.startsWith('pod_housing_') || o.name.startsWith('rotor_disc_') || o.name.startsWith('rotor_hub_') || o.name.startsWith('duct_ring_'))) {
        const b = new THREE.Box3().setFromObject(o);
        const c = b.getCenter(new THREE.Vector3());
        podMeshes.push({ o, c });
      }
    });
    for (const pm of podMeshes) {
      let best = null, bd = 1e9;
      this.pods.forEach((p, i) => {
        const d = (pm.c.x - p.local.x) ** 2 + (pm.c.z - p.local.z) ** 2;
        if (d < bd) { bd = d; best = i; }
      });
      if (best !== null) {
        this.pods[best].meshes.push(pm.o);
        if (pm.o.name.startsWith('rotor_disc_')) this.pods[best].disc = pm.o;
      }
    }
  }
  get lift() { return this.pods.filter(p => p.alive).length / 4; }
  get alive() { return this.state === 'alive'; }
  get totalHp() {
    let s = this.pods.reduce((a, p) => a + Math.max(0, p.hp), 0);
    for (const k in this.zones) s += Math.max(0, this.zones[k].hp);
    return s;
  }
  get maxHp() { return 4 * ZONE_HP.pod + ZONE_HP.reactor + ZONE_HP.magazine + ZONE_HP.bridge + ZONE_HP.deck + ZONE_HP.engines; }
  get hpFrac() { return this.totalHp / this.maxHp; }
  get engineFactor() { const f = this.zones.engines.hp / this.zones.engines.max; return 0.2 + 0.8 * Math.max(0, f); }
  get steeringFactor() { const f = this.zones.bridge.hp / this.zones.bridge.max; return f <= 0 ? 0.25 : f < 0.5 ? 0.4 : 1; }
  get deckFactor() { const f = this.zones.deck.hp / this.zones.deck.max; return f; }
  get canLaunch() { return this.alive && this.deckFactor >= 0.3; }
  deckTopY() { return this.y + this.deckLocalY; }
  deckPoint(lx, lz) {
    return this.group.localToWorld(new THREE.Vector3(lx, this.deckLocalY, lz));
  }
  localFromWorld(x, z) {
    const v = this.group.worldToLocal(new THREE.Vector3(x, this.y, z));
    return { lx: v.x, lz: v.z };
  }
  deckContains(lx, lz) { return Math.abs(lx) <= this.deckHalfX && Math.abs(lz) <= this.deckHalfZ; }
  deckHeightAt(x, z) {
    if (!this.alive) return -Infinity;
    const l = this.localFromWorld(x, z);
    return this.deckContains(l.lx, l.lz) ? this.deckTopY() : -Infinity;
  }
  velocityAt(x, z) {
    const fx = Math.sin(this.heading), fz = -Math.cos(this.heading);
    const rx = Math.cos(this.heading), rz = Math.sin(this.heading);
    const dx = x - this.x, dz = z - this.z;
    const rAlong = dx * fx + dz * fz, rAcross = dx * rx + dz * rz;
    return {
      x: this.vx - rz * this.yawRate * rAlong + fz * 0, // yawRate x r, simplified
      z: this.vz + rx * this.yawRate * rAlong,
      _across: rAcross,
    };
  }
  // Map a hit in carrier-local coords to a damage zone.
  zoneAt(lx, lz, fromAbove) {
    const along = -lz / (CARRIER_LEN / 2); // +1 = bow, -1 = stern
    if (along > 0.5) return 'magazine';
    if (along < -0.55) return 'engines';
    if (lx >= -32 && lx <= -10 && lz >= 61 && lz <= 84) return 'bridge';
    if (lx >= -20 && lx <= 20 && lz >= -40 && lz <= 40) return 'reactor';
    if (fromAbove && Math.random() < 0.35) return 'deck';
    let best = null, bd = 1e9;
    this.pods.forEach((p, i) => {
      if (!p.alive) return;
      const d = (lx - p.local.x) ** 2 + (lz - p.local.z) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    if (best !== null && bd < 90 * 90) return 'pod:' + best;
    return 'deck';
  }
  damage(amount, lx, lz, fromAbove, ctx, opts) {
    if (this.state !== 'alive') return;
    const zoneKey = this.zoneAt(lx, lz, fromAbove);
    const wp = this.deckPoint(Math.max(-this.deckHalfX, Math.min(this.deckHalfX, lx)), Math.max(-this.deckHalfZ, Math.min(this.deckHalfZ, lz)));
    const szF = CARRIER_LEN / 42;
    const magHit = zoneKey === 'magazine';
    // Collision grind ticks pass { quiet: true } — zone damage only, no
    // hit flash/scorch per tick (the collision code sparks instead).
    // { noIgnite: true } keeps light collision bumps from starting fires.
    if (!opts || !opts.quiet) {
      ctx.vfx.hitFX(wp.x, wp.y + 4, wp.z, amount, szF, magHit);
      this.scorches.push(ctx.vfx.addScorch(this.group, lx, this.deckLocalY + 1, lz, 14));
      if (this.scorches.length > 20) { const s = this.scorches.shift(); this.group.remove(s); }
    }
    let detonate = false;
    if (zoneKey.startsWith('pod:')) {
      const pod = this.pods[+zoneKey.split(':')[1]];
      pod.hp -= amount;
      if (pod.hp <= 0 && pod.alive) {
        pod.alive = false;
        pod.meshes.forEach(m => { m.visible = false; });
        ctx.vfx.burst(wp.x, wp.y, wp.z, 40, [1, 0.6, 0.2], 10, 6);
        this.ignite('pod:' + this.pods.indexOf(pod), lx, lz);
        ctx.msg(`${this.name}: lift pod destroyed — lift ${(this.lift * 100) | 0}%`);
      }
    } else {
      const z = this.zones[zoneKey];
      const before = z.hp;
      z.hp = Math.max(0, z.hp - amount);
      if (amount >= 8 && !(opts && opts.noIgnite)) this.ignite(zoneKey, lx, lz);
      if (zoneKey === 'magazine' && amount >= 15 && (z.hp <= 0 || this.hpFrac <= 0.5)) detonate = true;
      if (zoneKey === 'reactor') {
        if (z.hp <= 0) detonate = true;
        else if (z.hp < 45 && Math.random() < 0.2) detonate = true; // damaged reactor: explosion risk
      }
      if (zoneKey === 'bridge' && z.hp <= 0) ctx.msg(`${this.name}: bridge destroyed — steering degraded`);
      if (zoneKey === 'deck' && z.hp <= 0) ctx.msg(`${this.name}: flight deck wrecked — cannot launch`);
      if (zoneKey === 'engines' && z.hp <= 0) ctx.msg(`${this.name}: engines destroyed — speed lost`);
      if (before > 0 && z.hp <= 0) ctx.vfx.burst(wp.x, wp.y, wp.z, 30, [1, 0.5, 0.1], 8, 5);
    }
    if (detonate) { this.detonate(ctx, zoneKey); return; }
    // Structural failure: total zone HP exhausted, or all pods dead.
    if (this.lift <= 0 || this.hpFrac <= 0.12) {
      this.startFall(ctx, this.lift <= 0 ? 'all lift pods lost' : 'structural failure');
    }
  }
  ignite(zoneKey, lx, lz) {
    if (this.fires.some(f => f.zone === zoneKey)) return;
    if (this.fires.length >= 6) return; // one fire per zone, max 6 concurrent
    this.fires.push({ zone: zoneKey, lx, lz, intensity: 0.5, t: 0 });
  }
  detonate(ctx, zoneKey) {
    ctx.vfx.magazineSecondary(this.x, this.y, this.z, CARRIER_LEN / 42);
    ctx.msg(`${this.name}: ${zoneKey === 'reactor' ? 'REACTOR' : 'MAGAZINE'} DETONATION`);
    this.breakUp(ctx, 'detonation');
  }
  startFall(ctx, reason) {
    if (this.state !== 'alive') return;
    this.state = 'falling';
    this.fallT = 0;
    this.vy = 0;
    const deadX = this.pods.filter(p => !p.alive).reduce((a, p) => a + p.local.x, 0);
    this.fallRollRate = (deadX >= 0 ? 1 : -1) * (0.06 + 0.1 * (1 - this.lift)) + (Math.random() - 0.5) * 0.05;
    this.fallPitchRate = (Math.random() - 0.5) * 0.08;
    this.fallYawRate = (Math.random() - 0.5) * 0.05;
    ctx.msg(`${this.name} is FALLING — ${reason}`);
    if (this.wing) this.wing.handleCarrierFalling(ctx);
  }
  // Split into 2-3 tumbling pieces (Hurricane splitShip clipping-plane trick,
  // extended: each piece is a clone with 1-2 world-space clipping planes).
  breakUp(ctx, reason) {
    if (this.state === 'gone') return;
    const wasAlive = this.state === 'alive';
    const fallVy = this.state === 'falling' ? this.vy : -5; // capture before state flips
    this.state = 'gone';
    this.group.visible = false;
    // Object3D.clone() JSON-deep-clones userData; group.userData.carrier
    // points back at this Helicarrier (which owns the group) — a cycle
    // that throws "Converting circular structure to JSON" and kills the
    // breakup mid-way (carrier vanishes, zero pieces). Strip it first;
    // the original is dead and no longer needs click-pick identity.
    this.group.userData.carrier = undefined;
    const fwd = { x: Math.sin(this.heading), z: -Math.cos(this.heading) };
    const cx = this.x, cz = this.z;
    const mkPiece = (planes, rollRate, pitchRate) => {
      const clone = this.group.clone(true);
      clone.visible = true;
      clone.traverse(o => {
        if (o.isMesh) {
          o.material = o.material.clone();
          o.material.clippingPlanes = planes.map(p => new THREE.Plane(new THREE.Vector3(p.nx, 0, p.nz), p.c));
        }
      });
      clone.position.set(this.x, this.y, this.z);
      clone.rotation.set(this.pitch, -this.heading, this.roll);
      const piece = new BreakupPiece(ctx.scene, clone, fallVy, rollRate, pitchRate, (Math.random() - 0.5) * 0.1);
      this.pieces.push(piece);
    };
    // Bow piece: keep forward side of the cut plane through the centre.
    mkPiece([{ nx: fwd.x, nz: fwd.z, c: -(fwd.x * cx + fwd.z * cz) }], 0.25 + Math.random() * 0.2, 0.1);
    // Stern piece: keep aft side.
    mkPiece([{ nx: -fwd.x, nz: -fwd.z, c: (fwd.x * cx + fwd.z * cz) }], -0.25 - Math.random() * 0.2, -0.1);
    // Mid piece (only if the carrier was still flying — a 3-way split).
    if (wasAlive && Math.random() < 0.6) {
      mkPiece([
        { nx: fwd.x, nz: fwd.z, c: -(fwd.x * cx + fwd.z * cz) + 45 },
        { nx: -fwd.x, nz: -fwd.z, c: (fwd.x * cx + fwd.z * cz) + 45 },
      ], (Math.random() - 0.5) * 0.5, 0.3);
    }
    ctx.vfx.magazineSecondary(this.x, this.y, this.z, CARRIER_LEN / 42);
    ctx.msg(`${this.name} broke up ${reason ? '(' + reason + ')' : ''} — ${this.pieces.length} pieces falling`);
    if (this.wing) this.wing.handleCarrierFalling(ctx);
    if (ctx.onCarrierLost) ctx.onCarrierLost(this);
  }
  update(dt, ctx) {
    // Breakup pieces always update.
    for (const p of this.pieces) p.update(dt, ctx);
    this.pieces = this.pieces.filter(p => !p.gone);
    if (this.state === 'gone') return;
    // Rotor spin
    for (const pod of this.pods) {
      if (pod.alive && pod.disc) pod.disc.rotation.y += dt * 22;
    }
    // Fires: drain zone HP, spawn flame/smoke, spread.
    this.fireT -= dt;
    for (const f of this.fires) {
      f.t += dt;
      f.intensity = Math.min(1, f.intensity + dt * 0.05);
      const drain = f.intensity * 2.0 * dt;
      if (f.zone.startsWith('pod:')) {
        const pod = this.pods[+f.zone.split(':')[1]];
        if (pod && pod.alive) { pod.hp -= drain; if (pod.hp <= 0) { pod.alive = false; pod.meshes.forEach(m => { m.visible = false; }); if (this.lift <= 0) this.startFall(ctx, 'last lift pod burned out'); } }
      } else {
        const z = this.zones[f.zone];
        if (z) { z.hp = Math.max(0, z.hp - drain); if (z.hp <= 0 && f.zone === 'reactor') { this.detonate(ctx, 'reactor'); return; } }
      }
      if (this.fireT <= 0) {
        const wp = this.deckPoint(f.lx, f.lz);
        const nFl = 2 + Math.floor(f.intensity * 4);
        for (let i = 0; i < nFl; i++) {
          ctx.vfx.spawnParticle(wp.x + (Math.random() - 0.5) * 6, wp.y + 2, wp.z + (Math.random() - 0.5) * 6,
            (Math.random() - 0.5) * 2, 2 + Math.random() * 2.5, (Math.random() - 0.5) * 2, 0.8, 1, 0.65, 0.2, -0.5);
        }
        const sm = ctx.vfx.spawnSprite(wp.x, wp.y + 8, wp.z, 3.5, 8 + f.intensity * 4, 8 + f.intensity * 4, 0.5, 0x141414, 0.6);
        sm.vy = 3;
      }
      // Spread: every ~5 s, 8% chance to ignite another damaged zone.
      if (f.t > 5 && Math.random() < dt * 0.016) {
        const keys = ['reactor', 'magazine', 'bridge', 'deck', 'engines'];
        const k = keys[Math.floor(Math.random() * keys.length)];
        if (this.zones[k].hp < this.zones[k].max) this.ignite(k, (Math.random() - 0.5) * 40, (Math.random() - 0.5) * 200);
      }
    }
    if (this.fireT <= 0) this.fireT = 0.15;
    // Hurt smoke (no fire): hp < 70% dark smoke, < 40% + embers.
    this.hurtT -= dt;
    if (this.hurtT <= 0 && this.hpFrac < 0.7 && this.state === 'alive') {
      this.hurtT = this.hpFrac < 0.4 ? 0.3 : 0.45;
      const wp = this.deckPoint((Math.random() - 0.5) * 40, (Math.random() - 0.5) * 200);
      const sm = ctx.vfx.spawnSprite(wp.x, wp.y + 6, wp.z, 3.0, 10, 10, 0.4, 0x1a1a1a, 0.5);
      sm.vy = 2.5;
    }

    if (this.state === 'alive') {
      // Lift layer (Pandora lift/list rules, adapted): list toward dead pods.
      const deadX = this.pods.filter(p => !p.alive).reduce((a, p) => a + p.local.x, 0);
      const listTarget = (1 - this.lift) * 0.12 * (deadX >= 0 ? 1 : -1);
      this.list += (listTarget - this.list) * Math.min(1, dt * 0.5);
      this.roll += (this.list - this.roll) * Math.min(1, dt * 2);
      // Altitude hold: climb +15 / descend -10 m/s, ramped; lift<0.6 sinks.
      let climb = 0;
      const dy = this.targetAlt - this.y;
      if (dy > 2) climb = Math.min(15, dy * 0.2);
      else if (dy < -2) climb = Math.max(-10, dy * 0.2);
      if (this.lift < 0.6) climb -= (0.6 - this.lift) * 6;
      this.vy += (climb - this.vy) * Math.min(1, dt * 0.8);
      this.y += this.vy * dt;
      this.group.position.set(this.x, this.y, this.z);
      this.group.rotation.set(this.pitch, -this.heading, this.roll);
    } else if (this.state === 'falling') {
      // GENUINE FREEFALL: gravity, drag toward terminal velocity from
      // mass and remaining lift, attitude from asymmetric lift loss.
      this.fallT += dt;
      const vt = 40 + 30 * this.lift; // terminal velocity, m/s
      const a = GRAV * (1 - this.lift * 0.35);
      this.vy -= a * dt;
      this.vy += (-vt - this.vy) * Math.min(1, dt / 2.5); // drag
      this.y += this.vy * dt;
      this.roll += this.fallRollRate * dt;
      this.pitch += this.fallPitchRate * dt;
      this.heading += this.fallYawRate * dt;
      this.group.position.set(this.x, this.y, this.z);
      this.group.rotation.set(this.pitch, -this.heading, this.roll);
      // Breakup re-check during the fall: structural stress from fall
      // speed + spin + existing damage.
      this.breakupT -= dt;
      if (this.breakupT <= 0) {
        this.breakupT = 0.4;
        const speed = Math.abs(this.vy);
        const stress = (speed / vt) * 0.5 + (1 - this.hpFrac) * 0.5;
        if (speed > 25 && Math.random() < stress * 0.35) { this.breakUp(ctx, 'stressed in the fall'); return; }
      }
      const seaH = ctx.sea.waveHeight(this.x, this.z, ctx.time);
      if (this.y <= seaH + 2) {
        this.state = 'sinking';
        this.sinkT = 0;
        this.impactY = seaH;
        ctx.vfx.splash(this.x, seaH, this.z, Math.abs(this.vy));
        ctx.msg(`${this.name} hit the sea at ${Math.abs(this.vy).toFixed(0)} m/s`);
        if (this.wing) this.wing.handleCarrierSinking(ctx);
      }
    } else if (this.state === 'sinking') {
      // Hurricane sinking sequence (30 s quadratic descent), only AFTER
      // the wreck is in the water — the fall above was gravity, not this.
      this.sinkT += dt / 30;
      const f = Math.min(1, this.sinkT);
      this.y = this.impactY - f * f * 55;
      this.roll += (0.5 - this.roll) * dt * 0.5;
      this.group.position.y = this.y;
      this.group.rotation.z = this.roll;
      this.bubbleT = (this.bubbleT || 0) - dt;
      if (this.bubbleT <= 0) { this.bubbleT = 0.06; ctx.vfx.bubbles(this.x, this.impactY, this.z, 6 + Math.floor(f * 8), 200); }
      this.boilT = (this.boilT || 0) - dt;
      if (this.boilT <= 0 && f > 0.15 && f < 0.9) { this.boilT = 0.3; ctx.vfx.boil(this.x, this.impactY, this.z, 60); }
      if (f >= 1) {
        this.state = 'gone';
        this.group.visible = false;
        ctx.vfx.burst(this.x, this.impactY, this.z, 30, [0.8, 0.9, 1], 4, 4);
        for (let i = 0; i < 6; i++) {
          const s = ctx.vfx.spawnSprite(this.x + (Math.random() - 0.5) * 100, this.impactY + 1, this.z + (Math.random() - 0.5) * 100, 30, 12, 12, 0.1, 0x3a2a1a, 0.7);
          s.vx = (Math.random() - 0.5) * 2; s.vz = (Math.random() - 0.5) * 2;
        }
        if (ctx.onCarrierLost) ctx.onCarrierLost(this);
      }
    }
  }
}

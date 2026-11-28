// carrier.js — SHIELD helicarrier: GLB load/normalise, per-zone damage model,
// lift layer, gravity freefall, multi-piece breakup, sinking.
// Scale: 1 unit = 1 m. Helicarrier normalised to 333 m (Pandora), bow -Z
// (the Hurricane convention: heading 0 = -Z, forward = (sin h, 0, -cos h),
// mesh yaw = -heading).
// v1.4.0: the model is Nicholas's STL (Helicarrier_-_Full_Model, Printables
// "roboticide", CC BY-NC 4.0), decimated 169,723 -> 35,667 tris and
// meshopt-compressed, pre-normalised in the GLB itself (333 m, centred,
// bow -Z) — so normalizeHelicarrier() measures, it does not rescale or
// rotate. The STL replaces the old patch-up approach: its sculpted hull
// IS the hull (no inner core loft), its four fan discs ARE the rotors
// (they spin in place), its island IS the tower (a wedge rising to the
// stern). The deck is SLOPED (bow -4.65 m, stern +0.86 m) — see
// DECK_PROFILE and deckLocalYAt(). The deck carries the Ford flight-deck
// texture (assets/ASSETS.md). A centreline trench (x -12..+5,
// z -115..+6) is closed by an infill strip in buildCarrierDetail().
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
// Models are embedded as base64 JS modules (Pandora-style) because the
// GitHub snapshot-push route only accepts UTF-8 text files — no binary .glb
// files are shipped. See assets/ASSETS.md.
import { SEA_FLOOR_Y } from './sea.js'; // v1.6.0 Item 2: wrecks rest on the seabed, never despawn
import { HELICARRIER_B64 } from '../assets/helicarrier.b64.js';
import { FA18_B64 } from '../assets/fa18.b64.js';

export const CARRIER_LEN = 333;
export const GRAV = 9.81;
const ZONE_HP = { pod: 100, reactor: 150, magazine: 120, bridge: 100, deck: 120, engines: 150 };
// v1.4.0 (items 2+4): fire HP drain, HP/s at full intensity (a new fire
// starts at intensity 0.5 and ramps 0.05/s to 1.0). Was 2.0 — at 2.0 a
// reactor fire finished off what 2–4 centre-deck bomb hits started in
// ~9/10 strike flights, so a single flight killed a carrier at hpFrac
// ~0.85 and 4v4 rounds ran only 269–582 game s. At 1.2 the fire still
// matters (~55–80 HP over a flight) but the reactor usually survives
// the first flight, so carriers take ~1.5 flights to kill and rounds
// run longer without touching bomb damage (30) or any zone HP.
const FIRE_DRAIN_RATE = 1.2;
// v1.4.0 flight physics — mass-grounded, from
// goals/helicarriers-at-sea-game/hidden_files/v14-physics-spec.md.
// Design mass 120,000 t (Nimitz 97–104 kt + 15–25% for lift pods and
// the in-air hull backbone); weight 1,177 MN. Max lift thrust 1.45 x W
// (hover at 69%) so one pod lost is survivable (0.75 x 1.45 = 1.09 W)
// and two lost cannot hold altitude (0.50 x 1.45 = 0.73 W). The lift
// system is fictional high-thrust ducted fans — momentum theory would
// demand ~325 m/s induced velocity and 380 GW, so thrust is specified,
// not derived. Inertias from Pandora's inertias() formula (m = 120e6,
// L = 333, span = 68): pitch 1.11e12, yaw 1.16e12, roll 2.31e10 kg m^2.
// Lever arms are measured from template.podLocals at construction
// (mean |z| 65.1 m, mean |x| 58.2 m — both >20% off the spec's nominal
// 90/42 m, so the angular accels below are RE-DERIVED from the measured
// levers, not the spec table: pitch 0.0173 rad/s^2, yaw 0.0148 rad/s^2).
// A ~3x gameplay compression vs a strict thrust model is inside the
// spool numbers (a real 120,000 t ship would take minutes to reach
// flank speed); do not "correct" it silently in either direction.
export const PHYSICS = {
  MASS: 120_000_000, // kg
  WEIGHT: 120_000_000 * 9.81, // N
  T_LIFT_MAX_RATIO: 1.45, // max lift thrust / weight
  THROTTLE_HOVER: 1 / 1.45, // 0.69 — throttle fraction that hovers
  INERTIA_PITCH: 120_000_000 * 333 * 333 / 12, // 1.11e12 kg m^2
  INERTIA_YAW: 120_000_000 * (68 * 68 + 333 * 333) / 12, // 1.16e12
  INERTIA_ROLL: 0.5 * 120_000_000 * 68 * 68 / 12, // 2.31e10
  ROTOR_SPOOL_TAU: 6, // s — a 38 m fan does not spool in under a second
  SPOOL_UP: 0.45, // m/s^2 ordered-speed slew up (was 6)
  SPOOL_DOWN: 0.60, // m/s^2 ordered-speed slew down, reverse thrust (was 10)
  TAU_SPEED: 4.0, // s — forward speed chases the ordered speed
  TURN_LOSS: 0.15, // ordered-speed bleed in a turn (was 0.33)
  OMEGA_MAX: 0.09, // rad/s (5.2 deg/s) rudder-authority turn cap
  BANK_MAX: 10 * Math.PI / 180, // rad — deck/crew limit, bank is the RESULT of turn rate
  TAU_YAW: 6.0, // s — headingRate chases the bank-limited command
  TAU_ROLL: 1.5, // s — bank chases the coordinated-turn value
  RUDDER_SLEW: 8, // deg/s (was 40) — hard-over to hard-over in 8.8 s
  PITCH_MAX: 0.21, // rad, +-12 deg — unchanged
  PITCH_RATE_MAX: 0.06, // rad/s (3.4 deg/s) — reached at PITCH_ACCEL
  CLIMB_MAX: 6, // m/s — climb is thrust-authority limited
  // v1.4.2 throttle linearity ABOVE hover: the throttle term alone
  // spans (0-1)*8 = -8..+3.6 m/s, so the climb sum is clamped to -8
  // below (not -6) — clamping at -6 saturated the bottom ~17% of the
  // slider (throttle 0.05-0.15 all gave -6.00 m/s, probed
  // v142-throttle-climb). Equal 10% slider steps now give equal
  // 1.16 m/s climb steps over the whole range; hover (0.69) and
  // full-throttle climb (+3.6) are unchanged, and pitch-only descent
  // is still capped at -6 by the pitch term's own clamp. Max descent
  // via throttle is now -8 m/s.
  // v1.6.2: the note above is the ABOVE-hover half only. BELOW hover
  // the throttle term is no longer a velocity at all — it is the
  // acceleration a = -g*(1 - liftThrust) + drag (see the alive
  // branch), uncapped, so there is no -8 floor on a gravity descent.
  // The -8 clamp survives only as the pitch-down bound in controlled
  // flight.
  CLIMB_MAX_DN: 8, // m/s — descent authority (throttle term's natural floor)
  TAU_VY: 5.0, // s — vertical speed chases the climb command
  ALT_HOLD_CAP_UP: 6, ALT_HOLD_CAP_DN: -5, // m/s (was +15/-10)
  LIFT_HOVER: 1 / 1.45, // 0.69 — hover threshold, re-anchored from 0.60
  THROTTLE_CLIMB: 8, // m/s climb per unit lift excess over hover (throttle)
  // v1.4.2 freefall — real physics (Nicholas 2026-11-26; supersedes spec
  // §8's "do not fix it from the mass", which capped the fall at a
  // 40-70 m/s terminal with a tau=2.5 s chase and gave ~27 m/s^2
  // initial acceleration — 2.75g, impossible in freefall).
  FALL_RHO: 1.225, // kg/m^3, sea-level air
  FALL_CD: 1.0, // flat plate
  FALL_A_PLAN: 333 * 68, // m^2, planform flat
  FALL_A_BOW: 68 * 35, // m^2, bow face (hull depth 35 m, estimate)
  FALL_A_SIDE: 333 * 35, // m^2, side face
};
// v1.4.2 freefall model (see PHYSICS.FALL_*): gravity g = 9.81 m/s^2
// exactly — a freefalling body starting from rest cannot accelerate
// faster than g (drag only slows it). Drag is the drag equation,
// F = 1/2*rho*Cd*A*v^2; terminal velocity vt = sqrt(2*m*g/(rho*Cd*A))
// = 291 m/s flat, so from game altitudes (<=600 m) the ship is still
// accelerating at impact: 350 m in 8.5 s at 81 m/s, 600 m in 11.2 s
// at 105 m/s (probed before/after, v142-fall-before/after.json).
// Attitude changes the projected area (flat vs nose-down). Rotors at
// zero throttle are STOPPED, not windmilling: a windmilling rotor would
// autorotate a helicopter down at ~10 m/s, but these are ducted fans
// with the drive cut — the pods are dead weight in the fall, so hull
// drag alone governs (no rotor-drag term). Lift thrust, when the fans
// are spooled back up, offsets weight directly:
// a = -g*(1 - liftThrust) + a_drag.
// v1.4.2: projected area (m^2) of a 333 m hull at pitch/roll (radians).
function fallProjectedArea(pitch, roll) {
  return PHYSICS.FALL_A_PLAN * Math.abs(Math.cos(pitch)) * Math.abs(Math.cos(roll))
    + PHYSICS.FALL_A_BOW * Math.abs(Math.sin(pitch))
    + PHYSICS.FALL_A_SIDE * Math.abs(Math.sin(roll));
}
// v1.4.2: drag acceleration (m/s^2, signed — always opposes the motion)
// for a body moving at vy (m/s) presenting area (m^2) with mass (kg):
// a_drag = -(1/2*rho*Cd*A/m) * vy*|vy|.
function fallDragAccel(vy, area, mass) {
  const k = 0.5 * PHYSICS.FALL_RHO * PHYSICS.FALL_CD * area / mass;
  return -k * vy * Math.abs(vy);
}
// v1.4.0: pitch limits now live in PHYSICS above (PITCH_MAX 0.21 rad,
// PITCH_RATE_MAX 0.06 rad/s, accel from the measured pod levers). The
// old 0.5 rad/s pitch rate (12 deg in 0.42 s) is gone — it was the
// single most weightless-feeling number in the pitch path.
const ALT_FLOOR = 150;
const ALT_CEIL = 600;

let _loader = null;
function loader() {
  if (!_loader) { _loader = new GLTFLoader(); _loader.setMeshoptDecoder(MeshoptDecoder); }
  return _loader;
}

// v1.4.0: the STL model needs no hides — there are no bad slabs, no
// flat rotor discs, no interior shells to retire. Its fans (rotorSpin_*)
// are real multi-blade rotors and must stay visible; its hull is a
// closed sculpted shell. The only job here is the v1.2.1 solidity
// backstop: every shell renders double-sided, so an open shell never
// vanishes from its back face and no see-through path opens.
function hideBadSlabs(obj) {
  obj.traverse(o => {
    if (o.isMesh && o.name.startsWith('deck_top')) {
      o.material.polygonOffset = true; o.material.polygonOffsetFactor = -2;
    }
    if (o.isMesh && o.material) o.material.side = THREE.DoubleSide;
  });
}

// v1.4.0 — deck profile of the STL model, measured by the converter
// (/tmp/stl-convert/meta.json): the flight deck is flat at the bow,
// ramps up, and is flat at the stern. Centreline heights (game Y):
// bow -4.65 (STL Z 47) for z <= -38, linear ramp to stern +0.86
// (STL Z 52) over z -38..+6, flat +0.86 above. Jets, markings, fires
// and scorches all sit on deckLocalYAt(lz), not on one flat height.
const DECK_PROFILE = { bowY: -4.65, sternY: 0.86, rampZ0: -38, rampZ1: 6 };
function deckLocalYAt(lz) {
  const { bowY, sternY, rampZ0, rampZ1 } = DECK_PROFILE;
  if (lz <= rampZ0) return bowY;
  if (lz >= rampZ1) return sternY;
  return bowY + (sternY - bowY) * (lz - rampZ0) / (rampZ1 - rampZ0);
}
// Landable deck half-width by local z (the deck narrows to a point at
// bow and stern; the textured strip is |x| <= 38). Hull half-widths
// measured from the STL (meta.json stations), capped at the strip.
const DECK_WIDTH_STATIONS = [
  [-166, 15], [-140, 19], [-120, 23], [-100, 26], [-80, 38], [-60, 38],
  [-40, 38], [-20, 38], [0, 38], [20, 38], [40, 38], [60, 38], [80, 38],
  [100, 38], [120, 38], [140, 38], [166, 34],
];
function deckHalfWidthAt(lz) {
  const st = DECK_WIDTH_STATIONS;
  if (lz <= st[0][0]) return st[0][1];
  if (lz >= st[st.length - 1][0]) return st[st.length - 1][1];
  for (let i = 0; i < st.length - 1; i++) {
    if (lz >= st[i][0] && lz <= st[i + 1][0]) {
      const f = (lz - st[i][0]) / (st[i + 1][0] - st[i][0]);
      return st[i][1] + f * (st[i + 1][1] - st[i][1]);
    }
  }
  return 38;
}

// v1.2.0 detail materials (shared across the template's clones).
// Hurricane palette: haze-grey verticals, deck-grey horizontals.
const DM = {
  // v1.4.0: darkened to blend with the Ford deck texture (the old
  // 0x424a52 read as a light grey panel on the near-black deck; the
  // texture's base colour x 0.169 renders near-black under the game
  // lights, so the infill is near-black too).
  deckInfill: new THREE.MeshStandardMaterial({ color: 0x1e2126, roughness: 0.85, metalness: 0.1 }),
  // Deck patches on the light pod/side decks (Ford pod grey).
  patchLight: new THREE.MeshStandardMaterial({ color: 0x8a9aa8, roughness: 0.65, metalness: 0.25 }),
  whiteMark: new THREE.MeshStandardMaterial({ color: 0xdfe9f2, roughness: 0.6, metalness: 0.05 }),
  darkMark: new THREE.MeshStandardMaterial({ color: 0x1c2833, roughness: 0.7, metalness: 0.2 }),
  ductDark: new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.7, metalness: 0.4, side: THREE.DoubleSide }),
  lightGrey: new THREE.MeshStandardMaterial({ color: 0x8a9aa8, roughness: 0.6, metalness: 0.3 }),
  hubMetal: new THREE.MeshStandardMaterial({ color: 0x6a6e73, roughness: 0.4, metalness: 0.6 }),
  windowGlow: new THREE.MeshStandardMaterial({ color: 0xffe9a8, emissive: 0xaa7711, emissiveIntensity: 0.9, roughness: 0.4 }),
  redNav: new THREE.MeshStandardMaterial({ color: 0xff4444, emissive: 0xaa1111, emissiveIntensity: 1.2 }),
  greenNav: new THREE.MeshStandardMaterial({ color: 0x44ff66, emissive: 0x11aa33, emissiveIntensity: 1.2 }),
  // v1.3.2: torn section caps — dark scorched steel, so a cut face reads
  // as a broken edge, not a clean light panel.
  capSteel: new THREE.MeshStandardMaterial({ color: 0x33383d, roughness: 0.9, metalness: 0.3, side: THREE.DoubleSide }),
  // v1.6.2: pulverised-remnant steel — a mid grey, flat-shaded, so a
  // tumbling wreck chunk reads as solid steel from every angle. The
  // old capSteel (0x33383d) on a flat tetrahedron read as a black
  // card; this plus real volume is what makes a remnant look like a
  // piece of the carrier instead of a floating black quad.
  remnantSteel: new THREE.MeshStandardMaterial({ color: 0x565d64, roughness: 0.85, metalness: 0.35, flatShading: true, side: THREE.DoubleSide }),
};
function dbox(w, h, d, mat, x, y, z, ry = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  if (ry) m.rotation.y = ry;
  return m;
}

// v1.4.0 — hull profile of the STL model, for section caps (a torn-off
// piece gets a solid cross-section at each cut). Stations [z, halfWidth,
// centrelineKeelY] measured from the STL by the converter
// (/tmp/stl-convert/meta.json): half-widths are the hull's max per
// z-slice, keel is the CENTRELINE keel (the slice minimum is deeper —
// it catches the pod housings — and would poke a spike below the hull).
// The STL hull is a closed sculpted shell, so there is no inner core
// loft any more: the v1.2.1 slab core this replaced is gone for good.
const HULL_PROFILE_STATIONS = [
  [-160, 15.3, -6.1], [-140, 19.2, -17.2], [-120, 23.4, -18.1],
  [-100, 26.3, -20.4], [-80, 41.9, -22.6], [-60, 42, -29.3],
  [-40, 42, -29.2], [-20, 41.8, -29.0], [0, 42, -28.4],
  [20, 39.4, -27.2], [40, 41, -27.7], [60, 41.8, -28.7],
  [80, 41.9, -29.8], [100, 41.9, -29.8], [120, 41.9, -17.6],
  [140, 42, -5.9], [160, 34.5, -5.9],
];

// v1.3.2 — section caps: a torn-off piece must read as a solid part of
// one ship, not a hollow open shell. Interpolate the hull profile at a
// cut (local z) and cap the cross-section with a solid face.
function hullSectionAt(z) {
  const st = HULL_PROFILE_STATIONS;
  if (z <= st[0][0]) return { w: st[0][1], k: st[0][2] };
  if (z >= st[st.length - 1][0]) return { w: st[st.length - 1][1], k: st[st.length - 1][2] };
  for (let i = 0; i < st.length - 1; i++) {
    if (z >= st[i][0] && z <= st[i + 1][0]) {
      const f = (z - st[i][0]) / (st[i + 1][0] - st[i][0]);
      return { w: st[i][1] + f * (st[i + 1][1] - st[i][1]), k: st[i][2] + f * (st[i + 1][2] - st[i][2]) };
    }
  }
  return { w: 30, k: -20 };
}
// v1.4.0 fragmentation realism (research §2): seeded RNG + jagged
// fracture paths. A clip plane is flat by definition, so jaggedness
// cannot come from the plane — it comes from geometry added at the cut
// (caps + petals), all derived from ONE seeded path per cut so the crack
// ribbon the player watches grow IS the outline the cap will show.
// Seed = hash(carrier id, cut index, hit lz): same cut always looks the
// same across replays/probes; different cuts differ. Never Math.random()
// for fracture geometry.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function fracSeed(id, cutIdx, lz) {
  return (((id * 1000003) ^ (cutIdx * 9176) ^ Math.round((lz || 0) * 10)) >>> 0) || 1;
}
// Jagged cross-section outline at a cut (local z): the hull-section
// polyline (top edge -> sides -> keel V) displaced by a seeded random
// walk, amplitude ±2–5 m (larger at the extremities), second octave
// ±0.8–1.5 m (the ≈0.8 fractal dimension of real fracture surfaces),
// weighted ×1.5 within 15 m of the hit / a stress raiser and ×0.7
// elsewhere, plus ONE dominant 6–12 m V-notch at the point nearest the
// hit — the crack entered there. Returns [{x, y}] (closed implicitly).
function jaggedFracturePath(seed, zc, hitLx) {
  const { w, k } = hullSectionAt(zc);
  const w2 = w + 1, k2 = k - 1;
  const topY = deckLocalYAt(zc) + 0.3;
  const midY = (topY + k2) / 2;
  const base = [
    [-w2, topY], [w2, topY], [w2, midY], [w2 * 0.55, k2 + 1.5],
    [0, k2], [-w2 * 0.55, k2 + 1.5], [-w2, midY],
  ];
  const rng = mulberry32(seed);
  const cx = 0, cy = (topY + k2) / 2;
  const hitY = topY; // the hit enters at deck level on the outline
  const pts = [];
  for (let s = 0; s < base.length; s++) {
    const [x0, y0] = base[s];
    const [x1, y1] = base[(s + 1) % base.length];
    const segLen = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.round(segLen / 11)); // ~8–20 m wavelength
    const nx = -(y1 - y0) / (segLen || 1), ny = (x1 - x0) / (segLen || 1);
    let walk = 0;
    for (let i = 0; i < steps; i++) {
      const f = i / steps;
      const px = x0 + (x1 - x0) * f, py = y0 + (y1 - y0) * f;
      // Random-walk step along the outline normal, ±2–5 m per step.
      walk += (rng() - 0.5) * 2 * (2 + rng() * 3);
      walk = Math.max(-5, Math.min(5, walk));
      // Second octave: ±0.8–1.5 m at 3–6 m wavelength.
      const fine = (rng() - 0.5) * 2 * (0.8 + rng() * 0.7);
      // Stress-path bias: ×1.5 near the hit / raisers, ×0.7 elsewhere.
      const dHit = Math.hypot(px - (hitLx || 0), py - hitY);
      const nearRaiser = Math.abs(Math.abs(px) - 40) < 15; // pod-duct edge band
      const wgt = (dHit < 15 || nearRaiser) ? 1.5 : 0.7;
      pts.push({ x: px + nx * walk * wgt + nx * fine, y: py + ny * walk * wgt + ny * fine });
    }
  }
  // Dominant notch: the outline point nearest the hit is pulled toward
  // the centroid by 6–12 m — the crack entered there.
  let bi = 0, bd = 1e9;
  pts.forEach((p, i) => {
    const d = Math.hypot(p.x - (hitLx || 0), p.y - hitY);
    if (d < bd) { bd = d; bi = i; }
  });
  const notch = 6 + rng() * 6;
  const p = pts[bi];
  const dx = cx - p.x, dy = cy - p.y, dl = Math.hypot(dx, dy) || 1;
  p.x += (dx / dl) * notch; p.y += (dy / dl) * notch;
  // v1.6.0 V6: the random walk (up to ±5 m × 1.5 near the hit, plus the
  // fine octave) could push the outline ~8 m OUTSIDE the hull section
  // it is meant to cap — the cap then overhangs the hull in mid-air.
  // Clamp every point to the hull section expanded by ≤1 m.
  for (const q of pts) {
    q.x = Math.max(-w2, Math.min(w2, q.x));
    q.y = Math.max(k2, Math.min(topY, q.y));
  }
  return pts;
}
// v1.6.0 V2: clip a closed outline polygon to an x-range (Sutherland–
// Hodgman against x >= xMin and x <= xMax). Longitudinal halves get a
// transverse cap/petals only over their own half of the hull — a
// full-width cap on a half-hull is an open hollow face on the other side.
function clipPolyX(pts, xMin, xMax) {
  const clip = (list, keep, edge) => {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const a = list[i], b = list[(i + 1) % list.length];
      const aIn = keep(a.x), bIn = keep(b.x);
      if (aIn) out.push(a);
      if (aIn !== bIn) {
        const f = (edge - a.x) / ((b.x - a.x) || 1e-9);
        out.push({ x: edge, y: a.y + (b.y - a.y) * f });
      }
    }
    return out;
  };
  let r = pts;
  if (xMin !== undefined && xMin !== null) r = clip(r, x => x >= xMin, xMin);
  if (xMax !== undefined && xMax !== null) r = clip(r, x => x <= xMax, xMax);
  return r;
}
function addSectionCap(group, zc, islBox, opts = {}) {
  let pts = jaggedFracturePath(opts.seed || 1, zc, opts.hitLx || 0);
  if (opts.xRange) pts = clipPolyX(pts, opts.xRange[0], opts.xRange[1]);
  if (pts.length < 3) return null;
  const s = new THREE.Shape();
  pts.forEach((p, i) => { if (i === 0) s.moveTo(p.x, p.y); else s.lineTo(p.x, p.y); });
  s.closePath();
  const geo = new THREE.ShapeGeometry(s);
  // Dishing: the face is slightly dished/bulged like torn plate, never
  // a flat mirror — displace z by a low-frequency seeded field, ±1.5–3 m.
  const rng = mulberry32((opts.seed || 1) + 77);
  const ph1 = rng() * Math.PI * 2, ph2 = rng() * Math.PI * 2;
  const pos = geo.attributes.position;
  const hot = !!opts.hot;
  const steel = new THREE.Color(0x33383d), scorch = new THREE.Color(0x1a1c1e);
  const hotCol = new THREE.Color(0x6a3a1a);
  const cols = new Float32Array(pos.count * 3);
  const hotIdx = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    pos.setZ(i, (Math.sin(x * 0.06 + ph1) + Math.sin(y * 0.09 + ph2)) * 1.5);
    // Vertex colour: scorched near-black at the rim, streaked ±30%;
    // on a fresh detonation cut the vertices near the hit glow hot
    // orange-brown (fading over ~20 s, see BreakupPiece.update).
    // Structural cuts get bare torn steel + soot only, no hot band.
    const dHit = Math.hypot(x - (opts.hitLx || 0), y - (deckLocalYAt(zc) + 0.3));
    const c = new THREE.Color();
    if (hot && dHit < 20) { c.copy(hotCol); hotIdx.push(i); }
    else if (rng() < 0.45) c.copy(scorch);
    else c.copy(steel);
    const j = 0.7 + rng() * 0.6;
    c.multiplyScalar(j);
    cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.3, side: THREE.DoubleSide });
  const cap = new THREE.Mesh(geo, mat);
  cap.position.set(0, 0, zc);
  cap.name = 'breakCap';
  cap.userData.hotIdx = hotIdx;
  cap.userData.hotFade = hot ? 20 : 0; // seconds of hot band left
  group.add(cap);
  // Island cap: the STL island is a wedge rising toward the stern, not
  // a uniform tower, so a full-height rectangle would poke above the
  // wedge at a forward cut. A trapezoid — full width at the deck,
  // narrow at the wedge's local top — follows the island's shape.
  // v1.6.0 V2: on a longitudinal half the trapezoid is clipped to the
  // half's x-range (and skipped entirely when the island is wholly on
  // the other side), so it never floats over open water.
  if (islBox && zc >= islBox.min.z && zc <= islBox.max.z) {
    const islTop = islandTopYAt(zc, islBox);
    let ix0 = islBox.min.x, ix1 = islBox.max.x;
    if (opts.xRange) {
      ix0 = Math.max(ix0, opts.xRange[0] === null || opts.xRange[0] === undefined ? -Infinity : opts.xRange[0]);
      ix1 = Math.min(ix1, opts.xRange[1] === null || opts.xRange[1] === undefined ? Infinity : opts.xRange[1]);
    }
    if (ix1 - ix0 > 0.5) {
      const icx = (ix0 + ix1) / 2, ihw = (ix1 - ix0) / 2;
      const baseY = deckLocalYAt(zc); // local deck height at the cut
      const is = new THREE.Shape();
      is.moveTo(icx - ihw, baseY);
      is.lineTo(icx + ihw, baseY);
      is.lineTo(icx + ihw * 0.45, islTop);
      is.lineTo(icx - ihw * 0.45, islTop);
      is.closePath();
      const icap = new THREE.Mesh(new THREE.ShapeGeometry(is), DM.capSteel);
      icap.position.set(0, 0, zc);
      icap.name = 'breakCapIsland';
      group.add(icap);
    }
  }
  return cap;
}
// v1.4.0 torn petals / bent flaps (research §2.3): the cap is only
// visible face-on; from the side a piece still ends in a straight clip
// line. A ring of 8–14 triangular flaps around the cut perimeter, 6–14 m
// long, bent 20–60° outward on the tension side (detonation: outward,
// away from the blast) and short/folded flat on the compression side.
// One BufferGeometry per cut, double-sided, no clipping planes (same
// rule as caps). Built in a group at (0,0,zc) so the piece can scale
// them 0→1 over the 0.25 s hinge as the gap opens (they were hidden
// inside the closed crack).
function addTornPetals(group, zc, zDir, opts = {}) {
  let pts = jaggedFracturePath((opts.seed || 1) + 31, zc, opts.hitLx || 0);
  // v1.6.0 V2: longitudinal halves get petals only over their own half.
  if (opts.xRange) pts = clipPolyX(pts, opts.xRange[0], opts.xRange[1]);
  // v1.6.0 V4: on a diagonal cut the petal ring is stretched 1/cos θ
  // along x — the same transform as the diagonal cap — so the flaps
  // sit on the cut face instead of ~5 m inside it. (The group is
  // rotated -θ about Y by the caller, exactly like the cap.)
  if (opts.stretchX && opts.stretchX !== 1) for (const p of pts) p.x *= opts.stretchX;
  if (pts.length < 3) { const g0 = new THREE.Group(); g0.position.set(0, 0, zc); g0.scale.setScalar(0.001); g0.name = 'breakPetalsGroup'; group.add(g0); return g0; }
  const cx = 0, cy = (deckLocalYAt(zc) + 0.3 + (hullSectionAt(zc).k - 1)) / 2;
  const rng = mulberry32((opts.seed || 1) + 57);
  const count = Math.max(8, Math.min(14, Math.round(pts.length / 2) + (opts.detonation ? 2 : 0)));
  const step = Math.max(1, Math.floor(pts.length / count));
  const posArr = [], colArr = [];
  const scorch = new THREE.Color(0x1a1c1e), steel = new THREE.Color(0x3a3f45);
  const hotCol = new THREE.Color(0x6a3a1a);
  const push = (x, y, z, col) => { posArr.push(x, y, z); colArr.push(col.r, col.g, col.b); };
  let made = 0;
  for (let i = 0; i < pts.length && made < count; i += step, made++) {
    const p0 = pts[i], p1 = pts[(i + 1) % pts.length];
    const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
    // Radial-out direction from the section centroid.
    let ox = mx - cx, oy = my - cy;
    const ol = Math.hypot(ox, oy) || 1; ox /= ol; oy /= ol;
    // Tension side (deck in hogging / keel in sagging, from the hit
    // side): long flaps bent outward; compression side: short, folded
    // flat, with the cap rim carrying a buckle wave instead of teeth
    // (the wave is the cap's jagged outline itself — see §2.3).
    const tension = opts.tensionSide === 'top' ? (my > cy) : (my < cy);
    const bend = (20 + rng() * 40) * Math.PI / 180; // 20–60°
    const len = (6 + rng() * 8) * (tension ? 1.2 : 0.5) * (opts.detonation ? 1.15 : 1);
    const outK = Math.sin(bend), zK = Math.cos(bend);
    const midX = mx + ox * len * 0.55 * outK, midY = my + oy * len * 0.55 * outK, midZ = zDir * len * 0.55 * zK;
    // Tip curled a further 20–40° outward.
    const curl = (20 + rng() * 20) * Math.PI / 180;
    const tipX = midX + ox * len * 0.45 * Math.sin(bend + curl);
    const tipY = midY + oy * len * 0.45 * Math.sin(bend + curl);
    const tipZ = midZ + zDir * len * 0.45 * Math.cos(bend + curl);
    const cBase = (opts.hot && Math.hypot(mx - (opts.hitLx || 0), my - (deckLocalYAt(zc) + 0.3)) < 20) ? hotCol : scorch;
    const cTip = steel.clone().multiplyScalar(0.7 + rng() * 0.5);
    // Quad as two triangles: (b0, b1, mid), (b1, tip, mid).
    push(p0.x, p0.y, 0, cBase); push(p1.x, p1.y, 0, cBase); push(midX, midY, midZ, cTip);
    push(p1.x, p1.y, 0, cBase); push(tipX, tipY, tipZ, cTip); push(midX, midY, midZ, cTip);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posArr), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colArr), 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.3, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'breakPetals';
  const g = new THREE.Group();
  g.position.set(0, 0, zc);
  g.scale.setScalar(0.001); // revealed by the hinge over 0.25 s
  g.name = 'breakPetalsGroup';
  g.add(mesh);
  group.add(g);
  return g;
}

// v1.5.0 piece-fall physics — RE-DERIVED against the corrected v1.4.2
// fall model (a = -g*(1-liftThrust) - k*vy*|vy|, Cd=1.0, planform
// 333x68, vt=291 m/s), NOT the old v1.4.1 tau=2.5 s chase and NOT the
// v14 §4.3 piece vt formula (36/54 m/s) as written. For a piece,
// k = 1/2*rho*Cd*A/m, so vt = sqrt(2*m*g/(rho*Cd*A)). A uniform-density
// hull section scales A and m together with its length, so k — and vt
// = 291 m/s flat — is the SAME as the whole hull (that is what the
// existing BreakupPiece.update already computes). Pieces differ from
// the hull only where their area/mass ratio differs from a hull
// section's: a light draggy piece (deck strip, pulverised plate) has
// A/m several times a hull section's, so its vt is lower. vt follows the
// piece's own area and mass — area = fallProjectedArea * lenFrac *
// areaFrac * dragK, mass = PHYSICS.MASS * massFrac (lenFrac is clamped
// to a minimum of 20/333 in the fall branch) — NOT 291/sqrt(dragK), which
// ignores areaFrac and massFrac. True flat vt per type (measured
// 2026-11-27, v16-items12 probes — implied vt from the vy series matches
// these code values within ~1% for every type):
//   hull section (dragK 1, areaFrac 1, massFrac = lenFrac) -> vt 291 m/s
//   island (dragK 1, areaFrac 0.34, massFrac 0.008) -> vt 114 m/s (implied 113.4)
//   pod (dragK 1.5, areaFrac 0.44, massFrac 0.012) -> vt 116 m/s (implied 115.2)
//   deck strip (dragK 3, areaFrac 0.18, massFrac 0.002) -> vt 46 m/s (implied 45.6)
//   pulverised remnant (dragK 3, areaFrac 0.7, massFrac 0.04, segLen 44)
//     -> vt ~110 m/s (v1.6.2: the old flat plate, dragK 4 / areaFrac 0.5 /
//     massFrac 0.005, was vt 59 — the new solid chunk falls like the
//     island/pod chunks of the same scale, as it should)
// (An earlier version of this comment listed 206/168/119/75-92 from the
// dragK-only formula — those numbers were wrong, the code below was right.)
// dragK, areaFrac and massFrac on a BreakupPiece encode exactly that:
// area = fallProjectedArea * lenFrac * areaFrac * dragK, mass =
// PHYSICS.MASS * massFrac. Light draggy debris falls slowly and drifts
// — it never falls like a hull section.
function pieceVtEstimate(dragK) { return 291 / Math.sqrt(Math.max(1, dragK || 1)); }

// v1.5.0 D1 diagonal tear — the cap must be a PARALLELOGRAM-section
// outline matching the diagonal cut, NOT a transverse cap rotated into
// place (v15 §10.7). The cut plane has normal (sinθ,0,-cosθ) through
// (0,0,zc); its in-plane across direction is (cosθ,0,sinθ), so the
// jagged cross-section outline is stretched by 1/cosθ along its x
// axis and the mesh is rotated -θ about Y: a point at shape-u sits at
// hull-x u*cosθ and z = zc + u*sinθ = zc + x*tanθ, exactly on the cut.
function addDiagonalCap(group, zc, angle, islBox, opts = {}) {
  const cosA = Math.cos(angle) || 1;
  const pts = jaggedFracturePath(opts.seed || 1, zc, opts.hitLx || 0);
  const s = new THREE.Shape();
  pts.forEach((p, i) => { const u = p.x / cosA; if (i === 0) s.moveTo(u, p.y); else s.lineTo(u, p.y); });
  s.closePath();
  const geo = new THREE.ShapeGeometry(s);
  const rng = mulberry32((opts.seed || 1) + 77);
  const ph1 = rng() * Math.PI * 2, ph2 = rng() * Math.PI * 2;
  const pos = geo.attributes.position;
  const hot = !!opts.hot;
  const steel = new THREE.Color(0x33383d), scorch = new THREE.Color(0x1a1c1e);
  const hotCol = new THREE.Color(0x6a3a1a);
  const cols = new Float32Array(pos.count * 3);
  const hotIdx = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    pos.setZ(i, (Math.sin(x * 0.06 + ph1) + Math.sin(y * 0.09 + ph2)) * 1.5);
    const dHit = Math.hypot(x * cosA - (opts.hitLx || 0), y - (deckLocalYAt(zc) + 0.3));
    const c = new THREE.Color();
    if (hot && dHit < 20) { c.copy(hotCol); hotIdx.push(i); }
    else if (rng() < 0.45) c.copy(scorch);
    else c.copy(steel);
    c.multiplyScalar(0.7 + rng() * 0.6);
    cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.3, side: THREE.DoubleSide });
  const cap = new THREE.Mesh(geo, mat);
  cap.position.set(0, 0, zc);
  cap.rotation.y = -angle;
  cap.name = 'breakCapDiagonal';
  cap.userData.hotIdx = hotIdx;
  cap.userData.hotFade = hot ? 20 : 0;
  group.add(cap);
  // v1.6.0 V5: the diagonal cap had no island trapezoid — a diagonal
  // cut through the island left it hollow. Same trapezoid as the
  // transverse cap, stretched 1/cos θ and rotated -θ like the hull cap,
  // so it sits on the cut plane (shape-u = hull-x / cos θ).
  if (islBox && zc >= islBox.min.z && zc <= islBox.max.z) {
    const islTop = islandTopYAt(zc, islBox);
    const ix0 = islBox.min.x, ix1 = islBox.max.x;
    const icx = (ix0 + ix1) / 2, ihw = (ix1 - ix0) / 2;
    const baseY = deckLocalYAt(zc);
    const is = new THREE.Shape();
    is.moveTo((icx - ihw) / cosA, baseY);
    is.lineTo((icx + ihw) / cosA, baseY);
    is.lineTo((icx + ihw * 0.45) / cosA, islTop);
    is.lineTo((icx - ihw * 0.45) / cosA, islTop);
    is.closePath();
    const icap = new THREE.Mesh(new THREE.ShapeGeometry(is), DM.capSteel);
    icap.position.set(0, 0, zc);
    icap.rotation.y = -angle;
    icap.name = 'breakCapIsland';
    group.add(icap);
  }
  return cap;
}
// v1.5.0 D1: the diagonal clip plane in the piece's local space.
// keepSide -1 keeps the bow side of the cut (z <= cut, rotated),
// +1 keeps the stern side. Plane: n.p + c >= 0 is kept, with
// n = (sinθ,0,-cosθ) * keepSide... — built so that at x=0 the boundary
// is exactly z = zc, matching the transverse planes it replaces.
function diagonalPlane(zc, angle, keepSide) {
  const s = Math.sin(angle), c = Math.cos(angle);
  // Bow side (z below the diagonal): sinθ*x - cosθ*z - (-zc*cosθ)...:
  // boundary sinθ*x - cosθ*z + zc*cosθ = 0 -> at x=0, z = zc. Kept:
  // sinθ*x - cosθ*z + zc*cosθ >= 0.
  if (keepSide < 0) return new THREE.Plane(new THREE.Vector3(s, 0, -c), zc * c);
  return new THREE.Plane(new THREE.Vector3(-s, 0, c), -zc * c);
}
// v1.5.0 D2 longitudinal deck split — side-profile cap. The cap is the
// hull's SIDE profile (new geometry, not a transverse cap): the outline
// runs along the deck (deckLocalYAt) from bow to stern, down the stern
// end, back along the centreline keel (HULL_PROFILE_STATIONS), and up
// the bow end — displaced by a seeded jagged walk (±2-4 m) so the split
// face reads as torn plate. Built in (u=z, v=y) shape space and rotated
// -90° about Y so u runs along +Z at x = xOff.
function hullSideProfilePath(seed) {
  const rng = mulberry32(seed);
  const pts = [];
  const top = [];
  for (let z = -166; z <= 166; z += 11) top.push({ z, y: deckLocalYAt(z) + 0.3 });
  top.push({ z: 166, y: deckLocalYAt(166) + 0.3 });
  const keel = [];
  for (let i = HULL_PROFILE_STATIONS.length - 1; i >= 0; i--) {
    keel.push({ z: HULL_PROFILE_STATIONS[i][0], y: HULL_PROFILE_STATIONS[i][2] - 1 });
  }
  const raw = [...top, { z: 166, y: -5.9 }, ...keel, { z: -166, y: -6.1 }];
  let walk = 0;
  for (const p of raw) {
    walk += (rng() - 0.5) * 2 * 3;
    walk = Math.max(-4, Math.min(4, walk));
    pts.push({ z: p.z, y: p.y + walk * 0.4 + (rng() - 0.5) * 1.6 });
  }
  return pts;
}
function addSideProfileCap(group, xOff, opts = {}) {
  let pts = hullSideProfilePath(opts.seed || 1);
  // v1.6.0 V1: the side-profile cap is the split face of ONE half, so
  // it is built only over that half's own [zLo, zHi] (local z). The
  // full-length cap used to overhang both ends of a short half.
  if (opts.zLo !== undefined || opts.zHi !== undefined) {
    const zLo = opts.zLo !== undefined ? opts.zLo : -Infinity;
    const zHi = opts.zHi !== undefined ? opts.zHi : Infinity;
    const clip = (list, keep, edge) => {
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const a = list[i], b = list[(i + 1) % list.length];
        const aIn = keep(a.z), bIn = keep(b.z);
        if (aIn) out.push(a);
        if (aIn !== bIn) {
          const f = (edge - a.z) / ((b.z - a.z) || 1e-9);
          out.push({ z: edge, y: a.y + (b.y - a.y) * f });
        }
      }
      return out;
    };
    pts = clip(pts, z => z >= zLo, zLo);
    pts = clip(pts, z => z <= zHi, zHi);
  }
  if (pts.length < 3) return null;
  const s = new THREE.Shape();
  pts.forEach((p, i) => { if (i === 0) s.moveTo(p.z, p.y); else s.lineTo(p.z, p.y); });
  s.closePath();
  const geo = new THREE.ShapeGeometry(s);
  const rng = mulberry32((opts.seed || 1) + 77);
  const pos = geo.attributes.position;
  const steel = new THREE.Color(0x33383d), scorch = new THREE.Color(0x1a1c1e);
  const cols = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const c = rng() < 0.45 ? scorch.clone() : steel.clone();
    c.multiplyScalar(0.7 + rng() * 0.6);
    cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.3, side: THREE.DoubleSide });
  const cap = new THREE.Mesh(geo, mat);
  cap.position.set(xOff, 0, 0);
  cap.rotation.y = -Math.PI / 2;
  cap.name = 'breakCapSide';
  group.add(cap);
  return cap;
}

// v1.4.0 — the STL island is a wedge: low at its bow face, rising to a
// narrow ridge at the stern. Its top height at a local z, from the
// island bbox (measured by the converter: the top runs ~15 m at the
// bow face, ~20 m at 55% of the length, 33.9 m at the stern ridge).
// Used for the island cap and for placing mast/lights on the surface
// instead of floating above it (Nicholas's screenshot defect #3).
function islandTopYAt(zc, islBox) {
  const bowZ = islBox.min.z, maxZ = islBox.max.z, topY = islBox.max.y;
  const midZ = bowZ + 0.55 * (maxZ - bowZ);
  const pts = [[bowZ, topY - 19], [midZ, topY - 14], [maxZ, topY]];
  if (zc <= pts[0][0]) return pts[0][1];
  if (zc >= pts[2][0]) return pts[2][1];
  for (let i = 0; i < pts.length - 1; i++) {
    if (zc >= pts[i][0] && zc <= pts[i + 1][0]) {
      const f = (zc - pts[i][0]) / (pts[i + 1][0] - pts[i][0]);
      return pts[i][1] + f * (pts[i + 1][1] - pts[i][1]);
    }
  }
  return topY;
}

// v1.4.1 — raycast the ACTUAL island surface. islandTopYAt() (kept
// below for section caps) interpolates the ridge height along z only
// and assumes the top is flat across x — wrong for a wedge that tapers
// in x and steps in terraces. Measured 2026-11-26: the top is stepped
// (12.3 at the bow face, 16.9 mid, 23.9–26.0 on the upper terrace,
// a thin STL spike to 33.9 at (18.8, 92)); the z-only formula placed
// the mast base 6.5 m, antenna 2 23.4 m and the panel line 2.3 m above
// the real surface, and the nav lights where no surface exists at all.
// Every fitting below is seated on a raycast hit, embedded slightly
// into the surface; a spot with no hit is skipped, never left floating.
const _islRay = new THREE.Raycaster();
const _islDown = new THREE.Vector3(0, -1, 0);
function islandSurfaceYAt(mesh, x, z) {
  _islRay.set(new THREE.Vector3(x, 200, z), _islDown);
  _islRay.far = 400;
  const hits = _islRay.intersectObject(mesh, false);
  return hits.length ? hits[0].point.y : null;
}

// v1.4.0 — detail layered on the STL model (template group, so every
// carrier clone inherits it). The STL already supplies the sculpted hull,
// the four ducted fans and the island wedge, so this adds only what it
// does not: the trench infill, deck markings, island bridge/mast/radar/
// lights, duct caps and rotor blur discs. Deleted with the old model:
// the hull-core loft (the slab in Nicholas's screenshot), the deck
// under-plate and old infill, the transom/bow caps, the island coaming
// and core, the pod sponson plates, the stern exhausts, and the whole
// procedural rotor assembly — the STL fans spin instead (v1.2.0's
// 8-blade rotors are retired, not duplicated).
//   1. Centreline trench: the STL deck has a blind recess (x -12..+5,
//      z -115..+6, floor y -24..-16) where the old GLB had its deck
//      hole. It reads as a dark slot and the catapult track runs
//      through it, so a flush infill strip covers it: a flat box over
//      the bow-flat section and a sloped box over the ramp.
//   2. Deck markings follow the sloped deck (deckLocalYAt per marking);
//      the Ford texture already carries the runway centreline, edge
//      lines and spot boxes, so the procedural set is only the crisp
//      overlays: centreline dashes, arrestor wires, catapult tracks,
//      touchdown ring. (No angled landing strip: the STL deck is a
//      straight deck, and no edge lines: the deck narrows at bow and
//      stern, so fixed ±33 lines would run off the deck.)
//   3. Island detail is measured from island_6 and sits ON the wedge
//      (islandTopYAt) — nothing floats (Nicholas's screenshot #3).
//   4. Duct caps: a full-radius dark disc just below each STL fan
//      closes the see-through path through the blade gaps.
function buildCarrierDetail(group, podLocals, deckLocalY, deckHalfX, deckHalfZ) {
  // deckLocalY/deckHalfX/deckHalfZ are the template's reference values
  // (kept for the caller's shape); heights here come from
  // deckLocalYAt(lz) because the deck is sloped.
  // --- 1. Close the centreline trench ---
  // Flat section (bow deck -4.65): z -115..-38. Top flush with the deck.
  const infillFlat = dbox(18, 0.5, 77, DM.deckInfill, -3.5, DECK_PROFILE.bowY - 0.2, -76.5);
  infillFlat.name = 'deckInfill';
  group.add(infillFlat);
  // Sloped section (the ramp): z -38..+6, rising 5.51 m over 44 m.
  // rotation.x is negative so the +z (stern) end rises.
  const infillSlope = dbox(18, 0.5, 44.6, DM.deckInfill, -3.5, (DECK_PROFILE.bowY + DECK_PROFILE.sternY) / 2 - 0.2, -16);
  infillSlope.rotation.x = -Math.atan2(DECK_PROFILE.sternY - DECK_PROFILE.bowY, DECK_PROFILE.rampZ1 - DECK_PROFILE.rampZ0);
  infillSlope.name = 'deckInfillSlope';
  group.add(infillSlope);
  // Three small seams in the SOURCE model's deck triangulation (found
  // by the node-side solidity raycast, verified against the STL
  // itself — not conversion artifacts): a vertical joint on the port
  // side deck, a seam on the stern deck by the engine block, and a
  // sparse-triangulation gap on the starboard side deck. Each is
  // <=5 m across; a flush patch at deck level closes it. The two side
  // patches sit on the light pod decks (patchLight), the stern one on
  // the dark textured deck (deckInfill).
  for (const [px, pz, mat] of [[-45, 45, DM.patchLight], [-15, 135, DM.deckInfill], [85, -35, DM.patchLight]]) {
    const patch = dbox(12, 0.5, 12, mat, px, deckLocalYAt(pz) + 0.05, pz);
    patch.name = 'deckPatch';
    group.add(patch);
  }
  // --- Deck markings (each at its own local deck height) ---
  const markY = lz => deckLocalYAt(lz) + 0.35;
  for (let i = 0; i < 12; i++) group.add(dbox(0.9, 0.12, 7, DM.whiteMark, 0, markY(-120 + i * 22), -120 + i * 22));
  for (const wz of [55, 65, 75]) group.add(dbox(26, 0.1, 0.5, DM.whiteMark, -13, markY(wz) + 0.03, wz, 0.157));
  for (const sx of [-1, 1]) group.add(dbox(0.8, 0.12, 65, DM.darkMark, sx * 8, markY(-85), -85));
  const ring = new THREE.Mesh(new THREE.RingGeometry(11, 13.5, 32),
    new THREE.MeshBasicMaterial({ color: 0xdfe9f2, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(0, markY(105) + 0.07, 105);
  ring.name = 'deckTouchdownRing';
  group.add(ring);
  // --- Island detail (v1.4.1: raycast-seated on the real wedge
  // surface — see islandSurfaceYAt above. The bridge windows lie on
  // the upper ramp like a raked bridge face; the mast stands on the
  // upper terrace next to the STL's own thin spike (18.8, 92); the nav
  // lights sit on the terrace where surface exists, not on the bbox
  // corners. The island coaming closes the 4.4 m gap between the
  // island skirt (y≈5.25) and the deck (y≈0.86).) ---
  let islandBox = null, islandMesh = null;
  group.traverse(o => {
    if (o.isMesh && o.name === 'island_6') { islandMesh = o; islandBox = new THREE.Box3().setFromObject(o); }
  });
  if (!islandBox) {
    group.traverse(o => {
      if (o.isMesh && o.name.startsWith('island_')) {
        const b = new THREE.Box3().setFromObject(o);
        islandBox = islandBox ? islandBox.union(b) : b;
        if (!islandMesh) islandMesh = o;
      }
    });
  }
  if (islandBox && islandMesh) {
    const cx = (islandBox.min.x + islandBox.max.x) / 2;
    const cz = (islandBox.min.z + islandBox.max.z) / 2;
    const iw = islandBox.max.x - islandBox.min.x;
    const surf = (x, z) => islandSurfaceYAt(islandMesh, x, z);
    // Island coaming/base: a solid flange in island grey from the deck
    // up into the skirt — top sloped 5.7 (bow) to 7.9 (stern) so it
    // overlaps the skirt's bottom edge (5.25 bow, 7.53 stern face)
    // everywhere, bottom sunk below the deck. Without it the island's
    // flanks float 4.4 m over open deck.
    const coamLen = islandBox.max.z - islandBox.min.z;
    const coam = dbox(iw + 0.6, 7.4, coamLen + 0.6, DM.lightGrey, cx, 3.1, cz);
    coam.rotation.x = -Math.atan2(2.2, coamLen); // stern (+z) end higher
    coam.name = 'islandCoaming';
    group.add(coam);
    // Bridge windows: lit band lying on the upper ramp (tilted to the
    // ramp's slope, measured by raycast), near the top of the wedge.
    const winZ = islandBox.min.z + 0.72 * (islandBox.max.z - islandBox.min.z);
    const winSurf = surf(cx, winZ);
    if (winSurf !== null) {
      const sA = surf(cx, winZ - 4), sB = surf(cx, winZ + 4);
      const winSlope = (sA !== null && sB !== null) ? (sB - sA) / 8 : 0;
      const win = dbox(iw * 0.8, 0.3, 6, DM.windowGlow, cx, winSurf + 0.16, winZ);
      win.rotation.x = -Math.atan(winSlope);
      win.name = 'islandBridgeWindows';
      group.add(win);
    }
    // Mast + spinning radar bar, standing on the upper terrace
    // (measured surface ~25.5 at (20.5, 87)) — embedded 0.3 m into it.
    const mastZ = islandBox.min.z + 0.79 * (islandBox.max.z - islandBox.min.z);
    const mastSurf = surf(cx, mastZ);
    if (mastSurf !== null) {
      const mastH = 7;
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, mastH, 8), DM.darkMark);
      mast.position.set(cx, mastSurf + mastH / 2 - 0.3, mastZ);
      mast.name = 'islandMast';
      group.add(mast);
      const radar = new THREE.Group();
      radar.position.set(cx, mastSurf + mastH - 0.3 + 0.35, mastZ);
      radar.name = 'islandRadar';
      radar.add(dbox(9, 0.7, 1.1, DM.lightGrey, 0, 0, 0));
      radar.add(dbox(1.2, 2.2, 1.2, DM.hubMetal, 0, -1, 0));
      group.add(radar);
    }
    // Nav lights: red port, green starboard, on the upper terrace
    // where the wedge actually has surface (x = cx ± 5.5, measured
    // 23.86 at z 90.9) — the old bbox-corner spots (x 11.2/29.9) have
    // no surface beneath them at all. Spheres sunk 0.3 m into the
    // surface so they sit, not float.
    const navZ = islandBox.min.z + 0.85 * (islandBox.max.z - islandBox.min.z);
    for (const [sx, mat] of [[-1, DM.redNav], [1, DM.greenNav]]) {
      const nx = cx + sx * 5.5;
      const ns = surf(nx, navZ);
      if (ns === null) continue; // no surface here — removed, not floating
      const nav = new THREE.Mesh(new THREE.SphereGeometry(1.1, 10, 8), mat);
      nav.position.set(nx, ns + 0.8, navZ);
      nav.name = sx < 0 ? 'islandNavPort' : 'islandNavStbd';
      group.add(nav);
    }
    // Antenna whips, standing on the terrace (measured surface).
    for (const [ax, az] of [[-5, 84], [5, 90]]) {
      const as = surf(cx + ax, az);
      if (as === null) continue; // no surface here — removed, not floating
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.3, 7, 6), DM.darkMark);
      ant.position.set(cx + ax, as + 3.2, az);
      ant.name = 'islandAntenna';
      group.add(ant);
    }
    // Island panel line: a dark break across the upper ramp, tilted
    // with the measured surface.
    const plZ = islandBox.min.z + 0.45 * (islandBox.max.z - islandBox.min.z);
    const plSurf = surf(cx, plZ);
    if (plSurf !== null) {
      const sA = surf(cx, plZ - 4), sB = surf(cx, plZ + 4);
      const plSlope = (sA !== null && sB !== null) ? (sB - sA) / 8 : 0;
      const pl = dbox(iw * 0.9, 0.3, 0.6, DM.darkMark, cx, plSurf + 0.16, plZ);
      pl.rotation.x = -Math.atan(plSlope);
      pl.name = 'islandPanelLine';
      group.add(pl);
    }
  }
  // --- Duct caps + rotor blur discs (one per pod) ---
  // The STL pods are real ducted housings with real fans; no sponson
  // plates, no stern exhausts, no rub strips are needed — the STL
  // already has those shapes. The fan plane sits mid-duct (see
  // normalizeHelicarrier: the STL fan at y -7.37 hangs below the duct's
  // lower lip at -5, so the fan is raised into the duct); a dark disc
  // just below the fan closes the see-through path through the blade
  // gaps, and sits above the duct's bottom lip, so from below the pod
  // reads as a housed duct, not a disc dangling underneath. The blur
  // disc strengthens with rotor speed so a fast fan reads as a blur,
  // not a frozen star.
  podLocals.forEach((p, i) => {
    const r = p.r || 19;
    // Duct cap disc: full-radius, just below the fan plane (fan bottom
    // is p.y - 1.3; the cap sits 0.5 below that), inside the STL duct
    // and above its bottom lip (-5 fwd, -5.6 aft). Double-sided
    // (ductDark is), so it reads dark from above through the blade
    // gaps and closes the duct from below.
    const cap = new THREE.Mesh(new THREE.CircleGeometry(r * 0.98, 28), DM.ductDark);
    cap.rotation.x = -Math.PI / 2;
    cap.position.set(p.x, p.y - 1.8, p.z);
    cap.name = 'podDuctCap_' + i;
    group.add(cap);
    // Blur disc + its group: the group (rotorAsm_i) belongs to the pod
    // (it hides with the pod when the pod is destroyed); the disc is
    // found by name (rotorBlur_i) and its opacity follows spool.
    const asm = new THREE.Group();
    asm.position.set(p.x, p.y, p.z);
    asm.name = 'rotorAsm_' + i;
    const blur = new THREE.Mesh(new THREE.CircleGeometry(r * 0.94, 28),
      new THREE.MeshBasicMaterial({ color: 0x2a2e33, transparent: true, opacity: 0.04, side: THREE.DoubleSide, depthWrite: false }));
    blur.rotation.x = -Math.PI / 2;
    blur.position.y = 1.15;
    blur.name = 'rotorBlur_' + i;
    asm.add(blur);
    group.add(asm);
  });
}

// Normalise a loaded helicarrier GLB scene. v1.4.0: the STL model is
// pre-normalised in the GLB itself (333 m, centred, bow -Z — the
// converter baked the transform), so this MEASURES rather than rescales
// or rotates: deck extents from deck_top, pod centres/radii from the
// rotorSpin_* fan meshes. v1.4.1: the fans are NOT re-centred — their
// node origins already are their centres (quantized geometry centred
// on the node origin), so rotation.y spins them in place as loaded;
// the fan plane is only raised into the duct (DUCT_Y below).
// Returns { group, deckLocalY, deckHalfX, deckHalfZ, podLocals, scale }.
// deckLocalY is the reference deck height (mid-deck, lz 0); the deck
// itself is sloped — use deckLocalYAt(lz) for any point on it.
export function normalizeHelicarrier(sceneObj) {
  const group = new THREE.Group();
  group.add(sceneObj);
  group.updateMatrixWorld(true);
  hideBadSlabs(group);
  // Deck extents measured from the deck_top strip in group coords.
  let deckBox = null;
  group.traverse(o => {
    if (o.isMesh && o.name.startsWith('deck_top')) {
      const b = new THREE.Box3().setFromObject(o);
      deckBox = deckBox ? deckBox.union(b) : b;
    }
  });
  const deckLocalY = deckLocalYAt(0);
  const deckHalfX = deckBox ? (deckBox.max.x - deckBox.min.x) / 2 : 38;
  const deckHalfZ = deckBox ? (deckBox.max.z - deckBox.min.z) / 2 : 166.5;
  // Pod centres AND radii from the rotorSpin_* fan meshes (group
  // coords), so the caps/blur discs sit exactly inside their ducts.
  const fans = [];
  group.traverse(o => {
    if (o.isMesh && o.name.startsWith('rotorSpin_')) {
      const b = new THREE.Box3().setFromObject(o);
      const c = b.getCenter(new THREE.Vector3());
      const s = b.getSize(new THREE.Vector3());
      fans.push({ mesh: o, x: c.x, y: c.y, z: c.z, r: Math.max(s.x, s.z) / 2 });
    }
  });
  fans.sort((a, b) => (a.z - b.z) || (a.x - b.x));
  const podLocals = [];
  // v1.4.1 DUCT_Y: the fan plane inside the duct. The STL fan's node
  // origin is at y -7.37 — just below the duct walls' lower lip (-5
  // fwd, -5.6 aft; hull_1/9/10 span -5..+0.3) — so the fan belongs
  // mid-duct at -2.5, with the cap just below it (see
  // buildCarrierDetail). The fan disc is 2.6 m thick, so -2.5 puts it
  // fully inside the duct walls.
  const DUCT_Y = -2.5;
  fans.forEach((f, i) => {
    // v1.4.1: do NOT translate the geometry. The v1.4.0 code did
    // geometry.translate(-f.x, -f.y, -f.z) assuming geometry units ==
    // group units — but the fan meshes are meshopt-quantized
    // (normalized Int16 positions, node scale ~18.89 carrying the
    // size), so the translate corrupted the normalized attribute and
    // dropped the rendered fan disc ~12 m below its duct (world y
    // -20.6..-18 instead of -8.7..-6.1 — the dark slab hanging below
    // the pod in Nicholas's screenshot). The node origin already IS
    // the fan centre (geometry is centred on it, ±1 in x/z, ±0.069
    // in y), so rotation.y spins the fan in place with no translate.
    f.mesh.position.set(f.x, DUCT_Y, f.z);
    f.mesh.name = 'rotorSpin_' + i;
    podLocals.push({ x: f.x, y: DUCT_Y, z: f.z, r: f.r });
  });
  while (podLocals.length < 4) podLocals.push({ x: (podLocals.length % 2 ? -40 : 40), y: deckLocalY + 2, z: (podLocals.length < 2 ? -70 : 70), r: 19 });
  buildCarrierDetail(group, podLocals.slice(0, 4), deckLocalY, deckHalfX, deckHalfZ);
  return { group, deckLocalY, deckHalfX, deckHalfZ, podLocals: podLocals.slice(0, 4), scale: 1 };
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
// v1.4.0: the STL meshes are hull_*, island_6 and deck_outer (pod/side
// decks); the procedural duct caps stay dark and the STL fans
// (rotorSpin_*) and the Ford deck texture (deck_top) stay as-is —
// the old model's duct_ring_/hullCore/sternTransom/bowCap/islandCore/
// islandCoaming/podSponson_ meshes no longer exist.
export function applyEnemyLivery(group) {
  group.traverse(o => {
    if (!o.isMesh) return;
    o.material = o.material.clone();
    const n = o.name;
    if (n.startsWith('hull_') || n.startsWith('island_') || n === 'deck_outer') {
      o.material.color.setHex(0x7a2e26);
    }
  });
}

const _bpV = new THREE.Vector3(); // BreakupPiece cut-face scratch
// v1.6.0 B1: piece world-box scratch (see BreakupPiece.pieceBoxCorners).
const _bpBox = { minY: 0, maxY: 0, minX: 0, minZ: 0, cx: 0, cy: 0, cz: 0 };
// v1.4.0 venting pool guards (research §5): cut-face venting stops
// emitting once live sprites exceed 300 of S_MAX (420) or live
// particles exceed 1200 of P_MAX (1600) — the pools are shared
// stealers. The detonation bursts themselves peak ~900–1100 particles
// (pre-existing double magazineSecondary + hitFX), so a 50% particle
// guard would silence venting for the first seconds after every
// detonation; 1200 still leaves 25% headroom for fires elsewhere.
const S_MAX_GUARD = 300, P_MAX_GUARD = 1200;

export class BreakupPiece {
  constructor(scene, group, vy, rollRate, pitchRate, yawRate, vx = 0, vz = 0) {
    this.id = ++_pieceSeq;
    this.group = group; this.scene = scene;
    this.vy = vy; this.vx = vx; this.vz = vz; // v1.2.0: pieces inherit the
    // carrier's velocity plus a separation impulse from the blast, so
    // they fly apart ballistically instead of dropping straight down.
    this.rollRate = rollRate; this.pitchRate = pitchRate; this.yawRate = yawRate;
    this.state = 'falling'; this.sinkT = 0; this.y = group.position.y;
    this.roll = group.rotation.z; this.pitch = group.rotation.x; this.heading = -group.rotation.y;
    this.impactY = 0; this.bubbleT = 0; this.boilT = 0;
    this.clipMats = []; // v1.3.2: materials whose clip planes follow the piece
    // v1.4.0 fragmentation + mass: set by _mkPiece — segLen (m), reason
    // ('detonation' | structural | 'water impact'), capMeshes (hot-band
    // fade), petalGroups (hinge reveal), cutFaces [{lx,ly,lz}] (vent /
    // shed emitters, local coords), bornT (game time of release).
    this.segLen = 60; this.reason = 'structural'; this.capMeshes = [];
    this.petalGroups = []; this.cutFaces = []; this.bornT = 0;
    this.sinkDur = 30; this.impactRoll = 0; this.petalT = 0;
    this._shedAcc = 0; this._ventT = 0; this._fadeT = 0; this._hotFadeDone = false;
    this.ventCount = 0; this.shedCount = 0; // probe counters (research §7 venting check)
    // v1.5.0: per-piece fall identity (see the re-derivation above
    // addDiagonalCap). massFrac/areaFrac/dragK default to a uniform-
    // density hull section (vt 291 m/s flat); assemblies and debris
    // set them explicitly. cookoffs: pending D11 bursts transferred
    // from the breakup plan at release (times are seconds after
    // bornT). imploded: D14 fired once. rockAmp: D3/§3 flutter —
    // a long flat piece rocks with growing amplitude before shedding.
    this.massFrac = null; this.areaFrac = 1; this.dragK = 1;
    this.cookoffs = []; this.imploded = false; this.rockAmp = 0;
    this.rockT = 0; this.smokeTrail = false; this.burning = false;
    this.assembly = null; // 'island' | 'pod' | 'strip' | 'remnant' | null
    // v1.6.0 duplicates fix (B): a HELD piece is a segment that has
    // been spawned as a piece but not yet released — it rides with the
    // carrier (transform driven by updateBreakup) until its releaseAt,
    // when _armPiece gives it motion. While held it has no physics of
    // its own and is not a collision body (see solidBodies).
    this.held = false;
    this.halfBeamOverride = null; this.halfHOverride = null;
    this.centreLocal = null; // {x,y,z} centre offset in group-local space
    this._cookAcc = 0; this._trailT = 0; this._rockShedT = 0;
    scene.add(group);
  }
  // v1.4.2: same real freefall as the whole hull (see PHYSICS.FALL_*):
  // a = -g + a_drag, with the piece's own projected area and mass
  // (uniform linear density: both scale with segLen, so the drag
  // coefficient k equals the whole-hull value and the flat terminal
  // velocity is the same 291 m/s). The old pieceVt (36-54 m/s) with a
  // tau=2.5 s chase gave ~18 m/s^2 initial acceleration — the same
  // faster-than-g error as the hull. Pieces now fall at g and are
  // still accelerating at the sea.
  // Cut-face world position (cap centroid), for venting/shedding.
  cutFaceWorld(i, out) {
    const f = this.cutFaces[i % this.cutFaces.length];
    this.group.updateWorldMatrix(true, false);
    return out.set(f.lx, f.ly, f.lz).applyMatrix4(this.group.matrixWorld);
  }
  // v1.6.0 B1: the piece's world-space box, from its own geometry —
  // never the carrier origin. Hull pieces span local x ±halfBeam
  // (centred on centreLocal.x), y keel -34 to deck +6 (+34 with an
  // island segment — the measured solid-mesh extents, 27 Nov), z -segHi..-segLo (local z = -d). Assemblies are
  // centred on their own origin with (halfBeamOverride,
  // halfHOverride, segLen/2). Fills `out` with minY/maxY, the lowest
  // corner's (minX, minZ) for the sea sample, and the box centre.
  pieceBoxCorners(out) {
    const g = this.group;
    g.updateWorldMatrix(true, false);
    const m = g.matrixWorld.elements;
    const hb = this.halfBeamOverride || 42;
    const cx = (this.centreLocal && this.centreLocal.x) || 0;
    let yLo, yHi;
    if (this.assembly) {
      const hh = this.halfHOverride || 3;
      yLo = -hh; yHi = hh;
    } else {
      yLo = -34;
      yHi = (this.segLo !== undefined && this.segLo <= -47 && this.segHi >= -98) ? 34 : 6;
    }
    let zLo, zHi;
    if (this.segLo !== undefined && this.segHi !== undefined) { zLo = -this.segHi; zHi = -this.segLo; }
    else { const c = -(this.segCentre || 0), h = (this.segLen || 60) / 2; zLo = c - h; zHi = c + h; }
    const xs = [cx - hb, cx + hb], ys = [yLo, yHi], zs = [zLo, zHi];
    let minY = Infinity, maxY = -Infinity, minX = 0, minZ = 0, cxW = 0, cyW = 0, czW = 0;
    for (const x of xs) for (const y of ys) for (const z of zs) {
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      if (wy < minY) { minY = wy; minX = wx; minZ = wz; }
      if (wy > maxY) maxY = wy;
      cxW += wx; cyW += wy; czW += wz;
    }
    out.minY = minY; out.maxY = maxY; out.minX = minX; out.minZ = minZ;
    out.cx = cxW / 8; out.cy = cyW / 8; out.cz = czW / 8;
    return out;
  }
  // v1.6.0 B2: per-fragment buoyancy — equilibrium draft (metres the
  // lowest corner sits below the sea) and flood time (seconds to flood
  // from equilibrium to fully submerged). Hull sections are big sealed
  // boxes (~6 m draft); island/pod/strip are light and ride high;
  // pulverised remnants are negatively buoyant and sink at once.
  _buoyancy() {
    if (this.assembly === 'island') return { draft: 0.8, floodDur: 150 };
    if (this.assembly === 'pod') return { draft: 1.2, floodDur: 80 };
    if (this.assembly === 'strip') return { draft: 0.4, floodDur: 180 };
    if (this.assembly === 'remnant') return { draft: 0, floodDur: 6 };
    return { draft: 6, floodDur: this.sinkDur || 30 };
  }
  update(dt, ctx) {
    // v1.6.0 duplicates fix (B): a held piece does not integrate — the
    // carrier drives its transform (updateBreakup) and re-aims its clip
    // planes there. Its own fall starts at release (_armPiece).
    if (this.held) return;
    if (this.state === 'falling') {
      const lenFrac = Math.max(20, this.segLen || 60) / 333;
      // v1.5.0: piece drag/mass from the piece's own identity (see the
      // re-derivation above addDiagonalCap): area scales with the
      // piece's planform and dragK, mass with massFrac. A hull section
      // keeps lenFrac for both (vt 291 m/s, as before); an island, a
      // pod, a deck strip or pulverised debris falls at its own vt
      // (114 / 116 / 46 / ~110 m/s — measured 2026-11-27, see the table
      // above addDiagonalCap; remnant vt updated v1.6.2 with the chunk)
      // path by ballistic coefficient (TWA 800 debris zones).
      const area = fallProjectedArea(this.pitch, this.roll) * lenFrac * (this.areaFrac || 1) * (this.dragK || 1);
      const mass = PHYSICS.MASS * (this.massFrac !== null && this.massFrac !== undefined ? this.massFrac : lenFrac);
      this.vy += (-9.81 + fallDragAccel(this.vy, area, mass)) * dt;
      this.y += this.vy * dt;
      // Ballistic drift: horizontal velocity decays with air drag,
      // τ = 0.13·L s (audit §1) — a 60 m section keeps its separation
      // speed for ~8 s, a 150 m half-ship for ~20 s.
      const drag = Math.exp(-dt / (0.13 * Math.max(20, this.segLen || 60)));
      this.vx *= drag; this.vz *= drag;
      this.group.position.x += this.vx * dt;
      this.group.position.z += this.vz * dt;
      // v1.4.0 mass (audit F4): tumbling decays in air, τ≈8 s — pieces
      // settle instead of spinning at a constant rate all the way down.
      const rDecay = Math.exp(-dt / 8);
      this.rollRate *= rDecay; this.pitchRate *= rDecay; this.yawRate *= rDecay;
      // v1.5.0 §3 flutter: a long flat piece falling flat hunts for a
      // stable attitude — it rocks nose-up/nose-down with GROWING
      // amplitude, loading the fracture planes cyclically. The rock is
      // a pitch oscillation on top of the tumble (it never drives the
      // rates — it is a visible attitude wobble), and once the
      // amplitude passes ~6° the piece sheds a burst of small debris
      // (the crack growing under cyclic load) every ~2 s.
      if (this.rockAmp > 0) {
        this.rockT += dt;
        this.rockAmp = Math.min(0.12, this.rockAmp + dt * 0.012);
        this.pitch += Math.sin(this.rockT * 1.5) * this.rockAmp * dt * 2;
        this._rockShedT -= dt;
        if (this.rockAmp > 0.1 && this._rockShedT <= 0) {
          this._rockShedT = 2;
          this.group.updateWorldMatrix(true, false);
          _bpV.set(0, 0, 0).applyMatrix4(this.group.matrixWorld);
          ctx.vfx.burst(_bpV.x, _bpV.y, _bpV.z, 8, [0.4, 0.4, 0.4], 3, 1);
        }
      }
      // v1.5.0 D5: a torn-off pod's rotor keeps spinning while attached
      // to the piece, decaying over ~6 s (gyroscopic stiffness while
      // spinning, then tumble once it slows).
      if (this.spinMesh) {
        this.spinRate *= Math.exp(-dt / 6);
        this.spinMesh.rotation.y += this.spinRate * dt;
      }
      this.roll += this.rollRate * dt; this.pitch += this.pitchRate * dt; this.heading += this.yawRate * dt;
      this.group.position.y = this.y;
      this.group.rotation.set(this.pitch, -this.heading, this.roll);
      // v1.6.2: the detached-assembly smoke trail is gone — one black
      // sprite every 0.4 s behind a falling piece read as a floating
      // line of black orbs. No replacement; the piece itself is the visual.
      // v1.5.0 D11: cook-offs transferred from the breakup plan fire
      // here, on the piece, on the compressed real clock (see breakUp)
      // — including after the piece has left the ship. Visual/audio
      // only, as always.
      this._fireCookoffs(dt, ctx);
      // Petals revealed by the hinge over 0.25 s after release.
      if (this.petalT < 1) {
        this.petalT = Math.min(1, this.petalT + dt / 0.25);
        const s = Math.max(0.001, this.petalT);
        for (const pg of this.petalGroups) pg.scale.setScalar(s);
      }
      // Shedding: torn edges throw sparks while fresh — ~6–12/s/piece
      // for the first ~8 s, fading as the edges cool (research §4.4).
      // Budget: 6 pieces × 10/s × ~1 s life ≈ 60 live particles.
      const tSince = (ctx.time || 0) - (this.bornT || 0);
      const tumble = Math.abs(this.rollRate) + Math.abs(this.pitchRate);
      const rate = 9 * (0.5 + tumble) * Math.exp(-tSince / 8);
      this._shedAcc += rate * dt;
      if (this._shedAcc >= 1 && this.cutFaces.length) {
        this._shedAcc -= 1;
        this.shedCount++;
        const w = this.cutFaceWorld(0, _bpV);
        ctx.vfx.spawnParticle(w.x + (Math.random() - 0.5) * 8, w.y + (Math.random() - 0.5) * 6, w.z + (Math.random() - 0.5) * 8,
          (Math.random() - 0.5) * 4, 1 + Math.random() * 3, (Math.random() - 0.5) * 4, 0.6 + Math.random() * 0.7, 1, 0.5, 0.1, -3);
      }
      // Cut-face venting (research §5): detonation cuts vent flame for
      // the first 10 s after release, structural cuts embers only
      // (v1.6.2: the black smoke sprite is gone — it lined every tear
      // with floating black orbs); one emission per face per 0.5 s,
      // pool-guarded (never assume a spawn survives; halve the rate
      // under pool pressure).
      if (this.cutFaces.length && tSince < 12) {
        this._ventT -= dt;
        if (this._ventT <= 0) {
          this._ventT = 0.5;
          const spritesLive = ctx.vfx.liveSprites ? ctx.vfx.liveSprites() : 0;
          const partsLive = ctx.vfx.liveParticles ? ctx.vfx.liveParticles() : 0;
          if (spritesLive < S_MAX_GUARD && partsLive < P_MAX_GUARD) {
            for (let i = 0; i < this.cutFaces.length; i++) {
              this.ventCount++;
              const w = this.cutFaceWorld(i, _bpV);
              if (this.reason === 'detonation' && tSince < 10) {
                ctx.vfx.spawnSprite(w.x, w.y, w.z, 0.4, 12, 12, 3, 0xff8c2e, 0.9).vy = 3;
              }
              // v1.6.2: the black cut-face smoke sprite is gone — one
              // per face per 0.5 s, it lined the tear with floating
              // black orbs. The cut still vents flame (detonation) and
              // embers below.
              for (let e = 0; e < 3; e++) {
                ctx.vfx.spawnParticle(w.x, w.y, w.z, (Math.random() - 0.5) * 3, 3 + Math.random() * 2, (Math.random() - 0.5) * 3, 0.8, 1, 0.5, 0.1, -6);
              }
            }
          }
        }
      }
      // Hot-band fade: once per game second, lerp the hot cap vertices
      // toward torn steel — the fresh detonation glow cools over ~20 s.
      this._fadeT -= dt;
      if (this._fadeT <= 0) {
        this._fadeT = 1;
        for (const cap of this.capMeshes) {
          if (!cap.userData.hotFade || cap.userData.hotFade <= 0) continue;
          cap.userData.hotFade -= 1;
          const colAttr = cap.geometry.attributes.color;
          const steel = { r: 0.2, g: 0.22, b: 0.24 };
          for (const idx of cap.userData.hotIdx || []) {
            const f = 0.12; // ~12% per second toward steel
            colAttr.setXYZ(idx,
              colAttr.getX(idx) + (steel.r - colAttr.getX(idx)) * f,
              colAttr.getY(idx) + (steel.g - colAttr.getY(idx)) * f,
              colAttr.getZ(idx) + (steel.b - colAttr.getZ(idx)) * f);
          }
          colAttr.needsUpdate = true;
        }
      }
      // v1.6.0 B1: water entry is anchored to the piece's own lowest
      // corner, not the carrier origin — the old origin test fired the
      // splash up to 151 m early or 31 m late, and the sink curve below
      // jumped the group origin to the sea in one frame. The splash
      // lands at the lowest corner's position on the water.
      const box = this.pieceBoxCorners(_bpBox);
      const seaH = ctx.sea.waveHeight(box.minX, box.minZ, ctx.time);
      if (box.minY <= seaH) {
        this.impactY = seaH;
        this.impactRoll = this.roll;
        // v1.4.0: a piece that hits nose-first gains a one-off pitch
        // kick toward its heavy end (research §4.2).
        if (Math.abs(this.pitch) > 0.15) this.pitchRate += Math.sign(this.pitch) * 0.15;
        ctx.vfx.splash(box.minX, seaH, box.minZ, Math.abs(this.vy));
        ctx.vfx.burst(box.minX, seaH + 2, box.minZ, 30, [0.9, 0.9, 0.9], 8, 6);
        // v1.6.0 B2: a buoyant piece floats at its equilibrium draft
        // and floods from there; a negatively buoyant remnant sinks
        // straight away on the deep curve (anchored to its own origin
        // altitude at entry, so there is no one-frame jump).
        const b = this._buoyancy();
        if (b.floodDur <= 8) {
          this.state = 'sinking'; this.sinkT = 0; this._deepStartY = this.y;
        } else {
          this.state = 'floating'; this.floodF = 0; this._buoy = b;
          this._floodSide = Math.sign(this.rollRate) || (this.roll >= 0 ? 1 : -1);
        }
      }
    } else if (this.state === 'floating') {
      // v1.6.0 B2: the piece rides at its equilibrium draft, bobbing
      // with the live sea and listing/trimming as it floods. It only
      // leaves the surface by sinking once fully flooded — never by
      // popping, never flat like a stone unless the physics says so.
      // The waterline is controlled by the box CENTRE, not the lowest
      // corner: a long tilted piece touches with one corner while its
      // centre is still tens of metres up, and chasing the corner
      // would hang it in the air. Centre target = sea + halfV − draft,
      // so the lowest corner still sits exactly `draft` under at
      // equilibrium, and the piece settles DOWN onto the water as it
      // rights itself (halfV shrinks as it levels).
      const b = this._buoy || (this._buoy = this._buoyancy());
      this.floodF = Math.min(1, (this.floodF || 0) + dt / b.floodDur);
      const box = this.pieceBoxCorners(_bpBox);
      const seaH = ctx.sea.waveHeight(box.cx, box.cz, ctx.time);
      const boxH = Math.max(1, box.maxY - box.minY);
      const halfV = boxH / 2;
      const draft = b.draft + this.floodF * (boxH - b.draft);
      const err = (seaH + halfV - draft) - box.cy;
      const dy = Math.max(-5 * dt, Math.min(5 * dt, err));
      this.y += dy; this.group.position.y = this.y;
      // Horizontal drift decays in water; tumbling decays too.
      const drag = Math.exp(-dt * 0.6);
      this.vx *= drag; this.vz *= drag;
      this.group.position.x += this.vx * dt;
      this.group.position.z += this.vz * dt;
      const rDecay = Math.exp(-dt / 8);
      this.rollRate *= rDecay; this.pitchRate *= rDecay; this.yawRate *= rDecay;
      this.roll += this.rollRate * dt * 0.3;
      this.pitch += this.pitchRate * dt * 0.3;
      this.heading += this.yawRate * dt * 0.3;
      // Flooding list/trim (intact model): the list grows toward the
      // flood side as compartments fill, bow-first trim, wave-slope
      // coupling while near the surface. A floating section also
      // RIGHTS itself toward level as the tumble dies — a 110 m piece
      // that touched corner-first at 60° roll must settle onto the
      // water, not hang tilted for the rest of the round — so the
      // impact roll decays and the chase runs at 0.10 rad/s, not the
      // intact hull's 0.03.
      const od = ctx.sea.getOceanDataAt(box.cx, box.cz, ctx.time);
      const listTarget = this.impactRoll * (1 - this.floodF * 0.5) + (this._floodSide || 1) * 0.35 * this.floodF
        + od.slopeX * 0.3 * (1 - this.floodF);
      const rollErr = listTarget - this.roll;
      this.roll += Math.max(-0.10 * dt, Math.min(0.10 * dt, rollErr));
      this.pitch += (-0.05 - this.pitch) * Math.min(1, dt * 0.2);
      this.group.rotation.set(this.pitch, -this.heading, this.roll);
      // v1.6.2: floor-aware floating — a long steep piece floods until
      // its top is at the surface, which can drive its lowest corner
      // through the seabed; the sinking branch would then snap it back
      // UP to its rest altitude in one frame (popcheck: +21 m on a
      // diagonal hull section). Clamp the corner to the floor here so
      // the handover to sinking is continuous.
      const fb = this.pieceBoxCorners(_bpBox);
      if (fb.minY < SEA_FLOOR_Y) { this.y += SEA_FLOOR_Y - fb.minY; this.group.position.y = this.y; }
      // Bubbles while flooding (same cadence shape as the sinking
      // branch, driven by flood fraction instead of sink fraction).
      this.bubbleT -= dt;
      if (this.bubbleT <= 0 && this.floodF < 0.9) {
        this.bubbleT = 0.12 - 0.08 * Math.min(1, this.floodF / 0.7);
        ctx.vfx.bubbles(this.group.position.x, this.impactY, this.group.position.z, 4, 60);
      }
      this._fireCookoffs(dt, ctx);
      if (this.floodF >= 1) {
        // Fully flooded: hand over to the deep sink, anchored to the
        // origin altitude at handover (no jump).
        this.state = 'sinking'; this.sinkT = 0; this._deepStartY = this.y;
      }
    } else if (this.state === 'sinking') {
      this.sinkT += dt / this.sinkDur;
      const f = Math.min(1, this.sinkT);
      // v1.6.0 B1: the deep curve is anchored to the origin altitude
      // at water entry / flood handover, not to the sea — the old
      // impactY-anchored curve teleported the piece to the surface.
      const fu = Math.min(4, this.sinkT);
      const startY = this._deepStartY !== undefined ? this._deepStartY : this.impactY;
      // v1.6.0 Item 2: the deep curve ends on the seabed, not at -55 m +
      // hide. restY is the origin altitude at which this piece's lowest
      // corner touches SEA_FLOOR_Y (from its own live box, so a rolled
      // piece rests on its bilge, not through the floor or hovering).
      // The curve is clamped from below: once a corner touches the floor
      // the piece has arrived and becomes a resting wreck.
      const restBox = this.pieceBoxCorners(_bpBox);
      const restY = SEA_FLOOR_Y - (restBox.minY - this.y);
      // Item 2 fix (27 Nov): the old fixed 55 m drop stranded thin
      // pieces — a level remnant rests at -87 m but the curve bottomed
      // at -55 m, so it hovered there until the sinkT>=4 safety snapped
      // it 32 m to the floor. The drop is now deep enough to reach the
      // floor (55 m minimum, so carriers behave exactly as before), and
      // the clamp lands the piece on the seabed with no snap.
      const drop = Math.max(55, startY - restY + 5);
      const curveY = startY - fu * fu * drop;
      const clamped = curveY <= restY;
      this.group.position.y = clamped ? restY : curveY;
      this.y = this.group.position.y; // v1.4.0: keep the field honest (was stale at impactY in v1.3)
      // v1.3.2: sinking pieces keep drifting apart horizontally (with
      // drag) and slowly tumbling instead of freezing in a pile at the
      // impact point. Water-impact fragments are born at the same spot;
      // without this they sink as one overlapping mass and read as the
      // same "duplicates" glitch the clip fix addresses.
      // v1.4.0 mass (research §4.3): water stops horizontal drift fast,
      // τ≈0.6 s in the exponent; tumbling decays τ=8 s once submerged
      // (audit F11) — water does not let a 20,000 t section keep
      // cartwheeling at 0.3× its fall rate for 30 s.
      const drag = Math.exp(-dt * 0.6);
      this.vx *= drag; this.vz *= drag;
      this.group.position.x += this.vx * dt;
      this.group.position.z += this.vz * dt;
      const rDecay = Math.exp(-dt / 8);
      this.rollRate *= rDecay; this.pitchRate *= rDecay; this.yawRate *= rDecay;
      this.roll += this.rollRate * dt * 0.3;
      this.pitch += this.pitchRate * dt * 0.3;
      this.heading += this.yawRate * dt * 0.3;
      // Roll approaches the piece's own impact list at ≤0.03 rad/s
      // (audit F11) — not a fixed 0.4 rad at τ=2 s.
      const rollErr = this.impactRoll - this.roll;
      this.roll += Math.max(-0.03 * dt, Math.min(0.03 * dt, rollErr));
      this.group.rotation.set(this.pitch, -this.heading, this.roll);
      // v1.5.0 §4.2: bubbles/boil INCREASE as the trapped air is forced
      // out, then stop when the hull is full — the bubble interval
      // shortens from 0.12 s to 0.04 s as f goes 0 -> 0.7, and nothing
      // emits past f = 0.9 (was a flat 0.12 s / 0.4 s cadence).
      // v1.5.0 D14 implosion at depth (Derbyshire: voids collapse at
      // 25-100 m): below 25 m a sinking piece shows a late underwater
      // bubble/debris burst as an air pocket collapses — a second
      // explosion underwater, after the visible sinking. Fires once.
      if (!this.imploded && this.group.position.y < -25) {
        this.imploded = true;
        ctx.vfx.implosionBurst(this.group.position.x, this.group.position.y, this.group.position.z);
        if (ctx.audio) ctx.audio.boom(false);
      }
      this.bubbleT -= dt;
      if (this.bubbleT <= 0 && f < 0.9) {
        this.bubbleT = 0.12 - 0.08 * Math.min(1, f / 0.7);
        ctx.vfx.bubbles(this.group.position.x, this.impactY, this.group.position.z, 4, 60);
      }
      this.boilT -= dt;
      if (this.boilT <= 0 && f > 0.1 && f < 0.9) { this.boilT = 0.4 - 0.2 * Math.min(1, f / 0.7); ctx.vfx.boil(this.group.position.x, this.impactY, this.group.position.z, 40); }
      // v1.5.0 D11: a burning wreck keeps cooking off on the surface
      // after the sinking starts (post-splashdown cook-offs).
      this._fireCookoffs(dt, ctx);
      // v1.6.0 Item 2: the piece never leaves. When its lowest corner
      // reaches the seabed it becomes a resting wreck — visible and
      // selectable for the rest of the round (the old pop hid it at
      // ~-55 m and the L3144 filter then deleted it from c.pieces).
      // Safety: if the floor test somehow never fires, rest at sinkT >= 4.
      if (clamped || this.sinkT >= 4) {
        this.state = 'rested';
        // Snap exactly onto the floor with the final attitude (a few
        // metres at most — the clamp already holds it there).
        const rb = this.pieceBoxCorners(_bpBox);
        this.y += SEA_FLOOR_Y - rb.minY; this.group.position.y = this.y;
        this.rollRate = 0; this.pitchRate = 0; this.yawRate = 0;
        // v1.4.0 (item 6): the piece leaves floating wreckage where it
        // sank — 4 scorched chunks + an oil slick that persist for the
        // rest of the round (see js/wreckage.js). Guarded: hand-built
        // ctx objects in probes may not carry a wreckage field.
        // v1.5.0 D12: a burning piece leaves a BURNING slick (orange
        // emissive edge, flames for the first minute) instead of oil.
        if (ctx.wreckage) ctx.wreckage.spawn(this.group.position.x, this.group.position.z, {
          name: (this.carrierName || 'piece') + '-piece', heading: this.heading,
          along: Math.max(20, (this.segLen || 60) * 0.4), across: 20,
          chunks: 4, slickR0: 22, vx: this.vx, vz: this.vz, born: ctx.time,
          burning: !!this.burning,
        });
        // At rest on the seabed: no drift, no fall speed (the slick above
        // already inherited the drift velocity).
        this.vx = 0; this.vz = 0; this.vy = 0;
      }
    } else if (this.state === 'rested') {
      // v1.6.0 Item 2: a wreck on the seabed. It never despawns — it stays
      // visible and selectable for the rest of the round. The attitude
      // keeps settling toward its impact list (≤0.03 rad/s, as while
      // sinking) and the origin is re-snapped every frame so the lowest
      // corner stays exactly on the floor as it rolls — no sinking
      // through it, no hovering above it. No bubbles, no drift: at rest.
      const rollErr = this.impactRoll - this.roll;
      this.roll += Math.max(-0.03 * dt, Math.min(0.03 * dt, rollErr));
      this.group.rotation.set(this.pitch, -this.heading, this.roll);
      const rb = this.pieceBoxCorners(_bpBox);
      this.y += SEA_FLOOR_Y - rb.minY; this.group.position.y = this.y;
      this._fireCookoffs(dt, ctx);
    }
    // v1.3.2: re-aim the cut planes every frame (see refreshClipPlanes).
    // v1.6.0 Item 2: no piece state is 'gone' any more (wrecks rest on
    // the seabed instead of despawning), so this is unconditional.
    this.refreshClipPlanes();
  }
  // v1.5.0 D11: fire any pending cook-offs whose clock has come due.
  // Each burst is visual/audio only. The clock is the compressed real
  // clock (Forrestal 94 s thin-cased / 8-10 min thick-cased, compressed
  // to 0.5-30 s for playability — see breakUp()).
  _fireCookoffs(dt, ctx) {
    if (!this.cookoffs || !this.cookoffs.length) return;
    const tSince = (ctx.time || 0) - (this.bornT || 0);
    for (const ck of this.cookoffs) {
      if (ck.fired || tSince < ck.at) continue;
      ck.fired = true;
      ctx.vfx.cookoffBurst(this.group.position.x, this.group.position.y + 4, this.group.position.z, ck.size || 1);
      if (ctx.audio) ctx.audio.boom(false);
    }
  }
  // v1.3.2: the cut planes travel with the piece. Hurricane's splitShip
  // re-aims its clip planes every frame so the cut follows each half as
  // it drifts and turns; the v1.3.0 port baked the planes once in world
  // space, so a tumbling clone was sliced by a fixed slab and showed
  // other sections of the ship — the "glitching duplicates" Nicholas
  // reported. Planes are stored in the piece's local space (cut along
  // local Z) and re-transformed to world space from the piece's matrix
  // every frame, so each piece always shows exactly its own section.
  refreshClipPlanes() {
    if (!this.clipMats || !this.clipMats.length) return;
    this.group.updateMatrix();
    this.group.matrixWorld.copy(this.group.matrix);
    for (const m of this.clipMats) {
      const locals = m.userData.clipLocals;
      if (!locals) continue;
      for (let i = 0; i < locals.length; i++) {
        m.clippingPlanes[i].copy(locals[i]).applyMatrix4(this.group.matrixWorld);
      }
    }
  }
  // v1.6.0 Item 2: the old `get gone()` (state === 'gone') fed the
  // L3144 filter that deleted pieces from c.pieces. No piece ever goes
  // 'gone' now — wrecks rest on the seabed in state 'rested' — so the
  // getter and the filter are both gone with it.
}
let _carrierSeq = 0;
let _pieceSeq = 0; // breakup-piece ids (collisions.js pair keys + probe logs)

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
    // v1.6.0 hold (INDV/ANCHOR): the ordered speed + heading captured
    // at the moment a ship becomes held, so she sails on in her
    // previous state instead of being ordered to stop. Null = not held.
    this.holdSpeed = null;
    this.holdHeading = null;
    // v1.4.0 flight-physics states (spec §9): headingRate/pitchRate are
    // lagged rate states, bank is the coordinated-turn result (never an
    // input), spoolSpeed is the ordered-speed state (see game.js).
    this.headingRate = 0; // rad/s
    this.pitchRate = 0; // rad/s
    this.bank = 0; // rad — visual roll from the actual turn rate
    // v1.4.0 throttle (collective-style rotor strength, 0..1; hover at
    // 1/1.45 = 0.69). Player helm sets it on the selected carrier each
    // frame; escorts/AI keep the hover default.
    this.throttle = PHYSICS.THROTTLE_HOVER;
    // v1.6.2 _liftSpool: lift actually produced (fraction of weight).
    // It cuts instantly when throttle drops (fans stop — the v1.4.2
    // freefall model) and spools UP with ROTOR_SPOOL_TAU (6 s), the
    // same asymmetric spool as the falling branch's _fallSpool. Init
    // 1.0 = hover lift: every carrier spawns intact at hover throttle
    // (pods are built below, so lift cannot be read here yet).
    this._liftSpool = 1;
    this.liftThrustNow = 0; // v1.4.2: lift actually produced (fraction of weight) — read by the downwash builder + probes; set every frame in the alive/falling branches
    // v1.4.0 lever arms measured from the GLB's own pod centres
    // (template.podLocals): mean |z| 65.1 m (pitch), mean |x| 58.2 m
    // (roll/yaw). Angular accel from the max 25%-of-W control
    // differential: pitch 0.0173, yaw 0.0148 rad/s^2 (spec nominals
    // 0.024/0.011 assumed 90/42 m levers — re-derived here, §12.3).
    const leverPitch = opts.template.podLocals.reduce((a, p) => a + Math.abs(p.z), 0) / opts.template.podLocals.length;
    const leverRoll = opts.template.podLocals.reduce((a, p) => a + Math.abs(p.x), 0) / opts.template.podLocals.length;
    this.leverPitch = leverPitch; this.leverRoll = leverRoll;
    this.pitchAccel = 0.25 * PHYSICS.WEIGHT * leverPitch / PHYSICS.INERTIA_PITCH;
    this.yawAccel = 0.25 * PHYSICS.WEIGHT * leverRoll / PHYSICS.INERTIA_YAW;
    this.roll = 0; this.pitch = 0; this.list = 0;
    this.yawRate = 0;
    this.slot = { dx: 0, dz: 0, dy: 0 };
    this.avoidUntil = 0; this.avoidOther = null; // post-impact avoidance window (collisions.js NEW-1)
    this.state = 'alive'; // alive | falling | sinking | capsizing | gone | rested (v1.6.0 Item 2: 'rested' = wreck on the seabed)
    this.fallT = 0; this.sinkT = 0; this.impactY = 0;
    this.fallRollRate = 0; this.fallPitchRate = 0; this.fallYawRate = 0;
    this.breakupT = 0; this.pieces = [];
    // v1.4.0 progressive breakup (research §3): breakUp() is split
    // into beginBreakup() (phases 1–3 on the intact group: crack
    // propagation, hinge, staggered peel) and separatePiece() (phase 4,
    // one segment at a time). breakState: none | cracking | hinging |
    // separating; the ship is lost at the FIRST release, not the last.
    this.breakState = 'none'; this.breakT = 0; this.breakHinge = 0;
    this._breakPlan = null; this._breakCtx = null; this._breakReleased = 0;
    this._breakFirstReleased = false; this._crackRibbons = [];
    // v1.6.0 duplicates fix (C): after a D9 crippled core falls, any
    // later breakUp re-segments ONLY this surviving [lo, hi] range
    // (d units) — never the full hull, whose other regions already
    // exist as pieces. Null unless a D9 has happened.
    this._coreRange = null;
    this._brkSeq = 0; this._hitSeq = 0; this._lastBlastKey = null;
    // v1.4.1 breakup variety: a per-carrier, per-round seed. Every
    // breakup decision — fracture paths (fracSeed), cut spread, stagger,
    // hinge, cook-offs, fall tumble — draws from this RNG, never from
    // Math.random(), so no two carriers break up the same way and no
    // two rounds repeat the same breakup for the same carrier.
    this._brkSeed = (Math.random() * 2 ** 32) >>> 0;
    this._brkRng = mulberry32(this._brkSeed);
    this._breakList = 0; this._breakListTarget = 0; // v1.4.1: pre-breakup list (eases in during cracking/hinging)
    this._sinkDur = 30; // v1.4.1: intact-sinking duration, varied per kill (24–38 s)
    this._fallVentT = 0; // v1.4.1: falling-vent timer (smoke while falling hurt)
    this._washAcc = 0; // v1.4.2: downwash spray/mist emission accumulator
    // v1.5.0: damage-detail state (§6). _damageList is the stepped list
    // (radians toward the dead side) added by damage events — pod lost
    // +3°, magazine/engines destroyed +5°, deck destroyed (hatch
    // fails) +8° — so the list grows in steps tied to events, not by
    // smooth easing. _listSteps records each step for probes.
    this._damageList = 0; this._listSteps = [];
    // v1.5.0 D8: flooding state machine while capsizing (null unless
    // capsizing). lastCapsize records the staged list for probes.
    this._capsize = null; this.lastCapsize = null;
    // v1.5.0 D9: crippled-flight shedding — the ship keeps flying while
    // shedding; _crippledLift is the lift still produced (decays to 0).
    this._crippled = false; this._crippledLift = 0;
    // v1.5.0 D13: true-hull-flex prototype hinge groups (structural
    // kill path only) — two clipped clones hinged before separation.
    this._flexGroups = null; this._flexMats = [];
    // v1.5.0 D3: deck buckling/peel — transient overlay meshes on the
    // intact group during cracking/hinging (removed from piece clones).
    this._buckleMeshes = [];
    // v1.5.0 §6: island lights (bridge windows + nav lights) get
    // per-carrier materials so a dead bridge can kill them visibly.
    this._islandLights = [];
    // v1.5.0 §3: freefall tear-off (aero load finishing weakened
    // damage) fires at most once per fall.
    this._fallTearDone = false;
    // v1.5.0 sinking: flood-stage list/trim steps + implosion flag.
    this._sinkFloodStage = 0; this._sinkImploded = false;
    this._sinkTrimTarget = 0;
    this._fallZeroThrottle = false; // v1.4.1: this fall is a zero-throttle fall (pods alive, recoverable)
    this._fallSpool = 0; // v1.4.1: spooled lift thrust (fraction of weight) during a zero-throttle fall
    this.sinkRollTarget = 0; // F10: final list from the damage state
    this.scorches = [];
    this.pitchInput = 0; // v1.2.0 helm pitch command, -1..1 (+ = nose up)
    this.heelKick = 0; // v1.3.0 blast heel (decays in update)
    this.blastVx = 0; this.blastVz = 0; // v1.3.0 blast shove velocity
    this.blastYaw = 0; // v1.3.0 blast yaw kick rate
    this.lastHit = null; // v1.2.0: killing-blow context for varied breakup
    this.radar = null; // island radar bar (spins)
    // Zones
    this.pods = opts.template.podLocals.map((p, i) => ({
      hp: ZONE_HP.pod, alive: true, local: p, meshes: [], disc: null,
      rotorSpin: null, blur: null, spinRate: 0, spinAngle: 0, wobble: 0, // v1.4.1 film beat (Winter Soldier/ILM): engines wobble when hit — a struck fan tilts and shudders, decaying over ~1 s
      // v1.4.0: diagonal pairs spin the same way, adjacent pods
      // counter-rotate (quadcopter-style). Pod order is sorted by
      // (z, x), so the old index rule (i===0||i===3) pairs the WRONG
      // diagonals on this model; sign(x*z) pairs them correctly:
      // (port-bow, stbd-stern) share a sign, (stbd-bow, port-stern)
      // share the other.
      spinDir: Math.sign(p.x * p.z) || 1,
    }));
    this._assignPodMeshes();
    // v1.5.0 §6 secondary systems: the island's lights get per-carrier
    // materials (the template shares DM.windowGlow/DM.redNav/DM.greenNav
    // across all carriers — killing one ship's lights must not kill
    // every ship's). A dead bridge sets their emissiveIntensity to 0.
    this.group.traverse(o => {
      if (o.isMesh && (o.name === 'islandBridgeWindows' || o.name === 'islandNavPort' || o.name === 'islandNavStbd')) {
        o.material = o.material.clone();
        this._islandLights.push(o);
      }
    });
    // v1.2.0: per-instance refs to the procedural rotor assemblies
    // (template clones share geometry/materials, but each carrier
    // spins its own rotor groups).
    this.group.traverse(o => {
      if (o.name.startsWith('rotorSpin_')) {
        const i = +o.name.split('_')[1];
        if (this.pods[i]) this.pods[i].rotorSpin = o;
      } else if (o.name.startsWith('rotorBlur_')) {
        const i = +o.name.split('_')[1];
        if (this.pods[i]) this.pods[i].blur = o;
        // Blur opacity is per-carrier (spool state differs), so each
        // carrier gets its own blur material, not the shared template one.
        o.material = o.material.clone();
      } else if (o.name === 'islandRadar') {
        this.radar = o;
      }
    });
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
      // v1.4.0: the pod's mesh set is the STL fan itself (rotorSpin_*,
      // so a destroyed pod hides its fan), the duct cap disc and the
      // blur-disc group (rotorAsm_*, added below). The old model's
      // rotor_disc_/rotor_hub_/duct_ring_/podSponson_ meshes are gone.
      if (o.isMesh && (o.name.startsWith('rotorSpin_') || o.name.startsWith('podDuctCap_'))) {
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
      if (best !== null) this.pods[best].meshes.push(pm.o);
    }
    // v1.4.0: the blur-disc group (rotorAsm_*) belongs to its pod, so
    // a destroyed pod hides its blur disc with its fan and duct cap.
    this.group.traverse(o => {
      if (o.name.startsWith('rotorAsm_')) {
        const i = +o.name.split('_')[1];
        if (this.pods[i]) this.pods[i].meshes.push(o);
      }
    });
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
  // v1.4.0: the deck is SLOPED (DECK_PROFILE) — every point on it is
  // at deckLocalYAt(lz), not at one flat height. deckTopY() is the
  // reference height at mid-deck (lz 0), used for approach altitudes.
  deckTopY() { return this.y + deckLocalYAt(0); }
  deckPoint(lx, lz) {
    return this.group.localToWorld(new THREE.Vector3(lx, deckLocalYAt(lz), lz));
  }
  localFromWorld(x, z) {
    const v = this.group.worldToLocal(new THREE.Vector3(x, this.y, z));
    return { lx: v.x, lz: v.z };
  }
  deckContains(lx, lz) { return Math.abs(lx) <= deckHalfWidthAt(lz) && Math.abs(lz) <= this.deckHalfZ; }
  deckHeightAt(x, z) {
    if (!this.alive) return -Infinity;
    const l = this.localFromWorld(x, z);
    return this.deckContains(l.lx, l.lz) ? this.y + deckLocalYAt(l.lz) : -Infinity;
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
  // v1.3.0 blastImpulse (Hurricane v10.1, metric): an inverse-square
  // physical blast. A detonation shoves the hull away from the blast,
  // heels it away, and kicks the yaw if the blast is off-centre. Nearby
  // ships feel it too, falling off with the square of the distance.
  // Hurricane blastRadius 40u -> 40*5.74 = 230 m; falloff P/(1+d2/100)
  // is in Hurricane units, so here fall = power/(1+d2/2500) with the
  // same shape at metre scale. Called from damage() for hard hits and
  // from detonate()/breakUp() — never for light bumps.
  // v1.4.0 mass (audit F8): ONE impulse per detonation event — the old
  // code stacked three applications (damage + detonate + breakUp) into
  // a 20.8 m/s instant shove on a neighbour 100 m away (2.5 GN·s, 46 s
  // of full flank thrust in one frame). Callers pass one event key per
  // kill; only the largest application of that key lands, the rest is
  // the delta.
  // v1.6.0 mass discipline (27 Nov): the F8 coefficients were still
  // ~2000x too violent for a 120,000,000 kg ship — a 30-damage bomb
  // heeled her 5.7 deg and shoved her ~1 m/s, a 70-damage hit 2.2 m/s.
  // A real 500 kg bomb at ~300 m/s carries J ~= 1.5e5 N*s, so
  // dv = J/m ~= 0.001 m/s, and the roll impulse (J x ~30 m lever
  // against I_roll ~= 7e10 kg*m^2) is ~0.004 deg — the ship should
  // barely move. The retune below is ~100x the physical value, not
  // exact physics: a readable shudder (heel <= 0.46 deg, shove
  // <= 0.1 m/s, yaw <= 0.06 deg total) with the flash/fireball/smoke
  // carrying the hit feedback at range. Coefficient 0.06 -> 0.002 and
  // total dv capped at 0.1 m/s per event; heel 0.1 -> 0.008 rad,
  // clamped to +-0.015 rad total so repeated hits cannot stack it
  // into a big roll; yaw 0.05 -> 0.002 rad/s, clamped to +-0.0015.
  blastImpulse(bx, bz, power, key) {
    if (this.state !== 'alive') return;
    const dx = this.x - bx, dz = this.z - bz;
    const d2 = dx * dx + dz * dz, d = Math.sqrt(d2) || 1;
    if (d > 230) return;
    let fall = power / (1 + d2 / 2500);
    if (key) {
      this._blastByKey = this._blastByKey || {};
      const prev = this._blastByKey[key] || 0;
      if (fall <= prev) return; // already applied a larger one for this event
      this._blastByKey[key] = fall;
      fall = fall - prev; // apply only the delta
      this._blastVByKey = this._blastVByKey || {};
      const applied = this._blastVByKey[key] || 0;
      const addV = fall * 0.002;
      if (applied + addV > 0.1) fall = Math.max(0, (0.1 - applied) / 0.002);
      this._blastVByKey[key] = Math.min(0.1, applied + fall * 0.002);
    }
    const nx = dx / d, nz = dz / d;
    this.blastVx += nx * fall * 0.002;
    this.blastVz += nz * fall * 0.002;
    const lat = dx * Math.cos(this.heading) + dz * Math.sin(this.heading);
    this.heelKick -= Math.sign(lat || 1) * 0.008 * Math.min(1, fall / 6);
    this.heelKick = Math.max(-0.015, Math.min(0.015, this.heelKick));
    this.blastYaw += (Math.random() - 0.5) * 0.002 * Math.min(1, fall / 6);
    this.blastYaw = Math.max(-0.0015, Math.min(0.0015, this.blastYaw));
  }
  zoneAt(lx, lz, fromAbove) {
    const along = -lz / (CARRIER_LEN / 2); // +1 = bow, -1 = stern
    if (along > 0.5) return 'magazine';
    if (along < -0.55) return 'engines';
    if (lx >= 9 && lx <= 32 && lz >= 47 && lz <= 98) return 'bridge'; // v1.4.0: STL island footprint (starboard)
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
  // v1.5.0 §6: the list grows in STEPS tied to damage events, not by
  // smooth easing — pod lost +3° (0.052 rad), magazine/engines
  // destroyed (flooding) +5° (0.087), deck destroyed (hatch fails) +8°
  // (0.14), each toward the side that took the damage. Capped at 0.35
  // rad (~20°) so the stepped list never swamps the breakup list.
  _addListStep(rad, event, sideSign) {
    const s = sideSign >= 0 ? 1 : -1;
    this._damageList = Math.max(-0.35, Math.min(0.35, this._damageList + s * rad));
    this._listSteps.push({ t: null, event, deg: +(s * rad * 180 / Math.PI).toFixed(1), totalDeg: +(this._damageList * 180 / Math.PI).toFixed(1) });
    if (this._listSteps.length > 12) this._listSteps.shift();
  }
  _killIslandLights() {
    for (const m of this._islandLights) {
      if (m.material && m.material.emissiveIntensity !== undefined) m.material.emissiveIntensity = 0;
    }
  }
  damage(amount, lx, lz, fromAbove, ctx, opts) {
    if (this.state !== 'alive') return;
    const zoneKey = this.zoneAt(lx, lz, fromAbove);
    // v1.2.0: remember the killing-blow context — where she was hit,
    // how hard, and her speed/altitude/attitude at the time — so the
    // breakup that follows varies with the damage, not a fixed script.
    this.lastHit = {
      zone: zoneKey, amount, lx, lz,
      speed: this.forwardSpeed, alt: this.y,
      pitch: this.pitch, roll: this.roll, heading: this.heading,
      lift: this.lift,
    };
    const wp = this.deckPoint(Math.max(-this.deckHalfX, Math.min(this.deckHalfX, lx)), Math.max(-this.deckHalfZ, Math.min(this.deckHalfZ, lz)));
    const szF = CARRIER_LEN / 42;
    const magHit = zoneKey === 'magazine';
    // Collision grind ticks pass { quiet: true } — zone damage only, no
    // hit flash per tick (the collision code sparks instead).
    // { noIgnite: true } keeps light collision bumps from starting fires.
    // v1.3.0 (H): a scorch decal is applied on EVERY hit, quiet or not —
    // Hurricane calls addScorch in both damage paths. Only the flash/FX
    // is skipped for quiet ticks.
    this.scorches.push(ctx.vfx.addScorch(this.group, lx, deckLocalYAt(lz) + 1, lz, 14));
    if (this.scorches.length > 20) { const s = this.scorches.shift(); this.group.remove(s); }
    if (!opts || !opts.quiet) {
      ctx.vfx.hitFX(wp.x, wp.y + 4, wp.z, amount, szF, magHit);
    }
    // v1.3.0 (H): hard hits physically shove this carrier and her
    // neighbours (inverse-square blast impulse). v1.4.0 F8: one event
    // key per hit, shared with detonate()/breakUp() below so a kill
    // that detonates applies a single impulse, not three stacked ones.
    if (amount >= 15 && ctx.carriers) {
      const bkey = `hit:${this.id}:${++this._hitSeq}`;
      this._lastBlastKey = bkey;
      for (const c of ctx.carriers) c.blastImpulse(wp.x, wp.z, amount * 0.6, bkey);
    }
    let detonate = false;
    if (zoneKey.startsWith('pod:')) {
      const pod = this.pods[+zoneKey.split(':')[1]];
      pod.hp -= amount;
      // v1.4.1 film beat: a hit makes the engine wobble (Winter
      // Soldier/ILM — "carrier engines wobbling upon being hit").
      // The wobble is visual only; lift/damage are unchanged.
      pod.wobble = Math.min(1, (pod.wobble || 0) + amount / 30);
      if (pod.hp <= 0 && pod.alive) {
        this._killPodVisual(pod); // v1.6.0 D3: scorched husk, not a vanish
        ctx.vfx.burst(wp.x, wp.y, wp.z, 40, [1, 0.6, 0.2], 10, 6);
        this.ignite('pod:' + this.pods.indexOf(pod), lx, lz, amount / 20, ctx);
        // v1.5.0 §6: losing a pod steps the list +3° toward the dead side.
        this._addListStep(0.052, 'pod lost', pod.local.x);
        ctx.msg(`${this.name}: lift pod destroyed — lift ${(this.lift * 100) | 0}%`);
      }
    } else {
      const z = this.zones[zoneKey];
      const before = z.hp;
      z.hp = Math.max(0, z.hp - amount);
      if (amount >= 8 && !(opts && opts.noIgnite)) this.ignite(zoneKey, lx, lz, amount / 20, ctx);
      if (zoneKey === 'magazine' && amount >= 15 && (z.hp <= 0 || this.hpFrac <= 0.5)) detonate = true;
      if (zoneKey === 'reactor') {
        if (z.hp <= 0) detonate = true;
        else if (z.hp < 45 && Math.random() < 0.2) detonate = true; // damaged reactor: explosion risk
      }
      if (zoneKey === 'bridge' && z.hp <= 0) { ctx.msg(`${this.name}: bridge destroyed — steering degraded`); this._killIslandLights(); }
      if (zoneKey === 'deck' && z.hp <= 0) { ctx.msg(`${this.name}: flight deck wrecked — cannot launch`); this._addListStep(0.14, 'hatch fails', lx); }
      if (zoneKey === 'engines' && z.hp <= 0) { ctx.msg(`${this.name}: engines destroyed — speed lost`); this._addListStep(0.087, 'engines flood', lx); }
      if (zoneKey === 'magazine' && z.hp <= 0) this._addListStep(0.087, 'magazine floods', lx);
      if (before > 0 && z.hp <= 0) ctx.vfx.burst(wp.x, wp.y, wp.z, 30, [1, 0.5, 0.1], 8, 5);
    }
    if (detonate) { this.detonate(ctx, zoneKey); return; }
    // Structural failure: total zone HP exhausted, or all pods dead.
    if (this.lift <= 0 || this.hpFrac <= 0.12) {
      this.startFall(ctx, this.lift <= 0 ? 'all lift pods lost' : 'structural failure');
    }
  }
  ignite(zoneKey, lx, lz, severity = 1, ctx) {
    if (this.fires.some(f => f.zone === zoneKey)) return;
    if (this.fires.length >= 6) return; // one fire per zone, max 6 concurrent
    // v1.2.0: fire severity rides along for the visuals (flame/smoke
    // size by zone and hit strength). The HP drain stays exactly as
    // before — intensity still starts at 0.5 and grows at the same rate.
    // v1.5.0 §6/D12: a fire TRAVELS — the front advances along the
    // deck at 5-10 m/s from the hit point (direction seeded), leaving
    // scorched deck behind it and throwing new flame points ahead of
    // it as it reaches fuel. The HP drain stays exactly as before;
    // only the visual front moves (frontLz/frontLx); the zone logic
    // still reads the origin lx/lz.
    this.fires.push({ zone: zoneKey, lx, lz, intensity: 0.5, t: 0, sev: Math.max(0.5, Math.min(2, severity)), cookT: 2 + Math.random() * 2,
      frontLx: lx, frontLz: lz, frontDir: Math.random() < 0.5 ? 1 : -1, frontSpeed: 5 + Math.random() * 5, scorchAcc: 0 });
    // v1.3.1: a new fire flares up visibly at the hit point.
    if (ctx && ctx.vfx) {
      const wp = this.deckPoint(lx, lz);
      ctx.vfx.burst(wp.x, wp.y + 3, wp.z, 12, [1, 0.6, 0.2], 7, 4);
      ctx.vfx.spawnSprite(wp.x, wp.y + 4, wp.z, 0.35, 10, 10, 3, 0xff8c2e, 0.85);
    }
  }
  detonate(ctx, zoneKey) {
    // v1.4.0: a carrier already coming apart cannot detonate again —
    // breakUp() below is a no-op in that case, but the FX/msg would
    // otherwise fire twice for one kill.
    // v1.5.0: a capsizing carrier cannot detonate either — her death is
    // the flooding roll, and a mid-capsize breakup would break the D8 path.
    if (this.breakState !== 'none' || this.state === 'gone' || this.state === 'rested' || this.state === 'capsizing') return;
    // v1.2.0: explosions scale with what blew up — a reactor breach is
    // bigger and more violent than a magazine hit, which is bigger than
    // a deck hit. (Damage amounts and detonation gates are unchanged.)
    // v1.3.1: also scaled by the killing blow's severity. (v1.6.2: the
    // debris smoke ring is gone — six black sprites thrown outward
    // from the blast read as a ring of black orbs. The fireball,
    // flash and particle bursts below are the explosion now.)
    const scale = zoneKey === 'reactor' ? 1.35 : zoneKey === 'magazine' ? 1.2 : 1;
    const sev = Math.max(0.6, Math.min(2, (this.lastHit ? this.lastHit.amount : 30) / 40));
    ctx.vfx.magazineSecondary(this.x, this.y, this.z, CARRIER_LEN / 42 * scale * (0.8 + 0.2 * sev));
    ctx.vfx.burst(this.x, this.y, this.z, Math.round(40 * scale), [0.9, 0.9, 0.9], 12, 8);
    if (ctx.audio) ctx.audio.boom(true);
    if (ctx.noteDetonation) ctx.noteDetonation(this.x, this.y, this.z, 'detonation');
    // v1.4.0 F8: the same event key as the damage() blast above, so
    // the detonation does not stack a second impulse on top of it.
    if (ctx.carriers) {
      const bkey = this._lastBlastKey || `det:${this.id}:${++this._brkSeq}`;
      for (const c of ctx.carriers) if (c !== this) c.blastImpulse(this.x, this.z, 60 * scale, bkey);
    }
    ctx.msg(`${this.name}: ${zoneKey === 'reactor' ? 'REACTOR' : 'MAGAZINE'} DETONATION`);
    this.breakUp(ctx, 'detonation', { zone: zoneKey });
  }
  startFall(ctx, reason, opts = {}) {
    if (this.state !== 'alive') return;
    this.state = 'falling';
    this.fallT = 0;
    // v1.4.2: keep the vertical speed she had — cutting lift does not
    // zero velocity (a ship climbing at +3 m/s keeps rising briefly,
    // then falls; a ship already sinking keeps her sink rate).
    this.liftThrustNow = 0;
    // v1.4.1: a zero-throttle fall is recoverable — the pods are alive
    // and the player can spool them back up (falling branch); a
    // damage/structural fall is not (lift is gone or the ship is torn).
    // _fallSpool is the spooled lift thrust (fraction of weight).
    this._fallZeroThrottle = !!opts.recoverable;
    this._fallSpool = 0;
    // Solidity (v1.4.0): a falling carrier is NOT frozen in place any
    // more — she keeps the horizontal velocity she had when lift failed
    // (forward speed at the kill), decaying slowly, so a falling hull
    // is a moving obstacle and can meet another carrier mid-fall
    // instead of only ever colliding as a stationary object. The old
    // frozen fall is gone; water-impact position follows the drift.
    this.fallVx = this.vx || 0;
    this.fallVz = this.vz || 0;
    this.fallStartAlt = this.y; this.lastImpact = null;
    // v1.5.0: do NOT clear lastBreakup here — the D9 crippled core
    // calls startFall after its breakup, and wiping the record lost
    // the whole breakup (mode, cuts, releases, coreSeg) the moment
    // the remainder started falling. lastImpact resets for the new
    // fall; the breakup record is history and stays.
    const deadX = this.pods.filter(p => !p.alive).reduce((a, p) => a + p.local.x, 0);
    // v1.4.0 mass (audit §1): falling-hull attitude rates are capped —
    // roll ≤0.05, pitch ≤0.03, yaw ≤0.02 rad/s — and decay τ≈10 s in
    // freefall (no torque in freefall). A 120,000 t hull does not
    // cartwheel on the way down.
    // v1.4.1: the rates draw from the carrier's per-round seed and
    // scale with the damage asymmetry, so no two falls tumble alike.
    // v1.4.1 film beat (Winter Soldier/ILM — "they drop nose down"):
    // the fall pitches toward the damaged end — a bow hit drops the
    // bow, a stern hit drops the stern — on top of a small random
    // component. Still capped at the mass-limited ±0.03 rad/s.
    const frng = this._brkRng;
    const lh = this.lastHit;
    const noseBias = lh ? -0.02 * Math.max(-1, Math.min(1, -lh.lz / 100)) : 0; // bow hit (lz<0) -> nose-down
    this.fallRollRate = Math.max(-0.05, Math.min(0.05, (deadX >= 0 ? 1 : -1) * (0.03 + 0.02 * (1 - this.lift)) + (frng() - 0.5) * 0.02));
    this.fallPitchRate = Math.max(-0.03, Math.min(0.03, noseBias + (frng() - 0.5) * 0.02));
    this.fallYawRate = Math.max(-0.02, Math.min(0.02, (frng() - 0.5) * 0.03));
    // v1.4.1: a zero-throttle fall has no damage asymmetry driving it —
    // no dead pods, no blast — so the damage-derived tumble rates are
    // scaled down to a gentle drift; the ship falls flat, as a healthy
    // ship cut of all lift should. Damage falls keep the full rates.
    if (this._fallZeroThrottle) { this.fallRollRate *= 0.25; this.fallPitchRate *= 0.25; this.fallYawRate *= 0.25; }
    ctx.msg(`${this.name} is FALLING — ${reason}`);
    if (this.wing) this.wing.handleCarrierFalling(ctx);
  }

  // v1.6.2: the water-impact ladder, extracted verbatim from the
  // falling branch so a gravity descent in the ALIVE branch
  // (throttle below hover — the ship falls to the sea instead
  // of stopping at the 150 m floor) takes the same impact
  // decision: level + slow + healthy stays intact and sinks;
  // hard or nose-first shatters. Called when y reaches the sea;
  // no-op above it. The formulas, thresholds and outcomes are
  // unchanged.
  _waterImpact(ctx) {
    const seaH = ctx.sea.waveHeight(this.x, this.z, ctx.time);
    if (this.breakState === 'none' && this.y <= seaH + 2) {
      // v1.3.1 water-impact evaluation: the breakup decision is made
      // HERE, not only at the kill — a carrier can fall whole and
      // then fragment (or not) on how she hits the water. Level +
      // slower stays largely intact and sinks; hard or nose-first
      // shatters into many pieces, which inherit the impact
      // velocity and attitude.
      const impactSpeed = Math.abs(this.vy);
      const rollW = Math.atan2(Math.sin(this.roll), Math.cos(this.roll));
      // frag: impact speed relative to a 65 m/s reference, attitude
      // (nose-down and rolled entries hit far harder than level ones),
      // and remaining structural health. Level + slower + healthy
      // stays intact; hard or nose-first shatters.
      const attF = 1 + 2 * Math.abs(this.pitch) + 1.2 * Math.abs(rollW);
      // v1.4.1: the impact also follows the ship's state on arrival —
      // a burning ship is structurally weaker (fires), and residual
      // lift thrust cushions the blow (lift). Both are neutral for a
      // cold zero-throttle fall (no fires, no thrust) and bite only
      // when the condition is present: 4 fires raise frag ~48%, full
      // thrust cuts it 35%.
      const liftThrustAtImpact = Math.min(this.throttle * PHYSICS.T_LIFT_MAX_RATIO, this.lift * PHYSICS.T_LIFT_MAX_RATIO);
      const fireF = 1 + 0.12 * Math.min(4, this.fires.length);
      const liftF = 1 - 0.35 * Math.min(1, liftThrustAtImpact);
      const frag = (impactSpeed / 65) * attF * (1.3 - 0.6 * this.hpFrac) * fireF * liftF;
      const outcome = frag < 1.0 ? 'intact' : frag < 1.8 ? 'partial' : 'shatter';
      // v1.5.0 D10 slamming shatter: entry angle decides the damage.
      // Nose-down (|pitch| > 0.25): bow-flare slamming — the bow
      // crumples and the slam load runs aft as a whipping wave.
      // Flat: whole-bottom slam — largest total force, strongest
      // whipping, most likely midship fracture. On her side
      // (|roll| > 0.2): the side shell takes the slam, the deck edge
      // digs in and the ship trips and rolls. Slam pressure peaks
      // ~625 kPa bow-flare; whipping adds 30-40% bending moment.
      const slamBranch = Math.abs(rollW) > 0.2 ? 'side' : Math.abs(this.pitch) > 0.25 ? 'nose-down' : 'flat';
      this.lastImpact = { speed: +impactSpeed.toFixed(1), pitch: +this.pitch.toFixed(2), roll: +rollW.toFixed(2), hpFrac: +this.hpFrac.toFixed(2), fires: this.fires.length, liftThrust: +liftThrustAtImpact.toFixed(2), fireF: +fireF.toFixed(2), liftF: +liftF.toFixed(2), frag: +frag.toFixed(2), outcome, slamBranch };
      ctx.vfx.splash(this.x, seaH, this.z, impactSpeed);
      // White slam ring racing outward + spray sheet up the hull side.
      ctx.vfx.slamSheet(this.x, seaH, this.z, this.heading, CARRIER_LEN, slamBranch === 'side' ? Math.sign(rollW) : 0);
      ctx.msg(`${this.name} hit the sea at ${impactSpeed.toFixed(0)} m/s — ${outcome === 'intact' ? 'staying intact' : outcome === 'partial' ? 'breaking apart' : 'shattering'} (${slamBranch} entry)`);
      if (outcome !== 'intact') {
        const fwd = { x: Math.sin(this.heading), z: -Math.cos(this.heading) };
        const ivx = fwd.x * (this.forwardSpeed || 0) * 0.3, ivz = fwd.z * (this.forwardSpeed || 0) * 0.3;
        if (outcome === 'shatter') {
          if (slamBranch === 'nose-down') this.breakUp(ctx, 'water impact', { energy: 2.2 + frag * 0.5, impactVx: ivx, impactVz: ivz, cuts: 2, bowCrumple: true });
          else if (slamBranch === 'flat') this.breakUp(ctx, 'water impact', { energy: 2.2 + frag * 0.5, impactVx: ivx, impactVz: ivz, cuts: 3, midshipCut: true });
          else this.breakUp(ctx, 'water impact', { energy: 2.2 + frag * 0.5, impactVx: ivx, impactVz: ivz, mode: 'diagonal' });
        }
        else this.breakUp(ctx, 'water impact', { cuts: 1, energy: 1.4, impactVx: ivx, impactVz: ivz });
        return;
      }
      this.state = 'sinking';
      this.sinkT = 0;
      // v1.4.1: an intact sink takes 24–38 s (seeded per kill),
      // not a fixed 30 s — no two sinkings run the same clock.
      this._sinkDur = 24 + this._brkRng() * 14;
      this.impactY = seaH;
      // v1.4.0 mass (audit F10): the final list comes from the
      // damage state (impact roll + damage list), not a constant.
      this.sinkRollTarget = Math.max(-0.6, Math.min(0.6, this.roll + this.list));
      this._sinkPrevY = this.y;
      if (this.wing) this.wing.handleCarrierSinking(ctx);
    }
  }

  // Split into a VARIABLE number of tumbling pieces (Hurricane splitShip
  // clipping-plane trick, generalised). The breakup is driven by the
  // killing blow — no fixed piece count, no single canned split:
  //   v1.3.2: each piece is a genuine section — the cut planes live in
  //   the piece's local space and are re-aimed every frame, and each
  //   interior cut face gets a solid section cap. The v1.3.0 port baked
  //   world-space planes once, so tumbling clones showed each other's
  //   decks/islands/pods (the "duplicates" glitch).
  //   energy  = severity x speed x altitude x attitude (x1.3 detonation)
  //   cuts    = 1 + one per energy band (2..6 pieces)
  //   cut positions: first through the hit, the rest spread around it
  //     with jitter, min 40 m apart — so piece sizes vary too
  //   tumble: faster near the blast, wilder at speed/altitude
  //   separation: pieces fly away from the hit along the hull
  // (Damage amounts/gates are unchanged.)
  // v1.4.0 progressive breakup (research §3): breakUp() is split into
  // beginBreakup() (phases 1–3 on the intact group) and separatePiece()
  // (phase 4, one segment at a time, staggered). The ship is NOT pieces
  // during phases 1–3 — it is one group, deforming; pieces are born only
  // at phase 4. Timelines (game seconds from the kill):
  //   detonation ≈1.4 s: crack 0.15–0.75 s, hinge 0.5–1.1 s (6–8°),
  //     releases from 0.9 s, 0.15 s apart.
  //   structural ≈2.6 s: crack 0–1.2 s, hinge 0.8–2.0 s (3–5°),
  //     releases from 1.6 s, 0.35 s apart.
  //   water shatter ≈1.0 s: crack 0.3–0.5 s, releases from 0.6 s,
  //     0.1 s apart.
  // Crack propagation is a deliberate ~5–10× time compression of real
  // ductile tearing (20–40 m/s — a 333 m hull would take ~11 s; the
  // game shows ~0.7 s so the propagation is visible, not instantaneous).
  // Phase 2 bends by gap + attitude, not true mesh deformation: the
  // crack ribbon visibly opens and the whole group hinges a few degrees
  // (breakHinge, added to roll in update()) until separation — true
  // geometric bending waits for phase 4. The old single-frame breakUp
  // (all pieces in one frame) is gone.
  breakUp(ctx, reason, opts = {}) {
    if (this.state === 'gone' || this.state === 'rested' || this.breakState !== 'none' || this.state === 'capsizing') return;
    const fallVy = this.state === 'falling' ? this.vy : -5; // capture before state flips
    const hit = this.lastHit || {
      zone: 'reactor', amount: 30, lx: 0, lz: 0,
      speed: this.forwardSpeed, alt: this.y, pitch: this.pitch, roll: this.roll,
      heading: this.heading, lift: this.lift,
    };
    const severity = Math.max(0.6, Math.min(2, hit.amount / 40));
    const speedF = 1 + Math.min(1.5, Math.abs(hit.speed) / 16); // faster ship = wilder tumble
    const altF = 1 + Math.min(0.5, hit.alt / 800);
    const attF = 1 + Math.min(0.5, (Math.abs(hit.pitch) + Math.abs(hit.roll)) / 0.4);
    let energy = severity * speedF * altF * attF;
    if (reason === 'detonation') energy *= 1.3;
    if (opts.energy) energy = opts.energy;
    // v1.4.1 breakup variety: the kill kind picks a profile — a
    // reactor detonation tears fast and cooks off repeatedly, a
    // magazine detonation is nearly as violent, a structural fall
    // comes apart slowly and unevenly, a fire kill smoulders and
    // peels late, a water shatter is sudden. Every number in the
    // profile is drawn from this carrier's per-round seed, so the
    // same kill on the same carrier in another round plays
    // differently. (Damage amounts/gates are unchanged — only the
    // destruction sequence varies.)
    const rng = this._brkRng;
    const killKind = reason === 'detonation' ? (opts.zone === 'reactor' ? 'reactor' : 'magazine')
      : reason === 'water impact' ? 'water'
      : reason === 'fire' ? 'fire' : 'structural';
    const PROFILE = {
      // stagger [s], crack [s], hinge [deg], releaseStart [s], cookoffs [n], energyMul, release order
      reactor: { stagger: [0.10, 0.20], crack: [0.4, 0.7], hinge: [6, 10], releaseStart: [0.8, 1.1], cookoffs: [2, 4], energyMul: 1.15, order: 'nearest' },
      magazine: { stagger: [0.10, 0.20], crack: [0.4, 0.7], hinge: [6, 9], releaseStart: [0.8, 1.1], cookoffs: [2, 3], energyMul: 1.1, order: 'nearest' },
      structural: { stagger: [0.25, 0.55], crack: [0.9, 1.5], hinge: [2, 5], releaseStart: [1.4, 2.0], cookoffs: [0, 1], energyMul: 1.0, order: 'random' },
      fire: { stagger: [0.4, 0.8], crack: [1.2, 2.0], hinge: [2, 4], releaseStart: [1.8, 2.6], cookoffs: [1, 3], energyMul: 0.8, order: 'random' },
      water: { stagger: [0.08, 0.18], crack: [0.3, 0.5], hinge: [3, 6], releaseStart: [0.5, 0.8], cookoffs: [0, 1], energyMul: 1.0, order: 'nearest' },
    }[killKind];
    const lerp = (a, b) => a + rng() * (b - a);
    energy *= PROFILE.energyMul;
    // v1.5.0 destruction modes (research §8/§9, Tier 1 -> Tier 2): the
    // kill kind + seeded RNG pick ONE mode per kill; opts.mode forces
    // one (probes). Damage amounts/gates do not move — only the
    // destruction sequence varies.
    //   transverse   — v1.4.1 slices (default)
    //   diagonal     — D1: one rotated cut, wedge pieces sliding past
    //   asymmetric   — D6: clean end + shredded end (allocation change)
    //   longitudinal — D2: deck unzips, side-by-side half hulls
    //   crippled     — D9: keeps flying, sheds pieces in order, core falls
    //   pulverised   — D7: centre segment bursts into a debris cloud
    //   capsize      — D8: no breakup; progressive flooding roll
    let mode = opts.mode || null;
    if (!mode) {
      const r = rng();
      if (killKind === 'reactor' || killKind === 'magazine') {
        mode = r < 0.25 ? 'diagonal' : r < 0.55 ? 'asymmetric' : 'transverse';
      } else if (killKind === 'water') {
        mode = r < 0.4 ? 'diagonal' : 'transverse';
      } else { // structural / fire
        if (r < 0.15 && this.hpFrac <= 0.35) mode = 'capsize';
        else if (r < 0.32) mode = 'crippled';
        else if (r < 0.47) mode = 'longitudinal';
        else if (r < 0.62) mode = 'diagonal';
        else if (r < 0.80) mode = 'asymmetric';
        else mode = 'transverse';
      }
    }
    // v1.5.0 D8 capsize diversion: a structural/fire kill on a badly
    // flooded hull (hpFrac <= 0.35) may die WITHOUT breaking up — she
    // lists in steps, rolls to 90° and sinks intact (Concordia/Estonia).
    // Forced mode bypasses the hpFrac gate (probes); an ineligible
    // forced capsize falls through to a transverse breakup instead.
    if (mode === 'capsize') {
      if (this.state === 'alive' && (opts.mode === 'capsize' || this.hpFrac <= 0.35)) {
        this.startCapsize(ctx);
        return;
      }
      mode = 'transverse';
    }
    // v1.5.0 D1: the diagonal cut angle, 20-40° off transverse, either
    // way. One angle for the whole breakup, so the wedges match.
    const diagAngle = mode === 'diagonal' ? (0.35 + rng() * 0.35) * (rng() < 0.5 ? 1 : -1) : 0;
    const asymmetric = mode === 'asymmetric';
    // Cut count from energy: 2 pieces for a light kill, up to 6 for a
    // violent one. A forced count (water impact) overrides.
    let nCuts = 1;
    if (energy > 1.2) nCuts = 2;
    if (energy > 2.0) nCuts = 3;
    if (energy > 3.0) nCuts = 4;
    if (energy > 4.5) nCuts = 5;
    if (opts.cuts) nCuts = opts.cuts;
    nCuts = Math.max(1, Math.min(5, nCuts));
    const hitAlong = Math.max(-1, Math.min(1, -hit.lz / (CARRIER_LEN / 2))); // +1 = bow
    // First cut: through the hit for a detonation; for a slow kill
    // (structural/fire) half the time the tear starts at the WEAKEST
    // zone instead — the hull fails where it is already broken, not
    // where the last hit landed. (d units: -z * 0.33.)
    let cutOff = hitAlong * 55; // first cut through the hit
    if (killKind === 'structural' || killKind === 'fire') {
      if (rng() < 0.5) {
        const zoneLz = { magazine: 100, engines: -110, reactor: 0, bridge: 72, deck: -20 };
        let weak = 'deck', weakFrac = 2;
        for (const k of Object.keys(this.zones)) {
          const f = this.zones[k].hp / this.zones[k].max;
          if (f < weakFrac) { weakFrac = f; weak = k; }
        }
        cutOff = Math.max(-150, Math.min(150, -zoneLz[weak] * 0.33));
      }
    }
    const cuts = [cutOff];
    // Extra cuts: the spread pattern itself varies per kill —
    // clustered near the hit, spread along the hull, or one near each
    // end — alternating sides, jittered, so every cut lands ≥35 m
    // from the others and the piece sizes genuinely vary.
    const spreadPick = rng();
    const spread = spreadPick < 0.4 ? 'cluster' : spreadPick < 0.75 ? 'spread' : 'ends';
    const radii = spread === 'cluster' ? [35, 70, 110] : spread === 'ends' ? [120, 145] : [58, 104, 145];
    let sideSign = rng() < 0.5 ? 1 : -1;
    for (let i = 1; i < nCuts; i++) {
      const radius = radii[Math.floor((i - 1) / 2)] || 145;
      const cand = cutOff + sideSign * (radius + (rng() - 0.5) * (8 + rng() * 8));
      sideSign = -sideSign;
      if (cand < -150 || cand > 150) continue;
      if (cuts.some(c => Math.abs(c - cand) < 35)) continue;
      cuts.push(cand);
    }
    cuts.sort((a, b) => a - b);
    // v1.5.0 D6 asymmetric breakup (Fitzgerald/Titanic): one end stays
    // nearly intact, the other shreds, the middle disintegrates. This
    // is an ALLOCATION change, not a mechanism change: cuts cluster on
    // the hit side, leaving the far end as one long clean piece. If the
    // generic spread left too few cuts on the hit side, add clustered
    // cuts 35/70 m toward the hit end.
    if (asymmetric) {
      const hitSide = cutOff >= 0 ? 1 : -1;
      let kept = cuts.filter(c => c === cutOff || (c - cutOff) * hitSide > 0);
      if (kept.length < 3) {
        for (const rOff of [35, 70, 105]) {
          const cand = cutOff + hitSide * rOff + (rng() - 0.5) * 8;
          if (cand >= -150 && cand <= 150 && !kept.some(c => Math.abs(c - cand) < 30)) kept.push(cand);
          if (kept.length >= 3) break;
        }
      }
      cuts.length = 0;
      cuts.push(...kept.sort((a, b) => a - b));
    }
    // v1.5.0 D10: bow crumple (nose-down entry) puts an extra cut at
    // the bow; a flat entry puts a midship secondary fracture (the
    // whipping wave completing a crack the fall started).
    if (opts.bowCrumple && !cuts.some(c => Math.abs(c - 130) < 30)) cuts.push(130);
    if (opts.midshipCut && !cuts.some(c => Math.abs(c) < 30)) cuts.push(0);
    cuts.sort((a, b) => a - b);
    // v1.6.0 duplicates fix (C): a breakUp after a D9 crippled core
    // (breakState reset, carrier falling) must only re-segment the
    // SURVIVING core — re-cutting the full hull would respawn pieces
    // for regions already released as pieces in the first breakup.
    // Every cut is clamped inside the core (35 m margins, so no sliver
    // segment results) and re-spaced; a cut on the core boundary is a
    // cut through the core's end, not outside it. A core narrower than
    // 70 m cannot split and stays one piece — safe, nothing is
    // re-segmented. With no prior D9 the range is the full hull.
    let rLo = -CARRIER_LEN / 2, rHi = CARRIER_LEN / 2;
    if (this._coreRange) {
      [rLo, rHi] = this._coreRange;
      cutOff = Math.max(rLo + 5, Math.min(rHi - 5, cutOff));
      if (rHi - rLo < 70) cuts.length = 0;
      else {
        for (let i = 0; i < cuts.length; i++) cuts[i] = Math.max(rLo + 35, Math.min(rHi - 35, cuts[i]));
        cuts.sort((a, b) => a - b);
        for (let i = cuts.length - 1; i > 0; i--) if (cuts[i] - cuts[i - 1] < 35) cuts.splice(i, 1);
      }
    }
    const bounds = [rLo, ...cuts, rHi];
    const segments = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      segments.push({ lo: bounds[i], hi: bounds[i + 1], centre: (bounds[i] + bounds[i + 1]) / 2 });
    }
    // v1.5.0 D7 pulverisation rule (DECIDED — predictable from the
    // kill, never random): a segment pulverises iff the kill is a
    // detonation, the segment CONTAINS the detonation point, and
    // energy >= 3.0 — OR energy >= 4.5 and it is the centre segment
    // (a detonation inside the segment). Forced 'pulverised' mode
    // pulverises the centre segment (probes). A pulverised segment is
    // not a piece at all: it becomes a debris burst + a few large
    // remnants at its release time (see _separatePiece).
    for (const seg of segments) {
      const containsHit = seg.lo <= cutOff && seg.hi >= cutOff;
      const isCentre = Math.abs(seg.centre) < 60;
      if (mode === 'pulverised') seg.pulverised = isCentre || containsHit;
      else if (reason === 'detonation') seg.pulverised = (containsHit && energy >= 3.0) || (isCentre && energy >= 4.5);
      else seg.pulverised = false;
    }
    // v1.5.0 D2 longitudinal deck split: the deck unzips along the
    // centreline trench; the hull parts into side-by-side halves —
    // port full-length, starboard split transversely at the hit so a
    // transverse tear finishes the job at one end of the split.
    let longCutD = null;
    if (mode === 'longitudinal') {
      longCutD = Math.max(rLo + 5, Math.min(rHi - 5, Math.max(-120, Math.min(120, cutOff))));
      segments.length = 0;
      segments.push({ lo: rLo, hi: rHi, centre: (rLo + rHi) / 2, kind: 'longPort', half: 'port' });
      segments.push({ lo: longCutD, hi: rHi, centre: (longCutD + rHi) / 2, kind: 'longStbd', half: 'stbd' });
      segments.push({ lo: rLo, hi: longCutD, centre: (rLo + longCutD) / 2, kind: 'longStbd', half: 'stbd' });
      cuts.length = 0; cuts.push(longCutD);
    }
    // Island footprint in the carrier's local space, for section caps.
    this.group.updateMatrixWorld(true);
    const invM = new THREE.Matrix4().copy(this.group.matrixWorld).invert();
    let islBox = null;
    this.group.traverse(o => {
      if (o.isMesh && o.name.startsWith('island_')) {
        const b = new THREE.Box3().setFromObject(o).applyMatrix4(invM);
        islBox = islBox ? islBox.union(b) : b;
      }
    });
    this.lastBreakup = { reason, kind: killKind, mode, diagAngleDeg: +(diagAngle * 180 / Math.PI).toFixed(1), pulverised: segments.filter(s => s.pulverised).length, pieces: segments.length, energy: +energy.toFixed(2), cuts: cuts.map(c => +c.toFixed(0)), hitZone: hit.zone, hitAmount: hit.amount, alt: +hit.alt.toFixed(0), speed: +hit.speed.toFixed(1), spread, order: PROFILE.order, stagger: 0, cookoffsPlanned: 0, cookoffsFired: 0, tearoffs: 0, tearoffsFired: 0 };
    // Object3D.clone() JSON-deep-clones userData; group.userData.carrier
    // points back at this Helicarrier (which owns the group) — a cycle
    // that throws "Converting circular structure to JSON" and kills the
    // breakup mid-way (carrier vanishes, zero pieces). Strip it first;
    // the original is dead and no longer needs click-pick identity.
    // (This must happen in beginBreakup, not in _separatePiece — the
    // clone is what throws.)
    this.group.userData.carrier = undefined;
    // Phase 0 — flash & shock (unchanged): magazineSecondary + burst +
    // boom light + shake, at t=0.
    ctx.vfx.magazineSecondary(this.x, this.y, this.z, CARRIER_LEN / 42 * Math.max(0.9, Math.min(1.6, 0.8 + severity * 0.3)));
    ctx.vfx.burst(this.x, this.y, this.z, Math.round(30 * severity), [0.25, 0.25, 0.25], 11, 7);
    if (ctx.audio) ctx.audio.boom(true);
    // v1.4.0 F8: the neighbour blast uses the same event key as the
    // damage()/detonate() blast, so a detonation applies ONE impulse.
    if (ctx.carriers) {
      const bkey = this._lastBlastKey || `brk:${this.id}:${++this._brkSeq}`;
      this._lastBlastKey = null;
      for (const c of ctx.carriers) if (c !== this) c.blastImpulse(this.x, this.z, 60 * severity, bkey);
    }
    // Schedule: release order varies by profile — nearest the blast
    // first for a detonation/water shatter (tension side leaves
    // first), shuffled for a slow structural/fire peel so the
    // separation order itself is never the same twice. Timings are
    // drawn from the profile, not fixed per reason.
    // v1.5.0 D9 crippled-flight shedding: the stagger stretches to
    // 1.0-2.2 s between releases and the ship keeps flying while she
    // sheds — the LARGEST segment is the core and never releases (it
    // falls afterwards, clipped to its own range). Release order is by
    // content: pod segments first, then the island, then hull — each
    // loss shifts the CG and drives the next failure (TWA 800).
    let stagger = lerp(PROFILE.stagger[0], PROFILE.stagger[1]);
    const crackDur = lerp(PROFILE.crack[0], PROFILE.crack[1]);
    const releaseStart = lerp(PROFILE.releaseStart[0], PROFILE.releaseStart[1]);
    const hingeStart = Math.max(0.1, releaseStart - 0.4);
    const hingeEnd = releaseStart + 0.2;
    const hingeDeg = lerp(PROFILE.hinge[0], PROFILE.hinge[1]);
    let order = segments.map((s, i) => i);
    if (PROFILE.order === 'nearest') order.sort((a, b) => Math.abs(segments[a].centre - cutOff) - Math.abs(segments[b].centre - cutOff));
    else { // random: shuffle (Fisher-Yates on the seeded RNG)
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1));[order[i], order[j]] = [order[j], order[i]]; }
    }
    let coreIdx = -1;
    if (mode === 'crippled') {
      stagger = 1.0 + rng() * 1.2;
      coreIdx = segments.reduce((bi, s, i) => (s.hi - s.lo) > (segments[bi].hi - segments[bi].lo) ? i : bi, 0);
      const podD = this.template.podLocals.map(p => -p.z);
      const contentRank = (s) => {
        if (podD.some(d => d >= s.lo && d <= s.hi)) return 0; // pod first
        if (s.lo <= -47 && s.hi >= -98) return 1; // island second
        return 2; // hull last
      };
      order.sort((a, b) => (contentRank(segments[a]) - contentRank(segments[b])) || (Math.abs(segments[a].centre - cutOff) - Math.abs(segments[b].centre - cutOff)));
      this._crippled = true;
      this._crippledLift = 0.85; // still producing most of her lift — she flies on, sinking slowly
    }
    if (mode === 'longitudinal') order = [1, 2, 0]; // starboard halves part first, port half last
    order.forEach((segIdx, k) => { segments[segIdx].releaseAt = releaseStart + k * stagger; });
    if (coreIdx >= 0) segments[coreIdx].releaseAt = Infinity; // the core never releases — it falls
    // v1.5.0 D11 cook-off chain with REAL clocks, compressed for
    // playability (Forrestal: first 1,000-lb bomb cooked off 94 s
    // after the fire started; thick-cased Mk 83 endures 8-10 min in a
    // fuel fire; sympathetic detonation by shock is milliseconds).
    // A round's destruction runs seconds, not minutes, so the clock is
    // compressed to 0.5-30 s and SAY SO (README + this comment): the
    // chain is one blast at a time along the magazine, each with its
    // own fireball and hole, and a burning wreck keeps popping AFTER
    // it hits the water — cook-offs past the breakup transfer onto
    // the pieces (see _separatePiece) and fire there, including
    // post-splashdown. Visual/audio only, as always.
    const nCook = Math.round(lerp(PROFILE.cookoffs[0], PROFILE.cookoffs[1])) + (killKind === 'reactor' || killKind === 'magazine' ? 2 : 0);
    const cookoffs = [];
    let cookT = 0.5 + rng() * 1.5;
    for (let i = 0; i < nCook; i++) {
      const segIdx = order[Math.floor(rng() * order.length)];
      cookoffs.push({ at: cookT, segIdx, size: 0.7 + rng() * 0.9, fired: false });
      cookT += 2 + rng() * 6;
      if (cookT > 30) break;
    }
    cookoffs.sort((a, b) => a.at - b.at);
    // v1.5.0 D4/D5 detachable assemblies: the island shears off at its
    // base and a damaged pod tears off its mount, each as its own
    // tumbling rigid body (see _spawnAssemblyPiece). Island: when the
    // hit is near the island (lz 47..98) or the bridge is dead. Pod:
    // the most-damaged dead pod on the hit side, if any.
    const tearoffs = [];
    const islHit = hit.lz >= 40 && hit.lz <= 105;
    if (islHit || this.zones.bridge.hp <= 0) {
      if (killKind === 'reactor' || killKind === 'magazine' || rng() < 0.5) {
        tearoffs.push({ at: releaseStart + 0.3 + rng() * 0.5, kind: 'island', fired: false });
      }
    }
    const deadPods = this.pods.map((p, i) => ({ p, i })).filter(o => !o.p.alive);
    if (deadPods.length && rng() < 0.6) {
      const dp = deadPods[Math.floor(rng() * deadPods.length)];
      tearoffs.push({ at: releaseStart + 0.1 + rng() * 0.4, kind: 'pod', podIdx: dp.i, fired: false });
    }
    tearoffs.sort((a, b) => a.at - b.at);
    // v1.5.0 fix: a tear-off scheduled past the last release never
    // fired — the plan is torn down at the final release, so the
    // loop in updateBreakup never reached its time (measured: 1
    // planned, 0 fired). Clamp into the breakup window so every
    // scheduled tear-off happens while the hull is still there.
    const lastRel = Math.max(...segments.filter(s => s.releaseAt !== Infinity).map(s => s.releaseAt));
    for (const tf of tearoffs) tf.at = Math.min(tf.at, lastRel);
    // v1.4.1 pre-breakup list: the hull heels toward her dead side as
    // the cracks run, before anything separates — eased in during
    // updateBreakup and folded into the group rotation.
    const deadX = this.pods.filter(p => !p.alive).reduce((a, p) => a + p.local.x, 0);
    this._breakListTarget = (0.03 + rng() * 0.12) * (deadX >= 0 ? 1 : -1);
    this._breakList = 0;
    this._breakPlan = {
      reason, kind: killKind, mode, diagAngle, coreIdx, longCutD, energy, severity, speedF, cuts, cutOff, hit, islBox,
      segments, fallVy, fwd: { x: Math.sin(this.heading), z: -Math.cos(this.heading) },
      impactVx: opts.impactVx || 0, impactVz: opts.impactVz || 0,
      stagger, crackDur, hingeStart, hingeEnd, cookoffs, tearoffs,
      // v1.5.0 D13 true hull flex — prototype on ONE kill path, the
      // structural kill: the hull mesh is split into 2 rigid segments
      // joined at the hinge BEFORE separation (segments rotate relative
      // to each other — the segmented-mesh option, chosen over a
      // vertex-shader bend, which fights the clip-plane system).
      flexProto: killKind === 'structural',
      hingeTarget: hingeDeg * Math.PI / 180 * (hit.lx >= 0 ? 1 : -1),
      hingeMax: 0, ventT: 0,
    };
    if (this.lastBreakup) { this.lastBreakup.stagger = +stagger.toFixed(2); this.lastBreakup.cookoffsPlanned = cookoffs.length; this.lastBreakup.tearoffs = tearoffs.length; }
    this._breakCtx = ctx;
    this.breakState = 'cracking';
    this.breakT = 0; this.breakHinge = 0; this.breakFlex = 0; this._breakReleased = 0;
    this._flexShown = false; this._flexStaging = null; // v1.6.0 perf: flex halves rebuild per breakup
    this._breakFirstReleased = false;
    // Crack ribbons (§2.4): one jagged dark ribbon per cut, growing
    // around the hull cross-section from the hit — the same seeded path
    // the cap will show. Removed when the last piece releases.
    // v1.5.0: diagonal cuts get ribbons that follow the diagonal
    // (z = zc + x*tanθ); a longitudinal split gets a centreline deck
    // ribbon (the unzip, running the trench) plus the transverse
    // finish cut.
    const mkRibbon = (pts3, ci) => {
      pts3.push(pts3[0].clone());
      const geo = new THREE.BufferGeometry().setFromPoints(pts3);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x0a0a0a }));
      line.geometry.setDrawRange(0, 0);
      line.name = 'crackRibbon';
      line.frustumCulled = false;
      this.group.add(line);
      return { line, nPts: pts3.length, startAt: ci * stagger, dur: crackDur, tipT: 0 };
    };
    if (mode === 'longitudinal') {
      const deckPts = [];
      for (let z = -160; z <= 160; z += 10) deckPts.push(new THREE.Vector3(0, deckLocalYAt(z) + 0.6, z));
      const cutPts = jaggedFracturePath(fracSeed(this._brkSeed, 1, hit.lz), -longCutD, hit.lx)
        .map(p => new THREE.Vector3(p.x, p.y, -longCutD));
      this._crackRibbons = [mkRibbon(deckPts, 0), mkRibbon(cutPts, 1)];
    } else {
      this._crackRibbons = cuts.map((cut, ci) => {
        const zc = -cut; // d -> local z
        const path = jaggedFracturePath(fracSeed(this._brkSeed, ci, hit.lz), zc, hit.lx);
        const tanA = diagAngle ? Math.tan(diagAngle) : 0;
        const pts3 = path.map(p => new THREE.Vector3(p.x, p.y, zc + p.x * tanA));
        return mkRibbon(pts3, ci);
      });
    }
    // v1.5.0 D3 deck buckling + peel strips: before any piece
    // separates, the flight deck develops visible transverse
    // ripples/creases over a 30-60 m length near the hit, then long
    // strips peel back and curl, exposing the burning structure below.
    // Ripples are thin dark crease boxes riding the deck (the GLB deck
    // cannot be re-meshed in place); strips are hinged flap meshes
    // that curl up during the hinge phase and become light debris
    // pieces at the first release. Both are removed from piece clones
    // (see _separatePiece).
    if (killKind === 'structural' || killKind === 'fire' || mode === 'crippled' || mode === 'longitudinal') {
      this._buildBuckleMeshes(ctx, hit, mode);
    }
    ctx.msg(`${this.name} is breaking apart (${reason}) — ${segments.length} pieces`);
  }
  // v1.5.0 D3: build the deck-buckling overlays on the intact group —
  // transverse crease ribbons across the deck near the hit, and 1-2
  // peel strips hinged along one long edge. Driven (curl) in
  // updateBreakup; strips become light debris pieces at first release.
  _buildBuckleMeshes(ctx, hit, mode) {
    this._buckleMeshes = [];
    const rng = this._brkRng;
    const zc = Math.max(-140, Math.min(140, hit.lz));
    for (const off of [-24, -8, 8, 24]) {
      const z = zc + off;
      if (Math.abs(z) > 155) continue;
      const w = deckHalfWidthAt(z) * 2;
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.4, 2.2), DM.capSteel);
      m.position.set(0, deckLocalYAt(z) + 0.4 + (off % 16 === 0 ? 1.0 : -0.8), z);
      m.rotation.z = (rng() - 0.5) * 0.04;
      m.name = 'deckRipple';
      this.group.add(m);
      this._buckleMeshes.push({ mesh: m, kind: 'ripple' });
    }
    const nStrips = mode === 'longitudinal' ? 2 : 1;
    for (let i = 0; i < nStrips; i++) {
      const g = new THREE.Group();
      const stripZ = zc + (i === 0 ? -10 : 30);
      const geo = new THREE.BoxGeometry(12, 0.5, 50);
      geo.translate(6, 0, 0); // hinge edge at the group origin
      const mesh = new THREE.Mesh(geo, DM.capSteel);
      mesh.name = 'peelStrip';
      g.add(mesh);
      g.position.set(-12, deckLocalYAt(stripZ) + 0.3, stripZ);
      g.name = 'peelStripGroup';
      this.group.add(g);
      this._buckleMeshes.push({ group: g, kind: 'strip', maxCurl: 0.7 + rng() * 0.4, stripZ });
    }
  }
  // Island footprint in the carrier's local space (as in breakUp).
  _islandBoxLocal() {
    this.group.updateMatrixWorld(true);
    const invM = new THREE.Matrix4().copy(this.group.matrixWorld).invert();
    let islBox = null;
    this.group.traverse(o => {
      if (o.isMesh && o.name.startsWith('island_')) {
        const b = new THREE.Box3().setFromObject(o).applyMatrix4(invM);
        islBox = islBox ? islBox.union(b) : b;
      }
    });
    return islBox;
  }
  // v1.6.0 D3: a pod destroyed by damage/fire leaves a scorched husk —
  // the fan and duct stay visible, darkened, rotor winding down —
  // instead of vanishing outright. (A tear-off still hides the parent
  // pod meshes: the pod physically leaves as its own piece.)
  _killPodVisual(pod) {
    if (!pod || !pod.alive) return;
    pod.alive = false;
    const husk = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.95, metalness: 0.2 });
    for (const m of pod.meshes) {
      m.traverse(o => { if (o.isMesh) { o.material = husk; o.visible = true; } });
    }
    // The rotor stays visible and winds down on its own (pod.alive =
    // false drives the spin target to 0) — the wind-down is the tell
    // that the pod died instead of leaving.
    if (pod.rotorSpin) pod.rotorSpin.visible = true;
  }
  // v1.6.0 duplicates fix (B): hide an assembly's meshes inside every
  // piece — held or already released — whose segment contains it (d
  // units, x for the longitudinal side). A tear-off hides the originals
  // on the intact group; without this, a piece that already carries the
  // island/pod (the whole group is cloned at separation) would show it
  // a second time alongside the tear-off piece. The D4 case: a segment
  // that released before the tear-off fired (tear-offs run at
  // releaseStart+0.1..0.8, segments release in a staggered order).
  // Assembly pieces themselves are skipped (their segLo/segHi are
  // local, not d-units, and they ARE the assembly).
  _hideAssemblyInPieces(d, x, pred) {
    for (const p of this.pieces) {
      if (p.assembly) continue;
      if (p.segLo === undefined || d < p.segLo || d > p.segHi) continue;
      if (p.segKind === 'longPort' && x >= 0) continue;
      if (p.segKind === 'longStbd' && x < 0) continue;
      p.group.traverse(o => { if (pred(o)) o.visible = false; });
    }
  }
  // v1.5.0 D4/D5/D3/D7: spawn a detached assembly as its own tumbling
  // rigid body with a small collision proxy (see collisions.js
  // pieceBody — assembly pieces carry halfBeamOverride/halfHOverride
  // and massFrac/areaFrac/dragK, so the always-solid rule and the
  // re-derived fall model both cover them). The proxy is a simple
  // mesh, not a full-ship clone — an island/pod/strip is a small
  // fraction of 120,000 t, so it tumbles faster and decelerates
  // faster in air than a hull section.
  _spawnAssemblyPiece(ctx, kind, podIdx, worldPos, worldRot, salt) {
    const plan = this._breakPlan;
    // v1.6.0 V7: per-kind seed salt — the old fixed seed made every
    // pulverised remnant (and every peel strip) spawn as an identical
    // coincident cluster. `salt` is the remnant/strip index; the kind
    // base keeps island/pod/strip/remnant streams apart even when the
    // pod index coincides (an island and pod 0 used to share a seed).
    const kindSalt = kind === 'island' ? 900 : kind === 'strip' ? 600 : kind === 'remnant' ? 700 : 500;
    const rng = mulberry32(fracSeed(this._brkSeed, kindSalt + (podIdx || 0) + (salt || 0) * 37, this.lastHit ? this.lastHit.lz : 0));
    const g = new THREE.Group();
    let segLen = 30, massFrac = 0.01, areaFrac = 0.4, dragK = 1;
    let halfBeam = 12, halfH = 12, spinMesh = null, spinRate = 0;
    // v1.6.0 V11/D4: clone a mesh into the piece group from its
    // carrier-local transform (robust to nesting — the mesh's matrix
    // relative to the carrier group, decomposed). Materials are cloned
    // with clipping planes nulled, so a parent's breakup clip never
    // slices the detached piece.
    const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
    const cloneIntoPiece = (src, centre) => {
      const clone = src.clone();
      clone.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); o.material.clippingPlanes = null; } });
      this.group.updateMatrixWorld(true);
      const invM = new THREE.Matrix4().copy(this.group.matrixWorld).invert();
      _m4.copy(src.matrixWorld).premultiply(invM).decompose(_p, _q, _s);
      clone.position.set(_p.x - centre.x, _p.y - centre.y, _p.z - centre.z);
      clone.quaternion.copy(_q);
      clone.scale.copy(_s);
      clone.visible = true;
      g.add(clone);
      return clone;
    };
    if (kind === 'island') {
      // Clone the ACTUAL island meshes (island_*, mast, radar, bridge
      // windows, nav, antenna, panel line), offset so the island
      // centre sits at the piece origin — the old 23×22×51 box + mast
      // + radar read as a crate, not the ship's island.
      const ib = plan && plan.islBox ? plan.islBox : this._islandBoxLocal();
      const ic = ib ? new THREE.Vector3((ib.min.x + ib.max.x) / 2, (ib.min.y + ib.max.y) / 2, (ib.min.z + ib.max.z) / 2) : new THREE.Vector3(20, 15, -72);
      const isIslandMesh = (o) => o.isMesh && (o.name.startsWith('island_') || o.name === 'islandCoaming' || o.name === 'islandBridgeWindows' ||
        o.name === 'islandMast' || o.name === 'islandRadar' || o.name === 'islandNavPort' || o.name === 'islandNavStbd' ||
        o.name === 'islandAntenna' || o.name === 'islandPanelLine');
      this.group.traverse(o => {
        if (isIslandMesh(o)) {
          cloneIntoPiece(o, ic);
          o.visible = false;
        }
      });
      // v1.6.0 duplicates fix (B): the island also lives in any piece
      // whose segment contains it — hide it there too.
      this._hideAssemblyInPieces(-ic.z, ic.x, isIslandMesh);
      segLen = 51; massFrac = 0.008; areaFrac = 0.34; dragK = 1; halfBeam = 12; halfH = 18;
    } else if (kind === 'pod') {
      const pod = this.pods[podIdx];
      // Shallow dark duct cylinder for body (the flat disc alone is
      // invisible edge-on), plus the real fan / duct-cap / blur meshes.
      const duct = new THREE.Mesh(new THREE.CylinderGeometry(19, 19, 8, 20), DM.ductDark);
      duct.name = 'asmPodDuct';
      g.add(duct);
      if (pod) {
        const pc = new THREE.Vector3(pod.local.x, pod.local.y, pod.local.z);
        for (const m of pod.meshes) {
          const clone = cloneIntoPiece(m, pc);
          if (m.name.startsWith('rotorSpin_')) { spinMesh = clone; spinRate = 8; }
        }
        pod.alive = false; pod.meshes.forEach(m => { m.visible = false; }); if (pod.rotorSpin) pod.rotorSpin.visible = false;
        // v1.6.0 duplicates fix (B): the pod also lives in any piece
        // whose segment contains it — hide it there too.
        const podNames = new Set(pod.meshes.map(m => m.name).filter(n => n));
        if (pod.rotorSpin && pod.rotorSpin.name) podNames.add(pod.rotorSpin.name);
        this._hideAssemblyInPieces(-pod.local.z, pod.local.x, (o) => o.isMesh && o.name && podNames.has(o.name));
      }
      segLen = 38; massFrac = 0.012; areaFrac = 0.44; dragK = 1.5; halfBeam = 19; halfH = 8;
    } else if (kind === 'strip') {
      // v1.6.2: 2 m thick, so the visual matches the physics proxy
      // (halfH was already 2 — the old 0.5 m plate read as a black
      // card edge-on). A peeled deck section is still a plate, but a slab.
      const plate = new THREE.Mesh(new THREE.BoxGeometry(12, 2, 50), DM.capSteel);
      plate.name = 'asmStrip';
      g.add(plate);
      segLen = 50; massFrac = 0.002; areaFrac = 0.18; dragK = 3; halfBeam = 6; halfH = 2;
    } else { // 'remnant' — D7 pulverised-segment large remnant
      // v1.6.2: a REAL chunk, not a flat plate. The old Tetrahedron(9)
      // scaled (1.4, 0.25, 1.8) was a 25×4.5×32 m card in near-black
      // capSteel — in the frames it read as a floating black quad, and
      // six of them were all a 186 m hull section left behind, which is
      // what "parts of the ship just disappear" looked like. Now a
      // ~45×26×48 m solid tetrahedron in mid-grey flat-shaded steel,
      // with physics to match (segLen 44, massFrac 0.04 — a solid
      // chunk, vt ≈ 110 m/s like the island/pod chunks, not the old
      // flat-plate 59). 2–3 of these per pulverised segment.
      const frag = new THREE.Mesh(new THREE.TetrahedronGeometry(15), DM.remnantSteel);
      frag.scale.set(1.5, 0.85, 1.6); frag.name = 'asmRemnant';
      g.add(frag);
      segLen = 44; massFrac = 0.04; areaFrac = 0.7; dragK = 3; halfBeam = 22; halfH = 12;
    }
    g.position.copy(worldPos);
    if (worldRot) {
      g.rotation.copy(worldRot);
      // v1.6.0 V8: a world quaternion decomposed to XYZ can land on
      // the gimbal-flipped branch (pitch ≈ ±π — a curled peel strip
      // measured 2.82 rad). The initial matrix is identical, but the
      // piece then tumbles about the wrong body axes. The identity
      // (x,y,z) -> (x+π, π−y, z+π) is the same rotation with
      // |pitch| ≤ π/2 (verified numerically against the vendored
      // three.js over carrier pitch/heading/roll × curl).
      if (Math.abs(g.rotation.x) > Math.PI / 2) {
        const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
        g.rotation.set(wrap(g.rotation.x + Math.PI), wrap(Math.PI - g.rotation.y), wrap(g.rotation.z + Math.PI));
      }
    } else g.rotation.set(this.pitch, -this.heading, this.roll);
    const fwd = plan ? plan.fwd : { x: Math.sin(this.heading), z: -Math.cos(this.heading) };
    const rx = -fwd.z, rz = fwd.x;
    let vx = this.vx || 0, vz = this.vz || 0;
    if (kind === 'pod' && podIdx !== undefined && this.pods[podIdx]) {
      const s = Math.sign(this.pods[podIdx].local.x) || 1;
      vx += rx * s * (6 + rng() * 4); vz += rz * s * (6 + rng() * 4);
    } else if (kind === 'island') {
      vx += rx * (4 + rng() * 4); vz += rz * (4 + rng() * 4);
    } else if (kind === 'strip') {
      vx += rx * (rng() - 0.5) * 4; vz += rz * (rng() - 0.5) * 4;
    } else {
      vx += (rng() - 0.5) * 10; vz += (rng() - 0.5) * 10;
    }
    const piece = new BreakupPiece(ctx.scene, g, (plan ? plan.fallVy : -5) + 2 + rng() * 3,
      (rng() - 0.5) * (kind === 'island' || kind === 'pod' ? 0.8 : 0.4),
      (rng() - 0.5) * 0.5, (rng() - 0.5) * 0.5, vx, vz);
    piece.segLen = segLen; piece.massFrac = massFrac; piece.areaFrac = areaFrac; piece.dragK = dragK;
    piece.assembly = kind; piece.parentCarrier = this; piece.carrierName = this.name;
    piece.reason = plan ? plan.reason : 'structural';
    piece.halfBeamOverride = halfBeam; piece.halfHOverride = halfH;
    piece.centreLocal = { x: 0, y: 0, z: 0 }; piece.segCentre = 0;
    piece.segLo = -segLen / 2; piece.segHi = segLen / 2;
    piece.burning = piece.reason === 'fire' || piece.reason === 'detonation';
    piece.spinMesh = spinMesh; piece.spinRate = spinRate;
    piece.bornT = ctx.time || 0;
    piece.refreshClipPlanes();
    this.pieces.push(piece);
    return piece;
  }
  // v1.5.0 D13: build ONE hinge segment group for the flex prototype
  // (structural kill path only) — a clone of the intact group clipped
  // to one side of the first cut. Built hidden (v1.6.0 perf: one half
  // per frame, see updateBreakup); shown at hingeStart, when the
  // original group hides and the two halves rotate ±hinge/2 about the
  // roll axis so the hull visibly bends before it tears.
  _buildFlexHalf(ctx, plan, which) {
    const cut = plan.cuts[0];
    const zc = -cut;
    const locals = which === 'fore'
      ? [new THREE.Plane(new THREE.Vector3(0, 0, -1), zc)]
      : [new THREE.Plane(new THREE.Vector3(0, 0, 1), -zc)];
    const clone = this.group.clone(true);
    const ribbons = [];
    clone.traverse(o => { if (o.name === 'crackRibbon' || o.name === 'deckRipple' || o.name === 'peelStripGroup') ribbons.push(o); });
    for (const r of ribbons) r.parent.remove(r);
    clone.visible = false; // hidden until hingeStart (see updateBreakup)
    const mats = [];
    clone.traverse(o => {
      if (o.isMesh) {
        o.material = o.material.clone();
        o.material.clippingPlanes = locals.map(() => new THREE.Plane());
        o.material.userData.clipLocals = locals;
        mats.push(o.material);
      }
    });
    (this.group.parent || ctx.scene).add(clone);
    return { group: clone, mats, locals };
  }
  _aimFlexMats(fg) {
    fg.group.updateMatrix();
    fg.group.matrixWorld.copy(fg.group.matrix);
    for (const m of fg.mats) {
      const locals = m.userData.clipLocals;
      if (!locals) continue;
      for (let i = 0; i < locals.length; i++) m.clippingPlanes[i].copy(locals[i]).applyMatrix4(fg.group.matrixWorld);
    }
  }
  _teardownFlexGroups() {
    // v1.6.0 perf: also drop a half-built staged pair (first release
    // before both halves were built) so no hidden clone leaks.
    if (this._flexStaging) {
      for (const fg of [this._flexStaging.fore, this._flexStaging.aft]) {
        if (fg && fg.group.parent) fg.group.parent.remove(fg.group);
      }
      this._flexStaging = null;
    }
    if (!this._flexGroups) return;
    for (const fg of [this._flexGroups.fore, this._flexGroups.aft]) {
      if (fg.group.parent) fg.group.parent.remove(fg.group);
    }
    this._flexGroups = null;
    this._flexShown = false;
    this.group.visible = true;
  }
  // v1.5.0 D8 progressive flooding capsize (Concordia/Estonia): the
  // ship dies WITHOUT breaking up. Flooding spreads compartment to
  // compartment, free surface destroys stability, and the list grows
  // in steps (10° -> 20° -> 30°+) tied to events, then she rolls to
  // 90° and sinks on her side, intact. Driven by the existing zone
  // HP / flooding state — no new damage number.
  startCapsize(ctx) {
    if (this.state !== 'alive') return;
    this.state = 'capsizing';
    this._crippled = false;
    const deadX = this.pods.filter(p => !p.alive).reduce((a, p) => a + p.local.x, 0);
    const side = deadX !== 0 ? Math.sign(deadX) : (this.lastHit ? Math.sign(this.lastHit.lx || 1) : 1);
    this._capsize = {
      t: 0, stage: 0, stageT: 0, side,
      stages: [
        { listDeg: 10, dur: 5, event: 'compartment floods' },
        { listDeg: 20, dur: 4, event: 'flooding spreads — hatch fails' },
        { listDeg: 32, dur: 3.5, event: 'free surface — stability gone' },
        { listDeg: 90, dur: 6, event: 'rolls onto her side' },
      ],
      listTarget: 10 * Math.PI / 180 * side, sinkT: 0, sinkDur: 30, trimTarget: -0.05,
      impactY: ctx.sea ? ctx.sea.waveHeight(this.x, this.z, ctx.time) : 0,
    };
    this.lastCapsize = { side, stages: [{ t: 0, listDeg: 10, event: 'compartment floods' }], rollDeg: 0, durationS: 0 };
    if (this.wing) this.wing.handleCarrierFalling(ctx);
    if (ctx.onCarrierLost) ctx.onCarrierLost(this);
    ctx.msg(`${this.name} is capsizing — flooding, listing, rolling over`);
  }
  // Drive phases 1–3 on the intact group; called from update() while
  // breakState !== 'none'. Returns true once the breakup is complete
  // (state now 'gone').
  updateBreakup(dt, ctx) {
    const plan = this._breakPlan;
    if (!plan) { this.breakState = 'none'; return false; }
    this.breakT += dt;
    const t = this.breakT;
    // v1.6.0 perf: spread held-piece construction across the cracking
    // / hinging frames instead of building every remaining piece in
    // the first-release frame (that was 3-5 full group clones, 15-45 ms
    // each, in one frame — the breakup hitch). One piece per call,
    // built hidden (see _separatePiece held) so the intact group still
    // shows the whole ship exactly once; the pieces flip visible at
    // the first release, when the group hides. If a release arrives
    // before all pieces are pre-built (fast timescale, sea release),
    // the first-release block builds the rest, exactly as before.
    if (!this._breakFirstReleased) {
      const next = plan.segments.find(s => !s.released && !s._heldPiece);
      if (next) next._heldPiece = this._separatePiece(ctx, next, true);
    }
    // Phase 1 — crack propagation: each ribbon grows from the hit
    // around the cross-section. (v1.6.2: the smoke wisp that rode the
    // moving tip is gone — it dotted the tear with black orbs.)
    for (const r of this._crackRibbons) {
      const prog = Math.max(0, Math.min(1, (t - r.startAt) / r.dur));
      r.line.geometry.setDrawRange(0, Math.max(0, Math.floor(prog * r.nPts)));
    }
    // Phase 2 — hinge: 0 -> target over [hingeStart, hingeEnd].
    if (t >= plan.hingeStart) {
      const hp = Math.max(0, Math.min(1, (t - plan.hingeStart) / (plan.hingeEnd - plan.hingeStart)));
      this.breakHinge = plan.hingeTarget * hp * hp * (3 - 2 * hp);
      plan.hingeMax = Math.max(plan.hingeMax, Math.abs(this.breakHinge));
      // v1.4.1 film beat (Winter Soldier/ILM — hulls "bend and
      // wobble when being torn apart"): a small pitch-axis flex that
      // oscillates as the hinge runs, so the hull shudders along its
      // length instead of hinging on one clean axis. ±0.015 rad max.
      // v1.5.0 D10 flat-slam whipping: on a water kill the flex is
      // bigger (±0.04 rad) — the slam rings the hull girder.
      const flexAmp = plan.kind === 'water' ? 0.04 : 0.015;
      this.breakFlex = flexAmp * Math.sin(t * 3.1) * hp;
      if (this.breakState === 'cracking') this.breakState = 'hinging';
    }
    // v1.5.0 D13 flex prototype: build the hinge groups at hinge start
    // and drive them ±hinge/2 about the roll axis while the hinge runs
    // — the two segments rotate relative to each other, which is true
    // hull flex, not a gap + attitude cheat.
    // v1.6.0 duplicates fix (A): the flex groups are built ONCE, before
    // the first release. _teardownFlexGroups() at the first release used
    // to be undone on the very next frame by this unlatched rebuild, so
    // the two half-ship clones stayed visible for the whole separation
    // alongside the released pieces — every released segment drawn twice.
    // v1.6.0 perf: the two hinge clones used to be built in a single
    // frame at hingeStart. They are now built one per frame in the
    // 0.6 s before the hinge, hidden, and only shown at hingeStart —
    // the same first visible frame as before. _flexGroups is assigned
    // only once both halves exist, so readers never see a half-built
    // pair; _flexShown gates the positioning/aiming work.
    if (plan.flexProto && !this._breakFirstReleased) {
      if (!this._flexGroups && t >= plan.hingeStart - 0.6) {
        if (!this._flexStaging) this._flexStaging = {};
        if (!this._flexStaging.fore) this._flexStaging.fore = this._buildFlexHalf(ctx, plan, 'fore');
        else if (!this._flexStaging.aft) {
          this._flexStaging.aft = this._buildFlexHalf(ctx, plan, 'aft');
          this._flexGroups = { fore: this._flexStaging.fore, aft: this._flexStaging.aft };
          this._flexStaging = null;
        }
      }
      if (this._flexGroups && !this._flexShown && t >= plan.hingeStart) {
        this._flexShown = true;
        this.group.visible = false;
        this._flexGroups.fore.group.visible = true;
        this._flexGroups.aft.group.visible = true;
      }
    }
    if (this._flexGroups && this._flexShown) {
      const h = this.breakHinge;
      const fg = this._flexGroups;
      fg.fore.group.position.set(this.x, this.y, this.z);
      fg.fore.group.rotation.set(this.pitch + (this.breakFlex || 0), -this.heading, this.roll + (this._breakList || 0) + h / 2);
      fg.aft.group.position.set(this.x, this.y, this.z);
      fg.aft.group.rotation.set(this.pitch + (this.breakFlex || 0), -this.heading, this.roll + (this._breakList || 0) - h / 2);
      this._aimFlexMats(fg.fore); this._aimFlexMats(fg.aft);
    }
    // v1.5.0 D3: peel strips curl up as the hinge runs; fire shows at
    // the peel edge as the strip lifts.
    if (this._buckleMeshes.length) {
      const hp = t >= plan.hingeStart
        ? Math.max(0, Math.min(1, (t - plan.hingeStart) / Math.max(0.2, plan.hingeEnd - plan.hingeStart))) : 0;
      for (const b of this._buckleMeshes) {
        if (b.kind === 'strip') b.group.rotation.z = b.maxCurl * hp * hp * (3 - 2 * hp);
      }
      plan._stripFireT = (plan._stripFireT || 0) - dt;
      if (hp > 0.2 && plan._stripFireT <= 0) {
        plan._stripFireT = 0.3;
        for (const b of this._buckleMeshes) {
          if (b.kind !== 'strip') continue;
          const wp = b.group.localToWorld(new THREE.Vector3(6, 0, 0));
          ctx.vfx.spawnParticle(wp.x, wp.y + 1, wp.z, (Math.random() - 0.5) * 2, 2 + Math.random() * 2, (Math.random() - 0.5) * 2, 0.8, 1, 0.6, 0.2, -0.5);
        }
      }
    }
    // v1.4.1 pre-breakup list: while the hull is still one piece, she
    // heels toward her dead side — the breakup is telegraphed before
    // anything lets go. (v1.6.2: the vent smoke from the hit point is
    // gone — it rose as a column of black orbs over the deck.)
    if (this.breakState === 'cracking' || this.breakState === 'hinging') {
      this._breakList += (this._breakListTarget - this._breakList) * Math.min(1, dt * 1.2);
      plan.ventT -= dt;
      if (plan.ventT <= 0) {
        plan.ventT = 0.25;
        // v1.5.0 D2: fire vents from the trench along the whole split
        // length while the deck unzips.
        if (plan.mode === 'longitudinal') {
          const lz = -160 + Math.random() * 320;
          const wp2 = this.deckPoint(0, lz);
          ctx.vfx.spawnParticle(wp2.x, wp2.y + 2, wp2.z, (Math.random() - 0.5) * 2, 3 + Math.random() * 3, (Math.random() - 0.5) * 2, 0.9, 1, 0.6, 0.2, -0.5);
        }
      }
    }
    // v1.5.0 secondary explosions / cook-offs, on the schedule drawn
    // at breakUp time: a burst at the target segment's position as the
    // hull comes apart. Visual + audio only, no damage. Cook-offs
    // whose clock falls after the breakup transfer onto the pieces
    // instead (see _separatePiece) — the chain runs 0.5-30 s, long
    // past the last release.
    for (const ck of plan.cookoffs) {
      if (ck.fired || t < ck.at) continue;
      ck.fired = true;
      const seg = plan.segments[ck.segIdx];
      if (seg) {
        const wp = this.group.localToWorld(new THREE.Vector3(0, deckLocalYAt(-seg.centre) + 2, -seg.centre));
        ctx.vfx.cookoffBurst(wp.x, wp.y, wp.z, ck.size);
        if (ctx.audio) ctx.audio.boom(false);
        if (this.lastBreakup) this.lastBreakup.cookoffsFired = (this.lastBreakup.cookoffsFired || 0) + 1;
      }
    }
    // v1.5.0 D4/D5: detachable assemblies tear off on schedule — the
    // island shears at its base, a pod rips off its mount. The list
    // jumps toward the dead side at the tear moment.
    // v1.6.0 V11/D4: skip a tear-off whose assembly already left with
    // a released segment — the segment clone carries the island/pod
    // with it, and spawning a second one would duplicate it. A
    // longitudinal half only contains the assembly on its own side.
    // v1.6.0 duplicates fix (C): an assembly counts as already gone if
    // a released segment of THIS breakup covers it — or if NO segment
    // of this breakup covers it at all (it left in an earlier breakup:
    // a post-D9 second breakup only segments the surviving core).
    // Same any-match semantics as the old .some() (a d on a shared cut
    // or in both longitudinal halves checks every covering segment).
    const assemblyReleased = (d, x) => {
      let covered = false;
      for (const s of plan.segments) {
        if (d < s.lo || d > s.hi) continue;
        covered = true;
        if (!s.released) continue;
        if (s.kind === 'longPort') { if (x < 0) return true; continue; }
        if (s.kind === 'longStbd') { if (x >= 0) return true; continue; }
        return true;
      }
      return !covered;
    };
    for (const tf of plan.tearoffs) {
      if (tf.fired || t < tf.at) continue;
      tf.fired = true;
      this.group.updateMatrixWorld(true);
      if (tf.kind === 'island') {
        const ib = plan.islBox;
        const cx = ib ? (ib.min.x + ib.max.x) / 2 : 20;
        const cy = ib ? (ib.min.y + ib.max.y) / 2 : 15;
        const cz = ib ? (ib.min.z + ib.max.z) / 2 : 72;
        if (assemblyReleased(-cz, cx)) continue;
        const wp = this.group.localToWorld(new THREE.Vector3(cx, cy, cz));
        this._spawnAssemblyPiece(ctx, 'island', undefined, wp);
        this._breakListTarget += 0.03;
      } else {
        const pod = this.pods[tf.podIdx];
        if (pod) {
          if (assemblyReleased(-pod.local.z, pod.local.x)) continue;
          const wp = this.group.localToWorld(new THREE.Vector3(pod.local.x, pod.local.y, pod.local.z));
          this._spawnAssemblyPiece(ctx, 'pod', tf.podIdx, wp);
          this._breakListTarget += 0.05 * Math.sign(pod.local.x);
        }
      }
      if (this.lastBreakup) this.lastBreakup.tearoffsFired = (this.lastBreakup.tearoffsFired || 0) + 1;
    }
    // Phase 3 — staggered peel: release segments in schedule order.
    const firstReleaseAt = Math.min(...plan.segments.map(s => s.releaseAt));
    if (this.breakState !== 'separating' && t >= firstReleaseAt) this.breakState = 'separating';
    let released = false;
    // If a falling carrier has already reached the sea, the water does
    // the rest — release everything still attached at once.
    let seaRelease = false;
    if (this.state === 'falling') {
      const seaH = ctx.sea.waveHeight(this.x, this.z, ctx.time);
      if (this.y <= seaH + 1) seaRelease = true;
    }
    // v1.5.0 D10 fix: a water-impact breakup used to sea-release on
    // the first frame, so the hinge (and the ±0.04 rad flat-slam
    // whipping flex) never had time to show — hingeMaxDeg measured 0
    // on every impact breakup. Hold the sea release ~1 s on water
    // kills so the hull rings and flexes before it shatters.
    if (plan.kind === 'water' && t < 1.0) seaRelease = false;
    for (const seg of plan.segments) {
      if (seg.released) continue;
      if (!seaRelease && t < seg.releaseAt) continue;
      seg.released = true;
      seg.releaseBreakT = this.breakT; // exact in-game release time (probe hinge/stagger proof)
      // v1.6.0 duplicates fix (B): a segment already spawned held is
      // armed here; otherwise it is built and released at once.
      if (seg._heldPiece) this._releaseHeldPiece(ctx, seg);
      else this._separatePiece(ctx, seg);
      released = true;
    }
    if (released && !this._breakFirstReleased) {
      this._breakFirstReleased = true;
      // The ship is lost when it STARTS coming apart, not when the
      // last piece lets go.
      if (this.wing) this.wing.handleCarrierFalling(ctx);
      if (ctx.onCarrierLost) ctx.onCarrierLost(this);
      ctx.msg(`${this.name} broke up (${plan.reason}) — ${plan.segments.length} pieces falling`);
      // v1.5.0 D3: peel strips become light debris at the first tear.
      if (this._buckleMeshes.length) {
        let stripIdx = 0;
        for (const b of this._buckleMeshes) {
          if (b.kind !== 'strip') continue;
          b.group.updateWorldMatrix(true, false);
          const wp = new THREE.Vector3(); b.group.getWorldPosition(wp);
          const wq = new THREE.Quaternion(); b.group.getWorldQuaternion(wq);
          const wr = new THREE.Euler().setFromQuaternion(wq);
          this._spawnAssemblyPiece(ctx, 'strip', undefined, wp, wr, stripIdx++);
          if (b.group.parent) b.group.parent.remove(b.group);
        }
        this._buckleMeshes = this._buckleMeshes.filter(b => b.kind !== 'strip');
      }
      this._teardownFlexGroups(); // D13: pieces take over from the hinge groups
      // v1.6.0 duplicates fix (B): every still-attached segment becomes
      // a HELD piece now, so the intact group can hide at the first
      // release without any part of the ship vanishing — unreleased
      // segments ride as held pieces until their release time (see
      // _releaseHeldPiece). From this frame on, each part of the ship
      // is rendered exactly once: released pieces + held pieces, and
      // the whole-ship group is gone.
      for (const s of plan.segments) {
        if (s.released || s._heldPiece) continue;
        s._heldPiece = this._separatePiece(ctx, s, true);
      }
      // v1.6.0 perf: pre-built held pieces were hidden while the
      // intact group showed the ship; they take over now, in the same
      // frame the group hides — the ship is still rendered exactly
      // once (released pieces + held pieces).
      for (const s of plan.segments) if (s._heldPiece) s._heldPiece.group.visible = true;
      this.group.visible = false;
    }
    // v1.5.0 D9: all non-core segments are gone — clip the intact
    // group to the core range and let the remainder fall (it is still
    // one solid hull section, not a ghost of the whole ship).
    if (plan.coreIdx >= 0 && this._breakReleased >= plan.segments.length - 1 && !plan._coreClipped) {
      plan._coreClipped = true;
      const core = plan.segments[plan.coreIdx];
      // v1.6.0 duplicates fix (B/C): the core's held piece comes off —
      // the core continues as the intact group, clipped to its own
      // range (its held piece showed exactly that range, so the swap is
      // seamless). Removing a never-released held section from c.pieces
      // is not the v1.6.0 Item-2 case (a wreck leaving the array).
      if (core._heldPiece) {
        const hp = core._heldPiece;
        core._heldPiece = null;
        if (hp.group.parent) hp.group.parent.remove(hp.group);
        this.pieces = this.pieces.filter(p => p !== hp);
      }
      const locals = [];
      if (core.lo > -CARRIER_LEN / 2 + 1) locals.push(new THREE.Plane(new THREE.Vector3(0, 0, -1), -core.lo));
      if (core.hi < CARRIER_LEN / 2 - 1) locals.push(new THREE.Plane(new THREE.Vector3(0, 0, 1), core.hi));
      this._coreClipMats = [];
      this.group.traverse(o => {
        if (o.isMesh) {
          o.material = o.material.clone();
          o.material.clippingPlanes = locals.map(() => new THREE.Plane());
          o.material.userData.clipLocals = locals;
          this._coreClipMats.push(o.material);
        }
      });
      // v1.6.0 duplicates fix (B/C): the group was hidden at the first
      // release, so re-show it here — _teardownFlexGroups below only
      // re-shows it when flex groups still exist, and the latch (A)
      // means they do not. Also record the surviving range: any later
      // breakUp of this falling core re-segments ONLY this range
      // (see breakUp), never the full hull.
      this.group.visible = true;
      this._coreRange = [core.lo, core.hi];
      for (const r of this._crackRibbons) this.group.remove(r.line);
      this._crackRibbons = [];
      this.breakHinge = 0;
      this.breakState = 'none';
      const savedPlan = this._breakPlan;
      this._breakPlan = null; this._breakCtx = null;
      if (this.lastBreakup) {
        this.lastBreakup.hingeMaxDeg = +(savedPlan.hingeMax * 180 / Math.PI).toFixed(1);
        this.lastBreakup.durationS = +t.toFixed(2);
        this.lastBreakup.releases = savedPlan.segments.map(s => s.releaseAt === Infinity ? null : +(s.releaseBreakT || 0).toFixed(2));
        this.lastBreakup.coreSeg = [core.lo, core.hi];
      }
      this._teardownFlexGroups();
      // The core falls as a damaged hull; the crippled lift keeps
      // decaying in the falling branch until it reaches zero.
      this._crippled = false;
      this.startFall(ctx, 'crippled — remainder falling');
      return false;
    }
    if (this._breakReleased >= plan.segments.length) {
      for (const r of this._crackRibbons) this.group.remove(r.line);
      this._crackRibbons = [];
      this._teardownFlexGroups();
      this.breakHinge = 0;
      this.breakState = 'none';
      this._breakPlan = null; this._breakCtx = null;
      // Probe record: hinge developed before the first tear, and the
      // total breakup duration (research §7 hinge-before-tear check).
      if (this.lastBreakup) {
        this.lastBreakup.hingeMaxDeg = +(plan.hingeMax * 180 / Math.PI).toFixed(1);
        this.lastBreakup.durationS = +t.toFixed(2);
        this.lastBreakup.releases = plan.segments.map(s => +(s.releaseBreakT || 0).toFixed(2));
      }
      this.state = 'gone';
      this.group.visible = false;
      return true;
    }
    // v1.6.0 duplicates fix (B): held pieces ride with the carrier
    // until their release time — the same transform a fresh release
    // would spawn with (position + hinge/list/flex rotation) — then
    // their clip planes are re-aimed. Runs on every breakup frame; a
    // piece spawned held this same frame already has this transform,
    // so the sync is a no-op for it.
    for (const s of plan.segments) {
      const hp = s._heldPiece;
      if (!hp) continue;
      hp.group.position.set(this.x, this.y, this.z);
      hp.group.rotation.set(this.pitch + (this.breakFlex || 0), -this.heading, this.roll + this.breakHinge + (this._breakList || 0));
      // v1.6.0 perf: a pre-built held piece is hidden until the first
      // release — its clip planes are re-aimed on the flip frame by
      // this same loop, so skip the per-material re-aim while hidden.
      if (hp.group.visible) hp.refreshClipPlanes();
    }
    return false;
  }
  // v1.5.0 D7: the segment bursts into a debris cloud — a big burst
  // (budgeted first, ~100 particles + 8 sprites, pool-guarded) and
  // 2-3 large remnants as solid assembly pieces (they fall slowly and
  // drift, never like a hull section). (v1.6.2: the black smoke column
  // is gone — six big black sprites hanging over the burst read as
  // floating black orbs. The particle bursts are the cloud now.)
  _pulveriseSegment(ctx, seg) {
    const wp = this.group.localToWorld(new THREE.Vector3(0, deckLocalYAt(-seg.centre) + 2, -seg.centre));
    if (ctx.vfx.liveParticles() < 1200) {
      ctx.vfx.burst(wp.x, wp.y, wp.z, 100, [0.9, 0.9, 0.9], 12, 8);
      ctx.vfx.burst(wp.x, wp.y, wp.z, 40, [1, 0.55, 0.15], 10, 6);
    }
    if (ctx.audio) ctx.audio.boom(true);
    const rng = mulberry32(fracSeed(this._brkSeed, 700, seg.centre));
    const nRem = 2 + Math.floor(rng() * 2);
    // v1.6.2: stagger the remnants' spawn altitudes (20 m apart) —
    // siblings used to spawn at the same deck level, interpenetrated
    // by up to ~24 m, and the solidity solver had to clear the whole
    // overlap at once. A blast throws fragments apart vertically as
    // well as sideways, so staggered birth altitudes are the physical
    // reading — and the worst spawn overlap drops to the section-vs-
    // remnant case (~14 m), which the per-substep cap then clears
    // in ~0.1 s without a teleport (see PUSH_CAP_PIECE).
    for (let i = 0; i < nRem; i++) {
      const off = (rng() - 0.5) * (seg.hi - seg.lo) * 0.7;
      const yOff = (i - (nRem - 1) / 2) * 20;
      const rp = this.group.localToWorld(new THREE.Vector3((rng() - 0.5) * 30, deckLocalYAt(-seg.centre - off) + 2 + yOff, -seg.centre - off));
      this._spawnAssemblyPiece(ctx, 'remnant', undefined, rp, undefined, i);
    }
  }
  // Phase 4 — one segment becomes a free BreakupPiece (the old mkPiece
  // loop, refactored to a per-segment call). Cut planes live in the
  // piece's LOCAL space and are re-aimed every frame (v1.3.2).
  // v1.6.0 duplicates fix (B): held=true builds the piece but does not
  // release it — it rides with the carrier until _releaseHeldPiece arms
  // it at its releaseAt. Returns the built piece (undefined only for an
  // immediate pulverised release, which bursts instead of becoming one).
  _separatePiece(ctx, seg, held = false) {
    const plan = this._breakPlan;
    const { lo, hi, centre: segCentre } = seg;
    const { hit, islBox, reason } = plan;
    const segIdx = plan.segments.indexOf(seg);
    // v1.5.0 D7: a pulverised segment is not a piece at all — it
    // bursts into a debris cloud with a few large remnants, leaving
    // the bow and stern sections with a debris-filled gap between them.
    // A pulverised segment built held is NOT burst yet — it stays visible
    // as part of the ship until its release time, when _releaseHeldPiece
    // bursts it. Only an immediate (non-held) release bursts at once.
    if (seg.pulverised && !held) {
      this._pulveriseSegment(ctx, seg);
      this._breakReleased++;
      return;
    }
    const diagAngle = plan.diagAngle || 0;
    const locals = [];
    if (seg.kind === 'longPort' || seg.kind === 'longStbd') {
      // D2 longitudinal halves: a vertical longitudinal plane at x=0
      // (port keeps x<=0, starboard keeps x>=0) plus the transverse
      // bounds of the half-segment.
      if (seg.half === 'port') locals.push(new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0));
      else locals.push(new THREE.Plane(new THREE.Vector3(1, 0, 0), 0));
      if (lo > -CARRIER_LEN / 2 + 1) locals.push(new THREE.Plane(new THREE.Vector3(0, 0, -1), -lo));
      if (hi < CARRIER_LEN / 2 - 1) locals.push(new THREE.Plane(new THREE.Vector3(0, 0, 1), hi));
    } else if (diagAngle) {
      // D1 diagonal tear: rotated clip planes (see diagonalPlane).
      if (lo > -CARRIER_LEN / 2 + 1) locals.push(diagonalPlane(-lo, diagAngle, -1));
      if (hi < CARRIER_LEN / 2 - 1) locals.push(diagonalPlane(-hi, diagAngle, 1));
    } else {
      if (lo > -CARRIER_LEN / 2 + 1) locals.push(new THREE.Plane(new THREE.Vector3(0, 0, -1), -lo)); // keep z <= -lo
      if (hi < CARRIER_LEN / 2 - 1) locals.push(new THREE.Plane(new THREE.Vector3(0, 0, 1), hi));    // keep z >= -hi
    }
    const clone = this.group.clone(true);
    // Crack ribbons + buckle overlays belong to the intact group, not
    // to a piece clone.
    const ribbons = [];
    clone.traverse(o => { if (o.name === 'crackRibbon' || o.name === 'deckRipple' || o.name === 'peelStripGroup') ribbons.push(o); });
    for (const r of ribbons) r.parent.remove(r);
    clone.visible = true;
    const clipMats = [];
    clone.traverse(o => {
      if (o.isMesh) {
        o.material = o.material.clone();
        o.material.clippingPlanes = locals.map(() => new THREE.Plane());
        o.material.userData.clipLocals = locals;
        clipMats.push(o.material);
      }
    });
    // v1.4.0 fragmentation realism: jagged vertex-coloured caps (hot
    // band on fresh detonation cuts only) + torn petal flaps per cut.
    // v1.5.0: diagonal cuts get parallelogram-section caps (D1) and
    // longitudinal halves get side-profile caps (D2) — the cap must
    // match the cut it covers, never a rotated transverse cap.
    const capMeshes = [];
    const petalGroups = [];
    const cutFaces = [];
    const tensionSide = hit.pitch >= 0 ? 'top' : 'bottom';
    const hotCut = reason === 'detonation';
    if (seg.kind === 'longPort' || seg.kind === 'longStbd') {
      // D2: the side-profile cap IS the split face — the hull's side
      // profile at x=0, jagged, matching the longitudinal cut.
      // v1.6.0 V1: built only over this half's own [zLo, zHi] (local
      // z = -d, so the segment [lo, hi] spans z in [-hi, -lo]).
      // v1.6.0 V3: offset ±0.05 m toward its own side — the port and
      // starboard caps used to share the exact x=0 plane and z-fight.
      const xOff = seg.half === 'port' ? -0.05 : 0.05;
      const scap = addSideProfileCap(clone, xOff, { seed: fracSeed(this._brkSeed, segIdx * 2, hit.lz), zLo: -hi, zHi: -lo });
      if (scap) capMeshes.push(scap);
      cutFaces.push({ lx: 0, ly: 0, lz: -segCentre });
      // Transverse finish cut gets a normal cap + petals on BOTH
      // halves (v1.5.0 only capped the starboard half, leaving the
      // port half open at the cut). v1.6.0 V2: each cap/petal ring is
      // clipped to its own half's x-range. The full-length port half
      // has NO transverse cut (both ends are hull ends), so it gets
      // no cap at all — capping it would plate the stern.
      {
        const bound = seg.lo > -166 ? seg.lo : seg.hi; // the transverse cut (not the hull end)
        if (Math.abs(bound) < 166.5) {
          const zc = -bound;
          const xRange = seg.half === 'port' ? [null, 0] : [0, null];
          const cap = addSectionCap(clone, zc, islBox, { seed: fracSeed(this._brkSeed, segIdx * 2 + 1, hit.lz), hot: hotCut, hitLx: hit.lx, xRange });
          if (cap) capMeshes.push(cap);
          petalGroups.push(addTornPetals(clone, zc, seg.lo > -166 ? +1 : -1, { seed: fracSeed(this._brkSeed, segIdx * 2 + 1, hit.lz), hot: hotCut, hitLx: hit.lx, tensionSide, detonation: hotCut, xRange }));
          cutFaces.push({ lx: 0, ly: deckLocalYAt(zc), lz: zc });
        }
      }
    } else if (diagAngle) {
      const stretchX = 1 / (Math.cos(diagAngle) || 1);
      if (lo > -CARRIER_LEN / 2 + 1) {
        const cap = addDiagonalCap(clone, -lo, diagAngle, islBox, { seed: fracSeed(this._brkSeed, segIdx * 2, hit.lz), hot: hotCut, hitLx: hit.lx });
        if (cap) capMeshes.push(cap);
        const pg = addTornPetals(clone, -lo, +1, { seed: fracSeed(this._brkSeed, segIdx * 2, hit.lz), hot: hotCut, hitLx: hit.lx, tensionSide, detonation: hotCut, stretchX });
        pg.rotation.y = -diagAngle;
        petalGroups.push(pg);
        cutFaces.push({ lx: 0, ly: deckLocalYAt(-lo), lz: -lo });
      }
      if (hi < CARRIER_LEN / 2 - 1) {
        const cap = addDiagonalCap(clone, -hi, diagAngle, islBox, { seed: fracSeed(this._brkSeed, segIdx * 2 + 1, hit.lz), hot: hotCut, hitLx: hit.lx });
        if (cap) capMeshes.push(cap);
        const pg = addTornPetals(clone, -hi, -1, { seed: fracSeed(this._brkSeed, segIdx * 2 + 1, hit.lz), hot: hotCut, hitLx: hit.lx, tensionSide, detonation: hotCut, stretchX });
        pg.rotation.y = -diagAngle;
        petalGroups.push(pg);
        cutFaces.push({ lx: 0, ly: deckLocalYAt(-hi), lz: -hi });
      }
    } else {
      if (lo > -CARRIER_LEN / 2 + 1) {
        const cap = addSectionCap(clone, -lo, islBox, { seed: fracSeed(this._brkSeed, segIdx * 2, hit.lz), hot: hotCut, hitLx: hit.lx });
        if (cap) capMeshes.push(cap);
        petalGroups.push(addTornPetals(clone, -lo, +1, { seed: fracSeed(this._brkSeed, segIdx * 2, hit.lz), hot: hotCut, hitLx: hit.lx, tensionSide, detonation: hotCut }));
        cutFaces.push({ lx: 0, ly: deckLocalYAt(-lo), lz: -lo });
      }
      if (hi < CARRIER_LEN / 2 - 1) {
        const cap = addSectionCap(clone, -hi, islBox, { seed: fracSeed(this._brkSeed, segIdx * 2 + 1, hit.lz), hot: hotCut, hitLx: hit.lx });
        if (cap) capMeshes.push(cap);
        petalGroups.push(addTornPetals(clone, -hi, -1, { seed: fracSeed(this._brkSeed, segIdx * 2 + 1, hit.lz), hot: hotCut, hitLx: hit.lx, tensionSide, detonation: hotCut }));
        cutFaces.push({ lx: 0, ly: deckLocalYAt(-hi), lz: -hi });
      }
    }
    clone.position.set(this.x, this.y, this.z);
    clone.rotation.set(this.pitch + (this.breakFlex || 0), -this.heading, this.roll + this.breakHinge + (this._breakList || 0));
    // v1.4.0 mass (audit F4 + research §4.2): tumble comes from the
    // off-centre blast/hinge geometry, not coin flips — and is capped
    // by piece size: ω_roll ≤ 21/L rad/s (a 60 m piece ≤ 0.35 rad/s,
    // 20°/s; a 150 m half-ship ≤ 0.14 rad/s), pitch/yaw ≤ half that.
    // Nearest-blast pieces tumble fastest. Rates decay τ=8 s in air
    // (BreakupPiece.update); they never increase after release except
    // for the water-impact pitch kick.
    // v1.6.0 duplicates fix (B): the piece is built with NO motion here.
    // Ejection/tumble/cookoffs/bornT are armed at RELEASE time
    // (_armPiece) — for an immediate release that is this same call; for
    // a held piece it is the release loop, seconds later. The arm draws
    // from the same per-segment seeded RNG, so a held piece arms with
    // exactly the values an immediate release would have had.
    const piece = new BreakupPiece(ctx.scene, clone, 0, 0, 0, 0, 0, 0);
    if (held) { piece.held = true; piece.group.visible = false; } // v1.6.0 perf: pre-built held pieces stay hidden until the first release flips them visible (the intact group shows the ship until then)
    else this._armPiece(ctx, seg, piece);
    piece.clipMats = clipMats;
    piece.segLen = hi - lo; // v1.4.0 (item 6): wreckage field size
    piece.segLo = lo; piece.segHi = hi; piece.segCentre = segCentre; piece.segKind = seg.kind; // solidity: real section bounds (collisions.js)
    // v1.6.0 S2: diagonal-cut metadata for the two-box OBB — which
    // ends are diagonal cuts (a hull end is not a cut).
    piece.diagAngle = diagAngle || 0;
    piece.diagLo = !!diagAngle && lo > -CARRIER_LEN / 2 + 1;
    piece.diagHi = !!diagAngle && hi < CARRIER_LEN / 2 - 1;
    piece.carrierName = this.name;
    // v1.5.0: per-piece fall identity. A longitudinal half is half
    // the ship (massFrac/areaFrac 0.5) and only 42 m wide — its
    // collision proxy is 21 m half-beam centred at ±21 m local x.
    if (seg.kind === 'longPort' || seg.kind === 'longStbd') {
      piece.massFrac = 0.5; piece.areaFrac = 0.5;
      piece.halfBeamOverride = 21;
      piece.centreLocal = { x: seg.half === 'port' ? -21 : 21, y: 0, z: 0 };
    }
    // v1.5.0 §3 flutter: a long flat piece rocks with growing amplitude.
    if ((hi - lo) > 100 && Math.abs(this.pitch) < 0.2) piece.rockAmp = 0.03;
    piece.burning = this.fires.length > 0 || reason === 'fire' || reason === 'detonation';
    // v1.4.0 solidity: a piece is its parent's own hull — it must
    // never collide with the parent while the parent is breaking up
    // (the piece is born inside the parent's OBB; resolving that
    // overlap shoved pieces vertically at the 12 m/s push-apart cap
    // and zeroed their fall speed). Pieces still collide with every
    // OTHER carrier and with each other.
    piece.parentCarrier = this;
    piece.reason = reason;
    piece.capMeshes = capMeshes;
    piece.petalGroups = petalGroups;
    piece.cutFaces = cutFaces;
    piece.refreshClipPlanes(); // aim the planes before the first frame
    this.pieces.push(piece);
    // v1.6.0 duplicates fix (B): the release count advances at RELEASE,
    // not at held-spawn — a held piece is still part of the ship.
    if (!held) this._breakReleased++;
    return piece;
  }
  // v1.6.0 duplicates fix (B): arm a built piece for release — ejection
  // velocities, tumble rates, cook-off transfer, bornT, sink duration.
  // This is the ejection block _separatePiece used to run inline, moved
  // verbatim (same per-segment seeded RNG, same draw order), so the
  // values are identical to an immediate release; only the moment they
  // are applied moves. Also re-derives the piece's integrated state
  // (y/roll/pitch/heading) from its group, which the carrier has been
  // driving while the piece was held.
  _armPiece(ctx, seg, piece) {
    const plan = this._breakPlan;
    const { lo, hi, centre: segCentre } = seg;
    const { severity, cutOff, hit, reason } = plan;
    const segIdx = plan.segments.indexOf(seg);
    // v1.4.0 mass (audit F4 + research §4.2): tumble comes from the
    // off-centre blast/hinge geometry, not coin flips — and is capped
    // by piece size: ω_roll ≤ 21/L rad/s (a 60 m piece ≤ 0.35 rad/s,
    // 20°/s; a 150 m half-ship ≤ 0.14 rad/s), pitch/yaw ≤ half that.
    // Nearest-blast pieces tumble fastest. Rates decay τ=8 s in air
    // (BreakupPiece.update); they never increase after release except
    // for the water-impact pitch kick.
    const rng = mulberry32(fracSeed(this._brkSeed, segIdx, hit.lz) + 991);
    const L = Math.max(20, hi - lo);
    const rollCap = 21 / L, pitchCap = rollCap / 2, yawCap = rollCap / 2;
    const dHit = Math.abs(segCentre - cutOff);
    const nearF = 1 + 0.5 * (1 - Math.min(1, dHit / 150));
    const away = Math.sign(segCentre - cutOff) || (rng() < 0.5 ? 1 : -1);
    const rollBase = (0.15 + 0.35 * severity) * nearF;
    const rollRate = Math.max(-rollCap, Math.min(rollCap, rollBase)) * away;
    const pitchRate = Math.max(-pitchCap, Math.min(pitchCap, (0.1 + 0.2 * severity) * nearF)) * (hit.lx >= 0 ? 1 : -1);
    const yawRate = Math.max(-yawCap, Math.min(yawCap, 0.02 + 0.03 * severity)) * (rng() < 0.5 ? 1 : -1);
    // v1.4.0 ejection velocities by kill type (research §4.1, Gurney:
    // large sections are mass-dominated so section velocity is tens of
    // m/s, not km/s). All add to the inherited velocity; total
    // horizontal speed is capped at 25 m/s.
    const fwd = plan.fwd;
    let along = 0, up = 0, lat = 0;
    if (reason === 'detonation') {
      along = (18 * Math.exp(-dHit / 120) + 4) * (0.85 + rng() * 0.3); // 8–18 m/s
      up = 3 + rng() * 5;
      lat = (2 + rng() * 4) * (rng() < 0.5 ? 1 : -1); // radial out of the blast
    } else if (reason === 'water impact') {
      const shatter = plan.segments.length >= 4;
      along = shatter ? 4 + rng() * 6 : 2 + rng() * 2; // 4–10 / 2–4 m/s
      lat = shatter ? (2 + rng() * 3) * (rng() < 0.5 ? 1 : -1) : 0;
      up = shatter ? 2 + rng() * 2 : 0;
    } else {
      along = 2 + rng() * 4; // structural: 2–6 m/s, gravity owns the rest
    }
    // v1.5.0 D2: the halves separate LATERALLY (side-by-side, not
    // end-to-end) — the capsule push-apart in collisions.js handles
    // lateral separation on the SAT axes.
    if (seg.kind === 'longPort' || seg.kind === 'longStbd') {
      lat = (seg.half === 'port' ? -1 : 1) * (7 + rng() * 4);
      along = (rng() - 0.5) * 4;
      up = 1 + rng() * 2;
    }
    // Radial-outward component for detonation: away from the blast
    // point in the horizontal plane (here approximated by the
    // along-hull away direction + the lateral term above).
    const rx = -fwd.z, rz = fwd.x; // hull-right in XZ
    let vx = (this.vx || 0) + plan.impactVx + fwd.x * away * along + rx * lat;
    let vz = (this.vz || 0) + plan.impactVz + fwd.z * away * along + rz * lat;
    const hSpeed = Math.hypot(vx, vz);
    if (hSpeed > 25) { vx *= 25 / hSpeed; vz *= 25 / hSpeed; }
    piece.vy = plan.fallVy + up;
    piece.vx = vx; piece.vz = vz;
    piece.rollRate = rollRate; piece.pitchRate = pitchRate; piece.yawRate = yawRate;
    piece.y = piece.group.position.y;
    piece.roll = piece.group.rotation.z; piece.pitch = piece.group.rotation.x; piece.heading = -piece.group.rotation.y;
    piece.burning = this.fires.length > 0 || reason === 'fire' || reason === 'detonation';
    // v1.5.0 D11: cook-offs whose clock falls after this release ride
    // on the piece (times re-based to seconds after bornT).
    piece.cookoffs = plan.cookoffs
      .filter(ck => ck.segIdx === segIdx && !ck.fired)
      .map(ck => { ck.fired = true; return { at: Math.max(0.1, ck.at - (seg.releaseBreakT || 0)), size: ck.size, fired: false }; });
    piece.bornT = ctx.time || 0;
    // v1.4.0 mass (audit F11): sinking duration from size —
    // v_max = 3.5·√(60/segLen) m/s, clamped 2–6 m/s, so a 150 m
    // half-ship sinks slower than a 20 m fragment.
    // v1.4.1: ±20% per piece (seeded), so identical-size pieces do
    // not sink in lockstep.
    const vMaxPiece = Math.max(2, Math.min(6, 3.5 * Math.sqrt(60 / L)));
    piece.sinkDur = 110 / vMaxPiece * (0.85 + rng() * 0.4); // max descent rate = 2·drop/dur (drop >= 55 m, see the sink branch)
    piece.held = false;
  }
  // v1.6.0 duplicates fix (B): release a held piece at its releaseAt.
  // A pulverised held segment bursts instead of becoming a piece — its
  // held group is removed first, so the burst replaces it in the same
  // frame instead of doubling it. Removing a never-released held
  // section from c.pieces is not the v1.6.0 Item-2 case (a wreck
  // leaving the array) — it never existed as an independent piece.
  _releaseHeldPiece(ctx, seg) {
    const piece = seg._heldPiece;
    seg._heldPiece = null;
    if (!piece) return;
    if (seg.pulverised) {
      if (piece.group.parent) piece.group.parent.remove(piece.group);
      this.pieces = this.pieces.filter(p => p !== piece);
      this._pulveriseSegment(ctx, seg);
      this._breakReleased++;
      return;
    }
    this._armPiece(ctx, seg, piece);
    piece.group.visible = true; // v1.6.0 perf: a piece released before the first-release flip (or pre-built hidden) shows now
    this._breakReleased++;
  }
  // v1.6.0 Item 2: the origin altitude at which this carrier's lowest
  // corner touches the seabed (SEA_FLOOR_Y), from the group's live
  // transform — exact for any pitch/roll. The local box is the game's own
  // hull box (x ±42, keel -34, island top +34, z ±166) — the keel/top
  // are the measured solid-mesh extents (hull_16 keel -33.9, island_6
  // top +34.0 at level, probed 27 Nov), not the old -30/+20 guess, so
  // the true keel rests on the floor instead of 4 m under it. Only the
  // rotation row enters: the translation in the matrix is the group's
  // position, which is stale by a frame when this is called mid-update.
  _floorRestY() {
    this.group.updateWorldMatrix(true, false);
    const m = this.group.matrixWorld.elements;
    let minOff = Infinity;
    for (const x of [-42, 42]) for (const y of [-34, 34]) for (const z of [-166, 166]) {
      const off = m[1] * x + m[5] * y + m[9] * z;
      if (off < minOff) minOff = off;
    }
    return SEA_FLOOR_Y - minOff;
  }
  update(dt, ctx) {
    // Breakup pieces always update.
    for (const p of this.pieces) p.update(dt, ctx);
    // v1.6.0 Item 2: pieces are NEVER removed from c.pieces any more —
    // the old `filter(p => !p.gone)` deleted a wreck from the array the
    // same frame it went 'gone', so it could never rest on the seabed or
    // stay selectable. Wrecks now go to state 'rested' and stay in the
    // array (and visible) for the rest of the round.
    // v1.4.0 progressive breakup: drive phases 1–3 on the intact
    // group while it is coming apart; updateBreakup() returns true
    // once the last piece has released (state now 'gone').
    if (this.breakState !== 'none') {
      if (this.updateBreakup(dt, ctx)) return;
    }
    if (this.state === 'gone' || this.state === 'rested') return;
    // v1.4.0 rotor spool (spec §2.4): spin rate follows rotor demand —
    // throttle first (the lift fans hold the ship up), forward speed
    // second, a touch more while climbing — with a 6 s first-order lag,
    // so the fans visibly work in step with the carrier and a 38 m fan
    // no longer reads as full-speed in the first second. A pod
    // destroyed mid-spool winds down with the same lag. Throttle is a
    // TOTAL lift demand shared over the surviving fans, so losing a pod
    // makes the survivors spin harder (throttle/lift) up to the 1.15
    // cap — they compensate, they do not all slow down (the old
    // x lift factor that slowed every fan when one pod died is gone).
    // Counter-rotating diagonal pairs spin opposite ways.
    for (const pod of this.pods) {
      if (!pod.rotorSpin) continue;
      const demand = (this.state === 'sinking' || this.state === 'gone' || this.state === 'capsizing') ? 0
        : Math.max(0, Math.min(1.15, this.throttle / Math.max(this.lift, 0.25) + 0.1 * (Math.abs(this.forwardSpeed) / 20) + (this.vy > 1 ? 0.05 : 0)));
      let target = pod.alive ? 30 * demand : 0;
      // v1.5.0 §3 windmilling: an attached-but-unpowered pod in
      // freefall windmills in the airstream (~4 rad/s) instead of
      // stopping dead — it reads as "still alive", and it spins while
      // the ship falls. (Zero-throttle pods at hover demand spin at
      // 30*demand; only the unpowered fall windmills.)
      if (pod.alive && this.state === 'falling' && (this.liftThrustNow || 0) < 0.1) target = 4;
      pod.spinRate += (target - pod.spinRate) * (1 - Math.exp(-dt / PHYSICS.ROTOR_SPOOL_TAU)); // spool lag
      pod.spinAngle += pod.spinRate * dt * pod.spinDir;
      pod.rotorSpin.rotation.y = pod.spinAngle;
      // v1.4.1 film beat (Winter Soldier/ILM): a struck engine
      // wobbles — the fan disc tilts and shudders on its axis while
      // it still spins, decaying over ~1 s. Tilt only; the spin
      // rate/direction and the duct housing are untouched.
      if (pod.wobble > 0.01) {
        pod.wobble *= Math.exp(-dt * 0.8);
        const w = pod.wobble * 0.04 * Math.sin(ctx.time * 9 + pod.spinAngle * 0.5);
        pod.rotorSpin.rotation.x = w;
        pod.rotorSpin.rotation.z = w * 0.7;
      } else if (pod.rotorSpin.rotation.x !== 0 || pod.rotorSpin.rotation.z !== 0) {
        pod.rotorSpin.rotation.x = 0;
        pod.rotorSpin.rotation.z = 0;
      }
      if (pod.blur) pod.blur.material.opacity = 0.10 + 0.22 * Math.max(0, Math.min(1, pod.spinRate / 30)); // v1.2.1: fan disc reads solid from below
    }
    // Island radar bar sweeps while the carrier lives.
    if (this.radar && this.state === 'alive') this.radar.rotation.y += dt * 1.5;
    // Fires: drain zone HP, spawn flame/smoke, spread.
    // v1.2.0 visuals are tied to the zone and the hit severity — a
    // reactor fire is bigger, hotter and smokier than a pod fire, and
    // a hard hit burns harder. (Drain rate and spread are unchanged.)
    // v1.3.1: the visuals also EVOLVE as the zone burns down — the
    // flame/smoke scale grows with the burn fraction, reactor fires
    // burn white-blue at the core, magazine fires red-orange, and
    // smoke darkens as the fire matures. Hot magazine/reactor fires
    // throw visual-only cook-off bursts as they near burnout.
    this.fireT -= dt;
    for (const f of this.fires) {
      f.t += dt;
      f.intensity = Math.min(1, f.intensity + dt * 0.05);
      // v1.5.0 §6/D12 travelling fire front: the front advances along
      // the deck at 5-10 m/s (frontSpeed, set at ignite), leaving a
      // scorch sprite every ~10 m behind it. It runs the deck length
      // and stops at the bow/stern — it never leaves the deck.
      if (f.frontLz !== undefined) {
        const prevLz = f.frontLz;
        f.frontLz += f.frontDir * f.frontSpeed * dt;
        if (f.frontLz > 160 || f.frontLz < -160) f.frontDir *= -1;
        f.frontLz = Math.max(-160, Math.min(160, f.frontLz));
        f.scorchAcc = (f.scorchAcc || 0) + Math.abs(f.frontLz - prevLz);
        if (f.scorchAcc >= 10 && ctx.vfx) {
          f.scorchAcc = 0;
          const sc = ctx.vfx.addScorch(this.group, f.frontLx, deckLocalYAt(f.frontLz) + 1, f.frontLz, 12);
          this.scorches.push(sc);
          if (this.scorches.length > 20) { const s = this.scorches.shift(); this.group.remove(s); }
        }
      }
      const zoneScale = f.zone === 'reactor' ? 1.5 : f.zone === 'magazine' ? 1.35 : f.zone === 'deck' ? 1.1 : f.zone.startsWith('pod:') ? 0.85 : 1;
      const sevScale = 0.7 + 0.3 * (f.sev || 1);
      const zoneHpFrac = f.zone.startsWith('pod:')
        ? ((this.pods[+f.zone.split(':')[1]] || { hp: 0 }).hp / 100)
        : (this.zones[f.zone] ? this.zones[f.zone].hp / this.zones[f.zone].max : 0);
      const burnFrac = 1 - Math.max(0, Math.min(1, zoneHpFrac));
      const visScale = zoneScale * sevScale * (0.8 + 0.6 * burnFrac);
      const drain = f.intensity * FIRE_DRAIN_RATE * dt;
      if (f.zone.startsWith('pod:')) {
        const pod = this.pods[+f.zone.split(':')[1]];
        if (pod && pod.alive) { pod.hp -= drain; if (pod.hp <= 0) { this._killPodVisual(pod); if (this.lift <= 0) this.startFall(ctx, 'last lift pod burned out'); } }
      } else {
        const z = this.zones[f.zone];
        if (z) { z.hp = Math.max(0, z.hp - drain); if (z.hp <= 0 && f.zone === 'reactor') { this.detonate(ctx, 'reactor'); return; } }
      }
      if (this.fireT <= 0) {
        // v1.5.0: flames burn at the travelling front, not the origin.
        const wp = this.deckPoint(f.frontLx !== undefined ? f.frontLx : f.lx, f.frontLz !== undefined ? f.frontLz : f.lz);
        // v1.5.0 §6: smoke trails BEHIND the ship's motion (forward
        // speed + wind) and vents from the LOW side when she lists —
        // dark oily for fuel/ordnance, white steam for the reactor
        // (smokeCol below, unchanged).
        const vent = Math.abs(this.list) > 0.08
          ? this.deckPoint((f.frontLx !== undefined ? f.frontLx : f.lx) + Math.sign(this.list) * 20, f.frontLz !== undefined ? f.frontLz : f.lz)
          : wp;
        const nFl = 2 + Math.floor(f.intensity * 4);
        const fc = f.zone === 'magazine' ? [1, 0.4, 0.15] : [1, 0.65, 0.2];
        for (let i = 0; i < nFl; i++) {
          const col = f.zone === 'reactor' && i % 3 === 0 ? [0.75, 0.85, 1] : fc; // reactor core burns white-blue
          ctx.vfx.spawnParticle(wp.x + (Math.random() - 0.5) * 6, wp.y + 2, wp.z + (Math.random() - 0.5) * 6,
            (Math.random() - 0.5) * 2, (2 + Math.random() * 2.5) * visScale, (Math.random() - 0.5) * 2, 0.8 * visScale, col[0], col[1], col[2], -0.5);
        }
        // Hot fires throw embers; reactor/magazine fires throw more.
        if (f.intensity > 0.7) {
          for (let i = 0; i < Math.round(2 * visScale); i++) {
            ctx.vfx.spawnParticle(wp.x + (Math.random() - 0.5) * 4, wp.y + 2, wp.z + (Math.random() - 0.5) * 4,
              (Math.random() - 0.5) * 4, 4 + Math.random() * 3, (Math.random() - 0.5) * 4, 1.2, 1, 0.5, 0.1, -6);
          }
        }
        const smokeCol = f.zone === 'reactor' ? 0xd8ecf2 : burnFrac > 0.5 ? 0x0a0a0a : (f.zone === 'magazine' ? 0x241812 : 0x141414);
        const sm = ctx.vfx.spawnSprite(vent.x, vent.y + 8, vent.z, 3.5, (8 + f.intensity * 4 + burnFrac * 6) * visScale, (8 + f.intensity * 4 + burnFrac * 6) * visScale, 0.5,
          smokeCol, 0.6);
        sm.vy = 3;
        sm.vx = -this.vx * 0.3; sm.vz = -this.vz * 0.3; // trail behind the motion
      }
      // Cook-off: a hot magazine/reactor fire throws secondary bursts
      // as it matures — visual only, no extra damage.
      if ((f.zone === 'magazine' || f.zone === 'reactor') && f.intensity > 0.85) {
        const z = this.zones[f.zone];
        if (z && z.hp < 45) {
          f.cookT -= dt;
          if (f.cookT <= 0) {
            f.cookT = 3 + Math.random() * 3;
            const wp2 = this.deckPoint(f.lx, f.lz);
            ctx.vfx.burst(wp2.x, wp2.y + 4, wp2.z, 18, [1, 0.55, 0.15], 9, 5);
            ctx.vfx.spawnSprite(wp2.x, wp2.y + 4, wp2.z, 0.4, 12 * (CARRIER_LEN / 42), 12 * (CARRIER_LEN / 42), 3, 0xff8c2e, 0.9);
            if (ctx.audio) ctx.audio.boom(false);
          }
        }
      }
      // Spread: every ~5 s, 8% chance to ignite another damaged zone.
      if (f.t > 5 && Math.random() < dt * 0.016) {
        const keys = ['reactor', 'magazine', 'bridge', 'deck', 'engines'];
        const k = keys[Math.floor(Math.random() * keys.length)];
        if (this.zones[k].hp < this.zones[k].max) this.ignite(k, (Math.random() - 0.5) * 40, (Math.random() - 0.5) * 200, 1, ctx);
      }
    }
    if (this.fireT <= 0) this.fireT = 0.15;
    // Hurt smoke (no fire): hp < 70% dark smoke, < 40% thicker + embers
    // (v1.3.0 H grading — was smoke-only at both thresholds).
    this.hurtT -= dt;
    if (this.hurtT <= 0 && this.hpFrac < 0.7 && this.state === 'alive') {
      this.hurtT = this.hpFrac < 0.4 ? 0.3 : 0.45;
      const wp = this.deckPoint((Math.random() - 0.5) * 40, (Math.random() - 0.5) * 200);
      const sm = ctx.vfx.spawnSprite(wp.x, wp.y + 6, wp.z, 3.0, 10, 10, 0.4, 0x1a1a1a, 0.5);
      sm.vy = 2.5; sm.vx = -this.vx * 0.3; sm.vz = -this.vz * 0.3; // v1.5.0 §6: smoke trails behind the motion
      if (this.hpFrac < 0.4) {
        // Thicker smoke + embers below 40%.
        const sm2 = ctx.vfx.spawnSprite(wp.x, wp.y + 10, wp.z, 3.5, 16, 16, 0.5, 0x141414, 0.65);
        sm2.vy = 3; sm2.vx = -this.vx * 0.3; sm2.vz = -this.vz * 0.3;
        for (let i = 0; i < 2; i++) {
          ctx.vfx.spawnParticle(wp.x + (Math.random() - 0.5) * 6, wp.y + 3, wp.z + (Math.random() - 0.5) * 6,
            (Math.random() - 0.5) * 3, 3 + Math.random() * 3, (Math.random() - 0.5) * 3, 1.0, 1, 0.5, 0.1, -6);
        }
      }
      // v1.3.1: a dying ship (below 25%) flickers with small flames at
      // scorched deck points even where no fire object is burning.
      if (this.hpFrac < 0.25 && Math.random() < 0.35) {
        const fp = this.deckPoint((Math.random() - 0.5) * 50, (Math.random() - 0.5) * 220);
        for (let i = 0; i < 3; i++) {
          ctx.vfx.spawnParticle(fp.x + (Math.random() - 0.5) * 4, fp.y + 2, fp.z + (Math.random() - 0.5) * 4,
            (Math.random() - 0.5) * 2, 2 + Math.random() * 2, (Math.random() - 0.5) * 2, 0.7, 1, 0.6, 0.2, -0.5);
        }
      }
    }

    if (this.state === 'alive') {
      // v1.4.1 zero throttle = zero lift: no thrust, no altitude hold,
      // no scripted −6 m/s descent, no 150 m floor — the ship falls
      // under gravity (the existing startFall / freefall / water-impact
      // path, spec §8). Any throttle above zero stays in controlled
      // flight with the floor; only true zero drops her. The fall is
      // recoverable: the pods are alive, so restoring throttle spools
      // the fans back up (see the falling branch) — but only if there
      // was altitude to spool up in.
      // v1.6.2: the switch above is now for TRUE zero only — the
      // physics is continuous across it. Intermediate throttles
      // (0.005–0.69) no longer hit a -8 m/s capped sink; they take
      // the gravity-descent branch in the alive update below
      // (a = -g*(1 - liftThrust) + drag), which at 0.005 gives
      // -9.74 m/s^2 against the fall's -9.81 — the same curve, so
      // there is no cliff at the switch any more.
      // v1.5.0 D9: a crippled ship's breakup owns her fate — the
      // zero-throttle fall must not fire while she is shedding pieces.
      if (this.throttle < 0.005 && this.breakState === 'none' && !this._crippled) { this.startFall(ctx, 'throttle at zero — no lift', { recoverable: true }); return; }
      // v1.3.0 blast shove: the impulse velocity decays and drags the
      // hull with it; the heel kick decays back to level and the yaw
      // kick nudges the heading. All three decay, so a blast rocks the
      // ship instead of permanently displacing her.
      // v1.4.0 mass (audit F9): the shove decays with τ=4 s (the same
      // as TAU_SPEED), so it reads as a heavy slide, not a twitch; and
      // it is mirrored into vx/vz so any reader of the velocity state
      // (collisions effVel, HUD, probes) sees the same motion as the
      // position. driveCarrierPhysics overwrites vx/vz next frame, so
      // the mirror is per-frame, never double-integrated.
      if (Math.abs(this.blastVx) > 0.01 || Math.abs(this.blastVz) > 0.01) {
        this.x += this.blastVx * dt; this.z += this.blastVz * dt;
        this.vx += this.blastVx; this.vz += this.blastVz;
        const bd = Math.exp(-dt / 4);
        this.blastVx *= bd; this.blastVz *= bd;
      }
      if (Math.abs(this.blastYaw) > 0.0001) {
        this.heading += this.blastYaw * dt;
        this.blastYaw *= Math.exp(-dt * 1.5);
      }
      this.heelKick *= Math.exp(-dt * 1.2);
      // Lift layer (Pandora lift/list rules, adapted): list toward dead pods.
      const deadX = this.pods.filter(p => !p.alive).reduce((a, p) => a + p.local.x, 0);
      // v1.5.0 §6: the list target is the lift-loss lean PLUS the
      // event-driven steps in _damageList; it eases at dt*2 so each
      // step reads as a step, not a slow drift.
      const listTarget = Math.max(-0.45, Math.min(0.45, (1 - this.lift) * 0.12 * (deadX >= 0 ? 1 : -1) + this._damageList));
      this.list += (listTarget - this.list) * Math.min(1, dt * 2);
      // v1.4.0 roll: bank (coordinated-turn result, lagged at TAU_ROLL
      // in game.js) + damage list + blast heel. Bank is never eased
      // here — it arrives already lagged.
      this.roll = this.bank + this.list + this.heelKick;
      // v1.4.0 pitch (spec §7.2): pitchRate chases pitchInput x
      // PITCH_RATE_MAX at the mass-limited PITCH_ACCEL (0.0173 rad/s^2
      // from the measured 65.1 m lever — full 12 deg in ~5.2 s from
      // neutral). The old 0.5 rad/s rate limit (12 deg in 0.42 s) is
      // gone; pitchRate is zeroed at the stops, never wound up.
      // Control authority scales with lift (§7.4): a 2-pod ship
      // pitches at 75% authority.
      // Return to level: when the pitch command is released the
      // fly-by-wire springs back to level (v1.2.0 release behaviour —
      // pitch eases to 0, vy to 0, altitude hold resumes at the release
      // altitude). A pure rate-command model has no restoring term: on
      // release pitchRate decays to 0 and the attitude freezes wherever
      // it was (probed: stuck at ±12 deg forever). So with no input the
      // rate target is proportional to the attitude error instead,
      // capped at the same max rate — the return is as mass-limited as
      // the deflection (~5-6 s from 12 deg), not a snap.
      const auth = 0.5 + 0.5 * this.lift;
      let pitchRateTarget;
      if (Math.abs(this.pitchInput) > 0.05) {
        pitchRateTarget = Math.max(-1, Math.min(1, this.pitchInput)) * PHYSICS.PITCH_RATE_MAX * auth;
      } else {
        pitchRateTarget = Math.max(-PHYSICS.PITCH_RATE_MAX * auth, Math.min(PHYSICS.PITCH_RATE_MAX * auth, -this.pitch * 1.0));
      }
      this.pitchRate += Math.max(-this.pitchAccel * dt, Math.min(this.pitchAccel * dt, pitchRateTarget - this.pitchRate));
      this.pitch += this.pitchRate * dt;
      if (this.pitch > PHYSICS.PITCH_MAX) { this.pitch = PHYSICS.PITCH_MAX; this.pitchRate = 0; }
      if (this.pitch < -PHYSICS.PITCH_MAX) { this.pitch = -PHYSICS.PITCH_MAX; this.pitchRate = 0; }
      // v1.6.2 throttle-continuous descent (Nicholas 02:09 SGT) — ONE
      // vertical equation for throttle, no binary switch. Lift is the
      // lift actually produced (fraction of weight) — _liftSpool below:
      // it cuts instantly when throttle drops (fans stop, as in the
      // v1.4.2 freefall model) and spools UP with ROTOR_SPOOL_TAU
      // (6 s), the same asymmetric spool as the falling branch's
      // _fallSpool. So a throttle cut drops lift at once (a descent
      // starts at the full shortfall acceleration), and FULL throttle
      // from a descent takes the 6 s spool to arrive.
      //   liftThrust >= 1: controlled flight, as before — vy chases
      //     the climb command (pitch + altitude hold + the throttle
      //     excess over hover, linear in throttle) with TAU_VY.
      //   liftThrust < 1: gravity descent — net vertical acceleration
      //     from the lift shortfall, with drag, the SAME equation as
      //     the falling branch: a = -g*(1 - liftThrust) + a_drag. At
      //     0.69 a = 0 (hover); just below, a slow sink; half throttle
      //     -2.7 m/s^2; zero throttle full freefall (a = -g + drag,
      //     80.8 m/s from 350 m, as verified). No velocity cap, no
      //     hold, no pitch vertical on this side: the old model chased
      //     a capped velocity (throttleClimb = excess*8, clamped at
      //     -8 m/s) and jumped to the freefall branch at throttle <
      //     0.005 — a cliff between a -7.9 m/s sink and an unbounded
      //     fall. That cliff and the cap are gone: the curve is one
      //     smooth function of throttle through hover (both sides give
      //     vy = 0 and a = 0 at exactly 0.69).
      //   Carve-outs (scripted sequences, not throttle flight):
      //     _crippled (D9 shedding) and mid-breakup keep the old
      //     velocity model — their descents are scripted, and their
      //     verified behaviour (crippled ~2.5 m/s sink, breakup
      //     sequencing) is untouched.
      //   Consequence to know (same equation, damage side): a ship
      //     whose SURVIVING lift cannot make weight — a 2-pod ship
      //     (max 0.73W) at any throttle — now accelerates down at
      //     -g*(1 - liftThrust) instead of sinking steadily at
      //     ~2.2 m/s. She could never hover; now she falls like the
      //     physics says. (3-pod ships still hold: 1.09W max.)
      const liftTarget = Math.min(this.throttle * PHYSICS.T_LIFT_MAX_RATIO, this.lift * PHYSICS.T_LIFT_MAX_RATIO);
      if (liftTarget < this._liftSpool) this._liftSpool = liftTarget;
      else this._liftSpool += (liftTarget - this._liftSpool) * (1 - Math.exp(-dt / PHYSICS.ROTOR_SPOOL_TAU));
      const liftThrust = this._liftSpool;
      this.liftThrustNow = liftThrust; // v1.4.2: lift actually produced (downwash + probes)
      const marginFrac = Math.max(0, Math.min(1, (this.lift * PHYSICS.T_LIFT_MAX_RATIO - 1) / (PHYSICS.T_LIFT_MAX_RATIO - 1)));
      if (liftThrust < 1 && !this._crippled && this.breakState === 'none') {
        // Gravity descent (see the note above). Hold is suspended and
        // targetAlt tracks the ship, so hold resumes at the descent
        // altitude when throttle returns to hover.
        this.targetAlt = this.y;
        const area = fallProjectedArea(this.pitch, this.roll);
        const a = -9.81 * (1 - liftThrust) + fallDragAccel(this.vy, area, PHYSICS.MASS);
        this.vy += a * dt;
        this.y += this.vy * dt;
        this.y = Math.min(650, this.y);
        // No altitude floor on a gravity descent — she falls to the
        // sea, and the impact ladder decides the outcome exactly as
        // for a fall (see _waterImpact). The floor stop below is for
        // controlled flight only.
        const seaHg = ctx.sea.waveHeight(this.x, this.z, ctx.time);
        if (this.y <= seaHg + 2) this._waterImpact(ctx);
      } else {
        // Controlled flight — the v1.4.0 climb model, unchanged except
        // that liftThrust is now the SPOOLED value (see above), so a
        // throttle step develops over the 6 s spool; the steady-state
        // climb stays linear in throttle, hover at 0.69 unchanged.
        // (v1.4.0 spec §2.1/§7.4: throttle is a TOTAL lift demand,
        // shared over the surviving fans up to their combined 1.45xW
        // max; pitch climb authority scales with the REMAINING lift
        // margin: full lift -> full 6 m/s; 3 pods (margin 8.75%) ->
        // ~1.2 m/s; <=2 pods -> no margin, pitch cannot climb. Pitch
        // DOWN is not margin-limited. At default throttle a 3-pod ship
        // still holds altitude (demand 1.0W is inside her 1.09W max).)
        let climb = 0;
        const dy = this.targetAlt - this.y;
        if (dy > 2) climb = Math.min(PHYSICS.ALT_HOLD_CAP_UP, dy * 0.2);
        else if (dy < -2) climb = Math.max(PHYSICS.ALT_HOLD_CAP_DN, dy * 0.2);
        const liftExcess = liftThrust - 1;
        const throttleClimb = liftExcess * PHYSICS.THROTTLE_CLIMB;
        if (Math.abs(this.pitchInput) > 0.05 || Math.abs(throttleClimb) > 0.05) {
          // v1.4.0 mass (audit F13): spec §7.3 verbatim —
          // climb_cmd = clamp((|V|·0.8 + 6)·sin(pitch), ±6). The old
          // pitchBase gave 6.0 m/s at hover (spec: 1.25) and 6.0 at
          // FULL 16 m/s, 12° (spec: 3.9) — a 120,000 t ship must not
          // climb at 6 m/s from a hover on pitch alone. Pitch UP is
          // margin-limited (full lift -> full 6 m/s; 3 pods -> ~1.2);
          // pitch DOWN is not (descending only needs less lift).
          const pitchClimb = Math.max(-PHYSICS.CLIMB_MAX, Math.min(PHYSICS.CLIMB_MAX,
            (Math.abs(this.forwardSpeed) * 0.8 + 6) * Math.sin(this.pitch)));
          const pitchClimbM = pitchClimb >= 0 ? pitchClimb * marginFrac : pitchClimb;
          // v1.4.2: the descent clamp is CLIMB_MAX_DN (8), not
          // CLIMB_MAX (6). Below hover the throttle term is
          // acceleration, not a velocity (see the v1.6.2 note above),
          // so this clamp now bounds pitch-down descents only.
          climb = Math.max(-PHYSICS.CLIMB_MAX_DN, Math.min(PHYSICS.CLIMB_MAX, pitchClimbM + throttleClimb));
          this.targetAlt = this.y; // hold resumes here when pitch/throttle releases
        }
        // Pitch alone can never drive her into the sea or above the ceiling.
        // v1.5.0 D9 crippled flight: she sinks steadily (~2.5 m/s+) while
        // shedding — the controls go mushy (pitch authority x0.3) and
        // altitude hold cannot save her.
        if (this._crippled) {
          climb = Math.min(climb, -2.5);
          this.throttle = Math.max(0, this.throttle - dt * 0.03);
          this.pitchInput *= 0.3;
        }
        if (this.y <= ALT_FLOOR && climb < 0) climb = 0;
        if (this.y >= ALT_CEIL && climb > 0) climb = 0;
        // v1.4.0: one lag shape everywhere — first-order, tau named per
        // lag (spec §12.4). vy chases the climb command with TAU_VY 5 s.
        this.vy += (climb - this.vy) * (1 - Math.exp(-dt / PHYSICS.TAU_VY));
        this.y += this.vy * dt;
        // Hard altitude stops: pitch can ease the carrier down to the
        // floor, but never through it (and never above the ceiling) —
        // residual downward velocity is killed at the stop, so there is
        // no overshoot below it.
        // v1.4.1: the floor snap is a stop for a DESCENDING ship, not a
        // teleport for a ship that recovered from a zero-throttle fall
        // below the floor — a recovery can bottom out at ~60 m, and the
        // old unconditional snap (plus the 120 m backstop) teleported
        // her +93 m to 150 m in one frame (probed 2026-11-26). A ship
        // climbing out from below the floor just climbs; the climb gate
        // above already stops descents at the floor, and the falling
        // branch's impact is the only way down to the sea. The snap
        // therefore fires only on a descent command (climb <= 0) — a
        // recovery climbing out (climb > 0) never trips it.
        this.y = Math.min(650, this.y);
        if (this.y <= ALT_FLOOR && this.vy < 0 && climb <= 0) { this.y = ALT_FLOOR; this.vy = 0; }
        if (this.y >= ALT_CEIL) { this.y = ALT_CEIL; if (this.vy > 0) this.vy = 0; }
      }
      // v1.4.2 rotor downwash — spray + mist at the sea under each live
      // pod (the sea shader draws the flattened disc / spray ring /
      // churn; this is the airborne spray thrown up where the jet hits
      // the water and turns outward). Strength follows the same physics
      // as the shader sources (game.js): per-pod lift share faded with
      // height as (76/h)^2. Only below ~220 m and only while the fans
      // are actually producing lift; at cruise altitude nothing is
      // emitted. Throttled to one puff per pod every 0.25 s and guarded
      // by the live-pool counts, so 8 low carriers cost at most ~32
      // sprites + ~100 particles per second of pool churn — the pools
      // (420 sprites / 1600 particles) keep headroom for damage FX.
      // Spray velocities are visual, not the 325 m/s jet itself: the
      // particles are the water thrown up by the blast (radial outward
      // from each pod + up), capped so they read as spray, not tracers.
      this._washAcc = (this._washAcc || 0) + dt;
      if (liftThrust > 0.5 && this.y < 220 && this._washAcc > 0.25) {
        this._washAcc = 0;
        const seaH = ctx.sea.waveHeight(this.x, this.z, ctx.time);
        const h = Math.max(1, this.y - seaH);
        const fall = Math.min(1, (76 / h) * (76 / h));
        const nAlive = this.pods.filter(p => p.alive).length;
        if (nAlive && ctx.vfx.liveSprites() < 300 && ctx.vfx.liveParticles() < 1200) {
          for (const p of this.pods) {
            if (!p.alive) continue;
            const sPod = (liftThrust / nAlive) * fall;
            if (sPod < 0.02) continue;
            _bpV.set(p.local.x, p.local.y, p.local.z);
            this.group.localToWorld(_bpV);
            const R = Math.min(60, 19 * (1 + h / 76));
            // Mist: a wide soft sprite hanging over the sea under the
            // pod, growing slowly and fading — the spray cloud.
            ctx.vfx.spawnSprite(_bpV.x, seaH + 3, _bpV.z, 1.2, R * 2, R * 1.2, 0.5, 0xd8ecf2, Math.min(0.4, 0.12 + sPod));
            // Spray: water thrown radially outward from under the pod.
            const sp = 6 + 14 * sPod; // m/s outward, visual scale
            for (let k = 0; k < 3; k++) {
              const a = Math.random() * Math.PI * 2;
              ctx.vfx.spawnParticle(_bpV.x + (Math.random() - 0.5) * 10, seaH + 1, _bpV.z + (Math.random() - 0.5) * 10,
                Math.cos(a) * sp * (0.6 + Math.random() * 0.8), 4 + Math.random() * 8, Math.sin(a) * sp * (0.6 + Math.random() * 0.8),
                0.7 + Math.random() * 0.5, 0.85, 0.95, 1, -9.81);
            }
          }
        }
      }
      this.group.position.set(this.x, this.y, this.z);
      this.group.rotation.set(this.pitch + (this.breakFlex || 0), -this.heading, this.roll + (this.breakHinge || 0) + (this._breakList || 0));
    } else if (this.state === 'falling') {
      // v1.4.2 GENUINE FREEFALL (real physics — see PHYSICS.FALL_*):
      // a = -g*(1 - liftThrust) + a_drag, integrated directly. The old
      // code chased a 40-70 m/s terminal with tau=2.5 s, which gave
      // ~27 m/s^2 initial acceleration (2.75g — impossible: a
      // freefalling body cannot accelerate faster than g) and capped
      // the fall at ~66 m/s. Now the initial acceleration is exactly
      // g, drag is the 1/2*rho*Cd*A*v^2 equation, and the terminal
      // velocity (291 m/s flat) is never reached from game altitudes
      // — she is still accelerating at impact (350 m: 8.5 s, 81 m/s;
      // 600 m: 11.2 s, 105 m/s). Attitude changes the projected area,
      // so a tumbling fall drags differently from a flat one. The
      // water-impact ladder below is unchanged in formula — it is now
      // driven by the corrected impact speed.
      this.fallT += dt;
      // Lift thrust actually being produced (0 in a dead fall; spools
      // back up with ROTOR_SPOOL_TAU when the player restores throttle
      // in a zero-throttle fall, and offsets weight directly).
      // Damage falls never take this path: _fallZeroThrottle is false.
      let liftThrust = 0;
      if (this._fallZeroThrottle) {
        const liftTarget = Math.min(this.throttle * PHYSICS.T_LIFT_MAX_RATIO, this.lift * PHYSICS.T_LIFT_MAX_RATIO);
        this._fallSpool += (liftTarget - this._fallSpool) * (1 - Math.exp(-dt / PHYSICS.ROTOR_SPOOL_TAU));
        liftThrust = this._fallSpool;
      }
      // v1.5.0 D9: a crippled remainder keeps producing lift while she
      // sheds, decaying to zero over ~14 s — she flies on, sinking
      // slowly, then the fall takes over.
      if (this._crippledLift > 0) {
        liftThrust = Math.max(liftThrust, this._crippledLift);
        this._crippledLift = Math.max(0, this._crippledLift - dt * 0.06);
      }
      this.liftThrustNow = liftThrust;
      const area = fallProjectedArea(this.pitch, this.roll);
      const a = -9.81 * (1 - liftThrust) + fallDragAccel(this.vy, area, PHYSICS.MASS);
      this.vy += a * dt;
      this.y += this.vy * dt;
      // Horizontal drift from the velocity at lift failure (see
      // startFall): decays slowly, like the pieces' ballistic drag.
      // v1.4.0 mass (audit F3): τ≈20 s — from 16 m/s over a ~15 s
      // fall the hull drifts ~130–150 m downrange, not 0 m. The old
      // fall branch never touched x/z at all (that was the bug); the
      // solidity merge already carries fallVx/fallVz, this sets the
      // mass-scaled decay and keeps vx/vz honest for effVel/HUD.
      const fDrag = Math.exp(-dt / 20);
      this.fallVx = (this.fallVx || 0) * fDrag;
      this.fallVz = (this.fallVz || 0) * fDrag;
      this.x += this.fallVx * dt;
      this.z += this.fallVz * dt;
      this.vx = this.fallVx; this.vz = this.fallVz;
      // Freefall attitude: no torque, so rates decay τ≈10 s (audit §1).
      const attDecay = Math.exp(-dt / 10);
      this.fallRollRate *= attDecay; this.fallPitchRate *= attDecay; this.fallYawRate *= attDecay;
      this.roll += this.fallRollRate * dt;
      this.pitch += this.fallPitchRate * dt;
      this.heading += this.fallYawRate * dt;
      this.group.position.set(this.x, this.y, this.z);
      this.group.rotation.set(this.pitch + (this.breakFlex || 0), -this.heading, this.roll + (this.breakHinge || 0) + (this._breakList || 0));
      // v1.4.2 recovery: the fans are producing at least hover thrust
      // (liftThrust >= 1) and the descent is arrested (vy >= -1 m/s)
      // — back to controlled flight at the recovery altitude,
      // targetAlt reset there. Note the physics consequence: hover
      // thrust alone (liftThrust = 1) gives zero net acceleration, so
      // it HOLDS a fall rate but cannot arrest one — arrest needs
      // MORE than hover thrust (full throttle, 1.45xW, gives +0.45g).
      // A late restore still hits the sea — the impact block below
      // decides that, not this check.
      if (this._fallZeroThrottle && this.breakState === 'none' && liftThrust >= 1 && this.vy >= -1) {
        this.state = 'alive';
        this._fallZeroThrottle = false;
        this.targetAlt = this.y;
        // Descent arrested (residual < 1 m/s) — zero it, so the floor
        // snap in the alive branch does not read her as still
        // descending and teleport her up to 150 m.
        this.vy = 0;
        ctx.msg(`${this.name} recovered — rotors spooled back up`);
        return;
      }
      // Breakup re-check during the fall: structural stress from the
      // damage already taken and the tumble — NOT from fall speed
      // alone. A lightly damaged ship (one pod lost, hp ~90%) mostly
      // rides the fall out intact; a wreck at 12% HP mostly comes
      // apart on the way down. No breakup in the last 80 m — the
      // water impact decides that. (v1.3.1: the old 0.35-per-check
      // rate broke up almost every fall in the air, so intact falls
      // never happened.)
      // v1.4.0: skipped while a breakup is already running — the
      // breakup state machine owns the fall until the last release.
      this.breakupT -= dt;
      if (this.breakState === 'none' && this.breakupT <= 0) {
        this.breakupT = 0.4;
        const speed = Math.abs(this.vy);
        const stress = (1 - this.hpFrac) * 0.7 + (Math.abs(this.fallRollRate) + Math.abs(this.fallPitchRate)) * 0.5 + (this.lift <= 0 ? 0.1 : 0);
        const seaH0 = ctx.sea.waveHeight(this.x, this.z, ctx.time);
        // v1.4.1: the fall breakup reason follows the damage — a
        // burning ship tears as a fire kill (slow, smoky, cook-offs),
        // a cold wreck as a structural kill. Seeded per carrier.
        if (speed > 25 && this.y > seaH0 + 80 && this._brkRng() < stress * 0.05) { this.breakUp(ctx, this.fires.length ? 'fire' : 'stressed in the fall'); return; }
      }
      // v1.5.0 §3 freefall breakup: aerodynamic load grows with v²
      // and finishes already-weakened damage — a cracked deck, a
      // damaged pod mount, the island base. Once per fall, past 25 m/s
      // and above 80 m, a weakened assembly can tear off on the
      // airstream: a dead pod rips off its mount (list jumps toward
      // the dead side), otherwise the island shears at its base.
      if (!this._fallTearDone && this.breakState === 'none' && Math.abs(this.vy) > 25) {
        const seaH1 = ctx.sea.waveHeight(this.x, this.z, ctx.time);
        if (this.y > seaH1 + 80 && this._brkRng() < (1 - this.hpFrac) * 0.05) {
          this._fallTearDone = true;
          // v1.6.0 duplicates fix (C): after a D9 the surviving core is
          // the only hull left — only tear off an assembly still on it.
          // A pod/island outside the core range already left with its
          // segment in the first breakup, and a pod whose meshes are
          // already hidden was already torn off; tearing either off
          // again would duplicate it.
          const onCore = (d) => !this._coreRange || (d >= this._coreRange[0] && d <= this._coreRange[1]);
          const deadPod = this.pods.findIndex(p => !p.alive && onCore(-p.local.z) && p.meshes.some(m => m.visible));
          this.group.updateMatrixWorld(true);
          if (deadPod >= 0) {
            const pod = this.pods[deadPod];
            const wp = this.group.localToWorld(new THREE.Vector3(pod.local.x, pod.local.y, pod.local.z));
            this._spawnAssemblyPiece(ctx, 'pod', deadPod, wp);
            this._addListStep(0.05, 'pod torn off in the fall', pod.local.x);
          } else {
            const ib = this._islandBoxLocal();
            const cx = ib ? (ib.min.x + ib.max.x) / 2 : 20;
            const cy = ib ? (ib.min.y + ib.max.y) / 2 : 15;
            const cz = ib ? (ib.min.z + ib.max.z) / 2 : 72;
            if (onCore(-cz)) {
              const wp = this.group.localToWorld(new THREE.Vector3(cx, cy, cz));
              this._spawnAssemblyPiece(ctx, 'island', undefined, wp);
            }
          }
        }
      }
      // v1.4.1 falling vent: a hurt ship falling intact vents smoke
      // from her deck as she goes down — pre-breakup behaviour even
      // when she never comes apart in the air.
      if (this.hpFrac < 0.6) {
        this._fallVentT -= dt;
        if (this._fallVentT <= 0) {
          this._fallVentT = 0.5;
          const wp = this.deckPoint((this._brkRng() - 0.5) * 40, (this._brkRng() - 0.5) * 200);
          const sm = ctx.vfx.spawnSprite(wp.x, wp.y + 6, wp.z, 2.5, 12, 12, 0.5, 0x141414, 0.55);
          sm.vy = 2;
        }
      }
      this._waterImpact(ctx);
    } else if (this.state === 'capsizing') {
      // v1.5.0 D8 progressive flooding capsize (Concordia/Estonia):
      // no breakup — the flooding state machine drives the list in
      // steps tied to events, the deck edge dips, she rolls to 90°
      // and sinks on her side, intact. Pods wind down as they flood.
      const cap = this._capsize;
      cap.t += dt;
      cap.stageT += dt;
      if (cap.stage < cap.stages.length - 1 && cap.stageT >= cap.stages[cap.stage].dur) {
        cap.stage++;
        cap.stageT = 0;
        const ns = cap.stages[cap.stage];
        cap.listTarget = ns.listDeg * Math.PI / 180 * cap.side;
        if (this.lastCapsize) this.lastCapsize.stages.push({ t: +cap.t.toFixed(1), listDeg: ns.listDeg, event: ns.event });
      }
      const listErr = cap.listTarget - this.list;
      this.list += Math.max(-0.06 * dt, Math.min(0.06 * dt, listErr));
      this.roll = this.bank + this.list + this.heelKick;
      this.pitch += (cap.trimTarget - this.pitch) * Math.min(1, dt * 0.2);
      // Settle slowly while listing; once the roll to 90° is running
      // (last stage) she sinks sideways, intact.
      const seaHc = ctx.sea.waveHeight(this.x, this.z, ctx.time);
      if (cap.stage >= cap.stages.length - 1) {
        cap.sinkT += dt / cap.sinkDur;
        const f = Math.min(1, cap.sinkT);
        // v1.6.0 Item 2: the sink ends on the seabed — the curve is
        // clamped at the floor (see _floorRestY) and the wreck rests
        // there, visible, instead of going 'gone' at -55 m.
        const capRestY = this._floorRestY();
        // Item 2 fix (27 Nov): same floor-reach depth as the piece
        // branch — a level hull rests at -60 m, deeper than the old
        // fixed 55 m drop, so it would hover at -55 m and snap.
        const capDrop = Math.max(55, cap.impactY - capRestY + 5);
        const capCurveY = cap.impactY - f * f * capDrop + seaHc * (1 - f) * 0.8;
        this.y = Math.max(capCurveY, capRestY);
        this.bubbleT = (this.bubbleT || 0) - dt;
        if (this.bubbleT <= 0 && f < 0.9) { this.bubbleT = 0.12 - 0.08 * Math.min(1, f / 0.7); ctx.vfx.bubbles(this.x, cap.impactY, this.z, 6 + Math.floor(f * 8), 200); }
        if (capCurveY <= capRestY || cap.sinkT >= 1.5) {
          this.state = 'rested';
          // Rotation first, so the rest snap uses this frame's attitude.
          this.group.rotation.set(this.pitch, -this.heading, this.roll);
          this.y = this._floorRestY(); this.group.position.y = this.y;
          if (this.lastCapsize) { this.lastCapsize.rollDeg = +(this.roll * 180 / Math.PI).toFixed(1); this.lastCapsize.durationS = +cap.t.toFixed(1); }
          if (ctx.wreckage) ctx.wreckage.spawn(this.x, this.z, {
            name: this.name, heading: this.heading,
            along: 120, across: 35, chunks: 10, slickR0: 55,
            vx: 0, vz: 0, born: ctx.time, burning: this.fires.length > 0,
          });
        }
      } else {
        this.y = Math.max(seaHc + 2, this.y - dt * 0.5);
      }
      this.group.position.set(this.x, this.y, this.z);
      this.group.rotation.set(this.pitch, -this.heading, this.roll);
    } else if (this.state === 'sinking') {
      // Hurricane sinking sequence (30 s quadratic descent), only AFTER
      // the wreck is in the water — the fall above was gravity, not this.
      // v1.4.0 mass (audit F10): the old branch eased roll to a fixed
      // 0.5 rad (28.6°) at τ=2 s and ignored the sea entirely, with a
      // stale vy of −62.7 m/s for the whole sinking. Now the list
      // develops at ≤0.035 rad/s (≈2°/s) toward the damage-derived
      // sinkRollTarget, the hull rides the swell while near the surface
      // (wave coupling fades as she goes down), and vy = dy/dt.
      this.sinkT += dt / (this._sinkDur || 30);
      const f = Math.min(1, this.sinkT);
      const waveH = ctx.sea.waveHeight(this.x, this.z, ctx.time);
      const prevY = this.y;
      // v1.6.0 Item 2: the sink ends on the seabed — clamp the curve at
      // the floor (see _floorRestY). She settles onto it as she rolls,
      // instead of sinking through to -55 m and vanishing.
      const sinkRestY = this._floorRestY();
      // Item 2 fix (27 Nov): see the capsize branch — the drop must
      // reach the floor (level hull rests at -60 m).
      const sinkDrop = Math.max(55, this.impactY - sinkRestY + 5);
      const sinkCurveY = this.impactY - f * f * sinkDrop + waveH * (1 - f) * 0.8;
      this.y = Math.max(sinkCurveY, sinkRestY);
      this.vy = dt > 0 ? (this.y - prevY) / dt : 0;
      // v1.5.0 §4.2: flooding is a CASCADE, not a fill — the list
      // grows in steps as compartments flood (f = 0.25/0.5/0.75 each
      // add ~3.5° toward the damage side), and the trim is set by
      // where the water is: bow-first is common (fine bow sections
      // have less reserve buoyancy), so she trims bow-down as she goes.
      const floodSide = Math.sign(this.sinkRollTarget || this._damageList || 1);
      if (this._sinkFloodStage === 0 && f >= 0.25) { this._sinkFloodStage = 1; this.sinkRollTarget += floodSide * 0.06; }
      if (this._sinkFloodStage === 1 && f >= 0.5) { this._sinkFloodStage = 2; this.sinkRollTarget += floodSide * 0.06; }
      if (this._sinkFloodStage === 2 && f >= 0.75) { this._sinkFloodStage = 3; this.sinkRollTarget += floodSide * 0.06; }
      this._sinkTrimTarget = -0.05; // bow-first
      this.pitch += (this._sinkTrimTarget - this.pitch) * Math.min(1, dt * 0.2);
      const rollErr = this.sinkRollTarget - this.roll;
      this.roll += Math.max(-0.035 * dt, Math.min(0.035 * dt, rollErr));
      this.group.position.y = this.y;
      this.group.rotation.x = this.pitch;
      this.group.rotation.y = -this.heading;
      this.group.rotation.z = this.roll;
      // v1.5.0 D11 post-splashdown cook-offs: a burning wreck keeps
      // popping after it hits the water (1-3 bursts over the first
      // ~18 s of sinking). Visual/audio only.
      if (!this._sinkCookInit) {
        this._sinkCookInit = true;
        this._sinkElapsed = 0;
        this._sinkCookoffs = [];
        if (this.fires.some(fl => fl.zone === 'magazine' || fl.zone === 'reactor')) {
          const n = 1 + Math.floor(Math.random() * 3);
          for (let i = 0; i < n; i++) this._sinkCookoffs.push({ at: 2 + Math.random() * 16, fired: false });
          this._sinkCookoffs.sort((a, b) => a.at - b.at);
        }
      }
      this._sinkElapsed = (this._sinkElapsed || 0) + dt;
      for (const ck of this._sinkCookoffs || []) {
        if (ck.fired || this._sinkElapsed < ck.at) continue;
        ck.fired = true;
        ctx.vfx.cookoffBurst(this.x, this.y + 4, this.z, 1);
        if (ctx.audio) ctx.audio.boom(false);
      }
      // v1.5.0 D14 implosion at depth (Derbyshire: voids collapse at
      // 25-100 m): below 25 m a late underwater bubble/debris burst as
      // an air pocket collapses. Fires once.
      if (!this._sinkImploded && this.y < -25) {
        this._sinkImploded = true;
        ctx.vfx.implosionBurst(this.x, this.y, this.z);
        if (ctx.audio) ctx.audio.boom(false);
      }
      this.bubbleT = (this.bubbleT || 0) - dt;
      // v1.5.0 §4.2: bubbles/boil INCREASE as trapped air is forced
      // out, then stop when the hull is full (interval 0.12 -> 0.04 s
      // to f = 0.7, silent past f = 0.9).
      if (this.bubbleT <= 0 && f < 0.9) { this.bubbleT = 0.12 - 0.08 * Math.min(1, f / 0.7); ctx.vfx.bubbles(this.x, this.impactY, this.z, 6 + Math.floor(f * 8), 200); }
      this.boilT = (this.boilT || 0) - dt;
      if (this.boilT <= 0 && f > 0.15 && f < 0.9) { this.boilT = 0.4 - 0.2 * Math.min(1, f / 0.7); ctx.vfx.boil(this.x, this.impactY, this.z, 60); }
      // v1.6.0 Item 2: she rests on the seabed when the curve reaches
      // the floor (or, as a safety, when the sink clock runs 50% past
      // its end) — visible and selectable for the rest of the round.
      // The old f>=1 pop hid her at -55 m. The rotation was already set
      // above, so the rest snap uses this frame's attitude.
      if (sinkCurveY <= sinkRestY || this.sinkT >= 1.5) {
        this.state = 'rested';
        this.y = this._floorRestY(); this.group.position.y = this.y;
        ctx.vfx.burst(this.x, this.impactY, this.z, 30, [0.8, 0.9, 1], 4, 4);
        // v1.4.0 (item 6): instead of vanishing after ~30 s (the old
        // six life-30 dark sprites below), she leaves persistent
        // floating wreckage — debris chunks + an oil slick that drift
        // with the current for the rest of the round (js/wreckage.js).
        // The short smoke puffs stay as the final gasp only.
        if (ctx.wreckage) ctx.wreckage.spawn(this.x, this.z, {
          name: this.name, heading: this.heading,
          along: 120, across: 35, chunks: 10, slickR0: 55,
          vx: this.vx || 0, vz: this.vz || 0, born: ctx.time,
          burning: this.fires.length > 0, // v1.5.0 D12: burning slick
        });
        for (let i = 0; i < 4; i++) {
          const s = ctx.vfx.spawnSprite(this.x + (Math.random() - 0.5) * 100, this.impactY + 1, this.z + (Math.random() - 0.5) * 100, 4, 12, 12, 0.1, 0x3a2a1a, 0.7);
          s.vx = (Math.random() - 0.5) * 2; s.vz = (Math.random() - 0.5) * 2;
        }
        if (ctx.onCarrierLost) ctx.onCarrierLost(this);
      }
    }
    // v1.5.0 D9: re-aim the core clip planes every frame (same rule as
    // BreakupPiece.refreshClipPlanes — the planes live in local space
    // and the group moves/turns under them).
    if (this._coreClipMats && this._coreClipMats.length && this.state !== 'gone') {
      this.group.updateMatrix();
      this.group.matrixWorld.copy(this.group.matrix);
      for (const m of this._coreClipMats) {
        const locals = m.userData.clipLocals;
        if (!locals) continue;
        for (let i = 0; i < locals.length; i++) m.clippingPlanes[i].copy(locals[i]).applyMatrix4(this.group.matrixWorld);
      }
    }
  }
}

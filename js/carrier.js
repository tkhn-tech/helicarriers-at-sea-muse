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
  TAU_VY: 5.0, // s — vertical speed chases the climb command
  ALT_HOLD_CAP_UP: 6, ALT_HOLD_CAP_DN: -5, // m/s (was +15/-10)
  LIFT_HOVER: 1 / 1.45, // 0.69 — hover threshold, re-anchored from 0.60
  THROTTLE_CLIMB: 8, // m/s climb per unit lift excess over hover (throttle)
};
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
  return pts;
}
function addSectionCap(group, zc, islBox, opts = {}) {
  const pts = jaggedFracturePath(opts.seed || 1, zc, opts.hitLx || 0);
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
  if (islBox && zc >= islBox.min.z && zc <= islBox.max.z) {
    const islTop = islandTopYAt(zc, islBox);
    const ix0 = islBox.min.x, ix1 = islBox.max.x;
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
  const pts = jaggedFracturePath((opts.seed || 1) + 31, zc, opts.hitLx || 0);
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
  // --- Island detail (bbox-measured from island_6 — the STL island
  // is a wedge rising toward the stern, so every fitting sits ON its
  // surface via islandTopYAt(), never at a bbox corner in mid-air.
  // The bridge windows lie on the upper ramp like a raked bridge face;
  // the mast and radar stand on the stern ridge (the island's top);
  // the nav lights sit on the upper ramp, not on the bbox corners.) ---
  let islandBox = null;
  group.traverse(o => {
    if (o.isMesh && o.name === 'island_6') islandBox = new THREE.Box3().setFromObject(o);
  });
  if (!islandBox) {
    group.traverse(o => {
      if (o.isMesh && o.name.startsWith('island_')) {
        const b = new THREE.Box3().setFromObject(o);
        islandBox = islandBox ? islandBox.union(b) : b;
      }
    });
  }
  if (islandBox) {
    const cx = (islandBox.min.x + islandBox.max.x) / 2;
    const cz = (islandBox.min.z + islandBox.max.z) / 2;
    const iw = islandBox.max.x - islandBox.min.x;
    const topY = islandBox.max.y;
    const ridgeZ = islandBox.max.z - 6; // stern ridge, the island's top
    const ridgeY = islandTopYAt(ridgeZ, islandBox);
    // Bridge windows: lit band lying on the upper ramp (tilted to the
    // ramp's slope), near the top of the wedge.
    const winZ = islandBox.min.z + 0.72 * (islandBox.max.z - islandBox.min.z);
    const winSlope = (islandTopYAt(winZ + 4, islandBox) - islandTopYAt(winZ - 4, islandBox)) / 8;
    const win = dbox(iw * 0.8, 0.3, 6, DM.windowGlow, cx, islandTopYAt(winZ, islandBox) + 0.35, winZ);
    win.rotation.x = -Math.atan(winSlope);
    win.name = 'islandBridgeWindows';
    group.add(win);
    // Mast + spinning radar bar (Hurricane: radar bar on the tower),
    // standing on the stern ridge.
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 9, 8), DM.darkMark);
    mast.position.set(cx, ridgeY + 4.5, ridgeZ);
    mast.name = 'islandMast';
    group.add(mast);
    const radar = new THREE.Group();
    radar.position.set(cx, ridgeY + 9.5, ridgeZ);
    radar.name = 'islandRadar';
    radar.add(dbox(9, 0.7, 1.1, DM.lightGrey, 0, 0, 0));
    radar.add(dbox(1.2, 2.2, 1.2, DM.hubMetal, 0, -1, 0));
    group.add(radar);
    // Nav lights: red port, green starboard, on the upper ramp.
    const navZ = islandBox.min.z + 0.85 * (islandBox.max.z - islandBox.min.z);
    for (const [sx, mat] of [[-1, DM.redNav], [1, DM.greenNav]]) {
      const nav = new THREE.Mesh(new THREE.SphereGeometry(1.1, 10, 8), mat);
      nav.position.set(cx + sx * (iw / 2 - 2), islandTopYAt(navZ, islandBox) + 0.8, navZ);
      nav.name = sx < 0 ? 'islandNavPort' : 'islandNavStbd';
      group.add(nav);
    }
    // Antenna whips, standing on the upper ramp.
    for (const [ax, az] of [[-iw / 3, -6], [iw / 3, 6]]) {
      const azz = ridgeZ + az;
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.3, 7, 6), DM.darkMark);
      ant.position.set(cx + ax, islandTopYAt(azz, islandBox) + 3.5, azz);
      ant.name = 'islandAntenna';
      group.add(ant);
    }
    // Island panel line: a dark break across the upper ramp, tilted
    // with the surface.
    const plZ = islandBox.min.z + 0.45 * (islandBox.max.z - islandBox.min.z);
    const plSlope = (islandTopYAt(plZ + 4, islandBox) - islandTopYAt(plZ - 4, islandBox)) / 8;
    const pl = dbox(iw * 0.9, 0.3, 0.6, DM.darkMark, cx, islandTopYAt(plZ, islandBox) + 0.25, plZ);
    pl.rotation.x = -Math.atan(plSlope);
    pl.name = 'islandPanelLine';
    group.add(pl);
  }
  // --- Duct caps + rotor blur discs (one per pod) ---
  // The STL pods are real ducted housings with real fans; no sponson
  // plates, no stern exhausts, no rub strips are needed — the STL
  // already has those shapes. A full-radius dark disc just below each
  // fan closes the see-through path through the blade gaps (the fan
  // reads dark between blades from above, and the duct reads closed
  // from below). The blur disc strengthens with rotor speed so a fast
  // fan reads as a blur, not a frozen star.
  podLocals.forEach((p, i) => {
    const r = p.r || 19;
    // Duct cap disc: full-radius, just below the fan plane, inside the
    // STL duct. Double-sided (ductDark is), so it reads dark from above
    // through the blade gaps and closes the duct from below.
    const cap = new THREE.Mesh(new THREE.CircleGeometry(r * 0.98, 28), DM.ductDark);
    cap.rotation.x = -Math.PI / 2;
    cap.position.set(p.x, p.y - 5, p.z);
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
// rotorSpin_* fan meshes, and the fans are re-centred so they spin in
// place (their geometry is in ship coords; rotating the mesh about Y
// would otherwise swing the fan around the ship's centre).
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
  fans.forEach((f, i) => {
    // Re-centre the fan on its own centre: translate the geometry so
    // the fan centre is the mesh origin, then place the mesh there.
    // After this, rotation.y (set every frame by the rotor spool)
    // spins the fan in place instead of orbiting it around the ship.
    f.mesh.geometry.translate(-f.x, -f.y, -f.z);
    f.mesh.position.set(f.x, f.y, f.z);
    f.mesh.name = 'rotorSpin_' + i;
    podLocals.push({ x: f.x, y: f.y, z: f.z, r: f.r });
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
    scene.add(group);
  }
  // v1.4.0 mass (audit F4/F11 + research §4.3): terminal velocity
  // breathes with attitude — flat-falling ≈36 m/s, nose-down ≈54 m/s.
  pieceVt() { return 45 * (0.8 + 0.4 * Math.abs(Math.cos(this.pitch || 0))); }
  // Cut-face world position (cap centroid), for venting/shedding.
  cutFaceWorld(i, out) {
    const f = this.cutFaces[i % this.cutFaces.length];
    this.group.updateWorldMatrix(true, false);
    return out.set(f.lx, f.ly, f.lz).applyMatrix4(this.group.matrixWorld);
  }
  update(dt, ctx) {
    if (this.state === 'falling') {
      const vt = this.pieceVt();
      this.vy += (-vt - this.vy) * Math.min(1, dt / 2.5);
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
      this.roll += this.rollRate * dt; this.pitch += this.pitchRate * dt; this.heading += this.yawRate * dt;
      this.group.position.y = this.y;
      this.group.rotation.set(this.pitch, -this.heading, this.roll);
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
      // Cut-face venting (research §5): detonation cuts vent flame +
      // smoke for the first 10 s after release, structural cuts smoke
      // only; one emission per face per 0.5 s, pool-guarded (never
      // assume a spawn survives; halve the rate under pool pressure).
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
              const sm = ctx.vfx.spawnSprite(w.x, w.y + 2, w.z, 2.5, 14, 14, 1, 0x141414, 0.55);
              sm.vy = 2;
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
      const seaH = ctx.sea.waveHeight(this.group.position.x, this.group.position.z, ctx.time);
      if (this.y <= seaH + 1) {
        this.state = 'sinking'; this.sinkT = 0; this.impactY = seaH;
        this.impactRoll = this.roll;
        // v1.4.0: a piece that hits nose-first gains a one-off pitch
        // kick toward its heavy end (research §4.2).
        if (Math.abs(this.pitch) > 0.15) this.pitchRate += Math.sign(this.pitch) * 0.15;
        ctx.vfx.splash(this.group.position.x, seaH, this.group.position.z, Math.abs(this.vy));
        ctx.vfx.burst(this.group.position.x, seaH + 2, this.group.position.z, 30, [0.9, 0.9, 0.9], 8, 6);
      }
    } else if (this.state === 'sinking') {
      this.sinkT += dt / this.sinkDur;
      const f = Math.min(1, this.sinkT);
      this.group.position.y = this.impactY - f * f * 55;
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
      this.bubbleT -= dt;
      if (this.bubbleT <= 0) { this.bubbleT = 0.12; ctx.vfx.bubbles(this.group.position.x, this.impactY, this.group.position.z, 4, 60); }
      this.boilT -= dt;
      if (this.boilT <= 0 && f > 0.1 && f < 0.9) { this.boilT = 0.4; ctx.vfx.boil(this.group.position.x, this.impactY, this.group.position.z, 40); }
      if (f >= 1) {
        this.state = 'gone'; this.group.visible = false;
        // v1.4.0 (item 6): the piece leaves floating wreckage where it
        // sank — 4 scorched chunks + an oil slick that persist for the
        // rest of the round (see js/wreckage.js). Guarded: hand-built
        // ctx objects in probes may not carry a wreckage field.
        if (ctx.wreckage) ctx.wreckage.spawn(this.group.position.x, this.group.position.z, {
          name: (this.carrierName || 'piece') + '-piece', heading: this.heading,
          along: Math.max(20, (this.segLen || 60) * 0.4), across: 20,
          chunks: 4, slickR0: 22, vx: this.vx, vz: this.vz, born: ctx.time,
        });
      }
    }
    // v1.3.2: re-aim the cut planes every frame (see refreshClipPlanes).
    if (this.state !== 'gone') this.refreshClipPlanes();
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
  get gone() { return this.state === 'gone'; }
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
    this.state = 'alive'; // alive | falling | sinking | gone
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
    this._brkSeq = 0; this._hitSeq = 0; this._lastBlastKey = null;
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
      rotorSpin: null, blur: null, spinRate: 0, spinAngle: 0,
      // v1.4.0: diagonal pairs spin the same way, adjacent pods
      // counter-rotate (quadcopter-style). Pod order is sorted by
      // (z, x), so the old index rule (i===0||i===3) pairs the WRONG
      // diagonals on this model; sign(x*z) pairs them correctly:
      // (port-bow, stbd-stern) share a sign, (stbd-bow, port-stern)
      // share the other.
      spinDir: Math.sign(p.x * p.z) || 1,
    }));
    this._assignPodMeshes();
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
  // the delta. Coefficient 0.35 -> 0.06 and total Δv capped at 3 m/s
  // per event: a neighbour at 100 m gets ≤ ~1.5 m/s, a heavy slide,
  // not a 75 km/h shove.
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
      const addV = fall * 0.06;
      if (applied + addV > 3) fall = Math.max(0, (3 - applied) / 0.06);
      this._blastVByKey[key] = Math.min(3, applied + fall * 0.06);
    }
    const nx = dx / d, nz = dz / d;
    this.blastVx += nx * fall * 0.06;
    this.blastVz += nz * fall * 0.06;
    const lat = dx * Math.cos(this.heading) + dz * Math.sin(this.heading);
    this.heelKick -= Math.sign(lat || 1) * 0.1 * Math.min(1, fall / 6);
    this.blastYaw += (Math.random() - 0.5) * 0.05 * Math.min(1, fall / 6);
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
      if (pod.hp <= 0 && pod.alive) {
        pod.alive = false;
        pod.meshes.forEach(m => { m.visible = false; });
        ctx.vfx.burst(wp.x, wp.y, wp.z, 40, [1, 0.6, 0.2], 10, 6);
        this.ignite('pod:' + this.pods.indexOf(pod), lx, lz, amount / 20, ctx);
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
  ignite(zoneKey, lx, lz, severity = 1, ctx) {
    if (this.fires.some(f => f.zone === zoneKey)) return;
    if (this.fires.length >= 6) return; // one fire per zone, max 6 concurrent
    // v1.2.0: fire severity rides along for the visuals (flame/smoke
    // size by zone and hit strength). The HP drain stays exactly as
    // before — intensity still starts at 0.5 and grows at the same rate.
    this.fires.push({ zone: zoneKey, lx, lz, intensity: 0.5, t: 0, sev: Math.max(0.5, Math.min(2, severity)), cookT: 2 + Math.random() * 2 });
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
    if (this.breakState !== 'none' || this.state === 'gone') return;
    // v1.2.0: explosions scale with what blew up — a reactor breach is
    // bigger and more violent than a magazine hit, which is bigger than
    // a deck hit. (Damage amounts and detonation gates are unchanged.)
    // v1.3.1: also scaled by the killing blow's severity, plus a debris
    // smoke ring thrown outward from the blast.
    const scale = zoneKey === 'reactor' ? 1.35 : zoneKey === 'magazine' ? 1.2 : 1;
    const sev = Math.max(0.6, Math.min(2, (this.lastHit ? this.lastHit.amount : 30) / 40));
    ctx.vfx.magazineSecondary(this.x, this.y, this.z, CARRIER_LEN / 42 * scale * (0.8 + 0.2 * sev));
    ctx.vfx.burst(this.x, this.y, this.z, Math.round(40 * scale), [0.9, 0.9, 0.9], 12, 8);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.random() * 0.5;
      const s = ctx.vfx.spawnSprite(this.x + Math.cos(a) * 40, this.y + 4, this.z + Math.sin(a) * 40, 4, 18, 18, 0.4, 0x1a1a1a, 0.6);
      s.vx = Math.cos(a) * 8; s.vz = Math.sin(a) * 8; s.vy = 1;
    }
    if (ctx.audio) ctx.audio.boom(true);
    if (ctx.noteDetonation) ctx.noteDetonation(this.x, this.y, this.z, 'detonation');
    // v1.4.0 F8: the same event key as the damage() blast above, so
    // the detonation does not stack a second impulse on top of it.
    if (ctx.carriers) {
      const bkey = this._lastBlastKey || `det:${this.id}:${++this._brkSeq}`;
      for (const c of ctx.carriers) if (c !== this) c.blastImpulse(this.x, this.z, 60 * scale, bkey);
    }
    ctx.msg(`${this.name}: ${zoneKey === 'reactor' ? 'REACTOR' : 'MAGAZINE'} DETONATION`);
    this.breakUp(ctx, 'detonation');
  }
  startFall(ctx, reason) {
    if (this.state !== 'alive') return;
    this.state = 'falling';
    this.fallT = 0;
    this.vy = 0;
    // Solidity (v1.4.0): a falling carrier is NOT frozen in place any
    // more — she keeps the horizontal velocity she had when lift failed
    // (forward speed at the kill), decaying slowly, so a falling hull
    // is a moving obstacle and can meet another carrier mid-fall
    // instead of only ever colliding as a stationary object. The old
    // frozen fall is gone; water-impact position follows the drift.
    this.fallVx = this.vx || 0;
    this.fallVz = this.vz || 0;
    this.fallStartAlt = this.y; this.lastImpact = null; this.lastBreakup = null;
    const deadX = this.pods.filter(p => !p.alive).reduce((a, p) => a + p.local.x, 0);
    // v1.4.0 mass (audit §1): falling-hull attitude rates are capped —
    // roll ≤0.05, pitch ≤0.03, yaw ≤0.02 rad/s — and decay τ≈10 s in
    // freefall (no torque in freefall). A 120,000 t hull does not
    // cartwheel on the way down.
    this.fallRollRate = Math.max(-0.05, Math.min(0.05, (deadX >= 0 ? 1 : -1) * (0.03 + 0.02 * (1 - this.lift)) + (Math.random() - 0.5) * 0.02));
    this.fallPitchRate = Math.max(-0.03, Math.min(0.03, (Math.random() - 0.5) * 0.04));
    this.fallYawRate = Math.max(-0.02, Math.min(0.02, (Math.random() - 0.5) * 0.03));
    ctx.msg(`${this.name} is FALLING — ${reason}`);
    if (this.wing) this.wing.handleCarrierFalling(ctx);
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
    if (this.state === 'gone' || this.breakState !== 'none') return;
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
    const cutOff = hitAlong * 55; // first cut through the hit
    const cuts = [cutOff];
    // Extra cuts: alternate sides of the hit at growing radii (58 m,
    // then 104 m each side), jittered — so every cut lands ≥35 m from
    // the others and the piece sizes genuinely vary. (A single fixed
    // spread radius could only ever place one cut per side, capping
    // every violent kill at 4 pieces no matter the energy.)
    const radii = [58, 104];
    let sideSign = Math.random() < 0.5 ? 1 : -1;
    for (let i = 1; i < nCuts; i++) {
      const radius = radii[Math.floor((i - 1) / 2)] || 145;
      const cand = cutOff + sideSign * (radius + (Math.random() - 0.5) * 8);
      sideSign = -sideSign;
      if (cand < -150 || cand > 150) continue;
      if (cuts.some(c => Math.abs(c - cand) < 35)) continue;
      cuts.push(cand);
    }
    cuts.sort((a, b) => a - b);
    const bounds = [-CARRIER_LEN / 2, ...cuts, CARRIER_LEN / 2];
    const segments = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      segments.push({ lo: bounds[i], hi: bounds[i + 1], centre: (bounds[i] + bounds[i + 1]) / 2 });
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
    this.lastBreakup = { reason, pieces: segments.length, energy: +energy.toFixed(2), cuts: cuts.map(c => +c.toFixed(0)), hitZone: hit.zone, hitAmount: hit.amount, alt: +hit.alt.toFixed(0), speed: +hit.speed.toFixed(1) };
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
    // Schedule: releases nearest the blast/hit first (tension side
    // leaves first), staggered; cracks start staggered the same way.
    const isDet = reason === 'detonation';
    const isWater = reason === 'water impact';
    const stagger = isDet ? 0.15 : isWater ? 0.10 : 0.35;
    const crackDur = isDet ? 0.6 : isWater ? 0.4 : 1.2;
    const releaseStart = isDet ? 0.9 : isWater ? 0.6 : 1.6;
    const hingeStart = isDet ? 0.5 : isWater ? 0.3 : 0.8;
    const hingeEnd = isDet ? 1.1 : isWater ? 0.7 : 2.0;
    const hingeDeg = isDet ? 6 + Math.random() * 2 : isWater ? 4 : 3 + Math.random() * 2;
    const order = segments.map((s, i) => i).sort((a, b) => Math.abs(segments[a].centre - cutOff) - Math.abs(segments[b].centre - cutOff));
    order.forEach((segIdx, k) => { segments[segIdx].releaseAt = releaseStart + k * stagger; });
    this._breakPlan = {
      reason, energy, severity, speedF, cuts, cutOff, hit, islBox,
      segments, fallVy, fwd: { x: Math.sin(this.heading), z: -Math.cos(this.heading) },
      impactVx: opts.impactVx || 0, impactVz: opts.impactVz || 0,
      stagger, crackDur, hingeStart, hingeEnd,
      hingeTarget: hingeDeg * Math.PI / 180 * (hit.lx >= 0 ? 1 : -1),
      hingeMax: 0,
    };
    this._breakCtx = ctx;
    this.breakState = 'cracking';
    this.breakT = 0; this.breakHinge = 0; this._breakReleased = 0;
    this._breakFirstReleased = false;
    // Crack ribbons (§2.4): one jagged dark ribbon per cut, growing
    // around the hull cross-section from the hit — the same seeded path
    // the cap will show. Removed when the last piece releases.
    this._crackRibbons = cuts.map((cut, ci) => {
      const zc = -cut; // d -> local z
      const path = jaggedFracturePath(fracSeed(this.id, ci, hit.lz), zc, hit.lx);
      const pts3 = path.map(p => new THREE.Vector3(p.x, p.y, zc));
      pts3.push(pts3[0].clone());
      const geo = new THREE.BufferGeometry().setFromPoints(pts3);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x0a0a0a }));
      line.geometry.setDrawRange(0, 0);
      line.name = 'crackRibbon';
      line.frustumCulled = false;
      this.group.add(line);
      return { line, nPts: pts3.length, startAt: ci * stagger, dur: crackDur, tipT: 0 };
    });
    ctx.msg(`${this.name} is breaking apart (${reason}) — ${segments.length} pieces`);
  }
  // Drive phases 1–3 on the intact group; called from update() while
  // breakState !== 'none'. Returns true once the breakup is complete
  // (state now 'gone').
  updateBreakup(dt, ctx) {
    const plan = this._breakPlan;
    if (!plan) { this.breakState = 'none'; return false; }
    this.breakT += dt;
    const t = this.breakT;
    // Phase 1 — crack propagation: each ribbon grows from the hit
    // around the cross-section; a smoke wisp rides the moving tip.
    for (const r of this._crackRibbons) {
      const prog = Math.max(0, Math.min(1, (t - r.startAt) / r.dur));
      r.line.geometry.setDrawRange(0, Math.max(0, Math.floor(prog * r.nPts)));
      r.tipT -= dt;
      if (prog > 0 && prog < 1 && r.tipT <= 0) {
        r.tipT = 0.15;
        const idx = Math.max(0, Math.min(r.nPts - 1, Math.floor(prog * r.nPts)));
        const lp = r.line.geometry.attributes.position;
        const wp = this.group.localToWorld(new THREE.Vector3(lp.getX(idx), lp.getY(idx), lp.getZ(idx)));
        ctx.vfx.spawnSprite(wp.x, wp.y, wp.z, 0.3, 6, 6, 1, 0x141414, 0.5);
      }
    }
    // Phase 2 — hinge: 0 -> target over [hingeStart, hingeEnd].
    if (t >= plan.hingeStart) {
      const hp = Math.max(0, Math.min(1, (t - plan.hingeStart) / (plan.hingeEnd - plan.hingeStart)));
      this.breakHinge = plan.hingeTarget * hp * hp * (3 - 2 * hp);
      plan.hingeMax = Math.max(plan.hingeMax, Math.abs(this.breakHinge));
      if (this.breakState === 'cracking') this.breakState = 'hinging';
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
    for (const seg of plan.segments) {
      if (seg.released) continue;
      if (!seaRelease && t < seg.releaseAt) continue;
      seg.released = true;
      seg.releaseBreakT = this.breakT; // exact in-game release time (probe hinge/stagger proof)
      this._separatePiece(ctx, seg);
      released = true;
    }
    if (released && !this._breakFirstReleased) {
      this._breakFirstReleased = true;
      // The ship is lost when it STARTS coming apart, not when the
      // last piece lets go.
      if (this.wing) this.wing.handleCarrierFalling(ctx);
      if (ctx.onCarrierLost) ctx.onCarrierLost(this);
      ctx.msg(`${this.name} broke up (${plan.reason}) — ${plan.segments.length} pieces falling`);
    }
    if (this._breakReleased >= plan.segments.length) {
      for (const r of this._crackRibbons) this.group.remove(r.line);
      this._crackRibbons = [];
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
    return false;
  }
  // Phase 4 — one segment becomes a free BreakupPiece (the old mkPiece
  // loop, refactored to a per-segment call). Cut planes live in the
  // piece's LOCAL space and are re-aimed every frame (v1.3.2).
  _separatePiece(ctx, seg) {
    const plan = this._breakPlan;
    const { lo, hi, centre: segCentre } = seg;
    const { severity, speedF, cutOff, hit, islBox, reason } = plan;
    const segIdx = plan.segments.indexOf(seg);
    const locals = [];
    if (lo > -CARRIER_LEN / 2 + 1) locals.push(new THREE.Plane(new THREE.Vector3(0, 0, -1), -lo)); // keep z <= -lo
    if (hi < CARRIER_LEN / 2 - 1) locals.push(new THREE.Plane(new THREE.Vector3(0, 0, 1), hi));    // keep z >= -hi
    const clone = this.group.clone(true);
    // Crack ribbons belong to the intact group, not to a piece clone.
    const ribbons = [];
    clone.traverse(o => { if (o.name === 'crackRibbon') ribbons.push(o); });
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
    const capMeshes = [];
    const petalGroups = [];
    const cutFaces = [];
    const tensionSide = hit.pitch >= 0 ? 'top' : 'bottom';
    if (lo > -CARRIER_LEN / 2 + 1) {
      const cap = addSectionCap(clone, -lo, islBox, { seed: fracSeed(this.id, segIdx * 2, hit.lz), hot: reason === 'detonation', hitLx: hit.lx });
      if (cap) capMeshes.push(cap);
      petalGroups.push(addTornPetals(clone, -lo, +1, { seed: fracSeed(this.id, segIdx * 2, hit.lz), hot: reason === 'detonation', hitLx: hit.lx, tensionSide, detonation: reason === 'detonation' }));
      cutFaces.push({ lx: 0, ly: deckLocalYAt(-lo), lz: -lo });
    }
    if (hi < CARRIER_LEN / 2 - 1) {
      const cap = addSectionCap(clone, -hi, islBox, { seed: fracSeed(this.id, segIdx * 2 + 1, hit.lz), hot: reason === 'detonation', hitLx: hit.lx });
      if (cap) capMeshes.push(cap);
      petalGroups.push(addTornPetals(clone, -hi, -1, { seed: fracSeed(this.id, segIdx * 2 + 1, hit.lz), hot: reason === 'detonation', hitLx: hit.lx, tensionSide, detonation: reason === 'detonation' }));
      cutFaces.push({ lx: 0, ly: deckLocalYAt(-hi), lz: -hi });
    }
    clone.position.set(this.x, this.y, this.z);
    clone.rotation.set(this.pitch, -this.heading, this.roll + this.breakHinge);
    // v1.4.0 mass (audit F4 + research §4.2): tumble comes from the
    // off-centre blast/hinge geometry, not coin flips — and is capped
    // by piece size: ω_roll ≤ 21/L rad/s (a 60 m piece ≤ 0.35 rad/s,
    // 20°/s; a 150 m half-ship ≤ 0.14 rad/s), pitch/yaw ≤ half that.
    // Nearest-blast pieces tumble fastest. Rates decay τ=8 s in air
    // (BreakupPiece.update); they never increase after release except
    // for the water-impact pitch kick.
    const rng = mulberry32(fracSeed(this.id, segIdx, hit.lz) + 991);
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
    // Radial-outward component for detonation: away from the blast
    // point in the horizontal plane (here approximated by the
    // along-hull away direction + the lateral term above).
    const rx = -fwd.z, rz = fwd.x; // hull-right in XZ
    let vx = (this.vx || 0) + plan.impactVx + fwd.x * away * along + rx * lat;
    let vz = (this.vz || 0) + plan.impactVz + fwd.z * away * along + rz * lat;
    const hSpeed = Math.hypot(vx, vz);
    if (hSpeed > 25) { vx *= 25 / hSpeed; vz *= 25 / hSpeed; }
    const piece = new BreakupPiece(ctx.scene, clone, plan.fallVy + up,
      rollRate, pitchRate, yawRate, vx, vz);
    piece.clipMats = clipMats;
    piece.segLen = hi - lo; // v1.4.0 (item 6): wreckage field size
    piece.segLo = lo; piece.segHi = hi; piece.segCentre = segCentre; // solidity: real section bounds (collisions.js)
    piece.carrierName = this.name;
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
    piece.bornT = ctx.time || 0;
    // v1.4.0 mass (audit F11): sinking duration from size —
    // v_max = 3.5·√(60/segLen) m/s, clamped 2–6 m/s, so a 150 m
    // half-ship sinks slower than a 20 m fragment.
    const vMaxPiece = Math.max(2, Math.min(6, 3.5 * Math.sqrt(60 / L)));
    piece.sinkDur = 110 / vMaxPiece; // max descent rate = 2·55/dur
    piece.refreshClipPlanes(); // aim the planes before the first frame
    this.pieces.push(piece);
    this._breakReleased++;
  }
  update(dt, ctx) {
    // Breakup pieces always update.
    for (const p of this.pieces) p.update(dt, ctx);
    this.pieces = this.pieces.filter(p => !p.gone);
    // v1.4.0 progressive breakup: drive phases 1–3 on the intact
    // group while it is coming apart; updateBreakup() returns true
    // once the last piece has released (state now 'gone').
    if (this.breakState !== 'none') {
      if (this.updateBreakup(dt, ctx)) return;
    }
    if (this.state === 'gone') return;
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
      const demand = (this.state === 'sinking' || this.state === 'gone') ? 0
        : Math.max(0, Math.min(1.15, this.throttle / Math.max(this.lift, 0.25) + 0.1 * (Math.abs(this.forwardSpeed) / 20) + (this.vy > 1 ? 0.05 : 0)));
      const target = pod.alive ? 30 * demand : 0;
      pod.spinRate += (target - pod.spinRate) * (1 - Math.exp(-dt / PHYSICS.ROTOR_SPOOL_TAU)); // spool lag
      pod.spinAngle += pod.spinRate * dt * pod.spinDir;
      pod.rotorSpin.rotation.y = pod.spinAngle;
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
        if (pod && pod.alive) { pod.hp -= drain; if (pod.hp <= 0) { pod.alive = false; pod.meshes.forEach(m => { m.visible = false; }); if (this.lift <= 0) this.startFall(ctx, 'last lift pod burned out'); } }
      } else {
        const z = this.zones[f.zone];
        if (z) { z.hp = Math.max(0, z.hp - drain); if (z.hp <= 0 && f.zone === 'reactor') { this.detonate(ctx, 'reactor'); return; } }
      }
      if (this.fireT <= 0) {
        const wp = this.deckPoint(f.lx, f.lz);
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
        const smokeCol = burnFrac > 0.5 ? 0x0a0a0a : (f.zone === 'reactor' || f.zone === 'magazine' ? 0x241812 : 0x141414);
        const sm = ctx.vfx.spawnSprite(wp.x, wp.y + 8, wp.z, 3.5, (8 + f.intensity * 4 + burnFrac * 6) * visScale, (8 + f.intensity * 4 + burnFrac * 6) * visScale, 0.5,
          smokeCol, 0.6);
        sm.vy = 3;
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
      sm.vy = 2.5;
      if (this.hpFrac < 0.4) {
        // Thicker smoke + embers below 40%.
        const sm2 = ctx.vfx.spawnSprite(wp.x, wp.y + 10, wp.z, 3.5, 16, 16, 0.5, 0x141414, 0.65);
        sm2.vy = 3;
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
      const listTarget = (1 - this.lift) * 0.12 * (deadX >= 0 ? 1 : -1);
      this.list += (listTarget - this.list) * Math.min(1, dt * 0.5);
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
      // v1.4.0 climb — one unified lift model (spec §2.1/§7.4):
      // throttle is a TOTAL lift demand, shared over the surviving
      // fans up to their combined 1.45xW max. liftThrust is the lift
      // actually produced as a fraction of weight; the excess over
      // weight climbs (or sinks) at 8 m/s per unit. Pitch climb
      // authority scales with the REMAINING lift margin: full lift ->
      // full 6 m/s; 3 pods (margin 8.75%) -> ~1.2 m/s; <=2 pods -> no
      // margin, pitch cannot climb and the shortfall sinks the ship
      // (~2.3 m/s at lift 0.5, ~5.1 at 0.25) even at max throttle.
      // Pitch DOWN is not margin-limited (descending only needs less
      // lift, which is always available). The old separate sink term
      // ((0.69-lift)*12) double-counted this shortfall and is gone:
      // the excess term IS the sink. While pitch or throttle is
      // off hover, altitude hold is suspended and targetAlt tracks the
      // ship (hold resumes at the new altitude on release, as pitch
      // did in v1.2.0). At default throttle a 3-pod ship still holds
      // altitude (demand 1.0W is inside her 1.09W max); a 2-pod ship
      // cannot hover at any throttle (max 0.73W).
      let climb = 0;
      const dy = this.targetAlt - this.y;
      if (dy > 2) climb = Math.min(PHYSICS.ALT_HOLD_CAP_UP, dy * 0.2);
      else if (dy < -2) climb = Math.max(PHYSICS.ALT_HOLD_CAP_DN, dy * 0.2);
      const liftThrust = Math.min(this.throttle * PHYSICS.T_LIFT_MAX_RATIO, this.lift * PHYSICS.T_LIFT_MAX_RATIO);
      const liftExcess = liftThrust - 1;
      const throttleClimb = liftExcess * PHYSICS.THROTTLE_CLIMB;
      const marginFrac = Math.max(0, Math.min(1, (this.lift * PHYSICS.T_LIFT_MAX_RATIO - 1) / (PHYSICS.T_LIFT_MAX_RATIO - 1)));
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
        climb = Math.max(-PHYSICS.CLIMB_MAX, Math.min(PHYSICS.CLIMB_MAX, pitchClimbM + throttleClimb));
        this.targetAlt = this.y; // hold resumes here when pitch/throttle releases
      }
      // Pitch alone can never drive her into the sea or above the ceiling.
      if (this.y <= ALT_FLOOR && climb < 0) climb = 0;
      if (this.y >= ALT_CEIL && climb > 0) climb = 0;
      // v1.4.0: one lag shape everywhere — first-order, tau named per
      // lag (spec §12.4). vy chases the climb command with TAU_VY 5 s.
      this.vy += (climb - this.vy) * (1 - Math.exp(-dt / PHYSICS.TAU_VY));
      this.y += this.vy * dt;
      this.y = Math.max(120, Math.min(650, this.y));
      // Hard altitude stops: pitch can ease the carrier down to the
      // floor, but never through it (and never above the ceiling) —
      // residual downward velocity is killed at the stop, so there is
      // no overshoot below it.
      if (this.y <= ALT_FLOOR) { this.y = ALT_FLOOR; if (this.vy < 0) this.vy = 0; }
      if (this.y >= ALT_CEIL) { this.y = ALT_CEIL; if (this.vy > 0) this.vy = 0; }
      this.group.position.set(this.x, this.y, this.z);
      this.group.rotation.set(this.pitch, -this.heading, this.roll + (this.breakHinge || 0));
    } else if (this.state === 'falling') {
      // GENUINE FREEFALL: drag toward terminal velocity from mass and
      // remaining lift, attitude from asymmetric lift loss.
      // v1.4.0 mass (audit F14): the old code added gravity AND a drag
      // term chasing −vt, so the true terminal was −(vt + a·τ) = −64.5
      // m/s at lift 0, not the documented 40. vy now chases −vt with
      // τ=2.5 s and the terminal velocity IS vt as documented (40–70
      // m/s by lift) — consistent with breakup pieces (vt 36–54).
      this.fallT += dt;
      const vt = 40 + 30 * this.lift; // terminal velocity, m/s
      this.vy += (-vt - this.vy) * Math.min(1, dt / 2.5); // drag only
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
      this.group.rotation.set(this.pitch, -this.heading, this.roll + (this.breakHinge || 0));
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
        if (speed > 25 && this.y > seaH0 + 80 && Math.random() < stress * 0.05) { this.breakUp(ctx, 'stressed in the fall'); return; }
      }
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
        const frag = (impactSpeed / 65) * attF * (1.3 - 0.6 * this.hpFrac);
        const outcome = frag < 1.0 ? 'intact' : frag < 1.8 ? 'partial' : 'shatter';
        this.lastImpact = { speed: +impactSpeed.toFixed(1), pitch: +this.pitch.toFixed(2), roll: +rollW.toFixed(2), hpFrac: +this.hpFrac.toFixed(2), frag: +frag.toFixed(2), outcome };
        ctx.vfx.splash(this.x, seaH, this.z, impactSpeed);
        ctx.msg(`${this.name} hit the sea at ${impactSpeed.toFixed(0)} m/s — ${outcome === 'intact' ? 'staying intact' : outcome === 'partial' ? 'breaking apart' : 'shattering'}`);
        if (outcome !== 'intact') {
          const fwd = { x: Math.sin(this.heading), z: -Math.cos(this.heading) };
          const ivx = fwd.x * (this.forwardSpeed || 0) * 0.3, ivz = fwd.z * (this.forwardSpeed || 0) * 0.3;
          if (outcome === 'shatter') this.breakUp(ctx, 'water impact', { energy: 2.2 + frag * 0.5, impactVx: ivx, impactVz: ivz });
          else this.breakUp(ctx, 'water impact', { cuts: 1, energy: 1.4, impactVx: ivx, impactVz: ivz });
          return;
        }
        this.state = 'sinking';
        this.sinkT = 0;
        this.impactY = seaH;
        // v1.4.0 mass (audit F10): the final list comes from the
        // damage state (impact roll + damage list), not a constant.
        this.sinkRollTarget = Math.max(-0.6, Math.min(0.6, this.roll + this.list));
        this._sinkPrevY = this.y;
        if (this.wing) this.wing.handleCarrierSinking(ctx);
      }
    } else if (this.state === 'sinking') {
      // Hurricane sinking sequence (30 s quadratic descent), only AFTER
      // the wreck is in the water — the fall above was gravity, not this.
      // v1.4.0 mass (audit F10): the old branch eased roll to a fixed
      // 0.5 rad (28.6°) at τ=2 s and ignored the sea entirely, with a
      // stale vy of −62.7 m/s for the whole sinking. Now the list
      // develops at ≤0.035 rad/s (≈2°/s) toward the damage-derived
      // sinkRollTarget, the hull rides the swell while near the surface
      // (wave coupling fades as she goes down), and vy = dy/dt.
      this.sinkT += dt / 30;
      const f = Math.min(1, this.sinkT);
      const waveH = ctx.sea.waveHeight(this.x, this.z, ctx.time);
      const prevY = this.y;
      this.y = this.impactY - f * f * 55 + waveH * (1 - f) * 0.8;
      this.vy = dt > 0 ? (this.y - prevY) / dt : 0;
      const rollErr = this.sinkRollTarget - this.roll;
      this.roll += Math.max(-0.035 * dt, Math.min(0.035 * dt, rollErr));
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
        // v1.4.0 (item 6): instead of vanishing after ~30 s (the old
        // six life-30 dark sprites below), she leaves persistent
        // floating wreckage — debris chunks + an oil slick that drift
        // with the current for the rest of the round (js/wreckage.js).
        // The short smoke puffs stay as the final gasp only.
        if (ctx.wreckage) ctx.wreckage.spawn(this.x, this.z, {
          name: this.name, heading: this.heading,
          along: 120, across: 35, chunks: 10, slickR0: 55,
          vx: this.vx || 0, vz: this.vz || 0, born: ctx.time,
        });
        for (let i = 0; i < 4; i++) {
          const s = ctx.vfx.spawnSprite(this.x + (Math.random() - 0.5) * 100, this.impactY + 1, this.z + (Math.random() - 0.5) * 100, 4, 12, 12, 0.1, 0x3a2a1a, 0.7);
          s.vx = (Math.random() - 0.5) * 2; s.vz = (Math.random() - 0.5) * 2;
        }
        if (ctx.onCarrierLost) ctx.onCarrierLost(this);
      }
    }
  }
}

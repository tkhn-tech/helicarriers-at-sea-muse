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
// v1.2.0 pitch limits: ±12° (0.21 rad), eased at 0.5 rad/s. Pitch alone can
// never flip the carrier or drive her into the sea: climb from pitch is
// capped at ±14 m/s and hard-stopped at the altitude floor/ceiling below.
const PITCH_MAX = 0.21;
const PITCH_RATE = 0.5;
const ALT_FLOOR = 150;
const ALT_CEIL = 600;

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
    // v1.2.1 solidity backstop: every GLB shell renders double-sided,
    // so an open shell never vanishes from its back face and no
    // see-through path opens through a missing backface.
    if (o.isMesh && o.material) o.material.side = THREE.DoubleSide;
    // v1.2.0: the GLB's own rotor discs/hubs are retired — flat star
    // shapes in near-black RotorDark that read as static discs from
    // every angle (Nicholas's screenshot). Procedural rotors built in
    // buildCarrierDetail() replace them; hide the originals so they
    // never show through the new assembly.
    if (o.isMesh && (o.name.startsWith('rotor_disc_') || o.name.startsWith('rotor_hub_'))) o.visible = false;
  });
}

// v1.2.0 detail materials (shared across the template's clones).
// Hurricane palette: haze-grey verticals, deck-grey horizontals.
const DM = {
  deckGrey: new THREE.MeshStandardMaterial({ color: 0x3a4148, roughness: 0.85, metalness: 0.1 }),
  deckInfill: new THREE.MeshStandardMaterial({ color: 0x424a52, roughness: 0.85, metalness: 0.1 }),
  whiteMark: new THREE.MeshStandardMaterial({ color: 0xdfe9f2, roughness: 0.6, metalness: 0.05 }),
  yellowMark: new THREE.MeshStandardMaterial({ color: 0xffd166, roughness: 0.6, metalness: 0.05 }),
  darkMark: new THREE.MeshStandardMaterial({ color: 0x1c2833, roughness: 0.7, metalness: 0.2 }),
  gunmetal: new THREE.MeshStandardMaterial({ color: 0x4a4f55, roughness: 0.55, metalness: 0.5, side: THREE.DoubleSide }),
  ductDark: new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.7, metalness: 0.4, side: THREE.DoubleSide }),
  lightGrey: new THREE.MeshStandardMaterial({ color: 0x8a9aa8, roughness: 0.6, metalness: 0.3 }),
  blade: new THREE.MeshStandardMaterial({ color: 0x2e3238, roughness: 0.45, metalness: 0.65 }),
  bladeTip: new THREE.MeshStandardMaterial({ color: 0xffd166, roughness: 0.5, metalness: 0.2 }),
  hubMetal: new THREE.MeshStandardMaterial({ color: 0x6a6e73, roughness: 0.4, metalness: 0.6 }),
  windowGlow: new THREE.MeshStandardMaterial({ color: 0xffe9a8, emissive: 0xaa7711, emissiveIntensity: 0.9, roughness: 0.4 }),
  redNav: new THREE.MeshStandardMaterial({ color: 0xff4444, emissive: 0xaa1111, emissiveIntensity: 1.2 }),
  greenNav: new THREE.MeshStandardMaterial({ color: 0x44ff66, emissive: 0x11aa33, emissiveIntensity: 1.2 }),
  exhaustGlow: new THREE.MeshStandardMaterial({ color: 0xff7a1e, emissive: 0xcc4400, emissiveIntensity: 1.4 }),
  panelGrey: new THREE.MeshStandardMaterial({ color: 0x5a6a72, roughness: 0.7, metalness: 0.25 }),
  // v1.2.1: inner hull core + caps — haze grey like the GLB hull.
  hullCore: new THREE.MeshStandardMaterial({ color: 0x7e8b96, roughness: 0.7, metalness: 0.25, side: THREE.DoubleSide }),
  hullGrey: new THREE.MeshStandardMaterial({ color: 0x8a9aa8, roughness: 0.6, metalness: 0.3, side: THREE.DoubleSide }),
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

// v1.2.1 — closed inner hull core (Hurricane-style extruded planform,
// done here as a loft so the keel follows the GLB's own depth profile).
// Stations [z, halfWidth, keelY] measured from the GLB hull vertices,
// inset ~1.5 m inside the shell. Cross-section is a rounded-V ring
// closed across the top just under the deck, so the loft is a solid:
// sides, belly, bow/stern end caps, and a top face backing the deck.
const HULL_CORE_STATIONS = [
  [-166, 8, -6.5], [-150, 11, -10], [-130, 16, -16], [-110, 21, -19],
  [-90, 24.5, -21.5], [-70, 26.5, -22.5], [-50, 28.5, -22], [-30, 30.5, -20],
  [-10, 32, -16], [10, 33, -12], [30, 33.5, -7.5], [50, 33.5, -7],
  // Stern keel drops steeply past z 60 (centreline keel strip
  // detail_34 reaches y -30.9 at z 58..109; hull_2/4 flare to -32.8).
  [70, 34, -12], [80, 36, -29], [90, 38, -30], [110, 41, -30], [130, 44, -28],
  [150, 42, -24], [170, 30, -18], [184, 12, -10],
];
function hullCoreGeometry(topY) {
  const ringPts = (w, k) => {
    const midY = (topY + k) / 2;
    return [[-w, topY], [-w, midY], [-w * 0.55, k + 1.5], [0, k],
      [w * 0.55, k + 1.5], [w, midY], [w, topY]];
  };
  const pos = [], idx = [];
  const rings = HULL_CORE_STATIONS.map(([z, w, k]) => ({ z, pts: ringPts(w, k) }));
  rings.forEach(r => r.pts.forEach(([x, y]) => pos.push(x, y, r.z)));
  const N = 7;
  for (let s = 0; s < rings.length - 1; s++) {
    for (let i = 0; i < N; i++) {
      const a = s * N + i, b = s * N + (i + 1) % N;
      const c = (s + 1) * N + i, d = (s + 1) * N + (i + 1) % N;
      idx.push(a, c, b, b, c, d);
    }
  }
  // End caps: fan from each end ring's centroid.
  const capFan = (s, flip) => {
    const base = s * N;
    let cx = 0, cy = 0;
    for (let i = 0; i < N; i++) { cx += pos[(base + i) * 3]; cy += pos[(base + i) * 3 + 1]; }
    cx /= N; cy /= N;
    const cz = HULL_CORE_STATIONS[s][0];
    const ci = pos.length / 3; pos.push(cx, cy, cz);
    for (let i = 0; i < N; i++) {
      const a = base + i, b = base + (i + 1) % N;
      if (flip) idx.push(ci, b, a); else idx.push(ci, a, b);
    }
  };
  capFan(0, false); capFan(rings.length - 1, true);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// v1.3.2 — section caps: a torn-off piece must read as a solid part of
// one ship, not a hollow open shell. Interpolate the hull profile at a
// cut (local z) and cap the cross-section with a solid face.
function hullSectionAt(z) {
  const st = HULL_CORE_STATIONS;
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
function addSectionCap(group, zc, deckY, islBox) {
  const { w, k } = hullSectionAt(zc);
  const w2 = w + 1.5, k2 = k - 1; // GLB hull sits ~1.5 m outside the core
  const topY = deckY + 0.3;
  const midY = (topY + k2) / 2;
  const s = new THREE.Shape();
  s.moveTo(-w2, topY);
  s.lineTo(w2, topY);
  s.lineTo(w2, midY);
  s.lineTo(w2 * 0.55, k2 + 1.5);
  s.lineTo(0, k2);
  s.lineTo(-w2 * 0.55, k2 + 1.5);
  s.lineTo(-w2, midY);
  s.closePath();
  const cap = new THREE.Mesh(new THREE.ShapeGeometry(s), DM.capSteel);
  cap.position.set(0, 0, zc);
  cap.name = 'breakCap';
  group.add(cap);
  // Island cap: a solid rectangle where the cut passes through the tower.
  if (islBox && zc >= islBox.min.z && zc <= islBox.max.z) {
    const is = new THREE.Shape();
    is.moveTo(islBox.min.x, deckY);
    is.lineTo(islBox.max.x, deckY);
    is.lineTo(islBox.max.x, islBox.max.y);
    is.lineTo(islBox.min.x, islBox.max.y);
    is.closePath();
    const icap = new THREE.Mesh(new THREE.ShapeGeometry(is), DM.capSteel);
    icap.position.set(0, 0, zc);
    icap.name = 'breakCapIsland';
    group.add(icap);
  }
}

// v1.2.0 — procedural detail layered on the SHIELD GLB (template group,
// so every carrier clone inherits it). Sources: Hurricane Fleet's
// carrier construction (deck markings, Ford island, sponsons, nav
// lights) and Pandora's SHIELD pod layout (duct_ring_* centres).
//   1. Deck hole: the GLB deck is NOT continuous — hiding detail_7
//      leaves a long central trench (x ±18, z −82…+183) that shows
//      sky/sea straight through the ship (Nicholas's screenshot).
//      A full-width under-plate just below deck level plus a centre
//      infill strip flush with the deck close it for good.
//   2. Rotors: real 8-blade rotors inside deep ducted pods.
//   3. Deck markings, island bridge/mast/radar/lights, hull panelling,
//      stern engine exhausts.
function buildCarrierDetail(group, podLocals, deckLocalY, deckHalfX, deckHalfZ) {
  const dy = deckLocalY;
  // --- 1. Close the deck hole ---
  // v1.2.1: the under-plate now runs the full deck length (to the stern
  // tip, z 187) instead of stopping at z 160, so no stern-corner gap
  // remains past it.
  const under = dbox(deckHalfX * 2 + 2, 0.5, 322, DM.deckGrey, 0, dy - 0.35, 26);
  under.name = 'deckUnderPlate';
  group.add(under);
  const infill = dbox(38, 0.5, 268, DM.deckInfill, 0, dy - 0.05, 50);
  infill.name = 'deckInfill';
  group.add(infill);
  // --- Deck markings (Hurricane carrier: edge lines, centreline dashes,
  // 9° angled landing strip, arrestor wires, catapult tracks, touchdown ring) ---
  const my = dy + 0.35;
  for (const sx of [-1, 1]) group.add(dbox(0.6, 0.12, 270, DM.whiteMark, sx * 33, my, 15));
  for (let i = 0; i < 12; i++) group.add(dbox(0.9, 0.12, 7, DM.whiteMark, 0, my, -120 + i * 22));
  group.add(dbox(2.2, 0.12, 150, DM.yellowMark, -16, my, 45, 0.157));
  for (const wz of [55, 65, 75]) group.add(dbox(26, 0.1, 0.5, DM.whiteMark, -13, my + 0.03, wz, 0.157));
  for (const sx of [-1, 1]) group.add(dbox(0.8, 0.12, 65, DM.darkMark, sx * 8, my, -85));
  const ring = new THREE.Mesh(new THREE.RingGeometry(11, 13.5, 32),
    new THREE.MeshBasicMaterial({ color: 0xdfe9f2, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(0, my + 0.07, 105);
  ring.name = 'deckTouchdownRing';
  group.add(ring);
  // --- Island detail (bbox-measured from the TALL tower island_6
  // alone — the union with island_23 is wider and reaches further
  // forward, so details based on the union float in mid-air beside
  // the tower instead of sitting on it) ---
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
    const bowZ = islandBox.min.z; // bow face (-Z)
    // Bridge windows: lit band across the bow face, near the top.
    const win = dbox(iw * 0.8, 2.2, 0.6, DM.windowGlow, cx, topY - 6, bowZ - 0.2);
    win.name = 'islandBridgeWindows';
    group.add(win);
    // Mast + spinning radar bar (Hurricane: radar bar on the tower).
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 9, 8), DM.darkMark);
    mast.position.set(cx, topY + 4.5, cz);
    mast.name = 'islandMast';
    group.add(mast);
    const radar = new THREE.Group();
    radar.position.set(cx, topY + 9.5, cz);
    radar.name = 'islandRadar';
    radar.add(dbox(9, 0.7, 1.1, DM.lightGrey, 0, 0, 0));
    radar.add(dbox(1.2, 2.2, 1.2, DM.hubMetal, 0, -1, 0));
    group.add(radar);
    // Nav lights: red port, green starboard, on the island top corners.
    for (const [sx, mat] of [[-1, DM.redNav], [1, DM.greenNav]]) {
      const nav = new THREE.Mesh(new THREE.SphereGeometry(1.1, 10, 8), mat);
      nav.position.set(cx + sx * (iw / 2 + 0.5), topY + 1, cz);
      nav.name = sx < 0 ? 'islandNavPort' : 'islandNavStbd';
      group.add(nav);
    }
    // Antenna whips.
    for (const [ax, az] of [[-iw / 3, -6], [iw / 3, 6]]) {
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.3, 7, 6), DM.darkMark);
      ant.position.set(cx + ax, topY + 3.5, cz + az);
      ant.name = 'islandAntenna';
      group.add(ant);
    }
    // Island panel lines (horizontal breaks on the tower face).
    group.add(dbox(iw * 0.9, 0.35, 0.3, DM.darkMark, cx, topY - 12, bowZ - 0.1));
  }
  // --- Hull: a single rub strip tucked right under the deck edge,
  // where the hull is at full width. (Side plates lower down floated
  // clear of the hull — it narrows with depth — so they are gone.) ---
  // v1.2.1: runs the full length, to the stern tip.
  for (const sx of [-1, 1]) {
    group.add(dbox(0.3, 1.0, 304, DM.darkMark, sx * (deckHalfX + 0.1), dy - 1, 32));
  }
  // --- Inner hull core: a closed solid loft, Hurricane-style ---
  // v1.2.1 solidity fix. The GLB hull is a set of open shell patches:
  // the mid-body side band (z -20..0, y -18..-13) is open and the belly
  // is hollow — rays from below first hit the recessed under-plate at
  // y -5.9 instead of a keel (64% of belly rays were "shallow" pre-fix).
  // The core is a closed loft whose sections follow the GLB hull profile
  // (measured per-z from the GLB vertices), inset ~1.5 m inside the
  // shell, so it never pokes through — but it IS the visible hull where
  // the GLB leaves nothing (stern overhang z 142..184, mid-body belly).
  // It also backs the deck, so no see-through path reaches the sky.
  const core = new THREE.Mesh(hullCoreGeometry(dy - 0.3), DM.hullCore);
  core.name = 'hullCore';
  group.add(core);
  // --- Bow and stern caps ---
  // Flat transom closing the stern face below the deck overhang, and a
  // cap closing the thin bow tip.
  const transom = dbox(deckHalfX * 2, 24, 1.5, DM.hullGrey, 0, dy - 17, 183.5);
  transom.name = 'sternTransom';
  group.add(transom);
  const bowCap = dbox(22, 4, 1.5, DM.hullGrey, 0, dy - 0.5, -165.5);
  bowCap.name = 'bowCap';
  group.add(bowCap);
  // --- Island base coaming ---
  // A low coaming ring around the island base seals the island/deck
  // junction and reads as real structure.
  const islX0 = -40.8, islX1 = -14.2, islZ0 = -20.3, islZ1 = 119.1;
  const islCx = (islX0 + islX1) / 2, islCz = (islZ0 + islZ1) / 2;
  const coam = (w, h, d, x, z) => { const m = dbox(w, h, d, DM.panelGrey, x, dy + 0.7, z); m.name = 'islandCoaming'; group.add(m); return m; };
  coam(1.2, 1.4, islZ1 - islZ0 + 2.4, islX0, islCz);
  coam(1.2, 1.4, islZ1 - islZ0 + 2.4, islX1, islCz);
  coam(islX1 - islX0 + 2.4, 1.4, 1.2, islCx, islZ0);
  coam(islX1 - islX0 + 2.4, 1.4, 1.2, islCx, islZ1);
  // Island inner core: island_23 is an open shell with a missing band
  // (rays at y +2, z 0..20 passed straight through it), so a solid
  // box inside the island footprint closes every path through it.
  const islCore = dbox(25, 9.4, 137, DM.panelGrey, -27.5, -0.7, 49.5);
  islCore.name = 'islandCore';
  group.add(islCore);
  // --- Pod sponson plates and duct caps ---
  // A solid plate under each lift-fan pod closes the view from below
  // into the pod housing, and a cap disc closes the bottom of the
  // exhaust cone. (Both are assigned to the pod's mesh set so they
  // disappear with the pod when it is destroyed.)
  podLocals.forEach((p, i) => {
    const sx = Math.sign(p.x);
    const plate = dbox(76, 2, 2 * p.r + 4, DM.panelGrey, sx * 55, p.y - 13, p.z);
    plate.name = 'podSponson_' + i;
    group.add(plate);
    const cap = new THREE.Mesh(new THREE.CircleGeometry(p.r * 0.55, 24), DM.ductDark);
    cap.rotation.x = -Math.PI / 2; cap.position.set(p.x, p.y - 11, p.z); cap.name = 'podDuctCap_' + i;
    group.add(cap);
  });
  // --- Stern engine exhausts (MCU: twin rear engine arrays) ---
  for (const sx of [-1, 1]) {
    const ex = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 4.2, 12, 14), DM.gunmetal);
    ex.rotation.x = Math.PI / 2;
    ex.position.set(sx * 14, dy - 13, 172);
    ex.name = 'exhaust_' + (sx < 0 ? 'port' : 'stbd');
    group.add(ex);
    const glow = new THREE.Mesh(new THREE.CircleGeometry(3.1, 16), DM.exhaustGlow);
    glow.position.set(sx * 14, dy - 13, 178.2);
    glow.name = 'exhaustGlow_' + (sx < 0 ? 'port' : 'stbd');
    group.add(glow);
  }
  // --- 2. Rotor assemblies: real 8-blade rotors inside deep ducted pods ---
  // Pod centres/radii come from the GLB's own duct_ring_* meshes, so the
  // rotors sit exactly inside their housings — never floating outside.
  podLocals.forEach((p, i) => {
    const r = p.r || 19;
    const asm = new THREE.Group();
    asm.position.set(p.x, p.y, p.z);
    asm.name = 'rotorAsm_' + i;
    // Duct wall: deep cylinder so the fan reads as sitting IN a housing,
    // with a dark interior, from above and from below.
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.99, r * 0.99, 7, 28, 1, true), DM.ductDark);
    wall.position.y = -1;
    wall.name = 'pod_housing_duct_' + i;
    asm.add(wall);
    // Intake ring (top lip) + lower lip ring.
    const lip = new THREE.Mesh(new THREE.TorusGeometry(r, 1.4, 10, 28), DM.lightGrey);
    lip.rotation.x = Math.PI / 2;
    lip.position.y = 2.8;
    lip.name = 'pod_housing_ring_' + i;
    asm.add(lip);
    const lip2 = new THREE.Mesh(new THREE.TorusGeometry(r * 0.97, 0.9, 8, 28), DM.gunmetal);
    lip2.rotation.x = Math.PI / 2;
    lip2.position.y = -4.5;
    lip2.name = 'pod_housing_lipring_' + i;
    asm.add(lip2);
    // Exhaust cone below the fan (depth from underneath).
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.32, 6, 20, 1, true), DM.ductDark);
    cone.position.y = -8;
    cone.name = 'pod_housing_exhaust_' + i;
    asm.add(cone);
    // Stator vanes: static radial bars below the rotor plane.
    for (let v = 0; v < 8; v++) {
      const vane = dbox(r * 0.9, 0.5, 2.0, DM.darkMark, 0, -2.6, 0, 0);
      vane.position.set(Math.cos(v * Math.PI / 4) * r * 0.45, -2.6, Math.sin(v * Math.PI / 4) * r * 0.45);
      vane.rotation.y = -v * Math.PI / 4;
      vane.name = 'pod_housing_vane_' + i + '_' + v;
      asm.add(vane);
    }
    // Spinning rotor: hub + mast + 8 pitched, tapered blades.
    const spin = new THREE.Group();
    spin.position.y = 0.8;
    spin.name = 'rotorSpin_' + i;
    const hub = new THREE.Mesh(new THREE.ConeGeometry(2.4, 4.5, 12), DM.hubMetal);
    hub.position.y = 1.2;
    hub.name = 'rotorHubCone_' + i;
    spin.add(hub);
    const mastR = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.4, 3.5, 10), DM.hubMetal);
    mastR.position.y = -0.8;
    mastR.name = 'rotorMast_' + i;
    spin.add(mastR);
    for (let b = 0; b < 8; b++) {
      const holder = new THREE.Group();
      holder.rotation.y = b * Math.PI / 4;
      holder.name = 'rotorBladeHolder_' + i + '_' + b;
      const blade = new THREE.Mesh(new THREE.BoxGeometry(r * 0.82, 0.45, 2.4), DM.blade);
      blade.position.set(2 + r * 0.41, 0, 0);
      blade.rotation.x = 0.38; // blade pitch (twist) — reads as an airfoil, not a flat card
      blade.name = 'rotorBlade_' + i + '_' + b;
      holder.add(blade);
      const tip = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 2.5), DM.bladeTip);
      tip.position.set(2 + r * 0.78, 0, 0);
      tip.rotation.x = 0.38;
      tip.name = 'rotorBladeTip_' + i + '_' + b;
      holder.add(tip);
      spin.add(holder);
    }
    asm.add(spin);
    // Motion-blur disc: faint translucent disc that strengthens with
    // rotor speed, so a fast rotor reads as a blur, not a frozen star.
    const blur = new THREE.Mesh(new THREE.CircleGeometry(r * 0.94, 28),
      new THREE.MeshBasicMaterial({ color: 0x2a2e33, transparent: true, opacity: 0.04, side: THREE.DoubleSide, depthWrite: false }));
    blur.rotation.x = -Math.PI / 2;
    blur.position.y = 1.15;
    blur.name = 'rotorBlur_' + i;
    asm.add(blur);
    group.add(asm);
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
  // Pod centres AND radii from the duct_ring_* meshes (group coords), so
  // the procedural rotors are built exactly inside their own housings.
  const rings = [];
  group.traverse(o => {
    if (o.isMesh && o.name.startsWith('duct_ring')) {
      const b = new THREE.Box3().setFromObject(o);
      const c = b.getCenter(new THREE.Vector3());
      const s = b.getSize(new THREE.Vector3());
      rings.push({ x: c.x, y: c.y, z: c.z, r: Math.max(s.x, s.z) / 2 });
    }
  });
  rings.sort((a, b) => (a.z - b.z) || (a.x - b.x));
  for (const r of rings) podLocals.push({ x: r.x, y: r.y, z: r.z, r: r.r });
  while (podLocals.length < 4) podLocals.push({ x: (podLocals.length % 2 ? -40 : 40), y: deckLocalY + 2, z: (podLocals.length < 2 ? -70 : 70), r: 19 });
  buildCarrierDetail(group, podLocals.slice(0, 4), deckLocalY, deckHalfX, deckHalfZ);
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
    if (n.startsWith('hull_') || n.startsWith('island_') || n === 'islandCore' || n.startsWith('pod_housing_') || n === 'hullCore' || n.startsWith('podSponson') || n === 'sternTransom' || n === 'bowCap' || n === 'islandCoaming') {
      o.material.color.setHex(0x7a2e26);
    } else if (n.startsWith('duct_ring_')) {
      o.material.color.setHex(0x4a1a16);
    }
  });
}

export class BreakupPiece {
  constructor(scene, group, vy, rollRate, pitchRate, yawRate, vx = 0, vz = 0) {
    this.group = group; this.scene = scene;
    this.vy = vy; this.vx = vx; this.vz = vz; // v1.2.0: pieces inherit the
    // carrier's velocity plus a separation impulse from the blast, so
    // they fly apart ballistically instead of dropping straight down.
    this.rollRate = rollRate; this.pitchRate = pitchRate; this.yawRate = yawRate;
    this.state = 'falling'; this.sinkT = 0; this.y = group.position.y;
    this.roll = group.rotation.z; this.pitch = group.rotation.x; this.heading = -group.rotation.y;
    this.impactY = 0; this.bubbleT = 0; this.boilT = 0;
    this.clipMats = []; // v1.3.2: materials whose clip planes follow the piece
    scene.add(group);
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
  update(dt, ctx) {
    if (this.state === 'falling') {
      const vt = 45;
      this.vy += (-vt - this.vy) * Math.min(1, dt / 2.5);
      this.y += this.vy * dt;
      // Ballistic drift: horizontal velocity decays with air drag.
      const drag = Math.exp(-dt * 0.15);
      this.vx *= drag; this.vz *= drag;
      this.group.position.x += this.vx * dt;
      this.group.position.z += this.vz * dt;
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
      // v1.3.2: sinking pieces keep drifting apart horizontally (with
      // drag) and slowly tumbling instead of freezing in a pile at the
      // impact point. Water-impact fragments are born at the same spot;
      // without this they sink as one overlapping mass and read as the
      // same "duplicates" glitch the clip fix addresses.
      const drag = Math.exp(-dt * 0.15);
      this.vx *= drag; this.vz *= drag;
      this.group.position.x += this.vx * dt;
      this.group.position.z += this.vz * dt;
      this.roll += this.rollRate * dt * 0.3;
      this.pitch += this.pitchRate * dt * 0.3;
      this.heading += this.yawRate * dt * 0.3;
      this.roll += (0.4 - this.roll) * dt * 0.5;
      this.group.rotation.set(this.pitch, -this.heading, this.roll);
      this.bubbleT -= dt;
      if (this.bubbleT <= 0) { this.bubbleT = 0.12; ctx.vfx.bubbles(this.group.position.x, this.impactY, this.group.position.z, 4, 60); }
      this.boilT -= dt;
      if (this.boilT <= 0 && f > 0.1 && f < 0.9) { this.boilT = 0.4; ctx.vfx.boil(this.group.position.x, this.impactY, this.group.position.z, 40); }
      if (f >= 1) { this.state = 'gone'; this.group.visible = false; }
    }
    // v1.3.2: re-aim the cut planes every frame (see refreshClipPlanes).
    if (this.state !== 'gone') this.refreshClipPlanes();
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
      spinDir: (i === 0 || i === 3) ? 1 : -1, // diagonal pairs counter-rotate
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
      if (o.isMesh && (o.name.startsWith('pod_housing_') || o.name.startsWith('rotor_disc_') || o.name.startsWith('rotor_hub_') || o.name.startsWith('duct_ring_') || o.name.startsWith('podSponson_') || o.name.startsWith('podDuctCap_'))) {
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
      // v1.2.0: the retired GLB rotor discs/hubs are hidden for good —
      // never put them in a pod's mesh list, or a debug heal would
      // resurrect the flat star discs alongside the new rotors.
      if (best !== null && !pm.o.name.startsWith('rotor_disc_') && !pm.o.name.startsWith('rotor_hub_')) {
        this.pods[best].meshes.push(pm.o);
        // v1.2.0: the GLB rotor discs are hidden (procedural rotors
        // replace them), so pod.disc stays null — spin uses rotorSpin.
      }
    }
    // v1.2.0: the whole procedural rotor assembly belongs to its pod,
    // so a destroyed pod hides its fan, duct and blades together.
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
  // v1.3.0 blastImpulse (Hurricane v10.1, metric): an inverse-square
  // physical blast. A detonation shoves the hull away from the blast,
  // heels it away, and kicks the yaw if the blast is off-centre. Nearby
  // ships feel it too, falling off with the square of the distance.
  // Hurricane blastRadius 40u -> 40*5.74 = 230 m; falloff P/(1+d2/100)
  // is in Hurricane units, so here fall = power/(1+d2/2500) with the
  // same shape at metre scale. Called from damage() for hard hits and
  // from detonate()/breakUp() — never for light bumps.
  blastImpulse(bx, bz, power) {
    if (this.state !== 'alive') return;
    const dx = this.x - bx, dz = this.z - bz;
    const d2 = dx * dx + dz * dz, d = Math.sqrt(d2) || 1;
    if (d > 230) return;
    const fall = power / (1 + d2 / 2500);
    const nx = dx / d, nz = dz / d;
    this.blastVx += nx * fall * 0.35;
    this.blastVz += nz * fall * 0.35;
    const lat = dx * Math.cos(this.heading) + dz * Math.sin(this.heading);
    this.heelKick -= Math.sign(lat || 1) * 0.1 * Math.min(1, fall / 6);
    this.blastYaw += (Math.random() - 0.5) * 0.05 * Math.min(1, fall / 6);
  }
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
    this.scorches.push(ctx.vfx.addScorch(this.group, lx, this.deckLocalY + 1, lz, 14));
    if (this.scorches.length > 20) { const s = this.scorches.shift(); this.group.remove(s); }
    if (!opts || !opts.quiet) {
      ctx.vfx.hitFX(wp.x, wp.y + 4, wp.z, amount, szF, magHit);
    }
    // v1.3.0 (H): hard hits physically shove this carrier and her
    // neighbours (inverse-square blast impulse).
    if (amount >= 15 && ctx.carriers) {
      for (const c of ctx.carriers) c.blastImpulse(wp.x, wp.z, amount * 0.6);
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
    if (ctx.carriers) for (const c of ctx.carriers) if (c !== this) c.blastImpulse(this.x, this.z, 60 * scale);
    ctx.msg(`${this.name}: ${zoneKey === 'reactor' ? 'REACTOR' : 'MAGAZINE'} DETONATION`);
    this.breakUp(ctx, 'detonation');
  }
  startFall(ctx, reason) {
    if (this.state !== 'alive') return;
    this.state = 'falling';
    this.fallT = 0;
    this.vy = 0;
    this.fallStartAlt = this.y; this.lastImpact = null; this.lastBreakup = null;
    const deadX = this.pods.filter(p => !p.alive).reduce((a, p) => a + p.local.x, 0);
    this.fallRollRate = (deadX >= 0 ? 1 : -1) * (0.06 + 0.1 * (1 - this.lift)) + (Math.random() - 0.5) * 0.05;
    this.fallPitchRate = (Math.random() - 0.5) * 0.08;
    this.fallYawRate = (Math.random() - 0.5) * 0.05;
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
  breakUp(ctx, reason, opts = {}) {
    if (this.state === 'gone') return;
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
    const sepV = (3 + 4 * severity) * (energy > 2 ? 1.3 : 1); // blast separation impulse along the hull
    this.state = 'gone';
    this.group.visible = false;
    // Object3D.clone() JSON-deep-clones userData; group.userData.carrier
    // points back at this Helicarrier (which owns the group) — a cycle
    // that throws "Converting circular structure to JSON" and kills the
    // breakup mid-way (carrier vanishes, zero pieces). Strip it first;
    // the original is dead and no longer needs click-pick identity.
    this.group.userData.carrier = undefined;
    const fwd = { x: Math.sin(this.heading), z: -Math.cos(this.heading) };
    const bounds = [-CARRIER_LEN / 2, ...cuts, CARRIER_LEN / 2];
    const impactVx = opts.impactVx || 0, impactVz = opts.impactVz || 0;
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
    const mkPiece = (lo, hi, segCentre) => {
      // v1.3.2: the cut lives in the piece's LOCAL space — a segment
      // [lo,hi] in along-hull d maps to local z in [-hi,-lo] (bow is
      // -Z, d = -lz). The planes are re-aimed to world space every
      // frame in BreakupPiece.refreshClipPlanes (the Hurricane re-aim
      // the v1.3.0 port dropped). A world plane baked once slices a
      // moving, tumbling clone at a different section every frame, so
      // pieces showed each other's decks, islands and pods — the
      // "glitching duplicates" Nicholas reported.
      const locals = [];
      if (lo > -CARRIER_LEN / 2 + 1) locals.push(new THREE.Plane(new THREE.Vector3(0, 0, -1), -lo)); // keep z <= -lo
      if (hi < CARRIER_LEN / 2 - 1) locals.push(new THREE.Plane(new THREE.Vector3(0, 0, 1), hi));    // keep z >= -hi
      const clone = this.group.clone(true);
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
      // End caps: a solid cross-section at each interior cut face, so
      // a piece reads as a torn-off part of one ship, not a hollow shell.
      if (lo > -CARRIER_LEN / 2 + 1) addSectionCap(clone, -lo, this.deckLocalY, islBox);
      if (hi < CARRIER_LEN / 2 - 1) addSectionCap(clone, -hi, this.deckLocalY, islBox);
      clone.position.set(this.x, this.y, this.z);
      clone.rotation.set(this.pitch, -this.heading, this.roll);
      // Tumble: faster near the blast, wilder with speed/altitude.
      const dHit = Math.abs(segCentre - cutOff);
      const tumble = (0.7 + 0.6 * severity) * (1 + 0.5 * (1 - Math.min(1, dHit / 150))) * speedF;
      const away = Math.sign(segCentre - cutOff) || (Math.random() < 0.5 ? 1 : -1);
      const piece = new BreakupPiece(ctx.scene, clone, fallVy,
        (0.2 + Math.random() * 0.4) * tumble * (Math.random() < 0.5 ? 1 : -1),
        (Math.random() - 0.5) * 0.4 * tumble,
        (Math.random() - 0.5) * 0.1 * speedF,
        (this.vx || 0) + impactVx + fwd.x * away * sepV * (0.7 + Math.random() * 0.6),
        (this.vz || 0) + impactVz + fwd.z * away * sepV * (0.7 + Math.random() * 0.6));
      piece.clipMats = clipMats;
      piece.refreshClipPlanes(); // aim the planes before the first frame
      this.pieces.push(piece);
    };
    for (let i = 0; i < bounds.length - 1; i++) mkPiece(bounds[i], bounds[i + 1], (bounds[i] + bounds[i + 1]) / 2);
    this.lastBreakup = { reason, pieces: this.pieces.length, energy: +energy.toFixed(2), cuts: cuts.map(c => +c.toFixed(0)), hitZone: hit.zone, hitAmount: hit.amount, alt: +hit.alt.toFixed(0), speed: +hit.speed.toFixed(1) };
    ctx.vfx.magazineSecondary(this.x, this.y, this.z, CARRIER_LEN / 42 * Math.max(0.9, Math.min(1.6, 0.8 + severity * 0.3)));
    ctx.vfx.burst(this.x, this.y, this.z, Math.round(30 * severity), [0.25, 0.25, 0.25], 11, 7);
    if (ctx.audio) ctx.audio.boom(true);
    if (ctx.carriers) for (const c of ctx.carriers) if (c !== this) c.blastImpulse(this.x, this.z, 60 * severity);
    ctx.msg(`${this.name} broke up ${reason ? '(' + reason + ')' : ''} — ${this.pieces.length} pieces falling`);
    if (this.wing) this.wing.handleCarrierFalling(ctx);
    if (ctx.onCarrierLost) ctx.onCarrierLost(this);
  }
  update(dt, ctx) {
    // Breakup pieces always update.
    for (const p of this.pieces) p.update(dt, ctx);
    this.pieces = this.pieces.filter(p => !p.gone);
    if (this.state === 'gone') return;
    // v1.2.0 rotor spool: spin rate follows lift demand — it spools up
    // with throttle (forward speed) and climb, and spools down as lift
    // is lost, so the fans visibly work in step with the carrier. A
    // dead pod's rotor stops (its assembly is hidden on pod death).
    // Counter-rotating diagonal pairs spin opposite ways.
    for (const pod of this.pods) {
      if (!pod.rotorSpin) continue;
      const demand = (this.state === 'sinking' || this.state === 'gone') ? 0
        : Math.max(0, Math.min(1.15, 0.55 + 0.45 * (Math.abs(this.forwardSpeed) / 16) + (this.vy > 1 ? 0.12 : 0)));
      const target = pod.alive ? 30 * demand * Math.max(0, this.lift) : 0;
      pod.spinRate += (target - pod.spinRate) * Math.min(1, dt * 1.2); // spool lag
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
      if (Math.abs(this.blastVx) > 0.01 || Math.abs(this.blastVz) > 0.01) {
        this.x += this.blastVx * dt; this.z += this.blastVz * dt;
        const bd = Math.exp(-dt * 0.8);
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
      this.roll += (this.list + this.heelKick - this.roll) * Math.min(1, dt * 2);
      // v1.2.0 pitch: the spring-return pitch command drives attitude
      // and climb. Pitch up climbs, pitch down descends; at neutral
      // the altitude hold below resumes at the new altitude.
      const pitchTarget = Math.max(-1, Math.min(1, this.pitchInput)) * PITCH_MAX;
      this.pitch += Math.max(-PITCH_RATE * dt, Math.min(PITCH_RATE * dt, pitchTarget - this.pitch));
      // Altitude hold: climb +15 / descend -10 m/s, ramped; lift<0.6 sinks.
      let climb = 0;
      const dy = this.targetAlt - this.y;
      if (dy > 2) climb = Math.min(15, dy * 0.2);
      else if (dy < -2) climb = Math.max(-10, dy * 0.2);
      if (this.lift < 0.6) climb -= (0.6 - this.lift) * 6;
      if (Math.abs(this.pitchInput) > 0.05) {
        // Pitch commands vertical speed from forward motion plus a
        // small hover authority, so pitch still bites near ALL STOP.
        climb = Math.max(-14, Math.min(14, (Math.abs(this.forwardSpeed) * 0.8 + 6) * Math.sin(this.pitch)));
        if (this.lift < 0.6) climb -= (0.6 - this.lift) * 6;
        this.targetAlt = this.y; // hold resumes here when pitch releases
      }
      // Pitch alone can never drive her into the sea or above the ceiling.
      if (this.y <= ALT_FLOOR && climb < 0) climb = 0;
      if (this.y >= ALT_CEIL && climb > 0) climb = 0;
      this.vy += (climb - this.vy) * Math.min(1, dt * 0.8);
      this.y += this.vy * dt;
      this.y = Math.max(120, Math.min(650, this.y));
      // Hard altitude stops: pitch can ease the carrier down to the
      // floor, but never through it (and never above the ceiling) —
      // residual downward velocity is killed at the stop, so there is
      // no overshoot below it.
      if (this.y <= ALT_FLOOR) { this.y = ALT_FLOOR; if (this.vy < 0) this.vy = 0; }
      if (this.y >= ALT_CEIL) { this.y = ALT_CEIL; if (this.vy > 0) this.vy = 0; }
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
      // Breakup re-check during the fall: structural stress from the
      // damage already taken and the tumble — NOT from fall speed
      // alone. A lightly damaged ship (one pod lost, hp ~90%) mostly
      // rides the fall out intact; a wreck at 12% HP mostly comes
      // apart on the way down. No breakup in the last 80 m — the
      // water impact decides that. (v1.3.1: the old 0.35-per-check
      // rate broke up almost every fall in the air, so intact falls
      // never happened.)
      this.breakupT -= dt;
      if (this.breakupT <= 0) {
        this.breakupT = 0.4;
        const speed = Math.abs(this.vy);
        const stress = (1 - this.hpFrac) * 0.7 + (Math.abs(this.fallRollRate) + Math.abs(this.fallPitchRate)) * 0.5 + (this.lift <= 0 ? 0.1 : 0);
        const seaH0 = ctx.sea.waveHeight(this.x, this.z, ctx.time);
        if (speed > 25 && this.y > seaH0 + 80 && Math.random() < stress * 0.05) { this.breakUp(ctx, 'stressed in the fall'); return; }
      }
      const seaH = ctx.sea.waveHeight(this.x, this.z, ctx.time);
      if (this.y <= seaH + 2) {
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

// game.js — Helicarriers at Sea v1: bootstrap, fleet steering (Hurricane
// telegraph/modes/formation/waypoint, metric), free-orbit camera (Pandora
// OrbitCamera helpers, ported), HUD, minimap, enemy AI director, debug hooks.
import * as THREE from 'three';
import { Sea, STAGES } from './sea.js';
import { VFX } from './vfx.js';
import { Helicarrier, loadModels, CARRIER_LEN } from './carrier.js';
import { checkCarrierCollisions } from './collisions.js';
import { AirWing, AirBomb, AntiShipMissile, bombBallisticsProbe, JET_CRUISE_SPEED } from './jets.js';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug') || params.get('debug') === '1';

window.addEventListener('error', e => {
  const el = $('loadErr');
  if (el) { el.style.display = 'flex'; $('loadErrText').textContent = (e.message || e.error || 'unknown error') + '\n' + (e.filename || '') + ':' + (e.lineno || ''); }
});

// ---------- Scale decision (also in README) ----------
// 1 unit = 1 m (Pandora metric). Helicarrier 333 m, F-18 18.79 m.
// Hurricane ran 1 unit ≈ 5.74 m with jets at 16 units; every Hurricane
// constant crossing into this game was re-derived in metres (see jets.js
// for the bomb-release re-derivation, sea.js for G_GAME = 9.81).

const TELEGRAPH = [
  { name: 'FLANK', frac: 1.0 }, { name: 'FULL', frac: 0.8 }, { name: 'STANDARD', frac: 0.6 },
  { name: 'HALF', frac: 0.4 }, { name: 'SLOW', frac: 0.2 }, { name: 'ALL STOP', frac: 0 },
  { name: 'HALF ASTERN', frac: -0.25 }, { name: 'FULL ASTERN', frac: -0.5 },
];
const SKILLS = {
  cadet: { launchInterval: 50, aimErr: 25, jetMul: 0.9, dmgMul: 0.8, label: 'Cadet' },
  veteran: { launchInterval: 35, aimErr: 12, jetMul: 1.0, dmgMul: 1.0, label: 'Veteran' },
  elite: { launchInterval: 22, aimErr: 5, jetMul: 1.1, dmgMul: 1.2, label: 'Elite' },
};
const FORM = {
  C: [[0, 450, 25], [-450, 450, -25], [0, 900, 0]],       // cruising wedge
  A: [[-450, 200, 25], [450, 200, -25], [-900, 400, 0]],  // attack line
};

const G = {
  renderer: null, scene: null, camera: null, sea: null, vfx: null,
  models: null, started: false, time: 0, timeScale: 1,
  playerFleet: [], enemyFleet: [], allCarriers: [],
  selected: null, mode: 'FLEET', // INDV | FLEET | ANCHOR
  stage: 0, form: 'C', skill: 'veteran', baseAlt: 350, enemyAI: 'auto',
  waypoint: null, targetMode: 'nearest', targetCarrier: null,
  bombs: [], missiles: [],
  camYaw: 0.6, camPitch: 0.32, camDist: 1100, camPan: { x: 0, y: 0 },
  camFollow: null, camTac: null, camTacIdx: 0,
  rudderInput: 0, keys: {},
  enemyTimers: new Map(), enemyLoadout: new Map(),
  over: false, bombStats: { drops: 0, hits: 0, log: [] },
  msgT: 0,
  collLog: [], // collision events {t, kind, a, b, closing, dmgA, dmgB, zoneA, zoneB, x, y, z, shake}
  collCool: {}, grindCool: {}, scrapeCool: {}, // per-pair cooldowns (collisions.js)
  collidePair: null, // [a, b] carriers forced onto a collision course (?collide= / debug button)
  collideMode: null, // 'headon' | 'gentle' | 'drift'
  transferAnnounce: null, // (c) sticky command-transfer banner {text, until}
  enemyFlag: null, // (c) current live enemy flagship (role moves when it dies)
  endResult: null, // (e) 'win' | 'lose' | 'draw' once the round ends
};

function msg(text) {
  const el = $('msg');
  if (el) el.textContent = text;
  G.msgT = 4;
}

// ---------- Scene ----------
function initScene() {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.localClippingEnabled = true; // breakup pieces need clipping planes
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  $('app').appendChild(renderer.domElement);
  G.renderer = renderer;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fc3d8);
  scene.fog = new THREE.Fog(0x9fc3d8, 800, 6000);
  G.scene = scene;
  G.camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 1, 12000);
  const sun = new THREE.DirectionalLight(0xfff2d8, 2.2);
  sun.position.set(800, 900, -600);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xbfd9e8, 0x1a3a4a, 1.1));
  const amb = new THREE.AmbientLight(0xffffff, 0.25);
  scene.add(amb);
  G.sea = new Sea(scene, G.stage);
  G.vfx = new VFX(scene);
  addEventListener('resize', () => {
    G.camera.aspect = innerWidth / innerHeight;
    G.camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}

// ---------- Fleet setup ----------
function applyForm(fleet, formKey, flagship) {
  const slots = FORM[formKey];
  fleet.forEach((c, i) => {
    if (i === 0) c.slot = { dx: 0, dz: 0, dy: 0 };
    else { const s = slots[i - 1] || [0, 450 * i, 0]; c.slot = { dx: s[0], dz: s[1], dy: s[2] }; }
    c.targetAlt = G.baseAlt + c.slot.dy;
  });
}
function rederiveSlots(newFlag, fleet) {
  // Hurricane rederiveSlots (L2269): slots from current positions relative
  // to the new flagship — stops the teleport scramble on command transfer.
  // Extended with dy (altitude offset kept as-is).
  fleet.forEach(c => {
    if (c === newFlag) { c.slot = { dx: 0, dz: 0, dy: c.slot.dy }; return; }
    const ox = c.x - newFlag.x, oz = c.z - newFlag.z;
    const h = newFlag.heading, ch = Math.cos(h), sn = Math.sin(h);
    c.slot = { dx: ox * ch + oz * sn, dz: -ox * sn + oz * ch, dy: c.slot.dy };
  });
}
function spawnFleet(side, n, z0, heading) {
  const fleet = [];
  // Spawn line along z, 450 m apart, so carriers never overlap.
  const offs = [[0, 0], [450, 450], [-450, -450], [0, 900]];
  for (let i = 0; i < n; i++) {
    const c = new Helicarrier({
      template: G.models.heli, side,
      name: (side === 'player' ? 'SHIELD-' : 'ENEMY-') + (i + 1),
      x: offs[i][0], z: z0 + offs[i][1],
      heading, alt: G.baseAlt,
    });
    G.scene.add(c.group);
    const wing = new AirWing(c, G.models.jet, side, side === 'enemy' ? SKILLS[G.skill] : null);
    wing._fleet = fleet; // set properly below (fleet ref shared)
    fleet.push(c);
  }
  fleet.forEach(c => { c.wing._fleet = fleet.concat(side === 'player' ? G.enemyFleet : G.playerFleet); });
  applyForm(fleet, G.form, fleet[0]);
  return fleet;
}

// ---------- Steering (Hurricane Fleet §4, metric) ----------
function drivenShips() {
  const sel = G.selected;
  if (!sel) return [];
  if (G.mode === 'ANCHOR') return G.playerFleet.filter(c => c.alive && c !== sel);
  return [sel].filter(c => c.alive);
}
function setTelegraph(i) {
  G.telegraphIdx = clamp(i, 0, TELEGRAPH.length - 1);
  for (const c of G.playerFleet) if (c.alive) c.telegraphIdx = G.telegraphIdx;
  updateTeleBox();
}
function switchShip(next) {
  if (!next || !next.alive) return;
  const prev = G.selected;
  G.waypoint = null;
  rederiveSlots(next, G.playerFleet);
  if (prev) { next.telegraphIdx = prev.telegraphIdx; next.spoolSpeed = next.forwardSpeed; next.rudderDeg = next.rudder * 35; }
  G.selected = next;
  G.camFollow = next;
  msg('Command: ' + next.name);
  renderFleetPanels();
}
// (c) Flagship death must never leave the helm on a dead carrier. The
// moment the selected carrier stops being alive (falling, sinking or
// gone), command passes to the next live carrier of the same side.
// Called every frame from updateSteering — so the transfer lands within
// a frame of the loss, even for a fall (onCarrierLost only fires once
// the wreck is 'gone', ~40 s of game time later) — and from
// onCarrierLost as a backstop. No-op while the selection is alive.
// Telegraph carries over: switchShip copies the dead flagship's notch
// onto the new one (and the global G.telegraphIdx never changes), and
// rudder is never snapped: the new flagship keeps its own rudderDeg
// and the player's live rudder input keeps steering it from the next
// frame, per the Hurricane no-snap rule. If no live carrier is left
// the dead selection is cleared and checkEnd ends the round (defeat)
// once the wrecks have finished sinking — the game never hangs on it.
function ensureLiveCommand(dead) {
  if (G.over) return false;
  if (G.selected && G.selected.alive) return false;
  if (!G.selected) return false; // already cleared; Tab/click re-takes command
  const fleet = G.playerFleet;
  if (!fleet.length) return false;
  const lost = dead && fleet.includes(dead) ? dead : G.selected;
  const start = lost ? fleet.indexOf(lost) : -1;
  for (let k = 1; k <= fleet.length; k++) {
    const c = fleet[(start + k) % fleet.length];
    if (c && c.alive) {
      const prevName = lost ? lost.name : 'Flagship';
      switchShip(c);
      const text = `${prevName} lost — command transferred to ${c.name}`;
      msg(text);
      // Sticky: the transfer is the one message the player must not
      // miss, and carrier/jet loss messages in the same frames would
      // otherwise overwrite it within a frame. Re-asserted at the end
      // of the loop for 8 s of game time (see loop()).
      G.transferAnnounce = { text, until: G.time + 8 };
      return true;
    }
  }
  G.selected = null;
  G.camFollow = null;
  renderFleetPanels();
  return false;
}
function wpRudderFor(c) {
  if (!G.waypoint) return 0;
  const want = Math.atan2(G.waypoint.x - c.x, -(G.waypoint.z - c.z));
  let dh = want - c.heading;
  dh = ((dh + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return clamp(dh * 1.5, -1, 1) * 35;
}
// Carrier keep-out: if another live carrier is inside 600 m, steer AWAY
// from the nearest one instead of the ordered rudder. Applied only to
// AI-driven hulls (enemy flagship, ANCHOR-mode ships) — never to the
// player's helm. Escorts already keep 400 m in escortControl; this
// closes the gap for flagships, which used to steam straight through
// each other (min separation 26 m between 333 m hulls).
function keepOutRudder(c, rudderDeg) {
  let nearest = null, nd = 1e18;
  for (const o of G.allCarriers) {
    if (o === c || !o.alive) continue;
    const d = Math.hypot(o.x - c.x, o.z - c.z);
    if (d < nd) { nd = d; nearest = o; }
  }
  if (!nearest || nd >= 600) return rudderDeg;
  const away = Math.atan2(c.x - nearest.x, -(c.z - nearest.z));
  let dah = away - c.heading;
  dah = ((dah + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return clamp(dah * 1.5, -1, 1) * 35;
}
// Collision debug hook (?collide=1|gentle|drift, or the debug-panel
// button): force two carriers onto a collision course for verification.
// updateSteering drives the pair at each other and skips them in every
// normal branch, so avoidance steering cannot defeat the meeting; the
// pair is released after the first impact (loop()) so the carriers
// separate instead of ramming again. Enemy jets are set passive so a
// strike cannot sink a carrier before the hulls meet.
//   headon: flagships 900 m apart, bow to bow, both FLANK (20 m/s each,
//     closing ~40 m/s — catastrophic, see collisions.js).
//   gentle: flagship at ALL STOP, enemy flagship SLOW into her
//     (closing ~4 m/s — a scuff: light zone damage + scorch, no fire).
//   drift: your carrier 2, 250 m off the flagship's starboard beam,
//     heading straight at her at SLOW (closing ~4 m/s) — a
//     formation neighbour drifting into the flagship. Needs 2+ player
//     carriers (fleet=1 falls back to the enemy flagship).
function forceCollisionCourse(mode) {
  const m = mode || 'headon';
  let a, b, aTele, bTele;
  if (m === 'drift') {
    a = G.playerFleet[0];
    b = G.playerFleet[1] || G.enemyFleet[0];
    if (!a || !b || !a.alive || !b.alive) return false;
    const rx = Math.cos(a.heading), rz = Math.sin(a.heading);
    b.x = a.x + rx * 250; b.z = a.z + rz * 250; // 250 m: ~78 game-s to meet at 3.2 m/s
    b.heading = Math.atan2(a.x - b.x, -(a.z - b.z));
    b.y = a.y; b.targetAlt = a.targetAlt;
    aTele = 5; bTele = 4; // ALL STOP vs SLOW (4 m/s — a light scuff, not a ram)
  } else {
    a = G.playerFleet[0]; b = G.enemyFleet[0];
    if (!a || !b || !a.alive || !b.alive) return false;
    const fx = Math.sin(a.heading), fz = -Math.cos(a.heading);
    // Separation by mode: head-on closes at ~40 m/s, gentle at ~4 m/s —
    // keep the wait to impact comparable (~25 s / ~35 s of game time).
    // Gentle must start > ~322 m apart (bow-circle to bow-circle contact
    // distance for two 333 m hulls) or the pair spawns already overlapped.
    const sep = m === 'gentle' ? 450 : 900;
    b.x = a.x + fx * sep; b.z = a.z + fz * sep;
    b.heading = a.heading + Math.PI;
    b.y = a.y; b.targetAlt = a.targetAlt;
    aTele = m === 'gentle' ? 5 : 0; // ALL STOP (gentle) vs FLANK (head-on)
    bTele = m === 'gentle' ? 4 : 0; // SLOW vs FLANK
  }
  a.telegraphIdx = aTele; b.telegraphIdx = bTele;
  a.rudderDeg = 0; b.rudderDeg = 0;
  G.collidePair = [a, b]; G.collideMode = m;
  G.enemyAI = 'passive';
  msg(`Collision course set (${m}): ${a.name} vs ${b.name} — keep-out disabled for this pair`);
  return true;
}
function driveCarrier(c, dt, rudderDeg, isDriven) {
  if (!c.alive) return;
  const stage = STAGES[G.stage];
  // Rudder slew toward target (deg/s ~ 40 for a big hull).
  const slew = 40 * dt;
  c.rudderDeg += clamp(rudderDeg - c.rudderDeg, -slew, slew);
  c.rudder = c.rudderDeg / 35;
  // Telegraph spool: ordered speed in m/s.
  const frac = TELEGRAPH[c.telegraphIdx].frac;
  const maxSpd = stage.speed * c.engineFactor * (1 - 0.33 * c.rudder * c.rudder);
  const ordered = frac * maxSpd;
  const rate = ordered > c.forwardSpeed ? 6 : 10; // m/s^2 spool
  c.forwardSpeed += clamp(ordered - c.forwardSpeed, -rate * dt, rate * dt);
  // Turn: rudder authority scales with speed and bridge health.
  const speedFactor = 0.12 + 0.88 * Math.min(1, Math.abs(c.forwardSpeed) / 12);
  const turnRate = 0.12 * c.rudder * speedFactor * c.steeringFactor;
  c.heading += turnRate * dt * (c.forwardSpeed >= 0 ? 1 : -0.25);
  c.yawRate = turnRate;
  const fx = Math.sin(c.heading), fz = -Math.cos(c.heading);
  c.vx = fx * c.forwardSpeed; c.vz = fz * c.forwardSpeed;
  c.x += c.vx * dt; c.z += c.vz * dt;
  // Wave push + tide are small at altitude; apply a whisper of drift.
  const push = G.sea.wavePush(c.x, c.z, G.time);
  c.x += push.x * dt * 0.1; c.z += push.z * dt * 0.1;
}
function escortControl(c, flag, dt) {
  if (!c.alive || !flag.alive) return;
  let rudderIn, desSpeed;
  // Post-impact avoidance window (NEW-1 fix): for 30 game-s after a
  // carrier–carrier collision, this escort BACKS OFF the other hull
  // instead of seeking its slot — otherwise slot-seeking slides it back
  // along the flagship and re-contacts 2–3+ times at ~3–4 m/s, grinding
  // the same zone down (drift probe: 19 events, 127 dmg/side, magazine
  // destroyed). Astern, not a turn-away: a carrier turns at only
  // ~4°/s at low speed, so steering away still points the bow at the
  // other hull for seconds — and speeding up to turn made the
  // re-contacts HARDER (first attempt: 5 events, 69 dmg/side, closing
  // 5.4–6.0 m/s). Reversing pulls the bow straight out of contact at
  // once (the bow was the contact point), while the rudder still swings
  // it toward the away heading for when the window expires. The window
  // refreshes on every further impact or grind tick, so it only expires
  // once the pair is actually clear, and it clears early past 600 m
  // separation. It never fires without a recent collision, so normal
  // formation flying is untouched, and it never fights the 600 m
  // keep-out rudder (escorts do not use it — this is their equivalent
  // while avoiding). Only escorts run this branch: the player's selected
  // ship keeps its helm, and the other carrier does the avoiding when
  // the flagship itself was hit.
  const o = c.avoidOther;
  if (G.time < (c.avoidUntil || 0) && o && o.alive && Math.hypot(o.x - c.x, o.z - c.z) < 600) {
    const away = Math.atan2(c.x - o.x, -(c.z - o.z));
    let dah = away - c.heading;
    dah = ((dah + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    rudderIn = clamp(dah * 1.5, -1, 1);
    // Back off astern at 6 m/s: the contact was at the bow, so reversing
    // separates immediately even before the slow turn comes around.
    // (The shared clamp below floors astern at -maxSpd/2; 6 is inside it.)
    desSpeed = -6;
  } else {
    c.avoidUntil = 0; c.avoidOther = null;
    // Slot target rotated by flagship heading (Nicholas v11.15 rule: the
    // escort takes its bearing from the flagship's heading and corrects
    // independently).
    const h = flag.heading, ch = Math.cos(h), sn = Math.sin(h);
    const tx = flag.x + c.slot.dx * ch - c.slot.dz * sn;
    const tz = flag.z + c.slot.dx * sn + c.slot.dz * ch;
    const dx = tx - c.x, dz = tz - c.z;
    const distToSlot = Math.hypot(dx, dz);
    // Separation: live neighbours within 400 m push the target away.
    let px = tx, pz = tz;
    for (const o2 of G.allCarriers) {
      if (o2 === c || !o2.alive) continue;
      const ox = c.x - o2.x, oz = c.z - o2.z;
      const d = Math.hypot(ox, oz);
      if (d < 400 && d > 1) { px += ox / d * (400 - d) * 0.6; pz += oz / d * (400 - d) * 0.6; }
    }
    const slotBrg = Math.atan2(px - c.x, -(pz - c.z));
    let desHeading = flag.heading;
    if (distToSlot > 6) {
      let dh = slotBrg - flag.heading;
      dh = ((dh + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      desHeading = flag.heading + clamp(dh, -0.35, 0.35);
    }
    let dh = desHeading - c.heading;
    dh = ((dh + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    rudderIn = clamp(dh * 1.5, -1, 1);
    if (distToSlot < 25) rudderIn *= 0.7;
    // Speed: mirror the flagship + bounded catch-up (v11.36 rule).
    desSpeed = flag.forwardSpeed + clamp((distToSlot - 20) * 0.05, -3, 3);
    if (flag.forwardSpeed < 1 && distToSlot < 30) desSpeed = 0;
  }
  const stage = STAGES[G.stage];
  const maxSpd = Math.max(6, stage.speed * c.engineFactor + 2);
  desSpeed = clamp(desSpeed, -maxSpd * 0.5, maxSpd);
  // Drive the escort directly toward its slot.
  c.rudderDeg += clamp(rudderIn * 35 - c.rudderDeg, -40 * dt, 40 * dt);
  c.rudder = c.rudderDeg / 35;
  const speedFactor = 0.12 + 0.88 * Math.min(1, Math.abs(c.forwardSpeed) / 12);
  const turnRate = 0.12 * c.rudder * speedFactor * c.steeringFactor;
  c.heading += turnRate * dt;
  c.yawRate = turnRate;
  const rate = desSpeed > c.forwardSpeed ? 6 : 10;
  c.forwardSpeed += clamp(desSpeed - c.forwardSpeed, -rate * dt, rate * dt);
  const fx = Math.sin(c.heading), fz = -Math.cos(c.heading);
  c.vx = fx * c.forwardSpeed; c.vz = fz * c.forwardSpeed;
  c.x += c.vx * dt; c.z += c.vz * dt;
  c.targetAlt = flag.targetAlt + c.slot.dy;
}
function updateSteering(dt) {
  // (c) Helm recovery first: if the flagship just died, command has
  // already moved to a live carrier before anything steers this frame,
  // so escortControl always gets a live flag and never early-returns.
  ensureLiveCommand();
  // Collision debug course (?collide= / debug button): the pair steers
  // at each other with fixed rudder/telegraph, bypassing the keep-out
  // rudder and the formation controller entirely — otherwise the
  // avoidance steering would defeat the forced meeting. Pair members
  // are skipped by every normal steering branch below so no carrier is
  // driven twice in one frame. Released after the first impact (loop()).
  const inCollidePair = c => G.collidePair && G.collidePair.includes(c);
  const steerPairAt = (c, t) => {
    if (!c.alive) return;
    const want = Math.atan2(t.x - c.x, -(t.z - c.z));
    let dh = want - c.heading;
    dh = ((dh + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    G._pairDbg = { c: c.name, want: +want.toFixed(2), dh: +dh.toFixed(2), h: +c.heading.toFixed(2) };
    driveCarrier(c, dt, clamp(dh * 1.5, -1, 1) * 35, true);
  };
  if (G.collidePair) {
    const [a, b] = G.collidePair;
    if (G.collideMode === 'drift') {
      if (a.alive) driveCarrier(a, dt, 0, true); // flagship holds at ALL STOP
      steerPairAt(b, a);
    } else {
      steerPairAt(a, b);
      steerPairAt(b, a);
    }
  }
  const sel = G.selected;
  if (sel) {
    const manualRudder = Math.abs(G.rudderInput) > 0.02 || G.keys['ArrowLeft'] || G.keys['ArrowRight'] || G.keys['a'] || G.keys['d'];
    if (manualRudder && G.waypoint) { G.waypoint = null; msg('Waypoint cancelled — manual helm'); }
    const rudderKeys = (G.keys['ArrowLeft'] || G.keys['a'] ? -1 : 0) + (G.keys['ArrowRight'] || G.keys['d'] ? 1 : 0);
    const rudderTarget = manualRudder ? (G.rudderInput !== 0 ? G.rudderInput * 35 : rudderKeys * 35) : (G.waypoint ? wpRudderFor(sel) : 0);
    if (G.mode === 'FLEET') {
      if (!inCollidePair(sel)) driveCarrier(sel, dt, rudderTarget, true);
      for (const c of G.playerFleet) if (c !== sel && c.alive && !inCollidePair(c)) escortControl(c, sel, dt);
    } else if (G.mode === 'INDV') {
      if (!inCollidePair(sel)) driveCarrier(sel, dt, rudderTarget, true);
      for (const c of G.playerFleet) if (c !== sel && c.alive && !inCollidePair(c)) { c.forwardSpeed += (0 - c.forwardSpeed) * Math.min(1, dt * 0.5); c.x += c.vx * dt; c.z += c.vz * dt; }
    } else { // ANCHOR: selected holds, the rest are driven together
      for (const c of G.playerFleet) {
        if (inCollidePair(c)) continue;
        if (c === sel) { c.forwardSpeed += (0 - c.forwardSpeed) * Math.min(1, dt * 0.5); }
        else driveCarrier(c, dt, keepOutRudder(c, G.waypoint ? wpRudderFor(c) : 0), true);
      }
    }
    if (G.waypoint) {
      const d = Math.hypot(G.waypoint.x - sel.x, G.waypoint.z - sel.z);
      if (d < 100) { G.waypoint = null; msg('Waypoint reached'); }
    }
  }
  // Enemy flagship steers toward the player fleet; enemy escorts follow.
  const eFlag = G.enemyFleet.find(c => c.alive);
  if (eFlag) {
    // (c) Enemy side: when their flagship dies the flag role passes to
    // the next live carrier, and slots are re-derived around it (as for
    // the player) so the escorts keep their formation instead of
    // steering at stale offsets — they never sit frozen.
    if (G.enemyFlag !== eFlag) {
      if (G.enemyFlag) rederiveSlots(eFlag, G.enemyFleet);
      G.enemyFlag = eFlag;
    }
    const pFlag = G.playerFleet.find(c => c.alive);
    if (pFlag) {
      const want = Math.atan2(pFlag.x - eFlag.x, -(pFlag.z - eFlag.z));
      let dh = want - eFlag.heading;
      dh = ((dh + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      const rud = keepOutRudder(eFlag, clamp(dh * 1.5, -1, 1) * 35);
      if (!inCollidePair(eFlag)) eFlag.telegraphIdx = 1; // FULL (pair members keep their forced notch)
      if (!inCollidePair(eFlag)) driveCarrier(eFlag, dt, rud, true);
      for (const c of G.enemyFleet) if (c !== eFlag && c.alive && !inCollidePair(c)) escortControl(c, eFlag, dt);
    }
  } else {
    G.enemyFlag = null;
  }
}

// ---------- Camera (Pandora OrbitCamera helpers, ported) ----------
// orbitCameraPosition: yaw 0 = south (+Z), positive yaw -> +X.
// applyCameraFloor: clear the sea under the camera (+3) and under the
// midpoint (+5), never below target + 2. Deck ceiling 4 m (Pandora) is
// not applied here — the target is the carrier, not a jet on its deck.
function orbitPos(target, yaw, pitch, dist) {
  return new THREE.Vector3(
    target.x + Math.sin(yaw) * Math.cos(pitch) * dist,
    target.y + Math.sin(pitch) * dist,
    target.z + Math.cos(yaw) * Math.cos(pitch) * dist);
}
function cameraTarget() {
  if (G.camTac) return G.camTac;
  if (G.camFollow) return G.camFollow.group ? { x: G.camFollow.x, y: G.camFollow.y, z: G.camFollow.z } : G.camFollow;
  const s = G.selected;
  return s ? { x: s.x, y: s.y, z: s.z } : { x: 0, y: 350, z: 0 };
}
function updateCamera(dt) {
  const t = cameraTarget();
  const tx = t.x + G.camPan.x, ty = t.y + G.camPan.y, tz = t.z; // camPan is {x, y}: x = lateral, y = vertical; no z component
  const want = orbitPos({ x: tx, y: ty, z: tz }, G.camYaw, G.camPitch, G.camDist);
  const seaH = G.sea.waveHeight(want.x, want.z, G.time);
  const midX = (want.x + tx) / 2, midZ = (want.z + tz) / 2;
  const midSea = G.sea.waveHeight(midX, midZ, G.time);
  const floor = Math.max(seaH + 3, midSea + 5, ty + 2);
  if (want.y < floor) want.y = floor;
  const k = 1 - Math.exp(-dt * 6);
  G.camera.position.lerp(want, k);
  G.camera.lookAt(tx, ty, tz);
  // Shake (Hurricane L4586): applied as a small offset.
  if (G.vfx.shake > 0.3) {
    G.camera.position.x += (Math.random() - 0.5) * G.vfx.shake * 0.12;
    G.camera.position.y += (Math.random() - 0.5) * G.vfx.shake * 0.12;
  }
}
function cycleTactical() {
  const jets = [];
  for (const c of G.allCarriers) if (c.wing) for (const s of c.wing.squadrons) for (const j of s.jets) if (['climb', 'ingress', 'attack', 'egress', 'rtb', 'trap'].includes(j.state)) jets.push(j);
  const ord = [...G.bombs, ...G.missiles].filter(o => o.alive);
  const carriers = G.allCarriers.filter(c => c.alive);
  const modes = [['fleet', null], ['jet', jets[0] || null], ['ordnance', ord[0] || null], ['carrier', carriers[0] || null]];
  G.camTacIdx = (G.camTacIdx + 1) % modes.length;
  const [name, tgt] = modes[G.camTacIdx];
  if (name === 'fleet') { G.camTac = null; $('btnCam').textContent = 'Camera: fleet [C]'; return; }
  if (!tgt) { G.camTacIdx = 0; G.camTac = null; $('btnCam').textContent = 'Camera: fleet [C]'; return; }
  G.camTac = tgt;
  $('btnCam').textContent = 'Camera: ' + name + ' [C]';
}

// ---------- HUD ----------
function zoneLine(c) {
  const z = c.zones;
  const podLine = 'Pods ' + c.pods.map(p => p.alive ? '●' : '✕').join('');
  const f = (k, label) => `<b>${label}</b> ${Math.round(z[k].hp / z[k].max * 100)}%`;
  const fires = c.fires.map(f => `<span class="fire">🔥${f.zone.replace('pod:', 'pod ')}</span>`).join(' ');
  return `${podLine}<br>${f('reactor', 'Rct')} · ${f('magazine', 'Mag')} · ${f('bridge', 'Brg')} · ${f('deck', 'Deck')} · ${f('engines', 'Eng')}${fires ? '<br>' + fires : ''}`;
}
function carrierRowHTML(c, selectable) {
  const cls = 'carrierRow' + (G.selected === c ? ' sel' : '') + (c.state === 'gone' || c.state === 'sinking' ? ' dead' : '');
  const hpCls = c.hpFrac > 0.6 ? '' : c.hpFrac > 0.3 ? ' hurt' : ' crit';
  const wing = c.wing ? ` · ✈ ${c.wing.remaining} jets (${c.wing.airborneCount()} up)` + (c.wing.squadrons.some(s => s.state === 'launchQueued') ? ' · LAUNCH QUEUED' : '') : '';
  return `<div class="${cls}" data-cid="${c.id}">
    <h4><span>${c.name}</span><span>${c.state === 'alive' ? Math.round(c.hpFrac * 100) + '%' : c.state.toUpperCase()}</span></h4>
    <div class="bar${hpCls}"><i style="width:${Math.round(c.hpFrac * 100)}%"></i></div>
    <div class="zones">Lift ${Math.round(c.lift * 100)}% · Alt ${Math.round(c.y)} m · Spd ${Math.abs(c.forwardSpeed).toFixed(0)} m/s${wing}<br>${zoneLine(c)}</div>
  </div>`;
}
function renderFleetPanels() {
  $('fleetRows').innerHTML = G.playerFleet.map(c => carrierRowHTML(c)).join('');
  $('enemyRows').innerHTML = G.enemyFleet.map(c => carrierRowHTML(c)).join('');
  document.querySelectorAll('.carrierRow').forEach(el => {
    el.addEventListener('click', () => {
      const c = G.allCarriers.find(x => x.id === +el.dataset.cid);
      if (!c) return;
      if (c.side === 'player') switchShip(c);
      else { G.targetCarrier = c; G.targetMode = 'designated'; $('btnTarget').textContent = 'Target: ' + c.name; msg('Target designated: ' + c.name); }
    });
  });
}
function updateTeleBox() {
  const t = TELEGRAPH[G.telegraphIdx];
  $('teleNotch').textContent = t.name;
  const s = G.selected;
  $('teleSub').textContent = (s ? Math.abs(s.forwardSpeed).toFixed(0) + ' m/s · rudder ' + Math.round(s.rudderDeg) + '°' : '—');
  $('modeBtn').textContent = G.mode;
}
function updateStatus() {
  const s = G.selected;
  if (!s) return;
  $('statusLine').textContent =
    `${s.name} · ALT ${Math.round(s.y)} m (target ${Math.round(s.targetAlt)}) · SPD ${Math.abs(s.forwardSpeed).toFixed(0)} m/s · ` +
    `TELEGRAPH ${TELEGRAPH[s.telegraphIdx].name} · MODE ${G.mode} · ${STAGES[G.stage].name} sea (Hs ${G.sea.HS.toFixed(1)} m) · ` +
    `✈ ${G.playerFleet.reduce((a, c) => a + (c.wing ? c.wing.remaining : 0), 0)} jets left · ` +
    `Bombs ${G.bombStats.drops} dropped / ${G.bombStats.hits} hits`;
}

// ---------- Minimap ----------
function drawMinimap() {
  const cv = $('minimap'), g = cv.getContext('2d');
  const W = cv.width, R = 4200; // world half-range shown
  const px = x => (x / R * 0.5 + 0.5) * W;
  const pz = z => (z / R * 0.5 + 0.5) * W;
  g.fillStyle = '#0d2839'; g.fillRect(0, 0, W, W);
  g.strokeStyle = 'rgba(140,200,230,.15)';
  for (let i = 1; i < 4; i++) { g.beginPath(); g.arc(W / 2, W / 2, W / 2 * i / 4, 0, Math.PI * 2); g.stroke(); }
  const drawCarrier = (c, color) => {
    g.save();
    g.translate(px(c.x), pz(c.z));
    g.rotate(c.heading); // canvas: nose-up triangle rotated by heading (0 = -Z = up)
    g.fillStyle = color;
    g.beginPath(); g.moveTo(0, -14); g.lineTo(9, 10); g.lineTo(-9, 10); g.closePath(); g.fill();
    g.restore();
    if (c.state === 'gone') { g.strokeStyle = color; g.beginPath(); g.arc(px(c.x), pz(c.z), 8, 0, Math.PI * 2); g.stroke(); }
  };
  for (const c of G.playerFleet) drawCarrier(c, G.selected === c ? '#ffd166' : '#58c98a');
  for (const c of G.enemyFleet) drawCarrier(c, '#e4572e');
  g.fillStyle = '#dfeef5';
  for (const c of G.allCarriers) if (c.wing) for (const s of c.wing.squadrons) for (const j of s.jets) if (['climb', 'ingress', 'attack', 'egress', 'rtb', 'trap'].includes(j.state)) g.fillRect(px(j.x) - 1, pz(j.z) - 1, 3, 3);
  if (G.waypoint) {
    g.strokeStyle = '#ffd166'; g.lineWidth = 2;
    g.beginPath(); g.arc(px(G.waypoint.x), pz(G.waypoint.z), 7, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(px(G.waypoint.x) - 10, pz(G.waypoint.z)); g.lineTo(px(G.waypoint.x) + 10, pz(G.waypoint.z)); g.stroke();
  }
}

// ---------- Combat / AI ----------
function nearestEnemyCarrier(from) {
  let best = null, bd = 1e18;
  for (const e of G.enemyFleet) {
    if (!e.alive) continue;
    const d = Math.hypot(e.x - from.x, e.z - from.z);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}
function currentTarget() {
  if (G.targetMode === 'designated' && G.targetCarrier && G.targetCarrier.alive) return G.targetCarrier;
  return nearestEnemyCarrier(G.selected || G.playerFleet.find(c => c.alive) || G.playerFleet[0]);
}
function launchPlayer(loadout) {
  const carrier = G.selected && G.selected.alive ? G.selected : G.playerFleet.find(c => c.alive);
  if (!carrier) { msg('No live carrier to launch from'); return; }
  const tgt = currentTarget();
  if (!tgt) { msg('No enemy carrier left to strike'); return; }
  const ok = carrier.wing.launch(loadout, tgt, makeCtx());
  msg(ok === true ? `${carrier.name} launching ${loadout === 'asm' ? 'ASM' : 'bomb'} flight at ${tgt.name}`
    : ok === 'queued' ? `${carrier.name}: catapult busy — flight QUEUED, launches when the first flight is clear`
    : `${carrier.name}: cannot launch (deck busy / wing exhausted / deck damaged)`);
  renderFleetPanels();
}
function enemyDirector(dt) {
  if (G.enemyAI !== 'auto' || G.over) return;
  for (const e of G.enemyFleet) {
    if (!e.alive || !e.wing) continue;
    let t = (G.enemyTimers.get(e.id) || 0) - dt;
    if (t <= 0) {
      const tgt = G.playerFleet.filter(c => c.alive).sort((a, b) => Math.hypot(a.x - e.x, a.z - e.z) - Math.hypot(b.x - e.x, b.z - e.z))[0];
      if (tgt) {
        const loadout = (G.enemyLoadout.get(e.id) || 'bomb') === 'bomb' ? 'asm' : 'bomb';
        G.enemyLoadout.set(e.id, loadout);
        e.wing.launch(loadout, tgt, makeCtx());
      }
      t = SKILLS[G.skill].launchInterval * (0.8 + Math.random() * 0.4);
    }
    G.enemyTimers.set(e.id, t);
  }
}
function checkEnd() {
  if (G.over) return;
  // A carrier counts as destroyed only when its wreck is fully gone:
  // breakup sets state='gone' at once, but the pieces are still falling
  // and sinking — the round must not end while wreckage is in the air.
  const destroyed = c => c.state === 'gone' && c.pieces.length === 0;
  // (e) Survivors are carriers in state 'alive' ONLY. A carrier that is
  // falling/sinking is doomed, not a survivor — and while one is still
  // falling/sinking the outcome is undecided, so the round waits for it
  // to resolve instead of ending early on a wrong count. In particular
  // both fleets gone at once is NOT a victory: it is a draw.
  const pAlive = G.playerFleet.some(c => c.state === 'alive');
  const eAlive = G.enemyFleet.some(c => c.state === 'alive');
  const pDestroyed = G.playerFleet.every(destroyed);
  const eDestroyed = G.enemyFleet.every(destroyed);
  if (pDestroyed && eDestroyed) return endGame('draw');
  if (eDestroyed && pAlive) return endGame('win');
  if (pDestroyed && eAlive) return endGame('lose');
  // Otherwise the round is still live, or a carrier is still
  // falling/sinking/breaking up with the outcome undecided — wait.
}
function endGame(result) {
  G.over = true;
  G.endResult = result;
  // Survivors: 'alive' only — a falling/sinking carrier is not one.
  const pSurv = G.playerFleet.filter(c => c.state === 'alive').length;
  const eSurv = G.enemyFleet.filter(c => c.state === 'alive').length;
  if (result === 'win') {
    $('endTitle').textContent = '🏆 VICTORY';
    $('endTitle').style.color = '#ffd166';
    $('endText').textContent = `All enemy helicarriers destroyed. ${pSurv} of your carriers survived.`;
  } else if (result === 'lose') {
    $('endTitle').textContent = '💥 DEFEAT';
    $('endTitle').style.color = '#e4572e';
    $('endText').textContent = `Your fleet is gone. The sea keeps the wreckage. ${eSurv} enemy carrier${eSurv === 1 ? '' : 's'} survived.`;
  } else { // draw — both fleets gone at once is not a victory
    $('endTitle').textContent = '💥 MUTUAL DESTRUCTION';
    $('endTitle').style.color = '#e8b13c';
    $('endText').textContent = 'Both fleets are gone — mutual destruction. No carriers survived.';
  }
  $('endOverlay').style.display = 'flex';
}

function makeCtx() {
  return {
    scene: G.scene, sea: G.sea, vfx: G.vfx, time: G.time,
    bombs: G.bombs, missiles: G.missiles,
    msg, onCarrierLost: (c) => { ensureLiveCommand(c); renderFleetPanels(); checkEnd(); },
    bombLog: (hit, along, across, by) => {
      G.bombStats.drops++;
      if (hit) G.bombStats.hits++;
      G.bombStats.log.push({ hit, along, across, by: by || null });
      if (G.bombStats.log.length > 200) G.bombStats.log.shift();
    },
  };
}

// ---------- Input ----------
function bindInput() {
  const cv = G.renderer.domElement;
  let dragging = false, lastX = 0, lastY = 0, moved = 0, shiftDrag = false;
  let pinchD = 0;
  cv.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch' && e.isPrimary === false) return;
    dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY;
    shiftDrag = e.shiftKey;
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    if (shiftDrag) {
      G.camPan.x = clamp(G.camPan.x + dx * 2, -1500, 1500);
      G.camPan.y = clamp(G.camPan.y - dy * 2, -400, 800);
    } else {
      G.camYaw -= dx * 0.005;
      G.camPitch = clamp(G.camPitch - dy * 0.005, -0.1, 1.2);
    }
  });
  cv.addEventListener('pointerup', e => {
    dragging = false;
    if (moved < 6) clickPick(e.clientX, e.clientY);
  });
  cv.addEventListener('pointercancel', () => { dragging = false; });
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    G.camDist = clamp(G.camDist * (1 + e.deltaY * 0.0006), 120, 4000);
  }, { passive: false });
  cv.addEventListener('contextmenu', e => e.preventDefault());
  // Touch pinch
  let touches = new Map();
  cv.addEventListener('touchstart', e => {
    for (const t of e.changedTouches) touches.set(t.identifier, { x: t.clientX, y: t.clientY });
    if (touches.size === 2) { const [a, b] = [...touches.values()]; pinchD = Math.hypot(a.x - b.x, a.y - b.y); }
  }, { passive: true });
  cv.addEventListener('touchmove', e => {
    for (const t of e.changedTouches) if (touches.has(t.identifier)) touches.set(t.identifier, { x: t.clientX, y: t.clientY });
    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchD > 0) G.camDist = clamp(G.camDist * (pinchD / d), 120, 4000);
      pinchD = d;
    }
  }, { passive: true });
  cv.addEventListener('touchend', e => { for (const t of e.changedTouches) touches.delete(t.identifier); pinchD = 0; });

  // Joystick (phone-first rudder)
  const joy = $('joy'), knob = $('joyKnob');
  let joyId = null;
  const joyMove = e => {
    const r = joy.getBoundingClientRect();
    let dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    dx = clamp(dx, -1, 1);
    G.rudderInput = dx;
    knob.style.left = (40 + dx * 38) + 'px';
  };
  joy.addEventListener('pointerdown', e => { joyId = e.pointerId; joy.setPointerCapture(e.pointerId); joyMove(e); });
  joy.addEventListener('pointermove', e => { if (e.pointerId === joyId) joyMove(e); });
  const joyEnd = () => { joyId = null; G.rudderInput = 0; knob.style.left = '40px'; };
  joy.addEventListener('pointerup', joyEnd);
  joy.addEventListener('pointercancel', joyEnd);

  // Minimap click = waypoint
  $('minimap').addEventListener('click', e => {
    const r = $('minimap').getBoundingClientRect();
    const wx = ((e.clientX - r.left) / r.width * 2 - 1) * 4200;
    const wz = ((e.clientY - r.top) / r.height * 2 - 1) * 4200;
    G.waypoint = { x: wx, z: wz };
    msg(`Waypoint set (${Math.round(wx)}, ${Math.round(wz)}) — fleet steering there`);
  });

  addEventListener('keydown', e => {
    if (!G.started) return;
    G.keys[e.key] = true;
    if (e.key === 'Tab') { e.preventDefault(); cycleShip(); }
    if (e.key >= '1' && e.key <= '8') setTelegraph(+e.key - 1);
    if (e.key === 'w' || e.key === 'W') setTelegraph(G.telegraphIdx - 1);
    if (e.key === 's' || e.key === 'S') setTelegraph(G.telegraphIdx + 1);
    if (e.key === 'q' || e.key === 'Q') adjustAlt(25);
    if (e.key === 'e' || e.key === 'E') adjustAlt(-25);
    if (e.key === 'r' || e.key === 'R') resetCamera();
    if (e.key === 'c' || e.key === 'C') cycleTactical();
  });
  addEventListener('keyup', e => { G.keys[e.key] = false; });

  $('btnLaunchBomb').addEventListener('click', () => launchPlayer('bomb'));
  $('btnLaunchAsm').addEventListener('click', () => launchPlayer('asm'));
  $('btnRecall').addEventListener('click', () => { for (const c of G.playerFleet) if (c.wing) c.wing.recallAll(); msg('Wings recalled'); });
  $('btnTarget').addEventListener('click', () => {
    if (G.targetMode === 'nearest') {
      const alive = G.enemyFleet.filter(c => c.alive);
      if (alive.length) { G.targetMode = 'designated'; G.targetCarrier = alive[0]; $('btnTarget').textContent = 'Target: ' + alive[0].name; }
    } else {
      const alive = G.enemyFleet.filter(c => c.alive);
      const i = alive.indexOf(G.targetCarrier);
      const next = alive[(i + 1) % alive.length];
      if (next) { G.targetCarrier = next; $('btnTarget').textContent = 'Target: ' + next.name; }
      else { G.targetMode = 'nearest'; $('btnTarget').textContent = 'Target: nearest'; }
    }
  });
  $('btnCam').addEventListener('click', cycleTactical);
  $('btnAltUp').addEventListener('click', () => adjustAlt(25));
  $('btnAltDn').addEventListener('click', () => adjustAlt(-25));
  $('teleUp').addEventListener('click', () => setTelegraph(G.telegraphIdx - 1));
  $('teleDn').addEventListener('click', () => setTelegraph(G.telegraphIdx + 1));
  $('modeBtn').addEventListener('click', () => {
    G.mode = G.mode === 'FLEET' ? 'INDV' : G.mode === 'INDV' ? 'ANCHOR' : 'FLEET';
    msg('Steering mode: ' + G.mode + (G.mode === 'ANCHOR' ? ' (selected ship holds, rest driven)' : G.mode === 'INDV' ? ' (selected ship only)' : ' (flagship + escorts)'));
    updateTeleBox();
  });
  $('btnAgain').addEventListener('click', () => location.reload());
}
function cycleShip() {
  const alive = G.playerFleet.filter(c => c.alive);
  if (!alive.length) return;
  const i = alive.indexOf(G.selected);
  switchShip(alive[(i + 1) % alive.length]);
}
function adjustAlt(d) {
  if (!G.selected) return;
  G.selected.targetAlt = clamp(G.selected.targetAlt + d, 200, 600);
  msg(`${G.selected.name} target altitude ${Math.round(G.selected.targetAlt)} m`);
}
function resetCamera() {
  G.camYaw = 0.6; G.camPitch = 0.32; G.camDist = 1100;
  G.camPan = { x: 0, y: 0 }; G.camTac = null; G.camTacIdx = 0; G.camFollow = G.selected;
  $('btnCam').textContent = 'Camera: fleet [C]';
}
function clickPick(cx, cy) {
  // Click a carrier to follow it (raycast against carrier groups).
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, G.camera);
  const hits = ray.intersectObjects(G.allCarriers.map(c => c.group), true);
  if (hits.length) {
    let o = hits[0].object;
    while (o && !o.userData.carrier) o = o.parent;
    const c = o && o.userData.carrier;
    if (c && c.state !== 'gone') {
      G.camFollow = c;
      if (c.side === 'player') switchShip(c);
      else { G.targetCarrier = c; G.targetMode = 'designated'; $('btnTarget').textContent = 'Target: ' + c.name; }
      msg('Following ' + c.name + (c.state === 'sinking' || c.state === 'falling' ? ' — she is going down' : ''));
    }
  }
}

// ---------- Debug hooks ----------
function bindDebug() {
  if (!DEBUG) return;
  $('debugPanel').classList.add('on');
  $('dbgKillEnemy').addEventListener('click', () => killCarrier(G.enemyFleet[0], 'reactor'));
  $('dbgKillPlayer').addEventListener('click', () => killCarrier(G.playerFleet[0], 'reactor'));
  $('dbgPod').addEventListener('click', () => {
    const c = G.selected;
    const pod = c.pods.find(p => p.alive);
    if (pod) { pod.hp = 0; pod.alive = false; pod.meshes.forEach(m => { m.visible = false; }); msg(`${c.name}: lift pod destroyed (debug) — lift ${Math.round(c.lift * 100)}%`); renderFleetPanels(); }
  });
  $('dbgFire').addEventListener('click', () => { G.selected.ignite('deck', 0, 50); msg('Deck fire started (debug)'); });
  $('dbgBombProbe').addEventListener('click', runBombProbe);
  $('dbgCollide').addEventListener('click', () => { if (forceCollisionCourse('headon')) msg('Forced collision: flagships head-on at FLANK'); });
  $('dbgHeal').addEventListener('click', () => {
    for (const c of G.playerFleet) {
      c.pods.forEach(p => { p.hp = 100; if (!p.alive) { p.alive = true; p.meshes.forEach(m => { m.visible = true; }); } });
      for (const k in c.zones) c.zones[k].hp = c.zones[k].max;
      c.fires = [];
      if (c.state !== 'alive') { c.state = 'alive'; c.group.visible = true; c.y = c.targetAlt; }
    }
    msg('Player fleet repaired (debug)'); renderFleetPanels();
  });
  $('dbgTime').addEventListener('click', () => { G.timeScale = G.timeScale === 1 ? 4 : 1; msg('Time scale ×' + G.timeScale); });
}
function killCarrier(c, zone) {
  if (!c || c.state !== 'alive') return;
  if (zone === 'reactor') c.damage(500, 0, 0, false, makeCtx());
  else c.startFall(makeCtx(), 'debug kill');
}
function runBombProbe() {
  const res = bombBallisticsProbe(20, 3);
  const el = $('probeOut');
  el.classList.add('on');
  const fmt = (label, r) => `${label}: ${r.hits}/${r.drops} hits (${Math.round(r.rate * 100)}%), mean along ${r.meanAlong.toFixed(1)} m, mean across ${r.meanAcross.toFixed(1)} m`;
  el.textContent =
    'BOMB BALLISTICS PROBE — release 60 m above deck / 100 m out, dive 190 m/s @ 30 deg, target 20 m/s, aim err ±3 m\n' +
    fmt('Leader ', res.leader) + '\n' + fmt('Wingman', res.wingman) +
    `\nGeometry: ${JSON.stringify(res.geometry)}` +
    `\nLive drops this round: ${G.bombStats.drops} dropped / ${G.bombStats.hits} hits` +
    `\nVerdict: ${res.leader.rate >= 0.8 && res.wingman.rate >= 0.8 && Math.abs(res.leader.rate - res.wingman.rate) <= 0.15 ? 'PASS — wingman hits at a comparable rate to the leader' : 'CHECK — rates diverge, see numbers above'}`;
  window.__probeResult = res;
}

// ---------- Start / main loop ----------
function readMenu() {
  const seg = (id) => { const b = document.querySelector(`#${id} button.on`); return b ? b.dataset.v : null; };
  G.playerN = +(seg('segPlayerFleet') || 4);
  G.enemyN = +(seg('segEnemyFleet') || 4);
  G.skill = seg('segSkill') || 'veteran';
  G.stage = +(seg('segStage') || 0);
  G.form = seg('segForm') || 'C';
  G.baseAlt = +$('selAlt').value;
  G.enemyAI = $('selEnemyAI').value;
}
async function startGame() {
  readMenu();
  if (params.has('fleet')) G.playerN = G.enemyN = +params.get('fleet');
  if (params.has('skill')) G.skill = params.get('skill');
  if (params.has('stage')) G.stage = params.get('stage') === 'storm' ? 2 : params.get('stage') === 'rough' ? 1 : 0;
  $('menu').style.display = 'none';
  $('hud').classList.add('on');
  initScene();
  G.sea.setStage(G.stage);
  try {
    G.models = await loadModels();
  } catch (err) {
    $('loadErr').style.display = 'flex';
    $('loadErrText').textContent = 'GLB load failed: ' + (err && err.message ? err.message : err) + '\nModels are embedded as base64 modules (assets/helicarrier.b64.js, assets/fa18.b64.js). Check they exist and the page is served over HTTP.';
    throw err;
  }
  G.playerFleet = spawnFleet('player', G.playerN, 1500, 0);
  G.enemyFleet = spawnFleet('enemy', G.enemyN, -1500, Math.PI);
  G.allCarriers = [...G.playerFleet, ...G.enemyFleet];
  G.selected = G.playerFleet[0];
  G.camFollow = G.selected;
  G.telegraphIdx = 1; // FULL
  for (const c of G.playerFleet) c.telegraphIdx = 1;
  bindInput();
  bindDebug();
  renderFleetPanels();
  updateTeleBox();
  msg(`Fleet launched — ${G.playerN}v${G.enemyN}, ${SKILLS[G.skill].label} enemy, ${STAGES[G.stage].name} sea. Launch a flight to strike.`);
  G.started = true;
  window.__game = G; // debug handle for the verification agent
  window.__bombBallisticsProbe = bombBallisticsProbe;
  if (params.has('timescale')) G.timeScale = clamp(+params.get('timescale') || 1, 1, 8);
  // Debug URL hooks
  if (params.has('collide')) forceCollisionCourse(params.get('collide') === '1' ? 'headon' : params.get('collide'));
  if (params.get('kill') === '1') setTimeout(() => killCarrier(G.enemyFleet[0], 'reactor'), 3000);
  if (params.get('killplayer') === '1') setTimeout(() => killCarrier(G.playerFleet[0], 'reactor'), 3000);
  if (params.get('probe') === 'bombs') setTimeout(runBombProbe, 1500);
  if (params.get('autostart') === '1' && G.enemyAI === 'auto') { /* enemy director runs anyway */ }
  requestAnimationFrame(loop);
  // HUD refresh
  setInterval(() => { if (G.started) { renderFleetPanels(); updateStatus(); updateTeleBox(); } }, 500);
}

let lastT = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  // dt clamp 0.10 s: at low frame rates (software rendering in a probe)
  // game time still tracks wall time at ~0.5x instead of stalling; the
  // flight/damage integrators stay stable at 0.1 s steps.
  const rawDt = Math.min(0.10, (now - lastT) / 1000);
  lastT = now;
  const dt = rawDt * G.timeScale;
  G.time += dt;
  if (G.msgT > 0) { G.msgT -= rawDt; if (G.msgT <= 0) $('msg').textContent = '—'; }
  // Post-game freeze (Job B): once G.over is set, the world stops — no
  // steering, carrier/wing, ordnance or director updates — so the frozen
  // scene stays exactly the end state the overlay describes (a survivor
  // can no longer die behind the overlay). Rendering, the sea, VFX
  // decay, camera orbit and the overlay itself keep running below.
  // The freeze starts at endGame, never before: checkEnd only ends the
  // round once every wreck's pieces have resolved, so the
  // wait-for-pieces-to-sink rule is untouched.
  if (!G.over) {
    updateSteering(dt);
    const ctx = makeCtx();
    for (const c of G.allCarriers) c.update(dt, ctx);
    for (const c of G.allCarriers) if (c.wing) c.wing.update(dt, ctx);
    checkCarrierCollisions(G, ctx, dt);
    // Release a forced collision course after the first impact: normal
    // steering (incl. the 600 m keep-out) takes over so the carriers
    // separate instead of ramming each other again on the next frame.
    if (G.collidePair && G.collLog.some(e => (e.kind === 'impact' || e.kind === 'catastrophic') &&
        G.collidePair.some(c => c.id === e.aId) && G.collidePair.some(c => c.id === e.bId))) {
      G.collidePair = null;
      msg('Collision course released — carriers separating');
    }
    for (const b of G.bombs) b.update(dt);
    G.bombs = G.bombs.filter(b => b.alive);
    for (const m of G.missiles) m.update(dt);
    G.missiles = G.missiles.filter(m => m.alive);
    enemyDirector(dt);
    checkEnd(); // every frame: a breakup's pieces take ~40 s of game time to sink
  }
  // (c) Keep a command-transfer announcement on screen for 8 s of game
  // time — it must survive the flurry of loss messages around a sinking.
  if (G.transferAnnounce) {
    if (G.time < G.transferAnnounce.until && !G.over) { $('msg').textContent = G.transferAnnounce.text; G.msgT = 4; }
    else G.transferAnnounce = null;
  }
  // Ocean follows the midpoint of the action; wakes only for hulls at the water.
  const alive = G.allCarriers.filter(c => c.state !== 'gone');
  const fx = alive.reduce((a, c) => a + c.x, 0) / Math.max(1, alive.length);
  const fz = alive.reduce((a, c) => a + c.z, 0) / Math.max(1, alive.length);
  const wakeShips = G.allCarriers.filter(c => c.y < 60).map(c => ({ x: c.x, z: c.z, heading: c.heading, forwardSpeed: c.forwardSpeed, len: CARRIER_LEN, beam: 70 }));
  G.sea.update(G.time, dt, fx, fz, wakeShips);
  G.vfx.update(dt);
  updateCamera(rawDt);
  drawMinimap();
  if (DEBUG) {
    $('dbgInfo').textContent = `t=${G.time.toFixed(0)}s · jets up ${G.allCarriers.reduce((a, c) => a + (c.wing ? c.wing.airborneCount() : 0), 0)} · bombs ${G.bombs.length} · missiles ${G.missiles.length} · parts steal: P ${G.vfx.pCursor}/${1600} S ${G.vfx.spCursor}/${420}`;
  }
  G.renderer.render(G.scene, G.camera);
}

// ---------- Menu wiring ----------
document.querySelectorAll('.seg').forEach(seg => {
  seg.addEventListener('click', e => {
    if (e.target.tagName !== 'BUTTON') return;
    seg.querySelectorAll('button').forEach(b => b.classList.remove('on'));
    e.target.classList.add('on');
  });
});
$('startBtn').addEventListener('click', () => { startGame().catch(err => console.error(err)); });

// Autostart for verification (?autostart=1): skip the menu with defaults.
if (params.get('autostart') === '1') {
  startGame().catch(err => console.error(err));
}
window.__booted = true;

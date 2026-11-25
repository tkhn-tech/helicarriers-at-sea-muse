// game.js — Helicarriers at Sea v1: bootstrap, fleet steering (Hurricane
// telegraph/modes/formation/waypoint, metric), free-orbit camera (Pandora
// OrbitCamera helpers, ported), HUD, minimap, enemy AI director, debug hooks.
import * as THREE from 'three';
import { Sea, STAGES } from './sea.js';
import { VFX } from './vfx.js';
import { Helicarrier, loadModels, CARRIER_LEN } from './carrier.js';
import { checkCarrierCollisions } from './collisions.js';
import { AirWing, AirBomb, AntiShipMissile, bombBallisticsProbe, JET_CRUISE_SPEED, predictBombImpact } from './jets.js';
import { GameAudio } from './audio.js';
import { AirDefenseSystem } from './airdefense.js';

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
  // v1.2.0 spectate (Hurricane v11.15 flow): the destroyed carrier the
  // camera follows through the fall/breakup/splash/sinking. Command and
  // the helm stay with the selected live carrier — spectate never locks
  // them. Null = follow the selected carrier as usual.
  camSpectate: null,
  // v1.2.0 pitch: spring-return pitch-track value, -1..1 (+ = nose up).
  pitchTrack: 0,
  rudderInput: 0, keys: {},
  enemyTimers: new Map(), enemyLoadout: new Map(),
  over: false, bombStats: { drops: 0, hits: 0, log: [] },
  msgT: 0,
  // v1.3.0
  paused: false, audio: null, airDefense: null,
  weatherProg: 'fixed', sailedDist: 0, lastFlagPos: null,
  freakT: 45, freakMesh: null, lightningT: 12, flashT: 0, pendingThunder: 0,
  ccip: [], ccipMeshes: [],
  tacMode: null, tacKind: null, tacTarget: null, tacHoldPos: null, tacHoldUntil: 0,
  tacJetsIdx: -1, tacOrdIdx: -1,
  best: null, attract: false, attractT: 0, alarmCool: 0,
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
  // v1.3.0 (I) CCIP rings: gold (leader) + white (wingman), hidden until a dive.
  G.ccipMeshes = [];
  for (let i = 0; i < 2; i++) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(8, 11, 32),
      new THREE.MeshBasicMaterial({ color: i === 0 ? 0xffd166 : 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    scene.add(ring);
    G.ccipMeshes.push(ring);
  }
  // v1.3.0 (D) freak-wave crest wall: a translucent wall that travels
  // with the crest, oriented across its direction of travel.
  const fwGeo = new THREE.PlaneGeometry(700, 20, 24, 1);
  const fwMat = new THREE.MeshBasicMaterial({ color: 0xbfe3f0, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false });
  G.freakMesh = new THREE.Mesh(fwGeo, fwMat);
  G.freakMesh.visible = false;
  scene.add(G.freakMesh);
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
  G.camSpectate = null; // v1.2.0: tapping another live ship exits spectate
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
  // v1.2.0 pitch: spring-return track + ArrowUp/Down combine into one
  // pitch command on the selected carrier, every frame. The track and
  // the rudder each own their pointer, so both can be driven at once.
  if (G.selected) {
    const keyPitch = (G.keys['ArrowUp'] ? 1 : 0) + (G.keys['ArrowDown'] ? -1 : 0);
    G.selected.pitchInput = clamp(G.pitchTrack + keyPitch, -1, 1);
  }
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
  // v1.2.0 spectate (Hurricane v11.15): while a destroyed carrier is
  // falling, sinking, or breaking up, the camera follows HER — through
  // the fall, the breakup pieces, the splash and the sinking. The
  // follow ends by itself when the wreck is fully gone, and the camera
  // returns to the selected live carrier. Helm/telegraph/rudder are
  // untouched: they keep driving the selected carrier throughout.
  if (G.camSpectate) {
    const c = G.camSpectate;
    if (c.state === 'falling' || c.state === 'sinking') return { x: c.x, y: c.y, z: c.z };
    if (c.state === 'gone' && c.pieces.length) {
      const p = c.pieces[0];
      return { x: p.group.position.x, y: p.group.position.y, z: p.group.position.z };
    }
    G.camSpectate = null; // wreck resolved — back to the fleet
    renderFleetPanels();
  }
  // v1.3.0 (E) detonation hold: while the hold runs the camera frames
  // the blast point (wide — see updateCamera's hold distance boost).
  if (G.tacHoldPos) {
    if (G.time < G.tacHoldUntil) return { x: G.tacHoldPos.x, y: G.tacHoldPos.y, z: G.tacHoldPos.z };
    G.tacHoldPos = null;
    // Hold over: back to the tracked target if it is still valid,
    // otherwise back to the fleet.
    if (!tacTargetValid()) {
      G.tacMode = null; G.tacKind = null; G.tacTarget = null; G.camTac = null;
      $('btnCam').textContent = 'Camera: fleet [C]';
    } else {
      $('btnCam').textContent = 'Camera: ' + G.tacMode + ' [C]';
    }
  }
  // v1.3.0 (E): a tracked target that died / landed ends the track.
  if (G.camTac && G.tacTarget && !tacTargetValid()) {
    G.tacMode = null; G.tacKind = null; G.tacTarget = null; G.camTac = null;
    $('btnCam').textContent = 'Camera: fleet [C]';
  }
  if (G.camTac) return G.camTac;
  if (G.camFollow) return G.camFollow.group ? { x: G.camFollow.x, y: G.camFollow.y, z: G.camFollow.z } : G.camFollow;
  const s = G.selected;
  return s ? { x: s.x, y: s.y, z: s.z } : { x: 0, y: 350, z: 0 };
}
function updateCamera(dt) {
  const t = cameraTarget();
  const tx = t.x + G.camPan.x, ty = t.y + G.camPan.y, tz = t.z; // camPan is {x, y}: x = lateral, y = vertical; no z component
  // v1.3.0 (E): during a detonation hold the camera pulls back for a
  // wide framing of the blast, then eases back when the hold ends.
  const dist = G.tacHoldPos ? Math.max(G.camDist, 900) : G.camDist;
  const want = orbitPos({ x: tx, y: ty, z: tz }, G.camYaw, G.camPitch, dist);
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
  // v1.3.0 (E) TacticalCameraSystem (Hurricane v11.35): C steps through
  // EVERY airborne jet in order, then EVERY ordnance in flight, then
  // off. Within each category the index advances (next jet, next
  // missile/bomb) instead of always tracking the first one. A crashed
  // jet still in her dive stays trackable; a spin-out jet too.
  const jets = [];
  for (const c of G.allCarriers) if (c.wing) for (const s of c.wing.squadrons) for (const j of s.jets)
    if (['climb', 'ingress', 'attack', 'egress', 'rtb', 'trap', 'spinout', 'crashed'].includes(j.state) && j.group.visible) jets.push(j);
  const ord = [...G.bombs, ...G.missiles, ...(G.airDefense ? G.airDefense.sams : [])].filter(o => o.alive);
  const setBtn = (label) => { $('btnCam').textContent = 'Camera: ' + label + ' [C]'; };
  const clearTac = () => { G.tacMode = null; G.tacKind = null; G.tacTarget = null; G.camTac = null; G.tacJetsIdx = -1; G.tacOrdIdx = -1; };
  if (G.tacMode === 'jet') {
    G.tacJetsIdx++;
    if (G.tacJetsIdx < jets.length) {
      G.tacTarget = jets[G.tacJetsIdx]; G.camTac = G.tacTarget;
      setBtn(`jet ${G.tacJetsIdx + 1}/${jets.length}`);
      return;
    }
    // Jets exhausted — move to ordnance.
    G.tacMode = 'ordnance'; G.tacOrdIdx = 0;
    if (ord.length) { G.tacTarget = ord[0]; G.camTac = ord[0]; setBtn(`ordnance 1/${ord.length}`); return; }
    clearTac(); setBtn('fleet'); return;
  }
  if (G.tacMode === 'ordnance') {
    G.tacOrdIdx++;
    if (G.tacOrdIdx < ord.length) {
      G.tacTarget = ord[G.tacOrdIdx]; G.camTac = ord[G.tacOrdIdx];
      setBtn(`ordnance ${G.tacOrdIdx + 1}/${ord.length}`);
      return;
    }
    clearTac(); setBtn('fleet'); return;
  }
  // Not tracking: start with jets, else ordnance, else stay on fleet.
  if (jets.length) {
    G.tacMode = 'jet'; G.tacKind = 'jet'; G.tacJetsIdx = 0;
    G.tacTarget = jets[0]; G.camTac = jets[0];
    setBtn(`jet 1/${jets.length}`);
    return;
  }
  if (ord.length) {
    G.tacMode = 'ordnance'; G.tacKind = 'ordnance'; G.tacOrdIdx = 0;
    G.tacTarget = ord[0]; G.camTac = ord[0];
    setBtn(`ordnance 1/${ord.length}`);
    return;
  }
  clearTac(); setBtn('fleet');
  msg('No jets or ordnance airborne — launch a flight first');
}
// v1.3.0 (E): detonation hold (Hurricane TacticalCameraSystem
// noteDetonation). Only takes over while a track is active and the blast
// is near what we are watching; holds a wide framing of the blast for
// ~2.5 s before easing back to the track (or to the fleet if the target
// is gone). Helm stays live throughout — this only moves the camera.
function noteDetonation(x, y, z, kind) {
  if (!G.tacMode || G.tacHoldPos) return;
  const t = G.tacTarget;
  if (t) {
    const d = Math.hypot(t.x - x, t.z - z);
    if (d > 300) return; // Hurricane used 120u (~689 m); 300 m is tighter for a 333 m carrier
  }
  G.tacHoldPos = { x, y, z };
  G.tacHoldUntil = G.time + 2.5;
  $('btnCam').textContent = 'Camera: impact hold [C]';
}
function tacTargetValid() {
  const t = G.tacTarget;
  if (!t) return false;
  if (t.state !== undefined) return ['climb', 'ingress', 'attack', 'egress', 'rtb', 'trap', 'spinout', 'crashed'].includes(t.state);
  return t.alive === true;
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
  const cls = 'carrierRow' + (G.selected === c ? ' sel' : '') + (c.state === 'gone' || c.state === 'sinking' ? ' dead' : '') + (G.camSpectate === c ? ' watch' : '');
  const hpCls = c.hpFrac > 0.6 ? '' : c.hpFrac > 0.3 ? ' hurt' : ' crit';
  const barCls = c.hpFrac > 0.6 ? '' : c.hpFrac > 0.3 ? 'mid' : 'low';
  const wing = c.wing ? ` · ✈ ${c.wing.remaining} jets (${c.wing.airborneCount()} up)` + (c.wing.squadrons.some(s => s.state === 'launchQueued') ? ' · LAUNCH QUEUED' : '') : '';
  // v1.1.0: Hurricane v11.30 visual row — icon + short code + health bar
  // on phones (CSS shows .fic/.fcode/.fbar and hides .nm/.hp/.zones/.bar);
  // desktop keeps the full row. fic flags fire / loss / camera-follow.
  // v1.2.0: 🎥 marks the carrier being spectated (Hurricane v11.15).
  const fic = G.camSpectate === c ? '🎥' : c.fires.length ? '🔥' : (c.state !== 'alive' ? '💥' : G.camFollow === c ? '🎥' : '🚢');
  const code = c.name.replace('SHIELD-', 'S').replace('ENEMY-', 'E');
  const pct = Math.round(c.hpFrac * 100);
  const hpText = G.camSpectate === c ? 'WATCHING' : c.state === 'alive' ? pct + '%' : c.state.toUpperCase();
  return `<div class="${cls}" data-cid="${c.id}">
    <h4><span class="fic">${fic}</span><span class="fcode">${code}</span><span class="nm">${c.name}</span><span class="hp">${hpText}</span></h4>
    <div class="fbar"><i class="${barCls}" style="width:${pct}%"></i></div>
    <div class="bar${hpCls}"><i style="width:${pct}%"></i></div>
    <div class="zones">Lift ${Math.round(c.lift * 100)}% · Alt ${Math.round(c.y)} m · Spd ${Math.abs(c.forwardSpeed).toFixed(0)} m/s${wing}<br>${zoneLine(c)}</div>
  </div>`;
}
function renderFleetPanels() {
  // v1.1.0: Hurricane v11.16 — the enemy roster panel is gone; enemies are
  // tracked on the minimap (red triangles) and designated by tapping one
  // there or with the Target button. Only the player fleet gets a list.
  $('fleetRows').innerHTML = G.playerFleet.map(c => carrierRowHTML(c)).join('');
  document.querySelectorAll('.carrierRow').forEach(el => {
    el.addEventListener('click', () => {
      const c = G.allCarriers.find(x => x.id === +el.dataset.cid);
      if (!c) return;
      // v1.2.0 spectate (Hurricane v11.15): a destroyed carrier's row
      // switches the CAMERA to watch her go down — command stays with
      // the live flagship and the helm does NOT lock. A live ship's row
      // takes command (and clears any spectate). Tapping the spectated
      // row again returns the camera to the fleet.
      if (c.side === 'player' && !c.alive) {
        if (c.state === 'falling' || c.state === 'sinking' || (c.state === 'gone' && c.pieces.length)) {
          if (G.camSpectate === c) {
            G.camSpectate = null;
            msg('Camera back on ' + (G.selected ? G.selected.name : 'the fleet'));
          } else {
            G.camSpectate = c;
            msg('🎥 Watching ' + c.name + ' go down — helm still live, R or a live ship returns');
          }
          renderFleetPanels();
          return;
        }
        msg(c.name + ' is gone');
        return;
      }
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
  $('rudderReadout').textContent = 'RUDDER ' + (s ? Math.round(s.rudderDeg) + '°' : '0°');
  $('modeBtn').textContent = G.mode;
  document.querySelectorAll('#teleBtns .teleBtn').forEach(b => b.classList.toggle('on', +b.dataset.idx === G.telegraphIdx));
}
function updateStatus() {
  const s = G.selected;
  if (!s) return;
  // v1.2.0: pitch readout follows the selected carrier's real pitch
  // angle whenever the pitch track / arrow keys are not actively held.
  if (Math.abs(G.pitchTrack) < 0.02 && !G.keys['ArrowUp'] && !G.keys['ArrowDown']) {
    const pd = Math.round(s.pitch * 57.2958);
    $('pitchReadout').textContent = 'PITCH ' + (pd >= 0 ? '+' : '') + pd + '°';
  }
  // v1.1.0: the wide centred status strip is gone — its facts live in the
  // Hurricane-style top pill bar (ship / nav / air) and the minimap stats.
  const pods = s.pods.map(p => p.alive ? '●' : '✕').join('');
  $('pillShip').innerHTML = `<b>${s.name}</b> · Lift ${Math.round(s.lift * 100)}% · Pods ${pods}`;
  $('pillNav').textContent =
    `ALT ${Math.round(s.y)} m (→${Math.round(s.targetAlt)}) · SPD ${Math.abs(s.forwardSpeed).toFixed(0)} m/s · ` +
    `${TELEGRAPH[s.telegraphIdx].name} · ${G.mode}`;
  $('pillAir').textContent =
    `✈ ${G.playerFleet.reduce((a, c) => a + (c.wing ? c.wing.remaining : 0), 0)} jets · ` +
    `💣 ${G.bombStats.drops}/${G.bombStats.hits} · ${STAGES[G.stage].name} Hs ${G.sea.HS.toFixed(1)} m`;
  $('miniStats').innerHTML =
    `YOU <b>${G.playerFleet.filter(c => c.alive).length}/${G.playerFleet.length}</b> · FOE <b>${G.enemyFleet.filter(c => c.alive).length}/${G.enemyFleet.length}</b>`;
}

// ---------- Minimap / tactical radar (v1.3.0, F) ----------
// Hurricane TacticalRadarHUD layers on the existing minimap: rotating
// sweep, range-ring labels, airborne squadrons as chevrons coloured by
// mission state, ordnance as tracking streaks, storm clutter
// (dimmed/flickering contacts in Storm/Hurricane).
const SQ_COLORS = { climb: '#dfeef5', ingress: '#ffd166', attack: '#ff7a3c', egress: '#e8b13c', rtb: '#58c98a', trap: '#7ad4f5', divert: '#c98ad4', spinout: '#ff5a5a' };
function drawMinimap() {
  const cv = $('minimap'), g = cv.getContext('2d');
  const W = cv.width, R = 4200; // world half-range shown
  const px = x => (x / R * 0.5 + 0.5) * W;
  const pz = z => (z / R * 0.5 + 0.5) * W;
  g.fillStyle = '#0d2839'; g.fillRect(0, 0, W, W);
  // Range rings with labels (1 km / 2 km / 3 km / 4 km).
  g.strokeStyle = 'rgba(140,200,230,.15)';
  g.fillStyle = 'rgba(157,184,204,.8)';
  g.font = '11px system-ui, sans-serif';
  for (let i = 1; i < 4; i++) {
    g.beginPath(); g.arc(W / 2, W / 2, W / 2 * i / 4, 0, Math.PI * 2); g.stroke();
    g.fillText((i) + ' km', W / 2 + 3, W / 2 - W / 2 * i / 4 + 12);
  }
  // Rotating sweep (one revolution per ~6 s of game time).
  const sweepA = (G.time * Math.PI * 2 / 6) % (Math.PI * 2);
  g.save();
  g.translate(W / 2, W / 2);
  g.rotate(sweepA);
  const sg = g.createLinearGradient(0, 0, W / 2, 0);
  sg.addColorStop(0, 'rgba(120,220,140,0.25)'); sg.addColorStop(1, 'rgba(120,220,140,0)');
  g.fillStyle = sg;
  g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, W / 2, -0.35, 0); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(120,220,140,0.7)'; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(0, 0); g.lineTo(W / 2, 0); g.stroke();
  g.restore();
  g.lineWidth = 1;
  // Storm clutter: dimmed, flickering false contacts in Storm/Hurricane.
  if (G.stage >= 2) {
    for (let i = 0; i < 14; i++) {
      const seed = Math.sin(i * 127.1 + 311.7) * 43758.5453;
      const fx = (seed - Math.floor(seed)) * W;
      const seed2 = Math.sin(i * 57.3 + 91.7) * 24634.6345;
      const fz = (seed2 - Math.floor(seed2)) * W;
      const flick = 0.15 + 0.35 * Math.abs(Math.sin(G.time * 2 + i * 1.7));
      g.fillStyle = `rgba(120,180,200,${flick.toFixed(2)})`;
      g.fillRect(fx - 2, fz - 2, 4, 4);
    }
  }
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
  // Airborne squadrons as chevrons coloured by mission state.
  for (const c of G.allCarriers) if (c.wing) for (const s of c.wing.squadrons) for (const j of s.jets) {
    if (!['climb', 'ingress', 'attack', 'egress', 'rtb', 'trap', 'spinout'].includes(j.state)) continue;
    const col = SQ_COLORS[s.state] || '#dfeef5';
    g.save();
    g.translate(px(j.x), pz(j.z));
    g.rotate(j.heading);
    g.fillStyle = col;
    g.beginPath(); g.moveTo(0, -7); g.lineTo(5, 5); g.lineTo(0, 2); g.lineTo(-5, 5); g.closePath(); g.fill();
    g.restore();
  }
  // Ordnance as tracking streaks (short trail behind each live bomb/ASM/SAM).
  const streak = (o, color) => {
    if (!o._trail) o._trail = [];
    o._trail.push([o.x, o.z]);
    if (o._trail.length > 14) o._trail.shift();
    g.strokeStyle = color; g.lineWidth = 2;
    g.beginPath();
    o._trail.forEach(([tx, tz], i) => { if (i === 0) g.moveTo(px(tx), pz(tz)); else g.lineTo(px(tx), pz(tz)); });
    g.stroke();
    g.lineWidth = 1;
    g.fillStyle = color;
    g.beginPath(); g.arc(px(o.x), pz(o.z), 3, 0, Math.PI * 2); g.fill();
  };
  for (const b of G.bombs) if (b.alive) streak(b, '#ffd166');
  for (const m of G.missiles) if (m.alive) streak(m, '#ff7a3c');
  if (G.airDefense) for (const s of G.airDefense.sams) if (s.alive) streak(s, '#ffffff');
  // v1.3.0 (I) CCIP markers on the minimap.
  for (const p of G.ccip) {
    if (!p || !p.valid) continue;
    g.strokeStyle = '#ffd166'; g.lineWidth = 2;
    g.beginPath(); g.arc(px(p.x), pz(p.z), 6, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(px(p.x) - 9, pz(p.z)); g.lineTo(px(p.x) + 9, pz(p.z)); g.stroke();
    g.lineWidth = 1;
  }
  // Freak wave on the radar (v1.3.0 D): a pale arc at the crest.
  if (G.sea && G.sea.freak) {
    const fw = G.sea.freak;
    g.strokeStyle = 'rgba(190,230,245,0.85)'; g.lineWidth = 3;
    g.beginPath(); g.arc(px(fw.x), pz(fw.z), fw.radius / R * W, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 1;
  }
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
  // v1.3.0 (G): score + persisted best result (localStorage).
  // Score: 100 per surviving carrier + 50 per enemy carrier destroyed
  // + 5 per bomb hit. Best = highest score, with the victory that earned it.
  const eDestroyed = G.enemyFleet.length - G.enemyFleet.filter(c => c.state === 'alive').length;
  const score = pSurv * 100 + eDestroyed * 50 + G.bombStats.hits * 5;
  const best = { result, survivors: pSurv, score, date: new Date().toISOString().slice(0, 10) };
  if (!G.best || score > G.best.score) {
    G.best = best;
    try { localStorage.setItem('helicarriers_best', JSON.stringify(best)); } catch (_) {}
  }
  const bestLine = `Score ${score} · Best: ${G.best.result.toUpperCase()} ${G.best.score} pts (${G.best.survivors} survived, ${G.best.date})`;
  if (result === 'win') {
    $('endTitle').textContent = '🏆 VICTORY';
    $('endTitle').style.color = '#ffd166';
    $('endText').textContent = `All enemy helicarriers destroyed. ${pSurv} of your carriers survived. ${bestLine}`;
  } else if (result === 'lose') {
    $('endTitle').textContent = '💥 DEFEAT';
    $('endTitle').style.color = '#e4572e';
    $('endText').textContent = `Your fleet is gone. The sea keeps the wreckage. ${eSurv} enemy carrier${eSurv === 1 ? '' : 's'} survived. ${bestLine}`;
  } else { // draw — both fleets gone at once is not a victory
    $('endTitle').textContent = '💥 MUTUAL DESTRUCTION';
    $('endTitle').style.color = '#e8b13c';
    $('endText').textContent = 'Both fleets are gone — mutual destruction. No carriers survived. ' + bestLine;
  }
  $('endOverlay').style.display = 'flex';
}

function makeCtx() {
  return {
    scene: G.scene, sea: G.sea, vfx: G.vfx, time: G.time,
    bombs: G.bombs, missiles: G.missiles,
    audio: G.audio, carriers: G.allCarriers,
    // v1.3.0 (E): a detonation near the tactical-camera target holds
    // the camera on the blast (see noteDetonation below).
    noteDetonation: (x, y, z, kind) => noteDetonation(x, y, z, kind),
    msg, onCarrierLost: (c) => { ensureLiveCommand(c); renderFleetPanels(); checkEnd(); },
    bombLog: (hit, along, across, by) => {
      G.bombStats.drops++;
      if (hit) G.bombStats.hits++;
      G.bombStats.log.push({ hit, along, across, by: by || null });
      if (G.bombStats.log.length > 200) G.bombStats.log.shift();
    },
  };
}

// ---------- v1.3.0: pause, weather, freak wave, CCIP ----------
// Pause screen (P or Esc): resume / restart / back to menu. The sim
// freezes; rendering, the sea and the camera keep running underneath.
function togglePause() {
  if (!G.started || G.over) return;
  G.paused = !G.paused;
  $('pauseOverlay').style.display = G.paused ? 'flex' : 'none';
  if (G.audio) G.audio.click();
}
function loadBest() {
  try {
    const b = JSON.parse(localStorage.getItem('helicarriers_best') || 'null');
    if (b && typeof b.score === 'number') G.best = b;
  } catch (_) { G.best = null; }
  const el = $('bestLine');
  if (el) el.textContent = G.best
    ? `Best result: ${G.best.result.toUpperCase()} — ${G.best.score} pts, ${G.best.survivors} carrier${G.best.survivors === 1 ? '' : 's'} survived (${G.best.date})`
    : 'No rounds played yet — your best result will be remembered here.';
}
// Distance-driven weather progression (D, optional): as the flagship
// sails, the weather worsens — Calm -> Rough at 1500 m sailed,
// Storm at 3000 m, Hurricane at 5000 m. Fixed mode never changes stage.
function updateWeatherProgression(dt) {
  if (G.weatherProg !== 'distance' || !G.selected) return;
  const s = G.selected;
  if (G.lastFlagPos) {
    G.sailedDist += Math.hypot(s.x - G.lastFlagPos.x, s.z - G.lastFlagPos.z);
  }
  G.lastFlagPos = { x: s.x, z: s.z };
  const want = G.sailedDist >= 5000 ? 3 : G.sailedDist >= 3000 ? 2 : G.sailedDist >= 1500 ? 1 : 0;
  if (want !== G.stage) {
    G.stage = want;
    G.sea.setStage(want);
    msg(`Weather worsening — ${STAGES[want].name} sea (${Math.round(G.sailedDist)} m sailed)`);
  }
}
// Freak wave (D, Hurricane v11.8-11.12): spawns only in Storm/Hurricane,
// travels across the sea toward the flagship, threatens anything low.
function spawnFreakWave() {
  const flag = G.playerFleet.find(c => c.alive) || G.allCarriers.find(c => c.alive);
  if (!flag) return;
  const ang = Math.random() * Math.PI * 2;
  const dist = 2500;
  const sx = flag.x + Math.cos(ang) * dist, sz = flag.z + Math.sin(ang) * dist;
  const toX = flag.x - sx, toZ = flag.z - sz, tl = Math.hypot(toX, toZ) || 1;
  G.sea.freak = { x: sx, z: sz, dirX: toX / tl, dirZ: toZ / tl, amp: 14, radius: 120, speed: 30, age: 0, life: 60 };
  msg('⚠️ FREAK WAVE — a wall of water is coming! Low jets: climb!');
  if (G.audio) G.audio.alarm(G.time);
}
function updateFreakWave(dt, ctx) {
  const fw = G.sea.freak;
  if (!fw) {
    if (G.stage >= 2) {
      G.freakT -= dt;
      if (G.freakT <= 0) spawnFreakWave();
    }
    return;
  }
  fw.age += dt;
  fw.x += fw.dirX * fw.speed * dt;
  fw.z += fw.dirZ * fw.speed * dt;
  if (fw.age > fw.life) { G.sea.freak = null; G.freakT = 45 + Math.random() * 30; return; }
  // Swamp check: a low jet caught by the crest is swamped/crashes.
  // Carriers fly at >=150 m — the 14 m crest cannot reach them (safe
  // by altitude, by design). Beam/bow rule, Hurricane-style: a jet
  // flying INTO the wave face (head-on to its travel) is swamped at a
  // lower crest than one running with it — here: any jet below the
  // crest + 3 m inside 1.5 radii is caught.
  for (const c of G.allCarriers) {
    if (!c.wing) continue;
    for (const s of c.wing.squadrons) for (const j of s.jets) {
      if (!['climb', 'ingress', 'attack', 'egress', 'rtb', 'trap'].includes(j.state)) continue;
      const crest = G.sea.freakHeightAt(j.x, j.z);
      if (crest > 6) {
        const seaH = G.sea.waveHeight(j.x, j.z, G.time);
        if (j.y < seaH + crest + 3) {
          j.startSpinOut(ctx, 'swamped by the freak wave');
          ctx.vfx.splash(j.x, seaH + crest, j.z, 20);
        }
      }
    }
  }
}
// Lightning (D): Storm/Hurricane only. A flash brightens the sky for
// ~0.15 s; thunder follows after a distance delay.
function updateLightning(dt) {
  if (G.stage < 2) return;
  G.lightningT -= dt;
  if (G.lightningT <= 0) {
    G.lightningT = 8 + Math.random() * 12;
    G.flashT = 0.15;
    G.pendingThunder = G.time + 0.5 + Math.random() * 1.5;
    if (G.scene) G.scene.background.setHex(0xd8e8f2);
  }
  if (G.flashT > 0) {
    G.flashT -= dt;
    if (G.flashT <= 0 && G.scene) G.scene.background.setHex(STAGES[G.stage].sky);
  }
  if (G.pendingThunder && G.time >= G.pendingThunder) {
    G.pendingThunder = 0;
    if (G.audio) G.audio.thunder();
  }
}
// CCIP (I): while a player strike flight is in its attack dive, show
// the predicted bomb impact point — a small ring in 3D on the target
// deck/sea plus the minimap marker (drawn in drawMinimap from G.ccip).
function updateCCIP() {
  G.ccip = [];
  if (!G.started || G.over) return;
  let mi = 0;
  for (const c of G.playerFleet) {
    if (!c.wing) continue;
    for (const s of c.wing.squadrons) {
      if (s.state !== 'attack' || s.attackPhase !== 'dive' || !s.target) continue;
      for (const j of s.aliveJets) {
        if (j.ordnance <= 0) continue;
        const p = predictBombImpact(j, s.target);
        G.ccip.push(p);
        const mesh = G.ccipMeshes[mi++];
        if (mesh) {
          mesh.visible = p.valid;
          if (p.valid) mesh.position.set(p.x, p.y + 3, p.z);
        }
      }
    }
  }
  for (; mi < G.ccipMeshes.length; mi++) G.ccipMeshes[mi].visible = false;
}

// ---------- Input ----------
function bindInput() {
  // v1.3.0 (C): lazy AudioContext on the first user gesture.
  const ensureAudio = () => { if (G.audio) G.audio.ensure(); };
  addEventListener('pointerdown', ensureAudio, { once: false });
  addEventListener('keydown', ensureAudio, { once: false });
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

  // Joystick — Hurricane v11.0 horizontal rudder track: the knob only
  // swings left/right (rudder), centred by a transform, not a left offset.
  // v1.2.0: the rudder track and the pitch track each own their pointer
  // (separate pointerId + pointer capture per control), so two thumbs
  // can drive rudder and pitch at the same time while a third finger
  // taps the telegraph — no single-pointer lock anywhere.
  const joy = $('joy'), knob = $('joyKnob');
  let joyId = null;
  const joyMove = e => {
    const r = joy.getBoundingClientRect();
    let dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    dx = clamp(dx, -1, 1);
    G.rudderInput = dx;
    knob.style.transform = `translateX(${dx * (r.width / 2 - 28)}px)`;
    $('rudderReadout').textContent = 'RUDDER ' + Math.round(dx * 35) + '°';
  };
  joy.addEventListener('pointerdown', e => { joyId = e.pointerId; try { joy.setPointerCapture(e.pointerId); } catch (_) {} joyMove(e); });
  joy.addEventListener('pointermove', e => { if (e.pointerId === joyId) joyMove(e); });
  const joyEnd = e => { if (e && e.pointerId !== joyId) return; joyId = null; G.rudderInput = 0; knob.style.transform = ''; };
  joy.addEventListener('pointerup', joyEnd);
  joy.addEventListener('pointercancel', joyEnd);

  // v1.2.0 pitch track — vertical spring-return drag beside the rudder:
  // drag up = nose up, drag down = nose down, returns to level on
  // release. Own pointerId/capture, independent of the rudder track.
  const pt = $('pitchTrack'), pk = $('pitchKnob');
  let ptId = null;
  const ptMove = e => {
    const r = pt.getBoundingClientRect();
    let dy = ((r.top + r.height / 2) - e.clientY) / (r.height / 2);
    dy = clamp(dy, -1, 1);
    G.pitchTrack = dy;
    pk.style.transform = `translateY(${-dy * (r.height / 2 - 26)}px)`;
    $('pitchReadout').textContent = 'PITCH ' + (dy >= 0 ? '+' : '') + Math.round(dy * 12) + '°';
  };
  pt.addEventListener('pointerdown', e => { ptId = e.pointerId; try { pt.setPointerCapture(e.pointerId); } catch (_) {} ptMove(e); });
  pt.addEventListener('pointermove', e => { if (e.pointerId === ptId) ptMove(e); });
  const ptEnd = e => { if (e && e.pointerId !== ptId) return; ptId = null; G.pitchTrack = 0; pk.style.transform = ''; $('pitchReadout').textContent = 'PITCH 0°'; };
  pt.addEventListener('pointerup', ptEnd);
  pt.addEventListener('pointercancel', ptEnd);

  // Minimap click — Hurricane v11.25: tap an enemy contact to designate it
  // as the air wing's target; open ocean sets a waypoint.
  $('minimap').addEventListener('click', e => {
    const r = $('minimap').getBoundingClientRect();
    const ix = (e.clientX - r.left) / r.width * 380, iy = (e.clientY - r.top) / r.height * 380;
    let best = null, bd = 1e18;
    for (const c of G.enemyFleet) {
      if (!c.alive) continue;
      const d = Math.hypot((c.x / 4200 * 0.5 + 0.5) * 380 - ix, (c.z / 4200 * 0.5 + 0.5) * 380 - iy);
      if (d < bd) { bd = d; best = c; }
    }
    if (best && bd < 30) {
      G.targetCarrier = best; G.targetMode = 'designated';
      $('btnTarget').textContent = 'Target: ' + best.name;
      msg('Target designated: ' + best.name);
      return;
    }
    const wx = (ix / 380 * 2 - 1) * 4200;
    const wz = (iy / 380 * 2 - 1) * 4200;
    G.waypoint = { x: wx, z: wz };
    msg(`Waypoint set (${Math.round(wx)}, ${Math.round(wz)}) — fleet steering there`);
  });

  // v1.1.0: collapsible panels (Hurricane Air Ops header toggle) + direct
  // telegraph notch buttons (Hurricane 2-column teleBtn grid).
  const bindToggle = (btnId, panelId) => {
    $(btnId).addEventListener('click', () => {
      const p = $(panelId);
      p.classList.toggle('collapsed');
      $(btnId).textContent = p.classList.contains('collapsed') ? '▸' : '▾';
    });
  };
  bindToggle('fleetToggle', 'fleetPanel');
  bindToggle('aoToggle', 'airOpsPanel');
  document.querySelectorAll('#teleBtns .teleBtn').forEach(b =>
    b.addEventListener('click', () => { setTelegraph(+b.dataset.idx); updateTeleBox(); }));

  addEventListener('keydown', e => {
    if (!G.started) return;
    // v1.3.0 (G): P or Esc pauses (before any other key handling).
    if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') { togglePause(); return; }
    if (G.paused) return;
    G.keys[e.key] = true;
    if (e.key === 'Tab') { e.preventDefault(); cycleShip(); }
    if (e.key >= '1' && e.key <= '8') setTelegraph(+e.key - 1);
    if (e.key === 'w' || e.key === 'W') setTelegraph(G.telegraphIdx - 1);
    if (e.key === 's' || e.key === 'S') setTelegraph(G.telegraphIdx + 1);
    if (e.key === 'q' || e.key === 'Q') adjustAlt(25);
    if (e.key === 'e' || e.key === 'E') adjustAlt(-25);
    // v1.2.0: ArrowUp/Down pitch (ArrowLeft/Right already rudder).
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') e.preventDefault();
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
  // v1.3.0 (G/C): pause overlay + mute toggle.
  $('btnResume').addEventListener('click', togglePause);
  $('btnRestart').addEventListener('click', () => location.reload());
  $('btnMenu').addEventListener('click', () => location.reload());
  $('btnPause').addEventListener('click', togglePause);
  const muteBtn = $('btnMute');
  const syncMute = () => { muteBtn.textContent = G.audio && G.audio.muted ? '🔇 Muted' : '🔊 Sound'; };
  muteBtn.addEventListener('click', () => {
    if (!G.audio) return;
    G.audio.ensure();
    G.audio.setMuted(!G.audio.muted);
    syncMute();
  });
  G._syncMute = syncMute;
  syncMute();
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
  G.tacMode = null; G.tacKind = null; G.tacTarget = null; G.tacHoldPos = null; G.tacJetsIdx = -1; G.tacOrdIdx = -1;
  G.camSpectate = null; // v1.2.0: R also ends a spectate follow (Hurricane v11.15)
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
      // v1.2.0: tapping a falling/sinking carrier spectates her
      // (camera follows her down, helm untouched); a live carrier
      // behaves as before (follow / take command / designate target).
      if (!c.alive) {
        G.camSpectate = c;
        msg('🎥 Watching ' + c.name + ' go down — helm still live, R returns');
        renderFleetPanels();
        return;
      }
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

// ---------- v1.3.0 (G) attract mode ----------
// Idle attract behind the start menu: two small fleets gently cruising
// on a living sea. No launches, no combat — just the world alive behind
// the menu. startGame() clears these fleets and spawns the real round.
function attractUpdate(dt) {
  G.time += dt;
  G.attractT += dt;
  G.camYaw += dt * 0.03;
  G.camDist = 1600;
  updateSteering(dt);
  const ctx = makeCtx();
  for (const c of G.allCarriers) c.update(dt, ctx);
}
async function startAttract() {
  try {
    G.playerN = 2; G.enemyN = 2; G.stage = 0; G.form = 'C'; G.baseAlt = 350;
    initScene();
    G.models = await loadModels();
    G.playerFleet = spawnFleet('player', 2, 1200, 0);
    G.enemyFleet = spawnFleet('enemy', 2, -1200, Math.PI);
    G.allCarriers = [...G.playerFleet, ...G.enemyFleet];
    G.selected = G.playerFleet[0];
    G.camFollow = G.selected;
    G.telegraphIdx = 1;
    for (const c of G.playerFleet) c.telegraphIdx = 1;
    G.attract = true;
    G._loopStarted = true;
    window.__game = G; // debug handle (attract phase)
    window.__bombBallisticsProbe = bombBallisticsProbe;
    window.__predictBombImpact = predictBombImpact;
    window.__noteDetonation = noteDetonation;
    requestAnimationFrame(loop);
  } catch (err) { console.error('attract failed', err); }
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
  G.weatherProg = $('selWeatherProg') ? $('selWeatherProg').value : 'fixed';
}
async function startGame() {
  readMenu();
  if (params.has('fleet')) G.playerN = G.enemyN = +params.get('fleet');
  if (params.has('skill')) G.skill = params.get('skill');
  if (params.has('stage')) G.stage = params.get('stage') === 'hurricane' ? 3 : params.get('stage') === 'storm' ? 2 : params.get('stage') === 'rough' ? 1 : 0;
  if (params.has('weatherprog')) G.weatherProg = params.get('weatherprog');
  $('menu').style.display = 'none';
  $('hud').classList.add('on');
  // v1.3.0: if the attract scene is already running, reuse it — clear
  // the demo fleets and spawn the real round into the same scene.
  if (G.attract) {
    for (const c of G.allCarriers) G.scene.remove(c.group);
    G.playerFleet = []; G.enemyFleet = []; G.allCarriers = [];
    G.attract = false; G.selected = null; G.camFollow = null;
    G.sea.setStage(G.stage);
  } else {
    initScene();
  }
  G.audio = new GameAudio();
  G.airDefense = new AirDefenseSystem();
  if (G._syncMute) G._syncMute();
  if (!G.models) {
    try {
      G.models = await loadModels();
    } catch (err) {
      $('loadErr').style.display = 'flex';
      $('loadErrText').textContent = 'GLB load failed: ' + (err && err.message ? err.message : err) + '\nModels are embedded as base64 modules (assets/helicarrier.b64.js, assets/fa18.b64.js). Check they exist and the page is served over HTTP.';
      throw err;
    }
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
  window.__predictBombImpact = predictBombImpact;
  window.__noteDetonation = noteDetonation;
  if (params.has('timescale')) G.timeScale = clamp(+params.get('timescale') || 1, 1, 8);
  // Debug URL hooks
  if (params.has('collide')) forceCollisionCourse(params.get('collide') === '1' ? 'headon' : params.get('collide'));
  if (params.get('kill') === '1') setTimeout(() => killCarrier(G.enemyFleet[0], 'reactor'), 3000);
  if (params.get('killplayer') === '1') setTimeout(() => killCarrier(G.playerFleet[0], 'reactor'), 3000);
  if (params.get('probe') === 'bombs') setTimeout(runBombProbe, 1500);
  if (params.get('autostart') === '1' && G.enemyAI === 'auto') { /* enemy director runs anyway */ }
  if (!G._loopStarted) { G._loopStarted = true; requestAnimationFrame(loop); }
  // HUD refresh
  setInterval(() => { if (G.started) { renderFleetPanels(); updateStatus(); updateTeleBox(); } }, 500);
}

let lastT = performance.now();
// v1.3.0 (J) substepped sim: one frame's sim time is split into
// substeps of at most 0.05 s (Pandora's cap), so a slow device (or a
// debug timeScale) can never feed a 0.8 s integrator step to the
// flight/damage code. Total sim per frame is capped at 0.10 s at
// timeScale 1 — at low frame rates the game runs in slow motion
// instead of spiralling (each frame still advances, never catching up
// unboundedly). Debug timeScale multiplies the cap, as before.
function stepSim(dt) {
  G.time += dt;
  if (G.msgT > 0) { G.msgT -= dt; if (G.msgT <= 0) $('msg').textContent = '—'; }
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
    // v1.3.0 (A): air defence on both sides.
    if (G.airDefense) G.airDefense.update(dt, ctx, G);
    enemyDirector(dt);
    updateWeatherProgression(dt);
    updateFreakWave(dt, ctx);
    updateLightning(dt);
    // v1.3.0 (C): alarm when the flagship takes fire.
    if (G.selected && G.selected.fires.length && G.audio && G.time > (G.alarmCool || 0)) {
      G.audio.alarm(G.time);
      G.alarmCool = G.time + 5;
    }
    checkEnd(); // every frame: a breakup's pieces take ~40 s of game time to sink
  }
  // (c) Keep a command-transfer announcement on screen for 8 s of game
  // time — it must survive the flurry of loss messages around a sinking.
  if (G.transferAnnounce) {
    if (G.time < G.transferAnnounce.until && !G.over) { $('msg').textContent = G.transferAnnounce.text; G.msgT = 4; }
    else G.transferAnnounce = null;
  }
}
function loop(now) {
  requestAnimationFrame(loop);
  const rawDt = Math.min(0.10, (now - lastT) / 1000);
  lastT = now;
  // v1.3.0 (G) attract mode: before the round starts the menu floats
  // over a living scene (fleet cruising on a living sea).
  if (G.attract && !G.started) {
    attractUpdate(rawDt);
    const alive = G.allCarriers.filter(c => c.state !== 'gone');
    const fx = alive.reduce((a, c) => a + c.x, 0) / Math.max(1, alive.length);
    const fz = alive.reduce((a, c) => a + c.z, 0) / Math.max(1, alive.length);
    G.sea.update(G.time, rawDt, fx, fz, []);
    G.vfx.update(rawDt);
    updateCamera(rawDt);
    G.renderer.render(G.scene, G.camera);
    return;
  }
  // v1.3.0 (G) pause: the sim freezes, the scene keeps rendering.
  if (!G.paused) {
    const totalDt = rawDt * G.timeScale;
    const cap = 0.10 * G.timeScale;
    const simDt = Math.min(totalDt, cap);
    const steps = Math.max(1, Math.ceil(simDt / 0.05));
    const sub = simDt / steps;
    for (let i = 0; i < steps; i++) stepSim(sub);
  }
  updateCCIP();
  // Ocean follows the midpoint of the action; wakes only for hulls at the water.
  const alive = G.allCarriers.filter(c => c.state !== 'gone');
  const fx = alive.reduce((a, c) => a + c.x, 0) / Math.max(1, alive.length);
  const fz = alive.reduce((a, c) => a + c.z, 0) / Math.max(1, alive.length);
  const wakeShips = G.allCarriers.filter(c => c.y < 60).map(c => ({ x: c.x, z: c.z, heading: c.heading, forwardSpeed: c.forwardSpeed, len: CARRIER_LEN, beam: 70 }));
  G.sea.update(G.time, rawDt, fx, fz, wakeShips);
  // v1.3.0 (D) freak-wave crest wall follows the crest.
  if (G.freakMesh) {
    const fw = G.sea.freak;
    if (fw) {
      G.freakMesh.visible = true;
      G.freakMesh.position.set(fw.x, fw.amp * 0.5, fw.z);
      G.freakMesh.rotation.y = Math.atan2(fw.dirX, fw.dirZ) + Math.PI / 2;
      G.freakMesh.material.opacity = 0.3 + 0.2 * Math.sin(G.time * 2);
    } else G.freakMesh.visible = false;
  }
  G.vfx.update(rawDt);
  updateCamera(rawDt);
  drawMinimap();
  if (DEBUG) {
    $('dbgInfo').textContent = `t=${G.time.toFixed(0)}s · jets up ${G.allCarriers.reduce((a, c) => a + (c.wing ? c.wing.airborneCount() : 0), 0)} · bombs ${G.bombs.length} · missiles ${G.missiles.length} · SAMs ${G.airDefense ? G.airDefense.sams.length : 0} · parts steal: P ${G.vfx.pCursor}/${1600} S ${G.vfx.spCursor}/${420}`;
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

// v1.3.0 (G): show the persisted best result on the menu, and run the
// idle attract scene behind it. Autostart (?autostart=1) skips both.
loadBest();
if (params.get('autostart') === '1') {
  startGame().catch(err => console.error(err));
} else {
  startAttract();
}
window.__booted = true;

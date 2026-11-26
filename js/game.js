// game.js — Helicarriers at Sea v1: bootstrap, fleet steering (Hurricane
// telegraph/modes/formation/waypoint, metric), free-orbit camera (Pandora
// OrbitCamera helpers, ported), HUD, minimap, enemy AI director, debug hooks.
import * as THREE from 'three';
import { Sea, STAGES } from './sea.js';
import { VFX } from './vfx.js';
import { Helicarrier, loadModels, CARRIER_LEN, PHYSICS, GRAV } from './carrier.js';
import { checkCarrierCollisions, soliditySnapshot } from './collisions.js';
import { AirWing, AirBomb, AntiShipMissile, bombBallisticsProbe, JET_CRUISE_SPEED, predictBombImpact } from './jets.js';
import { GameAudio } from './audio.js';
import { AirDefenseSystem } from './airdefense.js';
import { WreckageField } from './wreckage.js';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// v1.4.0 (item 7, touch spec §1.3/§6): millimetres -> CSS px via the
// CSS reference-pixel anchor (1in = 96 CSS px = 25.4 mm, so 1 mm =
// 96/25.4 CSS px). devicePixelRatio is deliberately NOT used: it
// converts CSS px to device px (backing-store resolution), not to
// physical millimetres, and it changes with page zoom. The anchor is
// a nominal millimetre (typically within ~10-20% of a ruler mm on a
// phone); that is strictly better than a raw-pixel threshold, which
// varies ~3x across phones. devicePixelRatio still belongs in
// rendering only (renderer.setPixelRatio in initScene).
const MM_TO_PX = 96 / 25.4;
const mm = m => m * MM_TO_PX;
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
// v1.4.0 (item 3) enemy AI director — skill shapes the DIRECTOR, not the
// ordnance: wave spacing comes from SKILLS.launchInterval, scoring noise
// from SKILLS.aimErr (elite picks the tactically best target almost
// every time, cadet often picks a worse one), and the wave stagger /
// focus discipline tighten with skill. jetMul/dmgMul stay unwired on
// purpose: wiring dmgMul would change bomb/missile damage amounts, which
// the AD-tuning pass forbade — skill differentiation lives in timing,
// target quality and coordination instead.
const DIRECTOR_SKILL = {
  cadet: { stagger: 6, focusS: 50, reevalS: 10 },
  veteran: { stagger: 3.5, focusS: 35, reevalS: 7 },
  elite: { stagger: 2, focusS: 25, reevalS: 5 },
};
// v1.4.0 (item 3) standoff band — Hurricane's optimal-range circling,
// rescaled to metric: Hurricane's heavy-cruiser optRange 240 u x 5.74
// m/u = 1378 m, band ±50 u = ±287 m. Helicarriers jets strike from
// 600–1000 m out, so the carriers hold at 1400 ± 250 m: close enough
// for short jet transits, far enough that the fleets never meet hull
// to hull. The band is measured to the player flagship (the fleet's
// position); strike targets are chosen separately by the director.
const DIRECTOR_OPT_RANGE = 1400;
const DIRECTOR_BAND = 250;
const FORM = {
  C: [[0, 450, 25], [-450, 450, -25], [0, 900, 0]],       // cruising wedge
  A: [[-450, 200, 25], [450, 200, -25], [-900, 400, 0]],  // attack line
};

const G = {
  renderer: null, scene: null, camera: null, sea: null, vfx: null, wreckage: null,
  models: null, started: false, time: 0, timeScale: 1,
  playerFleet: [], enemyFleet: [], allCarriers: [],
  selected: null, mode: 'FLEET', // INDV | FLEET | ANCHOR
  stage: 0, form: 'C', skill: 'veteran', baseAlt: 350, enemyAI: 'auto',
  waypoint: null, targetMode: 'nearest', targetCarrier: null,
  bombs: [], missiles: [],
  camYaw: 0.6, camPitch: 0.32, camDist: 1100, camPan: { x: 0, y: 0 },
  camFollow: null, camTac: null, camTacIdx: 0,
  // v1.4.1: one free-orbit camera — the dive camera mode (v1.4.0,
  // item 8) is removed entirely (button, mode and U key). The orbit
  // camera itself can now go anywhere, including below the surface:
  // the pitch clamp is widened to ±1.45 and the camera floor is gone,
  // so spectating a sinking carrier pans continuously through the
  // waterline. _underwater still tracks whether the lens is submerged
  // (fog / background / tint switch).
  _underwater: false,
  // v1.4.0 (item 7, touch spec §2/§8): rudder stick mode — 'float'
  // (default on coarse pointers) or 'fixed' (menu opt-out, persisted
  // as localStorage 'helicarriers_joy_mode'); joyGhost = rest
  // position of the floating ghost ring (last used centre, or the old
  // fixed track centre on first run).
  joyMode: 'fixed', joyGhost: null,
  // v1.4.0 (item 7, touch spec §5) haptics state: _hapticLast = real
  // time of the last pattern (500 ms global floor); _hapticBuzzed =
  // carrier ids already buzzed once (H1/H2 fire once per carrier);
  // _hapticPending = kills/losses queued in onCarrierLost and flushed
  // after checkEnd() in stepSim, so a mutual destruction fires H3
  // only, never H1+H2+H3; _hapticLog = attempts, for probes.
  _hapticLast: 0, _hapticBuzzed: new Set(), _hapticPending: [], _hapticLog: [],
  // v1.2.0 spectate (Hurricane v11.15 flow): the destroyed carrier the
  // camera follows through the fall/breakup/splash/sinking. Command and
  // the helm stay with the selected live carrier — spectate never locks
  // them. Null = follow the selected carrier as usual.
  camSpectate: null,
  // v1.2.0 pitch: spring-return pitch-track value, -1..1 (+ = nose up).
  pitchTrack: 0,
  // v1.4.0 throttle: collective-style rotor strength, 0..1. 0.69 hovers
  // (1/1.45); above it the excess lift climbs, below it the ship sinks.
  // Set on the selected carrier each frame (updateSteering), like pitch.
  throttle: PHYSICS.THROTTLE_HOVER,
  rudderInput: 0, keys: {},
  enemyTimers: new Map(), enemyLoadout: new Map(),
  // v1.4.0 (item 3) enemy AI director state. focus = the fleet-wide
  // focus-fire target; assignments = per-carrier launch target
  // (carrier id -> carrier); waves coordinate launches across carriers
  // so flights arrive together instead of trickling in.
  director: {
    focus: null, focusUntil: 0, focusCycle: 0, reevalAt: 0,
    assignments: new Map(), circleDir: new Map(),
    nextWaveAt: 0, waveId: 0, waveActive: false, waveStartedAt: 0,
    waveInterval: 0, waveAttempted: new Set(), waveLaunched: 0,
    log: [], stats: { waves: 0, launches: 0, coordinatedWaves: 0 },
  },
  over: false, bombStats: { drops: 0, hits: 0, log: [] },
  // v1.4.0 (item 5) CAP stats — launches, intercepts, gun passes /
  // hits, strike aborts + ordnance denied, enemy jets spun out by CAP
  // gunfire. Read by the v14-cap probes; never shown in the HUD.
  capStats: { launches: 0, intercepts: 0, gunPasses: 0, gunHits: 0, aborts: 0, capKills: 0, ordnanceDenied: 0 },
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
  if (el) { el.textContent = text; el.style.display = 'block'; } // v1.4.1: hidden by default — the idle '—' pill sat in open sea (39212)
  G.msgT = 4;
}

// v1.4.0 (item 7, touch spec §5): haptics — navigator.vibrate only,
// five rare events only (H1 kill, H2 own loss, H3 round end, H4 freak
// wave; H5 flagship-under-fire is NOT shipped, see spawnFreakWave /
// endGame / flushHaptics). Gated on the same flag as audio
// (G.audio.muted, localStorage 'helicarriers_muted'): Sound off also
// silences vibration, and muting cancels a pattern in flight
// (navigator.vibrate(0) in the mute handler). 500 ms real-time floor
// between any two patterns. navigator.vibrate exists only in Chromium
// on Android; it is undefined in Safari (all iOS browsers) and removed
// in Firefox 129+ — feature-detect, never assume. The iOS
// <input type="checkbox" switch> Taptic trick is NOT used (patched in
// iOS 26.5); on iOS these events produce visual + audio only — a
// documented platform gap, not a bug. Desktop Chromium returns true
// with no motor — harmless. Every attempt is logged to G._hapticLog
// (kind/pattern/game time) so probes can count patterns headless,
// where no motor exists. This helper is never called from a per-frame
// path: H1/H2 go through the once-per-carrier pending queue, H3
// through endGame (runs once), H4 through spawnFreakWave.
function haptic(pattern, kind) {
  if (G.audio && G.audio.muted) return false;
  const now = Date.now();
  if (now - G._hapticLast < 500) return false;
  G._hapticLast = now;
  G._hapticLog.push({ kind: kind || 'event', pattern: [...pattern], t: now, gameT: +G.time.toFixed(1) });
  try { if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(pattern); } catch (_) {}
  return true;
}
// Flush the kill/loss queue (see G._hapticPending). Called from
// stepSim after checkEnd(): if the round just ended, the pending
// kills are dropped — a mutual destruction fires H3 only.
function flushHaptics() {
  if (!G._hapticPending.length) return;
  if (G.over) { G._hapticPending.length = 0; return; }
  for (const p of G._hapticPending) {
    if (G._hapticBuzzed.has(p.id)) continue;
    G._hapticBuzzed.add(p.id);
    haptic(p.side === 'enemy' ? [30, 50, 60] : [25, 40, 25], p.side === 'enemy' ? 'kill' : 'loss');
  }
  G._hapticPending.length = 0;
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
  // v1.4.0 (item 6): persistent floating wreckage after a carrier sinks.
  G.wreckage = new WreckageField(scene, G.sea);
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
  if (prev) { next.telegraphIdx = prev.telegraphIdx; next.rudderDeg = next.rudder * 35; }
  // v1.4.0 (spec §12.1): spoolSpeed is the ordered-speed state and is
  // NOT overwritten on transfer — the new flagship keeps its own spool
  // and the spool slews to the (copied) telegraph at 0.45/0.60 m/s^2,
  // so command transfer never lurches. (The old line set
  // next.spoolSpeed = next.forwardSpeed, which would snap the ordered
  // speed to the current speed.)
  G.selected = next;
  G.camFollow = next;
  msg('Command: ' + next.name);
  renderFleetPanels();
}
// (c) Flagship death must never leave the helm on a dead carrier. The
// moment the selected carrier stops being alive (falling, sinking or
// gone), command passes to the next live carrier of the same side —
// EXCEPT a zero-throttle fall (v1.4.1): the pods are alive and the
// player can spool her back up, so the helm stays on her while she is
// falling-and-recoverable (see the guard in ensureLiveCommand).
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
  // v1.4.1: a zero-throttle fall is not a loss — the pods are alive and
  // the player can spool her back up, so the helm stays on her while
  // she is falling-and-recoverable. (switchShip/Tab refuse non-alive
  // carriers, so transferring away would make recovery impossible.)
  // The moment she stops being falling-and-recoverable (sinking,
  // breakup, gone) the transfer below proceeds as before.
  if (G.selected && G.selected.state === 'falling' && G.selected._fallZeroThrottle) return false;
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
// Opposite side ONLY (v1.4.0 item 3 fix): the old version counted
// same-side carriers too, so the enemy flagship fled its OWN escorts —
// they sit in 450 m formation slots, inside the 600 m trigger, and
// trail the flagship wherever it goes. Measured in the director probe:
// after ~330 game-s of clean ring-holding the flagship turned
// south-east, away from the anchor, at FULL, and opened 1641 -> 3274 m
// over 140 game-s while its escort stayed inside 600 m behind it —
// a self-perpetuating flee loop. Same-side separation is the escorts'
// own job (400 m push in escortControl); keep-out is for the enemy.
function keepOutRudder(c, rudderDeg) {
  let nearest = null, nd = 1e18;
  for (const o of G.allCarriers) {
    if (o === c || !o.alive || o.side === c.side) continue;
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
// v1.4.0 flight physics (spec §5/§6) — ONE implementation shared by
// driveCarrier (flagships, player helm, enemy AI, ANCHOR ships) and
// escortControl (formation escorts). A partial change that left
// escorts on the old instant model would read as a bug, so both paths
// call this with their own ordered speed and rudder.
//   rudder: slews at 8 deg/s toward target (was 40).
//   spool: spoolSpeed (the ordered-speed state) slews toward the
//     ordered speed at 0.45 m/s^2 up / 0.60 down (was a 6/10 clamp on
//     forwardSpeed itself); forwardSpeed chases it with tau 4 s. Peak
//     accel is therefore ~0.45 m/s^2 = T_FWD_MAX/m by construction.
//     Stopping is ACTIVE reverse thrust, never drag (drag at 20 m/s is
//     0.4 MN against 54 MN forward thrust — it would take ~1000 s).
//   turn: omega_cmd = rudder x OMEGA_MAX x speedFactor x steering x
//     lift-authority, capped by the coordinated-bank limit
//     g*tan(10 deg)/max(|V|,6) — so turn rate FALLS with speed, the
//     opposite of the old flat 6.9 deg/s. headingRate chases it with
//     tau 6 s (yaw accel 0.0148 rad/s^2 from the measured 58.2 m lever).
//     Bank is the RESULT: atan(headingRate*|V|/g), capped +-10 deg,
//     lagged at tau 1.5 s; carrier.js renders roll = bank+list+heel.
//     Astern turns the bow the opposite way at 25% (Hurricane rule).
function driveCarrierPhysics(c, dt, rudderDeg, orderedSpeed) {
  if (!c.alive) return;
  // Rudder slew toward target.
  const slew = PHYSICS.RUDDER_SLEW * dt;
  c.rudderDeg += clamp(rudderDeg - c.rudderDeg, -slew, slew);
  c.rudder = c.rudderDeg / 35;
  // Spool: ordered speed slews, forward speed chases with a lag.
  const rate = orderedSpeed > c.spoolSpeed ? PHYSICS.SPOOL_UP : PHYSICS.SPOOL_DOWN;
  c.spoolSpeed += clamp(orderedSpeed - c.spoolSpeed, -rate * dt, rate * dt);
  c.forwardSpeed += (c.spoolSpeed - c.forwardSpeed) * (1 - Math.exp(-dt / PHYSICS.TAU_SPEED));
  // Turn: bank-limited, lagged, authority scales with lift (§7.4).
  const auth = 0.5 + 0.5 * c.lift;
  const speedFactor = 0.15 + 0.85 * Math.min(1, Math.abs(c.forwardSpeed) / 12);
  let omegaCmd = c.rudder * PHYSICS.OMEGA_MAX * speedFactor * c.steeringFactor * auth;
  const omegaCap = GRAV * Math.tan(PHYSICS.BANK_MAX) / Math.max(Math.abs(c.forwardSpeed), 6);
  omegaCmd = clamp(omegaCmd, -omegaCap, omegaCap);
  c.headingRate += (omegaCmd - c.headingRate) * (1 - Math.exp(-dt / PHYSICS.TAU_YAW));
  c.heading += c.headingRate * dt * (c.forwardSpeed >= 0 ? 1 : -0.25);
  c.yawRate = c.headingRate;
  // Bank from the ACTUAL turn rate and speed (Pandora lesson: bank is
  // the result of turn rate, never an input), lagged at TAU_ROLL.
  const bankTarget = clamp(Math.atan(c.headingRate * Math.abs(c.forwardSpeed) / GRAV), -PHYSICS.BANK_MAX, PHYSICS.BANK_MAX);
  c.bank += (bankTarget - c.bank) * (1 - Math.exp(-dt / PHYSICS.TAU_ROLL));
  const fx = Math.sin(c.heading), fz = -Math.cos(c.heading);
  c.vx = fx * c.forwardSpeed; c.vz = fz * c.forwardSpeed;
  c.x += c.vx * dt; c.z += c.vz * dt;
  // Wave push + tide are small at altitude; apply a whisper of drift.
  const push = G.sea.wavePush(c.x, c.z, G.time);
  c.x += push.x * dt * 0.1; c.z += push.z * dt * 0.1;
}
function driveCarrier(c, dt, rudderDeg, isDriven) {
  if (!c.alive) return;
  const stage = STAGES[G.stage];
  // Telegraph spool: ordered speed in m/s. Turn bleed 0.15 (was 0.33 —
  // at 10 deg bank the load factor is 1.015, nothing supports losing a
  // third of top speed in a turn). Throttle couples with forward speed:
  // at the 69% hover throttle the factor is 1.0, full throttle gives
  // ~1.22x ordered speed, idle ~0.5x.
  const frac = TELEGRAPH[c.telegraphIdx].frac;
  const throttleFwd = 0.5 + 0.5 * (c.throttle / PHYSICS.THROTTLE_HOVER);
  const maxSpd = stage.speed * c.engineFactor * (1 - PHYSICS.TURN_LOSS * c.rudder * c.rudder) * throttleFwd;
  const ordered = frac * maxSpd;
  driveCarrierPhysics(c, dt, rudderDeg, ordered);
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
    // Desired heading. Two regimes, split on whether the flagship is
    // turning (v1.4.0 §5.2 fix, verified by probe):
    //  - Flagship TURNING (|headingRate| > ~1 deg/s): the slot swings at
    //    up to omega*r (42 m/s for a 450 m slot at hard rudder) and
    //    chasing its bearing with a 6 s yaw lag leaves the escort 60-80
    //    deg behind and 1.1 km off after a 90 deg turn (and SHIELD-2
    //    rammed the flagship at 16.1 m/s, 159 damage to both magazines).
    //    So fly the flagship's heading — formation-keeping, let the slot
    //    come to you.
    //  - Flagship STEADY: the original law, flag.heading + clamp(slot
    //    bearing, +-0.35). A wider clamp (1.2 rad) recovered a scattered
    //    formation fully in 235 s but the escorts cut across the flagship
    //    on their way back and rammed it (111 damage to a pod + a
    //    magazine at 13.4 m/s closing); a 0.6 rad clamp was worse — the
    //    error GREW to 1883 m, because an escort flying 34 deg off can't
    //    match the flagship's along-track speed even at max catch-up.
    //    So the clamp stays tight: after a hard turn the formation
    //    stalls ~800 m off and needs manual recovery (Tab), which is
    //    the safe failure — no self-damage. The turn scatter itself
    //    (~1.2 km) is geometric, not a tuning issue: the slots swing at
    //    42-82 m/s while escorts top out at 22 m/s.
    let desHeading = flag.heading;
    if (distToSlot > 6) {
      let dh = slotBrg - flag.heading;
      dh = ((dh + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      if (Math.abs(flag.headingRate) > 0.02) {
        desHeading = flag.heading;
      } else {
        desHeading = flag.heading + clamp(dh, -0.35, 0.35);
      }
    }
    let dh = desHeading - c.heading;
    dh = ((dh + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    rudderIn = clamp(dh * 1.5, -1, 1);
    if (distToSlot < 25) rudderIn *= 0.7;
    // Speed: mirror the flagship + bounded catch-up on the ALONG-TRACK
    // error only. v1.4.0 §5.2 fix, verified by probe: the old law used the
    // UNSIGNED distance — desSpeed = flag.fwd + clamp((dist-20)*0.05, +-3)
    // — so an escort AHEAD of its slot sped up and fell further behind.
    // SHIELD-3 spawns 900 m ahead of its slot (spawn z-450 vs slot z+450)
    // and its error grew 900 -> 2750 m in 900 game-s; SHIELD-2 hunted
    // +-130-170 m around its slot and grazed the flagship's stern once
    // per weave cycle, cutting flagship speed 16 -> ~11.5 m/s each time
    // (collisions.js velocity deflection applies to any approaching
    // contact, even a no-damage graze); SHIELD-2/4 then collided at
    // ~t600 and their engines zones were destroyed (maxSpd clamps to
    // 6 m/s), so they fell behind at 10 m/s forever. Lateral error is
    // the rudder's job, not the throttle's; the gain is lowered 0.05 ->
    // 0.02 per §5.2 (with a 4 s speed lag the old gain overshoots).
    //   alongErr > 0: escort ahead of its slot -> slow down.
    const fx = Math.sin(h), fz = -Math.cos(h);
    const alongErr = (c.x - tx) * fx + (c.z - tz) * fz;
    desSpeed = flag.forwardSpeed - clamp(alongErr * 0.02, -3, 3);
    if (flag.forwardSpeed < 1 && distToSlot < 30) desSpeed = 0;
  }
  const stage = STAGES[G.stage];
  const maxSpd = Math.max(6, stage.speed * c.engineFactor + 2);
  desSpeed = clamp(desSpeed, -maxSpd * 0.5, maxSpd);
  // v1.4.0: escorts drive through the same shared physics as flagships
  // (spool 0.45/0.60, tau 4 s, bank-limited lagged turns) — their slot
  // target becomes the ordered speed, not a direct speed clamp.
  driveCarrierPhysics(c, dt, rudderIn * 35, desSpeed);
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
  // v1.4.0 throttle: the collective-style throttle track (or Shift+W/S,
  // or +/- keys) sets rotor strength on the selected carrier, every
  // frame — same pattern as pitch, an independent input, not a mode.
  if (G.selected) {
    const keyPitch = (G.keys['ArrowUp'] ? 1 : 0) + (G.keys['ArrowDown'] ? -1 : 0);
    G.selected.pitchInput = clamp(G.pitchTrack + keyPitch, -1, 1);
    G.selected.throttle = clamp(G.throttle, 0, 1);
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
    // v1.4.0 mass (audit F7): pure pursuit cannot re-acquire the
    // bearing fast enough under the τ=6 s yaw lag at 4 m/s closing,
    // so the gentle course used to slip past with ~106 m clearance
    // and zero contact. Aim at the INTERCEPT point instead: the
    // target's position advanced by its velocity over the time to
    // close — a bearing-rate/lead term, not a wider turn.
    const tvx = t.state === 'falling' ? (t.fallVx || 0) : (t.vx || 0);
    const tvz = t.state === 'falling' ? (t.fallVz || 0) : (t.vz || 0);
    const dx = t.x - c.x, dz = t.z - c.z;
    const dist = Math.hypot(dx, dz) || 1;
    const closing = Math.max(1, -((tvx - (c.vx || 0)) * dx + (tvz - (c.vz || 0)) * dz) / dist);
    const tClose = dist / closing;
    const px = t.x + tvx * tClose, pz = t.z + tvz * tClose;
    const want = Math.atan2(px - c.x, -(pz - c.z));
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
      // v1.4.0 mass (audit F1): non-selected ships stop through the
      // shared physics (ordered speed 0, rudder 0) — the old branch
      // decayed only the speed READOUT (τ=2 s) while vx/vz stayed
      // stale, so a ship sailed 643 m in 39 s at 15.7 m/s while
      // reading 0. The stop now follows the spec spool-down
      // (0.60 m/s², τ=4 s, ~31 s / 274 m) with vx/vz consistent.
      for (const c of G.playerFleet) if (c !== sel && c.alive && !inCollidePair(c)) driveCarrierPhysics(c, dt, 0, 0);
    } else { // ANCHOR: selected holds, the rest are driven together
      for (const c of G.playerFleet) {
        if (inCollidePair(c)) continue;
        // v1.4.0 mass (audit F2): the selected ship stops through the
        // shared physics too — the old branch froze her position in a
        // single frame (16 m/s → 0 in one frame, infinite
        // deceleration for a 120,000 t ship). Station-keeping, if
        // ever needed, must be an ordered speed toward the anchor
        // point capped at 2 m/s — never a position freeze.
        if (c === sel) driveCarrierPhysics(c, dt, 0, 0);
        else driveCarrier(c, dt, keepOutRudder(c, G.waypoint ? wpRudderFor(c) : 0), true);
      }
    }
    if (G.waypoint) {
      const d = Math.hypot(G.waypoint.x - sel.x, G.waypoint.z - sel.z);
      if (d < 100) { G.waypoint = null; msg('Waypoint reached'); }
    }
  }
  // Enemy flagship holds a standoff ring on the player flagship
  // (v1.4.0 item 3) — Hurricane's close-to-band-then-circle, rescaled:
  // outside 1400+250 m close in at FULL, inside 1400-250 m open the
  // range, inside the band circle the target (tangent heading, direction
  // alternating per carrier). STANDARD in the band / opening, as in
  // Hurricane. The old code steamed straight at the player flagship at
  // FULL until the hulls met. Escorts still follow the flagship's
  // formation slots, so the whole enemy fleet orbits with her.
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
      directorEvaluate(G.time);
      const D = G.director;
      // The ring is anchored on the player FLAGSHIP (first live player
      // carrier) — the fleet's position — not on the strike focus
      // target: the focus rotates between ships as damage accumulates,
      // and a ring that chased it would swing the whole fleet around
      // every 35 s instead of holding. Strikes still go to the focus
      // target (director assignments); the carriers hold the ring
      // around the flagship while the jets do the hunting.
      const anchor = pFlag;
      if (!D.circleDir.has(eFlag.id)) {
        const idx = G.enemyFleet.indexOf(eFlag);
        D.circleDir.set(eFlag.id, idx % 2 === 0 ? 1 : -1);
      }
      const dx = anchor.x - eFlag.x, dz = anchor.z - eFlag.z;
      const d = Math.hypot(dx, dz) || 1;
      const toTgt = Math.atan2(dx, -dz);
      let desH;
      if (d > DIRECTOR_OPT_RANGE + DIRECTOR_BAND) desH = toTgt; // too far — close in
      else if (d < DIRECTOR_OPT_RANGE - DIRECTOR_BAND) desH = toTgt + Math.PI; // too close — open the range
      else desH = toTgt + (Math.PI / 2) * D.circleDir.get(eFlag.id); // in the band — circle the target
      let dh = desH - eFlag.heading;
      dh = ((dh + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      const rud = keepOutRudder(eFlag, clamp(dh * 1.5, -1, 1) * 35);
      if (!inCollidePair(eFlag)) eFlag.telegraphIdx = d > DIRECTOR_OPT_RANGE + DIRECTOR_BAND ? 1 : 2; // FULL to close, STANDARD to hold/circle
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
      $('btnCam').textContent = '📷 Fleet [C]';
    } else {
      $('btnCam').textContent = '📷 ' + G.tacMode[0].toUpperCase() + G.tacMode.slice(1) + ' [C]';
    }
  }
  // v1.3.0 (E): a tracked target that died / landed ends the track.
  if (G.camTac && G.tacTarget && !tacTargetValid()) {
    G.tacMode = null; G.tacKind = null; G.tacTarget = null; G.camTac = null;
    $('btnCam').textContent = '📷 Fleet [C]';
  }
  if (G.camTac) return G.camTac;
  if (G.camFollow) return G.camFollow.group ? { x: G.camFollow.x, y: G.camFollow.y, z: G.camFollow.z } : G.camFollow;
  const s = G.selected;
  return s ? { x: s.x, y: s.y, z: s.z } : { x: 0, y: 350, z: 0 };
}
function updateCamera(dt) {
  const t = cameraTarget();
  let tx = t.x + G.camPan.x, ty = t.y + G.camPan.y, tz = t.z; // camPan is {x, y}: x = lateral, y = vertical; no z component
  // v1.3.0 (E): during a detonation hold the camera pulls back for a
  // wide framing of the blast, then eases back when the hold ends.
  const dist = G.tacHoldPos ? Math.max(G.camDist, 900) : G.camDist;
  const want = orbitPos({ x: tx, y: ty, z: tz }, G.camYaw, G.camPitch, dist);
  // v1.4.1: one free-orbit camera — no dive blend, no camera floor.
  // The orbit position is used as computed, so the camera can go
  // below the surface, underneath the carrier, or straight overhead
  // at any zoom; the underwater switch below still follows the lens.
  const k = 1 - Math.exp(-dt * 6);
  G.camera.position.lerp(want, k);
  G.camera.lookAt(tx, ty, tz);
  // Underwater state (Hurricane v11.5, metric): when the lens is
  // below the local sea surface the scene becomes underwater — deep
  // blue-green background, dense murk fog, and the water tint wash.
  // The ocean mesh is DoubleSide, so the surface renders from below
  // as a bright ceiling. Applied only on change, never per frame.
  if (G.started) {
    const camSeaH = G.sea.waveHeight(G.camera.position.x, G.camera.position.z, G.time);
    const submerged = G.camera.position.y < camSeaH;
    if (submerged !== G._underwater) {
      G._underwater = submerged;
      if (submerged) {
        // Murk density rescaled from Hurricane's FogExp2 0.03 per
        // Hurricane unit (1 unit ≈ 5.74 m): 0.03/5.74 ≈ 0.005/m. At
        // the dive distance (~200 m) a wreck is ~35% visible through
        // the murk; the verbatim 0.03 would fog it out entirely
        // (99.7% fog at 200 m — the first dive probe frame was a
        // uniform murk colour).
        G.scene.fog = new THREE.FogExp2(0x06283a, 0.005); // murk: a sinking hull stays visible at inspection range
        G.scene.background.setHex(0x0a3547);
      } else {
        G.scene.fog = new THREE.Fog(0x9fc3d8, 800, 6000);
        G.scene.background.setHex(0x9fc3d8);
      }
      const tint = $('waterTint');
      if (tint) tint.style.opacity = submerged ? '0.85' : '0';
    }
  }
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
  const setBtn = (label) => { $('btnCam').textContent = '📷 ' + label[0].toUpperCase() + label.slice(1) + ' [C]'; };
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
  $('btnCam').textContent = '📷 Impact hold [C]';
}
function tacTargetValid() {
  const t = G.tacTarget;
  if (!t) return false;
  if (t.state !== undefined) return ['climb', 'ingress', 'attack', 'egress', 'rtb', 'trap', 'spinout', 'crashed'].includes(t.state);
  return t.alive === true;
}

// ---------- HUD ----------
function zoneLine(c) {
  // v1.4.1: zones as single-letter codes + numbers (R reactor, M
  // magazine, B bridge, D deck, E engines) — same readouts, no words.
  const z = c.zones;
  const podLine = 'Pods ' + c.pods.map(p => p.alive ? '●' : '✕').join('');
  const f = (k, label) => `<b>${label}</b> ${Math.round(z[k].hp / z[k].max * 100)}%`;
  const fires = c.fires.map(f => `<span class="fire">🔥${f.zone.replace('pod:', 'pod ')}</span>`).join(' ');
  return `${podLine}<br>${f('reactor', 'R')} · ${f('magazine', 'M')} · ${f('bridge', 'B')} · ${f('deck', 'D')} · ${f('engines', 'E')}${fires ? '<br>' + fires : ''}`;
}
function carrierRowHTML(c, selectable) {
  const cls = 'carrierRow' + (G.selected === c ? ' sel' : '') + (c.state === 'gone' || c.state === 'sinking' ? ' dead' : '') + (G.camSpectate === c ? ' watch' : '');
  const hpCls = c.hpFrac > 0.6 ? '' : c.hpFrac > 0.3 ? ' hurt' : ' crit';
  const barCls = c.hpFrac > 0.6 ? '' : c.hpFrac > 0.3 ? 'mid' : 'low';
  const wing = c.wing ? ` · ✈ ${c.wing.remaining} (${c.wing.airborneCount()} ↑)` + (c.wing.squadrons.some(s => s.state === 'launchQueued') ? ' · ⏳' : '') + (c.wing.squadrons.some(s => s.loadout === 'cap' && ['catapult', 'climb', 'patrol', 'intercept'].includes(s.state)) ? ' · 🛡' : c.wing.capOn ? ' · 🛡' : '') : '';
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
    <div class="zones">⇧ ${Math.round(c.lift * 100)}% · ⬍ ${Math.round(c.y)} · ➤ ${Math.abs(c.forwardSpeed).toFixed(0)}${wing}<br>${zoneLine(c)}</div>
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
      else { G.targetCarrier = c; G.targetMode = 'designated'; $('btnTarget').textContent = '🎯 ' + c.name.replace('SHIELD-', 'S').replace('ENEMY-', 'E'); msg('Target designated: ' + c.name); }
    });
  });
}
function updateTeleBox() {
  const t = TELEGRAPH[G.telegraphIdx];
  $('teleNotch').textContent = t.name;
  const s = G.selected;
  // v1.4.1: icon readouts — speed ➤, rudder ⎋, mode as icon + code.
  $('teleSub').textContent = (s ? `➤ ${Math.abs(s.forwardSpeed).toFixed(0)} · ⎋ ${Math.round(s.rudderDeg)}°` : '—');
  $('rudderReadout').textContent = '↔ ' + (s ? Math.round(s.rudderDeg) + '°' : '0°');
  $('modeBtn').textContent = G.mode === 'FLEET' ? '▦ FLEET' : G.mode === 'INDV' ? '◉ INDV' : '⚓ ANCHOR';
  document.querySelectorAll('#teleBtns .teleBtn').forEach(b => b.classList.toggle('on', +b.dataset.idx === G.telegraphIdx));
}
function updateStatus() {
  const s = G.selected;
  if (!s) return;
  // v1.2.0: pitch readout follows the selected carrier's real pitch
  // angle whenever the pitch track / arrow keys are not actively held.
  // v1.4.1: icon arrow + number, no word.
  if (Math.abs(G.pitchTrack) < 0.02 && !G.keys['ArrowUp'] && !G.keys['ArrowDown']) {
    const pd = Math.round(s.pitch * 57.2958);
    $('pitchReadout').textContent = (pd >= 0 ? '▲ +' : '▼ ') + pd + '°';
  }
  // v1.1.0: the wide centred status strip is gone — its facts live in the
  // Hurricane-style top pill bar (ship / nav / air) and the minimap stats.
  // v1.4.1: icons/bars/dots/numbers — ship icon + code + lift mini-bar
  // + % + pod dots; alt/speed as icons + numbers; jets/bombs/sea as
  // icons + numbers. No readout lost, no words left in the pills.
  const pods = s.pods.map(p => p.alive ? '●' : '✕').join('');
  const liftPct = Math.round(s.lift * 100);
  const code = s.name.replace('SHIELD-', 'S').replace('ENEMY-', 'E');
  $('pillShip').innerHTML = `<b>🚢 ${code}</b> <span class="minibar"><i style="width:${liftPct}%"></i></span> ${liftPct}% · ${pods}`;
  $('pillNav').textContent =
    `⬍ ${Math.round(s.y)} (→${Math.round(s.targetAlt)}) · ➤ ${Math.abs(s.forwardSpeed).toFixed(0)}`;
  $('pillAir').textContent =
    `✈ ${G.playerFleet.reduce((a, c) => a + (c.wing ? c.wing.remaining : 0), 0)} · ` +
    `💣 ${G.bombStats.drops}/${G.bombStats.hits} · 🌊 ${STAGES[G.stage].name} ${G.sea.HS.toFixed(1)}`;
  $('miniStats').innerHTML =
    `<span class="dot you"></span> ${G.playerFleet.filter(c => c.alive).length}/${G.playerFleet.length} · <span class="dot foe"></span> ${G.enemyFleet.filter(c => c.alive).length}/${G.enemyFleet.length}`;
}

// ---------- Minimap / tactical radar (v1.3.0, F) ----------
// Hurricane TacticalRadarHUD layers on the existing minimap: rotating
// sweep, range-ring labels, airborne squadrons as chevrons coloured by
// mission state, ordnance as tracking streaks, storm clutter
// (dimmed/flickering contacts in Storm/Hurricane).
const SQ_COLORS = { climb: '#dfeef5', ingress: '#ffd166', attack: '#ff7a3c', egress: '#e8b13c', rtb: '#58c98a', trap: '#7ad4f5', divert: '#c98ad4', spinout: '#ff5a5a', patrol: '#9fd8ff', intercept: '#ff9f43' };
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
  // v1.4.0 (item 6): wreckage sites — a dark dot per field with a ring
  // sized to its oil slick, so a sunk carrier stays findable.
  if (G.wreckage) for (const f of G.wreckage.fields) {
    const cx = f.cx !== undefined ? f.cx : f.x, cz = f.cz !== undefined ? f.cz : f.z;
    g.fillStyle = 'rgba(120,120,120,0.9)';
    g.beginPath(); g.arc(px(cx), pz(cz), 3, 0, Math.PI * 2); g.fill();
    if (f.slick) {
      g.strokeStyle = 'rgba(120,120,120,0.45)';
      g.beginPath(); g.arc(px(cx), pz(cz), Math.max(3, f.slick.scale.x / R * W / 2), 0, Math.PI * 2); g.stroke();
    }
  }
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
// v1.4.0 (item 5) CAP: the Air Ops button follows the selected
// carrier's wing — ON while that wing has a standing patrol ordered.
function syncCapBtn() {
  const el = $('btnCap');
  if (!el) return;
  const carrier = G.selected && G.selected.alive ? G.selected : G.playerFleet.find(c => c.alive);
  const on = !!(carrier && carrier.wing && carrier.wing.capOn);
  el.textContent = on ? '🛡 CAP patrol: ON (tap to stand down)' : '🛡 Launch CAP patrol';
  el.classList.toggle('on', on);
}
// ---------- v1.4.0 (item 3) enemy AI director ----------
// Replaces the v1 launch timer + nearest-target + beeline. Three parts:
//   (1) tactical target selection — score by damage, crippled lift,
//       fires, isolation and distance, with skill-scaled noise, so the
//       enemy prefers a hurt carrier over the nearest hull and different
//       carriers can disagree;
//   (2) focus fire — one fleet-wide focus target, held for a skill-
//       scaled window (longer at low skill: cadets fixate, elites
//       re-aim sooner); ~3/4 of the live enemy carriers strike the
//       focus, the rest hunt the best secondary target, so the enemy
//       neither dogpiles one ship with everything nor spreads evenly;
//   (3) coordinated waves — launches are scheduled as a wave, one
//       flight per carrier, staggered by a few seconds (tighter at
//       higher skill), so flights from several carriers arrive together
//       instead of trickling in one by one on independent timers.
// The director never adds air-to-air combat (proposal 1 was not
// chosen): it commands strike flights only. Damage amounts, AD
// constants and the flight model are untouched.
function directorLog(kind, fields) {
  const D = G.director;
  D.log.push({ t: +G.time.toFixed(1), kind, ...fields });
  if (D.log.length > 200) D.log.shift();
}
// Tactical value of one player carrier as seen from `from`. Higher is
// a better target. Distance costs ~25 pts at standoff range, so a
// damaged far carrier still beats a healthy near one; the flagship
// carries only a small premium so the enemy does not always dogpile
// her; a target already focused gets stickiness so the focus does not
// flip every re-evaluation.
function directorScoreTarget(tgt, from, noise) {
  let s = 40;
  s += (1 - tgt.hpFrac) * 70; // damaged first
  s += (1 - tgt.lift) * 30; // crippled lift
  if (tgt.fires.length) s += 15;
  if (!tgt.canLaunch) s += 10; // deck too damaged to strike back
  if (tgt === G.selected) s += 8; // flagship premium — small, not dominant
  let allyD = 1e9;
  for (const p of G.playerFleet) {
    if (p !== tgt && p.alive) allyD = Math.min(allyD, Math.hypot(p.x - tgt.x, p.z - tgt.z));
  }
  if (allyD > 700) s += 15; // isolated — no mutual AD cover
  const d = Math.hypot(tgt.x - from.x, tgt.z - from.z);
  s -= d * 0.018;
  if (G.director.focus === tgt) s += 20; // stickiness
  s += (Math.random() - 0.5) * 2 * noise;
  return s;
}
function directorBestTarget(from, exclude) {
  const noise = SKILLS[G.skill].aimErr;
  let best = null, bs = -1e18;
  for (const p of G.playerFleet) {
    if (!p.alive || p === exclude) continue;
    const s = directorScoreTarget(p, from, noise);
    if (s > bs) { bs = s; best = p; }
  }
  return best;
}
function directorEvaluate(now) {
  const D = G.director;
  const aliveE = G.enemyFleet.filter(c => c.alive);
  const aliveP = G.playerFleet.filter(c => c.alive);
  if (!aliveE.length || !aliveP.length) return;
  // Per-carrier strike separation (AD-tuning note): each enemy carrier
  // flies its strike flights on its own lane / altitude step, so
  // flights from different carriers never share a climb-out or ingress
  // line. Applied in jets.js (climb/ingress/egress/popup aims); the
  // dive geometry itself is untouched. Note this separates ROUTES, not
  // mid-air collisions: the collision rule is per-wing, so two flights
  // of the SAME carrier can still meet — that is already handled by the
  // per-squadron climb lanes and rtb offsets in jets.js.
  aliveE.forEach((c, i) => {
    if (c.wing && !c.wing._directorLaneSet) {
      c.wing._directorLaneSet = true;
      c.wing.strikeLaneOffset = ((i % 3) - 1) * 120;
      c.wing.strikeAltOffset = (i % 3) * 45;
    }
    if (!D.circleDir.has(c.id)) D.circleDir.set(c.id, i % 2 === 0 ? 1 : -1);
  });
  if (now < D.reevalAt) return;
  const dsk = DIRECTOR_SKILL[G.skill] || DIRECTOR_SKILL.veteran;
  D.reevalAt = now + dsk.reevalS;
  const flag = aliveE[0];
  // Focus: re-pick only when there is none, it died, or its window
  // expired. Otherwise the focus holds even if the scores shift.
  if (!D.focus || !D.focus.alive || now >= D.focusUntil || aliveP.length === 1) {
    const prev = D.focus ? D.focus.name : null;
    D.focus = directorBestTarget(flag, null) || aliveP[0];
    D.focusUntil = now + dsk.focusS;
    D.focusCycle++;
    if (D.focus && D.focus.name !== prev) {
      directorLog('focus', { target: D.focus.name, until: +D.focusUntil.toFixed(1) });
    }
  }
  // Assignments: ~3/4 of the live enemy carriers on the focus, the
  // rest on the best secondary target. Which carriers hunt secondary
  // rotates each focus cycle, so no carrier is permanently the odd one.
  const n = aliveE.length;
  const focusCount = Math.max(1, Math.ceil(n * 0.75));
  const rot = D.focusCycle % Math.max(1, n);
  const ordered = aliveE.slice(rot).concat(aliveE.slice(0, rot));
  D.assignments.clear();
  ordered.forEach((c, i) => {
    if (i < focusCount) D.assignments.set(c.id, D.focus);
    else D.assignments.set(c.id, directorBestTarget(c, D.focus) || D.focus);
  });
}
function directorReset() {
  const D = G.director;
  D.focus = null; D.focusUntil = 0; D.focusCycle = 0; D.reevalAt = 0;
  D.assignments.clear(); D.circleDir.clear();
  D.nextWaveAt = G.time + 5; // first strike early, not at t=0
  D.waveId = 0; D.waveActive = false; D.waveStartedAt = 0;
  D.waveInterval = 0; D.waveAttempted = new Set(); D.waveLaunched = 0;
  D.log = []; D.stats = { waves: 0, launches: 0, coordinatedWaves: 0 };
}
function enemyDirector(dt) {
  if (G.enemyAI !== 'auto' || G.over) return;
  const D = G.director;
  const aliveE = G.enemyFleet.filter(c => c.alive && c.wing);
  const aliveP = G.playerFleet.filter(c => c.alive);
  if (!aliveE.length || !aliveP.length) { D.waveActive = false; return; }
  directorEvaluate(G.time);
  const sk = SKILLS[G.skill];
  const dsk = DIRECTOR_SKILL[G.skill] || DIRECTOR_SKILL.veteran;
  // Start a wave when the clock says so: one flight per carrier, each
  // carrier firing at its staggered slot so the flights arrive together.
  if (!D.waveActive && G.time >= D.nextWaveAt) {
    D.waveActive = true;
    D.waveId++;
    D.waveStartedAt = G.time;
    D.waveInterval = sk.launchInterval * (0.9 + Math.random() * 0.2);
    D.nextWaveAt = G.time + D.waveInterval;
    D.waveAttempted = new Set();
    D.waveLaunched = 0;
    D.stats.waves++;
    directorLog('wave', { wave: D.waveId, target: D.focus ? D.focus.name : null, interval: +D.waveInterval.toFixed(1), nextWaveAt: +D.nextWaveAt.toFixed(1) });
  }
  if (D.waveActive) {
    aliveE.forEach((e, i) => {
      if (D.waveAttempted.has(e.id)) return;
      if (G.time < D.waveStartedAt + i * dsk.stagger) return;
      D.waveAttempted.add(e.id);
      let tgt = D.assignments.get(e.id);
      if (!tgt || !tgt.alive) tgt = directorBestTarget(e, null) || D.focus;
      if (!tgt || !tgt.alive) return;
      const loadout = (G.enemyLoadout.get(e.id) || 'bomb') === 'bomb' ? 'asm' : 'bomb';
      G.enemyLoadout.set(e.id, loadout);
      const ok = e.wing.launch(loadout, tgt, makeCtx());
      if (ok === true || ok === 'queued') {
        D.waveLaunched++;
        D.stats.launches++;
        directorLog('launch', { wave: D.waveId, carrier: e.name, target: tgt.name, loadout, queued: ok === 'queued' });
      }
    });
    // Wave ends once every live carrier has had its slot (plus a
    // margin), or all carriers are dead / out of targets.
    const done = aliveE.every(e => D.waveAttempted.has(e.id));
    if (done || G.time > D.waveStartedAt + aliveE.length * dsk.stagger + 10) {
      if (D.waveLaunched >= 2) D.stats.coordinatedWaves++;
      D.waveActive = false;
    }
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
  // v1.4.0 (item 7, touch spec §5.2 H3): round end buzzes exactly
  // once — win is a rising triple-tick, loss/draw a single heavy
  // thud. endGame runs once (G.over is set first), and flushHaptics
  // drops any pending kill/loss buzzes when the round ends, so a
  // mutual destruction fires H3 only, never H1+H2+H3.
  haptic(result === 'win' ? [20, 60, 20, 60, 40] : [80, 80, 120], 'end-' + result);
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
    scene: G.scene, sea: G.sea, vfx: G.vfx, wreckage: G.wreckage, time: G.time,
    bombs: G.bombs, missiles: G.missiles,
    audio: G.audio, carriers: G.allCarriers,
    cap: G.capStats, // v1.4.0 (item 5): CAP counters (launches / intercepts / gun / aborts)
    // v1.3.0 (E): a detonation near the tactical-camera target holds
    // the camera on the blast (see noteDetonation below).
    noteDetonation: (x, y, z, kind) => noteDetonation(x, y, z, kind),
    msg, onCarrierLost: (c) => {
      // v1.4.0 (item 7, touch spec §5.2 H1/H2): a carrier loss queues
      // exactly one buzz per carrier (guarded by _hapticBuzzed at
      // flush time) — enemy kill [30,50,60], own loss [25,40,25], so
      // the player can tell them apart without looking. Queued, not
      // fired here: onCarrierLost runs inside the carrier update, and
      // checkEnd() may end the round in the same frame — the flush in
      // stepSim drops the queue when the round ends (H3 only). Never
      // called from checkEnd() or any per-frame path.
      if (!G._hapticBuzzed.has(c.id) && !G._hapticPending.some(p => p.id === c.id))
        G._hapticPending.push({ id: c.id, side: c.side });
      ensureLiveCommand(c); renderFleetPanels(); checkEnd();
    },
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
  // v1.4.0 (item 7, touch spec §5.2 H4): one buzz with the warning.
  // Fires at most once per wave spawn by construction. (H5 — a tick
  // when the flagship is under fire — is deliberately NOT shipped;
  // see spec §5.2.)
  haptic([20, 40, 20], 'freak-wave');
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
  // v1.4.0 (item 7, touch spec §7): ONE pointer registry for the
  // whole HUD. Roles are exclusive: a pointerId belongs to exactly
  // one role until pointerup / pointercancel / lostpointercapture.
  // Live roles: rudder + pitch + throttle + orbit + pinch-partner
  // (spec §7.3 counts 4 — v1.3 had no throttle track; the throttle
  // is the fifth role, same pattern). A second pointerdown on a
  // control whose role is already taken is IGNORED — this fixes the
  // joyId/ptId single-var hole (spec §7.1 defect 2), where a second
  // touch overwrote the owner id and orphaned the first thumb.
  // Buttons stay click-only with no capture, so a button tap during
  // a rudder hold never disturbs the held stick.
  const pointers = new Map(); // pointerId -> role
  const pointerPos = new Map(); // pointerId -> {x, y} latest client coords
  const rolePointer = role => { for (const [id, r] of pointers) if (r === role) return id; return null; };
  const claim = (e, role) => {
    if (pointers.has(e.pointerId)) return false;
    if (rolePointer(role) !== null) return false;
    pointers.set(e.pointerId, role);
    pointerPos.set(e.pointerId, { x: e.clientX, y: e.clientY });
    return true;
  };
  const releasePointer = e => {
    const role = pointers.get(e.pointerId);
    if (!role) return null;
    pointers.delete(e.pointerId);
    pointerPos.delete(e.pointerId);
    return role;
  };
  // Canvas orbit + pinch, Pointer Events ONLY. The legacy Touch
  // Events pinch listeners (touchstart/touchmove/touchend + the
  // `touches` Map) are DELETED (spec §7.1 defect 1): two input
  // systems on one element dropped the second finger's pointerdown
  // in the orbit handler while consuming its touchstart in the pinch
  // handler. The old `isPrimary === false -> return` gate is deleted
  // with them; the Map is the gate now.
  let dragging = false, lastX = 0, lastY = 0, shiftDrag = false;
  let downX = 0, downY = 0; // tap anchor (Euclidean, reset every pointerdown — spec §6)
  let pinchD = 0;
  cv.addEventListener('pointerdown', e => {
    const role = rolePointer('orbit') === null ? 'orbit' : 'pinch';
    if (!claim(e, role)) return;
    if (role === 'orbit') {
      dragging = true; downX = e.clientX; downY = e.clientY; lastX = e.clientX; lastY = e.clientY;
      shiftDrag = e.shiftKey;
    } else {
      const oid = rolePointer('orbit');
      const o = oid !== null ? pointerPos.get(oid) : null;
      if (o) pinchD = Math.hypot(o.x - e.clientX, o.y - e.clientY);
    }
    try { cv.setPointerCapture(e.pointerId); } catch (_) {}
  });
  cv.addEventListener('pointermove', e => {
    const role = pointers.get(e.pointerId);
    if (!role) return;
    pointerPos.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (role === 'orbit') {
      if (!dragging) return;
      // While a pinch is live, the orbit finger only updates its
      // anchor — it must not orbit the camera at the same time as
      // the pinch zooms it (and the anchor update is what stops the
      // camera jumping when the pinch ends).
      if (rolePointer('pinch') !== null) { lastX = e.clientX; lastY = e.clientY; return; }
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (shiftDrag) {
        G.camPan.x = clamp(G.camPan.x + dx * 2, -1500, 1500);
        G.camPan.y = clamp(G.camPan.y - dy * 2, -400, 800);
      } else {
        G.camYaw -= dx * 0.005;
        // v1.4.1: full-orbit pitch — near-vertical both ways (±1.45,
        // ~83°) so the camera can look straight down on the deck or
        // straight up from below the hull at any zoom. (Was [-0.1,
        // 1.2]: no below-surface orbit.)
        G.camPitch = clamp(G.camPitch - dy * 0.005, -1.45, 1.45);
      }
    } else if (role === 'pinch') {
      const oid = rolePointer('orbit');
      const o = oid !== null ? pointerPos.get(oid) : null;
      if (!o || pinchD <= 0) return;
      const d = Math.hypot(o.x - e.clientX, o.y - e.clientY);
      // Pinch gate (spec §6): ignore distance changes < mm(2) ≈ 8 px
      // from the anchor (a 1-2 px pinch jitter must not zoom);
      // re-anchor after applying. Same ratio as the old handler.
      if (Math.abs(d - pinchD) < mm(2)) return;
      G.camDist = clamp(G.camDist * (pinchD / d), 120, 4000);
      pinchD = d;
    }
  });
  const canvasEnd = e => {
    const role = releasePointer(e);
    if (!role) return;
    if (role === 'orbit') {
      const wasPinch = rolePointer('pinch') !== null;
      // Tap test (spec §6): Euclidean travel from the anchor
      // < mm(4) ≈ 15 px. The old accumulated-Manhattan `moved < 6`
      // punished slow drags (a slow 20 mm drag accumulated past 6 px
      // and misfired as a tap); the anchor distance does not.
      const tap = Math.hypot(e.clientX - downX, e.clientY - downY) < mm(4);
      dragging = false;
      // If a pinch partner is still down, promote it to orbit so the
      // surviving finger keeps orbiting from its current point with
      // no camera jump (spec §7.2). Two fingers down is never a tap.
      const pid = rolePointer('pinch');
      if (pid !== null) {
        const pp = pointerPos.get(pid);
        pointers.set(pid, 'orbit');
        dragging = true; lastX = pp.x; lastY = pp.y; downX = pp.x; downY = pp.y;
        pinchD = 0;
      } else if (tap) clickPick(e.clientX, e.clientY);
    } else if (role === 'pinch') {
      pinchD = 0;
      // Survivor stays 'orbit': re-anchor its last point so the next
      // orbit move does not jump by the pinch travel (spec §7.2).
      const oid = rolePointer('orbit');
      if (oid !== null) { const o = pointerPos.get(oid); if (o) { lastX = o.x; lastY = o.y; } }
    }
  };
  cv.addEventListener('pointerup', canvasEnd);
  cv.addEventListener('pointercancel', canvasEnd);
  cv.addEventListener('lostpointercapture', canvasEnd);
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    G.camDist = clamp(G.camDist * (1 + e.deltaY * 0.0006), 120, 4000);
  }, { passive: false });
  cv.addEventListener('contextmenu', e => e.preventDefault());

  // --- Floating rudder (touch spec §2) ---
  // touch-down = centre, max radius mm(16) ≈ 60 CSS px with
  // centre-follow, dead zone mm(3) ≈ 11 px radial, horizontal-only
  // (Hurricane v11.0). Pitch stays a FIXED track in v1.4 (two
  // floating origins in one thumb zone would fight); the floating
  // code is generic enough for pitch to reuse later. Fixed mode is
  // kept as a persisted menu opt-out (helicarriers_joy_mode).
  const joy = $('joy'), knob = $('joyKnob'), joyZone = $('joyZone');
  const JOY_R_MAX = mm(16), JOY_DEAD = mm(3);
  let joyCentre = null; // {x, y} live centre in client coords
  let joyGhostT = null;
  const joyPlace = (cx, cy) => {
    joy.style.left = (cx - 60) + 'px'; joy.style.top = (cy - 60) + 'px'; joy.style.bottom = 'auto';
  };
  const joyMoveFloat = e => {
    if (!joyCentre) return;
    const dx = e.clientX - joyCentre.x, dy = e.clientY - joyCentre.y;
    const r = Math.hypot(dx, dy);
    let input = 0;
    if (r >= JOY_DEAD) {
      // Follow, don't just clamp (spec §2.3): past R_MAX the centre
      // is dragged along so r stays == R_MAX and input stays 1.0.
      if (r > JOY_R_MAX) {
        const k = (r - JOY_R_MAX) / r;
        joyCentre = { x: joyCentre.x + dx * k, y: joyCentre.y + dy * k };
        joyPlace(joyCentre.x, joyCentre.y);
      }
      const rr = Math.min(r, JOY_R_MAX);
      const mag = (rr - JOY_DEAD) / (JOY_R_MAX - JOY_DEAD);
      // Horizontal component only; vertical displacement still counts
      // toward r for the dead-zone / follow maths, so a diagonal drag
      // does not feel sticky. r >= JOY_DEAD here, so dx/r is safe.
      input = clamp(mag * (dx / r), -1, 1);
    }
    G.rudderInput = input;
    knob.style.transform = `translateX(${input * (JOY_R_MAX - 22)}px)`;
    $('rudderReadout').textContent = '↔ ' + Math.round(input * 35) + '°';
  };
  const joyResetFloat = () => {
    const last = joyCentre;
    joyCentre = null;
    G.rudderInput = 0;
    knob.style.transform = '';
    $('rudderReadout').textContent = '↔ 0°';
    if (last) G.joyGhost = last; // ghost ring rests at the last centre
    if (joyGhostT) clearTimeout(joyGhostT);
    joyGhostT = setTimeout(() => {
      if (G.joyMode === 'float' && !joyCentre && G.joyGhost) {
        joy.classList.add('ghost');
        joyPlace(G.joyGhost.x, G.joyGhost.y);
      }
    }, 600);
  };
  // The zone (left 45% x bottom 40% of the viewport, minus the fleet
  // panel — see #joyZone in index.html, z-index 4, below #hud's
  // stacking context so the pitch/throttle tracks still get their
  // touches) owns the events in floating mode; #joy is
  // pointer-events:none there and is only the rendered base,
  // repositioned on touch-down. In fixed mode the zone is inert
  // (pointer-events:none via .fixed) and the old track below runs.
  joyZone.addEventListener('pointerdown', e => {
    if (G.joyMode !== 'float') return;
    if (!claim(e, 'rudder')) return;
    joyCentre = { x: e.clientX, y: e.clientY };
    G.joyGhost = { ...joyCentre };
    joy.classList.remove('ghost');
    if (joyGhostT) { clearTimeout(joyGhostT); joyGhostT = null; }
    joyPlace(joyCentre.x, joyCentre.y);
    try { joyZone.setPointerCapture(e.pointerId); } catch (_) {}
    joyMoveFloat(e); // first sample always reads zero — no lurch
  });
  joyZone.addEventListener('pointermove', e => { if (pointers.get(e.pointerId) === 'rudder') joyMoveFloat(e); });
  const joyZoneEnd = e => { if (releasePointer(e) !== 'rudder') return; joyResetFloat(); };
  joyZone.addEventListener('pointerup', joyZoneEnd);
  joyZone.addEventListener('pointercancel', joyZoneEnd);
  joyZone.addEventListener('lostpointercapture', joyZoneEnd);

  // Fixed rudder track (v1.3.0 behaviour, kept verbatim for the
  // opt-out): the knob swings left/right around the fixed track
  // centre. Runs only when joyMode is 'fixed' — in floating mode
  // #joy has pointer-events:none so these handlers never fire.
  const joyMoveFixed = e => {
    const r = joy.getBoundingClientRect();
    let dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    dx = clamp(dx, -1, 1);
    G.rudderInput = dx;
    knob.style.transform = `translateX(${dx * (r.width / 2 - 28)}px)`;
    $('rudderReadout').textContent = '↔ ' + Math.round(dx * 35) + '°';
  };
  joy.addEventListener('pointerdown', e => {
    if (G.joyMode === 'float') return;
    if (!claim(e, 'rudder')) return;
    try { joy.setPointerCapture(e.pointerId); } catch (_) {}
    joyMoveFixed(e);
  });
  joy.addEventListener('pointermove', e => { if (pointers.get(e.pointerId) === 'rudder' && G.joyMode !== 'float') joyMoveFixed(e); });
  const joyFixedEnd = e => {
    if (releasePointer(e) !== 'rudder') return;
    G.rudderInput = 0; knob.style.transform = '';
  };
  joy.addEventListener('pointerup', joyFixedEnd);
  joy.addEventListener('pointercancel', joyFixedEnd);
  joy.addEventListener('lostpointercapture', joyFixedEnd);

  // v1.2.0 pitch track — vertical spring-return drag beside the
  // rudder. v1.4.0: adds the missing dead zone mm(3) ≈ 11 px
  // (spec §3) — a resting thumb used to pitch the ship — and moves
  // onto the shared pointer Map (own 'pitch' role, lostpointercapture
  // handled). Max travel stays the track half-height. Hit area: the
  // track is already 48-56 px wide, so no ::before padding is added
  // — 23 px of padding on either side would swallow the rudder zone
  // on the left and the throttle track on the right (spec §4.2 note).
  const pt = $('pitchTrack'), pk = $('pitchKnob');
  const PITCH_DEAD = mm(3);
  const ptMove = e => {
    const r = pt.getBoundingClientRect();
    const offPx = (r.top + r.height / 2) - e.clientY;
    const half = r.height / 2;
    let dy = 0;
    if (Math.abs(offPx) >= PITCH_DEAD)
      dy = clamp(Math.sign(offPx) * (Math.abs(offPx) - PITCH_DEAD) / (half - PITCH_DEAD), -1, 1);
    G.pitchTrack = dy;
    pk.style.transform = `translateY(${-dy * (r.height / 2 - 26)}px)`;
    $('pitchReadout').textContent = (dy >= 0 ? '▲ +' : '▼ ') + Math.round(dy * 12) + '°';
  };
  pt.addEventListener('pointerdown', e => { if (!claim(e, 'pitch')) return; try { pt.setPointerCapture(e.pointerId); } catch (_) {} ptMove(e); });
  pt.addEventListener('pointermove', e => { if (pointers.get(e.pointerId) === 'pitch') ptMove(e); });
  const ptEnd = e => {
    if (releasePointer(e) !== 'pitch') return;
    G.pitchTrack = 0; pk.style.transform = ''; $('pitchReadout').textContent = '▲ +0°';
  };
  pt.addEventListener('pointerup', ptEnd);
  pt.addEventListener('pointercancel', ptEnd);
  pt.addEventListener('lostpointercapture', ptEnd);

  // v1.4.0 throttle track — vertical collective-style drag beside the
  // pitch track: drag up = more rotor strength, drag down = less.
  // NOT spring-return: it stays where it is left. v1.4.0 (item 7):
  // moved onto the shared pointer Map (own 'throttle' role,
  // lostpointercapture handled) like rudder/pitch — the old single
  // thId var had the same overwrite hole.
  const th = $('thrTrack'), tk = $('thrKnob');
  const thMove = e => {
    const r = th.getBoundingClientRect();
    let v = 0.5 + ((r.top + r.height / 2) - e.clientY) / (r.height / 2) * 0.5;
    G.throttle = clamp(v, 0, 1);
    syncThrottleUI();
  };
  th.addEventListener('pointerdown', e => { if (!claim(e, 'throttle')) return; try { th.setPointerCapture(e.pointerId); } catch (_) {} thMove(e); });
  th.addEventListener('pointermove', e => { if (pointers.get(e.pointerId) === 'throttle') thMove(e); });
  const thEnd = e => { releasePointer(e); };
  th.addEventListener('pointerup', thEnd);
  th.addEventListener('pointercancel', thEnd);
  th.addEventListener('lostpointercapture', thEnd);
  syncThrottleUI();

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
    if (best && bd < 60) { // v1.4.0 (item 7, touch spec §4.2/§6): designation radius 30 -> 60 canvas units ≈ 23 display px ≈ 6 mm — the old 3 mm radius was smaller than a fingertip, so taps on an enemy triangle missed and dropped a waypoint instead. Waypoint taps (open ocean) use the else-branch and are unaffected.
      G.targetCarrier = best; G.targetMode = 'designated';
      $('btnTarget').textContent = '🎯 ' + best.name.replace('SHIELD-', 'S').replace('ENEMY-', 'E');
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
  // v1.4.0 (item 7, touch spec §4.2): the 48 px Air Ops buttons
  // make the dock tall enough to cover the minimap / top-bar pills
  // on short screens (e.g. a 390 px-high landscape phone) — so on
  // max-height:500px the Air Ops panel starts collapsed (tap ▸ to
  // open it) instead of shrinking the buttons back down.
  if (innerHeight <= 500) {
    $('airOpsPanel').classList.add('collapsed');
    $('aoToggle').textContent = '▸';
  }
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
    // v1.4.0 throttle keys: Shift+W/S steps rotor strength (W/S alone
    // still step the telegraph), =/- step it too.
    if (e.key === 'w' || e.key === 'W') { if (e.shiftKey) adjustThrottle(0.05); else setTelegraph(G.telegraphIdx - 1); }
    else if (e.key === 's' || e.key === 'S') { if (e.shiftKey) adjustThrottle(-0.05); else setTelegraph(G.telegraphIdx + 1); }
    if (e.key === '=' || e.key === '+') adjustThrottle(0.05);
    if (e.key === '-' || e.key === '_') adjustThrottle(-0.05);
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
  // v1.4.0 (item 5) CAP: toggles a standing patrol for the selected
  // carrier's wing. On: the wing auto-launches a patrol flight and
  // keeps one up (relief rotation through trap/rearm). Off: the patrol
  // flight is recalled and no relief launches. One wing = one CAP
  // flight; the other squadron stays free for strikes.
  $('btnCap').addEventListener('click', () => {
    const carrier = G.selected && G.selected.alive ? G.selected : G.playerFleet.find(c => c.alive);
    if (!carrier || !carrier.wing) { msg('No live carrier to order CAP from'); return; }
    const wing = carrier.wing;
    wing.capOn = !wing.capOn;
    if (!wing.capOn) wing.recallCAP();
    msg(wing.capOn
      ? `${carrier.name}: CAP patrol ordered — a flight will stand patrol over the fleet`
      : `${carrier.name}: CAP stood down — patrol flight recalled`);
    syncCapBtn(); renderFleetPanels();
  });
  $('btnRecall').addEventListener('click', () => { for (const c of G.playerFleet) if (c.wing) c.wing.recallAll(); msg('Wings recalled'); });
  $('btnTarget').addEventListener('click', () => {
    if (G.targetMode === 'nearest') {
      const alive = G.enemyFleet.filter(c => c.alive);
      if (alive.length) { G.targetMode = 'designated'; G.targetCarrier = alive[0]; $('btnTarget').textContent = '🎯 ' + alive[0].name.replace('SHIELD-', 'S').replace('ENEMY-', 'E'); }
    } else {
      const alive = G.enemyFleet.filter(c => c.alive);
      const i = alive.indexOf(G.targetCarrier);
      const next = alive[(i + 1) % alive.length];
      if (next) { G.targetCarrier = next; $('btnTarget').textContent = '🎯 ' + next.name.replace('SHIELD-', 'S').replace('ENEMY-', 'E'); }
      else { G.targetMode = 'nearest'; $('btnTarget').textContent = '🎯 Nearest'; }
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
  const syncMute = () => { muteBtn.textContent = G.audio && G.audio.muted ? '🔇' : '🔊'; }; // v1.4.1: icon only
  muteBtn.addEventListener('click', () => {
    if (!G.audio) return;
    G.audio.ensure();
    G.audio.setMuted(!G.audio.muted);
    // v1.4.0 (item 7, touch spec §5.4): muting cancels a haptic
    // pattern in flight; Sound off also silences vibration.
    if (G.audio.muted) { try { if (navigator.vibrate) navigator.vibrate(0); } catch (_) {} }
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
// v1.4.0 throttle: collective-style rotor strength, 0..1 (69% hovers).
// Not spring-return — it stays where the player leaves it, like a real
// collective. Updates the track knob + readout to match.
function adjustThrottle(d) {
  G.throttle = clamp(G.throttle + d, 0, 1);
  syncThrottleUI();
}
function syncThrottleUI() {
  const el = $('thrReadout');
  if (el) el.textContent = Math.round(G.throttle * 100) + '%'; // v1.4.1: number only, the bar sits beside it
  const knob = $('thrKnob'), track = $('thrTrack');
  if (knob && track) {
    const r = track.getBoundingClientRect();
    knob.style.transform = `translateY(${((0.5 - G.throttle) * (r.height / 2 - 26)).toFixed(1)}px)`;
  }
}
function resetCamera() {
  G.camYaw = 0.6; G.camPitch = 0.32; G.camDist = 1100;
  G.camPan = { x: 0, y: 0 }; G.camTac = null; G.camTacIdx = 0; G.camFollow = G.selected;
  G.tacMode = null; G.tacKind = null; G.tacTarget = null; G.tacHoldPos = null; G.tacJetsIdx = -1; G.tacOrdIdx = -1;
  G.camSpectate = null; // v1.2.0: R also ends a spectate follow (Hurricane v11.15)
  $('btnCam').textContent = '📷 Fleet [C]';
}
// v1.4.0 (item 7, touch spec §2/§8): apply the rudder stick mode.
// 'float' shows the ghost ring at G.joyGhost (last used centre, or
// the old fixed track centre on first run) and makes #joyZone own
// the touches; 'fixed' restores the v1.3.0 track exactly. Called from
// startGame, from the menu seg, and on load (initJoyMode). The rest
// position is captured BEFORE the class change, so the ghost starts
// where the fixed track was.
function applyJoyMode(mode) {
  G.joyMode = mode;
  try { localStorage.setItem('helicarriers_joy_mode', mode); } catch (_) {}
  const joy = $('joy'), zone = $('joyZone');
  if (!joy || !zone) return;
  // Rest position for the ghost ring. Prefer the live rect centre
  // when the track is still fixed (its centre is the first-run ghost
  // position). Do NOT trust a zero rect: #joy lives inside #hud,
  // which is display:none before the round starts, so
  // getBoundingClientRect() is 0,0,0,0 there — the first version of
  // this function stored {0,0} as the ghost and the ring rested
  // off-screen. Fallback is the fixed track's centre by viewport
  // (mobile ≤820 px: left 12 + 180/2, bottom 12 + 56/2).
  let cx, cy;
  const r = joy.getBoundingClientRect();
  const mobile = innerWidth <= 820;
  if (r.width > 0 && !joy.classList.contains('float')) { cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
  else if (G.joyGhost && (G.joyGhost.x || G.joyGhost.y)) { cx = G.joyGhost.x; cy = G.joyGhost.y; }
  else if (r.width > 0) { cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
  else { cx = mobile ? 102 : 122; cy = innerHeight - (mobile ? 40 : 45); }
  const isFloat = mode === 'float';
  joy.classList.toggle('float', isFloat);
  joy.classList.toggle('ghost', isFloat);
  zone.classList.toggle('fixed', !isFloat);
  if (isFloat) {
    G.joyGhost = { x: cx, y: cy };
    joy.style.left = (cx - 60) + 'px'; joy.style.top = (cy - 60) + 'px'; joy.style.bottom = 'auto';
    const knob = $('joyKnob'); if (knob) knob.style.transform = '';
  } else {
    joy.style.left = ''; joy.style.top = ''; joy.style.bottom = '';
    const knob = $('joyKnob'); if (knob) knob.style.transform = '';
    G.rudderInput = 0;
  }
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
      else { G.targetCarrier = c; G.targetMode = 'designated'; $('btnTarget').textContent = '🎯 ' + c.name.replace('SHIELD-', 'S').replace('ENEMY-', 'E'); }
      msg('Following ' + c.name + (c.state === 'sinking' || c.state === 'falling' ? ' — she is going down' : ''));
    }
  }
}

// ---------- Debug hooks ----------
function bindDebug() {
  if (!DEBUG) return;
  $('debugPanel').classList.add('on');
  $('dbgKillEnemy').addEventListener('click', () => killCarrier(G.enemyFleet.find(c => c.alive) || G.enemyFleet[0], 'reactor'));
  $('dbgKillPlayer').addEventListener('click', () => killCarrier(G.playerFleet.find(c => c.alive) || G.playerFleet[0], 'reactor'));
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
  // v1.4.0 (item 7, touch spec §8): rudder stick mode from the menu
  // seg (set by initJoyMode on load); falls back to the stored
  // preference, then to floating on coarse pointers.
  G.joyMode = seg('segJoyMode') || G.joyMode || 'fixed';
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
  // v1.4.0 (item 6): a new round starts with a clean sea — no wreckage
  // carried over from the attract scene or a previous round.
  if (G.wreckage) G.wreckage.clear();
  directorReset(); // v1.4.0 (item 3): fresh focus, assignments and wave clock
  G.selected = G.playerFleet[0];
  G.camFollow = G.selected;
  G.telegraphIdx = 1; // FULL
  for (const c of G.playerFleet) c.telegraphIdx = 1;
  bindInput();
  bindDebug();
  applyJoyMode(G.joyMode);
  // v1.4.0 (item 7, touch spec §8): first-run note, in #msg (the
  // #hint line is display:none on phones, so it cannot carry this).
  // Shown once, after the fleet-launched message has had its 4 s.
  try {
    if (G.joyMode === 'float' && !localStorage.getItem('helicarriers_joy_hint_seen')) {
      localStorage.setItem('helicarriers_joy_hint_seen', '1');
      setTimeout(() => { if (G.started && !G.over) msg('Rudder is now floating — touch down anywhere bottom-left to steer. Fixed stick available in the menu.'); }, 4500);
    }
  } catch (_) {}
  renderFleetPanels();
  updateTeleBox();
  msg(`Fleet launched — ${G.playerN}v${G.enemyN}, ${SKILLS[G.skill].label} enemy, ${STAGES[G.stage].name} sea. Launch a flight to strike.`);
  G.started = true;
  window.__game = G; // debug handle for the verification agent
  // Solidity probe handle: worst signed separation between any two solid
  // bodies (carriers whole/fragmented, pieces) — see collisions.js.
  G.soliditySnapshot = () => soliditySnapshot(G);
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
  setInterval(() => { if (G.started) { renderFleetPanels(); updateStatus(); updateTeleBox(); syncCapBtn(); } }, 500);
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
  if (G.msgT > 0) { G.msgT -= dt; if (G.msgT <= 0) { const m = $('msg'); if (m) m.style.display = 'none'; } } // v1.4.1: hide on expiry, never show the idle '—' pill
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
    // v1.4.0: rotor hum follows the selected carrier's mean spin rate
    // (throttle-driven — quiet at idle, loud at full rotor strength).
    if (G.audio && G.selected) {
      const pods = G.selected.pods;
      const meanSpin = pods.reduce((a, p) => a + p.spinRate, 0) / Math.max(1, pods.length) / 30;
      G.audio.rotor(meanSpin);
    }
    // v1.4.0 (item 6): wreckage drifts/spreads/bobs with game time.
    if (G.wreckage) G.wreckage.update(dt, G.time);
    checkEnd(); // every frame: a breakup's pieces take ~40 s of game time to sink
  }
  // v1.4.0 (item 7): flush queued kill/loss buzzes after checkEnd()
  // has had its say (see flushHaptics — a round that just ended
  // drops the queue so only H3 fires).
  flushHaptics();
  // (c) Keep a command-transfer announcement on screen for 8 s of game
  // time — it must survive the flurry of loss messages around a sinking.
  if (G.transferAnnounce) {
    if (G.time < G.transferAnnounce.until && !G.over) { const m = $('msg'); if (m) { m.textContent = G.transferAnnounce.text; m.style.display = 'block'; } G.msgT = 4; }
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
    $('dbgInfo').textContent = `t=${G.time.toFixed(0)}s · jets up ${G.allCarriers.reduce((a, c) => a + (c.wing ? c.wing.airborneCount() : 0), 0)} · bombs ${G.bombs.length} · missiles ${G.missiles.length} · SAMs ${G.airDefense ? G.airDefense.sams.length : 0} · parts steal: P ${G.vfx.pCursor}/${1600} S ${G.vfx.spCursor}/${420}` +
      (G.wreckage ? ` · wreck ${G.wreckage.fields.length} fields / ${G.wreckage.chunkCount} chunks / ${G.wreckage.slickCount} slicks` : '') +
      (G.director && G.director.focus ? ` · focus ${G.director.focus.name} · wave ${G.director.waveId}${G.director.waveActive ? ' (firing)' : ''} · launches ${G.director.stats.launches}` : '');
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

// v1.4.0 (item 7, touch spec §2.1/§8): rudder stick default —
// floating on coarse pointers (touch), fixed on mouse/keyboard —
// overridden by the stored preference. Sets the menu seg to match
// and applies the mode (ghost ring position) before the first round.
function initJoyMode() {
  let stored = null;
  try { stored = localStorage.getItem('helicarriers_joy_mode'); } catch (_) {}
  const def = stored === 'float' || stored === 'fixed' ? stored
    : (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches ? 'float' : 'fixed');
  document.querySelectorAll('#segJoyMode button').forEach(b => b.classList.toggle('on', b.dataset.v === def));
  G.joyMode = def;
  applyJoyMode(def);
}
document.querySelectorAll('#segJoyMode button').forEach(b => b.addEventListener('click', () => applyJoyMode(b.dataset.v)));

// v1.3.0 (G): show the persisted best result on the menu, and run the
// idle attract scene behind it. Autostart (?autostart=1) skips both.
loadBest();
initJoyMode();
if (params.get('autostart') === '1') {
  startGame().catch(err => console.error(err));
} else {
  startAttract();
}
window.__booted = true;

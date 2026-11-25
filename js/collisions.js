// collisions.js — helicarrier-vs-helicarrier AND breakup-piece collisions.
//
// Standing rule (Nicholas): helicarriers — whole or fragmented — are
// ALWAYS solid, and must never phase through each other at any juncture.
// Collision solidity holds across every state, not just intact carriers
// in normal flight: intact carriers, carriers in freefall, carriers
// mid-breakup, and every fragment/piece after breakup — falling,
// tumbling, sinking, drifting apart. No piece may pass through another
// carrier or through another piece.
//
// Adapted from Hurricane Fleet ship-ship collisions (index.html L3523
// hullCircles, L3853-4029 collision block): hull circles along the length,
// KE-scaled damage split by inverse mass, positional push-apart, grind
// damage while hulls stay in contact. Re-derived in metres (1 unit = 1 m):
// Hurricane speeds were game units (max ~14 u/s); here carriers run
// 20-30 m/s (STAGES speed), so closing speeds — and the KE scale — differ.
//
// Carrier-vs-carrier detection is a 3-D hull-footprint overlap, not a
// 2-D distance: the full 333 m OBB (2-D SAT) plus a vertical overlap
// check (|dy| < 70 m) — the SAME OBB the solidity snapshot measures,
// so resolver and measurer agree by construction. (The old
// tapered-circle test understated hull length by 5.3 m an end; see
// checkCarrierCollisions.) It covers player-player,
// player-enemy and enemy-enemy pairs, including formation neighbours
// and head-on meetings. The 600 m keep-out rudder (game.js) is prevention,
// NOT this system: collisions are still detected and resolved when
// carriers do meet.
//
// Piece detection is different, on purpose: a piece's geometry AABB is
// always full-ship (the v1.3.2 fragmentation fix — clipping is
// rasterisation-only), so a piece's collision shape must come from its
// actual section bounds (its along-hull segment [segLo, segHi]), never
// its geometry AABB — otherwise pieces would collide as full ships.
// Each piece is an oriented box (OBB) in the XZ plane: length = its
// segment's horizontal projection (it shrinks as the piece pitches up),
// beam = the hull beam, centre = the segment centre carried by the
// tumbling group. Narrowphase is 2-D SAT on the two boxes' axes plus a
// vertical interval check, resolved along the axis of least penetration
// (horizontal shove, or a vertical lift when a piece lands on a deck).
// At breakup the pieces' OBBs exactly abut (segments partition the
// hull), so no birth overlap — the blast separation impulse does the
// separating, collisions only stop them re-entering each other.
//
// Damage scale (closing speed v in m/s, equal masses, reduced mass 5):
//   dmgBase = 3 + 0.6 * v^2   (KE form: 0.5 * redMass * v^2 * 0.24)
//   v=4  -> ~13  (gentle bump: one zone scuffed + scorch, no fire)
//   v=8  -> ~41  (firm ram: a zone badly hurt, fire if >= 25)
//   v=16 -> ~157 (a whole zone gone — HALF vs HALF head-on)
//   v=40 -> ~963 (FLANK vs FLANK head-on: catastrophic, see below)
// At closing >= 20 m/s the hit breaks the carrier up outright (a
// 333 m hull at 20+ m/s into solid steel is not survivable); below that,
// magazine/reactor hits can still detonate through the existing
// damage() gates, and a hard hit can start the freefall via the
// structural-failure check there. Both sides take the same base damage
// (equal mass); each side's damage lands in the zone at the contact
// point, so list/trim, lift loss, speed/steering degradation and fires
// all follow from the existing per-zone model in carrier.js. A piece
// has no HP of its own (its parent is already gone), so a piece-vs-
// carrier hit damages only the carrier; a piece-vs-piece hit damages
// nothing — the pieces deflect, grind and separate instead.
//
// Broadphase: a uniform 256 m grid over body AABBs. Worst case is
// 8 carriers + 8 x 6 pieces = 56 bodies; the grid keeps candidate
// pairs near-linear instead of an O(n^2) all-pairs scan every substep.
// Narrowphase runs relaxation to convergence per substep: resolving
// one pair can push a body into a third (sibling pieces tumble as a
// cluster), so the pass re-tests every candidate pair from its pushed
// positions until a full pass finds zero overlaps (cap 6).
import * as THREE from 'three';
import { CARRIER_LEN, PHYSICS } from './carrier.js';

export const CARRIER_BEAM = 70;   // hull beam, m (matches the sea-wake beam in game.js)
export const CARRIER_MASS = PHYSICS.MASS; // v1.4.0 mass (audit F16):
// 120,000,000 kg — the old CARRIER_MASS = 10 was a Hurricane
// placeholder. It only set the 50/50 split between equal masses, so it
// was numerically harmless until unequal-mass contacts arrived; now
// piece masses (∝ segLen) share the same scale and impulses use the
// reduced mass m1·m2/(m1+m2).
export const VERT_HALF = 35;      // hull vertical half-extent, m — hulls touch while |dy| < 70
const CIRCLES = [[-0.4, 0.40], [-0.2, 0.55], [0, 0.55], [0.2, 0.55], [0.4, 0.40]]; // Hurricane L3523 taper
const IMPACT_COOLDOWN = 1.5;      // s per pair between impact hits (Hurricane)
const GRIND_INTERVAL = 1.0;       // s per pair between grind ticks
const GENTLE_CLOSING = 1.5;       // m/s — below this, contact is a nudge: separate, no damage (Hurricane v10.3)
const GRAZE_DEPTH = 0.5;          // m — shallower overlap is a brush-past: no damage (Hurricane v10.5)
const CATASTROPHIC_CLOSING = 20;  // m/s — at/above this, a hit breaks the carrier up
const AVOID_WINDOW = 30;      // s of game time a carrier steers clear after a collision (NEW-1 fix)
const PIECE_HALF_BEAM = 42;   // hull half-beam for a piece OBB — the STL
  // hull stations peak at 42 m mid-body, so 42 covers the real hull
  // (35 would understate it and let hulls interpenetrate by up to 7 m
  // a side before the shape even noticed). Bow/stern pieces are
  // narrower in reality; the conservative max is the safe side.
const PIECE_HALF_H_LEVEL = 20; // vertical half-extent of a level piece (keel -29..deck +5 about the centre, island aside)
const GRID_CELL = 256;        // broadphase cell, m — a carrier spans ~2 cells, a piece ~1

const wrapAngle = a => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

// Five circles along the hull, tapered at bow/stern (Hurricane L3523).
function hullCircles(c) {
  const fx = Math.sin(c.heading), fz = -Math.cos(c.heading);
  return CIRCLES.map(([al, rf]) => ({
    x: c.x + fx * CARRIER_LEN * al,
    z: c.z + fz * CARRIER_LEN * al,
    r: Math.max(CARRIER_BEAM * rf, 2),
  }));
}

// Effective velocity for collision purposes. A flying carrier moves with
// its vx/vz (set by the steering layer) and climbs/descends with vy. A
// falling carrier drifts horizontally with the velocity it had when lift
// failed (carrier.js fall branch integrates fallVx/fallVz) and falls
// with vy; a sinking wreck does not move at all.
function effVel(c) {
  if (c.state === 'alive') return { x: c.vx, z: c.vz, y: c.vy };
  if (c.state === 'falling') return { x: c.fallVx || 0, z: c.fallVz || 0, y: c.vy };
  return { x: 0, z: 0, y: 0 };
}

function isSolid(c) {
  return c.state === 'alive' || c.state === 'falling' || (c.state === 'sinking' && c.sinkT < 1);
}

function logCollision(G, entry) {
  G.collLog.push(entry);
  if (G.collLog.length > 100) G.collLog.shift();
}

// Post-impact avoidance (NEW-1 fix): each live carrier steers clear of
// the other for AVOID_WINDOW game-s after a collision. Set on every
// impact and grind tick, so the window only expires once the pair is
// actually clear. Read by escortControl in game.js — escorts only, so
// the player's selected ship is never steered, and the 600 m keep-out
// rudder still governs driven flagships. Without this, the struck
// escort's slot-seeking slides it back along the flagship and
// re-contacts 2–3+ times at ~3–4 m/s, grinding the same zone down.
function markAvoidance(a, b, t) {
  if (a.alive) { a.avoidUntil = t + AVOID_WINDOW; a.avoidOther = b; }
  if (b.alive) { b.avoidUntil = t + AVOID_WINDOW; b.avoidOther = a; }
}

// ---------------------------------------------------------------------------
// Solid bodies: every carrier (alive/falling/sinking) and every breakup
// piece (falling/tumbling/sinking) is one body. A body is an oriented box
// in XZ (centre, forward/right unit vectors, half-length, half-beam) plus
// a vertical interval (y, half-height) plus a velocity and a mass.
// Carriers keep their circle set too, for the unchanged carrier-carrier
// path below.
// ---------------------------------------------------------------------------
function carrierBody(c) {
  const fx = Math.sin(c.heading), fz = -Math.cos(c.heading);
  return {
    kind: 'carrier', ref: c, id: 'c' + c.id, name: c.name,
    x: c.x, z: c.z, y: c.y, fx, fz, rx: Math.cos(c.heading), rz: Math.sin(c.heading),
    // v1.4.0 solidity fix: the carrier OBB uses the true hull envelope
    // (PIECE_HALF_BEAM = 42) — CARRIER_BEAM/2 = 35 understates the STL
    // hull stations, which peak at 42 m half-beam mid-body, by 7 m a
    // side, the same reason pieces use 42. The snapshot measures this
    // body, so the envelope is what the ALWAYS-solid rule is judged on.
    halfLen: CARRIER_LEN / 2, halfBeam: PIECE_HALF_BEAM, halfH: VERT_HALF,
    vel: effVel(c), invMass: 1 / CARRIER_MASS, alive: c.alive, state: c.state,
    circles: hullCircles(c),
  };
}

// A piece's segment centre in world space: the piece group is a clone of
// the carrier group at the breakup pose, so local (0, 0, -segCentre) is
// the segment centre and local -Z is the segment's forward direction.
// updateWorldMatrix refreshes the matrix from position/rotation, so this
// is exact even when the renderer is no-op'd (probes) and matrixWorld is
// otherwise stale.
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
function pieceBody(p) {
  const g = p.group;
  g.updateWorldMatrix(true, false);
  _v1.set(0, 0, -p.segCentre).applyMatrix4(g.matrixWorld);
  const cx = _v1.x, cy = _v1.y, cz = _v1.z;
  _v2.set(0, 0, -p.segCentre - 10).applyMatrix4(g.matrixWorld);
  let fx = _v2.x - cx, fz = _v2.z - cz;
  const fl = Math.hypot(fx, fz);
  if (fl < 0.01) { // near-vertical piece: no horizontal forward — use heading
    fx = Math.sin(p.heading); fz = -Math.cos(p.heading);
  } else { fx /= fl; fz /= fl; }
  const halfLenFull = (p.segLen || 60) / 2;
  // Horizontal projection of the tumbling segment: a piece pitched up
  // presents a shorter footprint and a taller vertical extent.
  const cosP = Math.abs(Math.cos(p.pitch || 0));
  const halfLen = Math.max(12, halfLenFull * cosP);
  let halfH = Math.abs(Math.sin(p.pitch || 0)) * halfLenFull
    + PIECE_HALF_H_LEVEL * cosP
    + Math.abs(Math.sin(p.roll || 0)) * PIECE_HALF_BEAM * 0.5;
  // Island allowance: the island wedge (local z 47..98, i.e. d -98..-47)
  // rises ~14 m above the deck line, so a piece containing it is that
  // much taller. Without it an island piece could clip a deck above it.
  if (p.segLo !== undefined && p.segLo <= -47 && p.segHi >= -98) halfH += 14;
  // Sinking pieces sink at a fixed rate from sinkT (carrier.js derives y
  // from sinkT, it does not integrate a vy) — recover it analytically.
  // v1.4.0: sinkDur is size-scaled (audit F11), so the analytic vy uses
  // it when present instead of the old fixed 30 s.
  const vy = p.state === 'sinking'
    ? -2 * Math.min(1, p.sinkT || 0) * 55 / (p.sinkDur || 30)
    : p.vy;
  const mass = Math.max(1.5, Math.min(CARRIER_MASS, CARRIER_MASS * (p.segLen || 60) / CARRIER_LEN));
  return {
    kind: 'piece', ref: p, id: 'p' + p.id, name: (p.carrierName || 'carrier') + ' piece',
    x: cx, z: cz, y: cy, fx, fz, rx: -fz, rz: fx,
    halfLen, halfBeam: PIECE_HALF_BEAM, halfH,
    vel: { x: p.vx || 0, z: p.vz || 0, y: vy || 0 },
    invMass: 1 / mass, alive: false, state: p.state,
    segLen: p.segLen || 60, mass,
  };
}

// Every solid body in the round: carriers (alive/falling/sinking) plus
// the live pieces of every carrier, including carriers already 'gone'
// whose pieces are still falling/sinking.
export function solidBodies(G) {
  const out = [];
  for (const c of G.allCarriers) {
    if (isSolid(c)) out.push(carrierBody(c));
    for (const p of c.pieces) {
      if (p.state === 'falling' || p.state === 'sinking') out.push(pieceBody(p));
    }
  }
  return out;
}

// 2-D SAT on two OBBs in XZ. Returns { separated: true, gap } when
// separated on some axis (gap > 0 is the smallest axis gap), else
// { separated: false, nx, nz, depth } — the minimum translation axis
// pushing B out of A, depth > 0.
function satOverlap(A, B) {
  const dx = B.x - A.x, dz = B.z - A.z;
  const axes = [[A.fx, A.fz], [A.rx, A.rz], [B.fx, B.fz], [B.rx, B.rz]];
  let best = null;
  for (const [ux, uz] of axes) {
    const rA = A.halfLen * Math.abs(A.fx * ux + A.fz * uz) + A.halfBeam * Math.abs(A.rx * ux + A.rz * uz);
    const rB = B.halfLen * Math.abs(B.fx * ux + B.fz * uz) + B.halfBeam * Math.abs(B.rx * ux + B.rz * uz);
    const dist = Math.abs(dx * ux + dz * uz);
    const gap = dist - (rA + rB);
    if (gap >= 0) return { separated: true, gap };
    const depth = -gap;
    if (!best || depth < best.depth) {
      const s = (dx * ux + dz * uz) >= 0 ? 1 : -1;
      best = { nx: ux * s, nz: uz * s, depth };
    }
  }
  return { separated: false, ...best };
}

// Move a body in the world. Carriers move by their x/z (and fallVx/fallVz
// for a falling carrier, so the drift persists); pieces move by their
// group position (BreakupPiece.update integrates incrementally in x/z,
// so a positional nudge persists — but it overwrites group.position.y
// every frame from its own y/sinkT, so pieces can NEVER be moved in y
// by position: vertical moves go through vy instead, see pushBodyY).
function pushBodyXZ(b, nx, nz, d) {
  if (b.kind === 'carrier') {
    b.ref.x += nx * d; b.ref.z += nz * d;
    b.ref.group.position.x = b.ref.x; b.ref.group.position.z = b.ref.z;
  } else {
    b.ref.group.position.x += nx * d; b.ref.group.position.z += nz * d;
  }
  b.x += nx * d; b.z += nz * d;
}
// Vertical moves only work where the owner integrates y: a FALLING piece
// (vy is integrated with drag toward terminal velocity). A sinking
// piece's y is derived from sinkT and a carrier's y from its flight /
// fall model, so neither can be pushed in y — for those, vertical
// contact falls back to a horizontal shove (canMoveY false).
function canMoveY(b) {
  return b.kind === 'piece' && b.state === 'falling';
}
function pushBodyY(b, d) {
  if (b.kind === 'piece') {
    b.ref.group.position.y += d;
    b.ref.y += d; // BreakupPiece.y is the integrated altitude in the fall branch
    b.y += d;
  }
}

// Velocity response for a body along a unit normal (nx, nz) or vertical.
// v1.4.0 mass (audit F5/F6): a LIVE carrier never takes a velocity
// impulse here — the old code cut forwardSpeed directly (bypassing the
// 0.45/0.60 m/s² spool) and wrote heading directly (up to 8.6° in one
// substep), re-applied every substep of a sustained contact. Live
// carriers take their speed/heading response ONCE per impact, inside
// the impact gates, via spoolSpeed and the τ=6 s yaw lag (see the
// impact branches below). A falling carrier takes the impulse on its
// drift velocity; a sinking carrier takes no velocity change at all.
// Pieces take the impulse on vx/vz (and vy for a vertical hit, falling
// pieces only).
function deflectBody(b, nx, nz, ny, j, closing) {
  if (b.kind === 'carrier') {
    if (b.state === 'falling') {
      b.ref.fallVx = (b.ref.fallVx || 0) + nx * j * b.invMass;
      b.ref.fallVz = (b.ref.fallVz || 0) + nz * j * b.invMass;
    }
    return;
  }
  const p = b.ref;
  p.vx = (p.vx || 0) + nx * j * b.invMass;
  p.vz = (p.vz || 0) + nz * j * b.invMass;
  if (ny && b.state === 'falling') p.vy = (p.vy || 0) + ny * j * b.invMass;
}

// Live velocity of a body, read from its owner (not the body's built
// vel snapshot, which goes stale the moment a deflection lands — the
// second relaxation iteration needs the deflected values).
function bodyVel(b) {
  if (b.kind === 'carrier') return effVel(b.ref);
  const p = b.ref;
  return {
    x: p.vx || 0, z: p.vz || 0,
    y: p.state === 'sinking' ? -2 * Math.min(1, p.sinkT || 0) * 55 / (p.sinkDur || 30) : (p.vy || 0),
  };
}

// v1.4.0 mass (audit F5/F6): the once-per-impact velocity response for
// a live carrier. NEVER writes heading directly — the kick becomes a
// yaw-rate impulse through the τ=6 s lag, ΔheadingRate ≤ 0.01 rad/s per
// impact, so the total heading change per impact is ≤ ~1.5°. The speed
// change lands on spoolSpeed (the ordered-speed state), magnitude from
// momentum conservation: for equal masses a dead-centre head-on leaves
// both ships at their mean velocity — ΔV ≈ closing/2 per ship, scaled
// by overlap geometry (× depth/beam for a graze). The ship then
// recovers (or doesn't) through the spool, like any other ordered-speed
// change.
function carrierImpactResponse(c, o, closing, depth) {
  if (!c.alive) return;
  const geomF = Math.min(1, depth / CARRIER_BEAM);
  const dv = closing * 0.5 * geomF;
  if (c.spoolSpeed >= 0) c.spoolSpeed = Math.max(0, c.spoolSpeed - dv);
  else c.spoolSpeed = Math.min(0, c.spoolSpeed + dv);
  const brg = Math.atan2(o.x - c.x, -(o.z - c.z));
  const dh = wrapAngle(brg - c.heading);
  if (Math.abs(dh) < Math.PI / 2) {
    const kick = Math.min(0.01, closing * 0.0003);
    c.headingRate += (dh >= 0 ? -kick : kick);
  }
}

// Resolve one piece-involved pair (piece-carrier or piece-piece).
// hit: { nx, nz, depth } horizontal MTV, or { vertical: true, depth, dir }
// closing: horizontal closing speed + the vertical closing speed
// (audit F19: the old 0.5× vertical discount had no basis; with F3
// fixed, a falling carrier's real velocity enters closingH properly).
// dt: the sim substep, retained for the signature (see the positional
// note below — correction is uncapped, so dt is not used here).
function resolvePiecePair(G, ctx, A, B, hit, closing, dt = 0.05) {
  const key = A.id < B.id ? `${A.id}:${B.id}` : `${B.id}:${A.id}`;
  const carrier = A.kind === 'carrier' ? A : B.kind === 'carrier' ? B : null;
  const piece = A.kind === 'piece' ? A : B;
  const invSum = A.invMass + B.invMass;

  // --- positional separation, always applied, even for a gentle nudge,
  // so bodies never stay interpenetrated. Split by inverse mass; a body
  // that cannot move on the chosen axis yields its share to the other.
  // v1.4.0 solidity fix: positional correction is EXEMPT from any
  // separation-speed cap. Audit F15 as implemented at 09:18 capped it
  // at 2 m/s per side — a 20 m overlap then needed ~5 s of grinding to
  // clear, i.e. seconds of visible interpenetration against the
  // ALWAYS-solid rule. The cap was a category error: positional
  // correction is a constraint projection, not a velocity — it writes
  // positions only and touches no velocity state (forwardSpeed,
  // spoolSpeed, fallVx/vz, piece vx/vy/vz, headingRate), so it cannot
  // produce a glide, a shove or a freeze. The weightless behaviours the
  // mass audit fixed (F1 ghost glide, F2 ANCHOR freeze, F8/F9 blast
  // shove, F5/F6/F7 per-substep deflection) are all velocity effects,
  // and they stay fixed: velocity responses remain once-per-impact,
  // spool/lag-gated and reduced-mass (see the impact branches below).
  // Correction therefore removes the full overlap in the substep it is
  // detected, before any sample — or any player — can see it.
  if (hit.vertical) {
    const dir = hit.dir; // +1: B is above A — push B up / A down
    const aCan = canMoveY(A), bCan = canMoveY(B);
    if (aCan || bCan) {
      const shareA = aCan ? (bCan ? A.invMass / invSum : 1) : 0;
      const shareB = bCan ? (aCan ? B.invMass / invSum : 1) : 0;
      if (shareA) pushBodyY(A, -dir * hit.depth * shareA);
      if (shareB) pushBodyY(B, dir * hit.depth * shareB);
    } else {
      // Neither can move vertically (sinking pieces, carriers): fall
      // back to a horizontal shove along the line of centres.
      const dx = B.x - A.x, dz = B.z - A.z, d = Math.hypot(dx, dz) || 1;
      const nx = dx / d, nz = dz / d;
      pushBodyXZ(A, -nx, -nz, hit.depth * (A.invMass / invSum));
      pushBodyXZ(B, nx, nz, hit.depth * (B.invMass / invSum));
    }
  } else {
    pushBodyXZ(A, -hit.nx, -hit.nz, hit.depth * (A.invMass / invSum));
    pushBodyXZ(B, hit.nx, hit.nz, hit.depth * (B.invMass / invSum));
  }

  // --- velocity deflection, only for an approaching pair (a separating
  // pair must not gain energy). Velocities are read live: a deflection
  // in the first relaxation iteration must not be applied twice.
  const va = bodyVel(A), vb = bodyVel(B);
  const rvx = vb.x - va.x, rvz = vb.z - va.z, rvy = vb.y - va.y;
  let vn;
  if (hit.vertical) vn = rvy * hit.dir;
  else vn = rvx * hit.nx + rvz * hit.nz;
  if (vn < 0) {
    const e = carrier ? 0.1 : 0.25; // restitution: steel on steel, mostly dead
    const j = -(1 + e) * vn / invSum;
    if (hit.vertical) {
      deflectBody(A, 0, 0, -hit.dir, j, closing);
      deflectBody(B, 0, 0, hit.dir, j, closing);
    } else {
      deflectBody(A, -hit.nx, -hit.nz, 0, j, closing);
      deflectBody(B, hit.nx, hit.nz, 0, j, closing);
    }
    // v1.4.0 mass (audit F5/F6/F7): NO direct heading write here any
    // more — the live carrier's once-per-impact response (spoolSpeed
    // cut + lagged yaw-rate kick) lives in the gated impact branch
    // below, so a sub-threshold graze changes no velocity state at all.
  }

  // --- damage / logging. A piece has no HP: piece-carrier damage lands
  // only on the carrier, in the zone at the contact point; piece-piece
  // contact is logged but damages nothing.
  const hx = (A.x + B.x) / 2, hz = (A.z + B.z) / 2, hy = (A.y + B.y) / 2;
  const depth = hit.depth;
  const names = { a: A.name, b: B.name, aId: A.id, bId: B.id };
  const cool = G.collCool[key] || -1e9;
  if (closing >= GENTLE_CLOSING && depth >= GRAZE_DEPTH && G.time - cool >= IMPACT_COOLDOWN) {
    G.collCool[key] = G.time;
    G.grindCool[key] = G.time;
    const dmgBase = Math.round(3 + 0.6 * closing * closing);
    const catastrophic = carrier && closing >= CATASTROPHIC_CLOSING;
    let zoneC = null, dmgC = 0;
    if (carrier && carrier.alive) {
      const l = carrier.ref.localFromWorld(hx, hz);
      zoneC = carrier.ref.zoneAt(l.lx, l.lz, false);
      carrier.ref.damage(dmgBase, l.lx, l.lz, false, ctx, { noIgnite: dmgBase < 25 });
      dmgC = dmgBase;
      // v1.4.0 mass (audit F5/F6): the live carrier's velocity
      // response, once per impact — spoolSpeed cut + lagged yaw-rate
      // kick, never a direct heading write.
      const other = carrier === A ? B : A;
      carrierImpactResponse(carrier.ref, other, closing, depth);
    }
    let kind = 'piece-impact';
    if (catastrophic) {
      kind = 'piece-catastrophic';
      if (carrier.alive) carrier.ref.breakUp(ctx, `piece impact at ${closing.toFixed(0)} m/s closing`);
    }
    if (carrier) {
      ctx.msg(`PIECE IMPACT — ${piece.name} hit ${carrier.name}: closing ${closing.toFixed(1)} m/s, ${dmgBase} damage${catastrophic ? ' — CATASTROPHIC' : ''}`);
    } else {
      ctx.vfx.burst(hx, hy, hz, 6, [1, 0.75, 0.2], 2, 2);
    }
    logCollision(G, {
      t: +G.time.toFixed(1), kind, ...names,
      closing: +closing.toFixed(2), depth: +depth.toFixed(1),
      dmgA: carrier === A ? dmgC : 0, dmgB: carrier === B ? dmgC : 0,
      zoneA: carrier === A ? zoneC : null, zoneB: carrier === B ? zoneC : null,
      x: +hx.toFixed(0), y: +hy.toFixed(0), z: +hz.toFixed(0),
      shake: +ctx.vfx.shake.toFixed(1),
      pieceSeg: piece ? piece.segLen : null,
    });
    return;
  }
  const gCool = G.grindCool[key] || -1e9;
  const slide = hit.vertical ? Math.max(Math.abs(rvx), Math.abs(rvz), closing * 0.5)
    : Math.max(Math.abs(rvx * -hit.nz + rvz * hit.nx), closing * 0.5);
  if (depth >= GRAZE_DEPTH && (slide > 1.5 || closing > GENTLE_CLOSING) && G.time - gCool >= GRIND_INTERVAL) {
    G.grindCool[key] = G.time;
    const gDmg = Math.round(Math.min(12, 3 + 1.2 * slide));
    let zoneC = null, dmgC = 0;
    if (carrier && carrier.alive) {
      const l = carrier.ref.localFromWorld(hx, hz);
      zoneC = carrier.ref.zoneAt(l.lx, l.lz, false);
      carrier.ref.damage(gDmg, l.lx, l.lz, false, ctx, { quiet: true, noIgnite: true });
      dmgC = gDmg;
    }
    ctx.vfx.burst(hx, hy, hz, 6, [1, 0.75, 0.2], 2, 2);
    logCollision(G, {
      t: +G.time.toFixed(1), kind: 'piece-grind', ...names,
      closing: +closing.toFixed(2), depth: +depth.toFixed(1),
      dmgA: carrier === A ? dmgC : 0, dmgB: carrier === B ? dmgC : 0,
      zoneA: carrier === A ? zoneC : null, zoneB: carrier === B ? zoneC : null,
      x: +hx.toFixed(0), y: +hy.toFixed(0), z: +hz.toFixed(0),
      shake: +ctx.vfx.shake.toFixed(1),
      pieceSeg: piece ? piece.segLen : null,
    });
  }
}

// Check every carrier pair for hull overlap and resolve it. Called once
// per frame from loop(), after steering + carrier updates, before
// checkEnd(). G carries the per-pair cooldowns and the collision log
// (exposed to probes on window.__game).
export function checkCarrierCollisions(G, ctx, dt) {
  const carriers = G.allCarriers;
  const invM = 1 / CARRIER_MASS, invSum = 2 * invM;
  for (let i = 0; i < carriers.length; i++) {
    for (let j = i + 1; j < carriers.length; j++) {
      const a = carriers[i], b = carriers[j];
      if (!isSolid(a) || !isSolid(b)) continue;
      if (!a.alive && !b.alive) continue; // two wrecks do not collide
      // Vertical overlap: hulls only touch while their altitude bands intersect.
      const dy = b.y - a.y;
      if (Math.abs(dy) >= 2 * VERT_HALF) continue;
      // v1.4.0 solidity fix: carrier-carrier detection is the SAME OBB
      // SAT the snapshot (soliditySnapshot) measures with. The old
      // deepest-circle test understated the hull — the bow/stern circles
      // end 5.3 m short of the bow tip at each end — so two ramming
      // carriers could sit with their visual bow tips interpenetrated by
      // up to ~10.6 m while the circles just touched, and the snapshot
      // (correctly) flagged it: solid-c and solid-regress each showed
      // exactly one such sample (worst −12.96 m / −10.76 m) after the
      // F15 cap fix had cleared every piece violation. Resolving on the
      // OBB makes resolver and measurer agree by construction; the hit
      // normal/depth come from the SAT minimum-translation axis, same
      // convention as the piece path (normal points A → B).
      const bodyA = carrierBody(a), bodyB = carrierBody(b);
      const sat = satOverlap(bodyA, bodyB);
      if (sat.separated) continue;
      const hit = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, nx: sat.nx, nz: sat.nz, depth: sat.depth };
      const y = (a.y + b.y) / 2;
      // Relative velocity at the contact point, split into normal
      // (crushing) and tangential (scraping) parts (Hurricane L~3900).
      const va = effVel(a), vb = effVel(b);
      const rvx = vb.x - va.x, rvz = vb.z - va.z;
      const vn = rvx * hit.nx + rvz * hit.nz; // < 0 = moving into each other
      const closingH = Math.max(0, -vn);
      const tx = -hit.nz, tz = hit.nx;
      const vt = rvx * tx + rvz * tz;
      // A falling carrier brings its vertical speed into the impact: only
      // freefall energy counts here (level carriers' climb/descent rates
      // of +-15 m/s are ordinary flight, not impact energy).
      // v1.4.0 mass (audit F19): full vertical closing — the old 0.5×
      // discount had no basis, and with F3 fixed a falling carrier's
      // real horizontal velocity enters closingH properly.
      const dvy = (a.state === 'falling' || b.state === 'falling') ? Math.abs(vb.y - va.y) : 0;
      const closing = closingH + dvy;

      // Positional push-apart (Hurricane v11.34), split by inverse mass.
      // Always applied, even for a gentle nudge, so hulls never stay
      // interpenetrated. Sinking wrecks get their mesh synced too —
      // their update branch only writes y.
      // v1.4.0 solidity fix: NO rate cap on positional correction (see
      // the note in resolvePiecePair above — the 09:18 F15 cap at
      // 2 m/s per side left deep overlaps clearing over seconds, i.e.
      // visible interpenetration; a constraint projection is not a
      // velocity, and all velocity responses stay capped/gated).
      const pushA = hit.depth * 0.5 * (invM / invSum) * 2;
      const pushB = hit.depth * 0.5 * (invM / invSum) * 2;
      a.x -= hit.nx * pushA; a.z -= hit.nz * pushA;
      b.x += hit.nx * pushB; b.z += hit.nz * pushB;
      a.group.position.x = a.x; a.group.position.z = a.z;
      b.group.position.x = b.x; b.group.position.z = b.z;

      // v1.4.0 mass (audit F5/F6/F7): the old per-substep velocity
      // deflection is GONE — it cut forwardSpeed directly (bypassing
      // the spool) and snapped heading up to 8.6° in a single substep,
      // re-applied every substep, even in sub-threshold grazes that
      // never logged. All velocity/heading effects now live inside the
      // impact gates below (carrierImpactResponse, once per impact).
      // A separating pair gains no energy; a graze gets push-apart only.

      const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
      const la = a.localFromWorld(hit.x, hit.z), lb = b.localFromWorld(hit.x, hit.z);
      const zoneA = a.zoneAt(la.lx, la.lz, false), zoneB = b.zoneAt(lb.lx, lb.lz, false);

      // One damaging impact per pair per cooldown window (Hurricane).
      const cool = G.collCool[key] || -1e9;
      if (closing >= GENTLE_CLOSING && hit.depth >= GRAZE_DEPTH && G.time - cool >= IMPACT_COOLDOWN) {
        G.collCool[key] = G.time;
        G.grindCool[key] = G.time; // grind ticks start after the impact, not with it
        const dmgBase = Math.round(3 + 0.6 * closing * closing);
        const catastrophic = closing >= CATASTROPHIC_CLOSING;
        // damage() fires hitFX + scorch + fire + the magazine/reactor
        // detonation gates per side; light hits (< 25) do not ignite.
        const dmgA = a.alive ? dmgBase : 0;
        const dmgB = b.alive ? dmgBase : 0;
        if (a.alive) a.damage(dmgBase, la.lx, la.lz, false, ctx, { noIgnite: dmgBase < 25 });
        if (b.alive) b.damage(dmgBase, lb.lx, lb.lz, false, ctx, { noIgnite: dmgBase < 25 });
        // v1.4.0 mass (audit F5/F6): once per impact, through the
        // spool and the yaw lag — never a direct heading write, never
        // a per-substep speed cut.
        if (vn < 0) {
          carrierImpactResponse(a, b, closing, hit.depth);
          carrierImpactResponse(b, a, closing, hit.depth);
        }
        let kind = 'impact';
        if (catastrophic) {
          kind = 'catastrophic';
          // A hard enough hit breaks the carrier up outright (breakUp
          // fires the magazine-secondary FX itself). A magazine/reactor
          // detonation inside damage() above already did this — breakUp
          // is a no-op for a carrier that is already gone.
          for (const c of [a, b]) {
            if (c.alive) c.breakUp(ctx, `collision at ${closing.toFixed(0)} m/s closing`);
          }
        }
        ctx.msg(`COLLISION — ${a.name} and ${b.name}: closing ${closing.toFixed(1)} m/s, ${dmgBase} damage each${catastrophic ? ' — CATASTROPHIC' : ''}`);
        logCollision(G, {
          t: +G.time.toFixed(1), kind, a: a.name, b: b.name, aId: a.id, bId: b.id,
          closing: +closing.toFixed(2), depth: +hit.depth.toFixed(1),
          dmgA, dmgB, zoneA, zoneB, x: +hit.x.toFixed(0), y: +y.toFixed(0), z: +hit.z.toFixed(0),
          shake: +ctx.vfx.shake.toFixed(1),
        });
        markAvoidance(a, b, G.time);
        continue;
      }

      // Grind damage (Hurricane v10.10): while the hulls stay overlapped
      // and sliding/pressing, both take repeated small ticks — a slow
      // grind still hurts, but the 1 s cooldown keeps it from insta-killing.
      const gCool = G.grindCool[key] || -1e9;
      const slide = Math.max(Math.abs(vt), closing * 0.5);
      if (hit.depth >= GRAZE_DEPTH && (Math.abs(vt) > 1.5 || closing > GENTLE_CLOSING) && G.time - gCool >= GRIND_INTERVAL) {
        G.grindCool[key] = G.time;
        const gDmg = Math.round(Math.min(12, 3 + 1.2 * slide));
        if (a.alive) a.damage(gDmg, la.lx, la.lz, false, ctx, { quiet: true, noIgnite: true });
        if (b.alive) b.damage(gDmg, lb.lx, lb.lz, false, ctx, { quiet: true, noIgnite: true });
        // Small spark burst at the contact point — the grind's only FX
        // (the quiet damage path skips hitFX/scorch on purpose).
        ctx.vfx.burst(hit.x, y, hit.z, 6, [1, 0.75, 0.2], 2, 2);
        const sCool = G.scrapeCool[key] || -1e9;
        if (G.time - sCool >= 5) {
          G.scrapeCool[key] = G.time;
          ctx.msg(`HULLS SCRAPING — ${a.name} and ${b.name} grinding together!`);
        }
        logCollision(G, {
          t: +G.time.toFixed(1), kind: 'grind', a: a.name, b: b.name, aId: a.id, bId: b.id,
          closing: +closing.toFixed(2), depth: +hit.depth.toFixed(1),
          dmgA: a.alive ? gDmg : 0, dmgB: b.alive ? gDmg : 0, zoneA, zoneB,
          x: +hit.x.toFixed(0), y: +y.toFixed(0), z: +hit.z.toFixed(0),
          shake: +ctx.vfx.shake.toFixed(1),
        });
        markAvoidance(a, b, G.time); // contact persists — keep the window open
      }
    }
  }

  // --- Piece-involved pairs (piece-carrier, piece-piece), broadphase grid ---
  const bodies = solidBodies(G);
  if (bodies.some(b => b.kind === 'piece')) {
    const grid = new Map();
    const cellKey = (cx, cz) => cx + ':' + cz;
    bodies.forEach((b, i) => {
      // AABB half-extent of the OBB in world x/z.
      const ex = b.halfLen * Math.abs(b.fx) + b.halfBeam * Math.abs(b.rx);
      const ez = b.halfLen * Math.abs(b.fz) + b.halfBeam * Math.abs(b.rz);
      const x0 = Math.floor((b.x - ex) / GRID_CELL), x1 = Math.floor((b.x + ex) / GRID_CELL);
      const z0 = Math.floor((b.z - ez) / GRID_CELL), z1 = Math.floor((b.z + ez) / GRID_CELL);
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
        const k = cellKey(cx, cz);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
    });
    const seen = new Set();
    const candPairs = [];
    for (const idxs of grid.values()) {
      for (let a = 0; a < idxs.length; a++) {
        for (let b = 0; b < idxs.length; b++) {
          const i = idxs[a], j = idxs[b];
          if (i >= j) continue;
          const pk = i + ':' + j;
          if (seen.has(pk)) continue;
          seen.add(pk);
          const A = bodies[i], B = bodies[j];
          if (A.kind !== 'piece' && B.kind !== 'piece') continue; // carrier-carrier done above
          // v1.4.0 solidity: a piece never collides with its OWN parent
          // carrier — it is born inside the parent's hull and ejects
          // from it; resolving that overlap shoved pieces vertically
          // at the push-apart cap and zeroed their fall speed.
          // Pieces still collide with every other carrier and each other.
          if ((A.kind === 'carrier' && B.kind === 'piece' && B.ref.parentCarrier === A.ref) ||
              (B.kind === 'carrier' && A.kind === 'piece' && A.ref.parentCarrier === B.ref)) continue;
          candPairs.push([A, B]);
        }
      }
    }
    // Relaxation to convergence: resolving one pair can push a body
    // into a third (sibling pieces tumble as a cluster, one sliding
    // past another at ~20 m/s), so a fixed number of passes leaves
    // residual overlap behind — the pair resolved first can be
    // re-overlapped by a pair resolved later in the same pass. Keep
    // re-testing every candidate pair from its pushed positions until
    // a full pass finds zero overlaps (cap 6 — candidate counts are
    // small, and a touching pair reports separated, so this terminates).
    // Damage/log cooldowns (same G.time in every iteration) stop any
    // double impact or grind.
    let itersUsed = 0;
    for (let iter = 0; iter < 6; iter++) {
      itersUsed = iter + 1;
      let any = false;
      for (const [A, B] of candPairs) {
        // Vertical interval check first (cheap reject).
        const dy = B.y - A.y;
        const vHalf = A.halfH + B.halfH;
        if (Math.abs(dy) >= vHalf) continue;
        const sat = satOverlap(A, B);
        if (sat.separated) continue;
        const vDepth = vHalf - Math.abs(dy);
        // Resolve along the axis of least penetration: a shallow
        // vertical overlap means a landing / stacking contact (push
        // apart in y); a shallow horizontal overlap means a side swipe.
        let hit;
        if (vDepth < sat.depth && (canMoveY(A) || canMoveY(B))) {
          hit = { vertical: true, depth: vDepth, dir: dy >= 0 ? 1 : -1 };
        } else {
          hit = { nx: sat.nx, nz: sat.nz, depth: sat.depth };
        }
        // Closing speed: horizontal normal component + the vertical
        // closing speed when a falling body is involved (audit F19:
        // full vertical closing, no 0.5× discount). Velocities
        // are read live (bodyVel) because iteration 1's deflection
        // already changed them — the built body.vel snapshot is stale.
        const va = bodyVel(A), vb = bodyVel(B);
        const rvx = vb.x - va.x, rvz = vb.z - va.z, rvy = vb.y - va.y;
        let closingH;
        if (hit.vertical) closingH = Math.max(0, -rvy * hit.dir);
        else closingH = Math.max(0, -(rvx * hit.nx + rvz * hit.nz));
        const fallingInvolved = (A.kind === 'piece' && A.state === 'falling')
          || (B.kind === 'piece' && B.state === 'falling')
          || (A.kind === 'carrier' && A.state === 'falling')
          || (B.kind === 'carrier' && B.state === 'falling');
        const dvy = fallingInvolved ? Math.abs(rvy) : 0;
        const closing = closingH + dvy;
        any = true;
        resolvePiecePair(G, ctx, A, B, hit, closing, dt);
      }
      if (!any) break;
    }
    // Probe/debug: how many relaxation passes the last piece-bearing
    // call needed (1 = clean on the first pass).
    G.solidityLastIters = itersUsed;
    G.solidityMaxIter = Math.max(G.solidityMaxIter || 0, itersUsed);
  }
}

// ---------------------------------------------------------------------------
// Probe support: a snapshot of every solid body and the worst signed
// separation between any two of them. Signed separation s for a pair:
//   s > 0  bodies are clear by s metres (vertical or horizontal gap)
//   s < 0  bodies interpenetrate by |s| metres along the least axis
// Zero interpenetration at every sampled point means minGap >= ~0
// (a -0.5 m tolerance absorbs one substep of numerical jitter).
// Exposed to probes as window.__game.soliditySnapshot() (game.js).
// ---------------------------------------------------------------------------
export function soliditySnapshot(G) {
  const bodies = solidBodies(G);
  let minGap = Infinity, worst = null, checked = 0, violations = 0;
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const A = bodies[i], B = bodies[j];
      // Same parent-piece exclusion as the resolution loop above.
      if ((A.kind === 'carrier' && B.kind === 'piece' && B.ref.parentCarrier === A.ref) ||
          (B.kind === 'carrier' && A.kind === 'piece' && A.ref.parentCarrier === B.ref)) continue;
      const dy = B.y - A.y;
      const vHalf = A.halfH + B.halfH;
      const vGap = Math.abs(dy) - vHalf;
      let gap;
      if (vGap >= 0) {
        gap = vGap;
      } else {
        const sat = satOverlap(A, B);
        gap = sat.separated ? sat.gap : -Math.min(sat.depth, vHalf - Math.abs(dy));
      }
      checked++;
      if (gap < minGap) { minGap = gap; worst = { a: A.name, b: B.name, aId: A.id, bId: B.id, gap: +gap.toFixed(2) }; }
      if (gap < -0.5) violations++;
    }
  }
  return {
    t: +G.time.toFixed(1),
    bodies: bodies.map(b => ({
      kind: b.kind, id: b.id, name: b.name, state: b.state,
      x: +b.x.toFixed(1), y: +b.y.toFixed(1), z: +b.z.toFixed(1),
      segLen: b.segLen || null, halfLen: +b.halfLen.toFixed(1), halfH: +b.halfH.toFixed(1),
      vx: +(b.vel.x || 0).toFixed(1), vy: +(b.vel.y || 0).toFixed(1), vz: +(b.vel.z || 0).toFixed(1),
    })),
    pairsChecked: checked,
    minGap: minGap === Infinity ? null : +minGap.toFixed(2),
    violations,
    worst,
  };
}

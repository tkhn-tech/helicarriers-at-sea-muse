// collisions.js — helicarrier-vs-helicarrier collisions (v1 feature).
//
// Adapted from Hurricane Fleet ship-ship collisions (index.html L3523
// hullCircles, L3853-4029 collision block): hull circles along the length,
// KE-scaled damage split by inverse mass, positional push-apart, grind
// damage while hulls stay in contact. Re-derived in metres (1 unit = 1 m):
// Hurricane speeds were game units (max ~14 u/s); here carriers run
// 20-30 m/s (STAGES speed), so closing speeds — and the KE scale — differ.
//
// Detection is a 3-D hull-footprint overlap, not a 2-D distance: five
// circles along the 333 m hull (tapered at bow/stern) plus a vertical
// overlap check (|dy| < 70 m). It covers player-player, player-enemy and
// enemy-enemy pairs, including formation neighbours and head-on meetings.
// The 600 m keep-out rudder (game.js) is prevention, NOT this system:
// collisions are still detected and resolved when carriers do meet.
//
// Solid rule (Hurricane v11.41): a carrier counts as an obstacle while
// alive, while falling, and while sinking with sinkT < 1. Two wrecks do
// not collide with each other. Breakup pieces are debris, not obstacles.
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
// all follow from the existing per-zone model in carrier.js.
import { CARRIER_LEN } from './carrier.js';

export const CARRIER_BEAM = 70;   // hull beam, m (matches the sea-wake beam in game.js)
export const CARRIER_MASS = 10;   // all helicarriers equal mass (Hurricane carrier: 10)
export const VERT_HALF = 35;      // hull vertical half-extent, m — hulls touch while |dy| < 70
const CIRCLES = [[-0.4, 0.40], [-0.2, 0.55], [0, 0.55], [0.2, 0.55], [0.4, 0.40]]; // Hurricane L3523 taper
const IMPACT_COOLDOWN = 1.5;      // s per pair between impact hits (Hurricane)
const GRIND_INTERVAL = 1.0;       // s per pair between grind ticks
const GENTLE_CLOSING = 1.5;       // m/s — below this, contact is a nudge: separate, no damage (Hurricane v10.3)
const GRAZE_DEPTH = 0.5;          // m — shallower overlap is a brush-past: no damage (Hurricane v10.5)
const CATASTROPHIC_CLOSING = 20;  // m/s — at/above this, a hit breaks the carrier up
const AVOID_WINDOW = 30;      // s of game time a carrier steers clear after a collision (NEW-1 fix)

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
// falling carrier does NOT translate horizontally (carrier.js fall branch
// only moves y) but falls with vy; a sinking wreck does not move at all.
function effVel(c) {
  if (c.state === 'alive') return { x: c.vx, z: c.vz, y: c.vy };
  if (c.state === 'falling') return { x: 0, z: 0, y: c.vy };
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
      // Deepest circle-pair overlap (Hurricane v10.5b: deepest, not first).
      const cA = hullCircles(a), cB = hullCircles(b);
      let hit = null;
      for (const ca of cA) {
        for (const cb of cB) {
          const dx = cb.x - ca.x, dz = cb.z - ca.z;
          const d = Math.hypot(dx, dz);
          if (d < ca.r + cb.r && d > 0.01) {
            const depth = (ca.r + cb.r) - d;
            if (!hit || depth > hit.depth) {
              hit = { x: (ca.x + cb.x) / 2, z: (ca.z + cb.z) / 2, nx: dx / d, nz: dz / d, depth };
            }
          }
        }
      }
      if (!hit) continue;
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
      const dvy = (a.state === 'falling' || b.state === 'falling') ? Math.abs(vb.y - va.y) : 0;
      const closing = closingH + 0.5 * dvy;

      // Positional push-apart, half the depth per frame (Hurricane v11.34),
      // split by inverse mass. Always applied, even for a gentle nudge, so
      // hulls never stay interpenetrated. Sinking wrecks get their mesh
      // synced too — their update branch only writes y.
      const push = hit.depth * 0.5;
      a.x -= hit.nx * push * (invM / invSum); a.z -= hit.nz * push * (invM / invSum);
      b.x += hit.nx * push * (invM / invSum); b.z += hit.nz * push * (invM / invSum);
      a.group.position.x = a.x; a.group.position.z = a.z;
      b.group.position.x = b.x; b.group.position.z = b.z;

      // Velocity deflection, only for an approaching pair (Hurricane v10.4:
      // a separating pair must not gain energy). Steering re-derives vx/vz
      // from forwardSpeed every frame, so the impulse lands there: the
      // blow cuts speed, and an off-centre hit yaws each hull away from
      // the other. Wrecks take no velocity change.
      if (vn < 0) {
        for (const [c, o] of [[a, b], [b, a]]) {
          if (!c.alive) continue;
          c.forwardSpeed *= (1 - Math.min(0.5, closing * 0.015));
          const brg = Math.atan2(o.x - c.x, -(o.z - c.z));
          const dh = wrapAngle(brg - c.heading);
          if (Math.abs(dh) < Math.PI / 2) {
            const kick = Math.min(0.15, closing * 0.006);
            c.heading += (dh >= 0 ? -kick : kick);
          }
        }
      }

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
}

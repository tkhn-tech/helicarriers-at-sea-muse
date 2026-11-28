# Helicarriers at Sea — v1.6.2

Command a fleet of flying SHIELD helicarriers against an enemy fleet of the
same. Launch F-18 strikes, keep your lift pods alive, and bring your jets
home. **Jets strike only in v1 — no dogfighting.** v1.4.0 adds defensive
CAP gun passes against inbound strikes (see below) — interception,
not dogfighting.

v1.6.2: the whole game now runs in real time by default (×1), with a HUD timescale control (1×/2×/4×/8×) in the top bar. Falls now take their real ~8.4 s from 350 m; at 8× the fall compresses again exactly as before. Physics and damage amounts unchanged. Fragmentation: the black smoke orbs at breakup are gone, pulverised remnants are bigger solid chunks (segLen 44, vt ~110 m/s) with deck strips thickened to match their physics proxy, and the camera follows the largest wreck piece through the explosion instead of snapping to the sea. Rounds never end on their own — when a fleet is destroyed the outcome is shown as a card, play carries on, and 🏁 End round in the top bar ends the round when you choose. Throttle-continuous descent: below the 0.69 hover threshold the ship now descends on the lift shortfall (a = −g·(1 − lift) + drag) — a slow sink just below hover, faster the lower the throttle, full freefall at zero — with lift spooling back up over 6 s on recovery; above hover the climb is unchanged.
v1.6.1: hotfix — underwater-camera crash fixed (VFX sprite shader now declares fogDensity; the linear→FogExp2 fog switch no longer throws at three.module.js:27531).
v1.6.0: performance, fragment solidity/buoyancy/persistence, INDV/ANCHOR steering, camera no-hop, seabed wrecks, damage-shake retune, duplicates fix.
- **Performance** — program pre-warm (shader compiles front-loaded at boot), VFX sprites batched to a single Points draw, sea on a wave table with analytic normals, cheap JS wins, breakup spread over frames. Whole-run work −44% vs v1.5.0 in the headless harness (phone calm ~12–14 ms, kill phases improved).
- **Fragments stay solid** — carriers and fragments never phase through each other; pieces settle, float and sink per buoyancy physics and rest on the seabed (`rested`) instead of despawning; no part of a ship ever just disappears. The one vanish-probe flag on the final tree was a same-frame core held-piece swap to the clipped intact group, proven seamless per-frame.
- **INDV/ANCHOR steering** — in INDV non-selected ships continue in their previous state; in ANCHOR the command ship holds while control inputs steer the rest of the fleet; the waypoint now clears off the nearest driven ship.
- **Camera no-hop** — destroying the selected ship no longer moves the camera; it stays on the wreck as it falls and sinks until Tab/tap switches manually.
- **Damage shake retune** — a bomb hit now heels the 120,000 t carrier ~0.46 deg (was 5.7 deg) with matching smaller yaw, shove and camera shake; damage amounts unchanged.
- **Duplicates fix** — fragmentation no longer shows duplicate copies of the ship (all 8 kill types verified: invariants A1–A5 = 0, A6 = 1).

v1.5.0: destruction detail and realism (research in
`../goals/helicarriers-at-sea-game/hidden_files/v15-destruction-research.md`).
Ships no longer break only in clean slices across the width — each kill picks
one destruction mode (seeded per carrier per round; damage amounts and gates
unchanged):
- **D1 diagonal tear** — one rotated clip plane (20–40°); wedge pieces
  sliding past each other, with a parallelogram-section cap matching the
  diagonal cut (never a rotated transverse cap).
- **D6 asymmetric breakup** — cuts cluster on the hit side: one clean end
  (a long piece that falls level and sinks nearly whole) and a shredded end
  (3–4 ragged pieces + debris cloud).
- **D2 longitudinal deck split** — the deck unzips along the centreline
  trench; the hull parts into side-by-side halves (port full-length,
  starboard split transversely at the hit), each with a side-profile cap
  (new geometry, not a transverse cap); the capsule push-apart handles
  lateral separation.
- **D9 crippled-flight shedding** — she keeps flying crippled after the
  kill (lift decaying over ~14 s), shedding pieces in order along her flight
  path (pod segments first, then island, then hull), sorted by ballistic
  coefficient; the largest segment is the core and falls afterwards,
  clipped to its own range.
- **D7 mid-section pulverisation** — rule (predictable from the kill, never
  random): a segment pulverises iff the kill is a detonation, the segment
  contains the detonation point, and energy ≥ 3.0 — or energy ≥ 4.5 and it
  is the centre segment. The segment becomes a debris burst + 2–4 large
  remnants; bow and stern are left with a debris-filled gap.
- **D8 progressive flooding capsize** — a structural/fire kill on a badly
  flooded hull (hpFrac ≤ 0.35) may die WITHOUT breaking up: list grows in
  steps 10° → 20° → 32° tied to flooding events, then she rolls to 90° and
  sinks on her side, intact.
- **D10 slamming shatter on water entry** — entry-angle branches on the
  impact frag ladder: nose-down → bow crumple (extra bow cut); flat →
  whole-bottom slam + whipping flex (bigger hinge oscillation ~1 s) +
  midship secondary fracture; side → roll trip + diagonal tear. White slam
  ring racing outward + spray sheet up the hull side.
- **D4 island shear-off + D5 pod tear-off** — detachable assemblies as
  their own tumbling rigid bodies with small collision proxies (island
  ~12 m half-beam, pod ~19 m); the pod's rotor keeps spinning while
  attached to the piece, decaying over ~6 s; the list jumps toward the
  dead side at the tear moment.
- **D3 deck buckling + peel strips** — the deck ripples/creases over a
  30–60 m length before separation, then long strips peel back and curl,
  exposing fire below, and become light draggy debris at the first tear.
- **D11 cook-off chain with real clocks** — one blast at a time along the
  magazine; real clocks are 94 s (thin-cased, Forrestal) to 8–10 min
  (thick-cased Mk 83), COMPRESSED to 0.5–30 s for playability (say so in
  code comments and here). Cook-offs past the breakup transfer onto the
  pieces and fire there, including post-splashdown from a burning wreck.
  Visual/audio only, as always.
- **D12 fuel fire on water + travelling deck fire** — deck fires travel
  as a front at 5–10 m/s leaving scorch behind; a burning wreck leaves a
  burning slick (orange emissive edge, flames for the first minute) on
  the sea.
- **D13 true hull flex** — prototype on ONE kill path, the structural
  kill: the hull mesh is split into 2 rigid segments joined at the hinge
  before separation (segments rotate ±hinge/2 relative to each other),
  chosen over a vertex-shader bend, which fights the clip-plane system.
- **D14 implosion at depth** — a sinking piece/carrier below 25 m shows
  a late underwater bubble/debris burst as an air pocket collapses
  (Derbyshire voids collapsed at 25–100 m).
- **Pre-breakup damage detail (§6)** — fires travel along the deck as a
  front; smoke trails behind the ship's motion and vents from the low
  side when listing (dark oily for fuel/ordnance, white steam for the
  reactor); list/trim grow in steps tied to events (pod lost +3°,
  magazine/engines flood +5°, hatch fails +8°); dead bridge kills the
  island lights; attached-but-unpowered pods windmill in freefall.
- **Freefall breakup (§3)** — aerodynamic load (growing with v²) finishes
  weakened damage: a dead pod or the island can tear off in the fall;
  long flat pieces rock with growing amplitude before shedding debris.
- **Sinking (§4.2–4.3)** — list grows in flood steps, trim is bow-first,
  bubbles/boil increase as trapped air is forced out then stop when full.
- **Piece-fall physics re-derived** against the corrected v1.4.2 fall
  model (a = −9.81·(1−liftThrust) − k·vy·|vy|, Cd=1.0, planform 333×68,
  vt=291 m/s) — NOT the old v1.4.1 τ=2.5 s chase and NOT the v14 §4.3
  piece vt formula (36/54 m/s) as written. A uniform-density hull section
  keeps vt 291 m/s; light draggy pieces fall slower by 1/√dragK (pod 206,
  island 168, deck strip 119, pulverised debris 75–92 m/s).
- **VFX pool budget** still binds (1600 particles / 420 sprites): the
  slam sheet (D10) and pulverisation burst (D7) are budgeted first and
  every new emitter is pool-guarded. MEASURED (26 Nov 2026 probes): the
  particle estimate held (liveP hits the 1600 cap during multi-breakup
  action) but the sprite estimate was ~4× too low — liveS reached
  415/420 (long-lived smoke sprites: cut-face venting, piece trails,
  fire/hurt smoke, sinking smoke). The pools saturate gracefully
  (spawnSprite recycles the oldest entry; no errors), but during
  saturation new effects can be throttled — raising S_MAX or guarding
  the pre-existing smoke emitters is a follow-up, not a blocker.
- **Probe-found fixes (26 Nov 2026, verified by re-probe)** — a tear-off
  scheduled past the last release never fired (clamped into the breakup
  window); the D9 crippled core's breakup record was wiped by startFall
  (no longer cleared); a water-impact breakup sea-released on the first
  frame so the D10 whipping flex never showed (hingeMaxDeg measured 0 —
  the sea release now holds ~1 s on water kills; re-measured hingeMax
  3.3°, duration 1.0 s on a flat shatter).

v1.4.2: the in-game toast/event messages are removed entirely (the
`#msg` element, its CSS and its show/hide logic are gone; `msg()` in
`js/game.js` is a no-op so the call sites in game/carrier/jets/
collisions keep working — nothing of that kind can appear). On phone
portrait the speed telegraph is anchored to the bottom of the viewport,
so collapsing or expanding Air Ops never moves it. Freefall is now real
physics (see `../goals/helicarriers-at-sea-game/hidden_files/
v14-physics-spec.md` §8, superseded 26 Nov 2026): initial acceleration
exactly g = 9.81 m/s², drag F = ½·ρ·Cd·A·v² (ρ = 1.225, Cd = 1.0,
planform 333×68 = 22,644 m², attitude-scaled), terminal velocity
291 m/s flat — the old 40–70 m/s terminal with a τ=2.5 s chase gave
~27 m/s² (2.75g) and capped the fall at ~66 m/s. From 350 m the fall now
takes 8.5 s and hits at 81 m/s; from 600 m, 11.2 s at 105 m/s. Recovery
is physics too: hover thrust alone holds a fall rate but cannot arrest
one — immediate FULL-throttle restore recovers from 350 m by only ~24 m
and from 600 m with ~274 m to spare, while a ~2 s delayed restore from
350 m hits the sea at ~45 m/s. Rotor
downwash is now visible on the sea: momentum theory with the game's own
numbers (W = 1.1772e9 N, disc area 4,536 m² → v_i = 325 m/s at hover,
392 m/s at full throttle), strength = lift actually produced per pod
faded with height as (76/h)², drawn in the sea shader as a flattened
disc + spray ring + churn + radial streaks under each live pod, plus
spray/mist particles — player and enemy alike, strongest low and at high
lift, absent at altitude. The throttle is linear now: the bottom ~17% of
the slider used to pin at −6 m/s climb (the climb sum was clamped at −6
while the throttle term spans −8…+3.6), so equal steps gave no change
there — the descent clamp is now −8 m/s, the throttle term's natural
floor, and equal 10% steps give equal 1.16 m/s climb steps across the
whole range; hover stays at 69% and full-throttle climb at +3.6 m/s.
The throttle knob also travels the full track now (it moved 29 px in a
110 px track) and sits under the finger. No other feature, physics or
damage amount changed.

v1.4.0: mass-grounded flight physics for the 120,000 t carriers (spec in
`../goals/helicarriers-at-sea-game/hidden_files/v14-physics-spec.md`):
spool-up 0.45 / spool-down 0.60 m/s² with a 4 s speed lag (0→FULL in ~39 s,
stop from FULL in ~31 s / ~274 m), banked lagged turns (10° bank cap, turn
rate falls with speed — 5.2°/s at FULL, 2.8°/s at FLANK in Hurricane seas),
rudder slew 8°/s, mass-limited pitch (12° in ~5.2 s, lever arms re-derived
from the GLB's own pod centres: 65.1 m pitch / 58.2 m roll), 6 s rotor
spool, altitude hold capped +6/−5 m/s, hover threshold re-anchored 0.60 →
0.69 with control authority scaling with lift. Pitch fix: `user-select:
none` on the whole HUD (the first mouse drag used to select the UP/DN
label text, and the next drag died on a native text-drag pointercancel —
rudder had the same flaw), and pitch now commands vertical speed directly
so full pitch-up climbs at 1.25 m/s at hover, 3.9 m/s at FULL 16 m/s and
up to the 6 m/s clamp at FLANK (spec §7.3: climb =
(|V|·0.8 + 6)·sin(pitch), vy chasing it with a 5 s lag — the old code's
6 m/s at hover was audit finding F13, fixed here; measured 4 m gained
in the first 5.6 s at hover, vy 0.97 m/s and still ramping toward 1.25). New collective-style throttle track (69% hovers):
rotor strength drives lift, climb authority, forward-speed coupling and
rotor spin + audio hum; high throttle + pitch up is the strongest climb,
low throttle sinks. All four helm controls (rudder, pitch, telegraph,
throttle) accept simultaneous independent inputs. Formation escorts
reworked for the slow physics (§5.2): catch-up is now signed along-track
(an escort ahead of its slot slows down instead of speeding away —
SHIELD-3 used to fall 900 m behind and never come back), gain lowered
0.05 → 0.02, and heading follows the flagship while it turns, steering
toward the slot only on a steady course — the fleet forms up from spawn
and holds ~35–60 m in straight flight, with no collisions and the
flagship's speed steady. A hard 90° turn at FULL still scatters it
~1.2 km (the slots swing at 42–82 m/s while escorts top out at 22 m/s —
geometrically unavoidable) and it stalls ~800–1300 m off afterwards,
needing manual recovery (Tab) — scattered escorts can also blunder into
each other or the flagship (grinds and one 34-damage impact observed
across probe runs); wider steering clamps were tried and rejected —
one recovered fully in 235 s but the escorts rammed the flagship on
their way back (111 damage), another made the error grow to 1.9 km. Damage amounts, gates,
fall/sink, fragmentation and all v1.3.0 features unchanged.

v1.4.0: the enemy AI director is tactical now (was a launch timer +
nearest target + a beeline at the player flagship). Target selection
scores damage, crippled lift, fires, isolation and distance, with
skill-scaled noise (elite picks the best target almost every time,
cadet often picks a worse one); one fleet-wide focus target is held
for a skill-scaled window, with ~3/4 of the live enemy carriers
striking it and the rest hunting the best secondary target, so the
enemy focuses fire without always dogpiling one ship; launches are
coordinated waves — one flight per carrier, staggered a few seconds
(tighter at higher skill), arriving together instead of trickling in.
Enemy carriers close to a 1400 ± 250 m standoff band around the player
flagship and circle there (Hurricane's optimal-range circling,
rescaled from 240 u × 5.74 m/u) at STANDARD instead of steaming into
the fleet. Each enemy carrier's strike flights fly their own
climb-out lane / altitude step so flights from different carriers
never share a transit line. Skill tiers now differ in wave tempo,
stagger, focus discipline and target quality (cadet ~50 s waves, 6 s
stagger; veteran ~35 s, 3.5 s; elite ~22 s, 2 s) on top of the existing
launch interval / aim error; jetMul/dmgMul stay unwired — wiring
dmgMul would change bomb/missile damage, which the AD tuning forbade.

v1.4.0: combat air patrol (CAP) — a standing defensive fighter
patrol over the fleet, ordered per wing from Air Ops ("Launch CAP
patrol"). One squadron per wing orbits a station 500 m out from its
home carrier toward the nearest enemy carrier, 250 m above the deck
(the flown orbit is ~350 m; the aim radius is 450 m because the jet
cuts the corner chasing the moving aim point at cruise speed). When
an inbound enemy strike flight closes within 1600 m of a live
carrier of the defended side, the patrol breaks orbit and flies a
pure-pursuit intercept (at the attacker's current position — no lead
pursuit) and makes close-range gun passes: one probability roll
(35%) per 2.5 s refractory window while inside 250 m, 4 passes per
jet per sortie, 20 damage through the existing jet zone model. An
attacker closing inside 400 m jinks (the existing SAM-evasion break);
a gun hit in the dive forces an immediate pullout, and two hits
abort the sortie outright — the flight egresses with its ordnance
undelivered (counted, not dropped silently). CAP jets return to
patrol when the target egresses, breaks off past 2200 m, or runs out
of ammo, and RTB for relief after 240 s on station (the wing
relaunches a fresh patrol while CAP is on); standing CAP down
recalls the flight to trap and rearm. This is deliberately NOT the
dogfighting kit (proposal 1, not chosen): no intercept/engage FSM,
no skill table, no lead pursuit, no missiles, no flares, no return
fire from the attackers — CAP is disruption and attrition, not a
kill machine (one gun hit cannot kill a jet alone). Measured
(v14-cap probes, 4v4 veteran, player parked + healed, 360 game-s
each, 6 runs): bombs delivered 2.2/wave with no CAP vs 1.4/wave
with CAP on the flagship's wing only vs 0.7/wave with CAP on all
four wings; all-wings runs totalled 26 aborts and 100 ordnance
denied, gun hit rate 0.33 pooled (68/205) vs the 0.35 design, and 0
CAP gun kills — CAP disrupts, it does not kill outright. At a real
cost: CAP jets stand inside the enemy SAM envelope for their whole
patrol and lost 14–15 jets to SAM/CIWS per 360 s run with all four
wings up (8–9 per run with one wing up; 0 with no CAP airborne in
one baseline run, 4 in the other — all four deck jets lost with a
carrier that died to collision damage, none airborne), so a standing
patrol trades jets for blunted strikes. Most CAP flights end by
losing both jets to AD on station rather than coming home — of 28
cleanly measured intercepts in one all-wings run, 7 returned to
patrol, 3 trapped for rearm, and 18 ended with the flight wiped out.
Enemy CAP does not exist — the director was not changed and still
commands strike flights only. Damage amounts, AD constants, physics
and the director are unchanged.
One bug found by the director probe and fixed with it: keep-out
steering used to count same-side carriers, so the enemy flagship fled
its own escorts (450 m slots, inside the 600 m trigger) and opened
1641 → 3274 m at FULL — keep-out now only counts the opposite side.
No dogfighting: the director commands strike flights only. Damage
amounts, AD constants and the flight model are unchanged.

v1.4.0: the helicarrier model is Nicholas's own STL (Helicarrier model by
roboticide, Printables, CC BY-NC 4.0 — see assets/ASSETS.md), decimated
169,723 → 35,667 triangles and meshopt-compressed (267,644 B, down from
631,132 B). The sculpted hull, four detailed lift fans and the wedge
island are the model itself — the v1.3.0 patch-up is gone: no inner hull
core slab, no flat wedge pods, no blob island. The STL fans spin in
place (lift-matched, diagonal pairs counter-rotating); the deck is the
model's own sloped flight deck (bow −4.65 m, stern +0.86 m) with the
Ford deck texture, centreline trench closed by an infill strip, and
deck markings, island bridge/mast/radar/nav lights and duct caps placed
on the model's measured geometry. Breakup pieces are genuine sections
of this model, with the per-frame re-aimed clip planes and scorched
caps from v1.3.2. All v1.3.0 features intact.

v1.3.0: solid helicarrier models from every angle (closed inner hull core
following the GLB's own keel profile, bow/stern caps, island coaming and
core, pod sponson plates and duct caps, double-sided shells, full-length
deck under-plate); physics-driven fragmentation in an unfixed number of
ways — piece count, split locations, sizes and tumble vary with the killing
blow, and a carrier can fall whole then fragment (or not) on how she hits
the water; fire/explosion visuals that evolve with the damage (burn-fraction
scaling, zone flame colours, cook-off bursts, dying-ship flickers); CIWS +
SAM air defence on both sides with jet SAM-evasion and flares; per-zone jet
damage with fires and spin-outs; synth audio; a Hurricane stage with freak
waves and lightning; a tactical camera that cycles every jet and holds on
detonations; radar sweep and squadron chevrons; pause and a remembered best
result; CCIP bomb-impact prediction in the dive.

v1.2.0: spectate a destroyed carrier as she falls/breaks up/sinks (fleet-row
or 3D tap, helm stays live, R or a live ship exits); rebuilt lift fans —
real 8-blade rotors spinning inside deep ducted pods, spooling with lift
demand; deck hole closed (continuous flight deck) plus deck markings,
island bridge/mast/radar/nav lights, hull panelling and stern exhausts;
pitch control (vertical spring-return track beside the rudder, ↑/↓ keys,
±12°, drives climb/descent with altitude hold on release); deeper damage
physics — zone/severity-tied fires, damage-scaled explosions, and breakups
that vary with hit location, severity, speed and altitude.

GitHub repo: `tkhn-tech/helicarriers-at-sea-muse` — v1.0.0 pushed 24 Nov 2026,
live on GitHub Pages at https://tkhn-tech.github.io/helicarriers-at-sea-muse/

## How to run

Static server from the game root (module scripts need HTTP):

```sh
cd ~/workspace/helicarriers-at-sea
python3 -m http.server 8123
# open http://localhost:8123/
```

Or any static host / GitHub Pages. Three.js 0.160 is **vendored locally**
under `js/vendor/` (downloaded from unpkg at build time) — the game needs
no CDN and no network at all once served. The two models are embedded as
base64 JS modules under `assets/` (`helicarrier.b64.js`, `fa18.b64.js`,
Pandora-style) — no binary `.glb` files are shipped, because the GitHub
snapshot-push route only accepts UTF-8 text files. `js/carrier.js`
decodes them with `atob()` and feeds the bytes to `GLTFLoader.parseAsync`
(MeshoptDecoder stays wired in for the F-18).

## Controls

- **Menu:** fleet size per side (1–4, default 4v4), enemy skill
  (cadet/veteran/elite), weather/sea (Calm/Rough/Storm), formation
  (Cruising wedge / Attack line), cruise altitude, enemy attacks
  (automatic/passive). Start button launches the round.
- **Helm:** drag the on-screen joystick (or ←/→, A/D) for rudder (35° max,
  returns to midships on release). `W/S` or `1–8` or the +/− buttons step
  the 8-notch Engine Order Telegraph (FLANK…FULL ASTERN) with spooling.
  `Tab` switches command between your carriers (slots re-derived from
  current positions, telegraph inherited — no lurch). Mode button cycles
  **FLEET** (flagship + escorts in formation) / **INDV** (selected ship
  only) / **ANCHOR** (selected ship holds, the rest are driven).
- **Altitude:** `Q/E` or the ▲/▼ buttons, 200–600 m. **Pitch:** drag the
  vertical pitch track beside the rudder (or ↑/↓) — nose up climbs, nose
  down dives, ±12°, altitude hold resumes at the new altitude on release.
  **Throttle:** drag the vertical throttle track right of the pitch track
  (or `Shift+W/S`, or `+`/`−`) — collective-style rotor strength, stays
  where left; 69% hovers, above it the excess lift climbs, below it she
  sinks; it also drives rotor spin rate and the rotor hum, and couples
  with forward speed.
- **Waypoint:** click the minimap — the fleet steers there; manual rudder
  cancels it; arrival within 100 m clears it.
- **Air wing:** Launch flight (bombs) / Launch flight (ASM) from the
  selected carrier at the current target; Target button cycles
  nearest → designated enemy carrier (or click an enemy row); Recall wings.
- **Camera:** free orbit — drag to orbit, wheel/pinch to zoom (120–4000 m),
  Shift+drag to pan, `R` reset, `C` cycles tactical tracking
  (fleet → jet → ordnance → carrier), click a carrier to follow it
  (including a dying/sinking one). The helm never locks.
- **Win/lose:** when one side's helicarriers are all destroyed.

## Scale decision

**1 unit = 1 m** (Pandora's metric scale). The helicarrier is 333 m long,
the F-18 is 18.79 m. Hurricane Fleet ran 1 unit ≈ 5.74 m with jets at
16 units — every Hurricane constant that crossed into this game was
re-derived in metres (speeds, release geometry, trap pattern, formation
spacing ~450 m, deck heights). Heading 0 = −Z, forward = (sin h, 0, −cos h),
mesh yaw = −heading; both GLBs are bow +Z in the file, so each is rotated
π about Y on load.

## What was lifted, adapted, built new

- **Lifted verbatim (structure):** JONSWAP spectrum + Gerstner waves +
  `getOceanDataAt` (`js/sea.js`, Hurricane L796–975, GAME_M 1, G 9.81);
  the ocean mesh + shader (`js/sea.js`, Hurricane L1024–1300) with
  `uShips` widened from 8 to **12** slots (8 carriers + 4 wreck slots);
  `steerJetTo` flight model (`js/jets.js`, Hurricane L5679–5832) with
  metric speeds/accels; the squadron state machine shape
  (deckReady/catapult/climb/ingress/attack/egress/rtb/trap/divert/taxi/rearm);
  `magazineSecondary` / hit FX / scorch decals (`js/vfx.js`);
  the OrbitCamera orbit + floor math (`js/game.js`, Pandora
  `OrbitCamera.ts`); the SHIELD GLB normalisation fixes (hide `detail_0` /
  `detail_7`, deck plates DoubleSide, deck measured from `deck_top_*`).
- **Adapted:** compartments → helicarrier zones (pods/reactor/magazine/
  bridge/deck/engines); single fire → up to 6 concurrent per-zone fires;
  Hurricane sinking (30 s quadratic wallow) → runs only *after* the wreck
  is in the water; `splitShip` 2-D clipping cut → 2–3 pieces with 1–2
  world-space planes each; ShipMotion 2-D → horizontal layer + separate
  lift/altitude layer; formation slots gained a third coordinate `dy`;
  `CARRIER_DECK_Y` / catapult / trap altitudes re-based to a deck at
  ~350 m; ASM aim logic kept (re-aims every frame — it was sound).
- **Built new:** gravity freefall with terminal velocity from remaining
  lift, asymmetric-lift attitude, breakup re-checks during the fall;
  the per-zone damage model and its capability losses; the enemy air-wing
  AI (second wing instance + skill tiers + launch director); the enemy
  fleet steering AI; the free-orbit spectating camera + tactical cycling;
  the menu/HUD/minimap; the bomb ballistics probe.

## The wingman-bomb fix

Hurricane's wingman bombs always missed (three compounding defects —
frozen dive aim, release 10 m higher through the leader's 45 m gate,
a 2 s hold that overshot the target). This game re-derived the release
from `AirBomb` ballistics and gives **both** jets the same geometry:
dive 190 m/s at 30°, release **60 m above the target deck and 100 m out
horizontally** (fall 0.61 s, horizontal travel 100.4 m — release distance
== travel). The dive aim is recomputed **every frame** for both jets
(0.5 s target lead); the stagger is time-only (wingman dives 1.5 s after
the leader). Verify with the probe (below).

## VFX pool budgets

Raised from Hurricane's 600 particles / 160 sprites, which the stock-take
flagged as shared round-robin stealers that exhaust with several carriers
burning: **1600 particles, 420 sprites** (`js/vfx.js`: `P_MAX`, `S_MAX`).
Both pools still round-robin and can steal the oldest live entry when
full — callers never assume a spawn survives.

## Helicarrier-vs-helicarrier collisions

New in v1 (after the first build): two helicarriers that meet **collide** —
player-player, player-enemy and enemy-enemy, including formation neighbours
drifting into each other and fleets meeting head-on. Implementation in
`js/collisions.js` (`checkCarrierCollisions`, called once per frame from
`loop()` after steering + carrier updates), adapted from Hurricane Fleet's
ship-ship collision block (hull circles L3523, collision block L3853–4029)
and re-derived in metres.

- **Detection:** 3-D hull-footprint overlap, not a 2-D distance — five
  circles along the 333 m hull (tapered at bow/stern: radii 28 m ends,
  38.5 m amidships, beam 70 m) plus a vertical check (`|dy| < 70 m`, hull
  half-extent 35 m). A carrier counts as an obstacle while alive, while
  falling, and while sinking with `sinkT < 1` (Hurricane v11.41 rule:
  wrecks stay solid while sinking); two wrecks do not collide with each
  other. A falling carrier passing through another carrier's airspace
  collides if the hulls overlap — its vertical speed counts toward the
  closing speed, and (v1.4.0) so does the horizontal drift she carries
  out of the fall. The 600 m keep-out rudder (`game.js`) is prevention
  only: it must not be treated as the collision system, and collisions
  are still detected and resolved when carriers do meet.
- **v1.4.0 solidity rule — pieces are solid too:** every breakup piece
  is a solid body in every state (falling, tumbling, sinking, drifting
  apart): piece-vs-carrier and piece-vs-piece collisions are detected
  and resolved in `js/collisions.js` alongside the carrier-carrier path,
  over a 256 m uniform-grid broadphase (8 carriers + up to 48 pieces).
  A piece's shape is an oriented box built from its real section bounds
  (`segLo`/`segHi` in `carrier.js` — never its geometry AABB, which is
  always full-ship because clipping is rasterisation-only): length is
  the segment's horizontal projection (shrinks as the piece pitches up),
  beam 70 m, vertical half-extent from pitch/roll. Narrowphase is 2-D
  SAT plus a vertical interval check, resolved along the axis of least
  penetration (horizontal shove, or a vertical lift when a piece lands
  on a deck). A piece-vs-carrier hit damages only the carrier, in the
  zone at the contact point, on the same KE scale (`3 + 0.6·v²`,
  catastrophic ≥ 20 m/s breaks the carrier up); a piece-vs-piece hit
  damages nothing — the pieces deflect, grind and separate. Both log
  `piece-impact` / `piece-catastrophic` / `piece-grind` entries in
  `G.collLog`. Probe handle: `window.__game.soliditySnapshot()` returns
  every solid body plus the worst signed separation between any two
  (negative = interpenetration).
- **Consequences** (both sides, equal mass 10/10, so the damage splits
  evenly): zone damage at the impact point through the existing per-zone
  model (`carrier.js` `damage()` — hull/pods/deck as the contact point
  dictates, so list/trim, lift loss, speed/steering degradation and fires
  all follow from it), fire + scorch at the contact point, camera shake,
  and a separation/deflection response (positional push-apart, half the
  overlap depth per frame, plus a speed cut and a heading kick away from
  the other hull) so they do not stay overlapped. While hulls stay in
  contact, repeated grind ticks (≤ 12 damage, 1 s cooldown) keep a slow
  grind hurting without insta-killing. After any impact or grind, both
  carriers get a 30 s post-impact avoidance window (`avoidUntil` /
  `avoidOther`, set in `checkCarrierCollisions`, read by `escortControl`
  in `game.js`): an escort backs off astern at 6 m/s from the other hull
  instead of seeking its formation slot, so the pair actually separates
  instead of re-contacting. The window refreshes on every further impact
  or grind, so it only expires once the pair is clear, and it clears
  early past 600 m separation. It never fires without a recent collision,
  so normal formation flying is untouched, and it never steers the
  player's selected ship — when the flagship itself was hit, the other
  carrier does the avoiding. (First attempt steered away forward at
  6 m/s; a carrier turns at only ~4°/s at low speed, so the bow still
  pointed at the other hull and the re-contacts came in harder — 5
  events, 69 damage/side, closing 5.4–6.0 m/s. Astern was the fix: the
  contact was at the bow, so reversing pulls it straight out.)
- **Damage scale** (closing speed `v` in m/s, KE form
  `dmg = 3 + 0.6·v²` per side):

  | Closing speed | Example | Damage/side | Outcome |
  | --- | --- | --- | --- |
  | < 1.5 m/s | resting nudge | 0 (separation only) | no damage |
  | ~4 m/s | gentle bump / SLOW drift | ~13 | light zone scuff + scorch, no fire |
  | ~8 m/s | HALF-speed ram | ~41 | a zone badly hurt, fire if ≥ 25 |
  | ~16 m/s | HALF vs HALF head-on | ~157 | a whole zone gone |
  | ≥ 20 m/s | FLANK vs FLANK head-on (40 m/s) | ~963 | **catastrophic: breakup** |
  | falling onto a hull | freefall vertical speed adds ½·\|Δvy\| | up to catastrophic | breakup of the live hull |

  Below the catastrophic threshold, magazine/reactor hits can still
  detonate through the existing `damage()` gates, and a hard hit can
  start the freefall via the structural-failure check there. A graze
  (overlap depth < 0.5 m) deals no damage. One damaging impact per pair
  per 1.5 s.
- **VFX:** impact flash + debris burst + smoke/fire at the contact point
  via the existing pools (`hitFX` / `magazineSecondary` — 1600 particles
  / 420 sprites, shared round-robin), camera shake (capped at 18),
  persistent scorch decals (max 20 per hull, FIFO).
- **Debug hook:** `?collide=headon` (flagships 900 m apart, bow to bow,
  both FLANK), `?collide=gentle` (flagship at ALL STOP, enemy flagship
  SLOW into her from 450 m), `?collide=drift` (your carrier 2, 250 m off
  the flagship's starboard beam, heading at her at SLOW — needs 2+
  player carriers; `fleet=1` falls back to the enemy flagship).
  `?collide=1` is an alias for `headon`. The debug panel
  (`?debug=1`) has a "Force collision" button for the head-on case.
  The pair steers at each other with the keep-out and formation
  controller bypassed, and is released after the first impact so normal
  steering takes over and the carriers separate. Enemy jets are set
  passive during a forced collision so a strike cannot sink a carrier
  before the hulls meet. Collision state is exposed for probes on
  `window.__game.collLog` (entries: `{t, kind, a, b, closing, depth,
  dmgA, dmgB, zoneA, zoneB, x, y, z, shake}`, kinds `impact` /
  `grind` / `catastrophic`) and `window.__game.collCool` /
  `grindCool` (per-pair cooldowns).
- **Probe results** (headless, `?timescale=8`, no-op renderer;
  probes at `~/workspace/probe-helicarriers/collide.mjs`):
  - (i) gentle: impact at t=32.5 s game, closing 3.96 m/s, 12 damage
    each, zones magazine/magazine, depth 2 m, shake 18, scorch 1 per
    hull, no fire, both alive, single event, separated (min centre
    separation after impact 248 m).
  - (ii) head-on: impact at t=15.9 s game, closing 40 m/s, 963 damage
    each, zones magazine/magazine, **catastrophic — both carriers broke
    up** (state `gone`, 2–3 breakup pieces, magazine 0, fire 1,
    scorch 1 per hull, shake 18), single event, min centre separation
    after impact 314–322 m — the hulls never occupied the same footprint
    after the impact (first-contact overlap up to ~17 m at coarse sim
    steps, `?timescale=8`).
  - (iii) drift: impact at t=13.0–13.3 s game, closing 3.9–4.0 m/s,
    12–13 damage each (zones pod:0 / magazine), then clean — a single
    event in every run, no re-contact, both alive (hp 0.988 each),
    scorch 1 per hull, min centre separation after impact 202–293 m.
    Four runs with the post-impact avoidance window (see Consequences),
    plus one 64 game-s long observation (single event, 12 damage,
    final separation 366 m). Before the window, the same probe was
    non-deterministic: best case 4 events / 34 damage per side, clean
    after t≈18.5, hp 0.967; worst case 19 events / 127 damage per side
    over 27.6 game-s, magazine destroyed (120→0), 15 scorch decals per
    hull, contact persisting when the probe ended — the escort's
    slot-seeking kept sliding it back along the flagship at ~3–4 m/s.
  - Natural 2v2 (see Verification): one grind tick fired mid-round
    (SHIELD-2 vs ENEMY-1, t=147.1 s, closing 0.97 m/s, depth 6 m,
    12 damage each, tangential slide ~7.5 m/s) — the hulls separated
    within ~1 s and the round was decided by strikes, not the collision.

## Post-game freeze

Found by the verifier: `loop()` never gated on `G.over` — steering,
carrier/wing, bomb/missile and enemy-director updates kept running after
the round ended, so in a natural 2v2 the round ended DEFEAT with "1 enemy
carrier survived" but by the final snapshot both enemy carriers were gone
(the last enemy died *after* the round ended). The end screen's survivor
claim could be visibly falsified behind the 72%-opaque overlay seconds
after it appeared (and symmetrically for a VICTORY survivor).

Fix (minimal, in `loop()`): once `G.over` is set, the whole world-update
block — `updateSteering`, carrier updates, wing updates, carrier
collisions, bombs, missiles, `enemyDirector`, `checkEnd` — is skipped.
Rendering, the sea, VFX decay, camera orbit and the end overlay itself
keep running, so the player can still look around the frozen scene, which
now shows exactly the end state the overlay describes. The freeze starts
at `endGame`, never before: `checkEnd` only ends the round once every
wreck's pieces have resolved, so the wait-for-pieces-to-sink rule is
untouched. Verified with `~/workspace/probe-helicarriers/freeze.mjs`
(`?kill=1` 1v1 → VICTORY, "1 of your carriers survived"): at end
t=49.4 s, +43.3 game-s later every survivor/wreck position, speed,
state and hp was bit-identical (all deltas 0), no new bombs/missiles,
overlay text unchanged and true, zero errors.

## Debug / cheat hooks

- `?debug=1` — debug panel: kill enemy carrier 1 / kill flagship
  (reactor detonation), destroy a lift pod, start a deck fire, run the
  bomb probe, repair the player fleet, time scale ×4, force a
  head-on collision (flagships at FLANK).
- `?collide=headon|gentle|drift` — force two carriers onto a collision
  course (see "Helicarrier-vs-helicarrier collisions" above);
  `?collide=1` is an alias for `headon`. Combine with `&fleet=1`
  (head-on/gentle) or `&fleet=2` (drift) and `&timescale=8`.
  Collision events land in `window.__game.collLog`.
- `?kill=1` — detonate enemy carrier 1's reactor 3 s after start
  (must fall, break up, crash and sink). `?killplayer=1` — same for your
  flagship.
- `?autostart=1` — skip the menu with defaults (4v4, veteran, Calm).
  Combine: `?autostart=1&debug=1&kill=1`.
- `?timescale=4` — start at ×4 game speed (also on the debug panel).
- `?probe=bombs` — run the bomb ballistics probe (20 drops per jet,
  moving target) and show the result; also available as
  `window.__bombBallisticsProbe(targetSpeed, aimErr)` in the console and
  `window.__game` (live game state) for driving the game.
- `?fleet=2&skill=elite&stage=storm` — override menu defaults.

## Files

| File | Size | What |
| --- | --- | --- |
| `index.html` | ~11 KB | Shell, menu, HUD, minimap, import map |
| `js/game.js` | ~38 KB | Bootstrap, steering, camera, HUD, AI, debug; post-game freeze gate in `loop()`; `forceCollisionCourse` + pair steering |
| `js/collisions.js` | ~11 KB | Helicarrier-vs-helicarrier collisions (hull circles, KE damage, push-apart, grind) |
| `js/carrier.js` | ~23 KB | Helicarrier: zones, lift, freefall, breakup, sinking; `damage()` takes a quiet/no-ignite opts for collision grind ticks |
| `js/jets.js` | ~34 KB | steerJetTo, squadrons, wings, ASM/bombs, probe |
| `js/sea.js` | ~16 KB | JONSWAP/Gerstner sea + ocean shader |
| `js/vfx.js` | ~8 KB | Particle/sprite pools, explosions, splash |
| `js/vendor/three.module.js` | 1,272,972 B | Three.js 0.160, vendored (no CDN) |
| `js/vendor/addons/` | ~165 KB | GLTFLoader, MeshoptDecoder, BufferGeometryUtils |
| `assets/helicarrier.b64.js` | 842,018 B | SHIELD helicarrier, 21,247 tris — base64 of the 631,132 B GLB |
| `assets/fa18.b64.js` | 313,167 B | F-18, 17,517 tris, Meshopt-compressed — base64 of the 234,512 B GLB |

## Attribution

- Helicarrier model by **roboticide** (Printables), **CC BY-NC 4.0** —
  decimated and retextured for this game. Non-commercial use only.
- F-18 model: provenance is the Hurricane Fleet / Pandora Planes `JET_GLB`;
  no license recorded — check before any public or commercial release.

## Verification (for the next agent)

- Boot: `python3 -m http.server 8123` from the game root, open
  `http://localhost:8123/?autostart=1&debug=1` — the game boots with no
  console/page errors; `window.__game` exposes live state.
- Probe harness (kept outside the game dir):
  `~/workspace/probe-helicarriers/` — `kill.mjs` (reactor kill →
  breakup → fall → sink → victory), `pieces.mjs`, `launch.mjs`
  (click Launch → catapult → ingress → dive → bombs → RTB),
  `pixels.mjs` (readPixels scene check), `collide.mjs <headon|gentle|drift>`
  (forced collisions, see above), `freeze.mjs` (post-game freeze),
  `nat-coll.mjs` (natural 2v2 + collision log), `fv-fix-ce.mjs
  <flagdeath|simul1v1|...>` ((c)/(e) spot checks), `fv-loops.mjs`
  (trap-loop endurance), `rv-natural.mjs` (natural 2v2). Run with node;
  needs the Playwright Chromium in `~/.cache/ms-playwright/` and the flags
  in the scripts (`--use-angle=swiftshader --enable-unsafe-swiftshader
  --disable-frame-rate-limit --disable-gpu-vsync`).
- Regression results, 2026-11-24 (this build — collision feature +
  post-game freeze):
  - Boot 4v4 (`rv-boot.mjs`): 8/8 carriers alive, zero console/page
    errors, zero failed requests.
  - Bomb ballistics (`rv-probe.mjs`, `?probe=bombs`): leader 20/20,
    wingman 20/20 (100% each), verdict PASS.
  - Trap loops (`fv-loops.mjs`, 2v2, enemy passive, 275.2 s game):
    12 trap entries, 12 catches, 0 bolters, max 3 full loops per
    squadron, live bombs 43/40 (leader 24/22, wingman 19/18), no ghosts
    / stalls / lost jets, zero errors.
  - Natural 2v2 (`rv-natural.mjs`, both sides auto): resolved
    MUTUAL DESTRUCTION (draw) at t=212.1 s game, 8 loops, 9 trap
    entries / 8 catches / 0 bolters, bombs 23/21, zero errors. A second
    natural run (`nat-coll.mjs`) resolved DEFEAT at t=211.9 s game,
    bombs 23/23, with exactly one collision event (a grind tick, see
    above) — the round was decided by strikes.
  - (c) flagship-death transfer (`fv-fix-ce.mjs flagdeath`): SHIELD-1
    killed → command transferred to SHIELD-2 within a frame ("SHIELD-1
    lost — command transferred to SHIELD-2", telegraph inherited, rudder
    held at 35°), zero errors.
  - (e) simultaneous destruction (`fv-fix-ce.mjs simul1v1`): both
    flagships killed at once → MUTUAL DESTRUCTION draw at t=63.8 s
    game, "Both fleets are gone — mutual destruction. No carriers
    survived.", zero errors.
  - Post-game freeze (`freeze.mjs`): see above — all end-state deltas 0
    over +43.3 game-s after a VICTORY at t=49.4 s.
  - Base64 asset conversion, 2026-11-24 (no gameplay change): the two
    binary `.glb` files were replaced by base64 JS modules
    (`assets/helicarrier.b64.js` 842,018 B, `assets/fa18.b64.js`
    313,167 B; total game dir 2,849,660 B, was 2,559,458 B) because the
    GitHub snapshot-push route only accepts UTF-8 text files. The
    loader now decodes with `atob()` and `GLTFLoader.parseAsync`
    (MeshoptDecoder still wired in). Re-verified after the conversion,
    with the `.glb` files deleted: `rv-boot.mjs` 8/8 carriers alive,
    zero errors, zero failed requests; `kill.mjs` reactor kill →
    enemy `gone`, pieces falling (errors: []), and the longer-window
    `kill-long.mjs` run confirmed the full sequence — 3 pieces falling
    (y 350 → 321, vy −5 → −24.6), sinking at y −1 / vy −44.5, then
    🏆 VICTORY at t=45.7 s game, zero errors. (`kill.mjs` itself only
    samples 80 s real, which in this slow SwiftShader sandbox reaches
    only ~t=28 s game at 1280×800, so it ends before the victory at
    t≈46 s; its screenshot step also times out in this sandbox, as
    documented above — neither is a game failure.)
- In this sandbox the headless frame rate is poor (SwiftShader on a
  shared 1.5-CPU cell; measured render 5–18 ms, game JS ~3 ms/frame —
  the game code is light, the host is slow). Use `?timescale=4` or `8`
  for verification runs. Playwright `page.screenshot` hangs in this
  sandbox (compositor readback); use the `toDataURL`/`readPixels`
  path in `pixels.mjs` instead.

## Known gaps / limits (v1)

- Jets have no gear node in this GLB (nodes are Weapon pack / Canopy /
  airframe / helmet only), so there is no visible gear animation; trap
  "catch" is positional, not a wire hook.
- No rotor downwash effect on the sea; no freak wave (Hurricane-only,
  gated hazard — deliberately omitted).
- Enemy fleet AI steers its flagship at the player fleet and launches on
  timers; it does not pick targets tactically or recall wings.
- Breakup pieces are clipping-plane clones, not true geometry splits;
  their COLLISION shape is the real section, not the clone geometry —
  see the v1.4.0 solidity rule below.
- Ocean wake uniforms only cover hulls near the water (flying carriers
  correctly skip them); sinking wrecks keep a wake slot until gone.
- Bomb hit resolution uses the deck footprint only; a bomb that passes
  just beside the deck keeps falling to the sea (by design).
- A falling carrier keeps the horizontal velocity she had when lift
  failed (`fallVx`/`fallVz` in `carrier.js`, decaying slowly), so a
  falling hull is a moving obstacle — the old frozen fall is gone.
- Performance is untested beyond a headless load probe; 4v4 with all
  wings airborne is the heaviest case (~16 jets + 8 carriers).

## v1.4.1 — island grounding, rotor housing, toast removal, icon HUD, free-orbit camera, breakup variety

- **Island grounded:** island fittings are now seated on the real island surface by raycast (the old z-only interpolation floated the mast 6.5 m, antenna 2 23.4 m and the nav lights off the wedge sides entirely). Bridge windows and panel line lie on the measured ramp slope; mast (short, 7 m) and radar stand on the upper terrace; nav lights and antennas moved inward to where surface exists; a coaming closes the 4.4 m gap between the island skirt and the deck.
- **Rotors housed:** the fan-plane fix — `normalizeHelicarrier()` no longer translates the quantized fan geometry (that corrupted the normalized attributes and dropped the rendered fan ~12 m below its duct, the dark slab in Nicholas's screenshot). Fans now sit mid-duct (y −2.5) with the cap disc just below the fan plane, inside the duct; from above the blades spin inside the duct, from below the pod reads as a housed duct.
- **Circled object removed:** the dark pill in open sea was the `#msg` toast showing its idle "—" placeholder — it never hid. The toast is now `display:none` by default and hides again on expiry; real messages still show for 4 s.
- **Icon HUD:** every information dashboard is icons/bars/dots/numbers — ship pill (🚢 code + lift mini-bar + % + pod dots), nav pill (⬍ alt · ➤ speed), air pill (✈ jets · 💣 drops/hits · 🌊 sea), minimap stats (coloured dots + counts), fleet rows (icon + code + HP bar + zone dots, single-letter zone codes), Air Ops as a 2-column icon grid, telegraph head ≣ + notch, teleSub ➤/⎋, pitch ▲/▼, throttle %, rudder ↔, mode icon + code. Layout re-anchored for phone portrait 390×844: two-row top bar with a 96 px minimap reserve, dock top-anchored below the minimap with internal scroll, bottom cluster (rudder 132 + pitch 44 + throttle 44) clear of the dock, readouts above their own tracks. No readout lost; all touch targets ≥44 px.
- **Camera:** the dive camera mode is gone (button, mode, U key). One free-orbit camera: pitch clamp widened to ±1.45 rad, camera floor removed, so it orbits anywhere at any zoom — including below the surface — and spectating a sinking carrier pans continuously through the waterline (underwater tint/fog follow the lens, as before).
- **Breakup variety:** every breakup now draws on a per-carrier, per-round seed. Kill-type profiles (reactor / magazine / fire / structural / water) vary stagger, crack and hinge timing, release order (nearest-first vs shuffled) and cook-off counts; cut spread varies (clustered / spread / ends); slow kills may tear at the weakest zone instead of the hit; 0–4 cook-off bursts fire during the breakup; the hull lists and vents smoke before separation; falling ships vent while intact; piece sink durations vary ±20% and intact sinks take 24–38 s. Damage amounts, zone HP and the always-solid rule are unchanged. Behavioural reference: the helicarrier damage scenes in *The Avengers* (2012) and *Captain America: The Winter Soldier* (2014) — the Avengers beats (one turbine down lists the ship and bleeds altitude progressively while she fights to stay aloft on the remaining rotors; fires and smoke columns; the turbine restart) map to the existing lift/list model (3 of 4 pods still flies, 2 cannot hold altitude) and the pre-breakup list/venting; the Winter Soldier beats (three ships, three different deaths; engines wobbling when hit; hulls bending and wobbling as they tear apart; the destroyed carriers dropping nose-down) map to the kill profiles, the new pod wobble on hits, the hull-flex shudder during the hinge, and the nose-down fall bias toward the damaged end.
- **Zero-throttle fall and water impact follow physics:** at throttle zero the ship used to descend at a scripted 6 m/s and park on the 150 m floor forever — zero lift, no fall, no sea. Now zero throttle is zero lift: she enters the existing freefall (spec §8, `vt = 40 + 30·lift`) and falls straight through the floor to the ocean. Measured from 350 m: vy −27 within the first game-second, terminal −64…−66 m/s, sea in ~6 game-seconds; from 600 m ~15 game-seconds. The water impact is evaluated from the measured arrival — speed, pitch, roll, damage, fires and residual lift thrust — through the existing intact/partial/shatter ladder, extended with two new factors: each fire raises frag 12% (max 4 fires), residual lift thrust cushions it up to 35%. Measured ladder: level 62.7 m/s cold → frag 0.54, intact, sinks whole; level 42 m/s with partial lift → 0.36, intact; level 34.2 m/s with full thrust spooling → 0.25, intact; nose-down 12° + 13° list at 66.3 m/s → 1.11, partial, 2 pieces; burning (3 fires) + damaged (hpFrac 0.55), nose-down + list at 66.4 m/s → 1.99, shatter, 3 pieces. The fall is recoverable — the pods are alive, so restoring throttle spools the fans back up (6 s spool) and the residual thrust cuts the terminal sink rate as it builds; the helm stays on her while she is falling-and-recoverable (command no longer transfers away, since Tab/switch refuse non-alive carriers). Measured: FULL throttle 1 s into a 600 m fall arrests the descent at 66 m and she climbs out; the same restore from 350 m only halves the impact (66 → 34 m/s) — not enough altitude to spool up. One fix the recovery exposed: the old floor snap teleported a recovering ship +93 m (57 → 150 m in one frame), so the floor is now a descent stop only — it fires on a descent command, and a ship climbing out from below the floor just climbs (climb-out from 90 m: 90 → 132 m smooth, no jump). The 150 m floor and 600 m ceiling for controlled flight are unchanged — pitch-down from 200 m stops at exactly 150 m (min 150, vy 0), the V16 floor rule holds.

## v1.4.0 — STL model, mass-grounded physics, director / CAP / AD / wreckage / touch / dive-cam

- **Helicarrier model (PRIORITY):** Nicholas's own STL (Helicarrier model by
  roboticide, Printables, CC BY-NC 4.0 — see assets/ASSETS.md), decimated
  169,723 → 35,667 triangles and meshopt-compressed (267,644 B, down from
  631,132 B). The sculpted hull, four detailed lift fans and the wedge
  island are the model itself — the v1.3.0 patch-up is gone: no inner hull
  core slab, no flat wedge pods, no blob island. The STL fans spin in
  place (lift-matched, diagonal pairs counter-rotating); the deck is the
  model's own sloped flight deck (bow −4.65 m, stern +0.86 m) with the
  Ford deck texture, centreline trench closed by an infill strip, and
  deck markings, island bridge/mast/radar/nav lights and duct caps placed
  on the model's measured geometry. Breakup pieces are genuine sections
  of this model, with the per-frame re-aimed clip planes and scorched
  caps from v1.3.2. Verified by rendered frames from top, bottom, both
  sides, bow, stern and obliques plus a breakup frame: no slab, wedge or
  blob from any angle.
- **Flight physics — mass-grounded (120,000 t):** spool-up 0.45 /
  spool-down 0.60 m/s² with a 4 s speed lag (0→FULL in ~39 s, stop from
  FULL in ~31 s / ~274 m — measured 31.2 s / 272.1 m), banked lagged
  turns (10° bank cap, turn rate falls with speed — 5.2°/s at FULL,
  2.8°/s at FLANK), rudder slew 8°/s, mass-limited pitch (12° in
  ~5.2 s, lever arms re-derived from the GLB's own pod centres: 65.1 m
  pitch / 58.2 m roll), 6 s rotor spool (measured t63 7 s), altitude
  hold capped +6/−5 m/s, hover threshold re-anchored 0.60 → 0.69 with
  control authority scaling with lift. Formation escorts reworked for
  the slow physics: catch-up is signed along-track (an escort ahead of
  its slot slows down instead of speeding away), gain lowered 0.05 →
  0.02, heading follows the flagship while it turns — the fleet forms
  up from spawn and holds ~35–60 m in straight flight (measured escort
  errors 25–40 m at form-up) with no collisions and the flagship's
  speed steady. Known limit, unchanged by this pass: a hard 90° turn at
  FULL still scatters the fleet ~1.2 km (slots swing at 42–82 m/s while
  escorts top out at 22 m/s — geometrically unavoidable) and it stalls
  ~800–1300 m off afterwards, needing manual recovery (Tab); scattered
  escorts can blunder into each other or the flagship.
- **Pitch fix + throttle track:** `user-select: none` on the whole HUD
  (the first mouse drag used to select the UP/DN label text, and the
  next drag died on a native text-drag pointercancel — rudder had the
  same flaw), and pitch now commands vertical speed directly: full
  pitch-up climbs at 1.25 m/s at hover, 3.9 m/s at FULL 16 m/s, up to
  the 6 m/s clamp at FLANK (spec §7.3: climb = (|V|·0.8 + 6)·
  sin(pitch), vy chasing it with a 5 s lag — the old code's 6 m/s at
  hover was audit finding F13, fixed here; fresh merge-probe
  measurement: 4 m gained in the first 5.6 s at hover, vy 0.97 m/s
  and still ramping toward 1.25, pitch 12°, return to level on
  release verified).
- **Air-defence tuning (proposal 2):** SAM_DMG 55 → 40 (one SAM no
  longer primes a zone for a single CIWS follow-up kill), SAM turn
  3 → 3.5 rad/s, flare decoy 0.5 → 0.4, CIWS_HIT_P_JET 0.08 → 0.06,
  and the `samsHit` counter fixed (was always 0). Measured over 10
  clean strike flights (fresh re-run on the final tree): AD losses
  0.60/flight — the pass-3 sample measured 0.40 and the v1.3.0
  baseline 0.6, so the loss mean varies run to run and the tuning's
  stable effects are elsewhere: SAM connect 35.5% (pass 3: 40%;
  baseline ~27%), bombs intercepted 14% (was 25%), bombs 31/31
  logged hit, target died 7/10. All 6 fresh losses were SAM wing
  kills; CIWS did damage but killed nothing in this sample. Bomb
  damage, zone HP, reload, ranges and skill tiers unchanged.
- **Bomb accuracy / round length (proposal 4):** FIRE_DRAIN_RATE 2.0
  → 1.2 HP/s (new const) — the round-length lever: at 2.0 a reactor
  fire finished what 2–4 bomb hits started in 9/10 flights. Over 5
  full 4v4 rounds: rounds +30% longer on average (376 → 489 game s),
  bombs hit/logged 97.9%, 3W–2L (baseline 1W–4L), per-round AD
  attrition down ~30% but still meaningful. Knock-on: mid-air
  collisions rose (22 jets over 5 rounds vs 4 — jets survive AD
  longer, so more are airborne at once); not touched here.
- **Enemy AI director (proposal 3):** tactical now (was a launch timer
  + nearest target + a beeline at the player flagship). Target
  selection scores damage, crippled lift, fires, isolation and
  distance, with skill-scaled noise; one fleet-wide focus target held
  for a skill-scaled window, ~3/4 of live enemy carriers striking it;
  launches are coordinated waves (one flight per carrier, staggered
  a few seconds, tighter at higher skill) arriving together. Enemy
  carriers close to a 1400 ± 250 m standoff band around the player
  flagship and circle there at STANDARD instead of steaming into the
  fleet; each carrier's flights fly their own climb-out lane /
  altitude step. Skill tiers now differ in wave tempo, stagger, focus
  discipline and target quality (cadet ~50 s waves, 6 s stagger;
  veteran ~35 s, 3.5 s; elite ~22 s, 2 s). Measured (4v4 veteran,
  player parked): standoff 13/15 samples in band (median 1583 m),
  27 launches in 8 waves, 7/8 focus-fire waves; fresh re-run on the
  final tree confirms it (11/12 in band, median 1578 m, 25 launches
  in 7 waves, 6/7 focus-fire waves). Also fixed: keep-out
  steering used to count same-side carriers, so the enemy flagship
  fled its own escorts — keep-out now only counts the opposite side.
  jetMul/dmgMul stay unwired (wiring dmgMul would change bomb/missile
  damage, which the AD tuning forbade). Damage amounts, AD constants
  and the flight model unchanged.
- **Combat air patrol (proposal 7):** a standing defensive fighter
  patrol over the fleet, ordered per wing from Air Ops. One squadron
  per wing orbits a station 500 m out from its home carrier toward
  the nearest enemy carrier, 250 m above the deck. When an inbound
  enemy strike flight closes within 1600 m of a live carrier of the
  defended side, the patrol breaks orbit and makes close-range gun
  passes (35% per 2.5 s window inside 250 m, 4 passes per jet per
  sortie, 20 damage through the jet zone model); a gun hit in the
  dive forces an immediate pullout, two hits abort the sortie
  outright. Measured (4v4 veteran, 360 game-s runs): bombs delivered
  2.2/wave with no CAP vs 1.4/wave with CAP on one wing vs 0.7/wave
  with CAP on all four wings; all-wings runs totalled 26 aborts and
  100 ordnance denied, gun hit rate 0.33 pooled vs the 0.35 design,
  0 CAP gun kills — CAP disrupts, it does not kill outright. At a
  real cost: CAP jets stand inside the enemy SAM envelope for their
  whole patrol and lost 14–15 jets to SAM/CIWS per 360 s run with all
  four wings up. Enemy CAP does not exist — the director still
  commands strike flights only. This is deliberately NOT dogfighting
  (proposal 1, not chosen): no intercept/engage FSM, no skill table,
  no lead pursuit, no missiles, no flares, no return fire.
- **Floating wreckage (proposal 9):** sunk carriers leave drifting
  debris fields and oil slicks that stay on the sea for the rest of
  the round. Measured (fresh re-run): 6 fields / 30 chunks / 6 slicks
  present at +30 s, growing to 12 / 48 / 12 by +120 s as more ships
  sank, and all still present at +300 s; wreck update 1.45 ms.
- **Touch refinements (proposal 11):** floating rudder (thumb lands =
  centre, centre-follow past the ring, 3 mm dead zone, spring-back on
  release, lost-pointer-capture recovery), every in-round button ≥
  48 px hit area, haptics only on meaningful events (kill once,
  own-loss pattern, freak wave, round end — silent for telegraph /
  camera / waypoint), tap-vs-drag disambiguation (4 mm), pinch zoom
  with a 2 mm jitter gate and survivor-orbit on finger release,
  third-finger telegraph taps mid-steer, mute kills haptics. One
  pointer registry for the whole HUD (rudder + pitch + throttle +
  orbit + pinch-partner); the legacy Touch Events pinch listeners are
  deleted. Verified headless at 390×844 (CDP touch, fresh re-run on
  the final tree): 20/20 spec tests pass, zero console errors, zero
  failed requests. (An earlier run showed T18 pinch and T22 perf
  failing; both pass on re-run — T18 was a probe read racing the
  input dispatch, and T22's headless fps baseline varies 6.8–84 fps
  run to run under SwiftShader, so the metric is not reproducible
  headless; the touch input path itself adds no per-frame allocation.)
- **Dive camera (proposal 14):** spectate a sinking wreck, then dive
  the camera under the surface (U) to watch it go down — underwater
  fog, tint and wash; surface (U) returns, tactical camera and reset
  both exit dive mode. Verified: dive/surface/tactical-exit/reset-exit
  all pass, underwater frame 87% blue.
- **Solidity rule — pieces are solid too:** every breakup piece is a
  solid body in the collision system, so pieces never phase through
  each other or a live carrier in any state. The 09:18 mass-discipline
  change (F15 separation cap, 2 m/s per side) regressed this — deep
  overlaps took seconds to clear (worst −26.57 m). Fix pass (same
  day): positional correction is exempt from the cap — it is a
  constraint projection, not a velocity, so it cannot cause a glide,
  shove or freeze (all velocity responses stay capped/gated); and
  carrier-carrier detection now uses the same full-hull OBB SAT the
  solidity snapshot measures (the old tapered circles ended 5.3 m
  short of each bow tip, letting visual bow tips interpenetrate up to
  ~10.6 m while the circles just touched). Re-verified 2026-11-25:
  solid-a/b/c and solid-regress 0 violations on two consecutive runs
  each (worst min-gap −0.28 m), fragmass dense 0 violations; full
  17-probe sweep re-run clean on the fixed tree.
- **Fragmentation realism + mass discipline:** breakups are progressive
  (cracking → hinge → sequential release over ~1.5–2.3 s, hinge
  3.8–6.2°), cuts are seeded and jagged with torn petals / bent flaps
  on the caps, cut-face venting and debris shedding are pool-guarded;
  pieces tumble with mass-capped rates and inherit the carrier's
  momentum (falling hulls keep their horizontal drift; INDV/ANCHOR
  stops are damped, not instant). Verified: detonation 5 pieces,
  silhouette sum 333 m (one 333 m ship, no duplicates); wreck
  freeboard error ≤0.05 m; piece yaw rates inside their caps.
- **Verification (final sweep, 2026-11-25):** boot 8/8 alive, zero
  console errors, zero failed requests on every probe page. Probe
  results in `~/workspace/probe-helicarriers/v14-*.json` (fresh
  re-runs) with per-item notes in
  `~/workspace/goals/helicarriers-at-sea-game/hidden_files/`.

## v1.3.0 — solidity, fragmentation, refinement pass (folded into the v1.4.0 push)

- **Solid models (v1.2.1 work, folded in):** the GLB hull is open shell
  patches — the mid-body side band was open and the belly hollow (rays
  from below first hit the recessed deck under-plate at y −5.9 instead of
  a keel, 64% of belly rays). A closed inner hull core (a loft whose
  sections follow the GLB's own measured keel profile, inset ~1.5 m)
  now backs the deck and closes the belly; bow/stern caps, an island
  coaming + inner core (the island shell had a see-through band), pod
  sponson plates and duct caps, double-sided shells everywhere, and a
  full-length deck under-plate. Verified by raycast + rendered-pixel
  checks from top, bottom, both sides, bow, stern and obliques: 0 misses
  in every band (side 0/61, top 0/375, belly 0 shallow/297, stern 0/35,
  bow 0/21, island 0/36).
- **Fragmentation (v1.3.1 work, folded in):** breakups are driven by the
  killing blow — energy = severity × speed × altitude × attitude
  (×1.3 detonation) sets 1–5 cuts (2–6 pieces) at growing radii around
  the hit, so piece sizes, split locations and tumble all vary; pieces
  inherit impact velocity and attitude. A lightly damaged ship mostly
  rides her fall out intact; a wreck mostly comes apart on the way down.
  At the water, the impact is re-evaluated — level + slower + healthy
  stays intact and sinks, a hard or nose-first impact shatters.
  v1.3.2 fix: each piece is a genuine section, never a full copy — the
  cut planes live in the piece's local space and are re-aimed every
  frame as it tumbles (the v1.3.1 port baked world-space planes once, so
  pieces showed each other's decks, islands and pods — a glitching
  mess of duplicates); every interior cut face gets a solid dark
  scorched section cap, and sinking pieces keep drifting apart and
  tumbling instead of freezing in a pile at the impact point. Verified
  by rendered frames plus a silhouette check: a clean two-half split
  renders 134 m + 184 m = 318 m (one 333 m ship in two parts).
  Forced-kill probes: reactor kill at speed/altitude 6 pieces; magazine
  kills 5 (slow/low) and 6 (fast/high); moderate magazine kill 3;
  structural fall from 500 m broke up in the air (4 pieces); light
  pod-loss fall from 150 m fell intact and sank intact (frag 0.83);
  nose-first impact shattered (5 pieces, frag 2.14); light fall from
  550 m broke into 2 at the water (frag 1.22).
- **Fire/explosion visuals:** flame/smoke scale grows with the zone's
  burn fraction, reactor fires burn white-blue at the core, magazine
  fires red-orange, smoke darkens as fires mature, hot magazine/reactor
  fires throw visual-only cook-off bursts (verified: 0 while gated,
  bursts at the fire location once intensity > 0.85 and zone HP < 45),
  new fires flare up on ignition, dying ships (< 25% HP) flicker with
  flames at scorched deck points, detonations scale with the killing
  blow and throw a debris smoke ring. No damage amounts changed.
- **Refinement pass (A–J):** CIWS (~700 m) + SAM (~1,600 m, max 2 out,
  6 s reload) on both sides, jets break 90° and dump flares on SAM
  launch; per-zone jet damage (wing/engine/fuel, fires, spin-out);
  WebAudio synth (boom, thunder, whoosh, SAM launch, click, flagship
  alarm, mute toggle); 4th Hurricane weather stage, distance-driven
  progression, lightning + thunder, freak waves; tactical camera cycles
  every jet/ordnance and holds 2.5 s on nearby detonations; minimap
  sweep, ring labels, squadron chevrons, ordnance streaks, storm
  clutter; pause (P/Esc) with resume/restart/menu, attract mode behind
  the menu, best result persisted; blast impulses, graded hurt smoke,
  scorch on every hit; CCIP bomb-impact prediction in the dive; loop
  substep cap (≤0.05 s, max 0.10 s/frame) and deck coupling (parked
  jets ride a climbing deck — verified: carrier +31.4 m, jet +31.4 m,
  gap steady at 2.4 m). No dogfighting, no real Sparrow/JDAM models,
  no new modes, no damage-balance changes except tuning the new systems.
  Verified headless: boot 8/8 alive, zero console errors, zero failed
  requests; bomb probe 4/4 hits with air defence live (16 SAMs fired,
  1 ordnance intercepted); SAM evasion observed on the targeted jet
  (defensiveT 2.05, flareT 1.55); CCIP marker live through the dive
  (53 samples, tFall 3.23 → 2.28 s); detonation hold set and cleared
  after ~2.5 game-s.

## v1.1.0 — HUD rework (live)

- Hurricane Fleet's anchored HUD layout: top pill bar (ship / nav / air),
  fleet panel top-left, minimap top-right, Air Ops + telegraph docked
  bottom-right, horizontal rudder track bottom-left. Collapsible fleet
  list and Air Ops panel; on phones the fleet rows go visual (icon +
  short code + health bar), telegraph buttons use short labels, the
  toast sits top-left under the bar. Enemy roster panel removed —
  enemies are tracked on the minimap (tap one to designate it as the
  target, open ocean still sets a waypoint). No mechanics changed.
  Verified headless at 390x844 and 1280x800: zero console errors,
  no overlaps, all controls live.

## v1.1 candidates

- Live verification of a full round (launch → strike → trap → win/lose)
  and tuning of enemy skill balance from that data.
- Tactical enemy AI (target selection, recalls, coordinated strikes).
- Rotor downwash rings on the sea under hovering/low carriers.
- Air-to-air combat (explicitly out of v1 scope — needs its own design).
- Sound: engine/rotor wash and radio chatter (explosions, thunder,
  whooshes, SAM launches, UI clicks and the flagship alarm are in
  since v1.3.0).

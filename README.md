# Helicarriers at Sea — v1.0.0

Command a fleet of flying SHIELD helicarriers against an enemy fleet of the
same. Launch F-18 strikes, keep your lift pods alive, and bring your jets
home. **Jets strike only in v1 — no dogfighting, no air-to-air combat.**

GitHub repo (exists, empty at build time — this build was **not** pushed):
`tkhn-tech/helicarriers-at-sea-muse`

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
- **Altitude:** `Q/E` or the ▲/▼ buttons, 200–600 m.
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
  wrecks stay solid while sinking); two wrecks do not collide, and
  breakup pieces are debris, not obstacles. A falling carrier passing
  through another carrier's airspace collides if the hulls overlap — its
  vertical speed counts toward the closing speed. The 600 m keep-out
  rudder (`game.js`) is prevention only: it must not be treated as the
  collision system, and collisions are still detected and resolved when
  carriers do meet.
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
  a piece that clips through another piece is possible in a multi-piece split.
- Ocean wake uniforms only cover hulls near the water (flying carriers
  correctly skip them); sinking wrecks keep a wake slot until gone.
- Bomb hit resolution uses the deck footprint only; a bomb that passes
  just beside the deck keeps falling to the sea (by design).
- A falling carrier's horizontal position is frozen in the fall branch
  (carrier.js), so a falling carrier only ever collides as a stationary
  obstacle — its closing speed comes from the other hull and its own
  vertical speed, not from carried horizontal momentum.
- Performance is untested beyond a headless load probe; 4v4 with all
  wings airborne is the heaviest case (~16 jets + 8 carriers).

## v1.1 candidates

- Live verification of a full round (launch → strike → trap → win/lose)
  and tuning of enemy skill balance from that data.
- Tactical enemy AI (target selection, recalls, coordinated strikes).
- True geometry breakup + floating wreckage that stays solid.
- Rotor downwash rings on the sea under hovering/low carriers.
- Air-to-air combat (explicitly out of v1 scope — needs its own design).
- Sound (engine/rotor wash, explosions, radio chatter).

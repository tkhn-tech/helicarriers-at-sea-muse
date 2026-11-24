# Helicarriers at Sea (v1) — Reuse Map

Survey date: 2026-11-24. Sources: Hurricane Fleet v11.51 `~/workspace/hurricane-fleet/index.html` (7,954 lines, Three.js 0.160 via unpkg import map, single file) and Pandora Planes Vite v4.9/4.10 `~/workspace/pandora-planes-vite/`. Stock-take read first: `~/workspace/goals/helicarriers-at-sea-game/hidden_files/stock-take-2026-11-24.md`.

Conventions shared by both sources: Y-up, heading 0 = −Z (North), clockwise, forward = (sin h, −cos h), mesh yaw = −heading. Hurricane scale: 1 unit ≈ 5.74 m (`GAME_M`, L772); carrier 174 units = 333 m real (2× scale, L1985–1987). Pandora scale: 1 unit = 1 m; helicarrier 333 m long. **Do not mix the two scales without converting** — Hurricane jet speeds are in game units (≈¼ real speed); Pandora speeds are m/s.

---

## 1. Sea

### 1a. JONSWAP spectrum + Gerstner — `hurricane-fleet/index.html` L772–975

| Item | Location | What it does / constants |
|---|---|---|
| Scale + gravity | L772–775 | `GAME_M = 5.74`, `G_GAME = 9.81 / GAME_M ≈ 1.71` (game units). Old 0.59 made waves oscillate ~1.7× too slowly. |
| `PHYSICS` consts | L779–794 | `restitution 0`, `blastImpulseScale 1.0`, `blastRadius 40`, `floodRate 0.02`, `bilgeDamping 1.2`, `waveDrag 0.25`, `despawnDepth 20`, `orbitalScale 1.0`, `slopeSlide 0.17`. |
| JONSWAP | L796–870 | `JONSWAP_FETCH = 300000` (m), `JONSWAP_GAMMA = 3.3`, `SPEC_N = 14`. `jonswapS(om, U)` L812–818 (peak `wp = 22·cbrt(g²/(U·F))`, α fetch law, σ 0.07/0.09). `buildSpectrum(U)` L819–870: 14 wind-sea components by **equal-variance quantiles**, every component same amplitude `a_i = sqrt(2·m0/N)` where `m0 = 1.67e-7·U²·F/g` (fetch-law variance — the measured Hs law, not the spectrum integral); directions ±40° (`0.7·sin(2πi·0.618)`), steepness `q = 0.7`; plus 4 swell components λ = 350/280/220/160 m, amp `0.1·Hs`, `q = 0.4`, ~55° off wind (0.96 rad). Dispersion `w = sqrt(G_GAME·k)`. Verified: Tp 7.13/8.99/10.29/11.32 s, Hs 0.25/0.50/0.75/1.00 units, `a_i` 0.024/0.047/0.071/0.094 per stage. Also sets `STOKES_U` (surface Stokes drift). |
| `gerstner(x,z,t)` | L874–900 | Sums 18 components; `Q = min(q, 1/max(0.001, k·A))` clamps steepness; returns displaced `{x+ox, y, z+oz}`. Freak-wave Gaussian added here (amp 8, radius 22 — see below). |
| `waveHeight(x,z,t)` | L901 | `gerstner(...).y` — thin wrapper; this is what `ShipMotion` injects as `getWaveHeight`. |
| `getOceanDataAt(x,z,t)` | L907–957 | **The shared ocean query — lift verbatim.** Returns `{height, nx, ny, nz, ovx, ovy, ovz, slopeX, slopeZ}`: height + analytic normal (partial derivatives of displacement, crossed tangents) + orbital velocity (time derivative). Freak-wave height/slope included. Picture and physics can never disagree if everything reads this. |
| `wavePush(x,z,t)` | L959–968 | Horizontal push: orbital surge × `orbitalScale` + slope slide `−slope·G_GAME·slopeSlide`. Applied as a velocity offset. |
| `waveSlope(x,z,t)` | L969–975 | Finite-difference slopes (e = 2). Cheaper fallback; `getOceanDataAt` is preferred. |
| `tideAt(t)` | L867–870 | E–W reversing tide, amplitude 1.0 m/s, full cycle 12 min game time. |
| `ampCur` / `ampTarget` | L872–873, L3580, L5576 | Wave amplitude multiplier; eases toward target at `dt·0.5`. `range = WAVE_AMP_SUM·ampCur + 0.1` feeds shader normalisation. |
| Freak wave | L886–899, L929–944, L3474–3495 | Hurricane + `ampCur > 1.5` only (`state.stage === 3`); spawns 180–250 out, speed 18 u/s, life-limited, re-arm 45–75 s; amp 8, radius 22, Gaussian. Added to both `gerstner` and `getOceanDataAt`, so ships ride it. **V1 decision: probably omit** (hazard, gated to Hurricane). |
| `shipInteractions(dt)` | L975–1023 | Bow-wave lateral shove `0.3·(spd/14)·prox` (only ahead, |across| < 25, spd > 4); Bernoulli abeam suction d < 25, |Δheading| < 0.3, both > 8 u/s, `0.25·(1−d/25)`. Small; makes close formation feel alive. |

**Reuse:** lift `buildSpectrum` / `gerstner` / `getOceanDataAt` / `wavePush` / `tideAt` verbatim. For flying helicarriers the sea only matters at the surface (splash, crash, sinking), but every height query (jet `minY`, bomb/missile `seaH`, sinking `y`) already goes through `getOceanDataAt` — keep that single choke point.

### 1b. Ocean mesh + shader — L1024–1300, L1459–1490, L7910–7926

- `makeRadialOcean()` L1024–1057: centre vertex + `RINGS = [12, 24, 48, 96, 144, 192, 288, 384, 512, 850, 1200, 1700, 2400, 3000]`, `SPOKES = 64` → **897 verts** (1 + 14×64). `OCEAN_STEP = 8`.
- `updateOcean(t)` L1459–1490: mesh follows `fleet[0]`, position snapped to the 8-unit grid so the wave field stays fixed in world space; per-vertex JS Gerstner displacement (local coords = world − mesh origin); `aH` = normalised height, `aSteep` from vertex normal `(1−ny)·3` clamped 0–1; `computeVertexNormals()` every other frame (`frameCount & 1`). Called once per frame at L7910.
- `oceanUniforms` L1071–1090: `uDeep 0x0d2839`, `uBase 0x1a5a78`, `uCrest 0x9fd4e8`, `uSky 0x9fc3d8`, `uSunDir (30,35,−80)`, `uSunI 1.15`, `uFoam 0xa9c2cf`, `uShips[8]` (Vector4), `uShipSize[8]` (Vector2), `uWind (0,1)`, `uWindStr 0`; `THREE.UniformsLib.fog` cloned in; `ShaderMaterial({fog: true, side: DoubleSide})` L1091–1290.
- Fragment shader: Snell's Window underside L1160–1175 (`win = smoothstep(0.55, 0.70, upAmt)`; bright sky disc overhead, abyss `vec3(0.01,0.10,0.16)` elsewhere; no fog on the underside). Topside: 4 value-noise ripple octaves with `detailFade = exp(−dist/170)`; Schlick Fresnel, subsurface scatter, sun glint.
- **Crest foam** L1213–1221: `foamGate = smoothstep(0.20,0.60,vSteep) · smoothstep(0.55,0.85,vH)` (top third of wave only); lace `smoothstep(0.45,0.95, foamGate + (n−0.5)·0.55)·0.45`; **wind gate** `smoothstep(0.35,0.75,uWindStr)` ≈ 0 Calm / 0.3 Rough / 0.9 Storm / 1.0 Hurricane; `· exp(−dist/200)`; final mix `0.35`.
- **Hull foam + Kelvin wake** L1223–1267 (loop `for i < 8` — hard-coded): hull = capsule (centreline segment, beam radius), churning band 0–4 units, bow-weighted `0.6 + 0.4·smoothstep(0, hl, −lz)`, speed factor `smoothstep(0,8,spd)`; wake V-arms 19.5° (`0.34 rad`, `armD` with 0.943/0.334), trail < 45, wash widening `4 + trail·0.15`; `uShips[i] = (x, z, heading, forwardSpeed)`, `uShipSize[i] = (len, beam)`; skip if `uShipSize.x ≤ 1`. Wind streaks L1268–1277 (anisotropic noise, crest-gated `smoothstep(0.4,0.7,vH)`, `·0.35·exp(−dist/260)`).
- Per-frame uniform update L7910–7926: `uShips[i].set(x, z, heading, forwardSpeed·spdFade)`, `uShipSize[i].set(len, wid)`; unused slots zeroed; `uWindStr = STAGES[stage].wind / 20`.
- **Gotchas for v1:** (1) `uShips[8]` / `uShipSize[8]` are hard-coded in GLSL (`uniform vec4 uShips[8]`) **and** JS — must become N (fleet size is 1–4 per side, plus wrecks). Easiest: size the arrays to max fleet and zero unused slots, as the code already does for 8. (2) The mesh follows `fleet[0]` only — with two fleets, follow the midpoint of the action or the player flagship; snapping to the 8-unit grid is what keeps waves world-fixed, keep it. (3) Enemies are **not** in `uShips` — they get sprite wakes only (L5054). For helicarriers the in-shader wake matters less (they fly); consider dropping `uShips` wake for airborne hulls and keeping it for anything on the water. (4) `computeVertexNormals()` every other frame on 897 verts is cheap; do not move displacement into the vertex shader or the picture/physics split reappears.

### 1c. Stage parameters — L624–633, L2507, L2532

- `STAGES` L627–631: Calm `{speed 8, amp 0.35, wind 5, sky 0x9fc3d8, sea 0x1a5a78, sunI 1.15}`; Rough `{10, 0.70, 10, 0x7e9db4, 0x174a64, 1.0}`; Storm `{12, 1.05, 15, 0x5a7286, 0x12394e, 0.85}`; Hurricane `{14, 1.40, 20, 0x39434e, 0x0d2839, 0.6}`. `speed` = stage max ship speed; `amp` = `settings.wave` multiplier; `wind` drives `buildSpectrum` (rebuilt on stage change, L865) and `uWindStr`.
- `STAGE_AT = [0, 400, 1100, 2100]` L633 — stages advance by **distance sailed**, not time (L2507). `stageBase` sky/sunI L637; `setSeaColors` L1445.
- `rockGain = 1 + stage·0.2 + max(0, ampCur−1)·0.4` (L3516, L5004) scales ship rolling. Storm shake floor: `state.shake = max(shake, 0.8·(stage−1))` for stage ≥ 2 (L4586).

### 1d. ShipMotion wave sampling — L1810–2080

- `class ShipMotion` L1825. Constructor opts (defaults): `mass 1`, `maxSpeed 14`, `thrustForce 14`, `rudderTurnSpeed 0.65`, `lateralDrag 5.0`, `forwardDrag 0.55`, `waveIntensity 1.0`, `length 20`, `beam 5`, `getWaveHeight` (injected — **must be `waveHeight`**), `draft 0`.
- `sampleWaves(t)` L1894–1930: 12 points — 4 stations (lz = ±0.45L, ±0.15L) × 3 across (lx = ±0.45W, 0), rotated by heading; `y = mean`, `pitch = atan((hBow−hStern)/L)`, `roll = atan((hPort−hStbd)/W)`, `hMax/hMin` kept. Flooded compartment nodes lose buoyancy: `sampleHeights[pi] *= (1 − flood·0.6)` per compartment (L1910–1917).
- `update(dt, input)` L1930–1985: rudder lag `k = 12` (input 0) / `5` (else) — exponential approach; `speedFactor = 0.12 + 0.88·min(1, |vF|/12)` (turn authority at low speed; `turnFloor` raises floor to 0.55 for re-forming escorts); `turnRate = rudderTurnSpeed·speedFactor·turnSlow`; astern: rudder × −0.25, and 0 if |rudder| < 0.05; `headingRate` lag `k = 10` (rudder ~0) / `4`; thrust accel `(thrust·thrustForce)/mass`; drag `vF·= exp(−dt·forwardDrag)`, `vL·= exp(−dt·lateralDrag)`; `vF` clamped `[−maxSpeed·0.5, maxSpeed]` (FULL ASTERN = −50%); position += (v + current)·dt; `sampleWaves(time)`; surf accel `−sin(pitch)·4·dt` along forward (bow-down accelerates); heel target `−headingRate·min(1,|vF|/12)·0.25`, clamped ±0.18, eased at rate 2.
- `arrive(target, slowingRadius = 30, maxSpeed)` L1867; `avoid(obstacles, lookAhead = 26)` L1873: 3 whiskers at −0.52/0/+0.52 rad, stepped every 4 units, returns `{bias, blocked}` (bias ±0.5 side / ±0.8 centre-blocked).
- `applyToMesh(group, extraRoll, extraPitch)` L1980: `position.set(x, y − draft, z)`, `rotation.set(pitch + extraPitch, −heading, roll + heel + extraRoll)`.
- **Gotchas for v1:** ShipMotion is strictly 2-D + wave ride (y/pitch/roll from the sea, no vertical velocity). A flying helicarrier needs a horizontal layer (this class, with `waveIntensity 0` and y ignored) **plus** a separate vertical lift layer (Pandora §6 model). Do not feed `sampleWaves` output into a flying hull's altitude — it is sea height, not deck height.

---

## 2. Damage VFX

### 2a. Pools — L2317–2444

| Pool | Location | Size / allocation |
|---|---|---|
| Particles (additive `THREE.Points`, `PointsMaterial size 1.7`, `softTex`, vertex colours, `AdditiveBlending`, `frustumCulled = false`) | L2317–2390 | `P_MAX = 600` (v11.27: 420 → 600). Pre-allocated `parts[]` (`{life, max, x,y,z, vx,vy,vz, r,g,b, grav}`); `spawnParticle(x,y,z,vx,vy,vz,life,r,g,b,grav)` L2332 round-robins via `pCursor` — **silently overwrites the oldest live particle when full**. `burst(x,y,z,n,col,spd,up)` L2342: radial burst, life 0.6–1.3 s, `grav −3`. `updateParticles(dt)` L2371: integrate, `vy += grav·dt`, colour fades `life/max`, dead → `y = −999`. |
| Sprites (smoke/fire/glow/wake/boil, one `SpriteMaterial` per sprite) | L2409–2444 | **160 sprites** (v11.47: 120 → 160). Pre-allocated `spritePool[]` (`{sp, life, max, vx,vy,vz, grow, fade}`); `spawnSprite(x,y,z,life,sx,sy,grow,color,opacity)` L2419 round-robins via `spCursor` — **silently steals the oldest live sprite**. `updateSprites(dt)` L2430: velocity, `opacity = fade·(life/max)`, scale `×= (1 + grow·dt)` per frame. |
| Flash light | L509–510, L4581 | Single shared `boomLight = THREE.PointLight(0xff8c2e, 0, 90)`; set intensity 6–14 per event, decays `−dt·18`. One light for the whole scene — new flashes overwrite old ones. |

**Gotcha:** both pools are **shared across every system** (damage, wakes, missiles, sinking, catapult steam). Wakes are throttled to protect the pool (stern wash every `0.70 − 0.20·spd` s, Kelvin every `1.40 − 0.40·spd` s, L4458–4472). With several helicarriers burning/breaking up at once, 600/160 **will exhaust** (stock-take flags this). For v1 raise both (e.g. 1200/320) or split a reserved damage pool; never assume a `spawnSprite` call survives — it can be stolen next frame.

### 2b. Fire / flame / smoke — `damageShip` L3326–3440, per-frame L4137–4185

- Ignition: `dmg >= 8` → `ship.fire = min(1, fire + 0.5)` (L3407). Fire position stored **once, in ship-local frame** (`ship.fireLx/fireLz`, L3383–3387) so flames ride with the hull; hy 0.6 below-waterline / 2.5 topside.
- Per-frame (player ships L4137–4180; enemies mirror at L5106–5120): `hp −= fire·dt·1.0`; flame particles every 0.15 s, `nFl = 2 + floor(fire·4)`, colour `(1, 0.65, 0.2)`, life 0.8, vy 2–4.5, grav −0.5; persistent `fireGlow` additive sprite on the hull, scale `(4 + fire·4)·szF`, flicker `0.7 + 0.3·sin(t·11+x) + 0.2·sin(t·17+z)`; smoke column every 0.2 s, sprite life 3.5, size `(5 + fire·2)·szF`, colour `0x141414`, `vy 3`, wind drift `±1.2`.
- Decay: `fire −= dt·(floodTotal > 0.4 ? 0.05 : 0.015)` (L4175) → burns **~1–2 min**; flooding suppresses it; `fire = 0` when the hull goes under (y < −1) with an 8-particle white steam burst (L4409–4418). `hp <= 0` while burning → `sinkShip(ship, pickSinkMode(ship, 25))`.
- Hurt smoke (no fire): `hp < 70%` → dark smoke every 0.45 s; `< 40%` → every 0.3 s + embers (L4185+).
- **Gotcha:** exactly **one fire per ship** (scalar `fire`, latest hit position only). No spread, no per-zone fires. V1 needs multiple fires per helicarrier (one per damage zone) — restructure as a list, reusing the per-fire spawn math above.

### 2c. Scorch decals — `addScorch` L2355–2370

- Max **20 per ship** (v11.27: 12 → 20), FIFO (`shift()` removes oldest). Dark crater sprite (`0x050505`, opacity 0.95, scale 12–18), pinned in the ship's local frame, `life: 1e9` (persistent for the round, never fades). Called on every hit (L3377) and shared by enemies. Cleared on reset (L2844).

### 2d. Magazine secondary — `magazineSecondary` L3231–3243, `magazineAn` L3222–3226, `pickSinkMode` L3183–3189

- `magazineAn(ship, hx, hz)`: along-fraction `an = along / (len/2)` in the target's frame (bow +); **magazine hit ⇔ `an > 0.5`** (forward 25% = Forward Magazine compartment).
- `pickSinkMode(ship, dmg, magHit)`: `(dmg >= 25 && magHit) || dmg >= 40` → `'breakup'`; `|floodSide| > 0.6` → `'capsize'`; `floodEnd > 0.5` → `'bow'`; `< −0.5` → `'stern'`; else `'settle'`.
- Detonation gate (L3415–3420): `magHit && dmg >= 15 && (hp <= 0 || hpBefore <= maxHp·0.5)` → immediate `sinkShip(ship, 'breakup')`. The half-HP gate is the fairness control — a healthy ship never one-shots. Non-detonating magazine hit (dmg ≥ 15, below waterline) floods compartment 0 completely (`comp0.flood = 1`, L3423–3428).
- `magazineSecondary(x, z, szF)` with `szF = max(1, len/42)` (carrier 174 → 4.14): `boomLight` intensity 14; white flash sprite 14 @ 0.5 s; fireball `20·szF` @ 0.9 s, `vy 4`; shockwave ring `8·szF` @ 0.6 s, `grow 8`; bursts: `80·szF` (cap 100) `[1,0.8,0.4]` spd 9 up 6; `50·szF` (cap 80) hot debris spd 10 up 7; `30·szF` (cap 60) dark smoke spd 5; `state.shake = min(18, shake + 14)`.
- Normal hit FX (L3355–3372, for scale): fireball `(6 + dmg·0.35)·szF` (magazine hit: `max(..., 10·szF)`), shockwave `4·szF` grow 6, bursts `22·szF`/`12·szF`, hit smoke `10·szF`, `boomLight 6 + min(8, dmg·0.4)`, `shake += 10` (cap 18).

### 2e. `splitShip` clipping-plane breakup — L3190–3221

- Clones `ship.group` twice; each clone's materials are **cloned** and given one `THREE.Plane` (`clippingPlanes = [plane]`), world-space plane through the ship centre, normal = forward × sign (bow +1 / stern −1). Original group hidden. Requires `renderer.localClippingEnabled = true` (L440). Planes are **re-aimed every frame** in the sinking branch (L4370–4377) so the cut follows each half as it drifts/turns.
- **Gotcha for v1:** a 2-D vertical cut through the centre only works for a hull split in plan view. A falling helicarrier breaking in 3-D needs either multiple planes per piece or actual geometry splits — the clone-and-clip pattern ports, but the plane math must be re-derived per break axis (and clipping planes are per-material, so budget the material clones).

### 2f. Sinking sequence — `sinkShip` L3244–3300, sinking branch L4342–4470

- `sinkShip`: `alive = false`, `sinkT = 0`, motion zeroed, `fireGlow` removed, bursts `40·szF` / `24·szF`, 6 smoke columns, breakup → `splitShip` + `magazineSecondary`; flagship loss transfers command (`rederiveSlots`, inherit telegraph, L3289–3298).
- Sinking branch (per frame): `sinkT += dt/30` → **fixed 30 s**; `f = min(1, sinkT)`; `y = motion.y·0.75 − f²·20` (**quadratic, no gravity** — `despawnDepth 20`); roll/pitch targets by mode: capsize `1.5·sideSign / 0.1`, bow `0.95·listDir / 0.35`, stern `0.95 / −0.35`, breakup `0.6 / 0.15`, settle `0.15 / 0.05`. Breakup halves drift apart: bow `+f·8` forward at `y − f·2`, stern `−f·6` at `y − f·1`, with diverging rolls.
- Bubbles: every 0.06 s, `nBub = 6 + floor(f·8)`, life 4.0 s, vy 2.5–4, `grav +2` (buoyant), spawned across the hull, biased to the flooded side.
- Boil: every 0.3 s while `0.15 < f < 0.9`, sprite `9·szF`, life 3.0, drifts with current (`vx = curX·0.5`).
- End (`f >= 1`): group hidden, final bubble burst `30·szF`, 5 smoke columns `14·szF` life 4, **6 debris sprites** `3.5·szF`, life **30 s**, drifting with the current — the only persistent wreck mark. No wreck mesh remains.
- **Gotcha for v1:** this is a wallow, not a fall. Replace with gravity freefall + terminal velocity + impact splash, then this sequence (bubbles/boil/debris) only after the wreck is in the water. Wrecks stay **solid/collidable until `sinkT >= 1`** (L3734, L3873) — keep that rule for floating wreckage.

### 2g. Camera shake — L4586–4587, L4809–4812

- `state.shake` (cap 18): +10 per hit, +14 magazine secondary; decays `shake ·= 0.02^dt`; storm floor `max(shake, 0.8·(stage−1))` for stage ≥ 2. Applied in `updateCamera`: if `shake > 0.3`, `camera.position.x/y += (rand−0.5)·shake·0.12`. Cheap, portable as-is.

---

## 3. Air wing

### 3a. Constants — L5629–5638, L5678, L2990

- `CARRIER_DECK_Y = 10.34` (measured: deck top 26.99 − waterline 3.25, × fit scale 174/399.53 = 0.4355; the 13 estimate floated jets 2.66 high).
- `CATAPULTS = [{x: −6, z0: −12, z1: −84}, {x: 6, z0: −12, z1: −84}]` (72-unit track; x −10 ran off the bow deck).
- `WIRE_POS = {x: −8, z: 52}` (angled deck, port side). `DECK_PARK` = 8 spots: `(-8,76), (4,76), (-12,-16), (4,-16), (16,76), (16,-16), (12,-48), (16,8)`.
- Speeds: `JET_CRUISE_SPEED 55`, `JET_ATTACK_SPEED 70`, `JET_CATAPULT_SPEED 68`, `JET_DIVE_SPEED 80`, `JET_TRAP_SPEED 48`. `JET_MIN_ALT 4`, `JET_MAX_ALT 120` (ceiling). `JET_STALL_SPEED 18`, `JET_BUFFET_SPEED 26` (stall 130 kt → 18 u/s at ¼ speed scale).
- `AIR_WING_TOTAL = 12` per wing (L2990); 2 squadrons per wing, 2 jets per launch.

### 3b. `steerJetTo` — L5679–5832 (the flight model; NOT BET — Reynolds Arrive steering)

- **Stall (hysteresis):** stalls below 18, recovers above 26; wing-drop side randomised per stall. Stalled: aim overridden to 30 ahead / 20 below (~34° dive), longitudinal accel 0 (speed gained only by falling), lateral cap 6 (mushy), pitch target −0.6 rad eased at 3 rad/s, roll ±0.5 wing drop, **no altitude floor** (can hit the sea → `crash('stalled into the sea')`).
- **Aim-behind override** (climb/ingress/egress/rtb, v11.49/50): if the aim is behind the jet (`dot < 0`), steer to a point 150 units to the side the target lies on, at own altitude — turns instead of decelerating through zero. Leader publishes `squadron.turnSide`; wingman copies it (prevents opposite-side turns into the leader).
- **Speed:** Arrive `sp = maxSpeed·min(1, d/slowingR)`; bank bleed `sp −= min(12, 8·(1/cos(roll) − 1))` when `|roll| > 0.5`; **commanded floor 30** (not stalled); `formCap` (wingman, §3e). **Actual-speed floor 30** in climb/ingress/attack/egress/rtb (v11.46/50 — this fixed 259 stall-sea deaths → 1).
- **Accelerations:** longitudinal `accel = 20` (stalled 0); vertical `vAcc = 15` stalled / `47` pullout (4 g) / `60` dive pushover / `32` else. Lateral cap `18` (stalled 6). **Cap order matters** (v11.49 fix): in climb/ingress/egress/rtb, longitudinal cap is applied **first**, then the lateral cap — the old order removed the whole turn component (net turn ~1°/s).
- **Attitude:** heading slews `dt·3` toward velocity heading; `omegaSm` smoothed `dt·6`; pitch `= asin(vy/speed) + AoA` (trap 0.14, attack 0, else 0.05), clamped ±1.05 rad; roll = coordinated `−atan2(speed·omegaSm, 15)` clamped ±1.31 rad, rate 3.8 rad/s; SAM-break override ±1.05 rad (`defensiveT/defSide`); pullout forces roll 0.
- **Altitude:** floor `seaH + JET_MIN_ALT` (not while stalled), ceiling `JET_MAX_ALT` (120). **V1 gotcha:** the ceiling is 120 units above the sea — helicarriers fly at ~300–600 units, so jets must be allowed far above 120, and `minY` must be relative to the sea only when low; the deck-altitude logic (`carrierDeckPoint`, `CARRIER_DECK_Y`) must be re-based to a deck at altitude.

### 3c. `FighterJetEntity` — L5834–5960, L6195–6312

- States: `deck | catapult | climb | ingress | attack | egress | rtb | trap | divert | taxi | rearm | crashed | sinking | slideoff | carrierCrash`. Fields: `ordnance 2`, `hp 100`, `formOffset` (leader `{0,0}`, wingman `{18,−12}` — right and **behind**), `aimPoint`, `diveT`, `diveAimPt`, `fired`, `stalled`, `gearNode` ('Gear'), `gearDown`, `catapult`, `parkSpot`, `rolloutV/Z`.
- `buildModel()` L5873: `fitModel('jet')`, procedural fallback if GLB missing; `gearNode = group.getObjectByName('Gear')`.
- `placeOnDeck(carrier, spot)` L5898: `carrierDeckPoint(carrier, spot.x, CARRIER_DECK_Y, spot.z)`; heading/pitch/roll copied from the carrier (sits flat on the deck, incl. trim/list).
- `updateCatapult(dt, carrier)` L5907–5945: constant accel `a = 68²/(2·72) ≈ 32.1` u/s²; `along = min(72, ½·a·t²)`, `speed = min(68, a·t)`; steam sprites every 0.12 s (4 × white, 0.8 s); off the bow → `climb`, `vy = 12`, `pitch = 0.35`. Timeout `t >= 2.5` also releases.
- `update(dt, carrier)` L6195–6312: catapult/deck branches separate; flight states call `steerJetTo(aimPoint, slowingR 40, spd)` (trap: slowingR 8, `JET_TRAP_SPEED`); attack speeds: dive 80 / popup 55 / else 70. Damaged-jet FX: `hp < 50` → dark smoke particle every 0.1 s + roll wobble `sin(t·7)·0.15·dt`; `hp < 25` adds a flame particle. Buffet (18–26, not stalled): roll wobble + white wingtip puffs at ±5.7 every 0.2 s. `syncModel()` L6290: `position.set(x,y,z)`, `rotation.set(pitch, −heading, roll)`. `syncGear()` L6297: gear down on deck/catapult/taxi/rearm/trap (and rtb once `patLeg >= 1`); up in flight; frozen in crash states. `damage(amount)` → `hp <= 0` → `crash()`; `crash(reason)` = flat spin / flaming dive, air wing deduction exactly once.
- **Per-jet visuals worth reusing:** damaged smoke/fire, buffet puffs, pullout flares (3 orange particles every 0.15 s, L6824–6834), catapult steam. **Not present:** afterburner glow (deleted v11.34/35 as a flat square), wingtip contrails (removed v11.44, performance), nav lights (none on jets; island nav lights only, L1652).

### 3d. `AirSquadron` state machine — L6513–7106

States: `deckReady | catapult | climb | ingress | attack | egress | rtb | trap | divert | taxi | rearm`. `update(dt, carrier)` L6640; `carrier` is overridden by `this.homeCarrier` (re-homed squadrons fly from the new carrier).

| State | Lines | Behaviour / numbers |
|---|---|---|
| `launch(loadout, target)` | L6538–6612 | Requires `deckReady`, `deckSafeForLaunch` (`|pitchSm| < 0.15`, `|rollSm| < 0.2`, alive), a live enemy. Finite wing: `n = min(2, wing.availableToLaunch())`; 0 → no launch. Jets rebuilt on deck (`DECK_PARK[(id−1)·2 + i]`); leader `catapult` at once, wingman `deck` with `t = −1` (launches 1 s later, `CATAPULTS[1]`). Consumes radar `airWaypoint` as staging point. |
| `catapult` | L6647–6662 | Wingman fires at `t >= 1`; leader aims at `carrierDeckPoint(carrier, 0, 60, −100)`; → `climb` when all jets are climbing. |
| `climb` | L6663–6669 | Same aim point; → `ingress` when `leader.y > 38`. |
| `ingress` | L6670–6695 | Waypoint first (within 60 → consumed). ASM: `approachPoint(leader, tgt, 260)`, alt `seaH + 42`; → `attack` at `d < 280`. Bomb: `approachPoint(..., 150)`, alt `seaH + 12`; → `attack` at `d < 160`, `attackPhase = 'popup'`. |
| `attack` (ASM) | L6697–6717 | Fire once when `d < 300` (`airMissileSystem.fire(j, tgt)` × ordnance, `ordnance = 0`); hold standoff 260 until all fired → `egress`. |
| `attack` (bomb) | L6718–6840 | `popup` → `dive` → `pullout`. Popup: 60 ahead, climb to `seaH + 47` (30°); dive at `leader.y > seaH + 45` or `t > 6`. Dive: 30° line, release point `sea + 30`, 45 out (see §3f). Pullout: 4 g level recovery (`JET_ATTACK_SPEED`), flares; `t > 3` → `egress`. Dive backstop `t > 20` → pullout with bombs aboard. |
| `egress` | L6836–6843 | `awayPoint(leader, tgt, 200)`, alt `seaH + 50`; `t > 8` or no target → `rtb`. |
| `rtb` | L6844–6871 | Real trap pattern (v11.37), `patPt` legs: downwind `(−190,−60,45)` → `(−190,300,45)` → `(30,360,40)` → final `(−8,210,30)`; advance at `dP < 70/70/90`; at leg 3 and `dC < 240`: carrier dead → `rehomeTo(otherCarrier)` or `divert`; else → `trap`. |
| `trap` | L6895–6931 | Glide-slope point `glideSlopePoint(carrier, 60, 6)` (**5.7°** slope); blend `k = 1 − dW/80` toward wire `carrierDeckPoint(WIRE_POS.x, CARRIER_DECK_Y + 0.5, WIRE_POS.z)`; speed `JET_TRAP_SPEED` 48. Catch: `dW < 6` and `|Δy| < 10` → `taxi`, `rolloutV 28`, `rolloutZ = WIRE_POS.z + idx·25`. Bolter: carrier-local z < `WIRE_POS.z − 30` → `rtb`, `patLeg = 1`. Backstop `t > 90` forces trap. |
| `taxi` | L6931–6934 | `t > 2` → `rearm`, `rearmT = 20`. |
| `rearm` | L6935–6943 | `rearmT −= dt`; at 0 → `deckReady`, `ordnance = 2`, `hp = maxHp`, jets to `deck`. |
| `divert` | L6872–6894 | Circle r = 150 at `seaH + 45` above the (sinking) carrier; when `carrier.sinkT >= 1` → `rehomeTo` or ditch (`crash('ditched — no deck left')`). |
| `recall()` | L6615–6632 | Any non-`deckReady`/`rearm` state → `rtb`. `onJetLost`: all jets lost in ingress/attack/egress → `rtb`. |
| Mirroring | L6944–6962 | Squadron state is mirrored onto flying jets **only** in climb/ingress/attack/egress/rtb/trap/divert; catapult/taxi/rearm jets manage themselves. Crashed/sinking jets still update (v11.25 freeze bug). |

Helpers L7063–7091: `approachPoint(jet, tgt, dist)` (point `dist` from target on the jet→target line), `awayPoint` (far side), `glideSlopePoint(carrier, back, alt)`, `patPt(c, lx, lz, alt)` (carrier-local → world, alt above sea).

### 3e. `CarrierAirWingSystem` — L7107–7240

- One wing per carrier (`carrierKey 'carrier'` = CV1, `'carrier2'` = CV2); `remaining = AIR_WING_TOTAL` (12); 2 squadrons each. `homeCarrier` = `fleet.find(key)`. `airborneCount()` (flying jets only), `availableToLaunch() = max(0, remaining − airborneCount)`, `launch(loadout)` picks first `deckReady` squadron, `recallAll()`.
- `update(dt, runShared)`: squadrons updated over a `.slice()` (a squadron may re-home mid-update); `checkJetCollisions()`; shared missile/bomb systems update **once** (`runShared`, second wing passes false).
- `checkJetCollisions()` L7168–7195: flying states only, centre distance² < 100 (10 units) → both `crash('mid-air collision')`, one fireball at midpoint.
- `rehomeTo(other)` L7189–7211: moves squadron to the surviving carrier's wing, `id = max+1`, `target.remaining += aliveN` (**may exceed 12 — allowed**), `homeCarrier = other`. `reset()` L7197: returns transferred squadrons to origin wing/id.
- `handleCarrierSinking(dt, carrier)` L6972–7010: deck/taxi/rearm/catapult jets `startSlideOff(carrier)`; `trap` jets `crashIntoCarrier(carrier)`; airborne flights re-home; rtb flights divert. Runs **before** the state machine each update.

### 3f. Bomb / missile attack — and the wingman-bomb bug (READ THIS BEFORE PORTING)

**ASM (works):** `AntiShipMissileSystem.fire(jet, target)` L6425; `AntiShipMissile` L6300–6425: speed **90**, dmg 25, inherits jet velocity (vy = 0 at launch); sea-skim `seaH + 5`; terminal popup `d < 60`: `wantY = seaH + 15 − (60−d)·0.18`; lead 0.5 s; turn authority 2.5 rad/s; aim point = target + random `aimAlong ±0.35·L` fixed at launch, recomputed each frame on the target's **current** heading; detonate `d < 10` (to aim point); splash if `d > 900` or `t > 30`; exhaust trail particles every 0.05 s. **Standoff: hold at 260, fire at d < 300** (§3d). This aim logic is sound — the missile re-aims every frame.

**Bomb (leader geometry is tuned; wingman geometry is broken):** `AirBomb` L6446–6512: ballistic — inherits the jet's full velocity at release, `vy −= 15·dt` (gravity 15); dmg 30; hit iff `|along| < L·0.55` **and** `|across| < W·0.75` **and** `y <= seaH + 6`; else a 14-particle geyser + white sprite. Leader dive (L6737–6760): target lead `0.74 s`; `sAim = max(0, ld − 80)`; aim point `tx − ux·sAim, seaH + 30 + (sAim − 45)·0.577, tz − uz·sAim` — a **30° dive line** (tan 30° = 0.577) through the release point (sea + 30, 45 out). Release gate (L6801–6812): `dj <= 45 && y <= relAlt && |roll| < 0.1`. Check the leader's ballistics: 80 u/s at 30° → vy = −40; fall from sea+30 takes (−40 + √(1600+900))/15 ≈ **0.67 s**; horizontal travel 80·cos30°·0.67 ≈ **46** — i.e. releasing at 45 out lands on the target. That is the tuned geometry; do not change these three numbers independently.

**The wingman-bomb bug — three compounding defects, all in L6761–6812:**

1. **Frozen aim.** The wingman's dive aim `j.diveAimPt` is computed **once** when its dive starts (`diveT >= 2`) from the target's then-position (with the 0.74 s lead baked in) and never updated. The leader recomputes `tx,tz` **every frame**. The target is a moving ship (up to 14 u/s); over a 5–10 s dive it moves 70–140 units, so the wingman's dive line points at water where the target used to be. The v11.46 comment claims the fixed aim was deliberate (it stopped the wingman banking through the dive so the `|roll| < 0.1` gate could fire) — it fixed the roll problem by breaking the aim.
2. **Release-altitude mismatch.** The wingman releases at `relAlt = seaH + 40` (10 higher than the leader's sea+30) through the **same** `dj <= 45` gate. Same 80 u/s 30° dive from 10 higher: fall time ≈ 0.86 s, horizontal travel ≈ **60** — the bomb lands **~15 units long** of the target even if the aim were perfect. The leader's numbers are tuned as a set; the wingman's +10 was added for stagger separation without re-tuning the gate.
3. **Hold overshoot.** During the 2 s stagger the wingman only gets `j.aimPoint.y = seaH + 47` (x/z stay on the echelon slot) and flies **onto the target (22 out) and overshoots** (comment at L6766–6778 admits this), then must reverse and re-attack on the stale fixed aim — at the 30 speed floor with lateral cap 18 the turn radius is ~50 units, so the re-attack is a long, flat pass.
4. Measured evidence (comment L6744–6751, v11.47): the `bombAlong ±0.35L` offset was tried three ways and **reverted** — it never moved impacts into the magazine zone (sd 0.21, max `an` 0.42, **0% in the zone**) and cut the bomb hit rate to 71% ("abeam runs aborted, wingman bombs missed off the beam"). Bombs stay centre-aimed; the magazine path runs through shells + missiles.

**Builder instruction:** do **not** copy the wingman dive block. Re-derive both jets' release from `AirBomb` ballistics: recompute the dive aim every frame like the leader (or re-freeze it at short range, e.g. inside 150 units, with a fresh lead), and give the wingman its own tuned (release-altitude, release-distance) pair that satisfies `travel = release-distance` for its altitude — or release both jets from the same geometry with a time/altitude stagger only. Verify with a probe: stationary target, 20 drops per jet, report hit rate and mean along/across error before calling it done.

### 3g. Rearm / re-home — L6932–6943, L7189–7211, L6972–7010

- Rearm: `taxi t > 2` → `rearm` (20 s) → `deckReady`, ordnance 2, HP restored. Losses are permanent against the wing's 12 (`remaining` only decreases; re-homed jets **increase** the receiving wing's `remaining`).
- Re-home triggers: carrier sinking with airborne jets (`handleCarrierSinking`), wave-off in `rtb` (L6862–6872), and `divert` after `sinkT >= 1`. No other deck → ditch (jet lost).
- **V1 note:** there is no enemy air wing in Hurricane Fleet (code comment: CIWS/SAMs idle, "will engage when one appears"). For v1, instantiate a **second `CarrierAirWingSystem`** for the enemy side; the class is already per-carrier (`carrierKey`), but it reads the global `fleet`/`enemies`/`jets` arrays and `airTarget` — parameterise those before cloning, or the two wings will fight over the same globals. Also `deckSafeForLaunch` and `CARRIER_DECK_Y` assume a sea-level carrier deck; a flying helicarrier's deck is at altitude — `carrierDeckPoint` (group `localToWorld`, L5657) already handles a moving/tilted deck, but the catapult/trap altitudes (`seaH + …`) must be re-based to deck altitude.

---

## 4. Fleet steering

### 4a. Telegraph + spool + rudder — L2129–2168, L2206–2258

- `TELEGRAPH` L2159–2168 (index 0 = fastest): FLANK 1.0, FULL 0.8, STANDARD 0.6, HALF 0.4, SLOW 0.2, **ALL STOP 0 (index 5)**, HALF ASTERN −0.25, FULL ASTERN −0.5.
- Per-type specs L2129–2133 (set in fleet setup): carrier `{mass 2.0, thrustForce 28, rudderTurnSpeed 0.6, spoolUp 0.8, spoolDown 1.5, rudderSlew 3}`; battleship `{1.5, 21, 0.65, 1.1, 2.0, 4}`; destroyer `{1.0, 14, 0.7, 1.6, 2.6, 8}`. `spoolUp/Down` are u/s per game-second; `rudderSlew` deg/s.
- `RUDDER_MAX = 35` deg (SOLAS, L2169). Helm input: joystick/←→/A-D sets rudder −1..1 (returns to midships on release); W/S or ↑/↓ or keys 1–8 step the telegraph.
- `driveShip(s, dt, rudderTarget, st)` L2206–2232: spool `spoolSpeed` toward `telegraphTarget` at `spoolUp/Down`; `telegraphTarget = frac · stage.speed · capFrac`, `capFrac = max(0, (1 − 0.6·erFlood)·(1 − 0.25·floodTotal))` (L2240–2247); thrust `= clamp((spoolSpeed − forwardSpeed)·0.35 + 0.039·spoolSpeed)` — the `0.039·ordered` feed-forward is what makes the ship settle **on** the ordered speed; rudder slews `rudderSlew·dt` toward target; `maxSpeed = stage.speed · (1 − 0.33·rudder²) · speedFactor` (turn drag); `wavePush` added to the current; `turnSlow = 1 − floodTotal·0.4`. `propulsionDead(s)` L2235: Engine Room compartment[4] flood ≥ 0.9 → telegraph locked at ALL STOP (index 5) with a toast.
- `setTelegraph(i)` / `stepTelegraph(dir)` L2249–2261: the notch goes to **every driven ship together**; dead ships keep ALL STOP.

### 4b. INDV / FLEET / ANCHOR modes — L2177–2188, L2233

- `drivenShips()` L2182: ANCHOR → all alive ships **except** the selected one; INDV/FLEET → the selected ship only (in FLEET the rest follow via the escort controller). **A mode switch only changes which ships the helm drives — it never re-derives slots, computes a target heading, or snaps a telegraph or rudder** (v11.44 fix for the fleet swinging to align on switch).
- `switchShip(idx)` L2281–2301: clears the waypoint, `rederiveSlots(next)`, new flagship inherits the old telegraph, `spoolSpeed = forwardSpeed`, `rudderDeg = motion.rudder·35` (no lurch, no momentum touch).

### 4c. Formation slots + `rederiveSlots` — L2107–2108, L2269–2280

- `FORM` L2107: C (CRUISING): carrier `[0,0]`, carrier2 `[0,310]`, bb1 `[−140,−155]`, bb2 `[140,−155]`, dd1 `[−240,−310]`, dd2 `[240,−310]`, dd3 `[−240,−70]`, dd4 `[240,−70]`; A (ATTACK): carrier `[0,0]`, carrier2 `[0,400]`, bb1 `[−400,−200]`, bb2 `[−400,−400]`, dd1 `[−350,50]`, dd2 `[−150,150]`, dd3 `[−450,200]`, dd4 `[−250,250]`. Slots are `(dx, dz)` in the flagship frame: dx = starboard, dz = **astern** (negative = ahead). Min centre separation ~92 (C) after the 2× scale-up.
- `rederiveSlots(newFlag)` L2269: recomputes every alive ship's slot from its **current** position relative to the new flagship: `dx = ox·cos(h) + oz·sin(h)`, `dz = −ox·sin(h) + oz·cos(h)`. Called on command transfer and on flagship loss — this is what stops the old 40–65-unit teleport scramble. `applyForm(m)` L2108 sets slots from `FORM`.
- **V1 note:** slots are 2-D. A flying formation needs a third slot coordinate (altitude offset per hull) — add `dy` to the slot and rotate only (dx, dz) by heading.

### 4d. Escort controller — L3649–3860 (FLEET mode only)

- Slot target rotated by flagship heading: `tx = flag.x + dx·c − dz·sn`, `tz = flag.z + dx·sn + dz·c`.
- **Flagship keep-out box:** `keepAhead = (fLen+eLen)/2 + 18`, `keepAstern = … + 8`, `keepWid = (fWid+eWid)/2 + 8`; if inside, shift the Arrive target laterally clear by `keepWid − |side| + 5`, and if ahead of the flagship also fall back astern by `keepLen − ahead + 5`.
- **Separation:** live neighbours within **120** push the target away by `(120 − sd)·0.6`. Radius sits just inside the design minimum centre distance (~131) so it never fights the formation on-station. Sinking wrecks do **not** separate — they are whisker obstacles instead.
- **Speed:** `desSpeed = state.speed + clamp(ag·0.1, ±2)` (v11.36: mirror the flagship + bounded catch-up; the old +5 boost charged escorts through the formation). **Traffic cap:** if another hull (alive, or sinking with `sinkT < 1`) is within 31 units, `trafficCap = min(max(1, hullGap))` when `hullGap < 14` off-slot (`distToSlot > 6`) / `< 8` on-slot; `desSpeed = min(desSpeed, trafficCap)`.
- **Heading (Nicholas's v11.15 rule):** the escort takes its bearing from the flagship's heading and corrects independently: `desHeading = flag.heading + clamp(slotBrg − flag.heading, ±20°)`; pure `flag.heading` when `distToSlot < 6`. `rudderIn = clamp(dh·1.5)`; softened ×0.7 when `distToSlot < 25` or reforming (`steadyT >= 3` and `distToSlot > 25`).
- **Whiskers:** skipped on-slot (`distToSlot < 12`); otherwise `avoid(obstacles, 34)` with obstacle radius `max(wid·1.5, len·0.25) + 4` (beam-based, not length — the v10.7 length-based radius steered escorts from spawn); centre-blocked → thrust ≤ 0.15. Astern: rudder negated.
- **Thrust:** holding (`state.speed < 1`): telegraph ALL STOP → thrust 0, rudder 0 (drift with the current — the v11.8 active hold caused collisions); else `thrust = clamp((desSpeed − vF)/2)`, settled cut (`dist < 1.5` and `|vF| < 0.5` → 0). Underway: `thrust = clamp((desSpeed − vF)/5)` — **braking allowed** (the old [0,1] clamp let escorts run into ships ahead on coast-down). `maxSpeed = max(6, state.speed + 2)`; `turnFloor` when `distToSlot > 25` and flagship slow.
- **Collisions** (L3860+): hulls are 3 circles along the length; damage scales with closing speed, lighter ship takes more; per-pair cooldown; mass carrier 10 / battleship 5 / destroyer 2. Sinking wrecks are tangible until `sinkT >= 1`.

### 4e. Waypoint autopilot — L2190–2198, L2952–2990, L3603–3615, L7509

- `fleetWaypoint = {x, z} | null` (L2955); `setFleetWaypoint(x, z)` L2971 (minimap click, L7509; radar click also sets the air waypoint); `clearFleetWaypoint()` L2980. Cleared on command transfer, on flagship loss, and on new round.
- `wpRudderFor(s)` L2190: heading error to waypoint × 1.5 (deg per deg), clamped ±`RUDDER_MAX`. Routing (L3603–3615): manual rudder input cancels the waypoint at once; arrival within 30 clears it; otherwise driven ships steer by `wpRudderFor`. Marker bobs at `waveHeight·0.5 + 3` (L3645).
- **V1 note:** the waypoint is 2-D. For flying carriers add an altitude component or keep waypoints horizontal-only (altitude stays on the lift layer).

---

## 5. Camera

### 5a. Input handling — `hurricane-fleet/index.html` L2585–2680

- Pointer model on the canvas (`touch-action: none`): **right-drag** = free-look (`freeLook ±0.6`, `+= movementX·0.003`, decays `dt·1.2` when inactive); **left-drag** = orbit (`state.orbitDrag`); **two fingers** = pinch (cancels orbit on second-finger landing); **Shift+drag** = pan the look target; **wheel** = zoom; `contextmenu` prevented; `pointercancel`/`blur` unlatch everything (a latched orbit keeps swinging after release).
- Orbit: `camOrbitAz −= dx·0.005` (unclamped azimuth), `camOrbitEl = clamp(−0.15..0.6, camOrbitEl − dy·0.005)`. Pan: `camPanX += dx·0.05` (clamp ±30), `camPanY −= dy·0.05` (clamp −12..18). Zoom: pinch `camZoom ·= pinchDist/d`, wheel `camZoom += deltaY·0.0006`, range **[0.35, 2.5]**, default 1. `saveCamera()` persists zoom/pan to `localStorage`; `resetCamera()` L2675: zoom 1, pan 0, freeLook 0, `camZfMul 1`, orbit az/el 0, ends sinking-ship follow and tactical track.
- **This is a chase camera with orbit offsets, not a free orbit** — the position is always derived from the anchor + chase heading. For v1's free orbit, use Pandora's helpers (§5c) and keep this input layer.

### 5b. `updateCamera` + `TacticalCameraSystem` — L4652–4830, L7696–7833

- `updateCamera(dt)` L4652: anchor = flagship, or `state.camFollowShip` if set (sinking ship, ends at `sinkT >= 1`, R, or clicking the flagship's row — L2499, L3122–3126, L4656–4664). **Watching a sinking ship frames her at the user's zoom** — the fleet-fit pull-back is skipped (L4725), or the distant fleet shrinks her out of frame.
- Base distance by aspect: portrait `camZ0 80 / camY0 26`, mid `70 / 22`, wide `60 / 19`; `camZ = camZ0·camZoom`, `camY = camY0·(0.85 + 0.3·camZoom)`. `camHeading` chases the flagship heading at rate 7.0 (stays dead behind the stern). Orbit basis from `camHeading + camOrbitAz`; elevation `tan(orbEl)·distance`.
- **Fleet fit:** tests actual ship corners against the real frustum (`fleetFits`, half-angles × 0.88 minus turn-lag allowance `min(0.35, |headingRate|/2)`), pulls back ×1.15 per iteration, max 22 iterations, cap `camZ·20` (v11.51: 8-ship formation is 620 deep CRUISING / 800 ATTACK; the old 12-iteration loop could only reach 5.35×). `fitMul` snaps out, eases in at `dt·5`; forced to 1 when `camZoom < 1` (a deliberate close zoom accepts cropping).
- **Dive camera (U):** `diveBlend` eases `dt·2.5`; dive distance `len/2 + 10 + (camZoom−0.35)/2.15·50`, dive Y `seaH − 5` clamped `seaH−12..−2`; same orbit basis works underwater.
- **Stiff follow:** along-track `kA = 1−exp(−dt·(5.5 turning / 7.5))`, lateral `kL = 1−exp(−dt·(5.0 / 6.5))`, vertical rate 4. Look target `lookAhead = 16 + speedN·8` ahead; bank `−rudder·0.03·speedN`, eased `dt·3`. Sun glow + clouds re-centre on the flagship each frame.
- `TacticalCameraSystem` L7696–7833: modes `null | jet | ordnance | hold`. **C** cycles jets → ordnance → off; Esc/R cancels. Jet cam: off the wingtip (`+rx·10 − fx·14`, `+4`, look `+fx·25`). Ordnance cam: 14 behind/above along velocity (torpedo: y = 10, looking down). `noteDetonation` within 120 → 2.5 s hold at `(+25, +16, +30)` from the blast. `targetValid()` per kind; a crashed jet stays tracked through its flaming dive. `trackTarget(dt)` returns `{x,y,z, lx,ly,lz}` or null; `updateCamera` applies it before the stiff follow, so the return to the fleet eases gently.

### 5c. Pandora `OrbitCamera.ts` (191 lines, pure helpers — lift verbatim)

- `orbitCameraPosition(target, {yaw, pitch}, dist)` — yaw 0 = south of target (+Z), positive yaw → +X; pitch clamped by the caller to **−0.1…1.2**.
- `applyCameraFloor(pos, target, groundHeightAt)` — raise to clear ground under the camera (+3 m), under the midpoint to the target (+5 m), and never below `target.y + 2`.
- `applyDeckCeiling(pos, deckTopY)` / `CARRIER_DECK_CAMERA_CEILING_M = 4.0`, `CARRIER_DECK_CAMERA_FLOOR_M = 3.0` — while the target is on a deck, the camera stays under the overhead sheet (measured: `detail_0` slab at deckTop +4.7…+6.6 m blocks every 30 m sightline from above; island_6 at deck +9.4…+38 m blocks the north side). Off-deck (`deckTopY = null`) it is the identity.
- `deckChaseCameraPosition(jetPos, fwd, up, dist, deckTopY)` — behind by `dist`, up `0.34·dist`, clamped to deckTop +3…+4.
- `chaseCameraPosition(...)` — deck chase + terrain floor (+6 under camera, +8 midpoint, target +2), then deck ceiling; the single source of truth for the chase target (snap on respawn — the v4.8 live finding was a side-on below-ground view after restart because the lerp path ran through terrain).
- `deckOrbitYaw(carrierYaw) = carrierYaw + π` — default orbit sits **astern on the deck centreline**; the fore/aft centreline is the only clear corridor (probe yaw sweep: 6/16 clear, all within ±0.4 rad of the carrier axis).
- `orbitCameraPositionDeckAware(target, angles, dist, groundHeightAt, deckTopY)` — floor first, then ceiling; on a deck they never fight.
- **V1 adaptation:** `groundHeightAt` becomes the sea (`getOceanDataAt().height`) for the floor, and `deckTopY` becomes the flying helicarrier's live deck altitude (pos.y + deckLocalY). The 4.0 m deck ceiling is in Pandora metres; scale it to the new game's units (or keep metres if the new game is 1 unit = 1 m).

---

## 6. Helicarrier (Pandora)

### 6a. `HelicarrierController.ts` — 1,423 lines, `src/entities/HelicarrierController.ts`

**Constants (L28–132):**

| Constant | Value | Notes |
|---|---|---|
| `SHIELD_DECK_TOP_Y` | **29.78** (m, source coords) | Deck top in the SHIELD GLB. |
| `SHIELD_CENTER_Y` | 35.06 | BBox centre Y. `deckLocalY = (29.78 − 35.06)·scale = −5.28` m in group coords. |
| `FALLBACK_DECK_LOCAL_Y` | `(1.28 − 2.8)·(333/52.9)` ≈ −9.56 | Procedural Ford fallback hull only. |
| `DECK_HALF_X / DECK_HALF_Z` | 32 / 150 | Fallback deck footprint (Ford 64 × 300 m). |
| `CARRIER_SPEED` | **40 m/s** | Fixed cruise speed. |
| `CARRIER_ALT` | **350 m** | Cruise altitude — matches the v1 target band (300–600 units if 1 unit = 1 m). |
| `CARRIER_START_POS` | (−1000, 350, −1200) | On the entry leg into waypoint 0, 600 m off Alpha's centreline. |
| `CARRIER_WAYPOINTS` | 6 points | One shared ~3000 m hexagon: (2800,350,−1200), (800,350,1800), (−1500,350,2600), (−3000,350,0), (−1200,350,−1000), (1500,350,−2600). |
| `carrierLoop(slot)` L97–111 | phase offsets | 3 carriers share the loop, offset ~⅓ lap (~5383 m) so they never overlap. |
| `POD_POSITIONS` (fallback) | (±40, −4, ±70) | Procedural pods only; SHIELD pods come from the GLB. |
| `WIRE_Z` | [−60, −75, −90] | Arresting wires, local z, stern deck. |
| `VTOL_PADS` | [(0,60), (0,110)], r 16 m | Bow section, forward of the island (ends local z +20). |

**Load / scale / orientation (L230, L264–280, L390–500):** `loadGLB(uri)` L230 (GLTFLoader + MeshoptDecoder, 9 s timeout in `FlightPhysicsController` L191); `normalizeModel(obj, 333, 0)` L264: `inner.rotation.y = noseRotY` (**0 — bow +Z already**), centre subtracted, `scale = 333 / size.z`, uniform scale. `build()` L390: loads `options.modelGlbUri`, normalises to 333 m. **Critical fixes in `build()` — copy them:** hide the `detail_0` and `detail_7` slabs (giant flat interior shells: detail_0 top Y ≈ 35.4, 5.6 m above the deck, first hit on 64% of the stern deck; detail_7 top Y ≈ 30.25, full-length); `deck_top_*` materials → `DoubleSide` (plates are wound face-down), map rotated +90° (`rotation = π/2`, centre 0.5,0.5), colour reset to white (`baseColorFactor` 0.169 made them ~6× too dark), `polygonOffset −2`, geometry lifted +0.15 m. Deck rects from the model (`deckRectsFromModel` L584): **two rects — wide stern 71.7 m, narrow bow 48.1 m**; visual plates at `deckLocalY + 0.2`.

**Pods (L612–752, `buildShieldPods`):** the four `duct_ring_*` meshes define pod centres; each pod's `rotor_disc_*` / `rotor_hub_*` / `pod_housing_*` meshes are grouped to the nearest ring. Each pod: **`hp 100`**, `alive`, `disc` (spin axis), `meshes[]`. Discs spin `+= dt·22`. Procedural fallback pods (L778–800): cylinder r 6 h 16 + disc, `POD_POSITIONS`, `spinAxis 'z'`. `damagePod(index, amount)` L1402–1423: `hp −= amount`; ≤ 0 → `alive = false`, meshes hidden, `onPodDestroyed(index, worldPos)` fired (game manager spawns smoke/fire FX — the FX lives in the G6 module, not here).

**Lift / list rules (`update`, L985–1105):** `lift = alivePods / 4` (empty `podList` reads as 1 — build guard, L1000–1003, so an unbuilt carrier doesn't die instantly). **Each lost pod: −25% lift, +7° list target** — `list = lerp(list, (1−lift)·0.12, dt·0.5)` (0.12 rad ≈ 7°). `lift < 0.6` → slow sink `(0.6 − lift)·6` m/s. Waypoint steering: `yawRate = clamp(dy·0.5, ±0.12)` rad/s, advance waypoint within 120 m. Terrain-following: `groundAhead(2500)` sampled every 200 m; `targetY = max(350, ahead + 150)`; climb **+15 / −10 m/s**, vertical acceleration ramped at **5 m/s²** via `vySmooth` (a 25 m/s reversal used to sink deck-riding jets 0.58 m into the deck). Terrain death: `pos.y < groundY + 10` after a 5 s post-reset grace → `alive = false`, `onCarrierDown`. Group rotation is `(0, yaw, list)` — no pitch.

**Dying behaviour (`updateDying`, L1105–1207):** entered when `lift <= 0.01` (all pods dead). Yaw rate decays to 0 (`lerp dt·0.5`), drifts straight ahead at 40 m/s; list → **0.5 rad (~28°)** (`lerp dt·0.4`); sink rate `min(2 + dyingT·2, 25)` m/s (**scripted, NOT gravity**); ground contact at `pos.y <= groundY + 20` → `impactDone`, wreck rests at `groundY + 5`, list 0.6, `onCarrierImpact(pos)`; `wreckT >= 10` s → `alive = false`, `onCarrierDown`. After impact `deckHeightAt → −Infinity` (wreck deck not landable). **V1 must replace this:** freefall under gravity from 300–600 units, breakup checks during the fall, then impact splash + Hurricane sinking sequence — do not port the scripted sink as-is.

**DeckProvider interface (`FlightPhysicsController.ts` L293–330; adapter `main.ts` L456–500):** `alive`, `deckTopY?`, `deckHeightAt(x, z)` (−Infinity when not over the deck / dead / impact-done), `velocity()` (deck-centre linear velocity), `velocityAt(x, z)` (**linear + yawRate × r** — a jet 120 m aft sees up to 14 m/s sideways deck motion at 0.12 rad/s; linear velocity alone leaves it behind), `yawRate()`, `yawRateAt(x, z)` (per-carrier — the single `yawRate()` can't say which carrier the jet is on), `local(x, z)` (carrier-local coords or null). The `main.ts` adapter resolves the carrier under the queried point (`carrierAt`) and takes the best `deckHeightAt` / max `deckTopY` across live carriers. `deckHeightAt` impl (L1207–1216): `carrierLocal` → `deckContains(l.x, l.z)` → `pos.y + deckLocalY`. `localPosition` (L1229) null-checks bounds. `tryTrap` (L1307+): hook down + touchdown in wire zone (local z −45…−105, |x| < 26) under 72 m/s catches; ≥ 72 m/s snaps the wire; releases under 2 m/s. Kinematic deck body: `syncDeckBody` uses `setNextKinematicTranslation/Rotation` (Rapier derives velocity from the displacement — `setTranslation` teleports with zero velocity and the deck stops lifting jets); `teleportDeckBody` for resets. Deck collider boxes: one per deck rect, top exactly at `deckLocalY`, extending 10 m down (L834–861).
- **Known open issues (memory, 2026-11-24):** helicarriers 2/3 visuals wrong; Ford deck markings have a seam between sections; HUD compass mirrored (deferred). VTOL deck liftoff/hover/transition **failed** the v4.9 live check; v4.10 claims fixes but the live check was still running — do not treat VTOL as settled.

### 6b. GLB scale / orientation summary

| Model | File | Size / tris | Load | Orientation | Scale |
|---|---|---|---|---|---|
| SHIELD helicarrier | `src/assets/models/helicarrier.ts` (base64, header L1–9) | 631,132 B, 21,247 tris, CC BY-NC 4.0 (Printables roboticide) | `HelicarrierController.build()` via `loadGLB` + `normalizeModel(obj, 333, 0)` | Bow **+Z**, no Y rotation | `333 / bbox.z`, uniform; deck top 29.78, centre Y 35.06 |
| F-18 (Pandora) | `src/assets/models/fa18.ts` | 234,512 B, 17,517 tris | `FlightPhysicsController.attachModel()` (§7) | Nose +Z (`NOSE_ROT_Y['fa18'] = 0`) | `spec.length 18.79 / bbox`, 1 unit = 1 m |

**Orientation gotcha:** Hurricane's world is bow **−Z** (jet `rot [-1,0,0, 0,1,0, 0,0,-1]` = 180° Y flip); Pandora's helicarrier is bow **+Z** with no flip. If the new game uses Hurricane's −Z convention, rotate the SHIELD model π about Y on load (or adopt Pandora's +Z convention for carriers and flip the jets instead — pick one and be consistent; `carrierLocal`/`deckContains`/`patPt` all assume the carrier's own forward).

---

## 7. F-18 GLB usage

### 7a. Hurricane Fleet — inline base64, `MODEL_SPEC.jet` L2018, `fitModel` L2043–2075, loader L2020–2042

- `jet: {uri: JET_GLB, len: 16, wid: 11.4, waterline: 0, rot: [-1,0,0, 0,1,0, 0,0,-1]}` — 18.79 m real jet at **16 units** (shrunk vs the 2× ships; carrier:jet ≈ 10.9:1, real Nimitz:F-18 ≈ 18:1). Nose +Z in the GLB, so the same 180° Y flip as the +Z-bow enemy ships. `waterline 0`: the jet's origin is its belly, which sits on the deck.
- Loader: `GLTFLoader` + `MeshoptDecoder` (dynamic `three/addons` import), `loader.parseAsync(dataUriToBuf(uri))` once at startup into `MODEL_CACHE`, cloned per ship via `fitModel` (rot matrix → bbox → `scale = len/size.z` → `position.set(−ctr.x·scale, −waterline·scale, −ctr.z·scale)`; `wrap.userData.len/wid` set). **Do not** load the base64 inline again — the liftable copy is Pandora's `fa18.ts`.
- `FighterJetEntity.buildModel()` L5873–5892: `fitModel('jet')`, else a procedural fallback (cylinder fuselage, cone nose, box wings; `len 19, wid 13`; material `0x8a97a3`, metalness 0.6). `gearNode = group.getObjectByName('Gear')` L5889; `gearNode.visible = gearDown`. `syncGear()` L6297–6310: down on deck/catapult/taxi/rearm/trap (and rtb once `patLeg >= 1`); up in flight; frozen in crash states. **V1 note:** the 'Gear' node is nose + 2 mains cut out of the airframe (v11.42) — visibility toggle only, no animation; gear does not extend/retract progressively.
- Per-jet visuals (§3c): damaged smoke (hp < 50), flame (hp < 25), buffet wingtip puffs (±5.7, every 0.2 s), pullout flares, catapult steam. No afterburner, no contrails, no nav lights on jets.

### 7b. Pandora — `fa18.ts` + `FlightPhysicsController.attachModel()` L1149–1230 + `AircraftSpec.ts` L208–270, L532–543

- `fa18.ts` header: **234,512 B, 17,517 tris, sha256 `cf7b1f0c…`**, source = Hurricane v2 `JET_GLB`. Same model, liftable as a data URI; loaded with `GLTFLoader` + `MeshoptDecoder` (`loadGLB`, L464). Template cached per `modelKey` and cloned per aircraft (materials cloned too, so per-jet tinting never mutates the template); procedural `proceduralJet()` fallback on load failure.
- `attachModel()`: `helmet002` (pilot) hidden; `normalizeAircraft(scene3, targetLen = spec.length, NOSE_ROT_Y['fa18'] = 0, bellyAlign)`; then `separateIncludedGear(group, spec.includedGear)` — the GLB's own gear is cut into named gear groups the rig binds and animates (v11.42-equivalent, but animated via `AircraftRigBindings`).
- `SPECS.fa18` (L208–270): mass 20,242 kg, fuel 6,354 kg, wingArea 46.5 m², span 13.62 m, **length 18.79 m**, thrustMax 196,000 N, `stallSpeed 66`, `rotateSpeedKt 140`, CL curve (linearEndAoA 15° / CL 1.35, peak 1.6 @ 35°, floor 0.8, postSlope 0.05, cdSep 0.35), maxG 9, `tailhook true`, `vtol false`, tint `0x8a97a3`, `carrier true`, gunRpm 6000, `bombs true`. BET-measured stall: **F-18 130 kt** (stock-take; curve solver is the verified fallback, `useBet: false`).
- **Gear stations (measured on the raw GLB, diag-glb 2026-11-20):** nose twin wheels at (x ±0.29, **z +3.57**), mains at (x ±1.55, z −2.26); wheel bottoms at raw y −0.01/0.00, 1.36 m below the belly (raw y 1.35). `bellyAlign: {rawY 1.35, targetY −0.84}` puts wheel bottoms exactly on the physics gear feet (−2.2 m). `includedGear` volumes: nose `{x −0.8..0.8, z 2.8..4.4, capY −1.0}`, mains `{x ±0.9..2.2, z −3.1..−1.6, capY −1.25}`. `gearPosts: {noseZ: 3.57}` — the formula put it at +6.58, 3.0 m ahead of the visible wheels (pass-12 fix). **Open (memory):** physics gear posts not moved to the model's stations for other types; F-35A headrest/helmet tops above the fuselage (no canopy).
- **Reuse decision:** use Pandora's `fa18.ts` (file, not Hurricane's inline base64) at 1 unit = 1 m if the new game is metric, or through Hurricane's `fitModel` (len 16) if it keeps Hurricane units. Either way, keep the 'Gear' node handling and the `bellyAlign`/gear-station numbers — the wheel-bottom alignment is what stops jets floating or sinking into the deck.

---

## Builder cautions — top 5 things NOT to copy blindly

1. **The wingman bomb dive (§3f).** Frozen `diveAimPt` (stale target), release at sea+40 through the leader's `dj <= 45` gate (~15 units long by ballistics), and a 2 s hold that overshoots the target before the dive starts. The leader's numbers are a tuned set (release 45 out / sea+30 at 80 u/s, 30°); re-derive both jets' release geometry from `AirBomb` ballistics and probe it (20 drops/jet, stationary target) before trusting it.
2. **The scripted sinking (§2f, §6a).** Hurricane's sink is a fixed 30 s quadratic wallow (`y = motion.y·0.75 − f²·20`); Pandora's dying carrier is a scripted sink at `min(2 + 2t, 25)` m/s that beaches on terrain. Neither is freefall. A destroyed helicarrier must fall under gravity with a terminal velocity, break-up checks during the fall, and only then the impact splash + sinking sequence.
3. **Hard-coded fleet size 8 (§1b, §3g).** `uShips[8]`/`uShipSize[8]` are baked into the GLSL and the JS update loop; the air-wing code reads global `fleet`/`enemies`/`jets` arrays. Parameterise the ship count (1–4 per side) and the wing's target arrays before cloning the wing for the enemy side, or the second wing will fight the first over shared globals.
4. **One fire, one scalar HP, 2-D everything (§2b, §4).** Hurricane ships have a single `fire` scalar (latest hit only), scalar `hp`, 6 flat compartments, and a purely 2-D formation/steering model. A helicarrier needs per-zone fires/HP (pods/reactor/magazine/bridge/deck/engines), a 3-D formation slot (add `dy`), and a vertical lift layer on top of `ShipMotion` — do not stretch the 2-D code to cover altitude.
5. **Scale and orientation mismatches (§1, §6b, §7).** Hurricane is 1 unit ≈ 5.74 m with bow −Z and jets at 16 units; Pandora is 1 unit = 1 m with the helicarrier bow +Z and the F-18 at 18.79 m. Pick one scale and one forward convention for the new game and convert every constant that crosses the boundary (speeds, `JET_MAX_ALT` 120, deck ceiling 4.0 m, `CARRIER_DECK_Y` 10.34, catapult/trap altitudes) — a silent unit mix-up here shows up as jets that can't reach the deck or carriers that fly through the sea.

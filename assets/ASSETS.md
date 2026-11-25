# Helicarriers at Sea — GLB Assets

Decoded 2026-11-24 from the Pandora Planes Vite project. Both files are
self-contained binary glTF (no external `.bin` or texture files).

> Update 2026-11-25 (v1.4.0): the helicarrier model was replaced with
> Nicholas's own STL (`Helicarrier_-_Full_Model_0_boii.stl`, same
> Printables "roboticide" source family as the old model, but the full
> 169,723-triangle file instead of the old 21,247-triangle decimation).
> Converted by `/tmp/stl-convert/convert.mjs` (three.js + meshoptimizer):
> spatial clustering split the triangle soup into 24 components, the
> visible flight deck was re-extracted (up-facing tris at deck height),
> Ford colours were applied from the old GLB's exact material values,
> the Ford deck texture was re-injected, and the result was
> meshopt-compressed with `gltf-transform meshopt` ONLY (the `optimize`
> path joins meshes by material and destroys the per-fan rotor meshes).
> The new `helicarrier.b64.js` is 357,198 chars (was 842,018); the game
> tree drops from ~2.97 MB to ~2.48 MB. The old model's numbers below
> are kept for reference; the live model is the v1.4.0 one.

## Files

| File | Size | SHA-256 (first 16 hex) | GLB version |
| --- | --- | --- | --- |
| `helicarrier.glb` (v1.4.0) | 267,644 B | `3b112d5288fbad7d…` | 2.0 |
| `helicarrier.glb` (v1.3.0, retired) | 631,132 B | `84a31e2837f4ca20…` | 2.0 |
| `fa18.glb` | 234,512 B | `cf7b1f0cb8b1d08b…` | 2.0 |

Full SHA-256:
- helicarrier (v1.4.0): `3b112d5288fbad7d8b330fe34c56d97a2e943962b80cbacf66117e1c2b4d1913`
- helicarrier (v1.3.0): `84a31e2837f4ca20d572a8c6d2986c8f7f2f798978c69675a2c0a5bfd76d30f3`
- fa18: `cf7b1f0cb8b1d08bb327231fb7905f97e119a338d002b9e13efb8db9abf8c22a`

## Sources

- `helicarrier.glb` (v1.4.0) ← `~/workspace/user/files/Helicarrier_-_Full_Model_0_boii.stl`
  (Printables, user "roboticide", SHIELD helicarrier; binary STL, Rhino
  Aug 2015, 8,486,234 B, 169,723 triangles, single triangle soup, no
  groups/UVs/textures). Conversion (`/tmp/stl-convert/convert.mjs`,
  three 0.160.0 + meshoptimizer 0.20.0): components found by
  vertex-welded spatial clustering (24 components); the model was
  re-centred and re-oriented (length along Z, bow −Z, up Y) and scaled
  to 333 m (×1.101786); per-component simplification with meshopt
  `simplify` + `LockBorder` (fans 0.2/0.1, island 0.3, hull 0.15/0.2,
  deck 0.12/0.2); smooth normals; planar UVs on the deck strip; Ford
  colours from the v1.3.0 GLB's exact material values; the Ford deck
  JPEG re-injected by `/tmp/stl-convert/inject-deck-texture.py`;
  meshopt-compressed (`gltf-transform meshopt`, 1.08 MB → 268 KB).
  169,723 → **35,667 tris**, 26 meshes. Deck: flat at the bow (game Y
  −4.65), ramp to +0.86 over z −38…+6, flat at the stern; centreline
  trench (x −12…+5, z −115…+6) closed in-game by an infill strip.
  Fans: four separate shells (~3.4k tris each) at (±54, −6.6, −50.5)
  and (±62, −6.6, +80.3), radius ~19 m — they ARE the rotors and spin
  in place. Island: comp 4, a wedge (x 9.2…31.9, y 5.3…33.9,
  z 46.6…98.2) rising toward the stern.
- `helicarrier.glb` (v1.3.0, retired) ← `~/workspace/pandora-planes-vite/src/assets/models/helicarrier.ts`
  (`HELICARRIER_GLB`, data-URI `data:model/gltf-binary;base64,…`).
  Original source per the file header: `~/workspace/user/files/Helicarrier_-_Full_Model.stl`
  (Printables, user "roboticide", SHIELD helicarrier), decimated, interior
  stripped, Ford look applied (colours sampled from the Gerald Ford GLB
  atlas; deck texture is a crop of the Ford atlas's flight-deck strip).
- `fa18.glb` ← `~/workspace/pandora-planes-vite/src/assets/models/fa18.ts`
  (`FA18_GLB`, same data-URI form). Original source per the file header:
  the v2 `index.html` `JET_GLB` (Hurricane Fleet embeds the same model;
  the Pandora copy was used, as instructed).

## Decode method

Python 3, no extra dependencies: regex-extract the single-quoted base64
payload after `export const <VAR> = 'data:model/gltf-binary;base64,` in
each `.ts` file, `base64.b64decode(..., validate=True)`, write the bytes
verbatim. No re-encoding, no re-export — the decoded bytes match the sizes
and SHA-256 prefixes recorded in the source files' own headers exactly.

## Validation (python3 `struct` + `json` parse of the GLB header)

- Both files start with the `glTF` magic, version 2, and the header's total
  length field equals the actual file size.
- helicarrier (v1.4.0): JSON chunk 18,520 B; 26 nodes / 26 meshes;
  triangle count recomputed from the index accessors: **35,667**.
  **Meshopt-compressed — loader must support `EXT_meshopt_compression`
  and `KHR_mesh_quantization`** (both in `extensionsRequired`); the
  loader already has MeshoptDecoder wired (as for the F-18). Plain
  (uncompressed) geometry, `POSITION` + `NORMAL` on every primitive;
  only `deck_top` also carries `TEXCOORD_0` (planar UVs for the Ford
  deck texture). One embedded JPEG texture (56,619 B) on the `FordDeck`
  material. Do NOT run `gltf-transform optimize` on this file: it joins
  meshes by material (26 → 3) and destroys the per-fan `rotorSpin_*`
  meshes the game spins.
- helicarrier (v1.3.0, retired): JSON chunk 43,744 B + BIN chunk 587,360 B;
  1 buffer (532,784 B, no `uri` — embedded). Triangle count recomputed
  from the index accessors: **21,247** — matches the source header.
- fa18: JSON chunk 8,596 B + BIN chunk 225,888 B; triangle count recomputed:
  **17,517** — matches the source header.
- No Draco compression in any file.

## Helicarrier (v1.4.0) — structure

- Generator: three.js GLTFExporter 0.160.0 + glTF-Transform meshopt.
  Extensions used and required: `KHR_mesh_quantization`,
  `EXT_meshopt_compression`.
- Self-contained: embedded buffers, no external references.
- 26 nodes / 26 meshes, all flat top-level scene nodes (no hierarchy).
  Pre-normalised: 333 m long (Z), centred, bow −Z, deck up (+Y) — the
  game does not rescale or rotate it. Groups by name prefix: `hull_*`
  (17), `rotorSpin_*` (4, the STL fans), `deck_top` (1, textured runway
  strip), `deck_outer` (1, pod/side decks), `island_6` (1).
- Full node/mesh list: `deck_outer, deck_top, hull_0, hull_1, hull_2,
  hull_3, hull_5, hull_6, hull_7, hull_8, hull_9, hull_10, hull_15,
  hull_16, hull_17, hull_18, hull_19, hull_20, hull_21, hull_22,
  hull_23, island_6, rotorSpin_0, rotorSpin_1, rotorSpin_2, rotorSpin_3`.
  (Component numbers are the STL spatial-clustering labels; 4, 11–14
  are the island and fans, the rest are hull pieces. `hull_1/9/10` are
  the duct walls/lips above the fans, in Ford pod grey.)
- Biggest meshes: `hull_16` (3,712 tris), `rotorSpin_3` (3,484),
  `rotorSpin_0` (3,444), `rotorSpin_1` (3,412), `rotorSpin_2` (3,394),
  `deck_top` (2,632).
- Materials (5, all flat colours except the deck): `FordHullGrey`,
  `FordPodGrey`, `FordIslandGrey`, `RotorDark`, `FordDeck` (exact
  colour values from the v1.3.0 GLB's materials).
- One embedded texture: the Ford flight-deck JPEG (56,619 B) used only
  by the `FordDeck` material on `deck_top` (U across the central strip,
  V along the length tiled twice; sampler: S clamp, T repeat). No other
  textures.

## Helicarrier (v1.3.0, retired) — structure

- Generator: trimesh (`https://github.com/mikedh/trimesh`). No extensions
  used or required. Plain (uncompressed) geometry, `POSITION` + `NORMAL`
  on every primitive; only the two deck meshes also carry `TEXCOORD_0`.
- Self-contained: single embedded buffer, no external references.
- 49 nodes / 49 meshes, all flat top-level scene nodes (no hierarchy).
  Groups by name prefix: `detail_*` (25), `duct_ring_*` (4), `hull_*` (4),
  `island_*` (2), `pod_housing_*` (4), `rotor_hub_*` (4), `rotor_disc_*` (4),
  `deck_top_*` (2).
- Full node/mesh list (identical names for node and mesh):
  `detail_0, detail_3, detail_5, detail_7, detail_8, detail_9, detail_16,
  detail_19, detail_22, detail_34, detail_36, detail_37, detail_39,
  detail_40, detail_41, detail_42, detail_43, detail_44, detail_45,
  detail_46, detail_47, detail_48, detail_50, detail_51, detail_52,
  duct_ring_1, duct_ring_12, duct_ring_24, duct_ring_25, hull_2, hull_4,
  hull_35, hull_49, island_6, island_23, pod_housing_11, pod_housing_13,
  pod_housing_14, pod_housing_15, rotor_hub_26, rotor_hub_29, rotor_hub_30,
  rotor_hub_32, rotor_disc_27, rotor_disc_28, rotor_disc_31, rotor_disc_33,
  deck_top_35, deck_top_49`.
- Biggest meshes: `hull_49` (2,757 tris), `hull_2` (2,092), `hull_4`
  (2,094), `pod_housing_11/15` (1,458 each), `deck_top_35` (1,093).
- Materials (8, all flat colours except the deck): `FordDetailGrey`,
  `DuctGunmetal`, `FordHullGrey`, `FordIslandGrey`, `FordPodGrey`,
  `RotorHub`, `RotorDark`, `FordDeck`.
- One embedded texture: a JPEG (56,619 B, bufferView 143) used only by the
  `FordDeck` material on the two `deck_top_*` meshes (the Ford flight-deck
  strip crop). No other textures.

## F-18 — structure

- Generator: glTF-Transform v4.5.1.
- **Meshopt-compressed — loader must support `EXT_meshopt_compression`.**
  `extensionsRequired`: `EXT_meshopt_compression`, `EXT_texture_webp`,
  `KHR_mesh_quantization`. All 13 geometry bufferViews are meshopt
  (`TRIANGLES` index + `ATTRIBUTES`, some `OCTAHEDRAL`-filtered normals).
  In three.js this means `GLTFLoader` + `MeshoptDecoder` (as in Pandora).
- Quirk: a second buffer (372,988 B) is declared as the meshopt
  *fallback* (`fallback: true`) but its bytes are **not** present in the
  file — the BIN chunk (225,888 B) holds only buffer 0. A loader without
  meshopt support therefore cannot fall back to uncompressed geometry;
  it will fail rather than degrade. Keep MeshoptDecoder wired in.
- 5 embedded WebP textures (all in bufferViews 0–4): `weapon_n`
  (1,330 B), `weapon_d` (2,690 B), `FA18F_V3_n` (5,648 B), `FA18F_V3_d`
  (38,960 B), `pilot_d` (9,998 B). No external textures.
- Only 4 nodes / 4 meshes, with generic Blender names — no fuselage/wing
  hierarchy, so per-part animation (e.g. gear, flaps) is not available
  from this file:
  - `Weapon pack` → mesh `Cylinder.023` (4,970 tris)
  - `Canopy` → mesh `Cylinder.104` (252 tris)
  - `ground` → mesh `Cylinder.101` (7,179 tris; the main airframe)
  - `helmet.002` → mesh `Sphere.006` (5,116 tris; pilot helmet/head)
- Materials: `Material`, `Material.001`, `Material.002`, `Material.011`
  (three textured, one flat). Also uses `KHR_materials_ior`,
  `KHR_materials_specular`, `KHR_materials_transmission` (not required).

## License

- **Helicarrier model: CC BY-NC 4.0** (source: Printables, user
  "roboticide"). Attribution is required in the game README, and the model
  may not be used commercially. Suggested credit line:
  "Helicarrier model by roboticide (Printables), CC BY-NC 4.0 — decimated
  and retextured for this game."
- F-18: no license recorded in the source file. Its provenance is the
  Hurricane Fleet / Pandora v2 `JET_GLB`; check before any public or
  commercial release.

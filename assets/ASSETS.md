# Helicarriers at Sea — GLB Assets

Decoded 2026-11-24 from the Pandora Planes Vite project. Both files are
self-contained binary glTF (no external `.bin` or texture files).

> Update 2026-11-24: the binary `.glb` files below were re-encoded as
> base64 JS modules (`helicarrier.b64.js`, `fa18.b64.js`) and the `.glb`
> files removed from the game dir, because the GitHub snapshot-push route
> only accepts UTF-8 text files. The bytes are identical (SHA-256 below
> matches the base64 payloads, verified on conversion); the rest of this
> file still describes the models themselves.

## Files

| File | Size | SHA-256 (first 16 hex) | GLB version |
| --- | --- | --- | --- |
| `helicarrier.glb` | 631,132 B | `84a31e2837f4ca20…` | 2.0 |
| `fa18.glb` | 234,512 B | `cf7b1f0cb8b1d08b…` | 2.0 |

Full SHA-256:
- helicarrier: `84a31e2837f4ca20d572a8c6d2986c8f7f2f798978c69675a2c0a5bfd76d30f3`
- fa18: `cf7b1f0cb8b1d08bb327231fb7905f97e119a338d002b9e13efb8db9abf8c22a`

## Sources

- `helicarrier.glb` ← `~/workspace/pandora-planes-vite/src/assets/models/helicarrier.ts`
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
- helicarrier: JSON chunk 43,744 B + BIN chunk 587,360 B; 1 buffer
  (532,784 B, no `uri` — embedded). Triangle count recomputed from the
  index accessors: **21,247** — matches the source header.
- fa18: JSON chunk 8,596 B + BIN chunk 225,888 B; triangle count recomputed:
  **17,517** — matches the source header.
- No Draco compression in either file.

## Helicarrier — structure

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

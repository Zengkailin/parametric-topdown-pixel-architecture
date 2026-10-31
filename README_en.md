# Parametric 2D Topdown Pixel Architecture (Web App)

A local web tool that renders **parametric 3D buildings** into **2D top-down pixel sprites**.

- 10 built-in architectural styles and 46 building types, with orthographic / perspective views, multi-angle frames, and sprite-sheet export.
- **Pure frontend, zero dependencies, fully offline**: no Godot, no server, just double-click to run.
- A web port of the Godot plugin `addons/hd2d_scene_tools` (v5/v6 recipes), using the same geometry and parameters.

---

## 1. Environment Setup (read this first)

| Who you are | What to install | Notes |
|---|---|---|
| **End user** (just want to render sprites) | **Nothing** | Double-click `index.html`. See "Quick Start" below. |
| **AI agent / automation script** | **Node.js 18+** (no `npm install`) | Drive the same renderer via `node cli/tb.js ...`. See section 7. |
| **Developer** (modify source / run tests / regenerate assets) | Python 3.10+ (with `Pillow`) and/or Node.js 18+ | Only needed for the scripts under `tools/`. See the "Developers" section. |

> Rendering sprites **does not require** Node.js, Python, or any `npm install`. `js/atlases.js` is large (~7.6 MB) because 10 atlases are embedded inline, so the page works from `file://` without a server.

### Browser requirement
Use **Chrome or Edge** (recommended). A few browsers restrict inline data decoding under `file://`; if so, use a local server (see "FAQ").

---

## 2. Quick Start

**Option A: Double-click (easiest)**
1. Download and unzip the whole project folder.
2. Double-click `启动工具.bat` (or `index.html`) to open the tool in your default browser.
3. A window resolution of **1600×1000 or larger** is recommended.

**Option B: Local server (if the page is blank)**
```bat
cd 参数化topdown建筑
python -m http.server 8000
:: Then open http://localhost:8000/ in your browser
```

Once open:
- Pick a **style** and a **building type** on the left; preview updates live on the right.
- Scroll to zoom, drag to pan, double-click to reset the preview.

---

## 3. Basic Usage

1. **Choose style / building**
   - Pick one of 10 built-in styles from the "Style" dropdown (Jiangnan, European, Japanese Machiya, Chinese Palace, Gothic, Steampunk, …).
   - Choose a building type and tweak parameters (width / depth / floors / pitch / windows / roof shape…), or click "Random Building".

2. **Adjust the view**
   - Projection: orthographic (no perspective) or perspective (set FOV).
   - Pitch angle, number of directions (1/2/4/8), canvas size, padding, outlines, background, etc.

3. **Export**
   - "② Export current direction": save a single PNG.
   - "③ Export all directions": a ZIP containing `dir_0.png … dir_N.png`, `sheet.png` (sprite sheet), and `recipe.json` (the full recipe).
   - "Download atlas template": export the current style's 4×4 atlas so an artist can repaint and re-import it.
   - **Since v1.1 every exported PNG embeds its generation parameters** (tool version + full recipe, stored in PNG text chunks with zero pixel impact).
   - "Import image recipe": pick any PNG exported by this tool (web or CLI) and the style, building, seeds, parameters, view, outlines and per-part overrides are restored into the UI; the CLI equivalent is `inspect` / `rec apply` (section 7).

4. **Custom styles (Style Workshop)**
   - Open "Style Workshop" at the top, upload your own 4×4 atlas (or per-role image / palette), and save as a new style.
   - Click any part of the preview to inspect its texture, recolor / replace / outline / reset that part — all written into the recipe.

> All parameters auto-save to the browser `localStorage` and survive a refresh.

---

## 4. Atlas Spec (for custom styles)

- Square PNG, side length divisible by 4; **512 (128px/cell)** or **1024 (256px/cell)** recommended.
- **4×4 = 16 cells, fixed order**:

| Row | Col 1 | Col 2 | Col 3 | Col 4 |
|---|---|---|---|---|
| 1 | `roof` | `wood` | `wall` | `stone` |
| 2 | `trim` | `glass` | `cloth` | `metal` |
| 3 | `shadow` | `accent` | `door` | `window` |
| 4 | `roof_edge` | `wall_base` | `sign` | `shutter` |

- Tiled roles (all except door/window/sign/shutter/wall_base/roof_edge) must tile seamlessly in all 4 directions.
- Use pixel blocks for shading — avoid smooth gradients; transparent pixels show through, so fill the alpha.
- On upload the tool validates: square? divisible by 4? any empty / near-solid cell? — with per-cell hints.

---

## 5. FAQ

**The page is blank / scripts don't run after double-click?**
Use Chrome or Edge, or run `python -m http.server 8000` in the folder and open `http://localhost:8000/`.

**Where are my styles saved?**
In the browser `localStorage`. Switching browsers or clearing data loses them — use "Export all styles" to back up as JSON (atlases included), then "Import style pack" on another machine.

**Why does the pixel art look a bit soft?**
Turn off "Anti-aliasing" and set the canvas size to match your final upscale (e.g. 256 then integer-scale 3×).

**Seeds differ from Godot?**
Geometry/parameters are identical, but the random sequence differs (PCG32 seeding details). To match Godot exactly, rebuild from this tool's exported `recipe.json`.

**Can I batch-render?**
The web UI exports all directions of the current building at once. For batch multi-building use the CLI:

```bat
node cli/tb.js batch jobs.json
```

---

## 6. Project Layout

```
参数化topdown建筑/
├─ index.html              Page skeleton (panels / preview / style workshop)
├─ 启动工具.bat            Opens index.html in the default browser
├─ AGENTS.md               Starter guide for AI agents (read this first)
├─ tb.cmd                  CLI shortcut (= node cli\tb.js, needs Node 18+)
├─ css/app.css             UI styles
├─ js/                     Core logic (geometry / materials / rasterizer / UI)
├─ cli/                    CLI for AI agents / scripts (see section 7)
├─ samples/                Example outputs and UI screenshots
└─ tools/                  Dev self-tests (not needed for normal use, see below)
```

---

## 7. CLI (for AI agents / automation)

Same geometry, materials and rasterizer, exposed as a command line. **Zero dependencies** (Node 18+, no `npm install`).
Full reference: [`cli/README.md`](cli/README.md). Short version:

```bat
:: render (defaults: 512px, pitch 45, single direction, orthographic)
node cli/tb.js render forest inn -o out/inn.png

:: 8 directions + sprite sheet + ZIP + recipe
node cli/tb.js render jiangnan inn -d 8 --sheet --zip -o out/inn8

:: let an agent discover every option and enum at once
node cli/tb.js schema

:: batch in a single process (atlases parsed once)
node cli/tb.js batch jobs.json

:: read back the parameters embedded in an image (on by default since v1.1)
node cli/tb.js inspect out/inn.png

:: use a PNG as a recipe: re-render with the parameters stored inside it
node cli/tb.js rec apply out/inn.png -o out/again
```

Designed for agent use:

- **One-line JSON summary by default** — `version / canvas / dirs / tris / ink / bbox / ms / meta / files`; `ink` and `bbox` tell you at a glance whether the frame is empty or badly cropped. `--quiet` prints paths only, `--thumb` adds a thumbnail.
- **No source reading needed** — `list styles|types|params|roles|enums` and `schema` expose all values and ranges.
- **Short commands** — `render forest inn -o a.png` is enough; save recurring setups with `preset save pixel` and reuse via `--preset pixel`.
- **Reproducible** — `--recipe` accepts the web UI's `recipe.json`; since v1.1 every PNG carries its own recipe, so `inspect` reads it back and `rec apply <png>` replays it (`--save-recipe` writes a JSON the web UI can import).
- **Full feature parity** — multi-direction, sprite sheets, three outline types, per-part tint/texture/outline, custom style pack import/export, atlas validation and templates.
- **Fast** — decoded atlases are cached in `cli/.cache/`, one render takes ~0.4 s; `batch` reuses the same process.

### Embedded image metadata (v1.1)

Every exported PNG (frames, sprite sheets, thumbnails, frames inside ZIPs) carries three PNG text chunks by default. Pixel data is untouched, so any image viewer is unaffected:

| Chunk | Type | Content |
|---|---|---|
| `Software` | tEXt | Producing tool and version |
| `topdown:version` | tEXt | Tool version (e.g. `1.1`) |
| `topdown:recipe` | iTXt | Full recipe JSON (UTF-8, deflate-compressed) |

```bat
node cli/tb.js inspect out/inn.png                    :: version + view/building parameters
node cli/tb.js inspect out/inn.png --full              :: include the full recipe
node cli/tb.js inspect out/inn.png --save-recipe a.json
node cli/tb.js rec apply out/inn.png -o out/again      :: replay from the image
node cli/tb.js render forest inn --no-meta             :: opt out (on by default)
```

- No timestamps are embedded: identical parameters produce a **byte-identical** PNG.
- Per-part textures are large data URLs, so they are stripped to source name, byte count and a `crc32` fingerprint; `inspect` warns about it — re-specify `--part <role>:texture=<file>` to replay exactly.
- Web UI and CLI write the same chunk names and JSON shape, so either side can read the other's output: the web UI's "Import image recipe" button is the equivalent of `inspect` + `rec apply`, and CLI `inspect` reads web exports too (their recipe chunk is stored uncompressed).

### Godot prefab export (v1.2)

The normal PNG pipeline is unchanged. Optionally emit a prefab that drops straight into a Godot project:

```bat
node cli/tb.js render forest inn --size auto --scale fixed --ppm 64 --no-aa ^
  --godot-project D:/YourGodotProject ^
  --godot-texture res://prefab/inn.png ^
  --godot-prefab  res://prefab/inn.tscn ^
  -o out/inn.png
```

Outputs:

- `out/inn.png`: the original full-canvas PNG (unchanged).
- `res://prefab/inn.png`: a **prefab-only** cropped copy (opaque bbox + `--godot-margin`, default 6 px).
- `res://prefab/inn.tscn`: the prefab, built from built-in nodes only.

> The collision/occlusion polygons are computed for that **cropped PNG's** size and origin, so the `.tscn` `ext_resource` must point at the same image; using the old asset (different crop/size) shifts everything. The web ZIP is packaged with the exact `res://` folder structure, so unzip it at the project root.

```
StaticBody2D (collision_layer=1, collision_mask=0)
├─ CollisionPolygon2D   ← foundation footprint (w+0.24 × d+0.24) projected through the current camera
├─ Sprite2D             ← offset puts the world origin (foundation center) at the node origin
└─ 遮挡层 (Area2D)
   └─ CollisionPolygon2D × N ← per-connected-block outer contours of the opaque coverage, minus the collision band, kept only above the base point (foundation center)
```

- No scripts and no `StippleShadow`; wire the collision/occlusion to your own script or the game's `scene_object.gd`.
- At 45° pitch the depth is foreshortened by `sin(45°)` in the 2D plane, matching the sprite base exactly; arbitrary yaw and perspective are supported.
- The prefab uses direction 1 (the current preview direction in the web UI); transparent background required; a degenerate footprint (pitch too low) raises a clear error.
- Web UI: the "Export Godot prefab" button downloads a ZIP with the cropped PNG and the `.tscn`.
- Note: Godot's `CollisionPolygon2D` has no holes. If a foundation band is fully enclosed by opaque pixels, the outer-contour rule keeps it in the occlusion area; that band is blocked by collision anyway and is unreachable.

---

## 8. Developers (optional)

End users can skip this section. These scripts are for maintaining / verifying the source and need the corresponding runtime:

```bat
:: Geometry / render / sampling self-tests (needs Node 18+)
node tools/selftest.js
node tools/test_nearest.js
node tools/test_all_types.js
node tools/test_views.js
node tools/ui_test.js        :: needs local Chrome / Edge

:: CLI end-to-end self-test (needs Node 18+)
node cli/selftest.js

:: Regenerate catalog & atlases from the Godot plugin (needs Python + Pillow)
pip install Pillow
python tools/build_assets.py
:: Optionally point at a plugin directory:
python tools/build_assets.py --addon "<plugin>\addons\hd2d_scene_tools"
```

> Scripts under `tools/` do not participate in rendering; deleting them won't affect normal users.

---

## 9. Open Source & License

- Issues and Pull Requests are welcome. Please run the `tools/` self-tests before submitting to avoid regressions.
- This project is a web port of the Godot plugin `hd2d_scene_tools`, referencing its geometry and parameter spec — please comply with its respective license.
- Atlas assets may involve third-party copyright; confirm licensing before use / distribution.

---

## 10. Changelog

### v1.2 (2026-10-31)

- **Godot prefab export**: `render` gains `--godot-prefab / --godot-texture / --godot-project / --godot-margin / --godot-name`. It uses the same 3D mesh and camera transform to derive a projected foundation collision polygon and per-block outer contours of the opaque coverage minus the collision band, kept only above the base point (foundation center), then writes a built-in-nodes-only `.tscn` (StaticBody2D + CollisionPolygon2D + Sprite2D + Area2D) with no scripts or StippleShadow. A cropped PNG is emitted alongside; the normal PNG pipeline is unchanged. The prefab uses direction 1 (the current preview direction in the web UI).
- **Web UI**: new "Export Godot prefab" button; the ZIP mirrors the entered `res://` folder structure (cropped PNG + `.tscn`).
- Geometry layer exposes `mesh.footprint` (foundation slab size) for the collision layer; rendering output is unaffected.
- Version bumped to 1.2.

### v1.1 (2026-10-30)

- **CLI**: added `cli/` (`render / batch / list / schema / rec / styles / atlas / preset`) — zero dependencies, single-process batch rendering, recipe/preset/style-pack interoperability with the web UI.
- **Embedded image metadata**: PNGs exported by the web UI and CLI now carry tool version + full recipe in PNG text chunks (pixels untouched). New `inspect` reads it back; `rec apply <png>` / `render --recipe <png>` replay directly from an image; `--no-meta` opts out.
- **Web image import**: a new "Import image recipe" button under the preview restores the full configuration (style / building / seeds / parameters / view / outlines / per-part overrides) from any exported PNG — the web counterpart of `inspect` / `rec apply`.
- Summary now reports `version` / `meta`; identical parameters render byte-identical PNGs.

### v1.0

- First web release: 10 styles, 46 building types, orthographic/perspective, multi-direction and sprite-sheet export, style workshop and per-part overrides.

---

Happy rendering 🏯

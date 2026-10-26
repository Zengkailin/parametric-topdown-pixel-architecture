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
The web UI exports all directions of the current building at once. For batch multi-building, reuse the `js/` modules in Node (see `tools/test_all_types.js`).

---

## 6. Project Layout

```
参数化topdown建筑/
├─ index.html              Page skeleton (panels / preview / style workshop)
├─ 启动工具.bat            Opens index.html in the default browser
├─ css/app.css             UI styles
├─ js/                     Core logic (geometry / materials / rasterizer / UI)
├─ samples/                Example outputs and UI screenshots
└─ tools/                  Dev self-tests (not needed for normal use, see below)
```

---

## 7. Developers (optional)

End users can skip this section. These scripts are for maintaining / verifying the source and need the corresponding runtime:

```bat
:: Geometry / render / sampling self-tests (needs Node 18+)
node tools/selftest.js
node tools/test_nearest.js
node tools/test_all_types.js
node tools/test_views.js
node tools/ui_test.js        :: needs local Chrome / Edge

:: Regenerate catalog & atlases from the Godot plugin (needs Python + Pillow)
pip install Pillow
python tools/build_assets.py
:: Optionally point at a plugin directory:
python tools/build_assets.py --addon "<plugin>\addons\hd2d_scene_tools"
```

> Scripts under `tools/` do not participate in rendering; deleting them won't affect normal users.

---

## 8. Open Source & License

- Issues and Pull Requests are welcome. Please run the `tools/` self-tests before submitting to avoid regressions.
- This project is a web port of the Godot plugin `hd2d_scene_tools`, referencing its geometry and parameter spec — please comply with its respective license.
- Atlas assets may involve third-party copyright; confirm licensing before use / distribution.

---

Happy rendering 🏯

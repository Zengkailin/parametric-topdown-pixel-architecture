# -*- coding: utf-8 -*-
"""从 Godot 插件 addons/hd2d_scene_tools 提取网页端需要的静态资源。

产物（都在 ../js/ 下）：
  catalog.js  —— 建筑目录（46 种类型、分类、默认参数、名称）
  atlases.js  —— 内置风格图集（v5 三种 + v6 六种，4×4 格，128px/格，base64 内嵌）

之所以内嵌而不直接读 PNG：
  浏览器以 file:// 打开页面时，canvas 读取本地 PNG 会被判定为跨源污染，
  无法 getImageData()。data: URL 的图片不受此限制，因此把图集转成 base64
  内嵌，网页双击即可运行，不需要起服务器。

用法：
  python tools/build_assets.py [--addon <插件根目录>] [--atlas-size 512]
"""
import argparse
import base64
import io
import json
import re
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DEFAULT_ADDON = Path(r"D:\BaiduNetdiskDownload\01_HD2D_0.4.7.1_Plugin_Manual\addons\hd2d_scene_tools")
# 像素图集不在官方手册包里（v5/*.png 之外的手绘补充素材），从本地插件目录兜底读取
EXTRA_ADDONS = [Path(r"D:\SoftWare\Game\Jeff场景插件\addons\hd2d_scene_tools")]

# 与 runtime/building_materials_v5.gd / v6 的 ROLES 顺序一致
ROLES = [
    "roof", "wood", "wall", "stone",
    "trim", "glass", "cloth", "metal",
    "shadow", "accent", "door", "window",
    "roof_edge", "wall_base", "sign", "shutter",
]

# runtime/building_materials_v2.gd 的 10 色基础调色板（顺序：roof,wall,wood,stone,glass,accent,metal,shadow,cloth,trim）
BASE_ROLES = ["roof", "wall", "wood", "stone", "glass", "accent", "metal", "shadow", "cloth", "trim"]
PALETTES = {
    "jiangnan": ["425b61", "e1dec8", "694334", "8c9691", "dfbe79", "b6543e", "756857", "343737", "b9a77c", "b68759"],
    "forest": ["556977", "ddc59c", "644739", "929489", "e8c47c", "617761", "706958", "303c3c", "a35942", "af875b"],
    "desert": ["c49764", "dfbd82", "7d573c", "b79570", "609a9c", "3c8989", "a98a52", "544839", "b85840", "ead4a1"],
}

# editor/building_styles.gd：v6 六种方言的几何基底（append-only，v1–v5 配方保持不变）
V6_BASES = {
    "machiya": "jiangnan",
    "nordic": "forest",
    "harbor": "forest",
    "palace": "jiangnan",
    "gothic": "forest",
    "steamworks": "forest",
}
V6_IDS = ["machiya", "nordic", "harbor", "palace", "gothic", "steamworks"]

# (id, 中文名, 几何族, 说明, 图集目录)
# 前三条对应 editor/sprite_studio.gd 的 STYLE_NAMES（v5 图集），其余为 v6 图集。
STYLE_INFO = [
    ("jiangnan", "江南古镇", "jiangnan", "江南民居：黛瓦白墙、木构穿斗、曲脊歇山。", "v5"),
    ("forest", "欧式风格", "forest", "欧式木构：陡坡双坡顶、木筋墙、外挂百叶与烟囱。", "v5"),
    ("desert", "沙漠聚落", "desert", "沙漠聚落：平顶露台、分层退台、土石墙面。", "v5"),
    ("machiya", "日式町屋", "machiya", "日式町屋：十字脊瓦顶、木格窗、暖帘门、缘侧外廊。", "v6"),
    ("nordic", "北欧雪乡", "nordic", "北欧雪乡：陡坡覆雪顶、木筋墙、百叶窗、石砌烟囱。", "v6"),
    ("harbor", "热带海港", "harbor", "热带海港：缓坡四坡顶加通风帽、缘侧布棚、百叶窗。", "v6"),
    ("palace", "中式宫阙", "palace", "中式宫阙：重檐歇山、朱红立柱、明黄琉璃、重彩斗拱。", "v6"),
    ("gothic", "哥特城镇", "gothic", "哥特城镇：尖券窗、飞扶壁、尖塔饰、深色石砌立面。", "v6"),
    ("steamworks", "蒸汽工业", "steamworks", "蒸汽工业：锯齿采光顶、玻璃天窗、锅炉烟囱、铆接金属。", "v6"),
    ("jiangnan_pixel", "像素江南", "jiangnan", "江南几何 + 手绘像素图集，低分辨率像素风。", "v5"),
]


def _roles_js() -> str:
    return "[" + ",".join('"%s"' % r for r in ROLES) + "]"


def build_catalog(addon: Path) -> str:
    raw = json.loads((addon / "editor" / "building_catalog.json").read_text(encoding="utf-8"))
    types = []
    for row in raw["types"]:
        types.append({
            "id": row["id"],
            "category": row["category"],
            "archetype": row.get("archetype", "house"),
            "kind": int(row.get("kind", 0)),
            "townGroup": row.get("town_group", ""),
            "names": row.get("names", {}),
            "defaults": row.get("defaults", {}),
        })
    data = {
        "version": 5,               # 插件 Catalog.VERSION：几何走 v5 配方
        "sourceVersion": raw.get("version", 4),
        "categories": raw["categories"],
        "types": types,
    }
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    bases = json.dumps(V6_BASES, separators=(",", ":"))
    api = r'''
// ---------------------------------------------------------------------------
// 目录 API：与 building_catalog.gd / building_designs_v5.gd 对齐
// ---------------------------------------------------------------------------
/** editor/building_styles.gd#BASES：v6 方言 → 基础几何族 */
TB.STYLE_BASES = BASES_JSON;
/** 方言 → 几何族：v6 走自己的屋顶/立面，其余保持自身 id */
TB.styleBase = function (style) { return TB.STYLE_BASES[style] || style; };
TB.isV6Style = function (style) { return !!TB.STYLE_BASES[style]; };

var Catalog = TB.Catalog = {
	version: 5,
	document: function () { return TB.CATALOG; },
	categories: function () { return TB.CATALOG.categories; },
	types: function (category) {
		return TB.CATALOG.types.filter(function (row) {
			return !category || row.category === category;
		});
	},
	entry: function (id) {
		var rows = TB.CATALOG.types;
		for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
		return null;
	},
	title: function (id, style, lang) {
		var row = Catalog.entry(id);
		if (!row) return id;
		lang = lang || "zh";
		var names = row.names[style] || row.names[TB.styleBase(style)] || row.names.jiangnan || {};
		return names[lang] || names.zh || id;
	},
	/** building_designs_v5.gd#defaults */
	designDefaults: function (id, style) {
		var p = { width: 6.5, depth: 5.0, floors: 1, windows: 2, pitch: 32, eave: 0.7, porch: true, balcony: false, ornament: true, roof: 0 };
		if (style === "forest") { p.width = 5.75; p.depth = 5.25; p.pitch = 46; p.eave = 0.5; }
		else if (style === "desert") { p.width = 6.0; p.depth = 5.5; p.pitch = 24; p.eave = 0.2; }
		if (id === "general_store") { p.width += 1.0; p.depth -= 0.25; p.floors = 1; }
		if (id === "inn") { p.width += 1.5; p.depth += 1.0; p.floors = 2; p.windows = 3; p.balcony = true; }
		return p;
	},
	/** editor/building_styles.gd#defaults：v6 六种方言的尺寸/坡度默认值 */
	styleDefaults: function (style, id, p) {
		var d = Object.assign({}, p);
		if (!TB.STYLE_BASES[style]) return d;
		if (style === "machiya") Object.assign(d, { width: 5.5, depth: 6.0, pitch: 28, eave: 0.65, balcony: false });
		else if (style === "nordic") Object.assign(d, { width: 5.5, depth: 5.0, pitch: 50, eave: 0.65, balcony: false });
		else if (style === "harbor") Object.assign(d, { width: 6.5, depth: 5.5, pitch: 30, eave: 0.85, balcony: true });
		else if (style === "palace") Object.assign(d, { width: 7.5, depth: 6.0, pitch: 30, eave: 0.9, balcony: true });
		else if (style === "gothic") Object.assign(d, { width: 5.5, depth: 6.0, pitch: 50, eave: 0.35, balcony: false });
		else if (style === "steamworks") Object.assign(d, { width: 7.0, depth: 5.5, pitch: 25, eave: 0.25, balcony: false });
		if (id === "general_store") d.width += 0.5;
		if (id === "inn") { d.width += 1.0; d.depth += 0.5; d.floors = 2; }
		return d;
	},
	/** building_catalog.gd#parameters */
	parameters: function (id, style, seedValue, randomShape) {
		var row = Catalog.entry(id) || {};
		seedValue = seedValue === undefined ? 60421 : seedValue;
		var p = Object.assign({}, row.defaults || {});
		if (style === "forest") { p.pitch = 48; p.eave = 0.55; }
		else if (style === "desert") { p.pitch = 24; p.eave = 0.25; }
		if (Catalog.version >= 5 && (id === "house" || id === "general_store" || id === "inn")) {
			Object.assign(p, Catalog.designDefaults(id, style));
		}
		// v6 方言在 v5 设计默认值之后覆盖尺寸；原型建筑只借用坡度与挑檐
		if (TB.STYLE_BASES[style]) {
			if (row.archetype === "house") p = Catalog.styleDefaults(style, id, p);
			else {
				var sd = Catalog.styleDefaults(style, id, p);
				p.pitch = sd.pitch;
				p.eave = sd.eave;
			}
		}
		if (randomShape) {
			var rng = new TB.PCG(seedValue + TB.hashStr(id) + TB.hashStr(style));
			p.width = TB.snappedf(TB.clamp(p.width * rng.randfRange(0.82, 1.15), 3, 10), 0.25);
			p.depth = TB.snappedf(TB.clamp(p.depth * rng.randfRange(0.85, 1.12), row.archetype === "wall" ? 0.5 : 2, 10), 0.25);
			if (row.archetype === "house") {
				p.floors = rng.randiRange(1, row.kind === 2 ? 3 : 2);
				p.porch = rng.randf() > 0.25;
				p.balcony = p.floors > 1 && rng.randf() > 0.35;
				p.roof = rng.randf() > 0.22 ? 0 : (style === "desert" ? 2 : 1);
			}
			if (style !== "desert") p.pitch = TB.clamp(p.pitch + rng.randiRange(-6, 4), 15, 50);
			p.height = TB.snappedf(p.height * rng.randfRange(0.90, 1.12), 0.1);
			p.bays = rng.randiRange(2, 5);
		}
		if (Catalog.version >= 5 && id === "inn") p.floors = Math.max(2, p.floors);
		return p;
	},
	/** building_catalog.gd#fields：面板按原型显示哪些参数行 */
	fields: function (id) {
		var base = ["width", "depth", "shape_seed", "detail_seed", "appearance_seed"];
		var arch = (Catalog.entry(id) || {}).archetype || "house";
		switch (arch) {
			case "house": return base.concat(["floors", "pitch", "eave", "windows", "roof", "porch", "balcony", "ornament"]);
			case "tower": return base.concat(["floors", "pitch", "eave", "windows", "roof"]);
			case "barn": return base.concat(["height", "bays", "pitch", "eave"]);
			case "greenhouse": return base.concat(["height", "bays"]);
			case "stall": return base.concat(["height", "bays"]);
			case "wall": case "dock": case "ruin": return base.concat(["height", "bays"]);
			case "gate": case "fortress": case "portal": return base.concat(["height"]);
			default: return base;
		}
	}
};
'''
    api = api.replace("BASES_JSON", bases)
    return (
        "(function(){\n"
        "\"use strict\";\n"
        "// 由 tools/build_assets.py 生成，请勿手改。\n"
        "// 数据来源：addons/hd2d_scene_tools/editor/building_catalog.json\n"
        "//           addons/hd2d_scene_tools/editor/building_styles.gd（v6 方言基底）\n"
        "var TB = globalThis.TB = globalThis.TB || {};\n"
        "TB.CATALOG = " + body + ";\n"
        "TB.ROLES = " + _roles_js() + ";\n"
        + api +
        "})();\n"
    )


def _sample_palette(im, cell):
    """从图集里取 10 个基础角色的平均色，作为该方言的调色板。

    v6 六套图集在插件里只提供图集、没有单独的调色板，这里按平均色反推，
    供「风格工坊」的调色板面板与程序化回退使用。
    """
    palette = {}
    rgb = im.convert("RGB")
    for role in BASE_ROLES:
        index = ROLES.index(role)
        box = ((index % 4) * cell, (index // 4) * cell, (index % 4 + 1) * cell, (index // 4 + 1) * cell)
        crop = rgb.crop(box)
        pixels = list(crop.getdata())
        count = max(1, len(pixels))
        avg = [sum(px[i] for px in pixels) // count for i in range(3)]
        palette[role] = "#%02x%02x%02x" % tuple(avg)
    return palette


def build_atlases(addon: Path, size: int, extras=()):
    rows = []
    notes = []
    palette = {style: {role: "#" + color for role, color in zip(BASE_ROLES, colors)}
               for style, colors in PALETTES.items()}
    for style, zh, geometry, note, folder in STYLE_INFO:
        path = None
        for root in [addon] + list(extras):
            candidate = root / "assets" / "buildings" / folder / ("%s.png" % style)
            if candidate.exists():
                path = candidate
                break
        if path is None:
            notes.append("缺少图集 %s/assets/buildings/%s/%s.png" % (addon, folder, style))
            continue
        im = Image.open(path).convert("RGBA")
        if im.width != im.height:
            notes.append("%s 不是方图，跳过" % path.name)
            continue
        native_cell = im.width / 4.0
        # 运行时会把每格缩到 128px（屋顶 64px），这里按整图 NEAREST 缩到目标尺寸。
        # v6 图集是 1254px（每格 313.5px，非 4 倍数），统一重采样到 4 的整数倍目标尺寸。
        if im.width != size:
            im = im.resize((size, size), Image.NEAREST)
        buf = io.BytesIO()
        im.save(buf, format="PNG", optimize=True)
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        rows.append({
            "id": style,
            "name": zh,
            "geometry": geometry,
            "cell": size // 4,
            "size": size,
            "nativeCell": round(native_cell),
            "note": note,
            "data": "data:image/png;base64," + b64,
        })
        if style not in palette:
            palette[style] = _sample_palette(im, size // 4)
        notes.append("%s: %dpx（原生 %.0fpx/格 → %dpx/格，PNG %.0f KB）"
                     % (style, size, native_cell, size // 4, len(buf.getvalue()) / 1024.0))

    body = json.dumps({"atlases": rows, "palette": palette}, ensure_ascii=False, separators=(",", ":"))
    js = (
        "(function(){\n"
        "\"use strict\";\n"
        "// 由 tools/build_assets.py 生成，请勿手改。\n"
        "// 图集来源：addons/hd2d_scene_tools/assets/buildings/v5/*.png、v6/*.png\n"
        "// 布局：4×4 格，角色顺序见 TB.ROLES。\n"
        "var TB = globalThis.TB = globalThis.TB || {};\n"
        "TB.BUILTIN_ASSETS = " + body + ";\n"
        "})();\n"
    )
    return js, notes


def _write(path: Path, text: str) -> None:
    """固定 LF 换行写出（Path.write_text 的 newline 参数要 3.10+）。"""
    with io.open(str(path), "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--addon", default=str(DEFAULT_ADDON))
    ap.add_argument("--extra-addon", action="append", default=None,
                    help="像素等补充素材所在的插件目录，可重复指定")
    ap.add_argument("--atlas-size", type=int, default=512)
    args = ap.parse_args()

    addon = Path(args.addon)
    extras = [Path(p) for p in (args.extra_addon or [str(p) for p in EXTRA_ADDONS])]
    js_dir = ROOT / "js"
    js_dir.mkdir(parents=True, exist_ok=True)

    catalog_js = build_catalog(addon)
    _write(js_dir / "catalog.js", catalog_js)

    atlas_js, notes = build_atlases(addon, args.atlas_size, extras)
    _write(js_dir / "atlases.js", atlas_js)

    print("catalog.js  %.1f KB" % (len(catalog_js.encode("utf-8")) / 1024.0))
    print("atlases.js  %.1f KB" % (len(atlas_js.encode("utf-8")) / 1024.0))
    for line in notes:
        print("  " + line)


if __name__ == "__main__":
    main()

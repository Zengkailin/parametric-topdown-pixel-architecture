(function () {
"use strict";
/**
 * 材质：图集裁格、最近邻缩放、平铺接缝混合、角色染色、程序化像素纹理。
 *
 * 图集规范（对应 building_materials_v5.gd）：
 *   - 正方形 PNG，边长能被 4 整除；4×4 = 16 格；
 *   - 格序 = TB.ROLES：
 *       roof    wood    wall     stone
 *       trim    glass   cloth    metal
 *       shadow  accent  door     window
 *       roof_edge wall_base sign shutter
 *   - 可平铺角色：最外圈与对侧取平均，避免重复接缝；
 *   - 构件角色（door/window/sign/shutter/wall_base/roof_edge）：整格使用，保留构图；
 *   - 运行时把 roof 格缩到 64px、其余缩到 128px，最近邻采样。
 */
var TB = globalThis.TB;

TB.ROLE_ZH = {
	roof: "屋顶瓦", wood: "木构件", wall: "墙面", stone: "石作",
	trim: "饰条", glass: "玻璃", cloth: "布幔", metal: "金属",
	shadow: "内影", accent: "点缀", door: "门扇", window: "窗扇",
	roof_edge: "瓦口", wall_base: "墙裙", sign: "招牌", shutter: "百叶",
	// 积雪：不占图集格，v6「北欧雪乡」的覆雪屋面专用程序化材质
	snow: "积雪"
};
TB.COMPONENT_ROLES = ["door", "window", "sign", "shutter", "wall_base", "roof_edge"];
/** 图集之外的附加角色（渲染器按 TB.PAINT_ROLES 编号，图集仍只认 16 格） */
TB.EXTRA_ROLES = ["snow"];
TB.PAINT_ROLES = TB.ROLES.concat(TB.EXTRA_ROLES);
TB.geometryStyle = function (style) {
	return style === "jiangnan_pixel" ? "jiangnan" : (style === "forest_pixel" ? "forest" : style);
};

// ---------------------------------------------------------------------------
// 缩放 / 拼接
// ---------------------------------------------------------------------------
TB.cropRGBA = function (data, width, x0, y0, w, h) {
	var out = new Uint8ClampedArray(w * h * 4);
	for (var y = 0; y < h; y++) {
		var src = ((y0 + y) * width + x0) * 4;
		var dst = y * w * 4;
		out.set(data.subarray(src, src + w * 4), dst);
	}
	return out;
};

TB.resizeNearest = function (data, sw, sh, dw, dh) {
	if (sw === dw && sh === dh) return data.slice();
	var out = new Uint8ClampedArray(dw * dh * 4);
	var xs = new Int32Array(dw);
	for (var x = 0; x < dw; x++) xs[x] = Math.min(sw - 1, Math.floor((x + 0.5) * sw / dw));
	for (var y = 0; y < dh; y++) {
		var sy = Math.min(sh - 1, Math.floor((y + 0.5) * sh / dh));
		var srcRow = sy * sw;
		var dstRow = y * dw;
		for (var x2 = 0; x2 < dw; x2++) {
			var s = (srcRow + xs[x2]) * 4;
			var d = (dstRow + x2) * 4;
			out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
		}
	}
	return out;
};

/** 可平铺纹理的首尾像素取平均（materials_v5.texture 同款做法）。 */
TB.blendBorder = function (data, size) {
	function mix(a, b) {
		return [(a[0] + b[0]) >> 1, (a[1] + b[1]) >> 1, (a[2] + b[2]) >> 1, (a[3] + b[3]) >> 1];
	}
	for (var a = 0; a < size; a++) {
		var top = (0 * size + a) * 4, bottom = ((size - 1) * size + a) * 4;
		var avg = mix([data[top], data[top + 1], data[top + 2], data[top + 3]],
			[data[bottom], data[bottom + 1], data[bottom + 2], data[bottom + 3]]);
		for (var i = 0; i < 4; i++) { data[top + i] = avg[i]; data[bottom + i] = avg[i]; }
	}
	for (var b = 0; b < size; b++) {
		var left = (b * size + 0) * 4, right = (b * size + (size - 1)) * 4;
		var avg2 = mix([data[left], data[left + 1], data[left + 2], data[left + 3]],
			[data[right], data[right + 1], data[right + 2], data[right + 3]]);
		for (var j = 0; j < 4; j++) { data[left + j] = avg2[j]; data[right + j] = avg2[j]; }
	}
	return data;
};

// ---------------------------------------------------------------------------
// 染色
// ---------------------------------------------------------------------------
TB.LOOK_NAMES = ["原色", "素雅", "暖色", "风化"];
TB.LOOK_TINTS = [
	[1.0, 1.0, 1.0],
	[0.94, 1.02, 1.02],
	[1.08, 1.00, 0.88],
	[0.80, 0.84, 0.73]
];

/** materials_v5.material：角色微差（0.97~1.03）× 外观色偏。 */
TB.materialTint = function (role, look, appearanceSeed) {
	var shade = 0.97 + TB.posmod((appearanceSeed | 0) + TB.hashStr(role), 7) * 0.01;
	var lookTint = TB.LOOK_TINTS[look] || TB.LOOK_TINTS[0];
	return [shade * lookTint[0], shade * lookTint[1], shade * lookTint[2]];
};

function applyTint(data, tint) {
	var out = new Uint8ClampedArray(data.length);
	for (var i = 0; i < data.length; i += 4) {
		out[i] = data[i] * tint[0];
		out[i + 1] = data[i + 1] * tint[1];
		out[i + 2] = data[i + 2] * tint[2];
		out[i + 3] = data[i + 3];
	}
	return out;
}

// ---------------------------------------------------------------------------
// 程序化像素纹理（移植 building_materials_v3.gd 的簇状像素配方）
// ---------------------------------------------------------------------------
var SHADES = [-0.34, -0.18, -0.07, 0.0, 0.12, 0.22];

/** 生成单角色 32×32 基础纹理（未染色）。 */
TB.proceduralCell = function (role, style, paletteRgb) {
	var size = 32;
	var base = paletteRgb[role] || [128, 128, 128];
	var shades = SHADES.map(function (s) { return TB.shade(base, s); });
	var rng = new TB.PCG(101 + TB.hashStr(style + "/" + role));
	var cells = new Uint8Array(256);
	for (var c = 0; c < 256; c++) cells[c] = rng.randiRange(0, 9);
	var data = new Uint8ClampedArray(size * size * 4);
	var palette = shades;
	function set(x, y, idx) {
		var color = palette[Math.max(0, Math.min(5, idx))];
		var o = (y * size + x) * 4;
		data[o] = color[0]; data[o + 1] = color[1]; data[o + 2] = color[2]; data[o + 3] = 255;
	}
	for (var y = 0; y < size; y++) {
		for (var x = 0; x < size; x++) {
			var cell = cells[((y >> 1) << 4) + (x >> 1)];
			var index = cell < 2 ? 2 : (cell === 9 ? 4 : 3);
			switch (role) {
				case "roof": {
					var tx = (x + ((y / 8) | 0) % 2 * 4) % 8;
					index = tx < 4 ? 2 : 3;
					if (y % 8 === 0 || tx === 0) index = 0;
					else if (y % 8 === 1) index = 4;
					else if (tx === 1) index = 5;
					break;
				}
				case "wood": {
					var grain = (y + (((x / 8) | 0) % 2)) % 8;
					if (grain === 0) index = 0;
					else if (grain === 1) index = 4;
					else if (grain === 4 && x % 8 < 5) index = 1;
					break;
				}
				case "stone": {
					var sx = (x + ((y / 8) | 0) * 8) % 16;
					if (y % 8 === 0 || sx === 0) index = 0;
					else if (y % 8 === 1 || sx === 1) index = 4;
					break;
				}
				case "wall": {
					index = cells[((y >> 2) << 4) + (x >> 2)] < 2 ? 2 : 3;
					if (style === "desert" && y % 8 === 0 && (x + ((y / 8) | 0) * 4) % 16 < 12) index = 1;
					break;
				}
				case "glass":
					index = ((((x / 4) | 0) + ((y / 4) | 0)) % 2 === 0) ? 4 : 2;
					break;
				case "cloth":
					index = x % 8 < 3 ? 1 : 4;
					break;
				case "metal":
					index = y % 8 < 2 ? 5 : 2;
					break;
				case "shadow":
					index = 2;
					break;
				case "trim":
					index = (y % 8 === 0) ? 5 : ((x + y) % 16 < 2 ? 4 : 2);
					break;
				case "accent":
					index = (x + y) % 12 < 3 ? 5 : 3;
					break;
				case "door": {
					index = ((x / 8) | 0) % 2 ? 2 : 3;
					if (x < 2 || x > 29 || y < 2) index = 0;
					if (y % 8 === 0 && x > 2) index = 1;
					if (x >= 22 && x <= 25 && y >= 15 && y <= 18) index = 5;
					break;
				}
				case "window": {
					index = ((((x / 4) | 0) + ((y / 4) | 0)) % 2 === 0) ? 4 : 2;
					if (x < 2 || x > 29 || y < 2 || y > 29) index = 1;
					if (x % 16 === 0 || y % 16 === 0) index = 0;
					break;
				}
				case "sign": {
					index = 2;
					if (x < 2 || x > 29 || y < 2 || y > 29) index = 0;
					if (y === 3 || y === 28) index = 4;
					var dx = Math.abs(x - 16), dy = Math.abs(y - 16);
					if (dx + dy < 6) index = 5;
					if ((x === 16 || y === 16) && dx + dy < 10) index = 1;
					break;
				}
				case "shutter": {
					var s = y % 6;
					index = s === 0 ? 0 : (s === 1 ? 4 : 3);
					if (x < 2 || x > 29) index = 1;
					break;
				}
				case "wall_base": {
					var bx2 = (x + ((y / 8) | 0) * 8) % 16;
					index = 3;
					if (y % 8 === 0 || bx2 === 0) index = 0;
					else if (y % 8 === 1) index = 4;
					if (y > 24) index = 1;
					break;
				}
				case "roof_edge": {
					index = ((x / 4) | 0) % 2 ? 3 : 2;
					if (y % 8 === 0) index = 0;
					if (y > 24) index = 1;
					if ((x + 2) % 8 === 0) index = 4;
					break;
				}
				default:
					break;
			}
			set(x, y, index);
		}
	}
	return data;
};

/** 生成整张 4×4 程序化图集（cellSize 每格边长）。 */
TB.proceduralAtlas = function (paletteRgb, style, cellSize) {
	cellSize = cellSize || 128;
	var size = cellSize * 4;
	var data = new Uint8ClampedArray(size * size * 4);
	TB.ROLES.forEach(function (role, index) {
		var cell = TB.resizeNearest(TB.proceduralCell(role, style, paletteRgb), 32, 32, cellSize, cellSize);
		if (TB.COMPONENT_ROLES.indexOf(role) < 0) TB.blendBorder(cell, cellSize);
		var x0 = (index % 4) * cellSize, y0 = ((index / 4) | 0) * cellSize;
		for (var y = 0; y < cellSize; y++) {
			var src = y * cellSize * 4;
			var dst = ((y0 + y) * size + x0) * 4;
			data.set(cell.subarray(src, src + cellSize * 4), dst);
		}
	});
	return { size: size, cell: cellSize, data: data };
};

/**
 * 温室玻璃：插件对 greenhouse 用半透明淡青玻璃（v4.glazing），
 * 本工具不计算混合，改用浅青格窗近似，避免整栋温室糊成黑窗。
 */
TB.glazingCell = function () {
	var size = 32;
	var data = new Uint8ClampedArray(size * size * 4);
	var base = [147, 189, 195];
	for (var y = 0; y < size; y++) {
		for (var x = 0; x < size; x++) {
			var mint = ((x >> 2) + (y >> 2)) % 2 === 0;
			var color = mint ? base : TB.darken(base, 0.10);
			if (x % 8 === 0 || y % 8 === 0) color = TB.lighten(base, 0.32);
			if ((x + y) % 16 === 0) color = TB.lighten(base, 0.22);
			if (x % 16 < 2 || y % 16 < 2) color = TB.darken(base, 0.35);
			var o = (y * size + x) * 4;
			data[o] = color[0]; data[o + 1] = color[1]; data[o + 2] = color[2]; data[o + 3] = 255;
		}
	}
	return data;
};

/**
 * 积雪：对应 building_materials_v6.gd 的 texture("snow")。
 * 插件用一张 16×16 的淡蓝白块面（0.65/0.73/0.79，2% 亮斑）盖在屋面上；
 * 这里按同款配方生成 32×32，再按普通角色缩到 128。
 */
TB.snowCell = function () {
	var size = 32;
	var data = new Uint8ClampedArray(size * size * 4);
	var base = [166, 186, 201];
	for (var y = 0; y < size; y++) {
		for (var x = 0; x < size; x++) {
			var shade = (((x / 8) | 0) + ((y / 6) | 0)) % 4 === 0 ? 5 : 0;
			var o = (y * size + x) * 4;
			data[o] = base[0] + shade;
			data[o + 1] = base[1] + shade;
			data[o + 2] = base[2] + shade;
			data[o + 3] = 255;
		}
	}
	return data;
};

/** 积雪贴图：128px + mip 链，外观色偏与角色微差同普通角色。 */
TB.snowTile = function (look, appearanceSeed, raw) {
	var target = 128;
	var data = TB.resizeNearest(TB.snowCell(), 32, 32, target, target);
	TB.blendBorder(data, target);
	if (!raw) data = applyTint(data, TB.materialTint("snow", look === undefined ? 0 : look, appearanceSeed || 0));
	return { w: target, h: target, data: data, mips: TB.makeMips(data, target, target) };
};

// ---------------------------------------------------------------------------
// 图集
// ---------------------------------------------------------------------------
TB.makeAtlas = function (data, size) {
	if (size % 4 !== 0) throw new Error("图集边长必须能被 4 整除");
	return { size: size, cell: size / 4, data: data };
};

TB.atlasCell = function (atlas, role) {
	var index = TB.ROLES.indexOf(role);
	if (index < 0) index = 0;
	var cell = atlas.cell;
	var x0 = (index % 4) * cell, y0 = ((index / 4) | 0) * cell;
	return TB.cropRGBA(atlas.data, atlas.size, x0, y0, cell, cell);
};

/** 把单张图片当作某角色的纹理（正方形，最近邻缩放到目标尺寸）。 */
TB.tileFromImage = function (imageData, role, raw) {
	var target = role === "roof" ? 64 : 128;
	var data = TB.resizeNearest(imageData.data, imageData.width, imageData.height, target, target);
	if (TB.COMPONENT_ROLES.indexOf(role) < 0) TB.blendBorder(data, target);
	return data;
};

/**
 * 生成 mip 链（2×2 盒式滤波）。插件材质是 NEAREST_WITH_MIPMAPS，
 * 缩小采样时靠 mip 去噪，否则瓦片会闪成噪点。
 */
TB.makeMips = function (data, w, h) {
	var levels = [{ w: w, h: h, data: data }];
	var cw = w, ch = h, current = data;
	while (cw > 1 || ch > 1) {
		var nw = Math.max(1, cw >> 1), nh = Math.max(1, ch >> 1);
		var next = new Uint8ClampedArray(nw * nh * 4);
		for (var y = 0; y < nh; y++) {
			for (var x = 0; x < nw; x++) {
				var sx0 = Math.min(cw - 1, x * 2), sx1 = Math.min(cw - 1, x * 2 + 1);
				var sy0 = Math.min(ch - 1, y * 2), sy1 = Math.min(ch - 1, y * 2 + 1);
				var o = (y * nw + x) * 4;
				var i00 = (sy0 * cw + sx0) * 4, i10 = (sy0 * cw + sx1) * 4;
				var i01 = (sy1 * cw + sx0) * 4, i11 = (sy1 * cw + sx1) * 4;
				for (var k = 0; k < 4; k++) {
					next[o + k] = (current[i00 + k] + current[i10 + k] + current[i01 + k] + current[i11 + k]) >> 2;
				}
			}
		}
		levels.push({ w: nw, h: nh, data: next });
		cw = nw; ch = nh; current = next;
	}
	return levels;
};

/**
 * 解析出最终使用的 16 张纹理。
 * sources[role] = {data: Uint8ClampedArray, size: number}  已按格/单图裁好的原始像素
 * opts = {look, appearanceSeed, raw}
 */
TB.buildTiles = function (sources, opts) {
	opts = opts || {};
	var look = opts.look === undefined ? 0 : opts.look;
	var seed = opts.appearanceSeed || 0;
	var tiles = {};
	TB.ROLES.forEach(function (role) {
		var source = sources[role];
		if (!source) return;
		var target = role === "roof" ? 64 : 128;
		var data = TB.resizeNearest(source.data, source.size, source.size, target, target);
		if (TB.COMPONENT_ROLES.indexOf(role) < 0) TB.blendBorder(data, target);
		if (!opts.raw) data = applyTint(data, TB.materialTint(role, look, seed));
		tiles[role] = { w: target, h: target, data: data, mips: TB.makeMips(data, target, target) };
	});
	// 积雪不在图集里，按需生成（只有北欧雪乡的屋面会引用它）
	tiles.snow = TB.snowTile(look, seed, opts.raw);
	return tiles;
};

/** 从图集解析 sources（每角色一格）。 */
TB.atlasSources = function (atlas) {
	var sources = {};
	TB.ROLES.forEach(function (role) {
		var cell = atlas.cell;
		var index = TB.ROLES.indexOf(role);
		var x0 = (index % 4) * cell, y0 = ((index / 4) | 0) * cell;
		sources[role] = { data: TB.cropRGBA(atlas.data, atlas.size, x0, y0, cell, cell), size: cell };
	});
	return sources;
};

/** 图集模板：把当前解析出的纹理拼回 4×4（每格 128）。 */
TB.assembleAtlas = function (sources, cellSize) {
	cellSize = cellSize || 128;
	var size = cellSize * 4;
	var data = new Uint8ClampedArray(size * size * 4);
	TB.ROLES.forEach(function (role, index) {
		var source = sources[role];
		if (!source) return;
		var cell = TB.resizeNearest(source.data, source.size, source.size, cellSize, cellSize);
		var x0 = (index % 4) * cellSize, y0 = ((index / 4) | 0) * cellSize;
		for (var y = 0; y < cellSize; y++) {
			var src = y * cellSize * 4;
			var dst = ((y0 + y) * size + x0) * 4;
			data.set(cell.subarray(src, src + cellSize * 4), dst);
		}
	});
	return { size: size, cell: cellSize, data: data };
};

// ---------------------------------------------------------------------------
// 默认调色板：v2 的 10 色基础 + 6 个派生角色
// ---------------------------------------------------------------------------
TB.derivePalette = function (base) {
	var p = {};
	TB.ROLES.forEach(function (role) {
		if (base[role]) { p[role] = base[role]; return; }
		switch (role) {
			case "door": p[role] = TB.rgbToHex(TB.darken(TB.hexToRgb(base.wood || "#694334"), 0.18)); break;
			case "window": p[role] = base.glass || "#dfbe79"; break;
			case "sign": p[role] = TB.rgbToHex(TB.darken(TB.hexToRgb(base.wood || "#694334"), 0.06)); break;
			case "shutter": p[role] = base.accent || "#b6543e"; break;
			case "wall_base": p[role] = TB.rgbToHex(TB.darken(TB.hexToRgb(base.stone || "#8c9691"), 0.10)); break;
			case "roof_edge": p[role] = TB.rgbToHex(TB.lighten(TB.hexToRgb(base.roof || "#425b61"), 0.10)); break;
			default: p[role] = base.wall || "#cccccc";
		}
	});
	return p;
};

TB.paletteToRgb = function (palette) {
	var out = {};
	TB.ROLES.forEach(function (role) {
		out[role] = TB.hexToRgb(palette[role] || "#888888");
	});
	return out;
};
})();

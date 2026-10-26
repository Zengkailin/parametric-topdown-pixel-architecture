/**
 * 最近邻采样验证：确认 256×256 图集（64px/格）在放大到 128px 时
 * 只产生 2×2 色块，不会出现任何中间色（即没有双线性 / 平滑插值）。
 *
 * 用法：node tools/test_nearest.js
 */
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..");
["util", "catalog", "atlases", "materials"].forEach((n) => require(path.join(ROOT, "js", n + ".js")));
const TB = globalThis.TB;
const results = [];

function check(name, ok, detail) {
	results.push({ name, ok: !!ok });
	console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  —  " + detail : ""));
}

// ---------------------------------------------------------------------------
// 1. 基础函数：2×2 → 8×8 只允许出现两种颜色，且每色块 4×4
// ---------------------------------------------------------------------------
(function baseResize() {
	const src = new Uint8ClampedArray([
		255, 0, 0, 255, 0, 0, 255, 255,
		0, 0, 255, 255, 255, 0, 0, 255
	]);
	const out = TB.resizeNearest(src, 2, 2, 8, 8);
	const colors = new Set();
	for (let i = 0; i < out.length; i += 4) colors.add([out[i], out[i + 1], out[i + 2]].join(","));
	check("2×2 → 8×8 只出现原图 2 种颜色", colors.size === 2, Array.from(colors).join(" | "));
	let blockOk = true;
	// 每个 4×4 块内颜色一致
	for (let by = 0; by < 2; by++) {
		for (let bx = 0; bx < 2; bx++) {
			const base = ((by * 4) * 8 + bx * 4) * 4;
			const color = out.slice(base, base + 3).join(",");
			for (let y = 0; y < 4; y++) {
				for (let x = 0; x < 4; x++) {
					const o = (((by * 4 + y) * 8) + (bx * 4 + x)) * 4;
					if (out.slice(o, o + 3).join(",") !== color) blockOk = false;
				}
			}
		}
	}
	check("放大后是整齐的 4×4 色块", blockOk);
})();

// ---------------------------------------------------------------------------
// 2. 256×256 图集（64px/格）：tiles 放大后不得出现中间色
// ---------------------------------------------------------------------------
(function atlasUpscale() {
	const cell = 64, size = 256;
	const data = new Uint8ClampedArray(size * size * 4);
	TB.ROLES.forEach((role, index) => {
		const cellX = (index % 4) * cell, cellY = Math.floor(index / 4) * cell;
		// 每个角色用一对高对比颜色做 1px 棋盘
		const a = [40 + index * 11, 60, 200 - index * 9];
		const b = [250 - index * 7, 230, 30 + index * 6];
		for (let y = 0; y < cell; y++) {
			for (let x = 0; x < cell; x++) {
				const c = ((x + y) % 2 === 0) ? a : b;
				const o = ((cellY + y) * size + (cellX + x)) * 4;
				data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
			}
		}
	});
	const atlas = TB.makeAtlas(data, size);
	const sources = TB.atlasSources(atlas);
	const tiles = TB.buildTiles(sources, { raw: true });

	// 构件角色 window（128px，2× 放大，且不做接缝混合）
	(function component() {
		const tile = tiles.window;
		const colors = new Set();
		for (let i = 0; i < tile.data.length; i += 4) {
			colors.add(tile.data.slice(i, i + 3).join(","));
		}
		check("window 64→128 只出现 2 种源色（无插值）", colors.size === 2, colors.size + " 色");
		const px = (x, y) => tile.data.slice((y * tile.w + x) * 4, (y * tile.w + x) * 4 + 3).join(",");
		check("2× 放大后每个源像素是 2×2 方块",
			px(0, 0) === px(1, 1) && px(1, 0) === px(0, 1) && px(2, 0) !== px(0, 0),
			`(0,0)=${px(0, 0)} (1,1)=${px(1, 1)} (2,0)=${px(2, 0)}`);
	})();

	// 可平铺角色 wall：去掉 1px 接缝混合边后，内部同样只能是 2 色
	(function tileable() {
		const tile = tiles.wall;
		const colors = new Set();
		for (let y = 1; y < tile.h - 1; y++) {
			for (let x = 1; x < tile.w - 1; x++) {
				const o = (y * tile.w + x) * 4;
				colors.add(tile.data.slice(o, o + 3).join(","));
			}
		}
		check("wall 内部也只有 2 种源色（接缝混合只影响最外圈）", colors.size === 2, colors.size + " 色");
		const px = (x, y) => tile.data.slice((y * tile.w + x) * 4, (y * tile.w + x) * 4 + 3).join(",");
		const edge = px(0, 5), inside = px(1, 5);
		check("边界接缝混合只改最外圈（边缘色不同于内侧源色）",
			edge !== inside && !colors.has(edge), edge + " vs " + inside);
	})();

	// roof：64px/格 → 64px，1:1（只做接缝混合）
	(function roof() {
		const tile = tiles.roof;
		check("roof 目标 64px 时保持 1:1", tile.w === 64 && tile.h === 64, tile.w + "×" + tile.h);
		const colors = new Set();
		for (let y = 1; y < tile.h - 1; y++) {
			for (let x = 1; x < tile.w - 1; x++) {
				const o = (y * tile.w + x) * 4;
				colors.add(tile.data.slice(o, o + 3).join(","));
			}
		}
		check("roof 内部同样只有 2 种源色", colors.size === 2, colors.size + " 色");
	})();
})();

// ---------------------------------------------------------------------------
// 3. 单角色图片 256 → 128：缩小也必须是最近邻（只取源像素，不插值）
// ---------------------------------------------------------------------------
(function singleImage() {
	const size = 256;
	const data = new Uint8ClampedArray(size * size * 4);
	const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
	// 2×2 的色块：最近邻缩小时每种颜色仍会被采到
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const c = colors[((x >> 1) % 2) + ((y >> 1) % 2) * 2];
			const o = (y * size + x) * 4;
			data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
		}
	}
	const allowed = new Set(colors.map((c) => c.join(",")));
	// 构件角色不做接缝混合，可用来单独验证“缩小”本身
	const tile = TB.tileFromImage({ data: data, width: size, height: size }, "window", true);
	const set = new Set();
	for (let i = 0; i < tile.length; i += 4) {
		set.add(tile.slice(i, i + 3).join(","));
	}
	let onlySourceColors = true;
	set.forEach((c) => { if (!allowed.has(c)) onlySourceColors = false; });
	check("单角色 256→128 缩小只取源像素（4 色，无中间色）", set.size === 4 && onlySourceColors,
		Array.from(set).join(" | "));
})();

const failed = results.filter((r) => !r.ok).length;
console.log("\n结果：" + (results.length - failed) + " / " + results.length + " 通过");
process.exit(failed ? 1 : 0);

/**
 * 生成 samples/ 示例输出（与网页端完全同一套几何 + 光栅化）。
 * 用法：node tools/make_samples.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const ROOT = path.join(__dirname, "..");
["util", "catalog", "atlases", "materials", "geometry", "view", "renderer"].forEach((n) => require(path.join(ROOT, "js", n + ".js")));
const TB = globalThis.TB;
const OUT = path.join(ROOT, "samples");
fs.mkdirSync(OUT, { recursive: true });

function decodePng(buf) {
	let pos = 8, width = 0, height = 0, idat = [];
	while (pos < buf.length) {
		const len = buf.readUInt32BE(pos);
		const type = buf.toString("ascii", pos + 4, pos + 8);
		const data = buf.subarray(pos + 8, pos + 8 + len);
		if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
		else if (type === "IDAT") idat.push(data);
		else if (type === "IEND") break;
		pos += 12 + len;
	}
	const raw = zlib.inflateSync(Buffer.concat(idat));
	const stride = width * 4;
	const out = Buffer.alloc(width * height * 4);
	let prev = Buffer.alloc(stride);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const cur = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
		for (let x = 0; x < stride; x++) {
			const a = x >= 4 ? cur[x - 4] : 0, b = prev[x], c = x >= 4 ? prev[x - 4] : 0;
			if (filter === 1) cur[x] = (cur[x] + a) & 255;
			else if (filter === 2) cur[x] = (cur[x] + b) & 255;
			else if (filter === 3) cur[x] = (cur[x] + ((a + b) >> 1)) & 255;
			else if (filter === 4) {
				const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
				cur[x] = (cur[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
			}
		}
		cur.copy(out, y * stride);
		prev = cur;
	}
	return { width, height, data: out };
}
function chunk(type, data) {
	const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4); crc.writeUInt32BE(TB.crc32(body), 0);
	return Buffer.concat([len, body, crc]);
}
function encodePng(frame) {
	const w = frame.width, h = frame.height, stride = w * 4;
	const raw = Buffer.alloc((stride + 1) * h);
	for (let y = 0; y < h; y++) {
		raw[y * (stride + 1)] = 0;
		Buffer.from(frame.data.buffer, frame.data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
const atlasCache = {};
function atlasFor(style) {
	if (atlasCache[style]) return atlasCache[style];
	const text = fs.readFileSync(path.join(ROOT, "js", "atlases.js"), "utf8");
	const start = text.indexOf("data:image/png;base64,", text.indexOf('"' + style + '"'));
	const end = text.indexOf('"', start);
	const png = decodePng(Buffer.from(text.slice(start + 22, end), "base64"));
	atlasCache[style] = TB.makeAtlas(new Uint8ClampedArray(png.data), png.width);
	return atlasCache[style];
}
const tileCache = {};
function tilesFor(style) {
	if (!tileCache[style]) tileCache[style] = TB.buildTiles(TB.atlasSources(atlasFor(style)), { look: 0, appearanceSeed: 101 });
	return tileCache[style];
}

function render(config) {
	const params = Object.assign(TB.Catalog.parameters(config.type, config.style), config.params || {});
	const entry = TB.Catalog.entry(config.type);
	const profile = {
		style: config.style, typeId: config.type, kind: entry.kind, categoryId: entry.category,
		shapeSeed: config.shapeSeed || 60421, detailSeed: config.detailSeed || 101, appearanceSeed: 101, params
	};
	const mesh = TB.buildBuilding(profile);
	const view = TB.prepareView(mesh.bounds, {
		pitch: config.pitch, projection: config.projection || 0, directions: config.directions || 0,
		baseYaw: config.baseYaw || 0, fov: config.fov === undefined ? 50 : config.fov, pixelSize: config.pixelSize === undefined ? 3 : config.pixelSize,
		scaleMode: config.scaleMode || 0, pixelsPerMeter: config.ppm || 48, padding: config.padding === undefined ? 8 : config.padding
	});
	const frames = view.yaws.map((yaw) => TB.renderFrame(mesh, tilesFor(config.style), view, yaw, {
		antialias: config.antialias !== false,
		outlineInner: config.outlineInner || 0,
		outlineOuter: config.outlineOuter || 0,
		outlineSilhouette: config.outlineSilhouette || 0,
		outlineColor: config.outlineColor || TB.OUTLINE_COLOR,
		outlineColorOuter: config.outlineColorOuter || config.outlineColor || TB.OUTLINE_COLOR,
		outlineColorSilhouette: config.outlineColorSilhouette || config.outlineColorOuter || config.outlineColor || TB.OUTLINE_COLOR,
		partOutlines: config.partOutlines || null,
		transparent: true
	}));
	return { mesh, view, frames };
}

const samples = [
	{ file: "01_jiangnan_house_p45_768.png", style: "jiangnan", type: "house", pitch: 45, pixelSize: 4 },
	{ file: "02_jiangnan_house_p45_4dir_sheet.png", style: "jiangnan", type: "house", pitch: 45, pixelSize: 3, directions: 2, sheet: true },
	{ file: "03_forest_inn_p45_768.png", style: "forest", type: "inn", pitch: 45, pixelSize: 4 },
	{ file: "04_desert_tower_p30_768.png", style: "desert", type: "watchtower", pitch: 30, pixelSize: 4 },
	{ file: "05_pixel_house_outline.png", style: "jiangnan_pixel", type: "house", pitch: 45, pixelSize: 3, antialias: false, outlineInner: 1, outlineSilhouette: 2 },
	{ file: "06_desert_stall_p45.png", style: "desert", type: "market_stall", pitch: 45, pixelSize: 3 },
	{ file: "07_forest_farmhouse_p45.png", style: "forest", type: "farmhouse", pitch: 45, pixelSize: 4 },
	{ file: "08_jiangnan_gate_p45.png", style: "jiangnan", type: "gate", pitch: 45, pixelSize: 3 },
	// FOV 0 = 正交极限；俯角 0 = 平视，出纯立面图
	{ file: "09_forest_inn_fov0_pitch0_elevation.png", style: "forest", type: "inn", pitch: 0, projection: 1, fov: 0, pixelSize: 4 },
	// 三套描边：只开内描边 / 只开部件外描边 / 只开轮廓描边 / 三者不同颜色
	{ file: "10_outline_inner_only.png", style: "jiangnan", type: "house", pitch: 45, pixelSize: 3, outlineInner: 2, outlineColor: "#e0b95f" },
	{ file: "11_outline_part_outer_only.png", style: "jiangnan", type: "house", pitch: 45, pixelSize: 3, outlineOuter: 2, outlineColorOuter: "#e0b95f" },
	{ file: "12_outline_both_colors.png", style: "jiangnan", type: "house", pitch: 45, pixelSize: 3, outlineInner: 2, outlineOuter: 2, outlineColor: "#f2cd74", outlineColorOuter: "#4a2416" },
	{ file: "13_outline_silhouette_only.png", style: "jiangnan", type: "house", pitch: 45, pixelSize: 3, outlineSilhouette: 3, outlineColorSilhouette: "#e0b95f" },
	// 部件级描边：只给屋顶加一圈亮色外描边，其它部件保持继承
	{ file: "14_outline_part_override.png", style: "jiangnan", type: "house", pitch: 45, pixelSize: 3, outlineInner: 1, outlineSilhouette: 2, partOutlines: { roof: { outer: 3, outerColor: "#e0b95f" } } }
];

samples.forEach((sample) => {
	const result = render(sample);
	const output = sample.sheet ? TB.composeSheet(result.frames, 16384) : result.frames[0];
	fs.writeFileSync(path.join(OUT, sample.file), encodePng(output));
	console.log(sample.file, output.width + "x" + output.height, "tris", result.mesh.triangles);
});
console.log("\n输出目录：samples/");

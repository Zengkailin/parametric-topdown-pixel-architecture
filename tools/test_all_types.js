/**
 * 全类型巡检：对目录里 46 种建筑各渲染一张 256px 缩略图，拼成 7×7 接触表，
 * 并输出 JSON 报告（三角面数 / 不透明占比 / 异常）。
 *
 * 用法：node tools/test_all_types.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const ROOT = path.join(__dirname, "..");
["util", "catalog", "atlases", "materials", "geometry", "view", "renderer"].forEach((n) => require(path.join(ROOT, "js", n + ".js")));
const TB = globalThis.TB;

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
function encodePng(w, h, data) {
	const stride = w * 4;
	const raw = Buffer.alloc((stride + 1) * h);
	for (let y = 0; y < h; y++) {
		raw[y * (stride + 1)] = 0;
		Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function loadAtlas(style) {
	const text = fs.readFileSync(path.join(ROOT, "js", "atlases.js"), "utf8");
	const start = text.indexOf("data:image/png;base64,", text.indexOf('"' + style + '"'));
	const end = text.indexOf('"', start);
	const png = decodePng(Buffer.from(text.slice(start + 22, end), "base64"));
	return TB.makeAtlas(new Uint8ClampedArray(png.data), png.width);
}

const outDir = path.join(__dirname, "_out");
fs.mkdirSync(outDir, { recursive: true });
const tilesByStyle = {};
function tiles(style) {
	if (!tilesByStyle[style]) tilesByStyle[style] = TB.buildTiles(TB.atlasSources(loadAtlas(style)), { look: 0, appearanceSeed: 101 });
	return tilesByStyle[style];
}

const types = TB.Catalog.types();
const cell = 256, gap = 6, cols = 7, rows = Math.ceil(types.length / cols);
const sheetW = cols * (cell + gap) + gap, sheetH = rows * (cell + gap) + gap;
const sheet = new Uint8ClampedArray(sheetW * sheetH * 4);
for (let i = 0; i < sheetW * sheetH; i++) {
	sheet[i * 4] = 28; sheet[i * 4 + 1] = 32; sheet[i * 4 + 2] = 38; sheet[i * 4 + 3] = 255;
}
const report = [];
let failures = 0;
types.forEach((entry, index) => {
	const style = "jiangnan";
	const params = TB.Catalog.parameters(entry.id, style);
	const profile = {
		style, typeId: entry.id, kind: entry.kind, categoryId: entry.category,
		shapeSeed: 60421, detailSeed: 101, appearanceSeed: 101, params
	};
	try {
		const mesh = TB.buildBuilding(profile);
		const view = TB.prepareView(mesh.bounds, {
			pitch: 45, projection: 0, directions: 0, baseYaw: 0, fov: 50,
			pixelSize: 1, scaleMode: 0, pixelsPerMeter: 48, padding: 8
		});
		const frame = TB.renderFrame(mesh, tiles(style), view, view.yaws[0], { antialias: false, outline: 0, transparent: true });
		let opaque = 0;
		for (let i = 3; i < frame.data.length; i += 4) if (frame.data[i] > 0) opaque++;
		const ratio = opaque / (frame.width * frame.height);
		const row = {
			id: entry.id, archetype: entry.archetype, kind: entry.kind,
			triangles: mesh.triangles, opaque: Number(ratio.toFixed(3)),
			ok: ratio > 0.05 && mesh.triangles > 20,
			error: null
		};
		report.push(row);
		if (!row.ok) failures++;
		// 贴到接触表
		const cx = gap + (index % cols) * (cell + gap);
		const cy = gap + Math.floor(index / cols) * (cell + gap);
		for (let y = 0; y < cell; y++) {
			for (let x = 0; x < cell; x++) {
				const s = (y * frame.width + x) * 4, d = ((cy + y) * sheetW + cx + x) * 4;
				const a = frame.data[s + 3] / 255;
				sheet[d] = frame.data[s] * a + sheet[d] * (1 - a);
				sheet[d + 1] = frame.data[s + 1] * a + sheet[d + 1] * (1 - a);
				sheet[d + 2] = frame.data[s + 2] * a + sheet[d + 2] * (1 - a);
				sheet[d + 3] = 255;
			}
		}
	} catch (err) {
		failures++;
		report.push({ id: entry.id, archetype: entry.archetype, kind: entry.kind, triangles: 0, opaque: 0, ok: false, error: err.message });
	}
});

fs.writeFileSync(path.join(outDir, "all_types.png"), encodePng(sheetW, sheetH, sheet));
fs.writeFileSync(path.join(outDir, "all_types.json"), JSON.stringify(report, null, 2));
report.forEach((row) => {
	if (!row.ok) console.log("FAIL", row.id, row.archetype, row.triangles, row.opaque, row.error || "");
});
console.log("types:", types.length, "failures:", failures, "sheet:", sheetW + "x" + sheetH);
console.log("order:", types.map((t) => t.id).join(", "));

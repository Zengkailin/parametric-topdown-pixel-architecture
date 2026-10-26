/** 视角/画布组合自测：透视、自适应、固定像素密度、8 方向 + 精灵表。 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const ROOT = path.join(__dirname, "..");
["util", "catalog", "atlases", "materials", "geometry", "view", "renderer"].forEach((n) => require(path.join(ROOT, "js", n + ".js")));
const TB = globalThis.TB;

function chunk(t, d) {
	const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0);
	const b = Buffer.concat([Buffer.from(t), d]);
	const c = Buffer.alloc(4); c.writeUInt32BE(TB.crc32(b), 0);
	return Buffer.concat([l, b, c]);
}
function enc(f) {
	const s = f.width * 4;
	const raw = Buffer.alloc((s + 1) * f.height);
	for (let y = 0; y < f.height; y++) {
		raw[y * (s + 1)] = 0;
		Buffer.from(f.data.buffer, f.data.byteOffset + y * s, s).copy(raw, y * (s + 1) + 1);
	}
	const ih = Buffer.alloc(13);
	ih.writeUInt32BE(f.width, 0); ih.writeUInt32BE(f.height, 4); ih[8] = 8; ih[9] = 6;
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
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
function loadAtlas(style) {
	const text = fs.readFileSync(path.join(ROOT, "js", "atlases.js"), "utf8");
	const start = text.indexOf("data:image/png;base64,", text.indexOf('"' + style + '"'));
	const end = text.indexOf('"', start);
	const png = decodePng(Buffer.from(text.slice(start + 22, end), "base64"));
	return TB.makeAtlas(new Uint8ClampedArray(png.data), png.width);
}

const params = TB.Catalog.parameters("house", "jiangnan");
const profile = {
	style: "jiangnan", typeId: "house", kind: 0, categoryId: "residential",
	shapeSeed: 60421, detailSeed: 101, appearanceSeed: 101, params
};
const mesh = TB.buildBuilding(profile);
const tiles = TB.buildTiles(TB.atlasSources(loadAtlas("jiangnan")), { look: 0, appearanceSeed: 101 });
const out = path.join(__dirname, "_out");
fs.mkdirSync(out, { recursive: true });

const cases = [
	{ name: "v_persp", pitch: 45, projection: 1, fov: 55, pixelSize: 3, scaleMode: 0 },
	{ name: "v_adaptive", pitch: 45, projection: 0, pixelSize: 6, scaleMode: 0, pixelsPerMeter: 48 },
	{ name: "v_adaptive_fixedppm", pitch: 45, projection: 0, pixelSize: 6, scaleMode: 1, pixelsPerMeter: 20 },
	{ name: "v_ppm_square", pitch: 60, projection: 0, pixelSize: 3, scaleMode: 1, pixelsPerMeter: 20 },
	{ name: "v_persp_fixed", pitch: 50, projection: 1, fov: 40, pixelSize: 3, scaleMode: 1, pixelsPerMeter: 24 },
	// FOV 0 = 正交极限；俯角 0 = 平视
	{ name: "v_fov0", pitch: 45, projection: 1, fov: 0, pixelSize: 3, scaleMode: 0 },
	{ name: "v_fov0_adaptive", pitch: 45, projection: 1, fov: 0, pixelSize: 6, scaleMode: 0, pixelsPerMeter: 40 },
	{ name: "v_pitch0_persp", pitch: 0, projection: 1, fov: 50, pixelSize: 3, scaleMode: 0 },
	{ name: "v_pitch0_fov0_fixed", pitch: 0, projection: 1, fov: 0, pixelSize: 3, scaleMode: 1, pixelsPerMeter: 24 }
];
let viewFailures = 0;
for (const c of cases) {
	const view = TB.prepareView(mesh.bounds, Object.assign({ directions: 0, baseYaw: 0, padding: 8, fov: 50 }, c));
	const frame = TB.renderFrame(mesh, tiles, view, view.yaws[0], { antialias: true, outline: 0, transparent: true });
	fs.writeFileSync(path.join(out, c.name + ".png"), enc(frame));
	let opaque = 0;
	for (let i = 3; i < frame.data.length; i += 4) if (frame.data[i] > 0) opaque++;
	const ratio = opaque / (frame.width * frame.height);
	const numeric = Number.isFinite(view.orthoSize) && Number.isFinite(view.distance) &&
		Number.isFinite(view.near) && Number.isFinite(view.far);
	const ok = numeric && ratio > 0.05;
	if (!ok) viewFailures++;
	console.log((ok ? "PASS " : "FAIL ") + c.name, "canvas", view.canvas, "ortho", view.orthoSize.toFixed(3),
		"dist", view.distance.toFixed(2), "persp", view.perspective, "fovLimit", !!view.fovLimit, "opaque", (ratio * 100).toFixed(1) + "%");
}

// 8 方向 + 精灵表
const view = TB.prepareView(mesh.bounds, { pitch: 45, projection: 0, directions: 3, baseYaw: 0, pixelSize: 2, scaleMode: 0, pixelsPerMeter: 48, padding: 8 });
const frames = view.yaws.map((yaw) => TB.renderFrame(mesh, tiles, view, yaw, { antialias: true, outline: 0, transparent: true }));
const sheet = TB.composeSheet(frames, 16384);
fs.writeFileSync(path.join(out, "v_sheet8.png"), enc(sheet));
console.log("sheet8", sheet.width + "x" + sheet.height, "frames", frames.length, "yaws", view.yaws.join(","));
if (viewFailures) {
	console.error("视角用例失败：", viewFailures);
	process.exit(1);
}

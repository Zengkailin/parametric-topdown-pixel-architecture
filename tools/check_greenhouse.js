/** 温室玻璃替换效果检查（与浏览器里 resolveTiles 的 glazing 分支一致）。 */
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
function encodePng(frame) {
	const w = frame.width, h = frame.height, stride = w * 4;
	const raw = Buffer.alloc((stride + 1) * h);
	for (let y = 0; y < h; y++) {
		raw[y * (stride + 1)] = 0;
		Buffer.from(frame.data.buffer, frame.data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
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

const src = TB.atlasSources(loadAtlas("jiangnan"));
src.glass = { data: TB.glazingCell(), size: 32 };
const tiles = TB.buildTiles(src, { look: 0, appearanceSeed: 101 });
const params = TB.Catalog.parameters("greenhouse", "jiangnan");
const profile = { style: "jiangnan", typeId: "greenhouse", kind: 0, categoryId: "agriculture", shapeSeed: 60421, detailSeed: 101, appearanceSeed: 101, params };
const mesh = TB.buildBuilding(profile);
const view = TB.prepareView(mesh.bounds, { pitch: 45, projection: 0, directions: 0, baseYaw: 0, fov: 50, pixelSize: 3, scaleMode: 0, pixelsPerMeter: 48, padding: 8 });
fs.writeFileSync(path.join(__dirname, "_out", "greenhouse_glazing.png"), encodePng(TB.renderFrame(mesh, tiles, view, view.yaws[0], { antialias: true, outline: 0, transparent: true })));
console.log("ok");

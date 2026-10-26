/**
 * 把当前风格的 16 张纹理拼成一张接触表，检查图集裁格是否正确。
 * 用法：node tools/dump_tiles.js [style] [outName]
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const ROOT = path.join(__dirname, "..");
["util", "catalog", "atlases", "materials"].forEach((n) => require(path.join(ROOT, "js", n + ".js")));
const TB = globalThis.TB;

function decodePng(buf) {
	let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
	const idat = [];
	while (pos < buf.length) {
		const len = buf.readUInt32BE(pos);
		const type = buf.toString("ascii", pos + 4, pos + 8);
		const data = buf.subarray(pos + 8, pos + 8 + len);
		if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
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
	ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; ihdr[9] = 6;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function loadAtlas(style) {
	const text = fs.readFileSync(path.join(ROOT, "js", "atlases.js"), "utf8");
	const start = text.indexOf('data:image/png;base64,', text.indexOf('"' + style + '"'));
	const end = text.indexOf('"', start);
	const png = decodePng(Buffer.from(text.slice(start + 22, end), "base64"));
	return TB.makeAtlas(new Uint8ClampedArray(png.data), png.width);
}

const style = process.argv[2] || "jiangnan";
const out = process.argv[3] || ("tiles_" + style);
const atlas = loadAtlas(style);
const src = TB.atlasSources(atlas);
const cell = 128, cols = 4, rows = 4, pad = 4;
const W = cols * (cell + pad) + pad, H = rows * (cell + pad) + pad;
const data = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) { data[i * 4] = 40; data[i * 4 + 1] = 44; data[i * 4 + 2] = 48; data[i * 4 + 3] = 255; }
TB.ROLES.forEach((role, index) => {
	const cellData = TB.resizeNearest(src[role].data, src[role].size, src[role].size, cell, cell);
	const x0 = pad + (index % cols) * (cell + pad);
	const y0 = pad + ((index / cols) | 0) * (cell + pad);
	for (let y = 0; y < cell; y++) {
		for (let x = 0; x < cell; x++) {
			const s = (y * cell + x) * 4, d = ((y0 + y) * W + x0 + x) * 4;
			const a = cellData[s + 3] / 255;
			data[d] = cellData[s] * a + 40 * (1 - a);
			data[d + 1] = cellData[s + 1] * a + 44 * (1 - a);
			data[d + 2] = cellData[s + 2] * a + 48 * (1 - a);
			data[d + 3] = 255;
		}
	}
});
fs.mkdirSync(path.join(__dirname, "_out"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "_out", out + ".png"), encodePng(W, H, data));
console.log("wrote", out, "atlas", atlas.size, "cell", atlas.cell);

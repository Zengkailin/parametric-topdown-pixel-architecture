/**
 * Node 自测：不依赖浏览器，直接跑几何 + 光栅化，输出 PNG 供肉眼检查。
 *
 * 用法：
 *   node tools/selftest.js            # 渲染一组预设
 *   node tools/selftest.js <style> <type> <pitch> <dirs> <outName>
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
["util", "catalog", "atlases", "materials", "geometry", "view", "renderer"].forEach((name) => {
	require(path.join(ROOT, "js", name + ".js"));
});
const TB = globalThis.TB;

// ---------------------------------------------------------------------------
// PNG 编解码（仅用于自测）
// ---------------------------------------------------------------------------
function decodePng(buf) {
	let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
	const idat = [];
	while (pos < buf.length) {
		const len = buf.readUInt32BE(pos);
		const type = buf.toString("ascii", pos + 4, pos + 8);
		const data = buf.subarray(pos + 8, pos + 8 + len);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			bitDepth = data[8];
			colorType = data[9];
		} else if (type === "IDAT") {
			idat.push(data);
		} else if (type === "IEND") break;
		pos += 12 + len;
	}
	if (bitDepth !== 8 || colorType !== 6) throw new Error("仅支持 8bit RGBA PNG");
	const raw = zlib.inflateSync(Buffer.concat(idat));
	const stride = width * 4;
	const out = Buffer.alloc(width * height * 4);
	let prev = Buffer.alloc(stride);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const cur = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
		for (let x = 0; x < stride; x++) {
			const a = x >= 4 ? cur[x - 4] : 0;
			const b = prev[x];
			const c = x >= 4 ? prev[x - 4] : 0;
			if (filter === 1) cur[x] = (cur[x] + a) & 255;
			else if (filter === 2) cur[x] = (cur[x] + b) & 255;
			else if (filter === 3) cur[x] = (cur[x] + ((a + b) >> 1)) & 255;
			else if (filter === 4) {
				const p = a + b - c;
				const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
				const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
				cur[x] = (cur[x] + pr) & 255;
			}
		}
		cur.copy(out, y * stride);
		prev = cur;
	}
	return { width, height, data: out };
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(TB.crc32(body), 0);
	return Buffer.concat([len, body, crc]);
}

function encodePng(frame) {
	const { width, height, data } = frame;
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0;
		Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0))
	]);
}

// ---------------------------------------------------------------------------
// 素材
// ---------------------------------------------------------------------------
function loadBuiltinAtlas(style) {
	const file = path.join(ROOT, "js", "atlases.js");
	const text = fs.readFileSync(file, "utf8");
	const key = '"' + style + '"';
	const index = text.indexOf(key);
	if (index < 0) throw new Error("找不到内置图集 " + style);
	const start = text.indexOf("data:image/png;base64,", index);
	const end = text.indexOf('"', start);
	const b64 = text.slice(start + "data:image/png;base64,".length, end);
	const png = decodePng(Buffer.from(b64, "base64"));
	return TB.makeAtlas(new Uint8ClampedArray(png.data.buffer.slice(png.data.byteOffset, png.data.byteOffset + png.data.length)), png.width);
}

function tilesFor(style, look, appearanceSeed, useProcedural) {
	if (useProcedural) {
		const palette = TB.BUILTIN_ASSETS.palette[TB.geometryStyle(style)] || TB.BUILTIN_ASSETS.palette.jiangnan;
		const atlas = TB.proceduralAtlas(TB.paletteToRgb(palette), TB.geometryStyle(style), 128);
		return TB.buildTiles(TB.atlasSources(atlas), { look: look, appearanceSeed: appearanceSeed });
	}
	const atlas = loadBuiltinAtlas(style);
	return TB.buildTiles(TB.atlasSources(atlas), { look: look, appearanceSeed: appearanceSeed });
}

function renderOne(opts) {
	const params = Object.assign(TB.Catalog.parameters(opts.type, opts.style), opts.params || {});
	const profile = {
		style: opts.style,
		typeId: opts.type,
		kind: TB.Catalog.entry(opts.type).kind,
		categoryId: TB.Catalog.entry(opts.type).category,
		shapeSeed: opts.shapeSeed || 60421,
		detailSeed: opts.detailSeed || 101,
		appearanceSeed: opts.appearanceSeed || 101,
		params: params
	};
	const t0 = Date.now();
	const mesh = TB.buildBuilding(profile);
	const buildMs = Date.now() - t0;
	const view = TB.prepareView(mesh.bounds, {
		pitch: opts.pitch,
		projection: opts.projection || 0,
		directions: 0,
		baseYaw: opts.baseYaw || 0,
		fov: opts.fov || 50,
		pixelSize: opts.pixelSize === undefined ? 3 : opts.pixelSize,
		scaleMode: opts.scaleMode === undefined ? 0 : opts.scaleMode,
		pixelsPerMeter: opts.ppm || 48,
		padding: opts.padding === undefined ? 8 : opts.padding
	});
	const tiles = tilesFor(opts.style, 0, 101, opts.procedural);
	const t1 = Date.now();
	const frame = TB.renderFrame(mesh, tiles, view, view.yaws[0], {
		antialias: opts.antialias !== false,
		outlineInner: opts.outlineInner === undefined ? 0 : opts.outlineInner,
		outlineOuter: opts.outlineOuter === undefined ? 0 : opts.outlineOuter,
		outlineSilhouette: opts.outlineSilhouette === undefined ? 0 : opts.outlineSilhouette,
		partOutlines: opts.partOutlines || null,
		transparent: opts.transparent !== false,
		backgroundColor: "#ffffff"
	});
	const renderMs = Date.now() - t1;
	return { frame, mesh, view, buildMs, renderMs, params, profile };
}

function save(name, frame) {
	const outDir = path.join(__dirname, "_out");
	fs.mkdirSync(outDir, { recursive: true });
	const file = path.join(outDir, name + ".png");
	fs.writeFileSync(file, encodePng(frame));
	const opaque = (() => {
		let n = 0;
		for (let i = 3; i < frame.data.length; i += 4) if (frame.data[i] > 0) n++;
		return n / (frame.width * frame.height);
	})();
	console.log(
		"%s  %dx%d  三角 %d  构建 %dms  渲染 %dms  不透明 %s%%",
		name, frame.width, frame.height, 0, 0, 0, (opaque * 100).toFixed(1)
	);
	return file;
}

function run() {
	const args = process.argv.slice(2);
	if (args.length >= 4) {
		const result = renderOne({
			style: args[0], type: args[1], pitch: Number(args[2]),
			dirs: Number(args[3]), pixelSize: 3, procedural: args[4] === "proc"
		});
		console.log("三角面", result.mesh.triangles, "构建", result.buildMs + "ms", "渲染", result.renderMs + "ms");
		save(args[5] || "custom", result.frame);
		return;
	}

	const cases = [
		{ style: "jiangnan", type: "house", pitch: 39, name: "jiangnan_house_p39" },
		{ style: "jiangnan", type: "house", pitch: 30, name: "jiangnan_house_p30" },
		{ style: "forest", type: "house", pitch: 45, name: "forest_house_p45" },
		{ style: "desert", type: "watchtower", pitch: 30, name: "desert_tower_p30" },
		{ style: "jiangnan", type: "general_store", pitch: 45, name: "jiangnan_store_p45" },
		{ style: "jiangnan", type: "inn", pitch: 45, name: "jiangnan_inn_p45" },
		{ style: "forest", type: "farmhouse", pitch: 45, name: "forest_farmhouse_p45" },
		{ style: "desert", type: "market_stall", pitch: 45, name: "desert_stall_p45" },
		{ style: "jiangnan", type: "granary", pitch: 45, name: "jiangnan_granary_p45" },
		{ style: "jiangnan", type: "gate", pitch: 45, name: "jiangnan_gate_p45" },
		{ style: "jiangnan", type: "watchtower", pitch: 45, name: "jiangnan_watchtower_p45" },
		{ style: "jiangnan", type: "greenhouse", pitch: 45, name: "jiangnan_greenhouse_p45" },
		{ style: "forest", type: "house", pitch: 45, name: "forest_proc_house", procedural: true },
		{ style: "jiangnan", type: "house", pitch: 39, name: "jiangnan_house_outline", outlineInner: 2, outlineOuter: 1, outlineSilhouette: 2 },
		{ style: "desert", type: "house", pitch: 45, name: "desert_house_p45" },
		{ style: "jiangnan_pixel", type: "house", pitch: 45, name: "pixel_house_p45" }
	];
	for (const c of cases) {
		try {
			const r = renderOne(Object.assign({ pixelSize: 3, antialias: true }, c));
			console.log("%s  三角 %d  构建 %dms  渲染 %dms  画布 %dx%d",
				c.name, r.mesh.triangles, r.buildMs, r.renderMs, r.frame.width, r.frame.height);
			save(c.name, r.frame);
		} catch (err) {
			console.error("FAILED", c.name, err && err.stack || err);
		}
	}
}

run();

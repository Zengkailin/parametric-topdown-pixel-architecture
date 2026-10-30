"use strict";
/**
 * 内置图集访问层 + 磁盘缓存。
 *
 * 背景：js/atlases.js 是一个 7.6MB 的内嵌 base64 图集，解析它 + 解 PNG +
 * 建 mip 每次要 100ms 上下。agent 一次会话往往连续调十几条命令，所以这里
 * 把「风格元信息」和「解码后的 RGBA」缓到 cli/.cache/：
 *   - builtin_meta.json：名称 / 几何 / 调色板（list、schema、styles 用，不需要图集）
 *   - atlas_<指纹>_<id>.rgba：512×512×4 的原始像素
 * 缓存用 atlases.js 的体积+mtime 做指纹，插件重新生成图集后自动失效。
 * 设 TB_NO_CACHE=1 可完全绕过缓存。
 */
const fs = require("fs");
const path = require("path");
const env = require("./env");
const png = require("./png");
const json = require("./json");

const CACHE = path.join(env.ROOT, "cli", ".cache");
const NO_CACHE = process.env.TB_NO_CACHE === "1";

function tagOf(fingerprint) {
	return fingerprint.replace(/[^0-9a-zA-Z_-]/g, "-");
}

function ensureDir(dir) {
	try {
		fs.mkdirSync(dir, { recursive: true });
		return true;
	} catch (err) {
		return false;
	}
}

function metaFile() {
	return path.join(CACHE, "builtin_meta.json");
}

function readMeta() {
	if (NO_CACHE) return null;
	try {
		return json.read(metaFile());
	} catch (err) {
		return null;
	}
}

function writeMeta(meta) {
	if (NO_CACHE || !ensureDir(CACHE)) return;
	try {
		fs.writeFileSync(metaFile(), JSON.stringify(meta));
	} catch (err) {
		/* 缓存写不进去不影响出图 */
	}
}

let cachedMeta = null;

/** 内置风格的元信息（不含图集像素）。 */
function builtinStyles() {
	if (cachedMeta) return cachedMeta;
	const fingerprint = env.atlasesFingerprint();
	const cached = readMeta();
	if (cached && cached.fingerprint === fingerprint && Array.isArray(cached.styles)) {
		cachedMeta = cached;
		return cachedMeta;
	}
	const TB = env.loadAtlases();
	const assets = TB.BUILTIN_ASSETS;
	const styles = assets.atlases.map(function (asset) {
		const base = assets.palette[asset.geometry] || assets.palette.jiangnan;
		return {
			id: asset.id,
			name: asset.name,
			geometry: asset.geometry,
			builtin: true,
			note: asset.note || "",
			cell: asset.cell,
			size: asset.size,
			palette: TB.derivePalette(base)
		};
	});
	cachedMeta = { fingerprint: fingerprint, styles: styles };
	writeMeta(cachedMeta);
	return cachedMeta;
}

function builtinStyle(id) {
	const list = builtinStyles().styles;
	for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
	return null;
}

function atlasCacheFile(fingerprint, id, size) {
	return path.join(CACHE, "atlas_" + tagOf(fingerprint) + "_" + id + "_" + size + ".rgba");
}

/** 内置图集像素：{size, cell, data:Uint8ClampedArray} */
function builtinAtlas(id) {
	const meta = builtinStyles();
	const entry = builtinStyle(id);
	if (!entry) return null;
	const file = atlasCacheFile(meta.fingerprint, id, entry.size);
	if (!NO_CACHE) {
		try {
			const buffer = fs.readFileSync(file);
			const data = new Uint8ClampedArray(buffer.length);
			data.set(buffer);
			return env.loadCore().makeAtlas(data, entry.size);
		} catch (err) {
			/* 缓存缺失或损坏，走下面的解码路径 */
		}
	}
	const TB = env.loadAtlases();
	const asset = TB.BUILTIN_ASSETS.atlases.filter(function (row) { return row.id === id; })[0];
	if (!asset) return null;
	const image = png.fromDataURL(asset.data);
	const atlas = TB.makeAtlas(new Uint8ClampedArray(image.data), image.width);
	if (!NO_CACHE && ensureDir(CACHE)) {
		try {
			fs.writeFileSync(file, Buffer.from(atlas.data.buffer, atlas.data.byteOffset, atlas.data.byteLength));
			pruneAtlasCache(meta.fingerprint);
		} catch (err) {
			/* 忽略 */
		}
	}
	return atlas;
}

/** 删掉旧指纹留下的 .rgba，避免反复生成图集后缓存目录无限膨胀。 */
function pruneAtlasCache(fingerprint) {
	const keep = "atlas_" + tagOf(fingerprint) + "_";
	let names = [];
	try {
		names = fs.readdirSync(CACHE);
	} catch (err) {
		return;
	}
	names.forEach(function (name) {
		if (name.startsWith("atlas_") && name.endsWith(".rgba") && !name.startsWith(keep)) {
			try { fs.unlinkSync(path.join(CACHE, name)); } catch (err) { /* 忽略 */ }
		}
	});
}

module.exports = { CACHE, builtinStyles, builtinStyle, builtinAtlas };

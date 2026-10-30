"use strict";
/**
 * 渲染引擎 + 产物落盘。
 *
 * 引擎负责把「风格 → 16 张纹理 → 打上部件覆盖」缓存起来，批量渲染时
 * 同一风格的图集只解析一次、mip 只建一次；这是 batch 比多次单独调用
 * 快得多的原因。
 */
const fs = require("fs");
const path = require("path");
const env = require("./env");
const png = require("./png");
const styles = require("./styles");
const config = require("./config");
const embedded = require("./embedded");

const OUT_ROOT = path.join(env.ROOT, "cli", "out");

function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
}

function sanitizeName(name) {
	return String(name).replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "building";
}

function createEngine(inlineStyle) {
	const TB = env.loadCore();
	const sourceCache = new Map();
	const tileCache = new Map();
	const styleCache = new Map();

	function styleOf(id) {
		if (inlineStyle && inlineStyle.id === id) return inlineStyle;
		if (styleCache.has(id)) return styleCache.get(id);
		const style = styles.resolve(id);
		if (!style) throw config.unknownStyle(id);
		styleCache.set(id, style);
		return style;
	}

	function sourcesFor(style, greenhouse) {
		const key = style.stamp + (greenhouse ? ":glazing" : "");
		if (sourceCache.has(key)) return sourceCache.get(key);
		const result = styles.sources(style, greenhouse);
		sourceCache.set(key, result);
		return result;
	}

	/** 风格本身的 16 张纹理（母本，绝不写回缓存被染色污染）。 */
	function baseTiles(style, look, appearanceSeed, greenhouse) {
		const key = [style.stamp, look, appearanceSeed, greenhouse ? 1 : 0].join(":");
		if (tileCache.has(key)) return tileCache.get(key);
		const tiles = TB.buildTiles(sourcesFor(style, greenhouse), { look: look, appearanceSeed: appearanceSeed });
		tileCache.set(key, tiles);
		return tiles;
	}

	function tintTileData(data, hex) {
		const color = TB.hexToRgb(hex);
		const out = new Uint8ClampedArray(data.length);
		for (let i = 0; i < data.length; i += 4) {
			out[i] = data[i] * color[0] / 255;
			out[i + 1] = data[i + 1] * color[1] / 255;
			out[i + 2] = data[i + 2] * color[2] / 255;
			out[i + 3] = data[i + 3];
		}
		return out;
	}

	/** 叠加部件级覆盖（染色 / 换图），与 app.js#applyPartOverrides 同义。 */
	function tilesFor(cfg, style) {
		const greenhouse = cfg.typeId === "greenhouse";
		const base = baseTiles(style, cfg.look, cfg.appearanceSeed, greenhouse);
		const roles = Object.keys(cfg.partOverrides || {}).filter(function (role) {
			const part = cfg.partOverrides[role];
			return part && (part.tint || part.texture);
		});
		if (!roles.length) return base;
		const tiles = Object.assign({}, base);
		roles.forEach(function (role) {
			const part = cfg.partOverrides[role];
			const target = role === "roof" ? 64 : 128;
			let data = null;
			if (part.texture) {
				const image = png.fromDataURL(part.texture);
				if (image.width !== image.height) return;
				data = TB.resizeNearest(new Uint8ClampedArray(image.data), image.width, image.height, target, target);
				if (TB.COMPONENT_ROLES.indexOf(role) < 0) TB.blendBorder(data, target);
			} else if (base[role]) {
				data = new Uint8ClampedArray(base[role].data);
			}
			if (!data) return;
			if (part.tint && part.tint.toLowerCase() !== "#ffffff") data = tintTileData(data, part.tint);
			tiles[role] = { w: target, h: target, data: data, mips: TB.makeMips(data, target, target) };
		});
		return tiles;
	}

	/** 渲染一个配置：返回 { mesh, view, frames, tiles, style }。 */
	function render(cfg) {
		const started = Date.now();
		const style = styleOf(cfg.styleId);
		const profile = config.buildProfile(cfg);
		const mesh = TB.buildBuilding(profile);
		const view = TB.prepareView(mesh.bounds, Object.assign({}, cfg.view));
		if (!view) throw new Error("该参数没有生成可绘制的几何（包围盒为空）");
		const tiles = tilesFor(cfg, style);
		const options = config.renderOptions(cfg);
		const frames = view.yaws.map(function (yaw) { return TB.renderFrame(mesh, tiles, view, yaw, options); });
		return {
			style: style, profile: profile, mesh: mesh, view: view, tiles: tiles, frames: frames,
			ms: Date.now() - started,
			identity: TB.recipeIdentity(profile)
		};
	}

	return { render: render, styleOf: styleOf };
}

// ---------------------------------------------------------------------------
// 产物命名 / 落盘
// ---------------------------------------------------------------------------
function defaultBase(cfg, view, opts) {
	if (opts.name) return sanitizeName(opts.name);
	const parts = [cfg.styleId, cfg.typeId, "p" + Math.round(view.pitch), view.yaws.length + "d"];
	const r = cfg.render;
	const inner = Number(r.outlineInner) || 0, outer = Number(r.outlineOuter) || 0, sil = Number(r.outlineSilhouette) || 0;
	if (inner > 0 || outer > 0 || sil > 0) parts.push("oi" + inner + "oo" + outer + (sil > 0 ? "os" + sil : ""));
	if (!r.antialias) parts.push("noaa");
	if (Number(cfg.look) > 0) parts.push("look" + cfg.look);
	if (view.adaptive) parts.push("auto");
	return sanitizeName(parts.join("_"));
}

function visibleRoles(frame) {
	const TB = env.loadCore();
	const counts = new Uint32Array(TB.PAINT_ROLES.length);
	const pick = frame.pick;
	if (!pick) return [];
	for (let i = 0; i < pick.length; i++) {
		if (pick[i] !== 255) counts[pick[i]]++;
	}
	const total = frame.width * frame.height;
	const rows = [];
	for (let i = 0; i < counts.length; i++) {
		if (counts[i] / total >= 0.005) rows.push([TB.PAINT_ROLES[i], Math.round(counts[i] / total * 1000) / 1000]);
	}
	rows.sort(function (a, b) { return b[1] - a[1]; });
	return rows.map(function (row) { return row[0]; });
}

/** 输出统一用相对 cwd 的正斜杠路径，跨平台可读、JSON 里也不出现反斜杠转义。 */
function relPath(target) {
	const rel = path.relative(process.cwd(), path.resolve(target));
	return (rel || target).split(path.sep).join("/");
}

/**
 * 写产物。
 * opts: { out, name, sheet, zip, thumb, saveRecipe, meta }
 */
function writeOutputs(cfg, result, opts) {
	const TB = env.loadCore();
	const view = result.view;
	const frames = result.frames;
	const base = defaultBase(cfg, view, opts);
	const files = [];
	const thumbs = [];
	const recipe = config.recipeDocument(cfg, view, result.identity, result.style);
	const multi = frames.length > 1 || opts.sheet || opts.zip;
	const meta = opts.meta === false ? null : embedded.forPng(recipe, config.TOOL_VERSION);
	const text = meta ? embedded.entries(meta.doc, config.TOOL_VERSION) : null;

	function encode(frame) {
		return png.encode(frame.width, frame.height, frame.data, text ? { text: text } : undefined);
	}

	let outRoot = opts.out === undefined ? path.join(OUT_ROOT, multi ? base : base + ".png") : String(opts.out);
	let dir = null;
	let singleFile = null;

	if (multi) {
		dir = outRoot;
		if (/\.(png|zip)$/i.test(dir)) dir = dir.replace(/\.(png|zip)$/i, "");
	} else if (/\.png$/i.test(outRoot)) {
		singleFile = outRoot;
	} else {
		dir = outRoot;
	}

	if (singleFile) {
		ensureDir(path.dirname(path.resolve(singleFile)));
		fs.writeFileSync(singleFile, encode(frames[0]));
		files.push(relPath(singleFile));
	} else {
		ensureDir(dir);
		frames.forEach(function (frame, index) {
			const file = path.join(dir, "dir_" + index + ".png");
			fs.writeFileSync(file, encode(frame));
			files.push(relPath(file));
		});
	}

	let sheetInfo = null;
	let sheetFrame = null;
	if (opts.sheet || opts.zip) {
		sheetFrame = TB.composeSheet(frames, 16384);
		const target = singleFile
			? singleFile.replace(/\.png$/i, "_sheet.png")
			: path.join(dir, "sheet.png");
		ensureDir(path.dirname(path.resolve(target)));
		fs.writeFileSync(target, encode(sheetFrame));
		sheetInfo = { file: relPath(target), size: [sheetFrame.width, sheetFrame.height] };
	}

	let recipeFile = null;
	const recipeBytes = Buffer.from(JSON.stringify(recipe, null, 2));
	if (opts.saveRecipe) {
		ensureDir(path.dirname(path.resolve(opts.saveRecipe)));
		fs.writeFileSync(opts.saveRecipe, recipeBytes);
		recipeFile = relPath(opts.saveRecipe);
	}

	let zipFile = null;
	if (opts.zip) {
		const entries = [];
		frames.forEach(function (frame, index) {
			entries.push({ name: "dir_" + index + ".png", data: encode(frame) });
		});
		if (sheetFrame) entries.push({ name: "sheet.png", data: encode(sheetFrame) });
		entries.push({ name: "recipe.json", data: recipeBytes });
		const target = typeof opts.zip === "string" && opts.zip !== "true"
			? opts.zip
			: (singleFile ? singleFile.replace(/\.png$/i, ".zip") : dir.replace(/[\\/]+$/, "") + ".zip");
		ensureDir(path.dirname(path.resolve(target)));
		fs.writeFileSync(target, TB.zip(entries));
		zipFile = relPath(target);
	}

	if (opts.thumb) {
		const maxSide = opts.thumb === true ? 128 : Math.max(16, Math.round(Number(opts.thumb) || 128));
		const targets = [{ frame: frames[0], stem: files[0].replace(/\.png$/i, "") }];
		if (sheetFrame && sheetInfo) targets.push({ frame: sheetFrame, stem: sheetInfo.file.replace(/\.png$/i, "") });
		targets.forEach(function (item) {
			const small = png.downscale(item.frame.data, item.frame.width, item.frame.height, maxSide);
			const file = item.stem + "_thumb" + maxSide + ".png";
			fs.writeFileSync(file, encode(small));
			thumbs.push({ file: file, size: [small.width, small.height] });
		});
	}

	const first = frames[0];
	const bg = Number(cfg.render.background) === 1 ? TB.hexToRgb(cfg.render.backgroundColor || "#2a2e33") : null;
	const stats = png.analyze(first.data, first.width, first.height, bg);
	return {
		files: files,
		thumbs: thumbs.map(function (row) { return row.file; }),
		sheet: sheetInfo,
		zip: zipFile,
		recipe: recipeFile,
		meta: meta ? { version: config.TOOL_VERSION, format: embedded.FORMAT, textures: meta.stripped ? "omitted" : "included" } : false,
		stats: stats,
		visible: visibleRoles(first)
	};
}

module.exports = { OUT_ROOT, createEngine, writeOutputs, defaultBase, ensureDir };

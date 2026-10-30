"use strict";
/**
 * 配置层：命令行选项 → 配置对象；配置对象 ↔ 配方 JSON。
 *
 * 配置结构与网页 localStorage 里的 tb_topdown_config_v1 一致：
 *   { styleId, categoryId, typeId, look, shapeSeed, detailSeed, appearanceSeed,
 *     params, view, render, partOverrides }
 * 这样 CLI 产出的 recipe.json 能直接丢回网页，网页导出的配方也能直接拿来渲染。
 */
const fs = require("fs");
const path = require("path");
const env = require("./env");
const png = require("./png");
const json = require("./json");
const spec = require("./spec");
const styles = require("./styles");
const embedded = require("./embedded");

const TOOL_VERSION = "1.1";
const DEFAULT_CONFIG = {
	styleId: "jiangnan",
	categoryId: "residential",
	typeId: "house",
	look: 0,
	shapeSeed: 60421,
	detailSeed: 101,
	appearanceSeed: 101,
	params: {},
	view: { pitch: 45, projection: 0, directions: 0, baseYaw: 0, fov: 50, pixelSize: 3, scaleMode: 0, pixelsPerMeter: 48, padding: 8 },
	render: {
		outlineInner: 0, outlineOuter: 0, outlineSilhouette: 0,
		antialias: true, background: 0, backgroundColor: "#2a2e33",
		outlineColor: "#140f0d", outlineColorOuter: "#140f0d", outlineColorSilhouette: "#140f0d",
		depthThreshold: 0.15, normalThreshold: 0.3
	},
	partOverrides: {}
};
const SIZE_INDEX = { 128: 0, 256: 1, 384: 2, 512: 3, 768: 4, 1024: 5, auto: 6 };
const DIR_INDEX = { 1: 0, 2: 1, 4: 2, 8: 3 };

function clone(value) { return JSON.parse(JSON.stringify(value)); }

/** 颜色归一：容忍省略 # 与 #rgb 简写，统一成小写 #rrggbb。 */
function hexOrNull(value) {
	if (typeof value !== "string") return null;
	let text = value.trim().replace(/^#/, "");
	if (/^[0-9a-fA-F]{3}$/.test(text)) text = text.split("").map(function (c) { return c + c; }).join("");
	if (!/^[0-9a-fA-F]{6}$/.test(text)) return null;
	return "#" + text.toLowerCase();
}

function cleanWidth(value) {
	if (value === null || value === undefined || value === "") return null;
	const n = Number(value);
	if (!isFinite(n)) return null;
	return Math.max(0, Math.min(16, n));
}

function normalizePartOverrides(raw) {
	const TB = env.loadCore();
	const out = {};
	if (!raw || typeof raw !== "object") return out;
	Object.keys(raw).forEach(function (role) {
		if (TB.ROLES.indexOf(role) < 0) return;
		const entry = raw[role] || {};
		const tint = hexOrNull(entry.tint);
		const texture = typeof entry.texture === "string" && entry.texture.indexOf("data:image/") === 0 ? entry.texture : null;
		const inner = cleanWidth(entry.inner);
		const outer = cleanWidth(entry.outer);
		const innerColor = hexOrNull(entry.innerColor);
		const outerColor = hexOrNull(entry.outerColor);
		if (!tint && !texture && inner === null && outer === null && !innerColor && !outerColor) return;
		out[role] = {
			tint: tint,
			texture: texture,
			textureFrom: texture ? String(entry.textureFrom || "").slice(0, 80) || null : null,
			inner: inner, outer: outer, innerColor: innerColor, outerColor: outerColor
		};
	});
	return out;
}

/** 与 app.js#normalizeConfig 同义的端口（去掉浏览器相关部分）。 */
function normalize(raw) {
	const TB = env.loadCore();
	const cfg = clone(DEFAULT_CONFIG);
	if (!raw || typeof raw !== "object") {
		cfg.params = TB.Catalog.parameters(cfg.typeId, cfg.styleId);
		return cfg;
	}
	if (raw.styleId) cfg.styleId = String(raw.styleId);
	const entry = TB.Catalog.entry(raw.typeId || cfg.typeId);
	cfg.typeId = entry ? entry.id : cfg.typeId;
	cfg.categoryId = (entry ? entry.category : raw.categoryId) || cfg.categoryId;
	cfg.look = TB.clampInt(raw.look || 0, 0, 3);
	cfg.shapeSeed = Number(raw.shapeSeed) || 60421;
	cfg.detailSeed = Number(raw.detailSeed) || 101;
	cfg.appearanceSeed = Number(raw.appearanceSeed) || 101;
	cfg.params = Object.assign(TB.Catalog.parameters(cfg.typeId, cfg.styleId), raw.params || {});
	cfg.view = Object.assign({}, DEFAULT_CONFIG.view, raw.view || {});
	cfg.render = Object.assign({}, DEFAULT_CONFIG.render, raw.render || {});
	cfg.render.outlineInner = Number(cfg.render.outlineInner) || 0;
	cfg.render.outlineOuter = Number(cfg.render.outlineOuter) || 0;
	cfg.render.outlineSilhouette = Number(cfg.render.outlineSilhouette) || 0;
	cfg.partOverrides = normalizePartOverrides(raw.partOverrides);
	return cfg;
}

// ---------------------------------------------------------------------------
// 命令行 → 配置
// ---------------------------------------------------------------------------
function readPartTexture(file) {
	const image = png.decodeFile(file);
	if (image.width !== image.height) throw new Error("部件贴图必须是正方形：" + file);
	return png.toDataURL(fs.readFileSync(file));
}

/** --part role:key=value 解析（支持同一角色多条合并）。 */
function parsePartSpec(list) {
	const out = {};
	(list || []).forEach(function (token) {
		const match = /^([a-z_]+):([A-Za-z]+)=(.*)$/.exec(String(token));
		if (!match) throw new Error("--part 需要 role:key=value 形式，收到：" + token);
		const role = match[1], key = match[2], value = match[3];
		if (env.loadCore().ROLES.indexOf(role) < 0) throw new Error("未知材质角色：" + role + "（见 list roles）");
		const entry = out[role] || (out[role] = {});
		if (key === "tint" || key === "innerColor" || key === "outerColor") {
			const hex = hexOrNull(value);
			if (!hex) throw new Error(key + " 需要 #rrggbb 颜色：" + value);
			entry[key] = hex;
		} else if (key === "inner" || key === "outer") {
			entry[key] = Number(value);
		} else if (key === "texture") {
			entry.texture = readPartTexture(value);
			entry.textureFrom = path.basename(value);
		} else {
			throw new Error("--part 不认识的键：" + key + "（可用 tint/texture/inner/innerColor/outer/outerColor）");
		}
	});
	return out;
}

function parseParamFlags(list, warnings) {
	const out = {};
	(list || []).forEach(function (token) {
		const index = String(token).indexOf("=");
		if (index < 0) throw new Error("--param 需要 k=v 形式，收到：" + token);
		const key = String(token).slice(0, index);
		const raw = String(token).slice(index + 1);
		const def = spec.PARAM_SPEC[key];
		if (!def) throw new Error("未知建筑参数：" + key + "（可用：" + Object.keys(spec.PARAM_SPEC).join(" ") + "）");
		if (def.bool) {
			out[key] = raw === "true" || raw === "1" || raw === "";
		} else if (def.enum) {
			out[key] = spec.clampNumber(key, raw, def, warnings);
		} else {
			out[key] = spec.clampNumber(key, raw, def, warnings);
		}
	});
	return out;
}

function unknownType(name) {
	const TB = env.loadCore();
	const tips = spec.suggest(name, TB.Catalog.types().map(function (row) { return row.id; }));
	return new Error("未知建筑类型：" + name + "（见 list types" + (tips.length ? "；相近的有 " + tips.join(" / ") : "") + "）");
}

function unknownStyle(name) {
	const tips = spec.suggest(name, styles.all().map(function (row) { return row.id; }));
	return new Error("未知风格：" + name + "（见 list styles" + (tips.length ? "；相近的有 " + tips.join(" / ") : "") + "）");
}

/**
 * 把 render 的选项解析成配置。
 * opts.first/second 是位置参数（style / type）。
 */
function fromArgs(args, options) {
	options = options || {};
	const TB = env.loadCore();
	const warnings = [];
	const positionals = args._.slice();
	const cfg = clone(DEFAULT_CONFIG);
	cfg.params = TB.Catalog.parameters(cfg.typeId, cfg.styleId);

	// 基线优先级：--preset / 外部传入的 base > --recipe > 类型默认值；命令行始终可以覆盖
	let base = null;
	if (options.base) {
		base = normalize(options.base);
	} else if (args.recipe) {
		const doc = embedded.readRecipeDoc(String(args.recipe));
		base = configFromRecipe(doc).cfg;
	}
	const merged = base ? Object.assign(clone(DEFAULT_CONFIG), base) : null;
	if (merged) {
		Object.assign(cfg, merged);
		cfg.params = Object.assign({}, merged.params);
		cfg.view = Object.assign({}, merged.view);
		cfg.render = Object.assign({}, merged.render);
		cfg.partOverrides = clone(merged.partOverrides || {});
	}

	// style / type：位置参数或选项
	let styleArg = args.style, typeArg = args.type;
	let styleFromPositional = false;
	if (styleArg === undefined && positionals.length) {
		styleArg = positionals.shift();
		styleFromPositional = true;
	}
	if (typeArg === undefined && positionals.length) typeArg = positionals.shift();
	// 只写了一个位置参数、而且它其实是建筑类型（如 `render inn`）时，按类型理解
	if (styleFromPositional && typeArg === undefined && !styles.resolve(String(styleArg)) && TB.Catalog.entry(String(styleArg))) {
		typeArg = styleArg;
		styleArg = undefined;
		warnings.push("位置参数 " + typeArg + " 按建筑类型处理（它不是风格 id）");
	}
	if (positionals.length) warnings.push("多余的位置参数已忽略：" + positionals.join(" "));

	if (styleArg !== undefined) cfg.styleId = String(styleArg);
	if (typeArg !== undefined) {
		const picked = TB.Catalog.entry(String(typeArg));
		if (!picked) throw unknownType(String(typeArg));
		cfg.typeId = picked.id;
		cfg.categoryId = picked.category;
	}
	const entry = TB.Catalog.entry(cfg.typeId);
	if (!entry) throw unknownType(cfg.typeId);
	cfg.categoryId = entry.category;

	// 参数：类型默认值 → 配方 → 命令行
	if (!merged) cfg.params = TB.Catalog.parameters(cfg.typeId, cfg.styleId);
	Object.assign(cfg.params, parseParamFlags(args.param, warnings));

	if (args.seed !== undefined) cfg.shapeSeed = Math.max(1, Math.round(Number(args.seed)) || 60421);
	if (args.dseed !== undefined) cfg.detailSeed = Math.max(1, Math.round(Number(args.dseed)) || 101);
	if (args.aseed !== undefined) cfg.appearanceSeed = Math.max(1, Math.round(Number(args.aseed)) || 101);
	if (args.look !== undefined) cfg.look = TB.clampInt(Number(args.look), 0, 3);

	if (args.random) {
		cfg.shapeSeed = randomSeed();
		cfg.detailSeed = randomSeed();
		cfg.params = TB.Catalog.parameters(cfg.typeId, cfg.styleId, cfg.shapeSeed, true);
		Object.assign(cfg.params, parseParamFlags(args.param, warnings));
	} else if (args["random-detail"]) {
		cfg.detailSeed = randomSeed();
	} else if (args.replay) {
		cfg.params = TB.Catalog.parameters(cfg.typeId, cfg.styleId, cfg.shapeSeed, true);
		Object.assign(cfg.params, parseParamFlags(args.param, warnings));
	}

	// 视角
	const view = cfg.view;
	if (args.pitch !== undefined) view.pitch = spec.clampNumber("pitch", args.pitch, spec.RANGE.pitch, warnings);
	if (args.proj !== undefined) {
		const proj = String(args.proj);
		if (proj !== "ortho" && proj !== "persp") throw new Error("--proj 只能是 ortho 或 persp");
		view.projection = proj === "persp" ? 1 : 0;
	}
	if (args.fov !== undefined) view.fov = spec.clampNumber("fov", args.fov, spec.RANGE.fov, warnings);
	if (args.dirs !== undefined) {
		const count = Number(args.dirs);
		if (!(count in DIR_INDEX)) throw new Error("--dirs 只能是 1 / 2 / 4 / 8");
		view.directions = DIR_INDEX[count];
	}
	if (args.yaw !== undefined) view.baseYaw = spec.clampNumber("yaw", args.yaw, spec.RANGE.yaw, warnings);
	if (args.size !== undefined) {
		const raw = String(args.size);
		const key = raw === "auto" ? "auto" : String(Number(raw));
		if (!(key in SIZE_INDEX)) throw new Error("--size 只能是 " + spec.ENUMS.size.join(" / "));
		view.pixelSize = SIZE_INDEX[key];
	}
	if (args.scale !== undefined) {
		const scale = String(args.scale);
		if (scale === "auto") view.scaleMode = 0;
		else if (scale === "fixed") view.scaleMode = 1;
		else throw new Error("--scale 只能是 auto 或 fixed");
	}
	if (args.ppm !== undefined) view.pixelsPerMeter = spec.clampNumber("ppm", args.ppm, spec.RANGE.ppm, warnings);
	if (args.padding !== undefined) view.padding = spec.clampNumber("padding", args.padding, spec.RANGE.padding, warnings);

	// 渲染
	const render = cfg.render;
	if (args["outline-inner"] !== undefined) render.outlineInner = spec.clampNumber("outline-inner", args["outline-inner"], spec.RANGE.outlineInner, warnings);
	if (args["outline-outer"] !== undefined) render.outlineOuter = spec.clampNumber("outline-outer", args["outline-outer"], spec.RANGE.outlineOuter, warnings);
	if (args["outline-silhouette"] !== undefined) render.outlineSilhouette = spec.clampNumber("outline-silhouette", args["outline-silhouette"], spec.RANGE.outlineSilhouette, warnings);
	["outline-color", "outline-color-outer", "outline-color-silhouette"].forEach(function (key) {
		if (args[key] === undefined) return;
		const hex = hexOrNull(String(args[key]));
		if (!hex) throw new Error("--" + key + " 需要 #rrggbb");
		if (key === "outline-color") render.outlineColor = hex;
		else if (key === "outline-color-outer") render.outlineColorOuter = hex;
		else render.outlineColorSilhouette = hex;
	});
	if (args.aa !== undefined) render.antialias = args.aa !== false && args.aa !== "false";
	if (args.bg !== undefined) {
		const bg = String(args.bg);
		if (bg === "transparent") render.background = 0;
		else {
			const hex = hexOrNull(bg);
			if (!hex) throw new Error("--bg 只能是 transparent 或 #rrggbb");
			render.background = 1;
			render.backgroundColor = hex;
		}
	}

	// 部件覆盖
	if (args["clear-parts"]) cfg.partOverrides = {};
	let parts = parsePartSpec(args.part);
	if (args["parts-json"] !== undefined) {
		const raw = String(args["parts-json"]);
		const text = fs.existsSync(raw) ? fs.readFileSync(raw, "utf8") : raw;
		let parsed;
		try {
			parsed = json.parse(text, "--parts-json");
		} catch (err) {
			err.hint = "内联 JSON 常被 shell 吃掉引号；把 JSON 写成文件再传路径更稳：--parts-json parts.json";
			throw err;
		}
		Object.keys(parsed).forEach(function (role) {
			parts[role] = Object.assign({}, parts[role] || {}, parsed[role]);
		});
	}
	if (Object.keys(parts).length) {
		cfg.partOverrides = Object.assign({}, cfg.partOverrides, normalizePartOverrides(parts));
	}

	// 风格存在性
	const style = options.inlineStyle || styles.resolve(cfg.styleId);
	if (!style) throw unknownStyle(cfg.styleId);
	cfg.styleId = style.id;

	return { cfg: normalize(cfg), warnings: warnings, style: style };
}

function randomSeed() {
	return Math.floor(Math.random() * 2147483646) + 1;
}

// ---------------------------------------------------------------------------
// 配置 → profile / view / render 选项
// ---------------------------------------------------------------------------
function buildProfile(cfg) {
	const TB = env.loadCore();
	const entry = TB.Catalog.entry(cfg.typeId) || TB.Catalog.entry("house");
	return {
		style: cfg.styleId,
		typeId: entry.id,
		kind: entry.kind,
		categoryId: entry.category,
		shapeSeed: cfg.shapeSeed,
		detailSeed: cfg.detailSeed,
		appearanceSeed: cfg.appearanceSeed,
		params: Object.assign({}, cfg.params)
	};
}

function partOutlineOptions(cfg) {
	const out = {};
	Object.keys(cfg.partOverrides || {}).forEach(function (role) {
		const part = cfg.partOverrides[role] || {};
		const entry = {};
		if (part.inner !== undefined && part.inner !== null) entry.inner = Number(part.inner) || 0;
		if (part.innerColor) entry.innerColor = part.innerColor;
		if (part.outer !== undefined && part.outer !== null) entry.outer = Number(part.outer) || 0;
		if (part.outerColor) entry.outerColor = part.outerColor;
		if (Object.keys(entry).length) out[role] = entry;
	});
	return out;
}

function renderOptions(cfg) {
	const r = cfg.render;
	return {
		antialias: !!r.antialias,
		outlineInner: Number(r.outlineInner) || 0,
		outlineOuter: Number(r.outlineOuter) || 0,
		outlineSilhouette: Number(r.outlineSilhouette) || 0,
		outlineColor: r.outlineColor || "#140f0d",
		outlineColorOuter: r.outlineColorOuter || r.outlineColor || "#140f0d",
		outlineColorSilhouette: r.outlineColorSilhouette || r.outlineColorOuter || r.outlineColor || "#140f0d",
		partOutlines: partOutlineOptions(cfg),
		transparent: Number(r.background) === 0,
		backgroundColor: r.backgroundColor,
		depthThreshold: Number(r.depthThreshold),
		normalThreshold: Number(r.normalThreshold)
	};
}

// ---------------------------------------------------------------------------
// 配方
// ---------------------------------------------------------------------------
function recipeDocument(cfg, view, identity, style) {
	const TB = env.loadCore();
	return {
		tool: "topdown-building-studio-cli",
		toolVersion: TOOL_VERSION,
		version: 1,
		generatedAt: new Date().toISOString(),
		style: {
			id: style.id,
			name: style.name,
			geometry: TB.geometryStyle(style.geometry),
			source: style.builtin ? "builtin-atlas" : (style.atlas ? "custom-atlas" : "palette"),
			atlasSize: style.atlas ? style.atlas.size : null,
			overrides: Object.keys(style.overrides || {}),
			palette: style.palette
		},
		profile: buildProfile(cfg),
		view: {
			pitch: view.pitch,
			projection: view.perspective ? "perspective" : "orthographic",
			projectionRequested: view.projectionRequested ? "perspective" : "orthographic",
			fov: view.fov,
			fovLimit: view.fovLimit,
			canvas: view.canvas,
			directions: view.yaws.length,
			baseYaw: cfg.view.baseYaw,
			scaleMode: view.fixed ? "fixed-ppm" : "auto",
			pixelsPerMeter: view.ppm,
			padding: view.padding,
			orthoSize: view.orthoSize
		},
		render: {
			outline: Number(cfg.render.outlineInner) || 0,
			outlineInner: Number(cfg.render.outlineInner) || 0,
			outlineOuter: Number(cfg.render.outlineOuter) || 0,
			outlineSilhouette: Number(cfg.render.outlineSilhouette) || 0,
			outlineColor: cfg.render.outlineColor || "#140f0d",
			outlineColorOuter: cfg.render.outlineColorOuter || "#140f0d",
			outlineColorSilhouette: cfg.render.outlineColorSilhouette || "#140f0d",
			outlineSemantics: { inner: "几何内侧（按部件分界）", outer: "部件外扩（可压到别的部件）", silhouette: "整栋剪影外扩到背景" },
			antialias: !!cfg.render.antialias,
			background: Number(cfg.render.background) === 1 ? cfg.render.backgroundColor : "transparent"
		},
		parts: Object.keys(cfg.partOverrides || {}).reduce(function (acc, role) {
			const part = cfg.partOverrides[role];
			acc[role] = {
				tint: part.tint || null,
				texture: part.texture ? "embedded" : null,
				textureFrom: part.textureFrom || null,
				outlineInner: part.inner === undefined || part.inner === null ? null : Number(part.inner),
				outlineInnerColor: part.innerColor || null,
				outlineOuter: part.outer === undefined || part.outer === null ? null : Number(part.outer),
				outlineOuterColor: part.outerColor || null
			};
			return acc;
		}, {}),
		look: cfg.look,
		outputFolder: identity,
		// 精确回放用：完整的配置对象（网页端能直接读，CLI 也优先用它）
		config: clone({
			styleId: cfg.styleId,
			categoryId: cfg.categoryId,
			typeId: cfg.typeId,
			look: cfg.look,
			shapeSeed: cfg.shapeSeed,
			detailSeed: cfg.detailSeed,
			appearanceSeed: cfg.appearanceSeed,
			params: cfg.params,
			view: cfg.view,
			render: cfg.render,
			partOverrides: cfg.partOverrides
		}),
		note: "无光照渲染：颜色只来自材质图集 × 顶点染色；几何移植自 Godot addon hd2d_scene_tools（v5 配方）。"
	};
}

/** 配方 JSON → 配置（优先用 config 字段，缺失时从老格式字段反推）。 */
function configFromRecipe(doc) {
	const TB = env.loadCore();
	if (doc && doc.config) return { cfg: normalize(doc.config), partial: false };
	if (!doc || !doc.profile) throw new Error("配方缺少 profile 字段");
	const reverseDirs = { 1: 0, 2: 1, 4: 2, 8: 3 };
	const cfg = clone(DEFAULT_CONFIG);
	cfg.styleId = doc.style && doc.style.id ? doc.style.id : cfg.styleId;
	cfg.typeId = doc.profile.typeId || cfg.typeId;
	const entry = TB.Catalog.entry(cfg.typeId);
	if (entry) cfg.categoryId = entry.category;
	cfg.shapeSeed = doc.profile.shapeSeed || cfg.shapeSeed;
	cfg.detailSeed = doc.profile.detailSeed || cfg.detailSeed;
	cfg.appearanceSeed = doc.profile.appearanceSeed || cfg.appearanceSeed;
	cfg.look = TB.clampInt(doc.look || 0, 0, 3);
	cfg.params = Object.assign(TB.Catalog.parameters(cfg.typeId, cfg.styleId), doc.profile.params || {});
	const view = doc.view || {};
	cfg.view.pitch = view.pitch === undefined ? cfg.view.pitch : Number(view.pitch);
	cfg.view.projection = view.projectionRequested === "perspective" || view.projection === "perspective" ? 1 : 0;
	cfg.view.fov = view.fov === undefined ? cfg.view.fov : Number(view.fov);
	cfg.view.directions = reverseDirs[view.directions] === undefined ? cfg.view.directions : reverseDirs[view.directions];
	cfg.view.baseYaw = view.baseYaw === undefined ? 0 : Number(view.baseYaw);
	cfg.view.scaleMode = view.scaleMode === "fixed-ppm" ? 1 : 0;
	cfg.view.pixelsPerMeter = view.pixelsPerMeter === undefined ? cfg.view.pixelsPerMeter : Number(view.pixelsPerMeter);
	cfg.view.padding = view.padding === undefined ? cfg.view.padding : Number(view.padding);
	const size = view.canvas && view.canvas[0];
	if (size && size in SIZE_INDEX) cfg.view.pixelSize = SIZE_INDEX[size];
	const render = doc.render || {};
	cfg.render.outlineInner = Number(render.outlineInner || render.outline || 0);
	cfg.render.outlineOuter = Number(render.outlineOuter || 0);
	cfg.render.outlineSilhouette = Number(render.outlineSilhouette || 0);
	if (render.outlineColor) cfg.render.outlineColor = render.outlineColor;
	if (render.outlineColorOuter) cfg.render.outlineColorOuter = render.outlineColorOuter;
	if (render.outlineColorSilhouette) cfg.render.outlineColorSilhouette = render.outlineColorSilhouette;
	if (render.antialias !== undefined) cfg.render.antialias = !!render.antialias;
	if (render.background && render.background !== "transparent") {
		cfg.render.background = 1;
		cfg.render.backgroundColor = render.background;
	}
	const parts = {};
	Object.keys(doc.parts || {}).forEach(function (role) {
		const part = doc.parts[role] || {};
		parts[role] = {
			tint: part.tint,
			inner: part.outlineInner === null ? undefined : part.outlineInner,
			innerColor: part.outlineInnerColor,
			outer: part.outlineOuter === null ? undefined : part.outlineOuter,
			outerColor: part.outlineOuterColor
		};
	});
	cfg.partOverrides = normalizePartOverrides(parts);
	return { cfg: normalize(cfg), partial: true };
}

module.exports = {
	TOOL_VERSION, DEFAULT_CONFIG, SIZE_INDEX, DIR_INDEX,
	normalize, fromArgs, buildProfile, renderOptions, partOutlineOptions,
	normalizePartOverrides, recipeDocument, configFromRecipe, parsePartSpec,
	unknownType, unknownStyle
};

(function () {
"use strict";
/**
 * 网页端应用层：风格管理、参数面板、预览、导出。
 * 几何 / 光栅化 / 材质全部在 js/ 下的独立模块里，本文件只做交互与编排。
 */
var TB = globalThis.TB;
var $ = function (sel) { return document.querySelector(sel); };
var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

var STORAGE_CONFIG = "tb_topdown_config_v1";
var STORAGE_STYLES = "tb_topdown_styles_v1";
/** 工具版本：界面标识、配方 JSON、风格包导出统一取这里。 */
var TOOL_VERSION = "1.1";
// 与插件 editor/building_styles.gd#IDS 顺序一致；像素风垫底
var STYLE_ORDER = ["jiangnan", "forest", "desert", "machiya", "nordic", "harbor", "palace", "gothic", "steamworks", "jiangnan_pixel"];

// 几何方言：[id, 短标签, 下拉说明]
var GEOMETRY_OPTIONS = [
	["jiangnan", "江南", "江南（歇山曲脊、木构穿斗、白墙）"],
	["forest", "欧式木构", "欧式木构（陡坡双坡顶、木筋墙、烟囱）"],
	["desert", "沙漠", "沙漠（平顶露台、分层退台）"],
	["machiya", "日式町屋", "日式町屋（十字脊、木格窗、缘侧外廊）"],
	["nordic", "北欧雪乡", "北欧雪乡（覆雪陡坡顶、百叶窗、石烟囱）"],
	["harbor", "热带海港", "热带海港（缓坡四坡顶、通风帽、布棚）"],
	["palace", "中式宫阙", "中式宫阙（重檐歇山、朱柱彩拱）"],
	["gothic", "哥特城镇", "哥特城镇（尖券窗、扶壁、尖塔饰）"],
	["steamworks", "蒸汽工业", "蒸汽工业（锯齿采光顶、锅炉烟囱）"]
];
var GEOMETRY_IDS = GEOMETRY_OPTIONS.map(function (row) { return row[0]; });

/** 方言 id 归一：像素风映射回基底，未知值退回江南 */
function normalizeGeometry(value) {
	var id = TB.geometryStyle(String(value || ""));
	return GEOMETRY_IDS.indexOf(id) >= 0 ? id : "jiangnan";
}

var DEFAULT_CONFIG = {
	styleId: "jiangnan",
	categoryId: "residential",
	typeId: "house",
	look: 0,
	shapeSeed: 60421,
	detailSeed: 101,
	appearanceSeed: 101,
	params: {},
	view: { pitch: 45, projection: 0, directions: 2, baseYaw: 0, fov: 50, pixelSize: 3, scaleMode: 0, pixelsPerMeter: 48, padding: 8 },
	render: {
		outlineInner: 0, outlineOuter: 0, outlineSilhouette: 0,
		antialias: true, background: 0, backgroundColor: "#2a2e33",
		outlineColor: "#140f0d", outlineColorOuter: "#140f0d", outlineColorSilhouette: "#140f0d",
		depthThreshold: 0.15, normalThreshold: 0.3
	},
	partOverrides: {}
};

var state = {
	styles: [],
	userStyles: [],
	cfg: clone(DEFAULT_CONFIG),
	mesh: null,
	meshKey: "",
	view: null,
	frame: null,
	baseTiles: null,
	baseTilesKey: "",
	tiles: null,
	revs: {},
	sourcesCache: new Map(),
	tilesCache: new Map(),
	imageCache: new Map(),
	renderToken: 0,
	renderTimer: 0,
	saveTimer: 0,
	zoom: 1,
	pan: { x: 0, y: 0 },
	dragging: false,
	dragMoved: false,
	partOverrides: {},
	partRev: 0,
	partTilesCache: new Map(),
	selection: null,
	texLib: { open: false, role: null, token: 0, cacheKey: "", cacheRole: null, items: [] },
	workshop: { open: false, draft: null, isNew: false, sourceId: "", draftRev: 0, atlasReport: null, thumbToken: 0 },
	exporting: false
};

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function nextFrame() { return new Promise(function (resolve) { requestAnimationFrame(function () { resolve(); }); }); }
function fmt(n, digits) { return Number(n).toFixed(digits === undefined ? 0 : digits); }

function toast(message, kind) {
	var node = $("#toast");
	node.textContent = message;
	node.className = "toast show" + (kind === "err" ? " err" : "");
	clearTimeout(toast._timer);
	toast._timer = setTimeout(function () { node.className = "toast"; }, 2800);
}

function setStatus(text, kind) {
	var node = $("#status");
	node.textContent = text;
	node.className = "status" + (kind ? " " + kind : "");
}

function setBusy(on, text) {
	var node = $("#busy");
	if (on) {
		$("#busyText").textContent = text || "正在渲染…";
		node.classList.add("open");
	} else {
		node.classList.remove("open");
	}
}

function downloadBytes(bytes, filename, mime) {
	var blob = new Blob([bytes], { type: mime || "application/octet-stream" });
	var url = URL.createObjectURL(blob);
	var a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
}

function readFileAsDataURL(file) {
	return new Promise(function (resolve, reject) {
		var reader = new FileReader();
		reader.onload = function () { resolve(String(reader.result)); };
		reader.onerror = function () { reject(new Error("读取文件失败")); };
		reader.readAsDataURL(file);
	});
}

// ---------------------------------------------------------------------------
// 风格：内置 + 本地用户风格
// ---------------------------------------------------------------------------
function styleRev(id) { return state.revs[id] || 0; }
function bumpRev(id) { state.revs[id] = styleRev(id) + 1; }

function buildBuiltinStyles() {
	var list = [];
	TB.BUILTIN_ASSETS.atlases.forEach(function (asset) {
		var basePalette = TB.BUILTIN_ASSETS.palette[asset.geometry] || TB.BUILTIN_ASSETS.palette.jiangnan;
		list.push({
			id: asset.id,
			name: asset.name,
			geometry: asset.geometry,
			builtin: true,
			note: asset.note || "",
			palette: TB.derivePalette(basePalette),
			atlas: { dataURL: asset.data, size: asset.size, cell: asset.cell, name: asset.id + ".png" },
			overrides: {}
		});
	});
	// 插件 STYLE_NAMES 的顺序：江南 / 欧式 / 沙漠 / 像素江南
	list.sort(function (a, b) { return STYLE_ORDER.indexOf(a.id) - STYLE_ORDER.indexOf(b.id); });
	return list;
}

function loadUserStyles() {
	try {
		var raw = localStorage.getItem(STORAGE_STYLES);
		if (!raw) return [];
		var data = JSON.parse(raw);
		if (!Array.isArray(data)) return [];
		return data.filter(function (s) { return s && s.id && s.name; }).map(function (s) {
			return {
				id: String(s.id),
				name: String(s.name),
				geometry: normalizeGeometry(s.geometry),
				builtin: false,
				note: s.note || "",
				palette: TB.derivePalette(s.palette || {}),
				atlas: s.atlas && s.atlas.dataURL ? { dataURL: s.atlas.dataURL, size: s.atlas.size || 512, cell: s.atlas.cell || 128, name: s.atlas.name || "atlas.png" } : null,
				overrides: s.overrides || {}
			};
		});
	} catch (err) {
		console.warn("读取本地风格失败", err);
		return [];
	}
}

function persistUserStyles() {
	try {
		localStorage.setItem(STORAGE_STYLES, JSON.stringify(state.userStyles));
		return true;
	} catch (err) {
		toast("保存失败：本地存储空间不足，请先导出风格包再删除部分风格", "err");
		return false;
	}
}

function getStyle(id) {
	for (var i = 0; i < state.styles.length; i++) if (state.styles[i].id === id) return state.styles[i];
	return state.styles[0];
}

function rebuildStyleList() {
	state.styles = buildBuiltinStyles().concat(state.userStyles);
	if (!getStyle(state.cfg.styleId)) state.cfg.styleId = state.styles[0].id;
}

function fillStyleSelect() {
	var select = $("#styleSelect");
	select.innerHTML = "";
	var builtin = document.createElement("optgroup");
	builtin.label = "内置风格";
	var userGroup = document.createElement("optgroup");
	userGroup.label = "自定义风格";
	state.styles.forEach(function (style) {
		var option = new Option(style.name + (style.builtin ? "" : "  ·自定义"), style.id);
		(style.builtin ? builtin : userGroup).appendChild(option);
	});
	select.appendChild(builtin);
	if (userGroup.children.length) select.appendChild(userGroup);
	select.value = state.cfg.styleId;
}

function activeStyle() { return getStyle(state.cfg.styleId); }
function activeGeometry() { return TB.geometryStyle(activeStyle().geometry); }

// ---------------------------------------------------------------------------
// 图片 / 图集 / 纹理
// ---------------------------------------------------------------------------
function loadImage(dataURL) {
	if (state.imageCache.has(dataURL)) return state.imageCache.get(dataURL);
	var promise = new Promise(function (resolve, reject) {
		var img = new Image();
		img.onload = function () { resolve(img); };
		img.onerror = function () { reject(new Error("图片解码失败")); };
		img.src = dataURL;
	});
	state.imageCache.set(dataURL, promise);
	return promise;
}

function imageToRGBA(dataURL) {
	return loadImage(dataURL).then(function (img) {
		var canvas = document.createElement("canvas");
		canvas.width = img.naturalWidth;
		canvas.height = img.naturalHeight;
		var ctx = canvas.getContext("2d", { willReadFrequently: true });
		ctx.drawImage(img, 0, 0);
		var data = ctx.getImageData(0, 0, canvas.width, canvas.height);
		return { width: data.width, height: data.height, data: data.data };
	});
}

function validateAtlas(image) {
	var errors = [], warnings = [], roleRows = [];
	var size = image.width;
	if (image.width !== image.height) errors.push("图集必须是正方形（当前 " + image.width + "×" + image.height + "）");
	if (size % 4 !== 0) errors.push("边长必须能被 4 整除（当前 " + size + "）");
	if (size < 64) errors.push("边长至少 64px（建议 512 或 1024）");
	if (size > 4096) errors.push("边长不要超过 4096px");
	var ok = errors.length === 0;
	var cell = Math.floor(size / 4);
	if (ok) {
		TB.ROLES.forEach(function (role, index) {
			var x0 = (index % 4) * cell, y0 = Math.floor(index / 4) * cell;
			var colors = new Set();
			var opaque = 0, total = 0;
			var step = Math.max(1, Math.floor(cell / 48));
			for (var y = y0; y < y0 + cell; y += step) {
				for (var x = x0; x < x0 + cell; x += step) {
					var o = (y * size + x) * 4;
					var r = image.data[o], g = image.data[o + 1], b = image.data[o + 2], a = image.data[o + 3];
					total++;
					if (a > 8) {
						opaque++;
						colors.add((r >> 3) << 10 | (g >> 3) << 5 | (b >> 3));
					}
				}
			}
			var uniq = colors.size;
			var opaqueRatio = total ? opaque / total : 0;
			var empty = opaqueRatio < 0.02;
			// 内影格本来就允许接近纯色（插件里也是平涂），不提示。
			var flat = role !== "shadow" && uniq <= 2 && opaqueRatio > 0.5;
			var row = { role: role, colors: uniq, opaque: opaqueRatio, empty: empty, flat: flat, ok: !empty && !flat };
			roleRows.push(row);
			if (empty) warnings.push("「" + (TB.ROLE_ZH[role] || role) + "」格几乎全透明，渲染会露底");
			else if (flat) warnings.push("「" + (TB.ROLE_ZH[role] || role) + "」格接近纯色，缺少像素细节");
		});
	}
	return { ok: ok, size: size, cell: cell, errors: errors, warnings: warnings, roles: roleRows };
}

function renderAtlasReport(report) {
	if (!report) return "未加载图集：将用调色板程序化生成 16 个角色的纹理。";
	var lines = [];
	if (report.errors.length) {
		lines.push('<div class="bad">图集不符合规范：</div><ul>');
		report.errors.forEach(function (e) { lines.push("<li>" + escapeHtml(e) + "</li>"); });
		lines.push("</ul>");
	} else {
		var bad = report.roles.filter(function (r) { return !r.ok; }).length;
		lines.push('<div class="' + (bad ? "warn" : "ok") + '">' +
			(report.ok ? "格式通过" : "格式有问题") + " · " + report.size + "px · " + report.cell + "px/格 · 16 格" +
			(bad ? " · " + bad + " 格需注意" : " · 全部有内容") + "</div>");
		if (report.warnings.length) {
			lines.push("<ul>");
			report.warnings.slice(0, 8).forEach(function (w) { lines.push('<li class="warn">' + escapeHtml(w) + "</li>"); });
			lines.push("</ul>");
		}
	}
	return lines.join("");
}

function escapeHtml(text) {
	return String(text).replace(/[&<>"']/g, function (c) {
		return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
	});
}

/** 解析某个风格实际使用的 16 个角色源（未染色、未缩放）。 */
async function resolveSources(style, cacheKey) {
	cacheKey = cacheKey || (style.id + ":" + styleRev(style.id));
	if (state.sourcesCache.has(cacheKey)) return state.sourcesCache.get(cacheKey);
	var atlasCells = null;
	if (style.atlas && style.atlas.dataURL) {
		var image = await imageToRGBA(style.atlas.dataURL);
		if (image.width % 4 !== 0 || image.width !== image.height) throw new Error("图集必须是 4×4 正方形");
		var atlas = TB.makeAtlas(new Uint8ClampedArray(image.data), image.width);
		atlasCells = TB.atlasSources(atlas);
	}
	var geometry = TB.geometryStyle(style.geometry);
	var paletteRgb = TB.paletteToRgb(style.palette);
	var sources = {};
	for (var i = 0; i < TB.ROLES.length; i++) {
		var role = TB.ROLES[i];
		if (style.overrides && style.overrides[role]) {
			var single = await imageToRGBA(style.overrides[role]);
			sources[role] = { data: single.data, size: single.width };
		} else if (atlasCells) {
			sources[role] = atlasCells[role];
		} else {
			sources[role] = { data: TB.proceduralCell(role, geometry, paletteRgb), size: 32 };
		}
	}
	state.sourcesCache.set(cacheKey, sources);
	if (state.sourcesCache.size > 16) {
		// 只保留最近使用的几份，避免编辑风格时无限增长
		var firstKey = state.sourcesCache.keys().next().value;
		if (firstKey !== cacheKey) state.sourcesCache.delete(firstKey);
	}
	return sources;
}

/**
 * 解析风格本身的 16 张基础纹理（不含任何部件覆盖）。
 * 注意：这里的产物是「母本」，绝不能把染色 / 换图后的纹理写回来，
 * 否则清除部件覆盖时会把染过色的纹理当成原图，表现为「重置无效」。
 */
async function resolveBaseTiles(style, look, appearanceSeed, glazing) {
	var key = [style.id, styleRev(style.id), look, appearanceSeed, glazing ? 1 : 0].join(":");
	if (state.baseTilesKey === key && state.baseTiles) return state.baseTiles;
	if (state.tilesCache.has(key)) {
		state.baseTiles = state.tilesCache.get(key);
		state.baseTilesKey = key;
		return state.baseTiles;
	}
	var sources = await resolveSources(style);
	if (glazing) {
		// 温室专用：插件用半透明淡青玻璃，这里用浅青格窗近似（不计算混合）。
		sources = Object.assign({}, sources);
		sources.glass = { data: TB.glazingCell(), size: 32 };
	}
	var tiles = TB.buildTiles(sources, { look: look, appearanceSeed: appearanceSeed });
	if (state.tilesCache.size > 10) state.tilesCache.clear();
	state.tilesCache.set(key, tiles);
	state.baseTiles = tiles;
	state.baseTilesKey = key;
	return tiles;
}

/** 部件级染色：按颜色乘算，保留纹理的像素细节。 */
function tintTileData(data, hex) {
	var color = TB.hexToRgb(hex);
	var out = new Uint8ClampedArray(data.length);
	for (var i = 0; i < data.length; i += 4) {
		out[i] = data[i] * color[0] / 255;
		out[i + 1] = data[i + 1] * color[1] / 255;
		out[i + 2] = data[i + 2] * color[2] / 255;
		out[i + 3] = data[i + 3];
	}
	return out;
}

/**
 * 在当前风格的 16 张纹理上叠加“部件覆盖”（仅当前建筑，不改风格）。
 * 覆盖支持：单独染色（乘算）、替换单张纹理（最近邻缩放到 64/128）。
 */
async function applyPartOverrides(baseTiles, baseKey) {
	var roles = Object.keys(state.partOverrides).filter(function (role) {
		var part = state.partOverrides[role];
		return part && (part.tint || part.texture);
	});
	if (!roles.length) return baseTiles;
	var key = (baseKey || "") + "|" + state.partRev;
	if (state.partTilesCache.has(key)) return state.partTilesCache.get(key);
	var tiles = Object.assign({}, baseTiles);
	for (var i = 0; i < roles.length; i++) {
		var role = roles[i];
		var part = state.partOverrides[role];
		var target = role === "roof" ? 64 : 128;
		var data = null;
		if (part.texture) {
			var image = await imageToRGBA(part.texture);
			if (image.width !== image.height) continue;
			data = TB.resizeNearest(new Uint8ClampedArray(image.data), image.width, image.height, target, target);
			if (TB.COMPONENT_ROLES.indexOf(role) < 0) TB.blendBorder(data, target);
		} else if (baseTiles[role]) {
			data = new Uint8ClampedArray(baseTiles[role].data);
		}
		if (!data) continue;
		if (part.tint && part.tint.toLowerCase() !== "#ffffff") data = tintTileData(data, part.tint);
		tiles[role] = { w: target, h: target, data: data, mips: TB.makeMips(data, target, target) };
	}
	if (state.partTilesCache.size > 12) state.partTilesCache.clear();
	state.partTilesCache.set(key, tiles);
	return tiles;
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
function defaultParams(typeId, styleId) {
	return TB.Catalog.parameters(typeId, styleId || DEFAULT_CONFIG.styleId);
}

function normalizeConfig(raw) {
	var cfg = clone(DEFAULT_CONFIG);
	if (!raw || typeof raw !== "object") {
		cfg.params = defaultParams(cfg.typeId, cfg.styleId);
		return cfg;
	}
	if (raw.styleId) cfg.styleId = String(raw.styleId);
	cfg.categoryId = raw.categoryId || cfg.categoryId;
	cfg.typeId = raw.typeId || cfg.typeId;
	cfg.look = TB.clampInt(raw.look || 0, 0, 3);
	cfg.shapeSeed = Number(raw.shapeSeed) || 60421;
	cfg.detailSeed = Number(raw.detailSeed) || 101;
	cfg.appearanceSeed = Number(raw.appearanceSeed) || 101;
	cfg.params = Object.assign(defaultParams(cfg.typeId, cfg.styleId), raw.params || {});
	cfg.view = Object.assign({}, DEFAULT_CONFIG.view, raw.view || {});
	cfg.render = Object.assign({}, DEFAULT_CONFIG.render, raw.render || {});
	var rawRender = raw.render || {};
	// 旧版单个 outline 参数迁移：内 + 轮廓（旧外描边就是整栋剪影），保持原来的观感
	if (rawRender.outline !== undefined) {
		if (rawRender.outlineInner === undefined) cfg.render.outlineInner = Number(rawRender.outline) || 0;
		if (rawRender.outlineSilhouette === undefined && rawRender.outlineOuter === undefined) {
			cfg.render.outlineSilhouette = Number(rawRender.outline) || 0;
		}
	}
	// 「外描边」语义改为部件外扩：老配置里的 outlineOuter 其实是整栋剪影，迁移到轮廓描边
	if (rawRender.outlineOuter !== undefined && rawRender.outlineSilhouette === undefined) {
		cfg.render.outlineSilhouette = Number(rawRender.outlineOuter) || 0;
		cfg.render.outlineOuter = 0;
	}
	cfg.render.outlineInner = Number(cfg.render.outlineInner) || 0;
	cfg.render.outlineOuter = Number(cfg.render.outlineOuter) || 0;
	cfg.render.outlineSilhouette = Number(cfg.render.outlineSilhouette) || 0;
	cfg.partOverrides = normalizePartOverrides(raw.partOverrides);
	return cfg;
}

function cleanHex(value) {
	return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : null;
}

function cleanWidth(value) {
	if (value === null || value === undefined || value === "") return null;
	var n = Number(value);
	if (!isFinite(n)) return null;
	return Math.max(0, Math.min(16, n));
}

/** 换图来源标注（例如「内置 · 欧式风格 · 图集 第 1 行第 1 列」），只做展示与配方记录。 */
function cleanSourceLabel(value) {
	if (typeof value !== "string") return null;
	var text = value.trim().slice(0, 80);
	return text || null;
}

function normalizePartOverrides(raw) {
	var out = {};
	if (!raw || typeof raw !== "object") return out;
	Object.keys(raw).forEach(function (role) {
		if (TB.ROLES.indexOf(role) < 0) return;
		var entry = raw[role] || {};
		var tint = cleanHex(entry.tint);
		var texture = typeof entry.texture === "string" && entry.texture.indexOf("data:image/") === 0 ? entry.texture : null;
		var inner = cleanWidth(entry.inner);
		var outer = cleanWidth(entry.outer);
		var innerColor = cleanHex(entry.innerColor);
		var outerColor = cleanHex(entry.outerColor);
		if (!tint && !texture && inner === null && outer === null && !innerColor && !outerColor) return;
		out[role] = {
			tint: tint, texture: texture, textureFrom: texture ? cleanSourceLabel(entry.textureFrom) : null,
			inner: inner, outer: outer, innerColor: innerColor, outerColor: outerColor
		};
	});
	return out;
}

/** 该部件是否有任何覆盖（染色 / 贴图 / 描边）。 */
function hasPartOverride(entry) {
	if (!entry) return false;
	return !!(entry.tint || entry.texture ||
		(entry.inner !== undefined && entry.inner !== null) ||
		(entry.outer !== undefined && entry.outer !== null) ||
		entry.innerColor || entry.outerColor);
}

function loadConfig() {
	try {
		var raw = localStorage.getItem(STORAGE_CONFIG);
		state.cfg = normalizeConfig(raw ? JSON.parse(raw) : null);
	} catch (err) {
		state.cfg = normalizeConfig(null);
	}
	state.partOverrides = clone(state.cfg.partOverrides || {});
}

var saveConfigTimer = 0;
function saveConfigSoon() {
	clearTimeout(saveConfigTimer);
	saveConfigTimer = setTimeout(function () {
		try {
			localStorage.setItem(STORAGE_CONFIG, JSON.stringify({
				styleId: state.cfg.styleId,
				categoryId: state.cfg.categoryId,
				typeId: state.cfg.typeId,
				look: state.cfg.look,
				shapeSeed: state.cfg.shapeSeed,
				detailSeed: state.cfg.detailSeed,
				appearanceSeed: state.cfg.appearanceSeed,
				params: state.cfg.params,
				view: state.cfg.view,
				render: state.cfg.render,
				partOverrides: state.partOverrides
			}));
		} catch (err) {
			/* 配额满了就算了，配置不是关键数据 */
		}
	}, 350);
}

// ---------------------------------------------------------------------------
// 生成与渲染
// ---------------------------------------------------------------------------
function buildProfile() {
	var entry = TB.Catalog.entry(state.cfg.typeId) || TB.Catalog.entry("house");
	return {
		style: state.cfg.styleId,
		typeId: entry.id,
		kind: entry.kind,
		categoryId: entry.category,
		shapeSeed: state.cfg.shapeSeed,
		detailSeed: state.cfg.detailSeed,
		appearanceSeed: state.cfg.appearanceSeed,
		params: Object.assign({}, state.cfg.params)
	};
}

function viewConfig() {
	return Object.assign({}, state.cfg.view, { padding: state.cfg.view.padding });
}

/** 部件级描边：只把用户明确设过的字段传给渲染器（其余继承全局）。 */
function partOutlineOptions() {
	var out = {};
	Object.keys(state.partOverrides).forEach(function (role) {
		var part = state.partOverrides[role] || {};
		var entry = {};
		if (part.inner !== undefined && part.inner !== null) entry.inner = Number(part.inner) || 0;
		if (part.innerColor) entry.innerColor = part.innerColor;
		if (part.outer !== undefined && part.outer !== null) entry.outer = Number(part.outer) || 0;
		if (part.outerColor) entry.outerColor = part.outerColor;
		if (Object.keys(entry).length) out[role] = entry;
	});
	return out;
}

function renderOptions() {
	var r = state.cfg.render;
	return {
		antialias: !!r.antialias,
		outlineInner: Number(r.outlineInner) || 0,
		outlineOuter: Number(r.outlineOuter) || 0,
		outlineSilhouette: Number(r.outlineSilhouette) || 0,
		outlineColor: r.outlineColor || TB.OUTLINE_COLOR,
		outlineColorOuter: r.outlineColorOuter || r.outlineColor || TB.OUTLINE_COLOR,
		outlineColorSilhouette: r.outlineColorSilhouette || r.outlineColorOuter || r.outlineColor || TB.OUTLINE_COLOR,
		partOutlines: partOutlineOptions(),
		transparent: Number(r.background) === 0,
		backgroundColor: r.backgroundColor,
		depthThreshold: Number(r.depthThreshold),
		normalThreshold: Number(r.normalThreshold)
	};
}

function scheduleRender(delay) {
	clearTimeout(state.renderTimer);
	state.renderTimer = setTimeout(function () { renderPreview(); }, delay === undefined ? 170 : delay);
}

async function renderPreview() {
	var token = ++state.renderToken;
	state.renderTimer = 0;
	try {
		var started = performance.now();
		if (!state.frame) {
			$("#previewEmpty").hidden = false;
			$("#previewEmpty").textContent = "正在渲染…";
		}
		var key = JSON.stringify([state.cfg.styleId, state.cfg.typeId, state.cfg.params, state.cfg.shapeSeed, state.cfg.detailSeed]);
		if (!state.mesh || state.meshKey !== key) {
			setStatus("正在重建建筑几何…");
			await nextFrame();
			state.mesh = TB.buildBuilding(buildProfile());
			state.meshKey = key;
		}
		if (token !== state.renderToken) return;
		var view = TB.prepareView(state.mesh.bounds, viewConfig());
		var style = activeStyle();
		var baseTiles = await resolveBaseTiles(style, state.cfg.look, state.cfg.appearanceSeed, state.cfg.typeId === "greenhouse");
		var tiles = await applyPartOverrides(baseTiles, state.baseTilesKey);
		if (token !== state.renderToken) return;
		state.tiles = tiles;
		var renderStart = performance.now();
		var frame = TB.renderFrame(state.mesh, tiles, view, view.yaws[0], renderOptions());
		if (token !== state.renderToken) return;
		var changed = !state.frame || state.frame.width !== frame.width || state.frame.height !== frame.height;
		state.frame = frame;
		state.view = view;
		drawPreview(frame);
		if (changed) resetPreviewView();
		var projection;
		if (view.projectionRequested) {
			projection = "透视 FOV " + Math.round(view.fov) + "°" + (view.fovLimit ? "（正交极限）" : "");
		} else {
			projection = "正交无透视";
		}
		var rCfg = state.cfg.render;
		var oInner = Number(rCfg.outlineInner) || 0;
		var oOuter = Number(rCfg.outlineOuter) || 0;
		var oSil = Number(rCfg.outlineSilhouette) || 0;
		var outlineText = (oInner > 0 || oOuter > 0 || oSil > 0)
			? "描边 内" + oInner + "/外" + oOuter + "/轮廓" + oSil + "px"
			: "无描边";
		var partCount = Object.keys(state.partOverrides).length;
		var partText = partCount ? " · 部件覆盖 " + partCount + " 项" : "";
		setStatus("预览：" + frame.width + "×" + frame.height + " px · " + projection + " · 俯角 " +
			Math.round(view.pitch) + "° · " + outlineText + " · " + view.yaws.length + " 个方向" +
			" · 几何 " + state.mesh.triangles + " 三角面" + partText);
		updateChips();
		$("#statTris").textContent = state.mesh.triangles.toLocaleString();
		$("#statStyle").textContent = style.name;
		$("#statType").textContent = TB.Catalog.title(buildProfile().typeId, style.id);
		$("#statTime").textContent = Math.round(performance.now() - started) + " ms";
		$("#previewEmpty").hidden = true;
		refreshFieldVisibility();
		refreshInspector();
		$("#btnClearParts").hidden = partCount === 0;
		state.renderSeq = (state.renderSeq || 0) + 1;
	} catch (err) {
		console.error(err);
		setStatus("生成失败：" + (err && err.message ? err.message : err), "err");
	}
}

function drawPreview(frame) {
	var canvas = $("#previewCanvas");
	canvas.width = frame.width;
	canvas.height = frame.height;
	var ctx = canvas.getContext("2d");
	var data = frame.data;
	// 选中部件时，在预览上叠一层暖金色高亮（不改动导出数据）
	if (state.selection !== null && frame.pick) {
		data = new Uint8ClampedArray(frame.data);
		var pick = frame.pick;
		var k = 0.25;
		for (var i = 0; i < pick.length; i++) {
			if (pick[i] !== state.selection) continue;
			var o = i * 4;
			data[o] += (245 - data[o]) * k;
			data[o + 1] += (196 - data[o + 1]) * k;
			data[o + 2] += (81 - data[o + 2]) * k;
		}
	}
	ctx.putImageData(new ImageData(data, frame.width, frame.height), 0, 0);
	layoutPreview();
}

function layoutPreview() {
	var wrap = $("#previewWrap");
	var canvas = $("#previewCanvas");
	if (!state.frame) return;
	var rect = wrap.getBoundingClientRect();
	if (rect.width < 8 || rect.height < 8) return;
	var fit = Math.min(rect.width / state.frame.width, rect.height / state.frame.height);
	var scale = fit * state.zoom;
	var shownW = state.frame.width * scale;
	var shownH = state.frame.height * scale;
	var limitX = Math.max(0, (shownW - rect.width) / 2);
	var limitY = Math.max(0, (shownH - rect.height) / 2);
	state.pan.x = Math.max(-limitX, Math.min(limitX, state.pan.x));
	state.pan.y = Math.max(-limitY, Math.min(limitY, state.pan.y));
	canvas.style.width = shownW + "px";
	canvas.style.height = shownH + "px";
	canvas.style.transform = "translate(-50%,-50%) translate(" + state.pan.x + "px," + state.pan.y + "px)";
	$("#zoomLabel").textContent = Math.round(state.zoom * 100) + "%";
}

function resetPreviewView() {
	state.zoom = 1;
	state.pan.x = 0;
	state.pan.y = 0;
	layoutPreview();
}

function setZoom(value) {
	state.zoom = Math.max(0.2, Math.min(8, value));
	layoutPreview();
}

// ---------------------------------------------------------------------------
// 部件拾取：点击画面查看角色纹理，并做部件级染色 / 替换
// ---------------------------------------------------------------------------
function roleIndex(role) { return TB.ROLES.indexOf(role); }
function selectedRole() { return state.selection === null ? null : TB.ROLES[state.selection]; }

function tileThumbURL(tile) {
	var canvas = document.createElement("canvas");
	canvas.width = tile.w;
	canvas.height = tile.h;
	var ctx = canvas.getContext("2d");
	var image = ctx.createImageData(tile.w, tile.h);
	image.data.set(tile.data);
	ctx.putImageData(image, 0, 0);
	// 透明像素铺深色底，便于看清
	ctx.globalCompositeOperation = "destination-over";
	ctx.fillStyle = "#12151a";
	ctx.fillRect(0, 0, tile.w, tile.h);
	ctx.globalCompositeOperation = "source-over";
	return canvas.toDataURL();
}

function roleOriginText(role) {
	var style = activeStyle();
	var part = state.partOverrides[role];
	if (part && part.texture) return part.textureFrom ? "纹理库 · " + part.textureFrom : "部件覆盖 · 单图";
	if (part && part.tint && part.tint !== "#ffffff") return "部件染色 · " + (style.atlas ? "图集" : "程序化");
	if (style.overrides && style.overrides[role]) return "风格 · 单角色图";
	if (style.atlas) {
		var index = roleIndex(role);
		return "风格图集 · 第 " + (Math.floor(index / 4) + 1) + " 行第 " + (index % 4 + 1) + " 列";
	}
	return "程序化调色板";
}

/** 部件级描边的三个状态：继承全局 / 自定义。 */
function outlineState(part, key) {
	var width = part[key];
	var color = part[key + "Color"];
	var inherit = (width === undefined || width === null) && !color;
	return { inherit: inherit, width: width, color: color };
}

function refreshInspector() {
	var inspector = $("#inspector");
	var role = selectedRole();
	var anyOverride = Object.keys(state.partOverrides).some(function (r) { return hasPartOverride(state.partOverrides[r]); });
	$("#btnClearParts").hidden = !anyOverride;
	if (!role) {
		inspector.hidden = true;
		return;
	}
	inspector.hidden = false;
	var part = state.partOverrides[role] || {};
	var render = state.cfg.render;
	$("#inspName").textContent = TB.ROLE_ZH[role] || role;
	$("#inspRole").textContent = role;
	$("#inspOrigin").textContent = roleOriginText(role);
	$("#inspTint").value = part.tint || "#ffffff";

	// 内描边
	var inner = outlineState(part, "inner");
	$("#inspInnerInherit").checked = inner.inherit;
	$("#inspInner").disabled = inner.inherit;
	$("#inspInnerColor").disabled = inner.inherit;
	$("#inspInner").value = inner.inherit ? "" : String(inner.width === undefined || inner.width === null ? 0 : inner.width);
	$("#inspInner").placeholder = "继承 " + (Number(render.outlineInner) || 0);
	$("#inspInnerColor").value = inner.color || render.outlineColor || TB.OUTLINE_COLOR;

	// 部件外描边
	var outer = outlineState(part, "outer");
	$("#inspOuterInherit").checked = outer.inherit;
	$("#inspOuter").disabled = outer.inherit;
	$("#inspOuterColor").disabled = outer.inherit;
	$("#inspOuter").value = outer.inherit ? "" : String(outer.width === undefined || outer.width === null ? 0 : outer.width);
	$("#inspOuter").placeholder = "继承 " + (Number(render.outlineOuter) || 0);
	$("#inspOuterColor").value = outer.color || render.outlineColorOuter || render.outlineColor || TB.OUTLINE_COLOR;

	var notes = [];
	if (part.texture) {
		notes.push(part.textureFrom ? "贴图取自纹理库（" + part.textureFrom + "）" : "已用单图替换该部件纹理");
	}
	if (part.tint && part.tint !== "#ffffff") notes.push("已对该部件单独染色");
	if (!inner.inherit) notes.push("内描边 " + (Number(inner.width) || 0) + "px（覆盖全局）");
	if (!outer.inherit) notes.push("外描边 " + (Number(outer.width) || 0) + "px（覆盖全局）");
	var hint = notes.length ? notes.join("；") + "。以上只作用于当前建筑，参与导出。"
		: "该部件引用风格本身的纹理与全局描边；下面的调整只作用于当前建筑，不改动风格。";
	$("#inspHint").textContent = hint;
	var tile = state.tiles && state.tiles[role];
	if (tile) $("#inspThumb").style.backgroundImage = "url(" + tileThumbURL(tile) + ")";
	$("#inspThumb").title = (TB.ROLE_ZH[role] || role) + "（" + role + "）当前纹理";
}

function selectPart(id) {
	state.selection = (id === null || id === undefined || id === 255) ? null : id;
	refreshInspector();
	if (state.frame) drawPreview(state.frame);
}

function pickPartAt(clientX, clientY) {
	var frame = state.frame;
	if (!frame || !frame.pick) return;
	var canvas = $("#previewCanvas");
	var rect = canvas.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return;
	var x = Math.floor((clientX - rect.left) / rect.width * frame.width);
	var y = Math.floor((clientY - rect.top) / rect.height * frame.height);
	if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) { selectPart(null); return; }
	var id = frame.pick[y * frame.width + x];
	if (id === 255) {
		// 点到细部边缘或被描边覆盖时，向邻域找最近的非背景部件（半径 2px）
		var best = 255, bestDist = 99;
		for (var dy = -2; dy <= 2; dy++) {
			for (var dx = -2; dx <= 2; dx++) {
				var nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= frame.width || ny >= frame.height) continue;
				var pid = frame.pick[ny * frame.width + nx];
				if (pid === 255) continue;
				var dist = dx * dx + dy * dy;
				if (dist < bestDist) { bestDist = dist; best = pid; }
			}
		}
		id = best;
	}
	selectPart(id === 255 ? null : id);
}

function partOverrideChanged() {
	state.partRev++;
	saveConfigSoon();
	scheduleRender(0);
}

async function setPartTexture(role, dataURL, from) {
	if (TB.ROLES.indexOf(role) < 0) throw new Error("未知部件");
	var image = await imageToRGBA(dataURL);
	if (image.width !== image.height) throw new Error("部件贴图必须是正方形");
	if (image.width < 16) throw new Error("贴图太小（至少 16×16）");
	var entry = state.partOverrides[role] || {};
	entry.texture = dataURL;
	if (from) entry.textureFrom = cleanSourceLabel(from);
	else delete entry.textureFrom;
	state.partOverrides[role] = entry;
	partOverrideChanged();
	refreshInspector();
}

function pickPartTexture() {
	var role = selectedRole();
	if (!role) {
		toast("请先在预览里点击选中一个部件");
		return;
	}
	var input = document.createElement("input");
	input.type = "file";
	input.accept = "image/png,image/*";
	input.onchange = async function () {
		if (!input.files || !input.files[0]) return;
		try {
			var dataURL = await readFileAsDataURL(input.files[0]);
			await setPartTexture(role, dataURL);
			toast("已替换「" + (TB.ROLE_ZH[role] || role) + "」纹理（仅当前建筑）");
		} catch (err) {
			toast(err.message, "err");
		}
	};
	input.click();
}

/** 纹理库缓存键：任一风格的版本、图集或单角色图变化时失效。 */
function textureLibraryKey() {
	return state.styles.map(function (style) {
		return style.id + ":" + styleRev(style.id) + ":" + (style.atlas && style.atlas.dataURL ? 1 : 0) +
			":" + Object.keys(style.overrides || {}).join(",");
	}).join("|");
}

/** 某个风格里该角色的贴图来自哪里（展示用）。 */
function roleSourceOrigin(style, role) {
	if (style.overrides && style.overrides[role]) return "单角色图";
	if (style.atlas && style.atlas.dataURL) {
		var index = roleIndex(role);
		return "图集 第 " + (Math.floor(index / 4) + 1) + " 行第 " + (index % 4 + 1) + " 列";
	}
	return "程序化调色板";
}

/** 把解析出来的角色源纹理编码成 data URL（超过 256px 先最近邻缩下来，省存储空间）。 */
function sourceToDataURL(source, maxSize) {
	var limit = maxSize || 256;
	var size = source.size;
	var data = source.data;
	if (size > limit) {
		data = TB.resizeNearest(new Uint8ClampedArray(data), size, size, limit, limit);
		size = limit;
	}
	var canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	var ctx = canvas.getContext("2d");
	var image = ctx.createImageData(size, size);
	image.data.set(data);
	ctx.putImageData(image, 0, 0);
	return canvas.toDataURL();
}

/**
 * 收集「所有已导入的纹理」里同一角色的贴图：内置风格 + 自定义风格一视同仁，
 * 每个风格的该角色贴图都是一份候选（图集对应格 / 该角色单图 / 程序化调色板）。
 */
async function collectRoleTextures(role) {
	var cacheKey = textureLibraryKey();
	// 只缓存最近一次打开的角色：16 个角色 × N 个风格的 data URL 没必要全留内存
	if (state.texLib.cacheKey === cacheKey && state.texLib.cacheRole === role && state.texLib.items.length) {
		return state.texLib.items;
	}
	var items = [];
	for (var i = 0; i < state.styles.length; i++) {
		var style = state.styles[i];
		try {
			var sources = await resolveSources(style);
			var source = sources[role];
			if (!source || !source.data || !source.size) continue;
			items.push({
				role: role,
				styleId: style.id,
				styleName: style.name,
				builtin: !!style.builtin,
				geometry: TB.geometryStyle(style.geometry),
				origin: roleSourceOrigin(style, role),
				size: source.size,
				dataURL: sourceToDataURL(source),
				thumb: sourceThumb(source, 96)
			});
		} catch (err) {
			console.warn("纹理库：解析风格失败 " + style.id, err);
		}
	}
	var activeId = state.cfg.styleId;
	items.sort(function (a, b) {
		if (a.styleId === activeId) return -1;
		if (b.styleId === activeId) return 1;
		if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
		return 0;
	});
	state.texLib.cacheKey = cacheKey;
	state.texLib.cacheRole = role;
	state.texLib.items = items;
	return items;
}

function openTextureLibrary() {
	var role = selectedRole();
	if (!role) {
		toast("请先在预览里点击选中一个部件");
		return;
	}
	state.texLib.open = true;
	state.texLib.role = role;
	$("#textureModal").classList.add("open");
	renderTextureLibrary(role);
}

function closeTextureLibrary() {
	state.texLib.open = false;
	state.texLib.role = null;
	state.texLib.token++;
	$("#textureModal").classList.remove("open");
}

async function renderTextureLibrary(role) {
	var token = ++state.texLib.token;
	var label = TB.ROLE_ZH[role] || role;
	$("#texTitle").textContent = "纹理库 · 同部件贴图";
	$("#texRole").textContent = label + " / " + role;
	$("#texNote").textContent = "正在从 " + state.styles.length + " 个已导入的风格里收集「" + label + "」的贴图…";
	$("#texGrid").innerHTML = "";
	$("#btnTextureClear").hidden = true;
	var items = await collectRoleTextures(role);
	if (token !== state.texLib.token) return;
	var part = state.partOverrides[role] || {};
	var current = part.texture || "";
	$("#btnTextureClear").hidden = !part.texture;
	if (!items.length) {
		$("#texNote").textContent = "没有找到可用的「" + label + "」贴图。";
		return;
	}
	var grid = $("#texGrid");
	var builtinCount = 0, customCount = 0;
	items.forEach(function (item) {
		if (item.builtin) builtinCount++;
		else customCount++;
		var using = item.dataURL === current;
		var card = document.createElement("button");
		card.type = "button";
		card.className = "tex-card" + (using ? " active" : "") +
			(item.styleId === state.cfg.styleId ? " from-active" : "");
		card.title = item.styleName + " · " + item.origin + " · " + item.size + "px";
		card.dataset.style = item.styleId;
		card.dataset.role = role;
		card.innerHTML =
			'<span class="tex-thumb" style="background-image:url(' + item.thumb + ')"></span>' +
			'<span class="tex-name">' + escapeHtml(item.styleName) + "</span>" +
			'<span class="tex-sub">' + (item.builtin ? "内置" : "自定义") + " · " + escapeHtml(item.origin) + "</span>" +
			(using ? '<span class="tex-flag">使用中</span>' : "");
		card.addEventListener("click", function () { applyLibraryTexture(role, item); });
		grid.appendChild(card);
	});
	$("#texNote").textContent = "共 " + items.length + " 张「" + label + "」贴图（内置 " + builtinCount +
		" / 自定义 " + customCount + "）。点一下即替换当前建筑的这一个部件。";
}

async function applyLibraryTexture(role, item) {
	try {
		await setPartTexture(role, item.dataURL,
			(item.builtin ? "内置" : "自定义") + " · " + item.styleName + " · " + item.origin);
		closeTextureLibrary();
		toast("已把「" + (TB.ROLE_ZH[role] || role) + "」换成「" + item.styleName + "」的同部件贴图");
	} catch (err) {
		toast(err.message, "err");
	}
}

/** 只撤掉换图，保留染色 / 部件级描边。 */
function clearPartTexture() {
	var role = state.texLib.role || selectedRole();
	if (!role) return;
	var entry = state.partOverrides[role] || {};
	if (!entry.texture) {
		toast("该部件当前没有换图");
		return;
	}
	delete entry.texture;
	delete entry.textureFrom;
	if (hasPartOverride(entry)) state.partOverrides[role] = entry;
	else delete state.partOverrides[role];
	state.partRev++;
	state.partTilesCache.clear();
	refreshInspector();
	saveConfigSoon();
	scheduleRender(0);
	closeTextureLibrary();
	toast("已把「" + (TB.ROLE_ZH[role] || role) + "」恢复为风格原纹理");
}

/**
 * 重置：把该部件的染色、贴图、内/外描边全部恢复为“跟随风格 / 跟随全局”的初始状态。
 * 会同时让基础纹理缓存失效检查走一遍（partRev 递增），避免旧纹理残留。
 */
function resetSelectedPartOverride() {
	var role = selectedRole();
	if (!role) return;
	var label = TB.ROLE_ZH[role] || role;
	var had = hasPartOverride(state.partOverrides[role]);
	delete state.partOverrides[role];
	state.partRev++;
	state.partTilesCache.clear();
	refreshInspector();
	saveConfigSoon();
	scheduleRender(0);
	toast(had ? "已重置「" + label + "」的染色、贴图与描边" : "「" + label + "」本来就是初始状态");
}

/** 写入部件级描边设置（继承时删除对应字段）。 */
function applyPartOutline(role) {
	if (!role) return;
	var entry = state.partOverrides[role] || {};
	if ($("#inspInnerInherit").checked) {
		delete entry.inner;
		delete entry.innerColor;
	} else {
		entry.inner = cleanWidth($("#inspInner").value) === null ? 0 : cleanWidth($("#inspInner").value);
		entry.innerColor = String($("#inspInnerColor").value).toLowerCase();
	}
	if ($("#inspOuterInherit").checked) {
		delete entry.outer;
		delete entry.outerColor;
	} else {
		entry.outer = cleanWidth($("#inspOuter").value) === null ? 0 : cleanWidth($("#inspOuter").value);
		entry.outerColor = String($("#inspOuterColor").value).toLowerCase();
	}
	if (hasPartOverride(entry)) state.partOverrides[role] = entry;
	else delete state.partOverrides[role];
	partOverrideChanged();
	refreshInspector();
}

function updateChips() {
	var view = state.view;
	if (!view) return;
	$("#chipCanvas").textContent = view.canvas[0] + "×" + view.canvas[1];
	if (view.projectionRequested) {
		$("#chipProj").textContent = "透视 " + Math.round(view.fov) + "°" + (view.fovLimit ? "（→正交）" : "");
	} else {
		$("#chipProj").textContent = "正交";
	}
	$("#chipPitch").textContent = Math.round(view.pitch) + "°";
	$("#chipDirs").textContent = view.yaws.length + " 向";
}

// ---------------------------------------------------------------------------
// 面板
// ---------------------------------------------------------------------------
function fillCategories() {
	var select = $("#categorySelect");
	select.innerHTML = "";
	TB.Catalog.categories().forEach(function (cat) { select.appendChild(new Option(cat.zh, cat.id)); });
	select.value = state.cfg.categoryId;
}

function fillTypes() {
	var select = $("#typeSelect");
	select.innerHTML = "";
	var rows = TB.Catalog.types(state.cfg.categoryId);
	if (!rows.length) rows = TB.Catalog.types();
	if (!rows.some(function (r) { return r.id === state.cfg.typeId; })) state.cfg.typeId = rows[0].id;
	rows.forEach(function (row) {
		select.appendChild(new Option(TB.Catalog.title(row.id, state.cfg.styleId), row.id));
	});
	select.value = state.cfg.typeId;
}

function refreshTypeTitles() {
	var rows = TB.Catalog.types(state.cfg.categoryId);
	var select = $("#typeSelect");
	Array.prototype.forEach.call(select.options, function (option, i) {
		var row = rows[i];
		if (row) option.textContent = TB.Catalog.title(row.id, state.cfg.styleId);
	});
}

function scopeObject(scope) {
	if (scope === "root") return state.cfg;
	if (scope === "params") return state.cfg.params;
	if (scope === "view") return state.cfg.view;
	return state.cfg.render;
}

function onControlChanged(key, scope) {
	if (scope === "root") {
		if (key === "look") { /* look 只换材质 */ }
	} else if (scope === "view") {
		// 视角变化不需要重建几何
	} else if (scope === "render") {
		//
	}
	if (key === "pixelSize") {
		state.pan.x = 0; state.pan.y = 0; state.zoom = 1;
	}
	refreshFieldVisibility();
	saveConfigSoon();
	scheduleRender();
}

function bindControls() {
	$$("[data-key]").forEach(function (input) {
		var key = input.dataset.key;
		var scope = input.dataset.scope || "params";
		var handler = function () {
			var target = scopeObject(scope);
			if (input.type === "checkbox") target[key] = input.checked;
			else if (input.type === "number") {
				var value = Number(input.value);
				target[key] = isFinite(value) ? value : 0;
			} else if (input.tagName === "SELECT") {
				var raw = input.value;
				target[key] = (raw !== "" && isFinite(Number(raw))) ? Number(raw) : raw;
			} else target[key] = input.value;
			onControlChanged(key, scope);
		};
		input.addEventListener("input", handler);
		input.addEventListener("change", handler);
	});
}

function syncControls() {
	$$("[data-key]").forEach(function (input) {
		var key = input.dataset.key;
		var scope = input.dataset.scope || "params";
		var value = scopeObject(scope)[key];
		if (value === undefined) return;
		if (input.type === "checkbox") input.checked = !!value;
		else input.value = value;
	});
	$("#styleSelect").value = state.cfg.styleId;
	$("#categorySelect").value = state.cfg.categoryId;
	$("#typeSelect").value = state.cfg.typeId;
	$("#lookSelect").value = String(state.cfg.look);
	$("#styleBadge").textContent = activeStyle().name;
	var styleNote = "内置风格 · " + geometryLabel(activeStyle().geometry) + " 几何 · 原插件图集";
	$("#styleNote").textContent = activeStyle().builtin
		? (activeStyle().note ? styleNote + " — " + activeStyle().note : styleNote)
		: "自定义风格 · " + geometryLabel(activeStyle().geometry) + " 几何 · 自定义材质";
	refreshFieldVisibility();
}

function geometryLabel(geometry) {
	var id = normalizeGeometry(geometry);
	for (var i = 0; i < GEOMETRY_OPTIONS.length; i++) {
		if (GEOMETRY_OPTIONS[i][0] === id) return GEOMETRY_OPTIONS[i][1];
	}
	return id;
}

function refreshFieldVisibility() {
	var fields = TB.Catalog.fields(state.cfg.typeId);
	$$("[data-field]").forEach(function (node) { node.hidden = fields.indexOf(node.dataset.field) < 0; });
	var balcony = document.querySelector('[data-scope="params"][data-key="balcony"]');
	if (balcony) balcony.disabled = Number(state.cfg.params.floors) < 2 || activeGeometry() === "desert";
	var perspective = Number(state.cfg.view.projection) === 1;
	$$('[data-view-field="fov"]').forEach(function (n) { n.hidden = !perspective; });
	var adaptive = Number(state.cfg.view.pixelSize) >= TB.ADAPTIVE_PIXEL_INDEX;
	var fixed = Number(state.cfg.view.scaleMode) === 1;
	$$('[data-view-field="ppm"]').forEach(function (n) { n.hidden = !(fixed || adaptive); });
	$$('[data-view-field="padding"]').forEach(function (n) { n.hidden = !((!fixed) || adaptive); });
	var bg = Number(state.cfg.render.background) === 1;
	$$('[data-scope="render"][data-key="backgroundColor"]').forEach(function (n) {
		var row = n.closest(".row");
		if (row) row.hidden = !bg;
	});
}

function loadSample() {
	state.cfg.params = defaultParams(state.cfg.typeId, state.cfg.styleId);
	state.cfg.shapeSeed = 60421;
	state.cfg.detailSeed = 101;
	state.cfg.appearanceSeed = 101;
	syncControls();
	saveConfigSoon();
	scheduleRender(0);
}

function replay() {
	state.cfg.params = TB.Catalog.parameters(state.cfg.typeId, state.cfg.styleId, Number(state.cfg.shapeSeed), true);
	syncControls();
	saveConfigSoon();
	scheduleRender(0);
}

function randomSeed() { return Math.floor(Math.random() * 2147483646) + 1; }

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------
function frameToCanvas(frame) {
	var canvas = document.createElement("canvas");
	canvas.width = frame.width;
	canvas.height = frame.height;
	canvas.getContext("2d").putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);
	return canvas;
}

function canvasPngBytes(canvas) {
	return new Promise(function (resolve, reject) {
		canvas.toBlob(function (blob) {
			if (!blob) { reject(new Error("PNG 编码失败")); return; }
			blob.arrayBuffer().then(function (buffer) { resolve(new Uint8Array(buffer)); });
		}, "image/png");
	});
}

function pngWithMeta(bytes) {
	try {
		if (!TB.pngEmbedText) return bytes;
		return TB.pngEmbedText(bytes, TB.pngMetaEntries(recipeDocument()));
	} catch (err) {
		console.warn("内嵌元信息写入失败：", err);
		return bytes;
	}
}

async function framePngBytes(frame) {
	return pngWithMeta(await canvasPngBytes(frameToCanvas(frame)));
}

function currentIdentity() {
	return TB.recipeIdentity(buildProfile());
}

function currentFolder() {
	if (!state.view) return currentIdentity();
	return TB.outputFolderName(state.cfg, state.view, currentIdentity());
}

async function ensurePreview() {
	var key = JSON.stringify([state.cfg.styleId, state.cfg.typeId, state.cfg.params, state.cfg.shapeSeed, state.cfg.detailSeed]);
	if (!state.frame || state.meshKey !== key) await renderPreview();
	if (!state.frame) throw new Error("当前没有可导出的画面");
}

async function exportCurrent() {
	if (state.exporting) return;
	try {
		state.exporting = true;
		setStatus("正在渲染当前方向…");
		await ensurePreview();
		var bytes = await framePngBytes(state.frame);
		var name = currentFolder().replace(/\//g, "_") + "_dir_0.png";
		downloadBytes(bytes, name, "image/png");
		setStatus("已导出第一方向：" + name, "ok");
	} catch (err) {
		setStatus("导出失败：" + err.message, "err");
	} finally {
		state.exporting = false;
	}
}

async function exportAll() {
	if (state.exporting) return;
	try {
		state.exporting = true;
		await ensurePreview();
		var view = state.view;
		var baseTiles = await resolveBaseTiles(activeStyle(), state.cfg.look, state.cfg.appearanceSeed, state.cfg.typeId === "greenhouse");
		var tiles = await applyPartOverrides(baseTiles, state.baseTilesKey);
		state.tiles = tiles;
		var folder = currentFolder();
		var frames = [];
		for (var i = 0; i < view.yaws.length; i++) {
			setBusy(true, "正在渲染方向 " + (i + 1) + " / " + view.yaws.length + "…");
			setStatus("正在渲染方向 " + (i + 1) + " / " + view.yaws.length + "…");
			await nextFrame();
			frames.push(TB.renderFrame(state.mesh, tiles, view, view.yaws[i], renderOptions()));
		}
		setBusy(true, "正在打包 ZIP…");
		var sheet = TB.composeSheet(frames, 16384);
		var files = [];
		for (var f = 0; f < frames.length; f++) {
			files.push({ name: folder + "/dir_" + f + ".png", data: await framePngBytes(frames[f]) });
		}
		files.push({ name: folder + "/sheet.png", data: await framePngBytes(sheet) });
		files.push({
			name: folder + "/recipe.json",
			data: new TextEncoder().encode(JSON.stringify(recipeDocument(), null, 2))
		});
		var archive = TB.zip(files);
		downloadBytes(archive, currentIdentity() + "_" + view.yaws.length + "dirs.zip", "application/zip");
		setStatus("已导出 " + frames.length + " 个方向帧 + 精灵表（" + sheet.width + "×" + sheet.height + "）", "ok");
	} catch (err) {
		console.error(err);
		setStatus("导出失败：" + err.message, "err");
	} finally {
		setBusy(false);
		state.exporting = false;
	}
}

function recipeDocument() {
	var style = activeStyle();
	var view = state.view;
	return {
		tool: "topdown-building-studio-web",
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
		profile: buildProfile(),
		view: {
			pitch: view.pitch,
			projection: view.perspective ? "perspective" : "orthographic",
			projectionRequested: view.projectionRequested ? "perspective" : "orthographic",
			fov: view.fov,
			fovLimit: view.fovLimit,
			canvas: view.canvas,
			directions: view.yaws.length,
			baseYaw: state.cfg.view.baseYaw,
			scaleMode: view.fixed ? "fixed-ppm" : "auto",
			pixelsPerMeter: view.ppm,
			padding: view.padding,
			orthoSize: view.orthoSize
		},
		render: {
			outline: Number(state.cfg.render.outlineInner) || 0,
			outlineInner: Number(state.cfg.render.outlineInner) || 0,
			outlineOuter: Number(state.cfg.render.outlineOuter) || 0,
			outlineSilhouette: Number(state.cfg.render.outlineSilhouette) || 0,
			outlineColor: state.cfg.render.outlineColor || TB.OUTLINE_COLOR,
			outlineColorOuter: state.cfg.render.outlineColorOuter || TB.OUTLINE_COLOR,
			outlineColorSilhouette: state.cfg.render.outlineColorSilhouette || TB.OUTLINE_COLOR,
			outlineSemantics: { inner: "几何内侧（按部件分界）", outer: "部件外扩（可压到别的部件）", silhouette: "整栋剪影外扩到背景" },
			antialias: !!state.cfg.render.antialias,
			background: Number(state.cfg.render.background) === 1 ? state.cfg.render.backgroundColor : "transparent"
		},
		parts: Object.keys(state.partOverrides).reduce(function (acc, role) {
			var part = state.partOverrides[role];
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
		outputFolder: currentFolder(),
		note: "无光照渲染：颜色只来自材质图集 × 顶点染色；几何移植自 Godot addon topdown_building_studio（v5 配方）。"
	};
}

function exportRecipe() {
	var doc = recipeDocument();
	downloadBytes(new TextEncoder().encode(JSON.stringify(doc, null, 2)),
		(currentIdentity() + "_recipe.json"), "application/json");
	toast("配方 JSON 已导出");
}

async function downloadTemplate(style, cacheKey) {
	style = style || activeStyle();
	try {
		setBusy(true, "正在生成图集模板…");
		var sources = await resolveSources(style, cacheKey || (style.id + ":" + styleRev(style.id)));
		var atlas = TB.assembleAtlas(sources, 128);
		var canvas = document.createElement("canvas");
		canvas.width = atlas.size;
		canvas.height = atlas.size;
		var ctx = canvas.getContext("2d");
		ctx.putImageData(new ImageData(atlas.data, atlas.size, atlas.size), 0, 0);
		var bytes = await canvasPngBytes(canvas);
		downloadBytes(bytes, style.id + "_atlas_template_" + atlas.size + ".png", "image/png");
		toast("图集模板已导出：" + atlas.size + "×" + atlas.size + "（128/格）");
	} catch (err) {
		toast("生成模板失败：" + err.message, "err");
	} finally {
		setBusy(false);
	}
}

// ---------------------------------------------------------------------------
// 风格工坊
// ---------------------------------------------------------------------------
function openWorkshop() {
	state.workshop.open = true;
	$("#workshopModal").classList.add("open");
	renderStyleList();
	var id = state.cfg.styleId;
	selectStyleForEdit(id, false);
}

function closeWorkshop() {
	state.workshop.open = false;
	$("#workshopModal").classList.remove("open");
	state.workshop.draft = null;
}

function renderStyleList() {
	var list = $("#styleList");
	list.innerHTML = "";
	state.styles.forEach(function (style) {
		var item = document.createElement("div");
		item.className = "style-item" + (state.workshop.draft && state.workshop.draft.id === style.id ? " active" : "");
		item.dataset.id = style.id;
		var swatch = document.createElement("div");
		swatch.className = "style-swatch";
		swatch.style.backgroundImage = "url(" + (style.atlas ? style.atlas.dataURL : paletteSwatch(style)) + ")";
		var meta = document.createElement("div");
		meta.className = "style-meta";
		var title = document.createElement("b");
		title.textContent = style.name;
		var sub = document.createElement("span");
		sub.textContent = (style.builtin ? "内置" : "自定义") + " · " + geometryLabel(style.geometry) + (style.atlas ? " · 图集" : " · 程序化");
		meta.appendChild(title);
		meta.appendChild(sub);
		item.appendChild(swatch);
		item.appendChild(meta);
		item.addEventListener("click", function () { selectStyleForEdit(style.id, false); });
		list.appendChild(item);
	});
}

function paletteSwatch(style) {
	var rgb = TB.paletteToRgb(style.palette);
	var atlas = TB.proceduralAtlas(rgb, TB.geometryStyle(style.geometry), 32);
	var canvas = document.createElement("canvas");
	canvas.width = atlas.size;
	canvas.height = atlas.size;
	canvas.getContext("2d").putImageData(new ImageData(atlas.data, atlas.size, atlas.size), 0, 0);
	return canvas.toDataURL();
}

function selectStyleForEdit(id, isNew) {
	var style = getStyle(id);
	if (!style) return;
	var draft = clone({
		id: style.id,
		name: style.name,
		geometry: style.geometry,
		builtin: style.builtin,
		note: style.note,
		palette: style.palette,
		atlas: style.atlas,
		overrides: style.overrides || {}
	});
	state.workshop.draft = draft;
	state.workshop.isNew = !!isNew;
	state.workshop.sourceId = id;
	state.workshop.draftRev++;
	state.workshop.atlasReport = null;
	$("#workshopModeBadge").textContent = draft.builtin ? "内置风格（保存为副本）" : "自定义风格";
	$("#btnDeleteStyle").disabled = draft.builtin;
	renderStyleList();
	renderEditor();
}

function touchDraft() {
	state.workshop.draftRev++;
	refreshRoleThumbs();
	refreshAtlasPreview();
}

function renderEditor() {
	var draft = state.workshop.draft;
	var host = $("#styleEditor");
	if (!draft) {
		host.innerHTML = '<div class="editor-empty note">在左侧选择一个风格，或点「新建风格」。</div>';
		return;
	}
	host.innerHTML = "";
	var basic = document.createElement("div");
	basic.className = "grid2";
	basic.innerHTML =
		'<div class="field"><label>风格名称</label><input type="text" id="editName" maxlength="40"></div>' +
		'<div class="field"><label>几何族（决定屋顶与立面做法）</label><select id="editGeometry">' +
		GEOMETRY_OPTIONS.map(function (row) {
			return '<option value="' + row[0] + '">' + escapeHtml(row[2]) + "</option>";
		}).join("") +
		"</select></div>";
	host.appendChild(basic);
	$("#editName").value = draft.name;
	$("#editGeometry").value = TB.geometryStyle(draft.geometry);
	$("#editName").addEventListener("input", function () { draft.name = this.value; saveButtonState(); });
	$("#editGeometry").addEventListener("change", function () {
		draft.geometry = this.value;
		state.workshop.draftRev++;
		refreshRoleThumbs();
		refreshAtlasPreview();
	});

	var hint = document.createElement("p");
	hint.className = "note";
	hint.innerHTML = "风格 = 几何族 + 16 个角色材质。几何族决定屋顶与立面做法；材质可来自 4×4 图集、单角色替换，或用下方调色板程序化生成。";
	host.appendChild(hint);

	// ---- 图集 ----
	var h3 = document.createElement("h3");
	h3.textContent = "整套图集（4×4，16 角色）";
	host.appendChild(h3);
	var atlasRow = document.createElement("div");
	atlasRow.style.cssText = "display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap";
	atlasRow.innerHTML =
		'<div class="atlas-preview" id="editAtlasPreview"></div>' +
		'<div style="flex:1;min-width:260px;display:flex;flex-direction:column;gap:8px">' +
		'<div class="dropzone" id="editAtlasDrop"><b>点击 / 拖入</b> 4×4 图集 PNG（正方形，边长能被 4 整除，建议 512/1024）</div>' +
		'<div style="display:flex;gap:8px;flex-wrap:wrap">' +
		'<button class="btn small" id="editAtlasPick">选择图集文件</button>' +
		'<button class="btn small ghost" id="editAtlasClear">清除图集（改用程序化）</button>' +
		'<button class="btn small ghost" id="editAtlasTemplate">下载当前图集模板</button>' +
		"</div>" +
		'<div class="report" id="editAtlasReport">未加载图集：将用调色板程序化生成 16 个角色的纹理。</div>' +
		"</div>";
	host.appendChild(atlasRow);

	// ---- 角色卡 ----
	var h4 = document.createElement("h3");
	h4.textContent = "角色纹理 / 程序化配色";
	host.appendChild(h4);
	var roleGrid = document.createElement("div");
	roleGrid.className = "role-grid";
	roleGrid.id = "editRoles";
	host.appendChild(roleGrid);
	var note = document.createElement("p");
	note.className = "note";
	note.innerHTML = "点缩略图或「换图」可上传该角色的单张正方形 PNG；色块是该角色的程序化配色（没有图集、也没有单图时使用）。";
	host.appendChild(note);

	renderRoleCards();
	refreshAtlasPreview();
	refreshRoleThumbs();
	bindAtlasEvents();
	saveButtonState();
	if (draft.atlas) validateDraftAtlas(draft.atlas.dataURL);
	else renderAtlasReportInto(null);
}

function saveButtonState() {
	$("#btnSaveStyle").disabled = !state.workshop.draft || !String(state.workshop.draft.name || "").trim();
}

function renderRoleCards() {
	var draft = state.workshop.draft;
	var grid = $("#editRoles");
	if (!grid) return;
	grid.innerHTML = "";
	TB.ROLES.forEach(function (role) {
		var card = document.createElement("div");
		card.className = "role-card";
		card.dataset.role = role;
		card.innerHTML =
			'<div class="thumb" data-thumb="' + role + '"></div>' +
			'<div class="name"><span>' + (TB.ROLE_ZH[role] || role) + '</span><code>' + role + "</code></div>" +
			'<div class="tools"><input type="color" data-color="' + role + '" title="程序化配色">' +
			'<button class="btn small" data-pick="' + role + '">换图</button>' +
			(draft.overrides && draft.overrides[role] ? '<button class="btn small danger" data-clear="' + role + '">×</button>' : "") +
			"</div>";
		grid.appendChild(card);
		var color = card.querySelector('[data-color="' + role + '"]');
		color.value = draft.palette[role] || "#888888";
		color.addEventListener("input", function () {
			draft.palette[role] = this.value;
			state.workshop.draftRev++;
			refreshRoleThumbs();
			refreshAtlasPreview();
		});
		card.querySelector('[data-pick="' + role + '"]').addEventListener("click", function () { pickRoleImage(role); });
		var clear = card.querySelector('[data-clear="' + role + '"]');
		if (clear) clear.addEventListener("click", function () {
			delete draft.overrides[role];
			state.workshop.draftRev++;
			renderRoleCards();
			refreshRoleThumbs();
			renderAtlasReportInto(state.workshop.atlasReport || null);
		});
		var thumb = card.querySelector('[data-thumb="' + role + '"]');
		thumb.addEventListener("click", function () { pickRoleImage(role); });
	});
}

async function refreshRoleThumbs() {
	var draft = state.workshop.draft;
	if (!draft) return;
	var token = ++state.workshop.thumbToken;
	var cacheKey = "draft:" + state.workshop.draftRev;
	try {
		var sources = await resolveSources(draft, cacheKey);
		if (token !== state.workshop.thumbToken) return;
		TB.ROLES.forEach(function (role) {
			var node = document.querySelector('[data-thumb="' + role + '"]');
			if (!node || !sources[role]) return;
			node.style.backgroundImage = "url(" + sourceThumb(sources[role], 96) + ")";
		});
	} catch (err) {
		toast("纹理解析失败：" + err.message, "err");
	}
}

function sourceThumb(source, size) {
	var data = TB.resizeNearest(source.data, source.size, source.size, size, size);
	var canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	var ctx = canvas.getContext("2d");
	var image = ctx.createImageData(size, size);
	image.data.set(data);
	ctx.putImageData(image, 0, 0);
	// 透明像素铺深色底，便于看清边界
	ctx.globalCompositeOperation = "destination-over";
	ctx.fillStyle = "#12151a";
	ctx.fillRect(0, 0, size, size);
	ctx.globalCompositeOperation = "source-over";
	return canvas.toDataURL();
}

function refreshAtlasPreview() {
	var draft = state.workshop.draft;
	var node = $("#editAtlasPreview");
	if (!draft || !node) return;
	if (draft.atlas && draft.atlas.dataURL) {
		node.style.backgroundImage = "url(" + draft.atlas.dataURL + ")";
		node.style.backgroundSize = "100% 100%";
	} else {
		var rgb = TB.paletteToRgb(draft.palette);
		var atlas = TB.proceduralAtlas(rgb, TB.geometryStyle(draft.geometry), 128);
		var canvas = document.createElement("canvas");
		canvas.width = atlas.size;
		canvas.height = atlas.size;
		canvas.getContext("2d").putImageData(new ImageData(atlas.data, atlas.size, atlas.size), 0, 0);
		node.style.backgroundImage = "url(" + canvas.toDataURL() + ")";
		node.style.backgroundSize = "100% 100%";
	}
}

function bindAtlasEvents() {
	var drop = $("#editAtlasDrop");
	var pick = $("#editAtlasPick");
	var clear = $("#editAtlasClear");
	var template = $("#editAtlasTemplate");
	if (pick) pick.addEventListener("click", function () { pickAtlasFile(); });
	if (clear) clear.addEventListener("click", function () {
		state.workshop.draft.atlas = null;
		state.workshop.atlasReport = null;
		state.workshop.draftRev++;
		refreshAtlasPreview();
		refreshRoleThumbs();
		renderAtlasReportInto(null);
		toast("已清除图集，改用程序化纹理");
	});
	if (template) template.addEventListener("click", function () { downloadTemplate(draftAsStyle(), "draft:" + state.workshop.draftRev); });
	if (drop) {
		drop.addEventListener("click", function () { pickAtlasFile(); });
		drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("over"); });
		drop.addEventListener("dragleave", function () { drop.classList.remove("over"); });
		drop.addEventListener("drop", function (e) {
			e.preventDefault();
			drop.classList.remove("over");
			if (e.dataTransfer.files && e.dataTransfer.files[0]) applyAtlasFile(e.dataTransfer.files[0]);
		});
	}
}

function draftAsStyle() {
	var d = state.workshop.draft;
	return {
		id: d.id,
		name: d.name,
		geometry: d.geometry,
		palette: d.palette,
		atlas: d.atlas,
		overrides: d.overrides || {}
	};
}

function pickAtlasFile() {
	var input = document.createElement("input");
	input.type = "file";
	input.accept = "image/png,image/*";
	input.onchange = function () {
		if (input.files && input.files[0]) applyAtlasFile(input.files[0]);
	};
	input.click();
}

async function applyAtlasFile(file) {
	try {
		var dataURL = await readFileAsDataURL(file);
		var image = await imageToRGBA(dataURL);
		var report = validateAtlas(image);
		state.workshop.atlasReport = report;
		if (report.errors.length) {
			renderAtlasReportInto(report);
			toast("图集不符合规范，未应用：" + report.errors[0], "err");
			return;
		}
		state.workshop.draft.atlas = { dataURL: dataURL, size: image.width, cell: Math.floor(image.width / 4), name: file.name };
		state.workshop.draftRev++;
		renderAtlasReportInto(report);
		refreshAtlasPreview();
		refreshRoleThumbs();
		if (report.warnings.length) toast("图集已载入，但有 " + report.warnings.length + " 格需要注意");
		else toast("图集已载入：" + image.width + "×" + image.height);
	} catch (err) {
		toast("图集载入失败：" + err.message, "err");
	}
}

function validateDraftAtlas(dataURL) {
	imageToRGBA(dataURL).then(function (image) {
		var report = validateAtlas(image);
		state.workshop.atlasReport = report;
		renderAtlasReportInto(report);
	}).catch(function () {});
}

function renderAtlasReportInto(report) {
	var node = $("#editAtlasReport");
	if (!node) return;
	var draft = state.workshop.draft;
	if (!draft) return;
	if (!draft.atlas) {
		node.innerHTML = "未加载图集：将用调色板程序化生成 16 个角色的纹理。右侧缩略图即为实际使用效果。";
		return;
	}
	var cell = draft.atlas.cell || Math.floor(draft.atlas.size / 4);
	function scaleText(source, target) {
		if (source === target) return "1:1";
		var k = source < target ? target / source : source / target;
		var text = Math.round(k * 100) / 100;
		return source < target ? "最近邻放大 " + text + "×" : "最近邻缩小 " + text + "×";
	}
	node.innerHTML = renderAtlasReport(report) +
		'<div class="note" style="margin-top:4px">文件：' + escapeHtml(draft.atlas.name || "atlas.png") +
		" · " + draft.atlas.size + "px · " + cell + "px/格</div>" +
		'<div class="note" style="margin-top:2px">采样：<b>最近邻，无插值/无平滑</b> · 屋顶 64px（' + scaleText(cell, 64) +
		"）· 其余 128px（" + scaleText(cell, 128) + "）</div>";
}

function pickRoleImage(role) {
	var input = document.createElement("input");
	input.type = "file";
	input.accept = "image/png,image/*";
	input.onchange = async function () {
		if (!input.files || !input.files[0]) return;
		try {
			var dataURL = await readFileAsDataURL(input.files[0]);
			var image = await imageToRGBA(dataURL);
			if (image.width !== image.height) throw new Error("单角色贴图必须是正方形");
			if (image.width < 16) throw new Error("贴图太小（至少 16×16）");
			state.workshop.draft.overrides[role] = dataURL;
			state.workshop.draftRev++;
			renderRoleCards();
			refreshRoleThumbs();
			renderAtlasReportInto(state.workshop.atlasReport || null);
			toast("已替换「" + (TB.ROLE_ZH[role] || role) + "」纹理");
		} catch (err) {
			toast(err.message, "err");
		}
	};
	input.click();
}

function saveDraftStyle() {
	var draft = state.workshop.draft;
	if (!draft) return;
	var name = String(draft.name || "").trim();
	if (!name) { toast("请先填写风格名称", "err"); return; }
	var id = draft.id;
	var isBuiltin = draft.builtin;
	if (isBuiltin || state.workshop.isNew) {
		id = "user_" + Date.now().toString(36) + Math.floor(Math.random() * 999).toString(36);
	}
	var style = {
		id: id,
		name: name,
		geometry: TB.geometryStyle(draft.geometry),
		builtin: false,
		note: draft.note || "",
		palette: draft.palette,
		atlas: draft.atlas ? { dataURL: draft.atlas.dataURL, size: draft.atlas.size, cell: draft.atlas.cell, name: draft.atlas.name } : null,
		overrides: draft.overrides || {}
	};
	var existing = state.userStyles.findIndex(function (s) { return s.id === id; });
	if (existing >= 0) state.userStyles[existing] = style;
	else state.userStyles.push(style);
	if (!persistUserStyles()) return;
	rebuildStyleList();
	fillStyleSelect();
	bumpRev(id);
	state.cfg.styleId = id;
	state.workshop.draft = clone(style);
	state.workshop.isNew = false;
	state.workshop.sourceId = id;
	$("#workshopModeBadge").textContent = "自定义风格";
	$("#btnDeleteStyle").disabled = false;
	renderStyleList();
	renderEditor();
	syncControls();
	saveConfigSoon();
	scheduleRender(0);
	toast("风格已保存：" + name);
}

function deleteDraftStyle() {
	var draft = state.workshop.draft;
	if (!draft || draft.builtin) return;
	if (!confirm("删除风格「" + draft.name + "」？此操作不可撤销。")) return;
	state.userStyles = state.userStyles.filter(function (s) { return s.id !== draft.id; });
	persistUserStyles();
	rebuildStyleList();
	fillStyleSelect();
	if (state.cfg.styleId === draft.id) {
		state.cfg.styleId = state.styles[0].id;
		syncControls();
		loadSample();
	}
	renderStyleList();
	renderEditor();
	toast("风格已删除");
}

function newStyle() {
	var base = state.workshop.draft || activeStyle();
	var copy = clone(base);
	copy.id = "draft_" + Date.now();
	copy.name = "新风格 " + (state.userStyles.length + 1);
	copy.builtin = false;
	copy.note = "";
	state.workshop.draft = copy;
	state.workshop.isNew = true;
	state.workshop.draftRev++;
	$("#workshopModeBadge").textContent = "新风格（未保存）";
	$("#btnDeleteStyle").disabled = true;
	renderStyleList();
	renderEditor();
}

function exportStyles() {
	var payload = {
		tool: "topdown-building-studio-web",
		toolVersion: TOOL_VERSION,
		version: 1,
		exportedAt: new Date().toISOString(),
		styles: state.userStyles
	};
	if (!state.userStyles.length) {
		toast("还没有自定义风格可导出；内置风格随工具附带");
		return;
	}
	downloadBytes(new TextEncoder().encode(JSON.stringify(payload)),
		"topdown_styles_" + new Date().toISOString().slice(0, 10) + ".json", "application/json");
	toast("已导出 " + state.userStyles.length + " 个自定义风格");
}

function importStyles() {
	var input = document.createElement("input");
	input.type = "file";
	input.accept = "application/json,.json";
	input.onchange = async function () {
		if (!input.files || !input.files[0]) return;
		try {
			var text = await input.files[0].text();
			var payload = JSON.parse(text);
			var list = Array.isArray(payload) ? payload : (payload.styles || []);
			if (!Array.isArray(list) || !list.length) throw new Error("文件里没有风格数据");
			var added = 0;
			list.forEach(function (raw) {
				if (!raw || !raw.name) return;
				var id = String(raw.id || ("user_" + Date.now().toString(36)));
				if (state.userStyles.some(function (s) { return s.id === id; })) {
					id = id + "_" + Math.random().toString(36).slice(2, 6);
				}
				state.userStyles.push({
					id: id,
					name: String(raw.name),
					geometry: normalizeGeometry(raw.geometry),
					builtin: false,
					note: raw.note || "",
					palette: TB.derivePalette(raw.palette || {}),
					atlas: raw.atlas && raw.atlas.dataURL ? { dataURL: raw.atlas.dataURL, size: raw.atlas.size || 512, cell: raw.atlas.cell || 128, name: raw.atlas.name || "atlas.png" } : null,
					overrides: raw.overrides || {}
				});
				added++;
			});
			if (!added) throw new Error("没有可导入的风格");
			if (!persistUserStyles()) return;
			rebuildStyleList();
			fillStyleSelect();
			renderStyleList();
			toast("已导入 " + added + " 个风格");
		} catch (err) {
			toast("导入失败：" + err.message, "err");
		}
	};
	input.click();
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------
function bindEvents() {
	bindControls();

	$("#styleSelect").addEventListener("change", function () {
		state.cfg.styleId = this.value;
		state.cfg.params = defaultParams(state.cfg.typeId, state.cfg.styleId);
		state.cfg.shapeSeed = 60421;
		state.cfg.detailSeed = 101;
		state.cfg.appearanceSeed = 101;
		refreshTypeTitles();
		syncControls();
		selectPart(null);
		saveConfigSoon();
		scheduleRender(0);
	});

	$("#categorySelect").addEventListener("change", function () {
		state.cfg.categoryId = this.value;
		var rows = TB.Catalog.types(state.cfg.categoryId);
		if (rows.length) state.cfg.typeId = rows[0].id;
		fillTypes();
		state.cfg.params = defaultParams(state.cfg.typeId, state.cfg.styleId);
		syncControls();
		selectPart(null);
		saveConfigSoon();
		scheduleRender(0);
	});

	$("#typeSelect").addEventListener("change", function () {
		state.cfg.typeId = this.value;
		state.cfg.params = defaultParams(state.cfg.typeId, state.cfg.styleId);
		syncControls();
		selectPart(null);
		saveConfigSoon();
		scheduleRender(0);
	});

	$("#lookSelect").addEventListener("change", function () {
		state.cfg.look = Number(this.value) || 0;
		saveConfigSoon();
		scheduleRender(90);
	});

	$("#btnRandomBuilding").addEventListener("click", function () {
		state.cfg.shapeSeed = (Number(state.cfg.shapeSeed) + randomSeed()) % 2147483647;
		state.cfg.detailSeed = (Number(state.cfg.detailSeed) + randomSeed()) % 2147483647;
		replay();
	});
	$("#btnRandomDetail").addEventListener("click", function () {
		state.cfg.detailSeed = (Number(state.cfg.detailSeed) + randomSeed()) % 2147483647;
		syncControls();
		saveConfigSoon();
		scheduleRender(0);
	});
	$("#btnReplay").addEventListener("click", replay);

	$("#btnRefresh").addEventListener("click", function () { renderPreview(); });
	$("#btnSavePng").addEventListener("click", exportCurrent);
	$("#btnExportCurrent").addEventListener("click", exportCurrent);
	$("#btnSaveAll").addEventListener("click", exportAll);
	$("#btnExportAll").addEventListener("click", exportAll);
	$("#btnExportRecipe").addEventListener("click", exportRecipe);
	$("#btnTemplate").addEventListener("click", function () { downloadTemplate(activeStyle()); });

	$("#btnReset").addEventListener("click", function () {
		var styleId = state.cfg.styleId;
		state.cfg = normalizeConfig(null);
		state.cfg.styleId = styleId;
		state.cfg.params = defaultParams(state.cfg.typeId, styleId);
		state.mesh = null;
		state.meshKey = "";
		syncControls();
		saveConfigSoon();
		scheduleRender(0);
		toast("已恢复默认参数");
	});

	$("#btnWorkshop").addEventListener("click", openWorkshop);
	$("#btnCloseWorkshop").addEventListener("click", closeWorkshop);
	$("#btnNewStyle").addEventListener("click", newStyle);
	$("#btnSaveStyle").addEventListener("click", saveDraftStyle);
	$("#btnCancelStyle").addEventListener("click", function () {
		if (state.workshop.draft && state.workshop.draft.id) selectStyleForEdit(state.workshop.sourceId, state.workshop.isNew);
	});
	$("#btnDeleteStyle").addEventListener("click", deleteDraftStyle);
	$("#btnExportStyles").addEventListener("click", exportStyles);
	$("#btnImportStyles").addEventListener("click", importStyles);

	$("#btnHelp").addEventListener("click", function () { $("#helpModal").classList.add("open"); });
	$("#btnCloseHelp").addEventListener("click", function () { $("#helpModal").classList.remove("open"); });

	$("#workshopModal").addEventListener("mousedown", function (e) {
		if (e.target === this) closeWorkshop();
	});
	$("#helpModal").addEventListener("mousedown", function (e) {
		if (e.target === this) this.classList.remove("open");
	});
	document.addEventListener("keydown", function (e) {
		if (e.key !== "Escape") return;
		if ($("#textureModal").classList.contains("open")) closeTextureLibrary();
		else if ($("#helpModal").classList.contains("open")) $("#helpModal").classList.remove("open");
		else if ($("#workshopModal").classList.contains("open")) closeWorkshop();
	});

	// 预览缩放 / 平移
	var wrap = $("#previewWrap");
	wrap.addEventListener("wheel", function (e) {
		e.preventDefault();
		var factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
		setZoom(state.zoom * factor);
	}, { passive: false });
	wrap.addEventListener("pointerdown", function (e) {
		if (e.button !== 0) return;
		state.dragging = true;
		state.dragMoved = false;
		state.dragStart = { x: e.clientX, y: e.clientY };
		state.dragPan = { x: state.pan.x, y: state.pan.y };
		wrap.classList.add("dragging");
		wrap.setPointerCapture(e.pointerId);
	});
	wrap.addEventListener("pointermove", function (e) {
		if (!state.dragging) return;
		var dx = e.clientX - state.dragStart.x;
		var dy = e.clientY - state.dragStart.y;
		if (Math.abs(dx) + Math.abs(dy) > 3) state.dragMoved = true;
		state.pan.x = state.dragPan.x + dx;
		state.pan.y = state.dragPan.y + dy;
		layoutPreview();
	});
	wrap.addEventListener("pointerup", function (e) {
		state.dragging = false;
		wrap.classList.remove("dragging");
		try { wrap.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
	});
	wrap.addEventListener("click", function (e) {
		if (state.dragMoved) {
			state.dragMoved = false;
			return;
		}
		pickPartAt(e.clientX, e.clientY);
	});
	wrap.addEventListener("dblclick", resetPreviewView);

	// 部件检查器
	$("#inspTint").addEventListener("change", function () {
		var role = selectedRole();
		if (!role) return;
		var entry = state.partOverrides[role] || {};
		var value = String(this.value).toLowerCase();
		if (value === "#ffffff") delete entry.tint;
		else entry.tint = value;
		if (hasPartOverride(entry)) state.partOverrides[role] = entry;
		else delete state.partOverrides[role];
		partOverrideChanged();
		refreshInspector();
	});
	$("#inspUpload").addEventListener("click", pickPartTexture);
	$("#inspLibrary").addEventListener("click", openTextureLibrary);
	$("#btnCloseTexture").addEventListener("click", closeTextureLibrary);
	$("#btnTextureClear").addEventListener("click", clearPartTexture);
	$("#textureModal").addEventListener("mousedown", function (e) {
		if (e.target === this) closeTextureLibrary();
	});
	// 重置：染色 + 贴图 + 描边一并回到初始状态
	$("#inspReset").addEventListener("click", resetSelectedPartOverride);
	$("#inspClose").addEventListener("click", function () { selectPart(null); });
	// 部件级描边：取消继承时用当前全局值打底，避免输入框是空的
	$("#inspInnerInherit").addEventListener("change", function () {
		var role = selectedRole();
		if (!role) return;
		if (!this.checked && $("#inspInner").value === "") {
			$("#inspInner").value = String(Number(state.cfg.render.outlineInner) || 0);
		}
		$("#inspInner").disabled = this.checked;
		$("#inspInnerColor").disabled = this.checked;
		applyPartOutline(role);
	});
	$("#inspOuterInherit").addEventListener("change", function () {
		var role = selectedRole();
		if (!role) return;
		if (!this.checked && $("#inspOuter").value === "") {
			$("#inspOuter").value = String(Number(state.cfg.render.outlineOuter) || 0);
		}
		$("#inspOuter").disabled = this.checked;
		$("#inspOuterColor").disabled = this.checked;
		applyPartOutline(role);
	});
	["#inspInner", "#inspInnerColor", "#inspOuter", "#inspOuterColor"].forEach(function (sel) {
		var node = $(sel);
		var handler = function () { applyPartOutline(selectedRole()); };
		node.addEventListener("input", handler);
		node.addEventListener("change", handler);
	});
	$("#btnClearParts").addEventListener("click", function () {
		state.partOverrides = {};
		state.partRev++;
		state.partTilesCache.clear();
		state.selection = null;
		saveConfigSoon();
		refreshInspector();
		scheduleRender(0);
		toast("已重置全部部件的染色、贴图与描边");
	});
	$("#pickHint").addEventListener("click", function () {
		toast("在预览里点击任意部位：可查看它引用的纹理，并单独染色、替换贴图或设置部件级描边");
	});
	$("#btnZoomIn").addEventListener("click", function () { setZoom(state.zoom * 1.25); });
	$("#btnZoomOut").addEventListener("click", function () { setZoom(state.zoom / 1.25); });
	$("#btnZoomReset").addEventListener("click", resetPreviewView);
	window.addEventListener("resize", function () { layoutPreview(); });

	// 拖拽图集到页面任意处（风格工坊打开时）
	document.addEventListener("dragover", function (e) {
		if ($("#workshopModal").classList.contains("open")) e.preventDefault();
	});
	document.addEventListener("drop", function (e) {
		if (!$("#workshopModal").classList.contains("open")) return;
		var drop = $("#editAtlasDrop");
		if (!drop) return;
		var inside = drop.contains(e.target);
		if (inside) return; // 交给 dropzone 自己的处理器
		e.preventDefault();
		if (e.dataTransfer.files && e.dataTransfer.files[0]) applyAtlasFile(e.dataTransfer.files[0]);
	});
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
function init() {
	state.userStyles = loadUserStyles();
	rebuildStyleList();
	loadConfig();
	rebuildStyleList();
	var styleExists = state.styles.some(function (s) { return s.id === state.cfg.styleId; });
	if (!styleExists) state.cfg.styleId = state.styles[0].id;
	var categories = TB.Catalog.categories();
	if (!categories.some(function (c) { return c.id === state.cfg.categoryId; })) state.cfg.categoryId = categories[0].id;
	fillStyleSelect();
	fillCategories();
	fillTypes();
	if (!state.cfg.params || !Object.keys(state.cfg.params).length) state.cfg.params = defaultParams(state.cfg.typeId, state.cfg.styleId);
	bindEvents();
	syncControls();
	saveConfigSoon();
	renderStyleList();
	$("#zoomLabel").textContent = "100%";
	$("#appVersion").textContent = "v" + TOOL_VERSION;
	$("#appVersion").title = "Topdown 建筑工坊 · 网页版 v" + TOOL_VERSION;
	document.title = "Topdown 建筑工坊 · 网页版 v" + TOOL_VERSION;
	// 首屏先画一帧，避免空白
	scheduleRender(0);
	setTimeout(function () {
		layoutPreview();
	}, 80);
	// 深链接：便于截图 / 直接打开某个面板
	if (location.hash === "#workshop") setTimeout(openWorkshop, 60);
	else if (location.hash === "#help") setTimeout(function () { $("#helpModal").classList.add("open"); }, 60);
	// 调试接口（控制台可用）
	window.TBApp = {
		version: TOOL_VERSION,
		state: state,
		render: renderPreview,
		exportAll: exportAll,
		exportCurrent: exportCurrent,
		openWorkshop: openWorkshop,
		recipe: recipeDocument,
		selectPart: selectPart,
		pickAt: pickPartAt,
		setPartTexture: setPartTexture,
		openTextureLibrary: openTextureLibrary,
		closeTextureLibrary: closeTextureLibrary,
		textureLibrary: collectRoleTextures,
		clearPartTexture: clearPartTexture
	};
}

init();
})();

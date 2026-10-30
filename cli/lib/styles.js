"use strict";
/**
 * 风格库：内置 10 套（js/atlases.js）+ 自定义（cli/styles/*.json）。
 *
 * 自定义风格的 JSON 结构与网页 localStorage / 网页「风格包」完全一致：
 *   { id, name, geometry, builtin:false, note, palette, atlas:{dataURL,size,cell,name}, overrides:{role:dataURL} }
 * 这样网页导出的风格包可以直接丢进 cli/styles/，CLI 做出来的风格包也能拖回网页导入。
 */
const fs = require("fs");
const path = require("path");
const env = require("./env");
const png = require("./png");
const json = require("./json");
const assets = require("./assets");

const STORE = path.join(env.ROOT, "cli", "styles");
const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

function ensureStore() {
	try {
		fs.mkdirSync(STORE, { recursive: true });
	} catch (err) { /* 忽略 */ }
}

function fileOf(id) {
	return path.join(STORE, id + ".json");
}

function sanitizeId(raw) {
	const id = String(raw || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
	if (!ID_PATTERN.test(id)) throw new Error("风格 id 只能是字母/数字/下划线/短横线：" + raw);
	return id;
}

function normalize(raw) {
	const TB = env.loadCore();
	const style = {
		id: String(raw.id),
		name: String(raw.name || raw.id),
		geometry: TB.geometryStyle(String(raw.geometry || "jiangnan")),
		builtin: false,
		note: raw.note || "",
		palette: TB.derivePalette(raw.palette || {}),
		atlas: null,
		overrides: {}
	};
	if (raw.atlas && raw.atlas.dataURL) {
		style.atlas = {
			dataURL: raw.atlas.dataURL,
			size: Number(raw.atlas.size) || 0,
			cell: Number(raw.atlas.cell) || 0,
			name: raw.atlas.name || "atlas.png"
		};
		if (!style.atlas.size) {
			const image = png.fromDataURL(style.atlas.dataURL);
			style.atlas.size = image.width;
			style.atlas.cell = Math.floor(image.width / 4);
		}
	}
	Object.keys(raw.overrides || {}).forEach(function (role) {
		if (TB.ROLES.indexOf(role) >= 0 && typeof raw.overrides[role] === "string") {
			style.overrides[role] = raw.overrides[role];
		}
	});
	return style;
}

function list() {
	ensureStore();
	let names = [];
	try {
		names = fs.readdirSync(STORE).filter(function (name) { return name.endsWith(".json"); });
	} catch (err) {
		return [];
	}
	const out = [];
	names.forEach(function (name) {
		try {
			const stat = fs.statSync(path.join(STORE, name));
			const raw = json.read(path.join(STORE, name));
			const style = normalize(Object.assign({ id: name.replace(/\.json$/, "") }, raw));
			out.push({
				id: style.id,
				name: style.name,
				geometry: style.geometry,
				note: style.note,
				hasAtlas: !!style.atlas,
				atlasSize: style.atlas ? style.atlas.size : 0,
				roles: Object.keys(style.overrides).length,
				mtimeMs: stat.mtimeMs,
				path: path.join(STORE, name)
			});
		} catch (err) {
			/* 单个文件坏了不影响其它风格 */
		}
	});
	out.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
	return out;
}

function getUser(id) {
	const file = fileOf(id);
	if (!fs.existsSync(file)) return null;
	const raw = json.read(file);
	const style = normalize(Object.assign({ id: id }, raw));
	style.stamp = "user:" + id + ":" + Math.round(fs.statSync(file).mtimeMs);
	return style;
}

function saveUser(style) {
	ensureStore();
	const payload = {
		id: style.id,
		name: style.name,
		geometry: style.geometry,
		builtin: false,
		note: style.note || "",
		palette: style.palette,
		atlas: style.atlas,
		overrides: style.overrides || {}
	};
	fs.writeFileSync(fileOf(style.id), JSON.stringify(payload));
	return fileOf(style.id);
}

function deleteUser(id) {
	const file = fileOf(id);
	if (!fs.existsSync(file)) throw new Error("没有这个自定义风格：" + id);
	fs.unlinkSync(file);
	return file;
}

/** 统一的风格记录：内置 / 自定义同构。 */
function resolve(id) {
	const builtin = assets.builtinStyle(id);
	if (builtin) {
		const TB = env.loadCore();
		return {
			id: builtin.id,
			name: builtin.name,
			geometry: TB.geometryStyle(builtin.geometry),
			builtin: true,
			note: builtin.note,
			palette: builtin.palette,
			atlas: { size: builtin.size, cell: builtin.cell, name: builtin.id + ".png" },
			overrides: {},
			stamp: "builtin:" + id
		};
	}
	const user = getUser(id);
	if (!user) return null;
	return user;
}

/** 全部风格（内置在前，自定义在后）。 */
function all() {
	const TB = env.loadCore();
	const builtin = assets.builtinStyles().styles.map(function (row) {
		return {
			id: row.id,
			name: row.name,
			geometry: TB.geometryStyle(row.geometry),
			builtin: true,
			note: row.note,
			hasAtlas: true,
			atlasSize: row.size,
			roles: 0
		};
	});
	return builtin.concat(list().map(function (row) {
		return Object.assign({}, row, { builtin: false });
	}));
}

/** 解析出 16 个材质角色的源像素（未染色、未缩放）——对齐 app.js#resolveSources。 */
function sources(style, greenhouse) {
	const TB = env.loadCore();
	const geometry = TB.geometryStyle(style.geometry);
	const paletteRgb = TB.paletteToRgb(style.palette);
	let atlasCells = null;
	if (style.builtin) {
		const atlas = assets.builtinAtlas(style.id);
		if (atlas) atlasCells = TB.atlasSources(atlas);
	} else if (style.atlas && style.atlas.dataURL) {
		const image = png.fromDataURL(style.atlas.dataURL);
		if (image.width % 4 !== 0 || image.width !== image.height) {
			throw new Error("风格「" + style.name + "」的图集必须是正方形且边长能被 4 整除");
		}
		atlasCells = TB.atlasSources(TB.makeAtlas(new Uint8ClampedArray(image.data), image.width));
	}
	const result = {};
	TB.ROLES.forEach(function (role) {
		if (style.overrides && style.overrides[role]) {
			const image = png.fromDataURL(style.overrides[role]);
			result[role] = { data: new Uint8ClampedArray(image.data), size: image.width };
		} else if (atlasCells) {
			result[role] = atlasCells[role];
		} else {
			result[role] = { data: TB.proceduralCell(role, geometry, paletteRgb), size: 32 };
		}
	});
	if (greenhouse) {
		// 温室：插件用半透明淡青玻璃，这里用浅青格窗近似（与网页一致）
		result.glass = { data: TB.glazingCell(), size: 32 };
	}
	return result;
}

// ---------------------------------------------------------------------------
// 图集校验 / 模板
// ---------------------------------------------------------------------------
function validateAtlas(image) {
	const TB = env.loadCore();
	const errors = [], warnings = [], roles = [];
	const size = image.width;
	if (image.width !== image.height) errors.push("图集必须是正方形（当前 " + image.width + "×" + image.height + "）");
	if (size % 4 !== 0) errors.push("边长必须能被 4 整除（当前 " + size + "）");
	if (size < 64) errors.push("边长至少 64px（建议 512 或 1024）");
	if (size > 4096) errors.push("边长不要超过 4096px");
	const ok = errors.length === 0;
	const cell = Math.floor(size / 4);
	if (ok) {
		TB.ROLES.forEach(function (role, index) {
			const x0 = (index % 4) * cell, y0 = Math.floor(index / 4) * cell;
			const colors = new Set();
			let opaque = 0, total = 0;
			const step = Math.max(1, Math.floor(cell / 48));
			for (let y = y0; y < y0 + cell; y += step) {
				for (let x = x0; x < x0 + cell; x += step) {
					const o = (y * size + x) * 4;
					total++;
					if (image.data[o + 3] > 8) {
						opaque++;
						colors.add(((image.data[o] >> 3) << 10) | ((image.data[o + 1] >> 3) << 5) | (image.data[o + 2] >> 3));
					}
				}
			}
			const uniq = colors.size;
			const opaqueRatio = total ? opaque / total : 0;
			const empty = opaqueRatio < 0.02;
			const flat = role !== "shadow" && uniq <= 2 && opaqueRatio > 0.5;
			roles.push({
				role: role, zh: TB.ROLE_ZH[role] || role, colors: uniq,
				opaque: Math.round(opaqueRatio * 1000) / 1000, empty: empty, flat: flat, ok: !empty && !flat
			});
			if (empty) warnings.push("「" + (TB.ROLE_ZH[role] || role) + "」格几乎全透明，渲染会露底");
			else if (flat) warnings.push("「" + (TB.ROLE_ZH[role] || role) + "」格接近纯色，缺少像素细节");
		});
	}
	return { ok: ok, size: size, cell: cell, errors: errors, warnings: warnings, roles: roles };
}

/** 把风格实际使用的纹理拼回 4×4 图集模板，方便画师重绘。 */
function template(style, cellSize) {
	const TB = env.loadCore();
	const sourcesMap = sources(style, false);
	const atlas = TB.assembleAtlas(sourcesMap, cellSize || 128);
	return atlas;
}

// ---------------------------------------------------------------------------
// 创建 / 导入导出
// ---------------------------------------------------------------------------
function createFromAtlas(options) {
	const TB = env.loadCore();
	const image = png.decodeFile(options.file);
	const report = validateAtlas(image);
	if (!report.ok) {
		const err = new Error("图集不符合规范：" + report.errors.join("；"));
		err.report = report;
		throw err;
	}
	const buffer = fs.readFileSync(options.file);
	const style = {
		id: options.id ? sanitizeId(options.id) : "user_" + Date.now().toString(36),
		name: options.name || path.basename(options.file, path.extname(options.file)),
		geometry: TB.geometryStyle(options.geometry || "jiangnan"),
		note: options.note || "",
		palette: TB.derivePalette({}),
		atlas: {
			dataURL: png.toDataURL(buffer),
			size: image.width,
			cell: Math.floor(image.width / 4),
			name: path.basename(options.file)
		},
		overrides: {}
	};
	const file = saveUser(style);
	return { style: style, path: file, report: report };
}

function createFromPalette(options) {
	const TB = env.loadCore();
	const palette = {};
	Object.keys(options.palette || {}).forEach(function (role) {
		if (TB.ROLES.indexOf(role) < 0) throw new Error("未知材质角色：" + role + "（见 list roles）");
		if (!/^#[0-9a-fA-F]{6}$/.test(options.palette[role])) throw new Error("颜色需要 #rrggbb 形式：" + options.palette[role]);
		palette[role] = options.palette[role].toLowerCase();
	});
	const style = {
		id: options.id ? sanitizeId(options.id) : "user_" + Date.now().toString(36),
		name: options.name || "自定义风格",
		geometry: TB.geometryStyle(options.geometry || "jiangnan"),
		note: options.note || "",
		palette: TB.derivePalette(palette),
		atlas: null,
		overrides: {}
	};
	const file = saveUser(style);
	return { style: style, path: file };
}

function setRole(options) {
	const TB = env.loadCore();
	if (TB.ROLES.indexOf(options.role) < 0) throw new Error("未知材质角色：" + options.role + "（见 list roles）");
	const style = getUser(options.id);
	if (!style) throw new Error("没有这个自定义风格：" + options.id);
	const image = png.decodeFile(options.image);
	if (image.width !== image.height) throw new Error("单角色贴图必须是正方形");
	if (image.width < 16) throw new Error("贴图太小（至少 16×16）");
	style.overrides[options.role] = png.toDataURL(fs.readFileSync(options.image));
	const file = saveUser(style);
	return { id: style.id, role: options.role, path: file, size: image.width };
}

function exportPack(file, ids) {
	const keep = ids && ids.length ? new Set(ids) : null;
	const out = list().filter(function (row) {
		if (row.id.startsWith("builtin:")) return false;
		return !keep || keep.has(row.id);
	}).map(function (row) {
		const style = getUser(row.id);
		return {
			id: style.id,
			name: style.name,
			geometry: style.geometry,
			builtin: false,
			note: style.note,
			palette: style.palette,
			atlas: style.atlas,
			overrides: style.overrides
		};
	});
	if (!out.length) throw new Error("没有可导出的自定义风格");
	const payload = {
		tool: "topdown-building-studio-web",
		toolVersion: "1.0",
		version: 1,
		exportedAt: new Date().toISOString(),
		styles: out
	};
	fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(payload));
	return { file: file, count: out.length, ids: out.map(function (s) { return s.id; }) };
}

function importPack(file) {
	const payload = json.read(file, "风格包");
	const list0 = Array.isArray(payload) ? payload : (payload.styles || []);
	if (!Array.isArray(list0) || !list0.length) throw new Error("文件里没有风格数据");
	const existing = new Set(list().map(function (row) { return row.id; }));
	const builtin = new Set(assets.builtinStyles().styles.map(function (row) { return row.id; }));
	const added = [];
	list0.forEach(function (raw) {
		if (!raw || !raw.name) return;
		let id = sanitizeId(raw.id || ("user_" + Date.now().toString(36)));
		if (builtin.has(id)) id = id + "_user";
		while (existing.has(id)) id = id + "_" + Math.random().toString(36).slice(2, 5);
		const style = normalize(Object.assign({}, raw, { id: id }));
		saveUser(style);
		existing.add(id);
		added.push(id);
	});
	if (!added.length) throw new Error("没有可导入的风格");
	return { count: added.length, ids: added };
}

/** 直接从风格包文件取一个风格（不写入风格库），配合 render --style-file 用。 */
function pickFromPack(file, id) {
	const payload = json.read(file, "风格包");
	const list0 = Array.isArray(payload) ? payload : (payload.styles || []);
	if (!list0.length) throw new Error("风格包里没有风格：" + file);
	let raw = null;
	if (id) {
		raw = list0.filter(function (row) { return row && String(row.id) === String(id); })[0] || null;
		if (!raw) throw new Error("风格包里没有 id=" + id + " 的风格");
	} else {
		raw = list0[0];
	}
	const style = normalize(raw);
	style.stamp = "pack:" + path.basename(file) + ":" + style.id;
	return style;
}

module.exports = {
	STORE, list, all, resolve, getUser, saveUser, deleteUser,
	sources, validateAtlas, template,
	createFromAtlas, createFromPalette, setRole, exportPack, importPack, sanitizeId, pickFromPack
};

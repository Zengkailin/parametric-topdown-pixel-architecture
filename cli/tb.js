#!/usr/bin/env node
"use strict";
/**
 * 参数化 Topdown 建筑 · 命令行入口
 *
 * 设计目标是「给 agent 用」：
 *   - 默认只输出一行 JSON 摘要（省 token），--quiet 只回产物路径；
 *   - 所有枚举/范围都能用 `list` / `schema` 一条命令查完，不需要读源码；
 *   - `batch` 单进程批量出图，图集与 mip 只解析一次；
 *   - `--thumb` 额外给一张缩略图，视觉模型可以直接看效果；
 *   - 产物命名、配方 JSON 与网页版一致，可互相迁移。
 */
const fs = require("fs");
const path = require("path");
const env = require("./lib/env");
const png = require("./lib/png");
const json = require("./lib/json");
const spec = require("./lib/spec");
const cliArgs = require("./lib/args");
const config = require("./lib/config");
const styles = require("./lib/styles");
const render = require("./lib/render");
const embedded = require("./lib/embedded");

const ALIASES = { s: "style", t: "type", o: "out", p: "pitch", d: "dirs", h: "help", n: "name", q: "quiet" };
const BOOLEANS = ["json", "quiet", "help", "verbose", "sheet", "random", "random-detail", "replay", "aa", "dry-run", "clear-parts", "full", "data-url", "meta"];
const OPTIONAL = ["thumb", "zip"];
const REPEAT = ["param", "part"];

function print(text) {
	process.stdout.write(text + "\n");
}

function fail(err) {
	const quiet = process.argv.indexOf("--quiet") >= 0;
	if (quiet) {
		process.stderr.write(String(err && err.message ? err.message : err) + "\n");
	} else {
		const payload = { ok: false, error: String(err && err.message ? err.message : err) };
		if (err && err.hint) payload.hint = err.hint;
		if (err && err.report) payload.report = err.report;
		process.stderr.write(JSON.stringify(payload) + "\n");
	}
	process.exitCode = 1;
}

function emit(payload, flags) {
	if (flags && flags.quiet) {
		const lines = [];
		(payload.files || []).forEach(function (item) { lines.push(item); });
		(payload.thumbs || []).forEach(function (item) { lines.push(item); });
		if (payload.sheet) lines.push(payload.sheet);
		if (payload.zip) lines.push(payload.zip);
		if (payload.recipe) lines.push(payload.recipe);
		print(lines.length ? lines.join("\n") : JSON.stringify(payload));
		return;
	}
	print(JSON.stringify(payload));
}

function parseFlags(argv) {
	return cliArgs.parse(argv, {
		booleans: BOOLEANS,
		optional: OPTIONAL,
		repeat: REPEAT,
		aliases: ALIASES
	});
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------
function prepare(a) {
	let inlineStyle = null;
	if (a["style-file"]) inlineStyle = styles.pickFromPack(String(a["style-file"]), a.style);
	let base = null;
	if (a.preset) base = loadPreset(String(a.preset)).config;
	const parsed = config.fromArgs(a, { inlineStyle: inlineStyle, base: base });
	return { cfg: parsed.cfg, warnings: parsed.warnings, style: parsed.style, inlineStyle: inlineStyle };
}

function dryRun(prepared, a) {
	const TB = env.loadCore();
	const cfg = prepared.cfg;
	const mesh = TB.buildBuilding(config.buildProfile(cfg));
	const view = TB.prepareView(mesh.bounds, Object.assign({}, cfg.view));
	emit({
		ok: true,
		dryRun: true,
		version: config.TOOL_VERSION,
		style: cfg.styleId,
		type: cfg.typeId,
		params: cfg.params,
		canvas: view ? view.canvas : null,
		dirs: view ? view.yaws.length : 0,
		pitch: cfg.view.pitch,
		proj: cfg.view.projection ? "persp" : "ortho",
		tris: mesh.triangles,
		seeds: [cfg.shapeSeed, cfg.detailSeed, cfg.appearanceSeed],
		parts: Object.keys(cfg.partOverrides || {}),
		meta: a.meta !== false,
		warnings: prepared.warnings
	}, a);
}

function summarize(cfg, result, written, warnings) {
	const view = result.view;
	const payload = {
		ok: true,
		version: config.TOOL_VERSION,
		style: cfg.styleId,
		type: cfg.typeId,
		canvas: view.canvas,
		dirs: view.yaws.length,
		pitch: Math.round(view.pitch * 10) / 10,
		proj: view.perspective ? "persp" : "ortho",
		tris: result.mesh.triangles,
		ink: written.stats.ink,
		bbox: written.stats.bbox,
		ms: result.ms,
		seeds: [cfg.shapeSeed, cfg.detailSeed, cfg.appearanceSeed],
		files: written.files
	};
	if (written.thumbs.length) payload.thumbs = written.thumbs;
	if (written.sheet) payload.sheet = written.sheet.file;
	if (written.zip) payload.zip = written.zip;
	if (written.recipe) payload.recipe = written.recipe;
	payload.meta = written.meta;
	if (written.visible && written.visible.length) payload.visible = written.visible;
	if (view.fovLimit) payload.note = "FOV≈0，实际按正交渲染";
	if (warnings && warnings.length) payload.warnings = warnings;
	return payload;
}

function runRender(a, base) {
	const prepared = prepare(a);
	if (a["dry-run"]) return dryRun(prepared, a);
	const engine = render.createEngine(prepared.inlineStyle);
	const result = engine.render(prepared.cfg);
	const written = render.writeOutputs(prepared.cfg, result, {
		out: a.out,
		name: a.name,
		sheet: a.sheet,
		zip: a.zip,
		thumb: a.thumb,
		saveRecipe: a["save-recipe"],
		meta: a.meta !== false
	});
	emit(summarize(prepared.cfg, result, written, prepared.warnings), a);
}

function cmdRender(argv) {
	const a = parseFlags(argv);
	if (a.help) return print(spec.RENDER_HELP);
	return runRender(a);
}

// ---------------------------------------------------------------------------
// batch
// ---------------------------------------------------------------------------
const JOB_FLAG = {
	style: "--style", type: "--type", pitch: "--pitch", proj: "--proj", fov: "--fov",
	dirs: "--dirs", yaw: "--yaw", size: "--size", scale: "--scale", ppm: "--ppm",
	padding: "--padding", look: "--look", seed: "--seed", dseed: "--dseed", aseed: "--aseed",
	random: "--random", "random-detail": "--random-detail", replay: "--replay",
	"outline-inner": "--outline-inner", "outline-outer": "--outline-outer",
	"outline-silhouette": "--outline-silhouette", "outline-color": "--outline-color",
	"outline-color-outer": "--outline-color-outer", "outline-color-silhouette": "--outline-color-silhouette",
	aa: "--aa", bg: "--bg", name: "--name", out: "--out", sheet: "--sheet", zip: "--zip",
	thumb: "--thumb", "save-recipe": "--save-recipe", "clear-parts": "--clear-parts",
	"style-file": "--style-file", recipe: "--recipe", preset: "--preset", meta: "--meta"
};

function jobToArgv(job) {
	const out = [];
	Object.keys(job).forEach(function (key) {
		const value = job[key];
		if ((key === "param" || key === "params") && value && typeof value === "object") {
			Object.keys(value).forEach(function (name) { out.push("--param", name + "=" + value[name]); });
			return;
		}
		if ((key === "part" || key === "parts") && value && typeof value === "object") {
			Object.keys(value).forEach(function (role) {
				const entry = value[role] || {};
				Object.keys(entry).forEach(function (field) { out.push("--part", role + ":" + field + "=" + entry[field]); });
			});
			return;
		}
		const flag = JOB_FLAG[key];
		if (!flag) throw new Error("batch job 里有未知键：" + key + "（可用：" + Object.keys(JOB_FLAG).join(" ") + " param part）");
		if (value === true) out.push(flag);
		else if (value === false) out.push("--no-" + key);
		else out.push(flag, String(value));
	});
	return out;
}

function cmdBatch(argv) {
	const a = parseFlags(argv);
	if (a.help) return print(spec.BATCH_HELP);
	const source = a._[0];
	if (!source) throw new Error("batch 需要清单文件：node cli/tb.js batch jobs.json（或 - 从 stdin 读）");
	const text = source === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(source, "utf8");
	const manifest = json.parse(text, source === "-" ? "stdin" : "批量清单");
	const defaults = manifest.defaults || {};
	const jobs = Array.isArray(manifest) ? manifest : manifest.jobs;
	if (!Array.isArray(jobs) || !jobs.length) throw new Error("清单里没有 jobs");
	const outBase = manifest.out ? path.resolve(String(manifest.out)) : null;
	const started = Date.now();
	const files = [];
	const thumbs = [];
	const errors = [];
	let done = 0;
	jobs.forEach(function (job, index) {
		try {
			const merged = Object.assign({}, defaults, job);
			if (!merged.out) {
				const name = merged.name || ((merged.style || "jiangnan") + "_" + (merged.type || "house"));
				merged.out = path.join(outBase || path.join(render.OUT_ROOT, "batch"), String(name));
			} else if (outBase && !path.isAbsolute(String(merged.out))) {
				merged.out = path.join(outBase, String(merged.out));
			}
			const jobArgs = parseFlags(jobToArgv(merged));
			const prepared = prepare(jobArgs);
			if (jobArgs["dry-run"]) {
				dryRun(prepared, jobArgs);
				done++;
				return;
			}
			const engine = render.createEngine(prepared.inlineStyle);
			const result = engine.render(prepared.cfg);
			const written = render.writeOutputs(prepared.cfg, result, {
				out: jobArgs.out,
				name: jobArgs.name,
				sheet: jobArgs.sheet,
				zip: jobArgs.zip,
				thumb: jobArgs.thumb,
				saveRecipe: jobArgs["save-recipe"],
				meta: jobArgs.meta !== false
			});
			written.files.forEach(function (file) { files.push(file); });
			written.thumbs.forEach(function (file) { thumbs.push(file); });
			done++;
		} catch (err) {
			errors.push({ job: index, name: job.name || null, error: String(err.message || err) });
		}
	});
	const payload = {
		ok: errors.length === 0,
		count: done,
		failed: errors.length,
		ms: Date.now() - started,
		files: files
	};
	if (thumbs.length) payload.thumbs = thumbs;
	if (errors.length) payload.errors = errors;
	const quiet = a.quiet;
	if (quiet) {
		const lines = files.concat(thumbs);
		print(lines.length ? lines.join("\n") : JSON.stringify(payload));
	} else {
		print(JSON.stringify(payload));
	}
	if (errors.length) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------
function fmt(value) {
	if (value === true) return "true";
	if (value === false) return "false";
	if (typeof value === "number") return String(Math.round(value * 1000) / 1000);
	return String(value);
}

function cmdList(argv) {
	const a = parseFlags(argv);
	if (a.help) return print(spec.LIST_HELP);
	const what = a._[0] || "styles";
	const TB = env.loadCore();

	if (what === "styles") {
		const rows = styles.all();
		if (a.json) return print(JSON.stringify(rows));
		return print(rows.map(function (row) {
			return [row.id, row.name, row.geometry, row.builtin ? "builtin" : "user", row.hasAtlas ? "atlas" + (row.atlasSize || "") : "palette"].join("\t");
		}).join("\n"));
	}
	if (what === "types") {
		const styleId = a.style || "jiangnan";
		const rows = TB.Catalog.types().map(function (row) {
			return {
				id: row.id, category: row.category, archetype: row.archetype,
				zh: TB.Catalog.title(row.id, styleId), kind: row.kind
			};
		});
		if (a.json) return print(JSON.stringify(rows));
		return print(rows.map(function (row) {
			return [row.id, row.category, row.archetype, row.zh].join("\t");
		}).join("\n"));
	}
	if (what === "params") {
		const typeId = a._[1] || "house";
		const entry = TB.Catalog.entry(typeId);
		if (!entry) throw new Error("未知建筑类型：" + typeId + "（见 list types）");
		const defaults = TB.Catalog.parameters(typeId, a.style || "jiangnan");
		const fields = TB.Catalog.fields(typeId);
		const rows = Object.keys(spec.PARAM_SPEC).map(function (key) {
			const def = spec.PARAM_SPEC[key];
			return {
				key: key,
				default: defaults[key],
				min: def.min, max: def.max, step: def.step, enum: def.enum || null, bool: !!def.bool,
				shown: fields.indexOf(key) >= 0,
				note: def.note
			};
		});
		if (a.json) return print(JSON.stringify(rows));
		return print(rows.map(function (row) {
			const range = row.bool ? "bool" : (row.enum ? row.enum.join("/") : row.min + ".." + row.max + " step " + row.step);
			return [row.key, fmt(row.default), range, row.shown ? "on" : "-", row.note].join("\t");
		}).join("\n"));
	}
	if (what === "roles") {
		const rows = TB.ROLES.map(function (role) { return { role: role, zh: TB.ROLE_ZH[role] || role }; });
		if (a.json) return print(JSON.stringify(rows));
		return print(rows.map(function (row) { return row.role + "\t" + row.zh; }).join("\n"));
	}
	if (what === "enums") {
		const payload = {
			projection: spec.ENUMS.projection,
			dirs: spec.ENUMS.dirs,
			size: spec.ENUMS.size,
			scale: spec.ENUMS.scale,
			look: spec.ENUMS.look,
			roof: spec.ENUMS.roof,
			ranges: spec.RANGE,
			seeds: { shapeSeed: 60421, detailSeed: 101, appearanceSeed: 101 }
		};
		return print(JSON.stringify(payload));
	}
	if (what === "presets") {
		const rows = listPresets();
		if (a.json) return print(JSON.stringify(rows));
		return print(rows.map(function (row) { return row.name + "\t" + (row.style || "") + "\t" + (row.type || ""); }).join("\n"));
	}
	throw new Error("list 只支持 styles / types / params / roles / enums / presets");
}

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------
function cmdSchema(argv) {
	const a = parseFlags(argv);
	if (a.help) return print(spec.SCHEMA_HELP);
	const TB = env.loadCore();
	const payload = {
		tool: "topdown-building-studio-cli",
		version: config.TOOL_VERSION,
		entry: "node cli/tb.js",
		commands: {
			render: "渲染（全参数 / 多方向 / 精灵表 / ZIP / 部件覆盖）",
			batch: "单进程批量渲染清单",
			list: "列出风格/类型/参数/角色/枚举",
			schema: "本清单",
			rec: "配方 show / apply",
			inspect: "读 PNG 内嵌配方（版本 + 全部视角/建筑参数），可存成 recipe.json 或直接回放",
			styles: "自定义风格库（create/import/export/set-role/template/delete）",
			atlas: "atlas check 校验 4×4 图集",
			preset: "参数预设 save/list/show/delete"
		},
		styles: styles.all().map(function (row) { return row.id; }),
		types: TB.Catalog.types().map(function (row) { return row.id; }),
		enums: {
			projection: spec.ENUMS.projection,
			dirs: spec.ENUMS.dirs,
			size: spec.ENUMS.size,
			scale: spec.ENUMS.scale,
			look: spec.ENUMS.look,
			roof: spec.ENUMS.roof
		},
		ranges: {
			pitch: [0, 90], fov: [0, 100], yaw: [-180, 180], ppm: [4, 200], padding: [0, 40],
			outline: [0, 16]
		},
		params: Object.keys(spec.PARAM_SPEC).reduce(function (acc, key) {
			const def = spec.PARAM_SPEC[key];
			acc[key] = def.bool ? "bool" : (def.enum ? def.enum : [def.min, def.max, def.step]);
			return acc;
		}, {}),
		flags: {
			value: ["style", "type", "out", "name", "pitch", "proj", "fov", "dirs", "yaw", "size", "scale", "ppm", "padding",
				"look", "seed", "dseed", "aseed", "outline-inner", "outline-outer", "outline-silhouette",
				"outline-color", "outline-color-outer", "outline-color-silhouette", "bg", "recipe", "save-recipe",
				"parts-json", "style-file", "preset"],
			boolean: ["sheet", "zip", "thumb", "json", "quiet", "dry-run", "random", "random-detail", "replay",
				"aa", "no-aa", "clear-parts", "full", "data-url", "meta", "no-meta"],
			repeat: ["param", "part"]
		},
		imageMeta: {
			default: "开启；--no-meta 关闭",
			chunks: {
				Software: "tEXt：产生该图的工具与版本",
				"topdown:version": "tEXt：工具版本号（v1.1 起）",
				"topdown:recipe": "iTXt：完整配方 JSON（UTF-8，deflate 压缩）"
			},
			read: "node cli/tb.js inspect <png>（--full 输出完整配方，--save-recipe <file> 存成 JSON）",
			replay: "node cli/tb.js rec apply <png> -o out/again（PNG 可直接当配方用）",
			note: "部件贴图 dataURL 体积大，入图时剥离为 textureCrc32/textureBytes；像素数据不受影响"
		},
		defaults: {
			style: "jiangnan", type: "house", pitch: 45, proj: "ortho", dirs: 1, size: 512,
			scale: "auto", ppm: 48, padding: 8, look: 0, seeds: [60421, 101, 101], aa: true, bg: "transparent"
		},
		output: {
			default: "cli/out/<风格>_<类型>_p<俯角>_<方向数>d.png",
			summary: "stdout 一行 JSON：ok/style/type/canvas/dirs/pitch/proj/tris/ink/bbox/ms/seeds/files",
			quiet: "--quiet 只输出产物路径",
			errors: "退出码 1，stderr 输出 {ok:false,error,hint}"
		},
		examples: [
			"node cli/tb.js render forest inn -o out/inn.png",
			"node cli/tb.js render jiangnan house -p 45 -d 4 --sheet --size 512",
			"node cli/tb.js render desert watchtower --param floors=3 --thumb",
			"node cli/tb.js render jiangnan house --part roof:tint=#ffcc00 --outline-silhouette 2",
			"node cli/tb.js inspect out/inn.png",
			"node cli/tb.js rec apply out/inn.png -o out/again",
			"node cli/tb.js batch jobs.json"
		]
	};
	if (a.full) {
		payload.typesFull = TB.Catalog.types().reduce(function (acc, row) {
			acc[row.id] = {
				category: row.category, archetype: row.archetype, kind: row.kind,
				fields: TB.Catalog.fields(row.id),
				defaults: TB.Catalog.parameters(row.id, "jiangnan")
			};
			return acc;
		}, {});
	}
	print(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// rec（配方）
// ---------------------------------------------------------------------------
function cmdRecipe(argv) {
	const a = parseFlags(argv);
	if (a.help) return print(spec.RECIPE_HELP);
	const sub = a._[0];
	if (sub === "show" || sub === "check") {
		const file = a._[1];
		if (!file) throw new Error("rec show 需要配方文件（recipe.json 或内嵌元信息的 PNG）");
		const fromPng = embedded.isPngFile(file);
		const doc = embedded.readRecipeDoc(file);
		const parsed = config.configFromRecipe(doc);
		const cfg = parsed.cfg;
		print(JSON.stringify({
			ok: true,
			source: fromPng ? "png" : "json",
			style: cfg.styleId,
			type: cfg.typeId,
			params: cfg.params,
			seeds: [cfg.shapeSeed, cfg.detailSeed, cfg.appearanceSeed],
			look: cfg.look,
			view: cfg.view,
			render: cfg.render,
			parts: Object.keys(cfg.partOverrides || {}),
			partial: parsed.partial
		}));
		return;
	}
	if (sub === "apply") {
		const file = a._[1];
		if (!file) throw new Error("rec apply 需要配方文件");
		const rest = argv.slice();
		rest.splice(rest.indexOf("apply"), 1);
		rest.splice(rest.indexOf(file), 1);
		return cmdRender(["--recipe", file].concat(rest));
	}
	throw new Error("rec 支持 show / apply（node cli/tb.js rec --help）");
}

// ---------------------------------------------------------------------------
// inspect（读图片内嵌配方）
// ---------------------------------------------------------------------------
function relPath(target) {
	const rel = path.relative(process.cwd(), path.resolve(target));
	return (rel || target).split(path.sep).join("/");
}

function cmdInspect(argv) {
	const a = parseFlags(argv);
	if (a.help) return print(spec.INSPECT_HELP);
	const file = a._[0];
	if (!file) throw new Error("inspect 需要图片路径：node cli/tb.js inspect out/inn.png");
	const found = embedded.readFile(String(file));
	if (a["save-recipe"]) {
		const target = String(a["save-recipe"]);
		render.ensureDir(path.dirname(path.resolve(target)));
		fs.writeFileSync(target, JSON.stringify(found.doc, null, 2));
	}
	if (a.full) {
		return print(JSON.stringify({
			ok: true, file: String(file), version: found.version, software: found.software, recipe: found.doc
		}));
	}
	const payload = embedded.describe(found.doc, String(file));
	if (a["save-recipe"]) payload.saved = relPath(String(a["save-recipe"]));
	print(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// styles
// ---------------------------------------------------------------------------
function parsePalette(text) {
	const out = {};
	String(text).split(",").forEach(function (token) {
		const pair = token.split("=");
		if (pair.length !== 2) throw new Error("--palette 需要 role=#rrggbb,... 形式");
		out[pair[0].trim()] = pair[1].trim();
	});
	return out;
}

function summarizeStyle(style) {
	if (!style) throw new Error("风格不存在");
	const out = {
		ok: true,
		id: style.id,
		name: style.name,
		geometry: style.geometry,
		builtin: !!style.builtin,
		note: style.note || "",
		atlas: style.atlas ? { size: style.atlas.size, cell: style.atlas.cell, name: style.atlas.name || null } : null,
		overrides: Object.keys(style.overrides || {}),
		palette: style.palette
	};
	return out;
}

function cmdStyles(argv) {
	const a = parseFlags(argv);
	if (a.help) return print(spec.STYLES_HELP);
	const sub = a._[0];
	if (!sub || sub === "list") {
		const rows = styles.all();
		if (a.json) return print(JSON.stringify(rows));
		return print(rows.map(function (row) {
			return [row.id, row.name, row.geometry, row.builtin ? "builtin" : "user",
				row.hasAtlas ? "atlas" + (row.atlasSize || "") : "palette"].join("\t");
		}).join("\n"));
	}
	if (sub === "get") {
		const id = a._[1];
		if (!id) throw new Error("styles get 需要 id");
		const style = styles.resolve(id);
		if (!style) throw new Error("未知风格：" + id + "（见 list styles）");
		const payload = summarizeStyle(style);
		if (!style.builtin) {
			const user = styles.getUser(id);
			payload.atlas.name = user.atlas ? user.atlas.name : null;
			payload.atlas.bytes = user.atlas ? Math.round(user.atlas.dataURL.length * 0.75) : 0;
			if (a["data-url"] && user.atlas) payload.atlas.dataURL = user.atlas.dataURL;
			if (a["data-url"]) payload.overrideData = user.overrides;
		}
		return print(JSON.stringify(payload));
	}
	if (sub === "create") {
		if (a.atlas) {
			const result = styles.createFromAtlas({
				file: String(a.atlas), name: a.name, geometry: a.geometry, id: a.id, note: a.note
			});
			return print(JSON.stringify({
				ok: true, id: result.style.id, name: result.style.name, path: result.path,
				atlas: { size: result.style.atlas.size, cell: result.style.atlas.cell },
				warnings: result.report.warnings
			}));
		}
		if (a.palette) {
			const result = styles.createFromPalette({
				name: a.name, geometry: a.geometry, id: a.id, note: a.note, palette: parsePalette(a.palette)
			});
			return print(JSON.stringify({ ok: true, id: result.style.id, name: result.style.name, path: result.path }));
		}
		throw new Error("styles create 需要 --atlas <图集.png> 或 --palette role=#hex,...（--name 必填）");
	}
	if (sub === "set-role") {
		const id = a._[1];
		if (!id) throw new Error("styles set-role 需要风格 id");
		if (!a.role || !a.image) throw new Error("styles set-role 需要 --role <角色> --image <图片>");
		return print(JSON.stringify(Object.assign({ ok: true }, styles.setRole({ id: id, role: String(a.role), image: String(a.image) }))));
	}
	if (sub === "template") {
		const id = a._[1] || a.style;
		if (!id) throw new Error("styles template 需要风格 id");
		const style = styles.resolve(id);
		if (!style) throw new Error("未知风格：" + id);
		const atlas = styles.template(style, Number(a.cell) || 128);
		const file = a.out || path.join(render.OUT_ROOT, "atlas_" + style.id + "_" + atlas.size + ".png");
		render.ensureDir(path.dirname(path.resolve(file)));
		fs.writeFileSync(file, png.encode(atlas.size, atlas.size, atlas.data));
		return print(JSON.stringify({ ok: true, id: style.id, file: path.relative(process.cwd(), file) || file, size: atlas.size, cell: atlas.cell }));
	}
	if (sub === "export") {
		const file = a._[1] || a.out;
		if (!file) throw new Error("styles export 需要目标文件");
		const ids = a._.slice(2);
		const result = styles.exportPack(file, ids);
		return print(JSON.stringify(Object.assign({ ok: true }, result)));
	}
	if (sub === "import") {
		const file = a._[1];
		if (!file) throw new Error("styles import 需要风格包文件");
		return print(JSON.stringify(Object.assign({ ok: true }, styles.importPack(file))));
	}
	if (sub === "delete") {
		const id = a._[1];
		if (!id) throw new Error("styles delete 需要 id");
		const file = styles.deleteUser(id);
		return print(JSON.stringify({ ok: true, id: id, deleted: file }));
	}
	throw new Error("styles 支持 list / get / create / set-role / template / export / import / delete（--help）");
}

// ---------------------------------------------------------------------------
// atlas
// ---------------------------------------------------------------------------
function cmdAtlas(argv) {
	const a = parseFlags(argv);
	if (a.help) return print(spec.ATLAS_HELP);
	const sub = a._[0] || "check";
	if (sub !== "check") throw new Error("atlas 目前只支持 check");
	const file = a._[1];
	if (!file) throw new Error("atlas check 需要 PNG 路径");
	const image = png.decodeFile(file);
	const report = styles.validateAtlas(image);
	print(JSON.stringify(Object.assign({ ok: report.ok, file: file }, report)));
	if (!report.ok) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// preset
// ---------------------------------------------------------------------------
function presetDir() {
	return path.join(env.ROOT, "cli", "presets");
}

function presetFile(name) {
	return path.join(presetDir(), styles.sanitizeId(name) + ".json");
}

function loadPreset(name) {
	const file = presetFile(String(name));
	if (!fs.existsSync(file)) throw new Error("没有这个预设：" + name + "（见 list presets）");
	return json.read(file, "预设");
}

function listPresets() {
	const dir = presetDir();
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir).filter(function (name) { return name.endsWith(".json"); }).map(function (name) {
		try {
			const doc = json.read(path.join(dir, name));
			return {
				name: name.replace(/\.json$/, ""),
				style: doc.config ? doc.config.styleId : null,
				type: doc.config ? doc.config.typeId : null,
				file: path.join(dir, name)
			};
		} catch (err) {
			return { name: name.replace(/\.json$/, ""), error: "解析失败" };
		}
	});
}

function cmdPreset(argv) {
	const a = parseFlags(argv);
	if (a.help) return print(spec.PRESET_HELP);
	const sub = a._[0];
	if (!sub || sub === "list") {
		const rows = listPresets();
		if (a.json) return print(JSON.stringify(rows));
		return print(rows.map(function (row) { return row.name + "\t" + (row.style || "") + "\t" + (row.type || ""); }).join("\n"));
	}
	if (sub === "save") {
		const name = a._[1];
		if (!name) throw new Error("preset save 需要名字：preset save <name> [选项]");
		const rest = argv.slice();
		rest.splice(rest.indexOf("save"), 1);
		rest.splice(rest.indexOf(name), 1);
		const jobArgs = parseFlags(rest);
		const parsed = config.fromArgs(jobArgs, {});
		const doc = {
			name: name,
			createdAt: new Date().toISOString(),
			config: parsed.cfg,
			warnings: parsed.warnings
		};
		render.ensureDir(presetDir());
		fs.writeFileSync(presetFile(name), JSON.stringify(doc, null, 2));
		return print(JSON.stringify({ ok: true, name: name, file: presetFile(name), style: parsed.cfg.styleId, type: parsed.cfg.typeId }));
	}
	if (sub === "show") {
		const name = a._[1];
		if (!name) throw new Error("preset show 需要名字");
		const doc = loadPreset(name);
		return print(JSON.stringify({ ok: true, name: doc.name, config: doc.config }));
	}
	if (sub === "delete") {
		const name = a._[1];
		if (!name) throw new Error("preset delete 需要名字");
		const file = presetFile(name);
		if (!fs.existsSync(file)) throw new Error("没有这个预设：" + name);
		fs.unlinkSync(file);
		return print(JSON.stringify({ ok: true, name: name, deleted: file }));
	}
	throw new Error("preset 支持 save / list / show / delete（--help）");
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
function main() {
	const argv = process.argv.slice(2);
	const command = argv[0];
	if (!command || command === "--help" || command === "-h" || command === "help") {
		return print(spec.MAIN_HELP);
	}
	if (command === "--version" || command === "version") {
		return print("topdown-building-studio-cli " + config.TOOL_VERSION + " (node " + process.version + ")");
	}
	const rest = argv.slice(1);
	switch (command) {
		case "render": case "r": return cmdRender(rest);
		case "batch": case "b": return cmdBatch(rest);
		case "list": case "ls": return cmdList(rest);
		case "schema": return cmdSchema(rest);
		case "rec": case "recipe": return cmdRecipe(rest);
		case "inspect": case "meta": return cmdInspect(rest);
		case "styles": case "style": return cmdStyles(rest);
		case "atlas": return cmdAtlas(rest);
		case "preset": case "presets": return cmdPreset(rest);
		default:
			throw new Error("未知命令：" + command + "（node cli/tb.js --help）");
	}
}

try {
	main();
} catch (err) {
	fail(err);
}

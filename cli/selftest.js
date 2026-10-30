/**
 * CLI 自测：把命令行的每条命令与主要选项都跑一遍并断言。
 * 用法：node cli/selftest.js
 *
 * 产物写到 cli/out/selftest/（.gitignore 已忽略），不触碰 cli/styles 里已有内容
 * （自测创建的临时风格 / 预设会在结束时删掉）。
 */
"use strict";
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "cli", "tb.js");
const OUT = path.join(ROOT, "cli", "out", "selftest");

const results = [];
let failed = 0;

function run(args, options) {
	options = options || {};
	try {
		const stdout = execFileSync(process.execPath, [ENTRY].concat(args), {
			cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
		});
		return { code: 0, stdout: stdout, stderr: "" };
	} catch (err) {
		return {
			code: err.status === undefined ? 1 : err.status,
			stdout: String(err.stdout || ""),
			stderr: String(err.stderr || "")
		};
	}
}

function json(result) {
	const text = result.stdout.trim();
	const line = text.split("\n").filter(function (row) { return row.trim().startsWith("{"); }).pop();
	if (!line) throw new Error("没有 JSON 输出：" + text.slice(0, 200));
	return JSON.parse(line);
}

function check(name, fn) {
	try {
		const detail = fn();
		results.push({ name: name, ok: true, detail: detail || "" });
	} catch (err) {
		failed++;
		results.push({ name: name, ok: false, detail: err.message });
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function fileExists(file) {
	return fs.existsSync(path.isAbsolute(file) ? file : path.join(ROOT, file));
}

function relOf(file) {
	return path.relative(ROOT, path.resolve(file)).split(path.sep).join("/");
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// 发现类命令
// ---------------------------------------------------------------------------
check("list styles", function () {
	const rows = run(["list", "styles"]).stdout.trim().split("\n");
	assert(rows.length >= 10, "风格数量不足：" + rows.length);
	assert(rows[0].indexOf("jiangnan") === 0, "首行不是 jiangnan：" + rows[0]);
	return rows.length + " 个风格";
});

check("list types", function () {
	const rows = run(["list", "types"]).stdout.trim().split("\n");
	assert(rows.length >= 40, "建筑类型数量不足：" + rows.length);
	return rows.length + " 个类型";
});

check("list params", function () {
	const rows = run(["list", "params", "inn"]).stdout.trim().split("\n");
	assert(rows.some(function (row) { return row.indexOf("width\t") === 0; }), "缺少 width 行");
	assert(rows.some(function (row) { return row.indexOf("floors\t2") === 0; }), "inn 默认楼层应为 2");
	return rows.length + " 个参数";
});

check("list roles", function () {
	const rows = run(["list", "roles"]).stdout.trim().split("\n");
	assert(rows.length === 16, "角色应为 16 个，实际 " + rows.length);
	return "16 个角色";
});

check("list enums", function () {
	const data = json(run(["list", "enums"]));
	assert(data.dirs.join(",") === "1,2,4,8", "方向枚举不对");
	return "dirs=" + data.dirs.join("/");
});

check("schema", function () {
	const data = json(run(["schema"]));
	assert(data.styles.length >= 10, "schema 缺风格");
	assert(data.types.length >= 40, "schema 缺类型");
	assert(data.flags.repeat.indexOf("part") >= 0, "schema 缺 --part");
	return Object.keys(data.commands).length + " 个命令";
});

check("schema --full", function () {
	const data = json(run(["schema", "--full"]));
	assert(data.typesFull && data.typesFull.inn, "typesFull 缺 inn");
	return Object.keys(data.typesFull).length + " 个类型默认值";
});

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
check("render 默认值", function () {
	const data = json(run(["render", "forest", "inn", "-o", path.join(OUT, "basic.png")]));
	assert(data.ok, "render 失败");
	assert(data.canvas[0] === 512 && data.canvas[1] === 512, "画布应为 512");
	assert(data.dirs === 1, "默认应为单方向");
	assert(fileExists(path.join(OUT, "basic.png")), "没有产物");
	assert(data.ink > 0.05 && data.ink < 0.95, "ink 不在合理区间：" + data.ink);
	return "512×512 · ink " + data.ink + " · " + data.ms + "ms";
});

check("render 位置参数 + quiet", function () {
	const target = path.join(OUT, "quiet.png");
	const out = run(["render", "desert", "watchtower", "--quiet", "-o", target]);
	assert(out.stdout.trim() === relOf(target), "quiet 只应输出路径，实际：" + out.stdout.trim());
	return "只回路径";
});

check("render 多方向 + 精灵表 + ZIP + 配方", function () {
	const dir = path.join(OUT, "multi");
	const data = json(run(["render", "jiangnan", "inn", "-d", "4", "--sheet", "--zip",
		"--save-recipe", path.join(dir, "recipe.json"), "-o", dir]));
	assert(data.dirs === 4, "方向数应为 4");
	assert(data.files.length === 4, "应有 4 张帧");
	assert(data.sheet, "缺少 sheet");
	assert(data.zip, "缺少 zip");
	assert(fileExists(data.zip), "zip 文件不存在");
	assert(fileExists(path.join(dir, "recipe.json")), "配方没写出来");
	return "4 帧 + sheet + zip";
});

check("render 平视立面（pitch 0 / FOV 0）", function () {
	const data = json(run(["render", "forest", "inn", "--pitch", "0", "--proj", "persp", "--fov", "0",
		"-o", path.join(OUT, "elev.png")]));
	assert(data.pitch === 0, "俯角应为 0");
	assert(data.proj === "ortho", "FOV=0 应退化为正交");
	assert(data.note, "应给出 FOV≈0 的说明");
	return "立面图 " + data.canvas.join("×");
});

check("render 自适应画布 + 8 方向", function () {
	const dir = path.join(OUT, "auto8");
	const data = json(run(["render", "jiangnan", "house", "--size", "auto", "--ppm", "40", "-d", "8", "--sheet", "-o", dir]));
	assert(data.dirs === 8, "方向数应为 8");
	assert(data.canvas[0] !== 512 || data.canvas[1] !== 512, "自适应画布不应固定 512");
	assert(data.sheet, "缺少 sheet");
	return data.canvas.join("×") + " × 8";
});

check("render 像素风 + 三套描边", function () {
	const data = json(run(["render", "jiangnan_pixel", "house", "--no-aa", "--outline-inner", "1",
		"--outline-outer", "2", "--outline-silhouette", "3", "--size", "256"]));
	assert(data.files.length === 1, "产物缺失");
	assert(data.files[0].indexOf("noaa") >= 0, "默认文件名应带 noaa 标记：" + data.files[0]);
	assert(data.files[0].indexOf("oi1oo2os3") >= 0, "默认文件名应带描边标记：" + data.files[0]);
	return data.files[0];
});

check("render 部件级覆盖（染色 / 外描边 / 换贴图）", function () {
	const data = json(run(["render", "jiangnan", "house",
		"--part", "roof:tint=#e0b95f", "--part", "roof:outer=2", "--part", "roof:outerColor=#ffffff",
		"-o", path.join(OUT, "parts.png")]));
	assert(data.ok, "部件覆盖失败");
	const tex = json(run(["render", "jiangnan", "house", "--part", "roof:texture=" + path.join(OUT, "basic.png"),
		"-o", path.join(OUT, "parts_tex.png")]));
	assert(tex.ok, "部件换贴图失败");
	return "染色 + 描边 + 换图";
});

check("render 随机可复现", function () {
	const first = json(run(["render", "forest", "house", "--random", "-o", path.join(OUT, "rnd1.png")]));
	const seeds = first.seeds;
	const again = json(run(["render", "forest", "house", "--seed", String(seeds[0]), "--dseed", String(seeds[1]),
		"--replay", "-o", path.join(OUT, "rnd2.png")]));
	const a = fs.readFileSync(path.join(OUT, "rnd1.png"));
	const b = fs.readFileSync(path.join(OUT, "rnd2.png"));
	assert(a.equals(b), "同种子未能复现同一张图");
	return "种子 " + seeds.slice(0, 2).join("/");
});

check("render --dry-run 与越界夹取", function () {
	const data = json(run(["render", "desert", "watchtower", "--param", "floors=9", "--dry-run"]));
	assert(data.dryRun, "应标记 dryRun");
	assert(data.warnings && data.warnings.length, "越界应给出 warning");
	assert(data.params.floors === 3, "floors 应被夹到 3");
	return "warnings=" + data.warnings.length;
});

check("render --thumb", function () {
	const data = json(run(["render", "harbor", "teahouse", "--thumb", "64", "-o", path.join(OUT, "thumb.png")]));
	assert(data.thumbs && data.thumbs.length, "缺少缩略图");
	assert(fileExists(data.thumbs[0]), "缩略图文件不存在");
	return data.thumbs[0];
});

check("render 背景色 + 负朝向", function () {
	const data = json(run(["render", "steamworks", "forge", "--bg", "202020", "--no-aa", "--yaw", "-45",
		"-o", path.join(OUT, "bg.png")]));
	assert(data.ok, "背景色渲染失败");
	assert(data.ink > 0.02, "不透明背景下的 ink 统计异常：" + data.ink);
	return "ink " + data.ink;
});

// ---------------------------------------------------------------------------
// 内嵌元信息（v1.1）
// ---------------------------------------------------------------------------
check("PNG 内嵌元信息 → inspect 回读", function () {
	const dir = path.join(OUT, "meta");
	const rendered = json(run(["render", "forest", "inn", "-p", "30", "-d", "2", "--sheet", "-o", dir]));
	assert(rendered.meta && rendered.meta.version === "1.1", "摘要应回报内嵌元信息：" + JSON.stringify(rendered.meta));
	const info = json(run(["inspect", path.join(dir, "dir_0.png")]));
	assert(info.ok, "inspect 失败");
	assert(info.toolVersion === "1.1", "版本号不对：" + info.toolVersion);
	assert(info.style === "forest" && info.type === "inn", "风格/类型不对");
	assert(info.pitch === 30 && info.dirs === 2, "视角参数没回读出来");
	assert(info.canvas[0] === 512 && info.canvas[1] === 512, "画布不对");
	assert(info.seeds.join(",") === rendered.seeds.join(","), "种子不一致");
	const sheet = json(run(["inspect", path.join(dir, "sheet.png")]));
	assert(sheet.dirs === 2, "精灵表也应带元信息");
	return "版本 " + info.toolVersion + " · pitch " + info.pitch + " · dirs " + info.dirs;
});

check("PNG 当配方回放（像素一致）", function () {
	const source = path.join(OUT, "meta", "dir_0.png");
	const replay = json(run(["rec", "apply", source, "-o", path.join(OUT, "meta_replay"), "-d", "1"]));
	assert(replay.files && replay.files.length === 1, "回放没产物");
	const png = require("./lib/png");
	const a = png.decodeFile(source);
	const b = png.decodeFile(path.join(ROOT, replay.files[0]));
	assert(a.width === b.width && a.height === b.height, "回放尺寸不一致");
	assert(Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)) === 0, "回放像素不一致");
	const shown = json(run(["rec", "show", source]));
	assert(shown.source === "png", "rec show 应识别 PNG：" + shown.source);
	const saved = json(run(["inspect", source, "--save-recipe", path.join(OUT, "from_png.json")]));
	assert(saved.saved, "inspect --save-recipe 没写文件");
	assert(fileExists(path.join(OUT, "from_png.json")), "配方文件不存在");
	return "PNG → 配方 → 同像素";
});

check("--no-meta 与旧图提示", function () {
	const file = path.join(OUT, "plain.png");
	const rendered = json(run(["render", "forest", "inn", "--no-meta", "-o", file]));
	assert(rendered.meta === false, "摘要应回 meta:false");
	const result = run(["inspect", file]);
	assert(result.code === 1, "无元信息应退出码 1");
	const payload = json({ stdout: result.stderr });
	assert(payload.hint && payload.hint.indexOf("--no-meta") >= 0, "应提示 --no-meta");
	return "无元信息有可读提示";
});

check("部件贴图剥离告警", function () {
	const file = path.join(OUT, "tex_meta.png");
	const rendered = json(run(["render", "jiangnan", "house", "--part", "roof:texture=" + path.join(OUT, "basic.png"), "-o", file]));
	assert(rendered.meta && rendered.meta.textures === "omitted", "应标记贴图未内嵌：" + JSON.stringify(rendered.meta));
	const info = json(run(["inspect", file]));
	assert(info.textures === "omitted", "inspect 应回 textures=omitted");
	assert(info.warnings && info.warnings.length, "inspect 应提示贴图缺失");
	return "textures=omitted";
});

// 网页端 js/pngmeta.js 写的是未压缩 iTXt，必须和 CLI 的读取端互通
check("网页 pngmeta 写入 → CLI inspect 可读", function () {
	const vm = require("vm");
	const ctx = { console: console, Uint8Array: Uint8Array, DataView: DataView, TextEncoder: TextEncoder, TextDecoder: TextDecoder, JSON: JSON, String: String, Number: Number };
	ctx.globalThis = ctx;
	vm.createContext(ctx);
	["util", "pngmeta"].forEach(function (name) {
		vm.runInContext(fs.readFileSync(path.join(ROOT, "js", name + ".js"), "utf8"), ctx, { filename: name + ".js" });
	});
	const src = path.join(OUT, "web_src.png");
	json(run(["render", "forest", "inn", "-p", "30", "--size", "256", "-o", src]));
	const doc = json(run(["inspect", src, "--full"])).recipe;
	const base = path.join(OUT, "web_base.png");
	json(run(["render", "forest", "inn", "-p", "30", "--size", "256", "--no-meta", "-o", base]));
	const out = path.join(OUT, "web_meta.png");
	fs.writeFileSync(out, ctx.TB.pngEmbedText(new Uint8Array(fs.readFileSync(base)), ctx.TB.pngMetaEntries(doc)));
	const info = json(run(["inspect", out]));
	assert(info.ok, "CLI 读不了网页写的元信息");
	assert(info.style === "forest" && info.type === "inn", "风格/类型不对：" + info.style + "/" + info.type);
	assert(info.pitch === 30 && info.canvas[0] === 256, "视角参数不对");
	const png = require("./lib/png");
	const a = png.decodeFile(base);
	const b = png.decodeFile(out);
	assert(Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)) === 0, "写入文本块后像素变了");
	return "网页写入 · CLI 读回 · 像素不变";
});

// ---------------------------------------------------------------------------
// 配方 / 预设 / 批量
// ---------------------------------------------------------------------------
check("rec show / apply", function () {
	const recipe = path.join(OUT, "multi", "recipe.json");
	const info = json(run(["rec", "show", recipe]));
	assert(info.style === "jiangnan" && info.type === "inn", "配方解析不对");
	const applied = json(run(["rec", "apply", recipe, "-o", path.join(OUT, "replay")]));
	assert(applied.dirs === 4, "配方回放应保留 4 方向");
	return "配方回放 4 帧";
});

check("preset save / show / render / delete", function () {
	const saved = json(run(["preset", "save", "t_self_test", "--style", "nordic", "--type", "villa",
		"--no-aa", "--size", "256", "--pitch", "30"]));
	assert(saved.ok, "预设保存失败");
	const rendered = json(run(["render", "--preset", "t_self_test", "-o", path.join(OUT, "preset.png")]));
	assert(rendered.style === "nordic", "预设没生效");
	assert(rendered.canvas[0] === 256, "预设尺寸没生效");
	run(["preset", "delete", "t_self_test"]);
	assert(!fs.existsSync(path.join(ROOT, "cli", "presets", "t_self_test.json")), "预设没删掉");
	return "预设生效并清理";
});

check("batch（含失败任务）", function () {
	const manifest = path.join(OUT, "jobs.json");
	fs.writeFileSync(manifest, JSON.stringify({
		out: path.join(OUT, "batch"),
		defaults: { size: 256, thumb: 64 },
		jobs: [
			{ name: "a", style: "jiangnan", type: "house" },
			{ name: "b", style: "forest", type: "inn", dirs: 2, sheet: true, param: { floors: 2 } },
			{ name: "c", style: "nope", type: "house" }
		]
	}));
	const result = run(["batch", manifest]);
	const data = json(result);
	assert(result.code === 1, "有失败任务时应退出码 1");
	assert(data.count === 2 && data.failed === 1, "计数不对：" + data.count + "/" + data.failed);
	assert(data.files.length === 3, "产物数不对：" + data.files.length);
	return "2 成功 / 1 失败";
});

check("batch 从 stdin 读", function () {
	const manifest = JSON.stringify({ jobs: [{ name: "s", style: "palace", type: "temple", out: path.join(OUT, "stdin.png"), size: 256 }] });
	const stdout = execFileSync(process.execPath, [ENTRY, "batch", "-"], { cwd: ROOT, input: manifest, encoding: "utf8" });
	const data = json({ stdout: stdout });
	assert(data.count === 1, "stdin 批量失败");
	return "stdin 1 个任务";
});

// ---------------------------------------------------------------------------
// 风格 / 图集
// ---------------------------------------------------------------------------
check("styles template + atlas check", function () {
	const data = json(run(["styles", "template", "jiangnan", "-o", path.join(OUT, "tpl.png")]));
	assert(data.size === 512, "模板应为 512");
	const report = json(run(["atlas", "check", path.join(OUT, "tpl.png")]));
	assert(report.ok, "内置图集模板应通过校验");
	assert(report.roles.length === 16, "应检查 16 格");
	return "512px · 16 格通过";
});

check("atlas check 拒绝非法图集", function () {
	const bad = path.join(OUT, "bad_atlas.png");
	const png = require("./lib/png");
	const data = new Uint8ClampedArray(301 * 301 * 4);
	for (let i = 3; i < data.length; i += 4) data[i] = 255;
	fs.writeFileSync(bad, png.encode(301, 301, data));
	const result = run(["atlas", "check", bad]);
	assert(result.code === 1, "非法图集应退出码 1");
	const report = json(result);
	assert(!report.ok && report.errors.length, "应给出错误列表");
	return report.errors[0];
});

check("styles create / get / set-role / export / import / delete", function () {
	const created = json(run(["styles", "create", "--atlas", path.join(OUT, "tpl.png"),
		"--name", "自测风格", "--geometry", "jiangnan", "--id", "t_self"]));
	assert(created.ok, "创建风格失败");
	const info = json(run(["styles", "get", "t_self"]));
	assert(info.name === "自测风格" && info.geometry === "jiangnan", "风格信息不对");
	const role = json(run(["styles", "set-role", "t_self", "--role", "roof", "--image", path.join(OUT, "basic.png")]));
	assert(role.ok, "单角色覆盖失败");
	const rendered = json(run(["render", "t_self", "house", "-o", path.join(OUT, "custom.png")]));
	assert(rendered.ok, "自定义风格渲染失败");
	const pack = json(run(["styles", "export", path.join(OUT, "pack.json")]));
	assert(pack.count >= 1, "导出风格包失败");
	const imported = json(run(["styles", "import", path.join(OUT, "pack.json")]));
	assert(imported.count >= 1, "导入风格包失败");
	const fromPack = json(run(["render", "--style-file", path.join(OUT, "pack.json"), "-t", "house",
		"-o", path.join(OUT, "stylefile.png")]));
	assert(fromPack.style === "t_self", "风格包直读失败");
	imported.ids.forEach(function (id) {
		if (id !== "t_self") run(["styles", "delete", id]);
	});
	run(["styles", "delete", "t_self"]);
	assert(!fs.existsSync(path.join(ROOT, "cli", "styles", "t_self.json")), "临时风格没删掉");
	return "建→渲染→导出→导入→直读→删";
});

check("styles create --palette", function () {
	const created = json(run(["styles", "create", "--palette", "roof=#425b61,wall=#e1dec8",
		"--name", "纯色自测", "--geometry", "forest", "--id", "t_palette"]));
	assert(created.ok, "调色板建风格失败");
	const data = json(run(["render", "t_palette", "house", "-o", path.join(OUT, "palette.png")]));
	assert(data.ok, "调色板风格渲染失败");
	run(["styles", "delete", "t_palette"]);
	return "程序化风格可渲染";
});

// ---------------------------------------------------------------------------
// 错误路径
// ---------------------------------------------------------------------------
check("未知类型的提示", function () {
	const result = run(["render", "desert", "tower", "-o", path.join(OUT, "x.png")]);
	assert(result.code === 1, "应退出码 1");
	const payload = json({ stdout: result.stderr });
	assert(payload.ok === false, "应返回 ok:false");
	assert(payload.error.indexOf("watchtower") >= 0, "应给出相近类型建议：" + payload.error);
	return payload.error.slice(0, 40) + "…";
});

check("未知风格 / 未知参数", function () {
	const badStyle = run(["render", "nope", "house"]).stderr;
	assert(badStyle.indexOf("未知风格") >= 0, "未知风格提示缺失");
	const badParam = run(["render", "jiangnan", "house", "--param", "nope=1"]).stderr;
	assert(badParam.indexOf("未知建筑参数") >= 0, "未知参数提示缺失");
	return "两类错误都有可读提示";
});

check("--help 覆盖各子命令", function () {
	["render", "batch", "list", "schema", "rec", "inspect", "styles", "atlas", "preset"].forEach(function (cmd) {
		const out = run([cmd, "--help"]);
		assert(out.code === 0 && out.stdout.length > 40, cmd + " 的 --help 异常");
	});
	return "9 个子命令都有帮助";
});

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const width = results.reduce(function (max, row) { return Math.max(max, row.name.length); }, 0);
results.forEach(function (row) {
	const mark = row.ok ? "PASS" : "FAIL";
	process.stdout.write(mark + "  " + row.name + new Array(Math.max(1, width - row.name.length + 2)).join(" ") + (row.ok ? row.detail : "← " + row.detail) + "\n");
});
const total = results.length;
process.stdout.write("\n" + (total - failed) + "/" + total + " 通过" + (failed ? "，" + failed + " 项失败" : "") + "\n");

// 默认清理产物（几十 MB）；调试想看某张图时用 --keep 保留
if (process.argv.indexOf("--keep") < 0) {
	fs.rmSync(OUT, { recursive: true, force: true });
	process.stdout.write("产物已清理（要看图请加 --keep，保留在 cli/out/selftest/）\n");
}
if (failed) process.exitCode = 1;

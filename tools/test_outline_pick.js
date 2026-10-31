/**
 * 三套描边（内 / 部件外 / 轮廓）+ 部件级覆盖 + 拾取缓冲验证。
 *
 * 语义：
 *   内描边   —— 只画在该部件自己的像素上（轮廓、折面断层、部件分界），不越出部件；
 *   部件外描边 —— 每个部件的剪影向外扩，允许压到别的部件（几何像素）上，也可落到背景；
 *   轮廓描边 —— 只把整栋剪影外扩到背景，绝不占用几何像素。
 * 宽度按输出像素连续计算（关抗锯齿时 0.5 为半覆盖）；部件交界只由一侧拥有。 *
 * 用法：node tools/test_outline_pick.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const ROOT = path.join(__dirname, "..");
["util", "catalog", "atlases", "materials", "geometry", "view", "renderer"].forEach((n) => require(path.join(ROOT, "js", n + ".js")));
const TB = globalThis.TB;
const results = [];
function check(name, ok, detail) {
	results.push({ name, ok: !!ok });
	console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  —  " + detail : ""));
}

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

const params = TB.Catalog.parameters("house", "jiangnan");
const profile = { style: "jiangnan", typeId: "house", kind: 0, categoryId: "residential", shapeSeed: 60421, detailSeed: 101, appearanceSeed: 101, params };
const mesh = TB.buildBuilding(profile);
const view = TB.prepareView(mesh.bounds, { pitch: 45, projection: 0, directions: 0, baseYaw: 0, fov: 50, pixelSize: 3, scaleMode: 0, pixelsPerMeter: 48, padding: 8 });
const tiles = TB.buildTiles(TB.atlasSources(loadAtlas("jiangnan")), { look: 0, appearanceSeed: 101 });
const INNER = [255, 0, 255];   // 洋红：内描边
const OUTER = [0, 255, 0];     // 纯绿：部件外描边
const SIL = [0, 128, 255];     // 天蓝：轮廓描边
const ROOF = TB.ROLES.indexOf("roof");
const WALL = TB.ROLES.indexOf("wall");

function render(opts) {
	return TB.renderFrame(mesh, tiles, view, view.yaws[0], Object.assign({
		antialias: false,
		transparent: true,
		outlineColor: "#ff00ff",
		outlineColorOuter: "#00ff00",
		outlineColorSilhouette: "#0080ff"
	}, opts));
}
function isColor(frame, i, rgb) {
	const o = i * 4;
	return frame.data[o] === rgb[0] && frame.data[o + 1] === rgb[1] && frame.data[o + 2] === rgb[2] && frame.data[o + 3] === 255;
}
function classify(frame, rgb) {
	let total = 0, onGeometry = 0, onBackground = 0;
	const roles = new Map();
	for (let i = 0; i < frame.pick.length; i++) {
		if (!isColor(frame, i, rgb)) continue;
		total++;
		if (frame.pick[i] === 255) onBackground++;
		else {
			onGeometry++;
			roles.set(frame.pick[i], (roles.get(frame.pick[i]) || 0) + 1);
		}
	}
	return { total, onGeometry, onBackground, roles };
}

// ---- 1. 内描边：只在几何上，且只在自己部件的像素上 ----
const innerOnly = render({ outlineInner: 2 });
const innerStats = classify(innerOnly, INNER);
check("内描边有像素", innerStats.total > 200, String(innerStats.total));
check("内描边全部落在几何像素上", innerStats.onBackground === 0, `背景 ${innerStats.onBackground} / 总计 ${innerStats.total}`);
check("只开内描边时没有外描边 / 轮廓像素", classify(innerOnly, OUTER).total === 0 && classify(innerOnly, SIL).total === 0);

// ---- 2. 轮廓描边：只包整栋剪影，落在背景上 ----
const silOnly = render({ outlineSilhouette: 2 });
const silStats = classify(silOnly, SIL);
check("轮廓描边有像素", silStats.total > 200, String(silStats.total));
check("轮廓描边全部落在背景上", silStats.onGeometry === 0, `几何 ${silStats.onGeometry} / 总计 ${silStats.total}`);

// ---- 3. 部件外描边：会压到别的部件（几何像素）上，也会落到背景 ----
const outerOnly = render({ outlineOuter: 2 });
const outerStats = classify(outerOnly, OUTER);
check("部件外描边有像素", outerStats.total > 200, String(outerStats.total));
check("部件外描边会压到别的部件上（几何像素 > 0）", outerStats.onGeometry > 20, `几何 ${outerStats.onGeometry} / 背景 ${outerStats.onBackground} / 总计 ${outerStats.total}`);
check("部件外描边也会包到背景上", outerStats.onBackground > 20, String(outerStats.onBackground));
check("部件外描边覆盖不止一个部件", outerStats.roles.size >= 3, Array.from(outerStats.roles.keys()).map((v) => TB.ROLES[v]).join(","));

// ---- 4. 三者同时开启，互不串色 ----
const both = render({ outlineInner: 1, outlineOuter: 1, outlineSilhouette: 1 });
const bothInner = classify(both, INNER);
const bothOuter = classify(both, OUTER);
const bothSil = classify(both, SIL);
check("内描边仍在几何上", bothInner.total > 100 && bothInner.onBackground === 0, `${bothInner.total}`);
check("部件外描边仍有几何像素", bothOuter.onGeometry > 0, `几何 ${bothOuter.onGeometry}`);
check("轮廓描边仍只在背景上", bothSil.total > 100 && bothSil.onGeometry === 0, `${bothSil.total}`);

// ---- 5. 宽度增加 → 像素变多 ----
const inner1 = classify(render({ outlineInner: 1 }), INNER).total;
const inner4 = classify(render({ outlineInner: 4 }), INNER).total;
const outer1 = classify(render({ outlineOuter: 1 }), OUTER).total;
const outer4 = classify(render({ outlineOuter: 4 }), OUTER).total;
const sil1 = classify(render({ outlineSilhouette: 1 }), SIL).total;
const sil4 = classify(render({ outlineSilhouette: 4 }), SIL).total;
check("内描边宽度 1→4 覆盖变多", inner4 > inner1, `${inner1} → ${inner4}`);
check("部件外描边宽度 1→4 覆盖变多", outer4 > outer1, `${outer1} → ${outer4}`);
check("轮廓描边宽度 1→4 覆盖变多", sil4 > sil1, `${sil1} → ${sil4}`);

// ---- 6. 部件级覆盖：只影响指定部件，宽度/颜色都生效 ----
const roofInner = render({ outlineInner: 0, partOutlines: { roof: { inner: 4 } } });
const roofInnerStats = classify(roofInner, INNER);
check("部件级内描边：只有 roof 被描边", roofInnerStats.total > 100 && roofInnerStats.roles.size === 1 && roofInnerStats.roles.has(ROOF),
	Array.from(roofInnerStats.roles.keys()).map((v) => TB.ROLES[v]).join(","));
const roofInner3 = classify(render({ outlineInner: 0, partOutlines: { roof: { inner: 3 } } }), INNER).total;
check("部件级内描边宽度生效（3 < 4 覆盖更少）", roofInnerStats.total > roofInner3 && roofInner3 > 0, `${roofInner3} → ${roofInnerStats.total}`);

const roofOuter = render({ outlineOuter: 0, partOutlines: { roof: { outer: 3, outerColor: "#00ff00" } } });
const roofOuterStats = classify(roofOuter, OUTER);
check("部件级外描边：只有 roof 的剪影外扩", roofOuterStats.total > 100, String(roofOuterStats.total));
check("部件级外描边：不覆盖 roof 自己的像素", roofOuterStats.roles.has(ROOF) === false,
	Array.from(roofOuterStats.roles.keys()).map((v) => TB.ROLES[v]).join(","));

// 全局外描边 + 部件覆盖为 0 → 该部件没有外描边
const disabled = render({ outlineOuter: 2, partOutlines: { roof: { outer: 0 } } });
const disabledStats = classify(disabled, OUTER);
const roofOuterWithGlobal = classify(render({ outlineOuter: 2 }), OUTER);
check("部件级外描边 = 0 可关闭全局外扩", disabledStats.total < roofOuterWithGlobal.total, `${disabledStats.total} vs ${roofOuterWithGlobal.total}`);

// 内/外描边颜色独立
const colorTest = render({ outlineInner: 2, partOutlines: { wall: { innerColor: "#00ff00" } } });
const wallGreen = classify(colorTest, OUTER);
check("部件级内描边颜色独立生效", wallGreen.onGeometry > 20 && wallGreen.roles.has(WALL) && wallGreen.roles.size === 1,
	Array.from(wallGreen.roles.keys()).map((v) => TB.ROLES[v]).join(","));

// ---- 7. 拾取缓冲 ----
const frame = render({ outlineInner: 1, outlineOuter: 1, outlineSilhouette: 1 });
check("pick 缓冲尺寸与画面一致", frame.pick && frame.pick.length === frame.width * frame.height,
	`${frame.pick ? frame.pick.length : 0} vs ${frame.width * frame.height}`);
const roleSet = new Set();
let bg = 0;
let colorMismatch = 0;
for (let i = 0; i < frame.pick.length; i++) {
	roleSet.add(frame.pick[i]);
	if (frame.pick[i] === 255) {
		bg++;
		// 背景像素允许是外描边 / 轮廓描边（不透明），其余必须透明
		if (frame.data[i * 4 + 3] === 255 && !isColor(frame, i, OUTER) && !isColor(frame, i, SIL)) colorMismatch++;
	} else if (frame.data[i * 4 + 3] !== 255) {
		colorMismatch++;
	}
}
check("pick 包含背景（255）", bg > 0, String(bg));
check("pick 包含屋顶 / 墙面 / 木构件", roleSet.has(ROOF) && roleSet.has(WALL) && roleSet.has(TB.ROLES.indexOf("wood")),
	Array.from(roleSet).filter((v) => v !== 255).map((v) => TB.ROLES[v]).join(","));
check("pick 与像素透明度一致", colorMismatch === 0, String(colorMismatch));
check("描边不改变 pick（外描边下方的部件仍可点中）", (() => {
	let n = 0;
	for (let i = 0; i < frame.pick.length; i++) if (isColor(frame, i, OUTER) && frame.pick[i] !== 255) n++;
	return n > 0;
})(), "");

// ---- 8. 抗锯齿开启时 pick 也会降采样到画面尺寸 ----
const aa = TB.renderFrame(mesh, tiles, view, view.yaws[0], {
	antialias: true, outlineInner: 1, outlineOuter: 1, outlineSilhouette: 1,
	outlineColor: "#ff00ff", outlineColorOuter: "#00ff00", outlineColorSilhouette: "#0080ff", transparent: true
});
check("抗锯齿时 pick 尺寸仍等于输出尺寸", aa.pick.length === aa.width * aa.height, `${aa.pick.length}`);

// ---- 保存一张对照图 ----
const image = render({ outlineInner: 2, outlineOuter: 2, outlineSilhouette: 2 });
fs.mkdirSync(path.join(__dirname, "_out"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "_out", "outline_split.png"), encodePng(image));

const failed = results.filter((r) => !r.ok).length;
console.log("\n结果：" + (results.length - failed) + " / " + results.length + " 通过");
process.exit(failed ? 1 : 0);

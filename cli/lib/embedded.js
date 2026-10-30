"use strict";
/**
 * 图片内嵌元信息（v1.1）：把渲染配方写进 PNG 的 ancillary 文本块，
 * 让导出的图片本身就能被回读、复现，像素数据完全不变。
 *
 * 写入三个块（都在 IHDR 之后）：
 *   Software          tEXt  产生该图的工具与版本
 *   topdown:version   tEXt  工具版本号（肉眼 / strings 可查）
 *   topdown:recipe    iTXt  完整配方 JSON（UTF-8，deflate 压缩）
 *
 * 部件贴图是 dataURL、体积大：入图时剥离，只留来源文件名、字节数与 crc32。
 * 内嵌数据不含时间戳，因此「同参数渲染 → 逐字节相同」仍然成立。
 */
const fs = require("fs");
const png = require("./png");
const json = require("./json");

const FORMAT = "topdown-building-studio/1";
const FORMAT_VERSION = 1;
const RECIPE_KEY = "topdown:recipe";
const VERSION_KEY = "topdown:version";
const SOFTWARE_KEY = "Software";
const TOOL_NAME = "topdown-building-studio-cli";

function bad(message, hint) {
	const err = new Error(message);
	if (hint) err.hint = hint;
	return err;
}

function isPngBuffer(buffer) {
	return Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer.subarray(0, 8).equals(png.SIGNATURE);
}

/** 按文件头判断，不依赖扩展名（.png 改名的 JPG 也能识别出来）。 */
function isPngFile(file) {
	let fd;
	try {
		fd = fs.openSync(file, "r");
		const head = Buffer.alloc(8);
		const read = fs.readSync(fd, head, 0, 8, 0);
		return read === 8 && isPngBuffer(head);
	} catch (err) {
		return false;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function decodeDoc(text, file) {
	const raw = text[RECIPE_KEY];
	if (raw === undefined) {
		throw bad("这张图片没有内嵌配方：" + file,
			"可能来自 v1.1 之前的版本，或用 --no-meta 导出；重新用 render 生成一次即可");
	}
	let doc;
	try {
		doc = JSON.parse(raw);
	} catch (err) {
		throw bad("内嵌配方解析失败（" + err.message + "）：" + file, "图片可能被编辑工具破坏或截断");
	}
	if (!doc || (!doc.config && !doc.profile)) {
		throw bad("内嵌配方缺少 config/profile：" + file, "不是本工具写入的元信息");
	}
	return doc;
}

/** 读取图片内嵌配方。返回 { doc, version, software }。 */
function readFile(file) {
	const text = png.readTextFile(file);
	const doc = decodeDoc(text, file);
	return {
		doc: doc,
		version: doc.toolVersion || text[VERSION_KEY] || null,
		software: text[SOFTWARE_KEY] || null
	};
}

function readBuffer(buffer, label) {
	const text = png.readText(buffer);
	const doc = decodeDoc(text, label || "内存图片");
	return {
		doc: doc,
		version: doc.toolVersion || text[VERSION_KEY] || null,
		software: text[SOFTWARE_KEY] || null
	};
}

/** 配方文件或图片都可以当配方源（图片按文件头判断）。 */
function readRecipeDoc(file) {
	if (isPngFile(file)) return readFile(file).doc;
	return json.read(file, "配方");
}

function crcTag(text) {
	const hex = png.crc32(Buffer.from(text, "latin1")).toString(16);
	return "crc32:" + "00000000".slice(hex.length) + hex;
}

/**
 * 生成「可入图」的配方副本：去掉时间戳、剥离贴图 dataURL。
 * 返回 { doc, stripped }，原对象不被修改。
 */
function forPng(recipe, version) {
	const doc = JSON.parse(JSON.stringify(recipe));
	delete doc.generatedAt;
	let stripped = 0;
	const overrides = doc.config && doc.config.partOverrides;
	if (overrides) {
		Object.keys(overrides).forEach(function (role) {
			const part = overrides[role];
			if (!part || typeof part.texture !== "string") return;
			part.textureBytes = part.texture.length;
			part.textureCrc32 = crcTag(part.texture);
			part.texture = null;
			part.textureOmitted = true;
			stripped++;
		});
	}
	Object.keys(doc.parts || {}).forEach(function (role) {
		const part = doc.parts[role];
		if (part && part.texture === "embedded") part.texture = "omitted";
	});
	doc.embedded = {
		format: FORMAT,
		formatVersion: FORMAT_VERSION,
		tool: doc.tool || TOOL_NAME,
		toolVersion: version,
		textures: stripped ? "omitted" : "included"
	};
	return { doc: doc, stripped: stripped };
}

/** 文本块列表，交给 png.encode({ text }) 或网页端 TB.pngEmbedText。 */
function entries(doc, version) {
	return [
		{ keyword: SOFTWARE_KEY, text: (doc.tool || TOOL_NAME) + " " + version },
		{ keyword: VERSION_KEY, text: version },
		{ keyword: RECIPE_KEY, text: JSON.stringify(doc), utf8: true, compress: true }
	];
}

/** inspect 的人类/agent 友好摘要（视角参数放最前）。 */
function describe(doc, file) {
	const view = doc.view || {};
	const profile = doc.profile || {};
	const render = doc.render || {};
	const embedded = doc.embedded || {};
	const payload = {
		ok: true,
		file: file,
		tool: doc.tool || null,
		toolVersion: doc.toolVersion || null,
		format: embedded.format || null,
		generatedAt: doc.generatedAt || null,
		style: doc.style ? doc.style.id : null,
		type: profile.typeId || null,
		canvas: view.canvas || null,
		dirs: view.directions === undefined ? null : view.directions,
		pitch: view.pitch === undefined ? null : Math.round(view.pitch * 10) / 10,
		proj: view.projection === "perspective" ? "persp" : "ortho",
		fov: view.fov === undefined ? null : view.fov,
		baseYaw: view.baseYaw === undefined ? null : view.baseYaw,
		scaleMode: view.scaleMode || null,
		ppm: view.pixelsPerMeter === undefined ? null : view.pixelsPerMeter,
		padding: view.padding === undefined ? null : view.padding,
		seeds: [profile.shapeSeed, profile.detailSeed, profile.appearanceSeed],
		look: doc.look,
		params: profile.params || null,
		render: {
			outlineInner: render.outlineInner || 0,
			outlineOuter: render.outlineOuter || 0,
			outlineSilhouette: render.outlineSilhouette || 0,
			antialias: render.antialias === undefined ? null : !!render.antialias,
			background: render.background || null
		},
		parts: Object.keys(doc.parts || {}),
		textures: embedded.textures || null
	};
	if (embedded.textures === "omitted") {
		payload.warnings = ["部件贴图未内嵌（体积原因），复现需重新指定 --part <角色>:texture=<文件>"];
	}
	return payload;
}

module.exports = {
	FORMAT, FORMAT_VERSION, RECIPE_KEY, VERSION_KEY, SOFTWARE_KEY, TOOL_NAME,
	isPngBuffer, isPngFile, readFile, readBuffer, readRecipeDoc,
	forPng, entries, describe
};

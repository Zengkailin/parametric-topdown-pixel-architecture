(function () {
"use strict";
/**
 * PNG 内嵌元信息（v1.1）：在网页导出的 PNG 里写入生成配方。
 * 只插入 ancillary 文本块（IHDR 之后），像素数据一个字节都不改；
 * 块名与 JSON 结构和 cli/lib/embedded.js 完全一致，CLI 的 inspect 可直接读。
 */
var TB = globalThis.TB;

var FORMAT = "topdown-building-studio/1";
var FORMAT_VERSION = 1;
var RECIPE_KEY = "topdown:recipe";
var VERSION_KEY = "topdown:version";
var SOFTWARE_KEY = "Software";

function latin1Bytes(text) {
	var out = new Uint8Array(text.length);
	for (var i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 255;
	return out;
}

function utf8Bytes(text) {
	return new TextEncoder().encode(text);
}

function concat(list) {
	var total = 0;
	list.forEach(function (item) { total += item.length; });
	var out = new Uint8Array(total);
	var at = 0;
	list.forEach(function (item) { out.set(item, at); at += item.length; });
	return out;
}

function chunk(type, data) {
	var body = concat([latin1Bytes(type), data]);
	var out = new Uint8Array(4 + body.length + 4);
	var view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(body, 4);
	view.setUint32(4 + body.length, TB.crc32(body));
	return out;
}

function textChunk(entry) {
	var keyword = latin1Bytes(String(entry.keyword));
	var text = String(entry.text);
	var ascii = /^[\x00-\xff]*$/.test(text) && !entry.utf8;
	if (ascii) {
		return chunk("tEXt", concat([keyword, new Uint8Array([0]), latin1Bytes(text)]));
	}
	return chunk("iTXt", concat([
		keyword, new Uint8Array([0]),
		new Uint8Array([0, 0]),
		new Uint8Array([0]), new Uint8Array([0]),
		utf8Bytes(text)
	]));
}

function crcTag(text) {
	var hex = TB.crc32(latin1Bytes(text)).toString(16);
	return "crc32:" + "00000000".slice(hex.length) + hex;
}

/** 生成可入图的配方副本：去时间戳、剥离贴图 dataURL（体积原因）。 */
TB.pngMetaEntries = function (doc) {
	var copy = JSON.parse(JSON.stringify(doc));
	delete copy.generatedAt;
	var stripped = 0;
	var overrides = copy.config && copy.config.partOverrides;
	if (overrides) {
		Object.keys(overrides).forEach(function (role) {
			var part = overrides[role];
			if (!part || typeof part.texture !== "string") return;
			part.textureBytes = part.texture.length;
			part.textureCrc32 = crcTag(part.texture);
			part.texture = null;
			part.textureOmitted = true;
			stripped++;
		});
	}
	Object.keys(copy.parts || {}).forEach(function (role) {
		var part = copy.parts[role];
		if (part && part.texture === "embedded") part.texture = "omitted";
	});
	copy.embedded = {
		format: FORMAT,
		formatVersion: FORMAT_VERSION,
		tool: copy.tool,
		toolVersion: copy.toolVersion,
		textures: stripped ? "omitted" : "included"
	};
	return [
		{ keyword: SOFTWARE_KEY, text: copy.tool + " " + copy.toolVersion },
		{ keyword: VERSION_KEY, text: String(copy.toolVersion) },
		{ keyword: RECIPE_KEY, text: JSON.stringify(copy), utf8: true }
	];
};

/** 把文本块插到 IHDR 之后；不是 PNG 时原样返回。 */
TB.pngEmbedText = function (bytes, entries) {
	if (!bytes || bytes.length < 33) return bytes;
	var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	var length = view.getUint32(8);
	var type = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
	if (type !== "IHDR") return bytes;
	var at = 8 + 12 + length;
	var chunks = (entries || []).map(textChunk);
	return concat([bytes.subarray(0, at)].concat(chunks, [bytes.subarray(at)]));
};

// ---------------------------------------------------------------------------
// 读取：解析 tEXt / zTXt / iTXt（CLI 写的配方是 deflate 压缩的 iTXt）
// ---------------------------------------------------------------------------
var PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function hasSignature(bytes) {
	if (!bytes || bytes.length < 8) return false;
	for (var i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
	return true;
}

function latin1Text(bytes, start, end) {
	var out = "";
	for (var i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
	return out;
}

function readU32(bytes, at) {
	return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

/** zlib（deflate）解压：Compression Streams，Chrome/Edge 80+。 */
async function inflateZlib(bytes) {
	if (typeof DecompressionStream !== "function") {
		throw new Error("当前浏览器不支持解压 PNG 里的压缩配方（需要 Chrome / Edge 80+）");
	}
	var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function keywordEnd(bytes, at, end) {
	for (var i = at; i < end; i++) if (bytes[i] === 0) return i;
	return -1;
}

async function parseTextChunk(type, bytes, at, end) {
	var zero = keywordEnd(bytes, at, end);
	if (zero < 0) return null;
	var keyword = latin1Text(bytes, at, zero);
	var pos = zero + 1;
	if (type === "tEXt") return { keyword: keyword, text: latin1Text(bytes, pos, end), utf8: false };
	if (type === "zTXt") {
		if (pos >= end) return null;
		var raw = await inflateZlib(bytes.subarray(pos + 1, end));
		return { keyword: keyword, text: new TextDecoder().decode(raw), utf8: true };
	}
	if (pos + 2 > end) return null;
	var compressed = bytes[pos] === 1;
	var textAt = pos + 2;
	var langEnd = keywordEnd(bytes, textAt, end);
	if (langEnd < 0) return null;
	var translatedEnd = keywordEnd(bytes, langEnd + 1, end);
	if (translatedEnd < 0) return null;
	var body = bytes.subarray(translatedEnd + 1, end);
	if (compressed) body = await inflateZlib(body);
	return { keyword: keyword, text: new TextDecoder().decode(body), utf8: true };
}

/** 读出全部文本块：{ 关键字: 文本 }。不是 PNG 时抛错。 */
TB.pngReadText = async function (bytes) {
	if (!hasSignature(bytes)) throw new Error("不是 PNG 文件");
	var text = {};
	var at = 8;
	while (at + 8 <= bytes.length) {
		var length = readU32(bytes, at);
		var type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
		var dataAt = at + 8;
		var dataEnd = dataAt + length;
		if (dataEnd + 4 > bytes.length) break;
		if (type === "IEND") break;
		if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
			var entry = await parseTextChunk(type, bytes, dataAt, dataEnd);
			if (entry) text[entry.keyword] = entry.text;
		}
		at = dataEnd + 4;
	}
	return text;
};

/** 解析图片内嵌配方，结构校验与 cli/lib/embedded.js 一致。 */
TB.pngReadMeta = async function (bytes) {
	var text = await TB.pngReadText(bytes);
	var raw = text[RECIPE_KEY];
	if (raw === undefined) {
		throw new Error("这张图片没有内嵌配方，可能来自 v1.1 之前的版本或命令行加了 --no-meta；请重新导出一次");
	}
	var doc;
	try {
		doc = JSON.parse(raw);
	} catch (err) {
		throw new Error("内嵌配方解析失败：" + err.message + "（图片可能被编辑工具破坏）");
	}
	if (!doc || (!doc.config && !doc.profile)) {
		throw new Error("内嵌配方缺少 config/profile，不是本工具写入的元信息");
	}
	return {
		doc: doc,
		version: doc.toolVersion || text[VERSION_KEY] || null,
		software: text[SOFTWARE_KEY] || null,
		emb: doc.embedded || null
	};
};
})();

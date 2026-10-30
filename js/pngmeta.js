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
})();

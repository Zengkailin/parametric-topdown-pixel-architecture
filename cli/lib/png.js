"use strict";
/**
 * 最小 PNG 编解码（零依赖，Node 内置 zlib）。
 *
 * 解码支持：8 位通道的灰度 / RGB / 索引色 / 灰度+alpha / RGBA，
 * 以及 1/2/4 位索引色（像素画工具常见导出）。不支持交错与 16 位，
 * 遇到会给出可执行的提示，而不是静默出错图。
 *
 * 编码固定输出 8 位 RGBA（color type 6），filter 0，deflate 可调级别。
 *
 * 文本块（tEXt / zTXt / iTXt）是 PNG 的 ancillary chunk，像素数据完全不受影响：
 * 写入时放在 IHDR 之后，读取时与像素解码解耦（readText 只看块，不解像素）。
 */
const fs = require("fs");
const zlib = require("zlib");

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const COLOR_NAME = { 0: "灰度", 2: "RGB", 3: "索引色", 4: "灰度+alpha", 6: "RGBA" };

function bad(message, hint) {
	const err = new Error(message);
	if (hint) err.hint = hint;
	return err;
}

function paeth(a, b, c) {
	const p = a + b - c;
	const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
}

/** Buffer(PNG) → {width, height, data: Uint8ClampedArray(RGBA)} */
function decode(buffer) {
	if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
	if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
		throw bad("不是有效的 PNG 文件", "请确认文件确实是 PNG（不是 JPG/WebP 改后缀）");
	}
	let pos = 8, width = 0, height = 0, depth = 8, colorType = 6, interlace = 0;
	let palette = null, trns = null;
	const idat = [];
	const text = {};
	while (pos + 8 <= buffer.length) {
		const length = buffer.readUInt32BE(pos);
		const type = buffer.toString("ascii", pos + 4, pos + 8);
		const data = buffer.subarray(pos + 8, pos + 8 + length);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			depth = data[8];
			colorType = data[9];
			interlace = data[12];
		} else if (type === "PLTE") palette = data;
		else if (type === "tRNS") trns = data;
		else if (type === "IDAT") idat.push(data);
		else if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
			const entry = parseTextChunk(type, data);
			if (entry) text[entry[0]] = entry[1];
		} else if (type === "IEND") break;
		pos += 12 + length;
	}
	if (!width || !height) throw bad("PNG 缺少 IHDR");
	if (interlace !== 0) {
		throw bad("不支持交错（Adam7）PNG", "请用非交错方式另存，例如 Photoshop「存储为 Web 所用格式」或 Aseprite 默认导出");
	}
	const channels = CHANNELS[colorType];
	if (!channels) throw bad("不支持的 PNG 颜色类型：" + colorType, "请在图像工具里另存为 8 位 RGBA PNG");

	const paletteMode = colorType === 3;
	if (!paletteMode && depth !== 8) {
		throw bad("不支持 " + depth + " 位/通道的 " + COLOR_NAME[colorType] + " PNG", "请另存为 8 位/通道（推荐 RGBA）");
	}
	if (paletteMode && depth !== 8 && depth !== 4 && depth !== 2 && depth !== 1) {
		throw bad("不支持的索引色位深：" + depth);
	}
	if (paletteMode && !palette) throw bad("索引色 PNG 缺少 PLTE 调色板");

	if (!idat.length) throw bad("PNG 缺少 IDAT 数据");
	const raw = zlib.inflateSync(Buffer.concat(idat));
	const bitsPerPixel = channels * depth;
	const bytesPerRow = Math.ceil(width * bitsPerPixel / 8);
	const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
	const out = new Uint8ClampedArray(width * height * 4);
	let prev = Buffer.alloc(bytesPerRow);
	let offset = 0;
	for (let y = 0; y < height; y++) {
		const filter = raw[offset++];
		const cur = Buffer.from(raw.subarray(offset, offset + bytesPerRow));
		offset += bytesPerRow;
		for (let x = 0; x < bytesPerRow; x++) {
			const a = x >= bpp ? cur[x - bpp] : 0;
			const b = prev[x];
			const c = x >= bpp ? prev[x - bpp] : 0;
			if (filter === 1) cur[x] = (cur[x] + a) & 255;
			else if (filter === 2) cur[x] = (cur[x] + b) & 255;
			else if (filter === 3) cur[x] = (cur[x] + ((a + b) >> 1)) & 255;
			else if (filter === 4) cur[x] = (cur[x] + paeth(a, b, c)) & 255;
			else if (filter !== 0) throw bad("PNG 行过滤器非法：" + filter);
		}
		const row = y * width * 4;
		if (paletteMode) {
			const perByte = 8 / depth;
			const mask = (1 << depth) - 1;
			for (let x = 0; x < width; x++) {
				const shift = 8 - depth * ((x % perByte) + 1);
				const index = (cur[Math.floor(x / perByte)] >> shift) & mask;
				const p = index * 3;
				const o = row + x * 4;
				out[o] = palette[p];
				out[o + 1] = palette[p + 1];
				out[o + 2] = palette[p + 2];
				out[o + 3] = trns && index < trns.length ? trns[index] : 255;
			}
		} else if (colorType === 6) {
			out.set(cur.subarray(0, width * 4), row);
		} else if (colorType === 2) {
			for (let x = 0; x < width; x++) {
				const s = x * 3, o = row + x * 4;
				out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = 255;
			}
		} else if (colorType === 0) {
			for (let x = 0; x < width; x++) {
				const v = cur[x], o = row + x * 4;
				out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255;
			}
		} else if (colorType === 4) {
			for (let x = 0; x < width; x++) {
				const s = x * 2, o = row + x * 4;
				out[o] = cur[s]; out[o + 1] = cur[s]; out[o + 2] = cur[s]; out[o + 3] = cur[s + 1];
			}
		}
		prev = cur;
	}
	return { width: width, height: height, data: out, text: text };
}

function decodeFile(file) {
	let buffer;
	try {
		buffer = fs.readFileSync(file);
	} catch (err) {
		throw bad("读不到文件：" + file, "检查路径是否写对（相对路径以当前工作目录为基准）");
	}
	const image = decode(buffer);
	image.file = file;
	return image;
}

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body), 0);
	return Buffer.concat([length, body, crc]);
}

/** tEXt / zTXt / iTXt 共用解析：返回 [keyword, text]；块损坏返回 null（ancillary 块不该拖垮解码）。 */
function parseTextChunk(type, data) {
	try {
		const end = data.indexOf(0);
		if (end <= 0) return null;
		const keyword = data.toString("latin1", 0, end);
		if (type === "tEXt") return [keyword, data.toString("latin1", end + 1)];
		if (type === "zTXt") {
			const method = data[end + 1];
			if (method !== 0) return null;
			return [keyword, zlib.inflateSync(data.subarray(end + 2)).toString("latin1")];
		}
		if (type === "iTXt") {
			const flag = data[end + 1];
			const method = data[end + 2];
			if (method !== 0) return null;
			let p = data.indexOf(0, end + 3);
			if (p < 0) return null;
			p = data.indexOf(0, p + 1);
			if (p < 0) return null;
			let body = data.subarray(p + 1);
			if (flag === 1) body = zlib.inflateSync(body);
			else if (flag !== 0) return null;
			return [keyword, body.toString("utf8")];
		}
	} catch (err) {
		return null;
	}
	return null;
}

/** 关键字规则：1–79 字节 Latin-1、不含 NUL。 */
function checkKeyword(keyword) {
	const text = String(keyword);
	if (!text || Buffer.byteLength(text, "latin1") > 79 || text.indexOf("\u0000") >= 0) {
		throw bad("PNG 文本块关键字非法：" + text);
	}
	if (!/^[\x20-\x7e]+$/.test(text)) {
		throw bad("PNG 文本块关键字只能是可打印 ASCII：" + text);
	}
	return text;
}

function textChunk(entry) {
	const keyword = checkKeyword(entry.keyword);
	const text = String(entry.text);
	const utf8 = entry.utf8 || !/^[\x00-\xff]*$/.test(text);
	if (!utf8) {
		return chunk("tEXt", Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0]), Buffer.from(text, "latin1")]));
	}
	const body = Buffer.from(text, "utf8");
	const compress = entry.compress && body.length > 128;
	const payload = compress ? zlib.deflateSync(body, { level: 9 }) : body;
	return chunk("iTXt", Buffer.concat([
		Buffer.from(keyword, "latin1"), Buffer.from([0]),
		Buffer.from([compress ? 1 : 0, 0]),
		Buffer.from([0]), Buffer.from([0]),
		payload
	]));
}

let CRC_TABLE = null;
function crc32(bytes) {
	if (!CRC_TABLE) {
		CRC_TABLE = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
			CRC_TABLE[n] = c >>> 0;
		}
	}
	let c = 0xFFFFFFFF;
	for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
	return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * RGBA → Buffer(PNG)
 * options.text: [{ keyword, text, utf8?, compress? }] 写入 IHDR 之后（不影响像素）。
 */
function encode(width, height, data, options) {
	const level = options && options.level !== undefined ? options.level : 6;
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	const view = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0;
		view.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;
	const texts = ((options && options.text) || []).map(textChunk);
	return Buffer.concat([
		SIGNATURE,
		chunk("IHDR", ihdr)
	].concat(texts, [
		chunk("IDAT", zlib.deflateSync(raw, { level: level })),
		chunk("IEND", Buffer.alloc(0))
	]));
}

/** 只读文本块，不碰像素（任意颜色类型/位深都能读，适合校验别人导出的图）。 */
function readText(buffer) {
	if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
	if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
		throw bad("不是有效的 PNG 文件", "请确认文件确实是 PNG（不是 JPG/WebP 改后缀）");
	}
	const text = {};
	let pos = 8;
	while (pos + 8 <= buffer.length) {
		const length = buffer.readUInt32BE(pos);
		const type = buffer.toString("ascii", pos + 4, pos + 8);
		if (type === "IEND") break;
		if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
			const entry = parseTextChunk(type, buffer.subarray(pos + 8, pos + 8 + length));
			if (entry) text[entry[0]] = entry[1];
		}
		pos += 12 + length;
	}
	return text;
}

function readTextFile(file) {
	let buffer;
	try {
		buffer = fs.readFileSync(file);
	} catch (err) {
		throw bad("读不到文件：" + file, "检查路径是否写对（相对路径以当前工作目录为基准）");
	}
	return readText(buffer);
}

function toDataURL(buffer) {
	return "data:image/png;base64," + buffer.toString("base64");
}

function fromDataURL(url) {
	const index = String(url).indexOf("base64,");
	if (index < 0) throw bad("不是 base64 dataURL");
	return decode(Buffer.from(String(url).slice(index + 7), "base64"));
}

/**
 * 等比分箱缩小（预乘 alpha 平均），用于缩略图。
 * 不做放大：源图小于目标时原样返回。
 */
function downscale(data, width, height, maxSide) {
	if (!maxSide || Math.max(width, height) <= maxSide) {
		return { width: width, height: height, data: data };
	}
	const scale = Math.max(width, height) / maxSide;
	const tw = Math.max(1, Math.round(width / scale));
	const th = Math.max(1, Math.round(height / scale));
	const out = new Uint8ClampedArray(tw * th * 4);
	const sx = width / tw, sy = height / th;
	for (let y = 0; y < th; y++) {
		const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
		for (let x = 0; x < tw; x++) {
			const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
			let r = 0, g = 0, b = 0, a = 0, count = 0;
			for (let yy = y0; yy < y1; yy++) {
				for (let xx = x0; xx < x1; xx++) {
					const o = (yy * width + xx) * 4;
					const alpha = data[o + 3];
					r += data[o] * alpha;
					g += data[o + 1] * alpha;
					b += data[o + 2] * alpha;
					a += alpha;
					count++;
				}
			}
			const d = (y * tw + x) * 4;
			if (a > 0) {
				out[d] = r / a;
				out[d + 1] = g / a;
				out[d + 2] = b / a;
			}
			out[d + 3] = a / Math.max(1, count);
		}
	}
	return { width: tw, height: th, data: out };
}

/**
 * 覆盖率与包围盒，用于让 agent 判断「是不是空白 / 构图偏了」。
 * bg 传入 [r,g,b] 时按「与背景色不同」统计（不透明背景时 ink 才不是恒等于 1）。
 */
function analyze(data, width, height, bg) {
	let covered = 0, minX = width, minY = height, maxX = -1, maxY = -1;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 4;
			let hit;
			if (bg) {
				hit = Math.abs(data[o] - bg[0]) + Math.abs(data[o + 1] - bg[1]) + Math.abs(data[o + 2] - bg[2]) > 12;
				if (hit) covered += 1;
			} else {
				hit = data[o + 3] > 8;
				covered += data[o + 3] / 255;
			}
			if (hit) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	const ink = width && height ? covered / (width * height) : 0;
	return {
		ink: Math.round(ink * 1000) / 1000,
		bbox: maxX < 0 ? null : [minX, minY, maxX, maxY]
	};
}

module.exports = {
	SIGNATURE, decode, decodeFile, encode, readText, readTextFile,
	toDataURL, fromDataURL, downscale, analyze, crc32
};

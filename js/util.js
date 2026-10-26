(function () {
"use strict";
/**
 * 基础数学 / 随机数 / 变换 / 打包工具。
 * 纯函数、无 DOM 依赖，可直接在 Node 里跑自测。
 */
var TB = globalThis.TB = globalThis.TB || {};

// ---------------------------------------------------------------------------
// 标量
// ---------------------------------------------------------------------------
TB.clamp = function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); };
TB.clampInt = function (v, lo, hi) { v = Math.round(v); return v < lo ? lo : (v > hi ? hi : v); };
TB.lerp = function (a, b, t) { return a + (b - a) * t; };
TB.posmod = function (a, b) { return ((a % b) + b) % b; };
/** 与 Godot wrapf 同义：结果落在 [min, max)。 */
TB.wrapf = function (value, min, max) {
	var range = max - min;
	if (range <= 0) return min;
	return value - range * Math.floor((value - min) / range);
};
TB.snappedf = function (value, step) { return step > 0 ? Math.round(value / step) * step : value; };
TB.deg = function (d) { return d * Math.PI / 180; };
TB.rad = function (r) { return r * 180 / Math.PI; };

// ---------------------------------------------------------------------------
// 向量（[x,y,z]，少量分配，几何构建阶段够用）
// ---------------------------------------------------------------------------
var V = TB.V = {
	make: function (x, y, z) { return [x || 0, y || 0, z || 0]; },
	add: function (a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; },
	sub: function (a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; },
	mul: function (a, s) { return [a[0] * s, a[1] * s, a[2] * s]; },
	mulv: function (a, b) { return [a[0] * b[0], a[1] * b[1], a[2] * b[2]]; },
	neg: function (a) { return [-a[0], -a[1], -a[2]]; },
	dot: function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; },
	cross: function (a, b) {
		return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
	},
	len: function (a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); },
	len2: function (a) { return a[0] * a[0] + a[1] * a[1] + a[2] * a[2]; },
	norm: function (a) {
		var l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
		return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
	},
	lerp: function (a, b, t) {
		return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
	},
	dist: function (a, b) {
		var dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
		return Math.sqrt(dx * dx + dy * dy + dz * dz);
	},
	/** p + UP * y，几何代码里到处用。 */
	lift: function (p, y) { return [p[0], p[1] + y, p[2]]; }
};
TB.UP = [0, 1, 0];
TB.RIGHT = [1, 0, 0];
TB.BACK = [0, 0, 1];
TB.FORWARD = [0, 0, -1];

// 向量操作的便捷别名（变换代码里直接写 TB.add 更接近 GDScript 读法）
TB.add = V.add;
TB.sub = V.sub;
TB.mul = V.mul;
TB.dot = V.dot;
TB.cross = V.cross;
TB.vlen = V.len;
TB.vnorm = V.norm;

// ---------------------------------------------------------------------------
// 3×3 基（按列存：bx/by/bz 三个基向量）+ 变换
// ---------------------------------------------------------------------------
TB.basis = function (bx, by, bz) { return { bx: bx, by: by, bz: bz }; };
TB.basisIdentity = function () { return { bx: [1, 0, 0], by: [0, 1, 0], bz: [0, 0, 1] }; };

/** 绕 Y 轴旋转：Basis(Vector3.UP, angle)。 */
TB.basisRotY = function (angle) {
	var c = Math.cos(angle), s = Math.sin(angle);
	return { bx: [c, 0, -s], by: [0, 1, 0], bz: [s, 0, c] };
};
/** 绕 X 轴旋转：Basis(Vector3.RIGHT, angle)。 */
TB.basisRotX = function (angle) {
	var c = Math.cos(angle), s = Math.sin(angle);
	return { bx: [1, 0, 0], by: [0, c, s], bz: [0, -s, c] };
};
TB.basisFromScale = function (x, y, z) {
	return { bx: [x, 0, 0], by: [0, y, 0], bz: [0, 0, z] };
};

TB.basisMul = function (a, b) {
	return {
		bx: TB.applyDir(a, b.bx),
		by: TB.applyDir(a, b.by),
		bz: TB.applyDir(a, b.bz)
	};
};
TB.applyDir = function (b, v) {
	return [
		b.bx[0] * v[0] + b.by[0] * v[1] + b.bz[0] * v[2],
		b.bx[1] * v[0] + b.by[1] * v[1] + b.bz[1] * v[2],
		b.bx[2] * v[0] + b.by[2] * v[1] + b.bz[2] * v[2]
	];
};
TB.basisTranspose = function (b) { return { bx: [b.bx[0], b.by[0], b.bz[0]], by: [b.bx[1], b.by[1], b.bz[1]], bz: [b.bx[2], b.by[2], b.bz[2]] }; };

/** 通用 3×3 逆矩阵（列基）。 */
TB.basisInverse = function (b) {
	var m = [
		b.bx[0], b.by[0], b.bz[0],
		b.bx[1], b.by[1], b.bz[1],
		b.bx[2], b.by[2], b.bz[2]
	];
	var a00 = m[0], a01 = m[1], a02 = m[2];
	var a10 = m[3], a11 = m[4], a12 = m[5];
	var a20 = m[6], a21 = m[7], a22 = m[8];
	var c00 = a11 * a22 - a12 * a21;
	var c01 = a12 * a20 - a10 * a22;
	var c02 = a10 * a21 - a11 * a20;
	var det = a00 * c00 + a01 * c01 + a02 * c02;
	if (Math.abs(det) < 1e-12) return TB.basisIdentity();
	var id = 1 / det;
	// 伴随矩阵 / det，再按列基拆开
	var i00 = c00 * id, i01 = (a02 * a21 - a01 * a22) * id, i02 = (a01 * a12 - a02 * a11) * id;
	var i10 = c01 * id, i11 = (a00 * a22 - a02 * a20) * id, i12 = (a02 * a10 - a00 * a12) * id;
	var i20 = c02 * id, i21 = (a01 * a20 - a00 * a21) * id, i22 = (a00 * a11 - a01 * a10) * id;
	return { bx: [i00, i10, i20], by: [i01, i11, i21], bz: [i02, i12, i22] };
};
/** 法线矩阵：inverse(basis).transposed()，与 Godot 版 face() 一致。 */
TB.normalBasis = function (b) { return TB.basisTranspose(TB.basisInverse(b)); };

TB.xf = function (b, o) { return { b: b || TB.basisIdentity(), o: o || [0, 0, 0] }; };
TB.xfIdentity = function () { return { b: TB.basisIdentity(), o: [0, 0, 0] }; };
TB.xfMul = function (a, b) {
	return { b: TB.basisMul(a.b, b.b), o: TB.add(TB.applyDir(a.b, b.o), a.o) };
};
TB.xfPoint = function (t, p) { return TB.add(TB.applyDir(t.b, p), t.o); };
TB.xfDir = function (t, v) { return TB.applyDir(t.b, v); };

// ---------------------------------------------------------------------------
// 确定性随机数：PCG32（Godot RandomPCG 同族算法）
// 同一种子在本工具内严格可复现；与 Godot 的数值序列不逐位对齐。
// ---------------------------------------------------------------------------
var MASK64 = (1n << 64n) - 1n;
var MULT = 6364136223846793005n;
function PCG(seed) {
	this.state = BigInt(Math.trunc(seed) >>> 0);
	this.inc = 1442695040888963407n;
}
PCG.prototype.rand = function () {
	var old = this.state;
	this.state = (old * MULT + this.inc) & MASK64;
	var xorshifted = Number((((old >> 18n) ^ old) >> 27n) & 0xFFFFFFFFn) >>> 0;
	var rot = Number(old >> 59n) & 31;
	return ((xorshifted >>> rot) | (xorshifted << ((-rot) & 31))) >>> 0;
};
PCG.prototype.randf = function () { return this.rand() / 4294967296.0; };
PCG.prototype.randiRange = function (a, b) {
	if (b < a) { var t = a; a = b; b = t; }
	return a + (this.rand() % ((b - a) + 1));
};
PCG.prototype.randfRange = function (a, b) { return a + this.randf() * (b - a); };
TB.PCG = PCG;

/** FNV-1a 32 位；用于角色名/类型名哈希（对应 Godot 的 String.hash()）。 */
TB.hashStr = function (str) {
	var h = 0x811c9dc5;
	for (var i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
};
/** 配方指纹：FNV-1a 64 位 → 16 位十六进制，用作输出目录名。 */
TB.hash64 = function (str) {
	var h1 = 0xcbf29ce484222325n;
	var h2 = 0x9e3779b97f4a7c15n;
	var prime = 0x100000001b3n;
	for (var i = 0; i < str.length; i++) {
		var c = BigInt(str.charCodeAt(i));
		h1 = ((h1 ^ c) * prime) & MASK64;
		h2 = ((h2 ^ (c + BigInt(i))) * prime) & MASK64;
	}
	var out = (h1 ^ (h2 << 1n)) & MASK64;
	return out.toString(16).padStart(16, "0");
};

// ---------------------------------------------------------------------------
// 颜色
// ---------------------------------------------------------------------------
TB.hexToRgb = function (hex) {
	hex = String(hex || "#000000").trim();
	if (hex[0] === "#") hex = hex.slice(1);
	if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
	var n = parseInt(hex, 16);
	if (isNaN(n)) return [0, 0, 0];
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
TB.rgbToHex = function (rgb) {
	var s = "#";
	for (var i = 0; i < 3; i++) {
		var v = Math.max(0, Math.min(255, Math.round(rgb[i])));
		s += v.toString(16).padStart(2, "0");
	}
	return s;
};
/** Godot Color.lightened / darkened：按比例向白色 / 黑色混合。 */
TB.lighten = function (rgb, amount) {
	return [rgb[0] + (255 - rgb[0]) * amount, rgb[1] + (255 - rgb[1]) * amount, rgb[2] + (255 - rgb[2]) * amount];
};
TB.darken = function (rgb, amount) { return [rgb[0] * (1 - amount), rgb[1] * (1 - amount), rgb[2] * (1 - amount)]; };
TB.shade = function (rgb, amount) { return amount >= 0 ? TB.lighten(rgb, amount) : TB.darken(rgb, -amount); };
TB.lerpRgb = function (a, b, t) { return [TB.lerp(a[0], b[0], t), TB.lerp(a[1], b[1], t), TB.lerp(a[2], b[2], t)]; };

// ---------------------------------------------------------------------------
// 极简 ZIP（仅 store，无压缩）：给“导出全部方向”打包用
// ---------------------------------------------------------------------------
var CRC_TABLE = (function () {
	var table = new Uint32Array(256);
	for (var n = 0; n < 256; n++) {
		var c = n;
		for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
		table[n] = c >>> 0;
	}
	return table;
})();
function crc32(bytes) {
	var c = 0xFFFFFFFF;
	for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
	return (c ^ 0xFFFFFFFF) >>> 0;
}
TB.crc32 = crc32;

/** files: [{name, data: Uint8Array}] → Uint8Array(zip) */
TB.zip = function (files) {
	var encoder = new TextEncoder();
	var entries = files.map(function (f) {
		var name = encoder.encode(f.name);
		return { name: name, data: f.data, crc: crc32(f.data) };
	});
	var total = 22;
	entries.forEach(function (e) { total += 30 + e.name.length + e.data.length + 46 + e.name.length; });
	var out = new Uint8Array(total);
	var view = new DataView(out.buffer);
	var offset = 0;
	var central = [];
	function u16(v) { view.setUint16(offset, v, true); offset += 2; }
	function u32(v) { view.setUint32(offset, v >>> 0, true); offset += 4; }
	entries.forEach(function (e) {
		var start = offset;
		u32(0x04034b50); u16(20); u16(0x0800); u16(0); u16(0); u16(0);
		u32(e.crc); u32(e.data.length); u32(e.data.length);
		u16(e.name.length); u16(0);
		out.set(e.name, offset); offset += e.name.length;
		out.set(e.data, offset); offset += e.data.length;
		central.push({ header: start, entry: e });
	});
	var cdStart = offset;
	central.forEach(function (c) {
		var e = c.entry;
		u32(0x02014b50); u16(20); u16(20); u16(0x0800); u16(0); u16(0); u16(0);
		u32(e.crc); u32(e.data.length); u32(e.data.length);
		u16(e.name.length); u16(0); u16(0); u16(0); u16(0); u32(0); u32(c.header);
		out.set(e.name, offset); offset += e.name.length;
	});
	var cdSize = offset - cdStart;
	u32(0x06054b50); u16(0); u16(0); u16(entries.length); u16(entries.length);
	u32(cdSize); u32(cdStart); u16(0);
	return out.subarray(0, offset);
};

TB.formatBytes = function (n) {
	if (n < 1024) return n + " B";
	if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
	return (n / 1024 / 1024).toFixed(2) + " MB";
};
})();

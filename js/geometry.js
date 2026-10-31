(function () {
"use strict";
/**
 * 参数化建筑几何：逐条移植 Godot 插件
 *   editor/building_architecture.gd
 *   editor/building_architecture_v3.gd
 *   editor/building_architecture_v4.gd
 *   editor/building_architecture_v5.gd
 *   editor/building_roofs.gd / building_roofs_v5.gd
 *   editor/building_components.gd / building_mesh.gd
 *
 * 坐标系：+Y 向上，Y=0 是台基底面，+Z 是正立面（入口朝向）。
 * 所有面以三角面片写入“角色桶”，每个三角形携带 position / uv / 顶点染色 / 法线。
 */
var TB = globalThis.TB;
var V = TB.V;

// ---------------------------------------------------------------------------
// 网格构建器（对应 building_mesh.gd + v5 的 polygon/face）
// ---------------------------------------------------------------------------
function MeshBuilder() {
	this.buckets = {};
	this.xf = TB.xfIdentity();
	this.triangles = 0;
	this.features = {};
	// 地基占地（米，世界 XZ）：供 Godot 预制体计算碰撞层；不含门前台阶。
	this.footprintSize = null;
}
MeshBuilder.prototype.mark = function (key) {
	this.features[key] = (this.features[key] || 0) + 1;
};
MeshBuilder.prototype.setFootprint = function (w, d) {
	var fw = Number(w), fd = Number(d);
	if (isFinite(fw) && isFinite(fd) && fw > 0 && fd > 0) this.footprintSize = [fw, fd];
};
MeshBuilder.prototype.bucket = function (role) {
	var b = this.buckets[role];
	if (!b) {
		b = this.buckets[role] = { pos: [], uv: [], tint: [], nrm: [] };
	}
	return b;
};

/** v5.polygon：points/uvs 都在当前局部空间，统一乘 xf。 */
MeshBuilder.prototype.polygon = function (points, uvs, role, tint) {
	if (!points || points.length < 3) return;
	var n = V.cross(V.sub(points[1], points[0]), V.sub(points[2], points[0]));
	if (V.len2(n) < 1e-12) return;
	n = V.norm(n);
	var nb = TB.normalBasis(this.xf.b);
	var normal = V.norm(TB.applyDir(nb, n));
	if (!isFinite(normal[0])) normal = [0, 1, 0];
	tint = tint || [1, 1, 1];
	var bucket = this.bucket(role);
	for (var i = 1; i < points.length - 1; i++) {
		var order = [0, i + 1, i];
		for (var k = 0; k < 3; k++) {
			var index = order[k];
			var p = TB.xfPoint(this.xf, points[index]);
			var uv = uvs[index] || [0, 0];
			bucket.pos.push(p[0], p[1], p[2]);
			bucket.uv.push(uv[0], uv[1]);
			bucket.tint.push(tint[0], tint[1], tint[2]);
			bucket.nrm.push(normal[0], normal[1], normal[2]);
			this.triangles++;
		}
	}
};

/** v5.face：自动 UV（米/3.2），木构件沿长边取纹理方向。 */
MeshBuilder.prototype.face = function (points, role, tint) {
	if (!points || points.length < 3) return;
	var n = V.cross(V.sub(points[1], points[0]), V.sub(points[2], points[0]));
	if (V.len2(n) < 1e-12) return;
	n = V.norm(n);
	var u = V.norm(V.sub(points[1], points[0]));
	if (role === "wood" && V.len(V.sub(points[2], points[1])) > V.len(V.sub(points[1], points[0]))) {
		u = V.norm(V.sub(points[2], points[1]));
	}
	var v = V.norm(V.cross(n, u));
	u = V.norm(TB.applyDir(this.xf.b, u));
	v = V.norm(TB.applyDir(this.xf.b, v));
	var uvs = [];
	for (var i = 0; i < points.length; i++) {
		var q = TB.applyDir(this.xf.b, points[i]);
		uvs.push([V.dot(q, u) / 3.2, -V.dot(q, v) / 3.2]);
	}
	this.polygon(points, uvs, role, tint);
};

/** v5.roof_face：固定坡度方向的瓦片 UV，避免三角形接缝错位。 */
MeshBuilder.prototype.roofFace = function (points, axis, origin) {
	var across = [-axis[2], 0, axis[0]];
	var uvs = [];
	for (var i = 0; i < points.length; i++) {
		var q = V.sub(points[i], origin);
		uvs.push([V.dot(q, axis) / 1.6, V.dot(q, across) / 1.6]);
	}
	this.polygon(points, uvs, "roof");
};

/** building_mesh.box：六个面各两个方向（side 控制绕序）。 */
MeshBuilder.prototype.box = function (c, size, role, tint) {
	var h = V.mul(size, 0.5);
	for (var s = -1; s <= 1; s += 2) {
		var faces = [
			[[-h[0], -h[1], s * h[2]], [h[0], -h[1], s * h[2]], [h[0], h[1], s * h[2]], [-h[0], h[1], s * h[2]]],
			[[s * h[0], -h[1], h[2]], [s * h[0], -h[1], -h[2]], [s * h[0], h[1], -h[2]], [s * h[0], h[1], h[2]]],
			[[-h[0], s * h[1], h[2]], [h[0], s * h[1], h[2]], [h[0], s * h[1], -h[2]], [-h[0], s * h[1], -h[2]]]
		];
		for (var f = 0; f < 3; f++) {
			var verts = faces[f].map(function (p) { return V.add(p, c); });
			if (s < 0) verts.reverse();
			this.face(verts, role, tint);
		}
	}
};

/** building_mesh.beam：任意两点之间的方木。 */
MeshBuilder.prototype.beam = function (a, b, width, role, depth) {
	var delta = V.sub(b, a);
	if (V.len(delta) < 0.0001) return;
	var y = V.norm(delta);
	var ref = Math.abs(y[2]) < 0.9 ? TB.FORWARD : TB.RIGHT;
	var x = V.norm(V.cross(y, ref));
	var before = this.xf;
	this.xf = TB.xfMul(this.xf, TB.xf(TB.basis(x, y, V.cross(x, y)), V.mul(V.add(a, b), 0.5)));
	this.box([0, 0, 0], [width, V.len(delta), depth === undefined || depth < 0 ? width : depth], role);
	this.xf = before;
};

MeshBuilder.prototype.cylinder = function (c, radius, height, role, sides) {
	sides = sides || 8;
	var top = [], bottom = [];
	for (var i = 0; i < sides; i++) {
		var a = Math.PI * 2 * i / sides, z = Math.PI * 2 * (i + 1) / sides;
		var p = V.add(c, [Math.cos(a) * radius, -height * 0.5, Math.sin(a) * radius]);
		var q = V.add(c, [Math.cos(z) * radius, -height * 0.5, Math.sin(z) * radius]);
		this.face([p, V.lift(p, height), V.lift(q, height), q], role);
		bottom.push(p);
		top.unshift(V.lift(p, height));
	}
	this.face(top, role);
	this.face(bottom, role);
};

MeshBuilder.prototype.panelFrame = function (c, w, h, thickness, role) {
	for (var s = -1; s <= 1; s += 2) {
		this.box(V.add(c, [s * w * 0.5, 0, 0]), [thickness, h + thickness, thickness], role);
		this.box(V.add(c, [0, s * h * 0.5, 0]), [w, thickness, thickness], role);
	}
};

MeshBuilder.prototype.finish = function () {
	var roles = {};
	var min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
	for (var role in this.buckets) {
		var src = this.buckets[role];
		var pos = new Float32Array(src.pos);
		for (var i = 0; i < pos.length; i += 3) {
			for (var k = 0; k < 3; k++) {
				if (pos[i + k] < min[k]) min[k] = pos[i + k];
				if (pos[i + k] > max[k]) max[k] = pos[i + k];
			}
		}
		roles[role] = {
			pos: pos,
			uv: new Float32Array(src.uv),
			tint: new Float32Array(src.tint),
			nrm: new Float32Array(src.nrm)
		};
	}
	if (min[0] === Infinity) return null;
	return {
		roles: roles,
		triangles: this.triangles,
		features: this.features,
		footprint: this.footprintSize ? [this.footprintSize[0], this.footprintSize[1]] : null,
		bounds: { min: min, max: max, size: V.sub(max, min), center: V.mul(V.add(min, max), 0.5) }
	};
};

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------
function P(S) { return S.params; }
function pt(x, y, z) { return [x, y, z]; }
function up(p, y) { return V.lift(p, y); }

/** 颜色变暗（Godot Color.darkened）→ 顶点染色。 */
function tintDark(amount) {
	var k = Math.max(0, 1 - amount);
	return [k, k, k];
}

function clampInt(v, lo, hi) { return TB.clampInt(Number(v), lo, hi); }
function clampf(v, lo, hi) { return TB.clamp(Number(v), lo, hi); }

// ---------------------------------------------------------------------------
// 构件（building_components.gd，只保留 v4/v5 用到的）
// ---------------------------------------------------------------------------
var Parts = {
	rail: function (S, a, b, h, style) {
		var bld = S.b;
		bld.mark("balustrade");
		bld.beam(up(a, h), up(b, h), 0.11, "wood");
		bld.beam(up(a, 0.16), up(b, 0.16), 0.10, "wood");
		var count = Math.max(2, Math.ceil(V.dist(a, b) / 0.40));
		for (var i = 0; i <= count; i++) {
			var p = V.lerp(a, b, i / count);
			bld.beam(p, up(p, h), i % 3 ? 0.055 : 0.10, "wood");
		}
		if (style === "jiangnan") {
			for (var j = 0; j < count; j += 2) {
				var q = up(V.lerp(a, b, j / count), 0.30);
				var r = up(V.lerp(a, b, Math.min(j + 2, count) / count), 0.64);
				bld.beam(q, r, 0.038, "trim");
			}
		}
	},
	lantern: function (S, c, style) {
		var bld = S.b;
		bld.mark("lantern");
		bld.beam(V.add(c, [0, 0.45, -0.28]), V.add(c, [0, 0.45, 0]), 0.06, "metal");
		bld.beam(V.add(c, [0, 0.45, 0]), V.add(c, [0, 0.24, 0]), 0.035, "metal");
		bld.cylinder(c, 0.17, 0.40, style === "jiangnan" ? "accent" : "glass", 8);
		[0.24, -0.24].forEach(function (y) { bld.cylinder(up(c, y), 0.20, 0.07, "wood", 8); });
		for (var i = 0; i < 4; i++) {
			var offset = [Math.cos(i * Math.PI / 2) * 0.16, 0, Math.sin(i * Math.PI / 2) * 0.16];
			bld.beam(V.add(c, V.lift(offset, -0.20)), V.add(c, V.lift(offset, 0.20)), 0.025, "trim");
		}
		if (style === "jiangnan") bld.beam(V.add(c, [0, -0.27, 0]), V.add(c, [0, -0.49, 0]), 0.035, "accent");
	},
	planter: function (S, c, w) {
		var bld = S.b;
		bld.box(c, [w, 0.21, 0.29], "wood");
		bld.box(up(c, 0.115), [w - 0.09, 0.035, 0.21], "shadow");
		var count = Math.max(2, Math.ceil(w / 0.16));
		for (var i = 0; i < count; i++) {
			var x = -w * 0.40 + i * 0.16;
			bld.box(V.add(c, [x, 0.21, 0]), [0.15, 0.16 + (i % 3) * 0.04, 0.19], "accent");
		}
	},
	signboard: function (S, c, w, style) {
		var bld = S.b;
		bld.mark("shop_sign");
		bld.box(c, [w, 0.42, 0.11], "wood");
		bld.panelFrame(V.add(c, [0, 0, 0.07]), w - 0.08, 0.33, 0.045, "trim");
		for (var i = 0; i < 3; i++) {
			var x = (i - 1) * w * 0.22;
			bld.box(V.add(c, [x, 0, 0.08]), [0.10, 0.19, 0.035], style === "desert" ? "accent" : "trim");
		}
	}
};

// ---------------------------------------------------------------------------
// 屋顶（building_roofs.gd 的曲线歇山点，供 v5 与 v4 共用）
// ---------------------------------------------------------------------------
function hipPoint(c, outer, inner, side, u, t, rise, lift) {
	var a = V.lerp(outer[side], outer[(side + 1) % 4], u);
	var z = V.lerp(inner[side], inner[(side + 1) % 4], u);
	var p = V.lerp(a, z, t);
	p = [p[0], rise * (0.6 * t + 0.4 * t * t) + lift * Math.pow(1 - t, 6) +
		lift * 0.4 * Math.pow(Math.abs(u * 2 - 1), 4) * (1 - t), p[2]];
	return V.add(c, p);
}

/** building_roofs.gd#hip（密集瓦垄版，v4 原型建筑使用）。 */
function roofHip(S, c, w, d, rise, eave, detailed) {
	var bld = S.b;
	bld.mark("curved_hip_roof");
	var x = w * 0.5 + eave, z = d * 0.5 + eave;
	var outer = [pt(-x, 0, z), pt(x, 0, z), pt(x, 0, -z), pt(-x, 0, -z)];
	var ridge = Math.max(0.25, x - z * 0.65);
	var inner = [pt(-ridge, 0, 0), pt(ridge, 0, 0), pt(ridge, 0, 0), pt(-ridge, 0, 0)];
	var lift = Math.min(0.25, rise * 0.16);
	for (var side = 0; side < 4; side++) {
		var columns = clampInt(Math.ceil(V.dist(outer[side], outer[(side + 1) % 4]) / 0.3), 2, 42);
		var rows = clampInt(Math.ceil(Math.sqrt(z * z + rise * rise) / 0.4), 3, 20);
		for (var row = 0; row < rows; row++) {
			for (var col = 0; col < columns; col++) {
				var a = hipPoint(c, outer, inner, side, col / columns, row / rows, rise, lift);
				var q = hipPoint(c, outer, inner, side, (col + 1) / columns, row / rows, rise, lift);
				var r = hipPoint(c, outer, inner, side, (col + 1) / columns, (row + 1) / rows, rise, lift);
				var s = hipPoint(c, outer, inner, side, col / columns, (row + 1) / rows, rise, lift);
				var k = 1 - ((col * 7 + row * 13 + side) % 7) * 0.018;
				bld.face([a, q, r, s], "roof", [k, k, k]);
				if (detailed) {
					var k2 = Math.max(0, k - 0.13);
					bld.face([up(a, -0.05), up(q, -0.05), q, a], "roof", [k2, k2, k2]);
					if (col % 2 === 0 && row < rows - 1) bld.beam(up(a, 0.027), up(s, 0.027), 0.04, "roof", 0.035);
				}
			}
		}
		for (var col2 = 0; col2 < columns; col2++) {
			var p0 = hipPoint(c, outer, inner, side, col2 / columns, 0, rise, lift);
			var p1 = hipPoint(c, outer, inner, side, (col2 + 1) / columns, 0, rise, lift);
			bld.beam(up(p0, -0.10), up(p1, -0.10), 0.14, "wood");
		}
		for (var row2 = 0; row2 < rows; row2++) {
			bld.beam(up(hipPoint(c, outer, inner, side, 0, row2 / rows, rise, lift), 0.08),
				up(hipPoint(c, outer, inner, side, 0, (row2 + 1) / rows, rise, lift), 0.08), 0.16, "roof");
		}
		var underside = [
			up(V.add(c, outer[(side + 1) % 4]), -0.03),
			up(V.add(c, outer[side]), -0.03),
			up(V.add(c, inner[side]), rise - 0.08),
			up(V.add(c, inner[(side + 1) % 4]), rise - 0.08)
		];
		bld.face(underside, "wood");
	}
	bld.beam(pt(c[0] - ridge - 0.12, c[1] + rise + 0.08, c[2]), pt(c[0] + ridge + 0.12, c[1] + rise + 0.08, c[2]), 0.22, "roof");
	[-1, 1].forEach(function (sign) {
		var end = pt(c[0] + sign * (ridge + 0.05), c[1] + rise + 0.15, c[2]);
		bld.beam(end, V.add(end, [sign * 0.25, 0.22, 0]), 0.15, "roof");
		bld.box(V.add(end, [sign * 0.2, 0.26, 0]), [0.14, 0.15, 0.2], "trim");
	});
}

/** building_roofs.gd#gable（密集瓦垄版）。 */
function roofGable(S, c, w, d, rise, eave, detailed) {
	var bld = S.b;
	bld.mark("layered_gable_roof");
	var x = w * 0.5 + eave, z = d * 0.5 + eave;
	[-1, 1].forEach(function (side) {
		var rows = clampInt(Math.ceil(Math.sqrt(x * x + rise * rise) / 0.42), 2, 24);
		var columns = clampInt(Math.ceil(z * 2 / 0.38), 2, 40);
		for (var row = 0; row < rows; row++) {
			var t0 = row / rows, t1 = (row + 1) / rows;
			for (var col = 0; col < columns; col++) {
				var z0 = -z + 2 * z * col / columns, z1 = -z + 2 * z * (col + 1) / columns;
				var a = V.add(c, [side * x * t0, rise * (1 - t0), z0]);
				var q = V.add(c, [side * x * t1, rise * (1 - t1), z0]);
				var r = V.add(c, [side * x * t1, rise * (1 - t1), z1]);
				var s = V.add(c, [side * x * t0, rise * (1 - t0), z1]);
				var pts = [a, q, r, s];
				if (side > 0) pts.reverse();
				var k = 1 - ((row * 11 + col * 3) % 6) * 0.023;
				bld.face(pts, "roof", [k, k, k]);
				if (detailed) {
					var k2 = Math.max(0, k - 0.2);
					bld.face(side < 0 ? [up(q, -0.055), up(r, -0.055), r, q] : [up(r, -0.055), up(q, -0.055), q, r], "roof", [k2, k2, k2]);
				}
			}
		}
		bld.beam(V.add(c, [side * x, -0.04, -z]), V.add(c, [side * x, -0.04, z]), 0.18, "wood");
		[-1, 1].forEach(function (front) {
			bld.beam(V.add(c, [0, rise, front * z]), V.add(c, [side * x, -0.06, front * z]), 0.20, "wood");
			bld.beam(V.add(c, [0, rise + 0.05, front * (z + 0.01)]), V.add(c, [side * x, 0, front * (z + 0.01)]), 0.055, "trim");
		});
		bld.face(side < 0
			? [V.add(c, [0, rise - 0.09, z]), V.add(c, [side * x, -0.09, z]), V.add(c, [side * x, -0.09, -z]), V.add(c, [0, rise - 0.09, -z])]
			: [V.add(c, [0, rise - 0.09, -z]), V.add(c, [side * x, -0.09, -z]), V.add(c, [side * x, -0.09, z]), V.add(c, [0, rise - 0.09, z])], "wood");
	});
	[-1, 1].forEach(function (front) {
		var pts = [
			V.add(c, [-w * 0.5, 0, front * d * 0.5]),
			V.add(c, [w * 0.5, 0, front * d * 0.5]),
			V.add(c, [0, rise, front * d * 0.5])
		];
		if (front < 0) pts.reverse();
		bld.face(pts, "wall");
		bld.beam(V.add(c, [-w * 0.5, 0.03, front * (d * 0.5 + 0.03)]), V.add(c, [w * 0.5, 0.03, front * (d * 0.5 + 0.03)]), 0.18, "wood");
		bld.beam(V.add(c, [0, 0, front * (d * 0.5 + 0.04)]), V.add(c, [0, rise - 0.1, front * (d * 0.5 + 0.04)]), 0.16, "wood");
		[-1, 1].forEach(function (side) {
			bld.beam(V.add(c, [0, 0.08, front * (d * 0.5 + 0.05)]), V.add(c, [side * w * 0.26, rise * 0.44, front * (d * 0.5 + 0.05)]), 0.10, "wood");
		});
	});
	bld.beam(V.add(c, [0, rise + 0.08, -z - 0.04]), V.add(c, [0, rise + 0.08, z + 0.04]), 0.22, "roof");
}

/** building_roofs.gd#terrace（密集版）。 */
function roofTerrace(S, c, w, d, eave) {
	var bld = S.b;
	bld.mark("parapet_terrace");
	bld.box(up(c, 0.10), [w + eave * 2, 0.2, d + eave * 2], "roof");
	[-1, 1].forEach(function (s) {
		bld.box(V.add(c, [s * w * 0.5, 0.42, 0]), [0.22, 0.64, d + 0.18], "wall");
		bld.box(V.add(c, [0, 0.42, s * d * 0.5]), [w, 0.64, 0.22], "wall");
		bld.box(V.add(c, [s * w * 0.5, 0.76, 0]), [0.34, 0.12, d + 0.35], "trim");
		bld.box(V.add(c, [0, 0.76, s * d * 0.5]), [w + 0.32, 0.12, 0.34], "trim");
		[-1, 1].forEach(function (x) {
			bld.box(V.add(c, [x * w * 0.5, 0.78, s * d * 0.5]), [0.43, 0.30, 0.43], "stone");
		});
	});
}

// ---------------------------------------------------------------------------
// v5 屋顶（building_roofs_v5.gd）：形状带 + 简化瓦面
// ---------------------------------------------------------------------------
var Roof5 = {
	hip: function (S, c, w, d, rise, eave) {
		var bld = S.b;
		bld.mark("curved_hip_roof");
		var x = w / 2 + eave, z = d / 2 + eave;
		var ridge = Math.max(0.3, x - z * 0.60);
		var outer = [pt(-x, 0, z), pt(x, 0, z), pt(x, 0, -z), pt(-x, 0, -z)];
		var inner = [pt(-ridge, 0, 0), pt(ridge, 0, 0), pt(ridge, 0, 0), pt(-ridge, 0, 0)];
		var lift = Math.min(0.28, rise * 0.18);
		for (var side = 0; side < 4; side++) {
			var axis = V.norm(V.sub(outer[(side + 1) % 4], outer[side]));
			for (var row = 0; row < 5; row++) {
				for (var col = 0; col < 6; col++) {
					var a = hipPoint(c, outer, inner, side, col / 6, row / 5, rise, lift);
					var q = hipPoint(c, outer, inner, side, (col + 1) / 6, row / 5, rise, lift);
					var r = hipPoint(c, outer, inner, side, (col + 1) / 6, (row + 1) / 5, rise, lift);
					var s = hipPoint(c, outer, inner, side, col / 6, (row + 1) / 5, rise, lift);
					bld.roofFace([a, q, r, s], axis, c);
				}
			}
			for (var col2 = 0; col2 < 6; col2++) {
				var p0 = hipPoint(c, outer, inner, side, col2 / 6, 0, rise, lift);
				var p1 = hipPoint(c, outer, inner, side, (col2 + 1) / 6, 0, rise, lift);
				bld.beam(up(p0, -0.13), up(p1, -0.13), 0.18, "wood");
			}
			for (var row2 = 0; row2 < 5; row2++) {
				bld.beam(up(hipPoint(c, outer, inner, side, 0, row2 / 5, rise, lift), 0.06),
					up(hipPoint(c, outer, inner, side, 0, (row2 + 1) / 5, rise, lift), 0.06), 0.17, "roof");
			}
			bld.face([
				up(V.add(c, outer[(side + 1) % 4]), -0.03),
				up(V.add(c, outer[side]), -0.03),
				up(V.add(c, inner[side]), rise - 0.1),
				up(V.add(c, inner[(side + 1) % 4]), rise - 0.1)
			], "wood");
		}
		bld.beam(pt(c[0] - ridge - 0.14, c[1] + rise + 0.07, c[2]), pt(c[0] + ridge + 0.14, c[1] + rise + 0.07, c[2]), 0.22, "roof");
		[-1, 1].forEach(function (s) {
			bld.beam(pt(c[0] + s * ridge, c[1] + rise + 0.08, c[2]), pt(c[0] + s * (ridge + 0.38), c[1] + rise + 0.34, c[2]), 0.16, "roof");
		});
	},
	gable: function (S, c, w, d, rise, eave) {
		var bld = S.b;
		bld.mark("layered_gable_roof");
		var x = w / 2 + eave, z = d / 2 + eave;
		[-1, 1].forEach(function (s) {
			var points = [
				V.add(c, [0, rise, -z]),
				V.add(c, [s * x, 0, -z]),
				V.add(c, [s * x, 0, z]),
				V.add(c, [0, rise, z])
			];
			if (s > 0) points.reverse();
			bld.roofFace(points, s < 0 ? TB.BACK : TB.FORWARD, c);
			bld.beam(V.add(c, [s * x, -0.08, -z]), V.add(c, [s * x, -0.08, z]), 0.19, "wood");
			[-1, 1].forEach(function (front) {
				bld.beam(V.add(c, [0, rise, front * z]), V.add(c, [s * x, -0.06, front * z]), 0.20, "wood");
			});
			var underside = points.slice().reverse().map(function (p) { return up(p, -0.10); });
			bld.face(underside, "wood");
		});
		[-1, 1].forEach(function (front) {
			var points = [
				V.add(c, [-w / 2, 0, front * d / 2]),
				V.add(c, [w / 2, 0, front * d / 2]),
				V.add(c, [0, rise, front * d / 2])
			];
			if (front < 0) points.reverse();
			bld.face(points, "wall");
			bld.beam(V.add(c, [-w / 2, 0.05, front * (d / 2 + 0.04)]), V.add(c, [w / 2, 0.05, front * (d / 2 + 0.04)]), 0.17, "wood");
			[-1, 1].forEach(function (s) {
				bld.beam(V.add(c, [0, 0.1, front * (d / 2 + 0.04)]), V.add(c, [s * w * 0.24, rise * 0.48, front * (d / 2 + 0.04)]), 0.12, "wood");
			});
		});
		bld.beam(V.add(c, [0, rise + 0.07, -z]), V.add(c, [0, rise + 0.07, z]), 0.18, "roof");
	},
	terrace: function (S, c, w, d, eave) {
		var bld = S.b;
		bld.mark("parapet_terrace");
		bld.box(up(c, 0.10), [w + eave * 2, 0.2, d + eave * 2], "wall");
		[-1, 1].forEach(function (s) {
			bld.box(V.add(c, [s * w * 0.5, 0.42, 0]), [0.22, 0.64, d + 0.18], "wall");
			bld.box(V.add(c, [0, 0.42, s * d * 0.5]), [w, 0.64, 0.22], "wall");
			bld.box(V.add(c, [s * w * 0.5, 0.76, 0]), [0.34, 0.12, d + 0.35], "stone");
			bld.box(V.add(c, [0, 0.76, s * d * 0.5]), [w + 0.32, 0.12, 0.34], "stone");
		});
	}
};

// ---------------------------------------------------------------------------
// 台基 / 楼层 / 立面（v5）
// ---------------------------------------------------------------------------
function foundation(S, w, d, height) {
	var bld = S.b, style = S.style;
	bld.box(pt(0, height * 0.5, 0), pt(w + 0.24, height, d + 0.24), "stone");
	bld.box(pt(0, height - 0.035, 0), pt(w + 0.37, 0.09, d + 0.37), style === "desert" ? "trim" : "stone");
	for (var i = 0; i < 3; i++) {
		var center = pt(0, height * (i + 1) / 6, d * 0.5 + 0.76 - i * 0.22);
		var size = pt(1.65, height * (i + 1) / 3, 0.29);
		bld.box(center, size, "stone");
	}
	bld.setFootprint(w + 0.24, d + 0.24);
}

function panel(S, c, w, h, role, tileX) {
	var bld = S.b;
	var repeat = tileX ? w / 3.2 : 1.0;
	bld.polygon([
		V.add(c, [-w / 2, -h / 2, 0]),
		V.add(c, [w / 2, -h / 2, 0]),
		V.add(c, [w / 2, h / 2, 0]),
		V.add(c, [-w / 2, h / 2, 0])
	], [[0, 1], [repeat, 1], [repeat, 0], [0, 0]], role);
}

function window5(S, c, w, h) {
	var bld = S.b, style = S.style;
	bld.mark("layered_window");
	bld.box(c, pt(w + 0.12, h + 0.15, 0.09), style !== "desert" ? "wood" : "stone");
	panel(S, V.add(c, [0, 0, 0.053]), w, h, "window");
	bld.box(V.add(c, [0, -h / 2 - 0.07, 0.10]), pt(w + 0.20, 0.12, 0.28), style === "desert" ? "stone" : "wood");
	if (style === "forest") {
		[-1, 1].forEach(function (s) {
			panel(S, V.add(c, [s * (w / 2 + 0.14), 0, 0.05]), 0.24, h, "shutter");
		});
	}
	if (TB.isV6Style(style)) window6(S, c, w, h);
}

function doorway(S) {
	var bld = S.b, style = S.style;
	bld.mark("framed_door");
	bld.box(pt(0, 1.08, 0.075), pt(1.48, 2.16, 0.16), style === "desert" ? "stone" : "wood");
	panel(S, pt(0, 1.07, 0.165), 1.30, 2.08, "door");
	if (style === "desert") {
		for (var i = 0; i < 8; i++) {
			var a = Math.PI * i / 8, b = Math.PI * (i + 1) / 8;
			bld.beam(pt(Math.cos(a) * 0.8, 1.65 + Math.sin(a) * 0.70, 0.18),
				pt(Math.cos(b) * 0.8, 1.65 + Math.sin(b) * 0.70, 0.18), 0.16, "stone");
		}
	}
	if (TB.isV6Style(style)) doorway6(S);
}

function facade5(S, w, h, floorIndex, columns, front, kind) {
	var bld = S.b, style = S.style;
	var entrance = front && floorIndex === 0;
	var band = style !== "desert" ? "wood" : "stone";
	if (entrance) doorway(S);
	panel(S, pt(0, 0.32, 0.012), w, 0.64, "wall_base", true);
	[0.07, h - 0.14].forEach(function (y) {
		bld.box(pt(0, y, 0.045), pt(w + 0.08, 0.14, 0.13), band);
	});
	var intervals = [];
	if (entrance) {
		intervals = [
			{ left: -w / 2 + 0.12, right: -0.88, count: Math.ceil(columns / 2) },
			{ left: 0.88, right: w / 2 - 0.12, count: Math.floor(columns / 2) }
		];
	} else {
		intervals = [{ left: -w / 2 + 0.15, right: w / 2 - 0.15, count: columns }];
	}
	intervals.forEach(function (interval) {
		if (!interval.count) return;
		var span = (interval.right - interval.left) / interval.count;
		for (var i = 0; i < interval.count; i++) {
			var x = interval.left + (i + 0.5) * span;
			var ww = Math.min(1.15, span * (style === "forest" ? 0.59 : 0.72));
			window5(S, pt(x, h * 0.55, 0.035), Math.max(0.16, ww), 1.08);
		}
	});
	[-1, 1].forEach(function (s) {
		bld.box(pt(s * w / 2, h / 2, 0.04), pt(0.16, h, 0.13), band);
		if (style === "jiangnan") {
			bld.box(pt(s * (w / 2 - 0.13), h - 0.32, 0.1), pt(0.44, 0.15, 0.26), "wood");
		} else if (style === "forest") {
			bld.beam(pt(s * w / 2, h - 0.8, 0.06), pt(s * (w / 2 - 0.65), h - 0.15, 0.06), 0.14, "wood");
		}
	});
	if (kind === 1 && entrance) {
		panel(S, pt(w * 0.28, h - 0.5, 0.19), Math.min(1.4, w * 0.24), 0.50, "sign");
	}
	if (TB.isV6Style(style)) facade6(S, w, h, floorIndex);
}

function storey(S, c, w, d, h, floorIndex, columns, kind) {
	var bld = S.b;
	bld.box(V.add(c, [0, h * 0.5, 0]), pt(w, h, d), "wall");
	var original = bld.xf;
	for (var side = 0; side < 4; side++) {
		var angle = side * Math.PI * 0.5;
		var basis = TB.basisRotY(angle);
		var span = side % 2 === 0 ? w : d;
		var distance = side % 2 === 0 ? d * 0.5 : w * 0.5;
		bld.xf = TB.xfMul(original, TB.xf(basis, V.add(c, TB.applyDir(basis, [0, 0, distance]))));
		facade5(S, span, h, floorIndex, columns, side === 0, kind);
	}
	bld.xf = original;
}

function roofAt5(S, c, w, d) {
	var p = P(S), style = S.style;
	if (TB.isV6Style(style)) { roofAt6(S, c, w, d); return; }
	var rise = Math.tan(TB.deg(clampf(p.pitch || 32, 15, 50))) * (style === "forest" ? w : d) * 0.5;
	var eave = Number(p.eave || 0.5);
	var choice = Number(p.roof || 0);
	if (choice === 2 || (choice === 0 && style === "desert")) Roof5.terrace(S, c, w, d, eave);
	else if (style === "jiangnan" && choice === 0) Roof5.hip(S, c, w, d, rise, eave);
	else Roof5.gable(S, c, w, d, rise, eave);
}

// ---------------------------------------------------------------------------
// v6 方言（editor/building_architecture_v6.gd）
// 六种方言沿用 v5 的功能骨架，只在屋顶、窗、立面、门、外廊上分支。
// ---------------------------------------------------------------------------
var V6_VERANDA = { machiya: 1, palace: 1, harbor: 1 };

function roofAt6(S, c, w, d) {
	var bld = S.b, p = P(S), style = S.style;
	var eave = Number(p.eave === undefined ? 0.6 : p.eave);
	var pitch = Number(p.pitch === undefined ? 35 : p.pitch);
	var rise = Math.tan(TB.deg(pitch)) * w * 0.5;
	var choice = Number(p.roof || 0);
	if (choice === 2) { Roof5.terrace(S, c, w, d, eave); return; }
	if (choice === 1) { Roof5.gable(S, c, w, d, rise, eave); return; }
	switch (style) {
		case "machiya": {
			// 十字脊：屋面沿进深方向再铺一遍，形成正交两道屋脊
			bld.mark("machiya_cross_ridge");
			var before = bld.xf;
			bld.xf = TB.xfMul(bld.xf, TB.xf(TB.basisRotY(Math.PI / 2), c));
			Roof5.gable(S, pt(0, 0, 0), d, w, Math.tan(TB.deg(pitch)) * d * 0.5, eave);
			bld.xf = before;
			[-1, 1].forEach(function (s) {
				bld.beam(V.add(c, [s * w / 2, -0.18, -d / 2 - eave]),
					V.add(c, [s * w / 2, -0.18, d / 2 + eave]), 0.18, "wood");
			});
			break;
		}
		case "nordic": {
			// 覆雪陡坡：雪面跟着瓦面坡度铺，檐口留一道瓦
			bld.mark("snow_capped_gable");
			Roof5.gable(S, c, w, d, rise, eave);
			[-1, 1].forEach(function (s) {
				var x = (w / 2 + eave) * 0.93, z = d / 2 + eave - 0.05;
				var points = [
					V.add(c, [0, rise + 0.05, -z]),
					V.add(c, [s * x, rise * 0.07 + 0.05, -z]),
					V.add(c, [s * x, rise * 0.07 + 0.05, z]),
					V.add(c, [0, rise + 0.05, z])
				];
				if (s > 0) points.reverse();
				bld.face(points, "snow");
			});
			if (w > 3) chimney(S, w, d, c[1], rise);
			break;
		}
		case "harbor": {
			// 缓坡四坡顶 + 屋面通风帽
			bld.mark("harbor_hip_and_vent");
			var hipRise = Math.min(rise, 2.3);
			Roof5.hip(S, c, w, d, hipRise, eave);
			var vent = V.add(c, [0, hipRise + 0.15, 0]);
			bld.box(V.add(vent, [0, 0.22, 0]), pt(1.0, 0.44, 0.65), "wood");
			Roof5.gable(S, V.add(vent, [0, 0.44, 0]), 1.2, 0.9, 0.38, 0.10);
			break;
		}
		case "palace": {
			// 重檐：下层大歇山 + 上层小歇山，檐下一圈重彩斗拱
			bld.mark("palace_double_eaves");
			var lower = Math.tan(TB.deg(pitch)) * d * 0.38;
			Roof5.hip(S, c, w, d, lower, eave);
			var upper = V.add(c, [0, lower + 0.28, 0]);
			bld.box(upper, pt(w * 0.5, 0.45, d * 0.48), "accent");
			Roof5.hip(S, V.add(upper, [0, 0.24, 0]), w * 0.58, d * 0.54, 0.7, eave * 0.4);
			[-1, 1].forEach(function (s) {
				for (var i = 0; i < 3; i++) {
					bld.box(V.add(c, [s * w * 0.42, -0.18 - i * 0.13, d * 0.35]),
						pt(0.38 + i * 0.18, 0.12, 0.5 - i * 0.08), "trim");
				}
			});
			break;
		}
		case "gothic": {
			// 陡坡双坡顶 + 两山尖塔
			bld.mark("gothic_pinnacles");
			Roof5.gable(S, c, w, d, rise, eave);
			[-1, 1].forEach(function (s) {
				var point = V.add(c, [0, rise, s * (d / 2 + eave)]);
				bld.cylinder(V.add(point, [0, 0.32, 0]), 0.10, 0.64, "metal", 6);
				bld.beam(V.add(point, [-0.17, 0.42, 0]), V.add(point, [0.17, 0.42, 0]), 0.055, "metal");
			});
			break;
		}
		case "steamworks": {
			// 锯齿采光顶：三跨斜屋面 + 竖直玻璃天窗 + 山墙封边
			bld.mark("industrial_sawtooth");
			var span = (w + 2 * eave) / 3;
			var h = Math.max(0.7, Math.tan(TB.deg(pitch)) * span);
			for (var i = 0; i < 3; i++) {
				var x = -w / 2 - eave + i * span;
				bld.roofFace([
					V.add(c, [x, h, d / 2 + eave]),
					V.add(c, [x + span, 0, d / 2 + eave]),
					V.add(c, [x + span, 0, -d / 2 - eave]),
					V.add(c, [x, h, -d / 2 - eave])
				], TB.BACK, c);
				bld.box(V.add(c, [x, h / 2, 0]), pt(0.05, h, d + 2 * eave), "glass");
				[-1, 1].forEach(function (s) {
					var points = [
						V.add(c, [x, 0, s * (d / 2 + eave)]),
						V.add(c, [x + span, 0, s * (d / 2 + eave)]),
						V.add(c, [x, h, s * (d / 2 + eave)])
					];
					if (s < 0) points.reverse();
					bld.face(points, "wall");
					bld.beam(points[2], points[1], 0.13, "metal");
				});
			}
			break;
		}
		default:
			Roof5.gable(S, c, w, d, rise, eave);
			break;
	}
}

/** v6 窗饰：木格、百叶、窗楣、尖券、金属框 */
function window6(S, c, w, h) {
	var bld = S.b, style = S.style;
	switch (style) {
		case "machiya":
			bld.mark("machiya_lattice");
			for (var i = 0; i < 4; i++) {
				bld.box(V.add(c, [(i - 1.5) * w / 4, 0, 0.12]), pt(0.035, h, 0.045), "wood");
			}
			break;
		case "nordic":
		case "harbor":
			bld.mark("louvered_shutters");
			[-1, 1].forEach(function (s) {
				panel(S, V.add(c, [s * (w / 2 + 0.14), 0, 0.075]), 0.23, h, "shutter");
				if (style === "harbor") {
					for (var j = 0; j < 4; j++) {
						bld.box(V.add(c, [s * (w / 2 + 0.14), -h * 0.34 + j * h * 0.22, 0.11]),
							pt(0.23, 0.055, 0.07), "trim");
					}
				}
			});
			break;
		case "palace":
			bld.mark("palace_window_canopy");
			bld.box(V.add(c, [0, h / 2 + 0.17, 0.09]), pt(w + 0.32, 0.16, 0.24), "trim");
			[-1, 1].forEach(function (s) {
				bld.box(V.add(c, [s * (w / 2 + 0.1), 0, 0.10]), pt(0.12, h + 0.2, 0.1), "accent");
			});
			break;
		case "gothic":
			bld.mark("pointed_window_arch");
			[-1, 1].forEach(function (s) {
				bld.beam(V.add(c, [s * (w / 2 + 0.09), h / 2 - 0.18, 0.13]),
					V.add(c, [0, h / 2 + 0.24, 0.13]), 0.11, "stone");
			});
			bld.box(V.add(c, [0, 0, 0.12]), pt(0.055, h, 0.06), "stone");
			break;
		case "steamworks":
			bld.mark("industrial_window_frame");
			bld.panelFrame(V.add(c, [0, 0, 0.10]), w + 0.10, h + 0.08, 0.08, "metal");
			[-1, 1].forEach(function (s) {
				bld.box(V.add(c, [s * w * 0.22, 0, 0.12]), pt(0.045, h, 0.06), "metal");
			});
			break;
		default:
			break;
	}
}

/** v6 立面附加：二层挑檐、壁柱、扶壁、金属框架 */
function facade6(S, w, h, floorIndex) {
	var bld = S.b, style = S.style;
	switch (style) {
		case "machiya":
			if (floorIndex > 0) bld.box(pt(0, 0.06, 0.30), pt(w + 0.14, 0.12, 0.65), "roof");
			break;
		case "palace":
			[-1, 1].forEach(function (s) {
				bld.box(pt(s * (w / 2 - 0.18), h / 2, 0.16), pt(0.23, h, 0.23), "wood");
				for (var i = 0; i < 3; i++) {
					bld.box(pt(s * (w / 2 - 0.18), h - 0.36 + i * 0.12, 0.18),
						pt(0.28 + i * 0.15, 0.10, 0.28 + i * 0.07), "trim");
				}
			});
			break;
		case "gothic":
			[-1, 1].forEach(function (s) {
				bld.box(pt(s * (w / 2 - 0.12), h / 2, 0.20), pt(0.23, h, 0.32), "stone");
			});
			break;
		case "steamworks":
			[-1, 1].forEach(function (s) {
				bld.beam(pt(s * (w / 2 - 0.22), 0.1, 0.17), pt(s * (w / 2 - 0.22), h - 0.1, 0.17), 0.14, "metal");
			});
			bld.box(pt(0, h - 0.35, 0.16), pt(w, 0.10, 0.16), "trim");
			break;
		default:
			break;
	}
}

/** v6 门饰：尖券石门套、暖帘、金属门框 */
function doorway6(S) {
	var bld = S.b, style = S.style;
	if (style === "gothic") {
		[-1, 1].forEach(function (s) {
			bld.beam(pt(s * 0.78, 1.78, 0.22), pt(0, 2.52, 0.22), 0.16, "stone");
		});
	} else if (style === "machiya") {
		bld.mark("split_noren");
		[-1, 1].forEach(function (s) {
			panel(S, pt(s * 0.34, 1.98, 0.26), 0.64, 0.55, "cloth");
		});
	} else if (style === "steamworks") {
		bld.panelFrame(pt(0, 1.10, 0.23), 1.5, 2.2, 0.12, "metal");
	}
}

/** v6 缘侧外廊（町屋 / 宫阙 / 海港），海港无二层时用布棚 */
function porch6(S, w, d, base, balcony) {
	var bld = S.b, style = S.style;
	bld.mark("style_veranda");
	var pw = w * 0.87, top = base + 2.55, front = d / 2 + 1.12;
	[-1, 1].forEach(function (s) { post(S, pt(s * pw / 2, base, front), 2.55); });
	bld.beam(pt(-pw / 2, top, front), pt(pw / 2, top, front), 0.20, "wood");
	if (balcony) {
		bld.box(pt(0, base + 2.78, d / 2 + 0.58), pt(pw + 0.25, 0.16, 1.3), "wood");
		Parts.rail(S, pt(-pw / 2, base + 2.9, front), pt(pw / 2, base + 2.9, front), 0.72, style);
	} else if (style === "harbor") {
		bld.polygon([
			pt(-pw / 2, top, d / 2),
			pt(-pw / 2, top - 0.32, front + 0.12),
			pt(pw / 2, top - 0.32, front + 0.12),
			pt(pw / 2, top, d / 2)
		], [[0, 0], [0, 1], [pw / 2, 1], [pw / 2, 0]], "cloth");
	} else {
		Roof5.hip(S, pt(0, top, d / 2 + 0.48), pw, 1.25, 0.38, 0.22);
	}
}

/** 蒸汽工业：锅炉房烟囱 + 外部管道 */
function boilerStack(S, isHouse) {
	if (!isHouse) return;
	var bld = S.b, p = P(S);
	bld.mark("boiler_stack");
	var w = clampf(p.width, 3, 10) * (S.profile.kind === 2 ? 1.12 : 1.0);
	var d = clampf(p.depth, 3, 10) * (S.profile.kind === 2 ? 1.08 : 1.0);
	var top = 0.36 + clampInt(p.floors === undefined ? 1 : p.floors, 1, 3) * 2.8;
	bld.cylinder(pt(w * 0.31, top + 0.85, -d * 0.25), 0.32, 2.2, "stone", 10);
	[top + 0.2, top + 1.65].forEach(function (y) {
		bld.cylinder(pt(w * 0.31, y, -d * 0.25), 0.39, 0.18, "metal", 10);
	});
	bld.beam(pt(-w * 0.34, 1.1, -d / 2 - 0.15), pt(-w * 0.34, top + 0.4, -d / 2 - 0.15), 0.15, "trim");
}

function porch5(S, w, d, base, balcony, kind, flat) {
	if (V6_VERANDA[S.style]) { porch6(S, w, d, base, balcony); return; }
	var bld = S.b, style = S.style, p = P(S);
	bld.mark("supported_porch");
	var wide = S.entry.id === "inn" || S.entry.id === "general_store" || style === "jiangnan";
	var pw = wide ? w * 0.90 : Math.min(w * 0.8, 3.0);
	var depth = 1.15, top = base + 2.62;
	[-1, 1].forEach(function (s) {
		var c = pt(s * pw / 2, base, d / 2 + depth);
		post(S, c, 2.62);
		bld.beam(V.add(c, [0, 2.10, 0]), V.add(c, [-s * 0.50, 2.57, 0]), 0.12, "wood");
	});
	bld.beam(pt(-pw / 2, top, d / 2 + depth), pt(pw / 2, top, d / 2 + depth), 0.17, "wood");
	if (balcony) {
		bld.box(pt(0, base + 2.8, d / 2 + depth / 2), pt(pw + 0.20, 0.14, depth + 0.2), "wood");
		Parts.rail(S, pt(-pw / 2, base + 2.94, d / 2 + depth), pt(pw / 2, base + 2.94, d / 2 + depth), 0.72, style);
		[-1, 1].forEach(function (s) {
			Parts.rail(S, pt(s * pw / 2, base + 2.94, d / 2), pt(s * pw / 2, base + 2.94, d / 2 + depth), 0.72, style);
		});
	} else if (style === "desert" || S.entry.id === "general_store") {
		bld.polygon([
			pt(-pw / 2, top, d / 2),
			pt(-pw / 2, top - 0.22, d / 2 + depth + 0.25),
			pt(pw / 2, top - 0.22, d / 2 + depth + 0.25),
			pt(pw / 2, top, d / 2)
		], [[0, 0], [0, 1], [pw / 2, 1], [pw / 2, 0]], "cloth");
	} else if (style === "jiangnan") {
		Roof5.hip(S, pt(0, top, d / 2 + 0.45), pw, 1.20, 0.40, 0.22);
	} else {
		Roof5.gable(S, pt(0, top, d / 2 + 0.45), pw, 1.3, 0.75, 0.18);
	}
	if (S.ornate) {
		[-1, 1].forEach(function (s) {
			Parts.lantern(S, pt(s * (pw / 2 - 0.23), top - 0.45, d / 2 + depth), style);
		});
	}
}

/** base building_architecture.chimney */
function chimney(S, w, d, y, rise) {
	var bld = S.b;
	bld.mark("capped_chimney");
	var c = pt(-w * 0.28, y + rise * 0.48, -d * 0.25);
	bld.box(V.add(c, [0, 0.65, 0]), pt(0.65, 1.65, 0.69), "stone");
	bld.box(V.add(c, [0, 1.5, 0]), pt(0.84, 0.17, 0.86), "stone");
	bld.box(V.add(c, [0, 1.60, 0]), pt(0.45, 0.03, 0.46), "shadow");
	[-1, 1].forEach(function (s) { bld.box(V.add(c, [s * 0.28, 1.83, 0]), pt(0.12, 0.47, 0.55), "stone"); });
	bld.box(V.add(c, [0, 2.08, 0]), pt(0.93, 0.12, 0.88), "roof");
}

/** v4/v5 通用柱：木柱 + 石础 */
function post(S, c, h) {
	var bld = S.b;
	block(S, V.add(c, [0, h / 2, 0]), pt(0.16, h, 0.16), "wood");
	bld.box(V.add(c, [0, 0.1, 0]), pt(0.3, 0.2, 0.3), "stone");
}

function block(S, c, size, role) {
	S.b.box(c, size, role || "stone");
}

// ---------------------------------------------------------------------------
// v4 摆件
// ---------------------------------------------------------------------------
function table(S, c, w, d) {
	var bld = S.b;
	bld.box(V.add(c, [0, 0.8, 0]), pt(w, 0.12, d), "wood");
	[-1, 1].forEach(function (x) {
		[-1, 1].forEach(function (z) {
			bld.box(V.add(c, [x * (w / 2 - 0.12), 0.38, z * (d / 2 - 0.10)]), pt(0.1, 0.76, 0.1), "wood");
		});
	});
}

function crate(S, c, size) {
	size = size || 0.55;
	var bld = S.b;
	bld.box(V.add(c, [0, size / 2, 0]), pt(size, size, size), "wood");
	[0.12, size - 0.1].forEach(function (y) {
		bld.box(V.add(c, [0, y, size / 2 + 0.02]), pt(size, 0.07, 0.05), "trim");
	});
	bld.beam(V.add(c, [-size / 2, 0.05, size / 2 + 0.03]), V.add(c, [size / 2, size - 0.05, size / 2 + 0.03]), 0.055, "trim");
}

function barrel(S, c, r) {
	r = r || 0.28;
	var bld = S.b;
	bld.cylinder(V.add(c, [0, 0.38, 0]), r, 0.76, "wood", 10);
	[0.12, 0.62].forEach(function (y) { bld.cylinder(V.add(c, [0, y, 0]), r + 0.018, 0.07, "metal", 10); });
	bld.cylinder(V.add(c, [0, 0.77, 0]), r * 0.91, 0.03, "trim", 10);
}

function bottle(S, c, role) {
	var bld = S.b;
	role = role || "glass";
	bld.cylinder(V.add(c, [0, 0.15, 0]), 0.1, 0.30, role, 6);
	bld.cylinder(V.add(c, [0, 0.34, 0]), 0.042, 0.12, role, 6);
}

function sword(S, c) {
	var bld = S.b;
	bld.box(V.add(c, [0, 0.52, 0]), pt(0.09, 0.82, 0.035), "metal");
	bld.box(V.add(c, [0, 0.18, 0]), pt(0.35, 0.07, 0.07), "trim");
	bld.box(V.add(c, [0, 0.08, 0]), pt(0.07, 0.2, 0.06), "wood");
}

function shield(S, c) {
	var bld = S.b;
	bld.face([
		V.add(c, [-0.24, 0.55, 0]), V.add(c, [0.24, 0.55, 0]),
		V.add(c, [0.24, 0.18, 0]), V.add(c, [0, -0.05, 0]), V.add(c, [-0.24, 0.18, 0])
	], "accent");
	bld.box(V.add(c, [0, 0.29, 0.025]), pt(0.055, 0.47, 0.05), "metal");
	bld.box(V.add(c, [0, 0.40, 0.025]), pt(0.43, 0.06, 0.05), "metal");
}

function canopy(S, c, w, d, h) {
	var bld = S.b;
	[-1, 1].forEach(function (x) {
		[-1, 1].forEach(function (z) {
			post(S, V.add(c, [x * w / 2, 0, z * d / 2]), h);
		});
	});
	for (var i = 0; i < 8; i++) {
		var x0 = -w / 2 + w * i / 8, x1 = -w / 2 + w * (i + 1) / 8;
		bld.face([
			V.add(c, [x0, h, -d / 2]),
			V.add(c, [x0, h - 0.2, d / 2]),
			V.add(c, [x1, h - 0.2, d / 2]),
			V.add(c, [x1, h, -d / 2])
		], i % 2 === 0 ? "cloth" : "accent");
	}
}

function wheel(S, c, r) {
	var bld = S.b;
	for (var i = 0; i < 12; i++) {
		var a = Math.PI * 2 * i / 12, z = Math.PI * 2 * (i + 1) / 12;
		bld.beam(V.add(c, [Math.cos(a) * r, Math.sin(a) * r, 0]), V.add(c, [Math.cos(z) * r, Math.sin(z) * r, 0]), 0.11, "wood");
		if (i % 2 === 0) bld.beam(c, V.add(c, [Math.cos(a) * r, Math.sin(a) * r, 0]), 0.07, "trim");
	}
}

// ---------------------------------------------------------------------------
// 民居室内外识别物
// ---------------------------------------------------------------------------
function houseIdentity5(S, w, d) {
	var id = S.entry.id;
	if (id !== "house" && id !== "general_store" && id !== "inn") {
		houseIdentity4(S, w, d);
		return;
	}
	var bld = S.b, style = S.style;
	var f = d / 2 + 0.65, left = -w * 0.30, right = w * 0.30;
	if (id === "house") {
		if (style === "desert") barrel(S, pt(right, 0.36, f), 0.25);
		else Parts.planter(S, pt(right, 0.5, f), 1.0);
	} else if (id === "general_store") {
		bld.mark("open_shopfront");
		table(S, pt(left, 0.36, f), Math.min(2, w * 0.32), 0.75);
		for (var shelf = 0; shelf < 2; shelf++) {
			bld.box(pt(right, 0.8 + shelf * 0.7, d / 2 + 0.3), pt(1.4, 0.10, 0.65), "wood");
			for (var i = 0; i < 3; i++) crate(S, pt(right - 0.45 + i * 0.43, 0.86 + shelf * 0.70, d / 2 + 0.3), 0.32);
		}
		for (var j = 0; j < 3; j++) crate(S, pt(left - 0.45 + j * 0.45, 1.22, f), 0.32);
		panel(S, pt(left, 2.32, f + 0.2), 1.4, 0.6, "sign");
	} else {
		bld.mark("inn_entrance");
		panel(S, pt(left, 2.37, f + 0.6), 1.55, 0.7, "sign");
		if (style === "jiangnan") {
			[-1, 1].forEach(function (s) { post(S, pt(s * 1.03, 0.36, f + 0.65), 2.2); });
			Roof5.hip(S, pt(0, 2.75, f + 0.45), 2.5, 1.1, 0.5, 0.22);
		} else if (style === "forest") {
			barrel(S, pt(right, 0.36, f));
			table(S, pt(left, 0.36, f), 1.3, 0.6);
		} else {
			[-1, 1].forEach(function (s) { block(S, pt(s * 0.95, 1.1, f + 0.3), pt(0.24, 1.5, 0.28), "stone"); });
			for (var k = 0; k < 8; k++) {
				var a = Math.PI * k / 8, b = Math.PI * (k + 1) / 8;
				bld.beam(pt(Math.cos(a) * 0.96, 1.8 + Math.sin(a) * 0.85, f + 0.3),
					pt(Math.cos(b) * 0.96, 1.8 + Math.sin(b) * 0.85, f + 0.3), 0.2, "stone");
			}
		}
	}
}

/** v4 的类型专属识别物（27 种民居分支）。 */
function houseIdentity4(S, w, d) {
	var bld = S.b, style = S.style, id = S.entry.id;
	var f = d / 2 + 0.4, left = -w * 0.34, right = w * 0.34;
	switch (id) {
		case "house":
			Parts.planter(S, pt(right, 0.5, f), 0.8);
			break;
		case "farmhouse":
			canopy(S, pt(left, 0, f + 0.4), 1.7, 1.0, 2.1);
			for (var i0 = 0; i0 < 3; i0++) {
				bld.beam(pt(left - 0.45 + i0 * 0.30, 0.4, f), pt(left - 0.45 + i0 * 0.30, 1.8, f), 0.06, "wood");
			}
			crate(S, pt(right, 0.36, f), 0.65);
			break;
		case "villa": case "manor":
			[-1, 1].forEach(function (s) {
				block(S, pt(s * (w / 2 + 0.75), 1.5, 0), pt(1.5, 3, d * 0.65), "wall");
				roofAt4(S, pt(s * (w / 2 + 0.75), 3, 0), 1.5, d * 0.65);
				Parts.rail(S, pt(s * w / 2, 0.36, f + 1.8), pt(s * 0.8, 0.36, f + 1.8), 0.85, style);
			});
			if (id === "manor") {
				[-1, 1].forEach(function (s) { block(S, pt(s * 0.9, 1.2, f + 1.8), pt(0.35, 2.4, 0.35), "stone"); });
				roofAt4(S, pt(0, 2.4, f + 1.8), 2.6, 0.9);
			}
			break;
		case "general_store":
			table(S, pt(left, 0.36, f), 1.7, 0.7);
			for (var i1 = 0; i1 < 3; i1++) crate(S, pt(left - 0.55 + i1 * 0.5, 1.22, f), 0.36);
			barrel(S, pt(right, 0.36, f));
			break;
		case "weaponsmith": case "armorer":
			table(S, pt(left, 0.36, f), 1.8, 0.6);
			for (var i2 = 0; i2 < 3; i2++) {
				if (id === "weaponsmith") sword(S, pt(left - 0.6 + i2 * 0.55, 1.2, f));
				else shield(S, pt(left - 0.55 + i2 * 0.55, 1.2, f + 0.30));
			}
			break;
		case "apothecary":
			bld.box(pt(left, 1.25, f), pt(1.5, 1.7, 0.45), "wood");
			for (var row = 0; row < 4; row++) {
				for (var col = 0; col < 3; col++) {
					var c = pt(left - 0.5 + col * 0.5, 0.60 + row * 0.38, f + 0.24);
					bld.box(c, pt(0.42, 0.30, 0.05), "trim");
					bld.box(V.add(c, [0, 0, 0.04]), pt(0.11, 0.035, 0.05), "metal");
				}
			}
			bottle(S, pt(right, 0.36, f));
			break;
		case "inn":
			Parts.signboard(S, pt(left, 2.55, f + 0.2), 1.5, style);
			[-1, 1].forEach(function (s) { Parts.lantern(S, pt(s * w * 0.38, 2.25, f + 0.1), style); });
			bld.box(pt(left, 1.35, f + 0.30), pt(1.4, 0.22, 0.8), "wood");
			break;
		case "tavern":
			for (var i3 = 0; i3 < 3; i3++) barrel(S, pt(left + (i3 % 2) * 0.6, 0.36 + Math.floor(i3 / 2) * 0.8, f));
			table(S, pt(right, 0.36, f), 1.3, 0.75);
			break;
		case "teahouse":
			[-1, 1].forEach(function (s) {
				table(S, pt(s * w * 0.32, 0.36, f), 1.2, 0.65);
				bottle(S, pt(s * w * 0.32, 1.22, f), "accent");
				bld.box(pt(s * w * 0.32, 0.65, f + 0.65), pt(1.1, 0.12, 0.3), "wood");
			});
			break;
		case "posthouse":
			canopy(S, pt(w / 2 + 0.9, 0, 0), 1.8, d * 0.8, 2.5);
			Parts.rail(S, pt(w / 2, 0.1, d * 0.35), pt(w / 2 + 1.8, 0.1, d * 0.35), 0.9, style);
			break;
		case "forge":
			[-1, 1].forEach(function (s) { block(S, pt(left + s * 0.47, 1.0, f), pt(0.26, 1.3, 0.85), "stone"); });
			block(S, pt(left, 1.65, f), pt(1.2, 0.22, 0.85), "stone");
			bld.box(pt(left, 0.9, f - 0.39), pt(0.65, 0.7, 0.05), "shadow");
			bld.box(pt(left, 0.60, f), pt(0.62, 0.12, 0.4), "accent");
			block(S, pt(left, 2.45, f - 0.2), pt(0.55, 1.6, 0.55), "stone");
			bld.box(pt(right, 0.85, f), pt(0.8, 0.25, 0.4), "metal");
			bld.box(pt(right, 0.55, f), pt(0.30, 0.6, 0.30), "wood");
			break;
		case "carpenter":
			table(S, pt(left, 0.36, f), 1.8, 0.8);
			for (var i4 = 0; i4 < 4; i4++) bld.box(pt(right, 0.45 + i4 * 0.14, f), pt(1.2, 0.11, 0.5), "wood");
			sword(S, pt(left, 1.2, f));
			break;
		case "tailor":
			for (var i5 = 0; i5 < 3; i5++) {
				bld.cylinder(pt(left - 0.45 + i5 * 0.40, 0.9, f), 0.17, 1.0, i5 % 2 ? "accent" : "cloth", 8);
			}
			table(S, pt(right, 0.36, f), 1.3, 0.6);
			bld.box(pt(right, 1.24, f), pt(0.8, 0.04, 0.5), "cloth");
			break;
		case "alchemy":
			table(S, pt(left, 0.36, f), 1.5, 0.75);
			for (var i6 = 0; i6 < 3; i6++) bottle(S, pt(left - 0.4 + i6 * 0.4, 1.22, f));
			bld.cylinder(pt(right, 1.0, f), 0.42, 0.9, "metal", 10);
			bld.beam(pt(right, 1.5, f), pt(right - 0.5, 1.5, f), 0.08, "metal");
			bottle(S, pt(right - 0.5, 0.9, f));
			break;
		case "mill":
			wheel(S, pt(w / 2 + 0.22, 1.5, 0), 1.3);
			break;
		case "magistrate":
			[-1, 1].forEach(function (s) { block(S, pt(s * 1.0, 1.65, f + 0.75), pt(0.28, 3.3, 0.28), "wood"); });
			roofAt4(S, pt(0, 3.3, f + 0.75), 2.6, 1.0);
			break;
		case "town_hall":
			bld.box(pt(0, Number(P(S).floors) * 2.8 + 1.0, d * 0.30), pt(1.3, 1.4, 1.0), "wall");
			bld.cylinder(pt(0, Number(P(S).floors) * 2.8 + 1.3, d * 0.30), 0.22, 0.35, "metal", 8);
			roofAt4(S, pt(0, Number(P(S).floors) * 2.8 + 1.7, d * 0.30), 1.6, 1.3);
			break;
		case "guild":
			Parts.signboard(S, pt(left, 2.25, f), 1.5, style);
			shield(S, pt(left, 2.0, f + 0.16));
			bld.box(pt(right, 1.55, f), pt(1.2, 1.4, 0.1), "wood");
			for (var i7 = 0; i7 < 4; i7++) {
				bld.box(pt(right - 0.28 + (i7 % 2) * 0.55, 1.25 + Math.floor(i7 / 2) * 0.55, f + 0.08), pt(0.38, 0.42, 0.04), "cloth");
			}
			break;
		case "escort_hall":
			[-1, 1].forEach(function (s) {
				bld.beam(pt(s * w * 0.34, 0.36, f), pt(s * w * 0.34, 2.9, f), 0.10, "wood");
				bld.box(pt(s * w * 0.34 + 0.35, 2.5, f), pt(0.7, 0.6, 0.035), "accent");
			});
			wheel(S, pt(left, 0.9, f + 0.25), 0.5);
			break;
		case "clan_hall":
			[-1, 1].forEach(function (s) {
				bld.cylinder(pt(s * w * 0.30, 0.75, f + 0.6), 0.28, 0.8, "stone", 8);
				bld.cylinder(pt(s * w * 0.30, 1.25, f + 0.6), 0.4, 0.24, "metal", 8);
			});
			break;
		case "temple":
			[-1, 1].forEach(function (s) { canopy(S, pt(s * (w / 2 + 0.8), 0, -0.2), 1.6, d * 0.7, 2.5); });
			bld.cylinder(pt(left, 1.0, f), 0.35, 0.6, "metal", 8);
			break;
		case "ancestral_hall":
			block(S, pt(left, 0.65, f), pt(1.0, 0.6, 0.5), "stone");
			for (var i8 = 0; i8 < 3; i8++) bld.box(pt(left - 0.3 + i8 * 0.3, 1.15, f), pt(0.15, 0.4, 0.08), "wood");
			Parts.signboard(S, pt(0, 2.65, f), 1.6, style);
			break;
		case "cathedral": {
			var tower = pt(-w / 2 - 0.75, 0, -d * 0.20);
			block(S, V.add(tower, [0, 2.8, 0]), pt(1.6, 5.6, 1.8), "wall");
			roofAt4(S, V.add(tower, [0, 5.6, 0]), 1.7, 1.9);
			if (style === "desert") {
				for (var i9 = 0; i9 < 6; i9++) bld.cylinder(pt(0, 3.3 + i9 * 0.18, 0), 1.15 * (1 - i9 / 8), 0.22, "roof", 12);
			}
			break;
		}
		case "academy":
			[-1, 1].forEach(function (s) {
				table(S, pt(s * w * 0.32, 0.36, f), 1.5, 0.7);
				bld.box(pt(s * w * 0.32, 1.24, f), pt(0.65, 0.06, 0.4), "cloth");
			});
			Parts.signboard(S, pt(0, 2.65, f), 2.0, style);
			break;
		case "library":
			[-1, 1].forEach(function (s) {
				bld.box(pt(s * w * 0.34, 1.45, f), pt(1.3, 2.0, 0.45), "wood");
				for (var row2 = 0; row2 < 3; row2++) {
					for (var i10 = 0; i10 < 5; i10++) {
						bld.box(pt(s * w * 0.34 - 0.48 + i10 * 0.24, 0.82 + row2 * 0.53, f + 0.26), pt(0.15, 0.35, 0.20), i10 % 2 ? "accent" : "cloth");
					}
				}
			});
			break;
		case "barracks":
			canopy(S, pt(left, 0.36, f + 0.4), 1.8, 1.0, 2.0);
			for (var i11 = 0; i11 < 3; i11++) sword(S, pt(left - 0.5 + i11 * 0.5, 0.6, f + 0.5));
			shield(S, pt(right, 1.1, f));
			break;
		default:
			Parts.planter(S, pt(right, 0.5, f), 0.8);
			break;
	}
}

/** v4.roof_at：原型建筑用密集瓦垄屋顶。 */
function roofAt4(S, c, w, d) {
	var p = P(S), style = S.style;
	// 插件里 v4 原型建筑同样调用 roof_at，v6 覆写后原型建筑也换成方言屋顶
	if (TB.isV6Style(style)) { roofAt6(S, c, w, d); return; }
	var rise = Math.tan(TB.deg(clampf(p.pitch === undefined ? 32 : p.pitch, 15, 50))) * Math.min(w, d) * 0.5;
	var eave = Number(p.eave === undefined ? 0.4 : p.eave);
	var choice = Number(p.roof || 0);
	if (choice === 2) roofTerrace(S, c, w, d, eave);
	else if (choice === 1) roofGable(S, c, w, d, rise, eave, false);
	else if (style === "jiangnan") roofHip(S, c, w, d, rise, eave, false);
	else if (style === "forest") roofGable(S, c, w, d, rise, eave, false);
	else roofTerrace(S, c, w, d, eave);
}

// ---------------------------------------------------------------------------
// v4 原型建筑
// ---------------------------------------------------------------------------
function stall(S, w, d, h, bays) {
	var bld = S.b;
	canopy(S, pt(0, 0, 0), w, d, h);
	table(S, pt(0, 0, d * 0.23), w * 0.84, 0.72);
	block(S, pt(0, 0.4, d * 0.23), pt(w * 0.84, 0.8, 0.72), "wood");
	for (var i = 0; i < bays; i++) {
		crate(S, pt(-w * 0.33 + i * w * 0.66 / Math.max(1, bays - 1), 0.86, d * 0.23), 0.34);
	}
}

function shelter(S, w, d, h, bays) {
	var bld = S.b, id = S.entry.id;
	var raised = id === "granary";
	var y = raised ? 0.7 : 0.1;
	block(S, pt(0, y / 2, 0), pt(w, y, d), raised ? "stone" : "wood");
	[-1, 1].forEach(function (x) {
		[-1, 1].forEach(function (z) { post(S, pt(x * w / 2, y, z * d / 2), h); });
	});
	block(S, pt(0, y + h * 0.4, -d / 2), pt(w, h * 0.8, 0.14), "wood");
	if (id !== "boathouse") {
		for (var i = 1; i < bays; i++) {
			block(S, pt(-w / 2 + w * i / bays, y + 0.55, -d * 0.15), pt(0.1, 1.1, d * 0.65), "wood");
		}
	}
	roofAt4(S, pt(0, y + h, 0), w, d);
	switch (id) {
		case "granary":
			for (var g = 0; g < bays; g++) crate(S, pt(-w * 0.3 + g * w * 0.6 / Math.max(1, bays - 1), y, -d * 0.25), 0.8);
			for (var s = 0; s < 4; s++) block(S, pt(0, 0.10 + s * 0.15, d / 2 + 0.8 - s * 0.2), pt(1.3, 0.20 + s * 0.30, 0.22), "stone");
			break;
		case "stable": case "animal_shed":
			for (var b = 0; b < bays; b++) {
				var x = -w / 2 + (b + 0.5) * w / bays;
				bld.box(pt(x, y + 0.2, -d * 0.3), pt(w / bays * 0.65, 0.4, 0.55), "wood");
				bld.box(pt(x, y + 0.42, -d * 0.3), pt(w / bays * 0.56, 0.05, 0.43), "cloth");
			}
			if (id === "animal_shed") Parts.rail(S, pt(-w / 2, y, d / 2), pt(-0.65, y, d / 2), 0.9, S.style);
			break;
		case "boathouse":
			[-1, 1].forEach(function (s2) {
				bld.beam(pt(s2 * 0.6, y + 0.22, -d * 0.3), pt(s2 * 0.35, y + 0.25, d * 0.3), 0.16, "wood");
			});
			for (var c2 = 0; c2 < 5; c2++) bld.box(pt(0, y + 0.23, -d * 0.3 + c2 * d * 0.15), pt(1.1, 0.12, 0.16), "wood");
			break;
		case "carriage_station":
			table(S, pt(-w * 0.28, y, -d * 0.1), 1.4, 0.6);
			[-1, 1].forEach(function (s3) { wheel(S, pt(w * 0.26 + s3 * 0.36, y + 0.55, -d * 0.10), 0.5); });
			bld.box(pt(w * 0.26, y + 0.65, -d * 0.10), pt(0.75, 0.25, 1.3), "wood");
			break;
		default:
			break;
	}
}

function greenhouse(S, w, d, h, bays) {
	var bld = S.b, style = S.style;
	block(S, pt(0, 0.12, 0), pt(w, 0.24, d), "stone");
	[-1, 1].forEach(function (x) {
		block(S, pt(x * w / 2, h / 2, 0), pt(0.06, h, d), "glass");
		for (var i = 0; i <= bays; i++) post(S, pt(x * w / 2, 0, -d / 2 + d * i / bays), h);
	});
	block(S, pt(0, h / 2, -d / 2), pt(w, h, 0.06), "glass");
	[-1, 1].forEach(function (x) { block(S, pt(x * (w / 4 + 0.4), h / 2, d / 2), pt(w / 2 - 0.8, h, 0.06), "glass"); });
	[-1, 1].forEach(function (s) {
		bld.face([pt(0, h + 1, -d / 2), pt(s * w / 2, h, -d / 2), pt(s * w / 2, h, d / 2), pt(0, h + 1, d / 2)], "glass");
		for (var i = 0; i <= bays; i++) {
			bld.beam(pt(0, h + 1, -d / 2 + i * d / bays), pt(s * w / 2, h, -d / 2 + i * d / bays), 0.1, "wood");
		}
		for (var j = 0; j < bays; j++) {
			Parts.planter(S, pt(s * w * 0.28, 0.55, -d * 0.35 + j * d * 0.7 / Math.max(1, bays - 1)), 0.8);
		}
	});
}

function wallSection(S, c, w, h) {
	var bld = S.b, style = S.style, arch = S.entry.archetype;
	var depth = Number(arch === "wall" ? (P(S).depth === undefined ? 0.8 : P(S).depth) : 0.55);
	block(S, V.add(c, [0, h / 2, 0]), pt(w, h, depth), style === "desert" ? "wall" : "stone");
	block(S, V.add(c, [0, h + 0.06, 0]), pt(w + 0.12, 0.16, depth + 0.16), "trim");
	var n = Math.max(2, Math.round(Number(P(S).bays || 3)) * 2);
	for (var i = 0; i <= n; i++) {
		var x = -w / 2 + w * i / n;
		block(S, V.add(c, [x, h + 0.35, 0]), pt(0.48, 0.6, 0.7), "stone");
		if (i % 3 === 0) block(S, V.add(c, [x, (h + 0.2) / 2, 0]), pt(0.7, h + 0.2, 0.8), "stone");
	}
}

function gate(S, w, d, h, checkpoint) {
	var bld = S.b, style = S.style;
	var gap = Math.min(2.6, w * 0.42), side = (w - gap) / 2;
	[-1, 1].forEach(function (x) {
		block(S, pt(x * (gap / 2 + side / 2), h / 2, 0), pt(side, h, d), "stone");
		if (checkpoint) roofAt4(S, pt(x * (gap / 2 + side / 2), h, 0), side, d);
	});
	block(S, pt(0, h - 0.2, 0), pt(gap, 0.4, d), "stone");
	if (!checkpoint) roofAt4(S, pt(0, h, 0), w, d);
	[-1, 1].forEach(function (s) { Parts.lantern(S, pt(s * (gap / 2 + 0.3), h * 0.6, d / 2 + 0.25), style); });
}

function fortress(S, w, d, h) {
	var bld = S.b;
	var before = bld.xf;
	[-1, 1].forEach(function (s) {
		bld.xf = TB.xf(TB.basisRotY(Math.PI / 2), pt(s * w / 2, 0, 0));
		wallSection(S, pt(0, 0, 0), d, h);
	});
	bld.xf = before;
	wallSection(S, pt(0, 0, -d / 2), w, h);
	[-1, 1].forEach(function (s) {
		wallSection(S, pt(s * (w / 4 + 0.65), 0, d / 2), w / 2 - 1.3, h);
		[-1, 1].forEach(function (z) {
			block(S, pt(s * w / 2, (h + 1) / 2, z * d / 2), pt(1.5, h + 1, 1.5), "stone");
			roofAt4(S, pt(s * w / 2, h + 1, z * d / 2), 1.5, 1.5);
		});
	});
	block(S, pt(0, h - 0.15, d / 2), pt(2.6, 0.3, 0.7), "stone");
}

function dock(S, w, d, h, bays) {
	var bld = S.b;
	block(S, pt(0, h, 0), pt(w, 0.16, d), "wood");
	[-1, 1].forEach(function (x) {
		for (var i = 0; i <= bays; i++) {
			var c = pt(x * w * 0.46, 0, -d / 2 + i * d / bays);
			post(S, c, h + 0.5);
			if (i % 2 === 0) bld.cylinder(V.add(c, [0, h + 0.55, 0]), 0.14, 0.13, "metal", 8);
		}
	});
	for (var j = 0; j < 4; j++) {
		block(S, pt(0, h * (j + 1) / 5, d / 2 + 1.0 - j * 0.25), pt(w * 0.5, h * (j + 1) * 0.4, 0.28), "wood");
	}
}

function portal(S, w, d, h, mine) {
	var bld = S.b;
	var gap = Math.min(2.4, w * 0.6);
	[-1, 1].forEach(function (s) { block(S, pt(s * (gap / 2 + 0.22), h / 2, 0), pt(0.44, h, d), mine ? "wood" : "stone"); });
	block(S, pt(0, h, 0), pt(gap + 0.9, 0.40, d), mine ? "wood" : "stone");
	block(S, pt(0, h * 0.5, -d / 2), pt(gap, h, 0.08), "shadow");
	if (mine) {
		[-1, 1].forEach(function (s) { bld.box(pt(s * 0.46, 0.055, d * 0.25), pt(0.08, 0.11, d * 1.2), "metal"); });
		for (var i = 0; i < 7; i++) bld.box(pt(0, 0.025, -d * 0.3 + i * d / 6), pt(1.3, 0.05, 0.12), "wood");
	} else {
		[-1, 1].forEach(function (s) { bld.cylinder(pt(s * (gap / 2 + 0.48), h + 0.18, 0), 0.27, 0.55, "accent", 6); });
		bld.box(pt(0, h + 0.42, 0), pt(gap * 0.6, 0.55, d * 0.5), "stone");
	}
}

function ruin(S, w, d, h, bays) {
	var bld = S.b, id = S.entry.id;
	block(S, pt(0, 0.08, 0), pt(w, 0.16, d), "stone");
	for (var i = 0; i <= bays; i++) {
		var rise = h * (0.35 + TB.posmod(Number(S.profile.shapeSeed) + i * 7, 5) * 0.13);
		block(S, pt(-w / 2 + w * i / bays, rise / 2, -d / 2), pt(w / bays * 0.70, rise, 0.4), "stone");
	}
	[-1, 1].forEach(function (s) {
		block(S, pt(s * w / 2, h * 0.28, -d * 0.2), pt(0.4, h * 0.56, d * 0.5), "wall");
		if (id === "ruins") bld.cylinder(pt(s * w * 0.34, h * 0.4, d * 0.22), 0.24, h * 0.8, "stone", 8);
		else bld.beam(pt(s * w / 2, h * 0.56, -d / 2), pt(0, h * 0.80, -d / 2), 0.17, "wood");
	});
}

function tower(S, w, d, h) {
	var p = P(S), style = S.style;
	var floors = clampInt(p.floors === undefined ? 3 : p.floors, 1, 3);
	foundation(S, w, d, 0.36);
	for (var f = 0; f < floors; f++) {
		storey(S, pt(0, 0.36 + f * 2.8, 0), w, d, 2.8, f, clampInt(p.windows === undefined ? 2 : p.windows, 1, 4), 0);
	}
	roofAt4(S, pt(0, 0.36 + floors * 2.8, 0), w + 0.2, d + 0.2);
	if (S.entry.id === "watchtower") {
		[-1, 1].forEach(function (s) {
			Parts.rail(S, pt(-w / 2, 0.36 + floors * 2.8, s * d / 2), pt(w / 2, 0.36 + floors * 2.8, s * d / 2), 0.6, style);
		});
	} else {
		S.b.cylinder(pt(0, 0.36 + floors * 2.8 + 2.3, 0), 0.42, 0.5, "accent", 6);
		for (var a = 0; a < 8; a++) {
			S.b.beam(pt(0, 0.36 + floors * 2.8 + 2.7, 0),
				pt(Math.cos(a * Math.PI / 4) * 0.7, 0.36 + floors * 2.8 + 2.3, Math.sin(a * Math.PI / 4) * 0.7), 0.05, "metal");
		}
	}
}

// ---------------------------------------------------------------------------
// 打包：类型专属附件
// ---------------------------------------------------------------------------
function packAsset(S, isHouse) {
	var bld = S.b, p = P(S);
	// 蒸汽工业：民居/商住额外挂锅炉烟囱与外墙管道（对应 v6.pack_asset）
	if (S.style === "steamworks") boilerStack(S, isHouse);
	if (isHouse) {
		var w = clampf(p.width, 3, 10) * (S.profile.kind === 2 ? 1.12 : 1.0);
		var d = clampf(p.depth, 3, 10) * (S.profile.kind === 2 ? 1.08 : 1.0);
		houseIdentity5(S, w, d);
		if (S.detailVariant % 2 === 0) Parts.signboard(S, pt(w * 0.34, 2.3, d / 2 + 0.22), 0.7, S.style);
	} else {
		var w2 = Number(p.width), d2 = Number(p.depth);
		var y = Math.min(Number(p.height === undefined ? 3 : p.height) * 0.6, 1.8);
		var count = 2 + S.detailVariant % 3;
		for (var i = 0; i < count; i++) {
			bld.box(pt(-w2 * 0.5 + 0.02 + i * 0.02, y + (i % 2) * 0.15, -d2 * 0.5 + 0.085),
				pt(0.08, 0.11 + (S.detailVariant % 2) * 0.06, 0.04), "trim");
		}
	}
	bld.mark("type_" + S.entry.id);
}

// ---------------------------------------------------------------------------
// 房屋（v5 主路径）
// ---------------------------------------------------------------------------
function buildHouse5(S) {
	var bld = S.b, p = P(S), style = S.style;
	var w = clampf(p.width, 3, 10) * (S.profile.kind === 2 ? 1.12 : 1.0);
	var d = clampf(p.depth, 3, 10) * (S.profile.kind === 2 ? 1.08 : 1.0);
	var floors = clampInt(p.floors === undefined ? 1 : p.floors, 1, 3);
	var columns = clampInt(p.windows === undefined ? 2 : p.windows, 1, 4);
	var base = 0.36, top = base + floors * 2.8;
	foundation(S, w, d, base);
	var rw = w, rd = d, rc = pt(0, top, 0);
	for (var f = 0; f < floors; f++) {
		var sw = w, sd = d, c = pt(0, base + f * 2.8, 0);
		if (style === "desert" && f > 0) {
			sw = w * 0.77;
			sd = d * 0.73;
			c = pt(c[0] + w * 0.10, c[1], c[2] - d * 0.12);
			if (f === 1) Roof5.terrace(S, pt(0, base + 2.70, 0), w, d, 0.15);
			rw = sw; rd = sd; rc = pt(c[0], top, c[2]);
		}
		storey(S, c, sw, sd, 2.8, f, columns, S.profile.kind);
	}
	roofAt5(S, rc, rw, rd);
	if (p.porch || S.profile.kind === 1) {
		porch5(S, w, d, base, floors > 1 && !!p.balcony && style !== "desert", S.profile.kind, style === "desert");
	}
	if (style === "forest" && Number(p.roof || 0) !== 2) {
		chimney(S, w, d, top, Math.tan(TB.deg(Number(p.pitch))) * w / 2);
	}
	if (style === "desert" && S.ornate) {
		bld.mark("rooftop_pergola");
		[-1, 1].forEach(function (x) {
			[-1, 1].forEach(function (z) {
				bld.beam(V.add(rc, [x * rw * 0.28, 0.2, z * rd * 0.3]), V.add(rc, [x * rw * 0.28, 1.55, z * rd * 0.3]), 0.14, "wood");
			});
		});
		for (var i = 0; i < 6; i++) {
			bld.beam(V.add(rc, [-rw * 0.32 + rw * 0.64 * i / 5, 1.55, -rd * 0.36]),
				V.add(rc, [-rw * 0.32 + rw * 0.64 * i / 5, 1.55, rd * 0.36]), 0.13, "wood");
		}
		[-1, 1].forEach(function (z) {
			bld.beam(V.add(rc, [-rw * 0.36, 1.48, z * rd * 0.3]), V.add(rc, [rw * 0.36, 1.48, z * rd * 0.3]), 0.15, "wood");
		});
	}
	packAsset(S, true);
}

/** v4 原型建筑主路径 */
function buildArchetype4(S) {
	var bld = S.b, p = P(S), arch = S.entry.archetype;
	var w = clampf(p.width === undefined ? 6 : p.width, 3, 10);
	var d = clampf(p.depth === undefined ? 4 : p.depth, arch === "wall" ? 0.5 : 2, 10);
	var h = clampf(p.height === undefined ? 3.2 : p.height, 0.3, 10);
	var bays = clampInt(p.bays === undefined ? 3 : p.bays, 1, 6);
	// 原型建筑没有统一台基：默认占地 = 主体宽×深；若内部调用 foundation 会覆盖这里。
	S.b.setFootprint(w, d);
	S.variant = TB.posmod(Number(S.profile.shapeSeed), 6);
	S.ornate = p.ornament !== false;
	switch (arch) {
		case "stall": stall(S, w, d, h, bays); break;
		case "barn": shelter(S, w, d, h, bays); break;
		case "greenhouse": greenhouse(S, w, d, h, bays); break;
		case "wall": wallSection(S, pt(0, 0, 0), w, h); break;
		case "gate": gate(S, w, d, h, S.entry.id === "checkpoint"); break;
		case "fortress": fortress(S, w, d, h); break;
		case "dock": dock(S, w, d, h, bays); break;
		case "portal": portal(S, w, d, h, S.entry.id === "mine"); break;
		case "ruin": ruin(S, w, d, h, bays); break;
		case "tower": tower(S, w, d, h); break;
		default: stall(S, w, d, h, bays); break;
	}
	packAsset(S, false);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
/**
 * profile = {
 *   style, typeId, kind, shapeSeed, detailSeed, appearanceSeed, params
 * }
 */
TB.buildBuilding = function (profile) {
	var entry = TB.Catalog.entry(profile.typeId);
	if (!entry) throw new Error("未知建筑类型：" + profile.typeId);
	var S = {
		b: new MeshBuilder(),
		entry: entry,
		profile: profile,
		params: profile.params || {},
		style: TB.geometryStyle(profile.style),
		variant: 0,
		ornate: true,
		detailVariant: 0
	};
	var rng = new TB.PCG((profile.detailSeed | 0) + TB.hashStr(profile.typeId));
	S.detailVariant = rng.randiRange(0, 5);
	S.variant = TB.posmod(Number(profile.shapeSeed) | 0, 6);
	S.ornate = S.params.ornament !== false;
	if (entry.archetype === "house") buildHouse5(S); else buildArchetype4(S);
	var mesh = S.b.finish();
	if (!mesh) throw new Error("该参数没有生成任何几何");
	return mesh;
};

TB.MeshBuilder = MeshBuilder;
})();

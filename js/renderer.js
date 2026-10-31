(function () {
"use strict";
/**
 * 纯软件光栅化器（无 WebGL / 无光照）。
 *
 * 目标：把参数化建筑按俯角投影成 2D 像素图，视觉规则与原插件一致：
 *   - 最近邻采样、不做三线性过滤，保留像素颗粒；
 *   - 只乘顶点染色与材质微差，不计算任何光源、阴影、环境光；
 *   - 可选的屏幕空间结构描边：用深度 + 法线缓冲区找断层（对应 sprite_outline.gdshader）；
 *   - 抗锯齿 = 2× 超采样后做盒式降采样（对应插件的 4× MSAA 观感）。
 */
var TB = globalThis.TB;

TB.OUTLINE_COLOR = "#140f0d";

/**
 * mesh: TB.buildBuilding 的产物
 * tiles: {role: {w,h,data:Uint8ClampedArray}}
 * view: TB.prepareView 的产物
 * yaw: 该方向朝向（度）
 * opts: {
 *   antialias, transparent, backgroundColor, depthThreshold, normalThreshold,
 *   outlineInner / outlineColor,          // 内描边（几何内侧，按部件分界）
 *   outlineOuter / outlineColorOuter,     // 部件外描边（每个部件向外扩，可压到别的部件上）
 *   outlineSilhouette / outlineColorSilhouette, // 轮廓描边（只包整栋剪影，落在背景上）
 *   partOutlines: {role: {inner, innerColor, outer, outerColor}}  // 部件级覆盖，缺省继承全局
 * }
 */
TB.renderFrame = function (mesh, tiles, view, yaw, opts) {
	opts = opts || {};
	var ss = opts.antialias === false ? 1 : 2;
	var baseW = view.canvas[0], baseH = view.canvas[1];
	var W = baseW * ss, H = baseH * ss;
	var cam = TB.cameraFor(view, yaw);
	var R = cam.R, eye = cam.eye;
	var r0 = [R.bx[0], R.by[0], R.bz[0]];
	var r1 = [R.bx[1], R.by[1], R.bz[1]];
	var r2 = [R.bx[2], R.by[2], R.bz[2]];

	// ---- 深度范围（用于描边的相对深度比较）----
	var corners = TB.boundsCorners(view.bounds);
	var dmin = Infinity, dmax = -Infinity;
	for (var ci = 0; ci < corners.length; ci++) {
		var c = corners[ci];
		var dx = c[0] - eye[0], dy = c[1] - eye[1], dz = c[2] - eye[2];
		var vc = -(r2[0] * dx + r2[1] * dy + r2[2] * dz);
		if (vc < dmin) dmin = vc;
		if (vc > dmax) dmax = vc;
	}
	var dNear = Math.max(dmin, view.near);
	var dRange = Math.max(dmax - dNear, 0.001);

	// ---- 缓冲区 ----
	var color = new Uint8ClampedArray(W * H * 4);
	var depth = new Float32Array(W * H);
	depth.fill(Infinity);
	var nbuf = new Float32Array(W * H * 3);
	// 部件拾取缓冲：每像素记录材质角色索引（0..15），255 = 背景。
	var pick = new Uint8Array(W * H);
	pick.fill(255);
	var transparent = opts.transparent !== false;
	if (!transparent) {
		var bg = TB.hexToRgb(opts.backgroundColor || "#2a2e33");
		for (var p0 = 0; p0 < W * H; p0++) {
			var o0 = p0 * 4;
			color[o0] = bg[0]; color[o0 + 1] = bg[1]; color[o0 + 2] = bg[2]; color[o0 + 3] = 255;
		}
	}

	// ---- 投影参数 ----
	var tanV = Math.tan(TB.deg(view.fov) * 0.5);
	var tanH = tanV * view.aspect;
	var halfH = view.orthoSize * 0.5;
	var halfW = halfH * view.aspect;
	var perspective = view.perspective;
	var near = view.near;

	function project(cx, cy, cz) {
		if (!perspective) {
			return {
				sx: (cx / halfW * 0.5 + 0.5) * W,
				sy: (0.5 - cy / halfH * 0.5) * H,
				iw: 1,
				dist: -cz
			};
		}
		var denom = -cz;
		return {
			sx: (cx / (denom * tanH) * 0.5 + 0.5) * W,
			sy: (0.5 - cy / (denom * tanV) * 0.5) * H,
			iw: 1 / denom,
			dist: denom
		};
	}

	var posArr, uvArr, tintArr, nrmArr;
	var drawn = 0;
	// Godot 的标准材质默认背面剔除。这里用几何法线判断朝向：
	// 法线朝向相机的一侧为正面（与插件里 cull_back 的结果一致）。
	var cull = opts.cull !== false;
	var eyeDir = cam.basis.bz;
	var tileW = 1, tileH = 1, tileData = null, tileMips = null, triLod = 0;
	var currentRole = 255;

	function makeVertex(p, u, vx, vy, vz) {
		var proj = project(vx, vy, vz);
		return {
			sx: proj.sx, sy: proj.sy, iw: proj.iw, dist: proj.dist,
			u: uvArr[u], v: uvArr[u + 1],
			r: tintArr[p], g: tintArr[p + 1], b: tintArr[p + 2],
			nx: nrmArr[p], ny: nrmArr[p + 1], nz: nrmArr[p + 2]
		};
	}

	function raster(v0, v1, v2) {
		var x0 = v0.sx, y0 = v0.sy, x1 = v1.sx, y1 = v1.sy, x2 = v2.sx, y2 = v2.sy;
		var denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
		if (!(Math.abs(denom) > 1e-7)) return;
		var minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
		var maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
		var minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
		var maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
		if (minX > maxX || minY > maxY) return;
		var inv = 1 / denom;
		var u0iw = v0.u * v0.iw, u1iw = v1.u * v1.iw, u2iw = v2.u * v2.iw;
		var v0iw = v0.v * v0.iw, v1iw = v1.v * v1.iw, v2iw = v2.v * v2.iw;
		var r0iw = v0.r * v0.iw, r1iw = v1.r * v1.iw, r2iw = v2.r * v2.iw;
		var g0iw = v0.g * v0.iw, g1iw = v1.g * v1.iw, g2iw = v2.g * v2.iw;
		var b0iw = v0.b * v0.iw, b1iw = v1.b * v1.iw, b2iw = v2.b * v2.iw;
		var n0iwx = v0.nx * v0.iw, n1iwx = v1.nx * v1.iw, n2iwx = v2.nx * v2.iw;
		var n0iwy = v0.ny * v0.iw, n1iwy = v1.ny * v1.iw, n2iwy = v2.ny * v2.iw;
		var n0iwz = v0.nz * v0.iw, n1iwz = v1.nz * v1.iw, n2iwz = v2.nz * v2.iw;
		var iw0 = v0.iw, iw1 = v1.iw, iw2 = v2.iw;
		var d0 = v0.dist, d1 = v1.dist, d2 = v2.dist;
		// 纹理 LOD：最近邻 + mip 链，与插件 TEXTURE_FILTER_NEAREST_WITH_MIPMAPS 一致。
		var level = tileMips ? Math.min(triLod, tileMips.length - 1) : 0;
		var mip = tileMips ? tileMips[level] : null;
		var tw = mip ? mip.w : tileW, th = mip ? mip.h : tileH, td = mip ? mip.data : tileData;

		for (var py = minY; py <= maxY; py++) {
			var pyc = py + 0.5;
			var rowBase = py * W;
			for (var px = minX; px <= maxX; px++) {
				var pxc = px + 0.5;
				var w0 = ((y1 - y2) * (pxc - x2) + (x2 - x1) * (pyc - y2)) * inv;
				var w1 = ((y2 - y0) * (pxc - x2) + (x0 - x2) * (pyc - y2)) * inv;
				var w2 = 1 - w0 - w1;
				if (w0 < 0 || w1 < 0 || w2 < 0) continue;
				var dist = w0 * d0 + w1 * d1 + w2 * d2;
				var idx = rowBase + px;
				if (dist >= depth[idx]) continue;
				var iw = w0 * iw0 + w1 * iw1 + w2 * iw2;
				if (!(iw > 0)) continue;
				var invw = 1 / iw;
				var u = (w0 * u0iw + w1 * u1iw + w2 * u2iw) * invw;
				var v = (w0 * v0iw + w1 * v1iw + w2 * v2iw) * invw;
				var ix = Math.floor(u * tw) % tw;
				if (ix < 0) ix += tw;
				var iy = Math.floor(v * th) % th;
				if (iy < 0) iy += th;
				var ti = (iy * tw + ix) * 4;
				var clear = td[ti + 3];
				if (clear === 0) continue;
				var tr = td[ti] * (w0 * r0iw + w1 * r1iw + w2 * r2iw) * invw;
				var tg = td[ti + 1] * (w0 * g0iw + w1 * g1iw + w2 * g2iw) * invw;
				var tb = td[ti + 2] * (w0 * b0iw + w1 * b1iw + w2 * b2iw) * invw;
				var o = idx * 4;
				color[o] = tr;
				color[o + 1] = tg;
				color[o + 2] = tb;
				color[o + 3] = 255;
				depth[idx] = dist;
				pick[idx] = currentRole;
				var nx = (w0 * n0iwx + w1 * n1iwx + w2 * n2iwx) * invw;
				var ny = (w0 * n0iwy + w1 * n1iwy + w2 * n2iwy) * invw;
				var nz = (w0 * n0iwz + w1 * n1iwz + w2 * n2iwz) * invw;
				var nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
				if (nl > 1e-6) { nx /= nl; ny /= nl; nz /= nl; }
				var no = idx * 3;
				nbuf[no] = nx; nbuf[no + 1] = ny; nbuf[no + 2] = nz;
				drawn++;
			}
		}
	}

	function tri(p, u) {
		var p0 = p, p1 = p + 3, p2 = p + 6;
		var u0 = u, u1 = u + 2, u2 = u + 4;
		if (cull) {
			var fnx = nrmArr[p0], fny = nrmArr[p0 + 1], fnz = nrmArr[p0 + 2];
			if (perspective) {
				var vx = eye[0] - posArr[p0], vy = eye[1] - posArr[p0 + 1], vz = eye[2] - posArr[p0 + 2];
				if (fnx * vx + fny * vy + fnz * vz <= 0) return;
			} else if (fnx * eyeDir[0] + fny * eyeDir[1] + fnz * eyeDir[2] <= 0) {
				return;
			}
		}
		var ax = posArr[p0], ay = posArr[p0 + 1], az = posArr[p0 + 2];
		var bx = posArr[p1], by = posArr[p1 + 1], bz = posArr[p1 + 2];
		var cx = posArr[p2], cy = posArr[p2 + 1], cz = posArr[p2 + 2];
		var cx0 = r0[0] * (ax - eye[0]) + r0[1] * (ay - eye[1]) + r0[2] * (az - eye[2]);
		var cy0 = r1[0] * (ax - eye[0]) + r1[1] * (ay - eye[1]) + r1[2] * (az - eye[2]);
		var cz0 = r2[0] * (ax - eye[0]) + r2[1] * (ay - eye[1]) + r2[2] * (az - eye[2]);
		var cx1 = r0[0] * (bx - eye[0]) + r0[1] * (by - eye[1]) + r0[2] * (bz - eye[2]);
		var cy1 = r1[0] * (bx - eye[0]) + r1[1] * (by - eye[1]) + r1[2] * (bz - eye[2]);
		var cz1 = r2[0] * (bx - eye[0]) + r2[1] * (by - eye[1]) + r2[2] * (bz - eye[2]);
		var cx2 = r0[0] * (cx - eye[0]) + r0[1] * (cy - eye[1]) + r0[2] * (cz - eye[2]);
		var cy2 = r1[0] * (cx - eye[0]) + r1[1] * (cy - eye[1]) + r1[2] * (cz - eye[2]);
		var cz2 = r2[0] * (cx - eye[0]) + r2[1] * (cy - eye[1]) + r2[2] * (cz - eye[2]);

		if (cz0 <= -near && cz1 <= -near && cz2 <= -near) {
			var va0 = makeVertex(p0, u0, cx0, cy0, cz0);
			var va1 = makeVertex(p1, u1, cx1, cy1, cz1);
			var va2 = makeVertex(p2, u2, cx2, cy2, cz2);
			// 三角形在屏幕上的 UV 变化率 → mip 层级
			var dx1 = va1.sx - va0.sx, dy1 = va1.sy - va0.sy;
			var dx2 = va2.sx - va0.sx, dy2 = va2.sy - va0.sy;
			var det = dx1 * dy2 - dx2 * dy1;
			if (Math.abs(det) > 1e-9) {
				var invDet = 1 / det;
				var du1 = (va1.u - va0.u) * tileW, du2 = (va2.u - va0.u) * tileW;
				var dv1 = (va1.v - va0.v) * tileH, dv2 = (va2.v - va0.v) * tileH;
				var dudx = (du1 * dy2 - du2 * dy1) * invDet;
				var dudy = (du2 * dx1 - du1 * dx2) * invDet;
				var dvdx = (dv1 * dy2 - dv2 * dy1) * invDet;
				var dvdy = (dv2 * dx1 - dv1 * dx2) * invDet;
				var g = Math.max(Math.abs(dudx), Math.abs(dudy), Math.abs(dvdx), Math.abs(dvdy));
				triLod = g > 1e-9 ? Math.max(0, Math.round(Math.log2(g) + 0.35)) : 0;
			} else {
				triLod = 0;
			}
			raster(va0, va1, va2);
			return;
		}
		if (cz0 > -near && cz1 > -near && cz2 > -near) return;
		// 近平面裁剪：Sutherland-Hodgman（z = -near）。裁剪面很小，直接沿用三角形 LOD。
		var poly = [];
		pushClip(poly, p0, u0, cx0, cy0, cz0, p1, u1, cx1, cy1, cz1, near);
		pushClip(poly, p1, u1, cx1, cy1, cz1, p2, u2, cx2, cy2, cz2, near);
		pushClip(poly, p2, u2, cx2, cy2, cz2, p0, u0, cx0, cy0, cz0, near);
		if (poly.length < 3) return;
		for (var i = 1; i < poly.length - 1; i++) raster(poly[0], poly[i], poly[i + 1]);
	}

	function pushClip(poly, pa, ua, ax, ay, az, pb, ub, bx, by, bz, nearZ) {
		var aIn = az <= -nearZ, bIn = bz <= -nearZ;
		if (aIn) poly.push(makeVertex(pa, ua, ax, ay, az));
		if (aIn !== bIn) {
			var t = (-nearZ - az) / (bz - az);
			var mx = ax + (bx - ax) * t, my = ay + (by - ay) * t, mz = az + (bz - az) * t;
			poly.push(interpVertex(pa, ua, pb, ub, mx, my, mz, t));
		}
	}

	function interpVertex(pa, ua, pb, ub, mx, my, mz, t) {
		var proj = project(mx, my, mz);
		return {
			sx: proj.sx, sy: proj.sy, iw: proj.iw, dist: proj.dist,
			u: uvArr[ua] + (uvArr[ub] - uvArr[ua]) * t,
			v: uvArr[ua + 1] + (uvArr[ub + 1] - uvArr[ua + 1]) * t,
			r: tintArr[pa] + (tintArr[pb] - tintArr[pa]) * t,
			g: tintArr[pa + 1] + (tintArr[pb + 1] - tintArr[pa + 1]) * t,
			b: tintArr[pa + 2] + (tintArr[pb + 2] - tintArr[pa + 2]) * t,
			nx: nrmArr[pa] + (nrmArr[pb] - nrmArr[pa]) * t,
			ny: nrmArr[pa + 1] + (nrmArr[pb + 1] - nrmArr[pa + 1]) * t,
			nz: nrmArr[pa + 2] + (nrmArr[pb + 2] - nrmArr[pa + 2]) * t
		};
	}

	for (var role in mesh.roles) {
		var tile = tiles[role];
		if (!tile || !tile.data) continue;
		tileMips = tile.mips && tile.mips.length ? tile.mips : [{ w: tile.w, h: tile.h, data: tile.data }];
		tileW = tile.w; tileH = tile.h; tileData = tile.data;
		currentRole = TB.PAINT_ROLES.indexOf(role);
		if (currentRole < 0) currentRole = 255;
		var bucket = mesh.roles[role];
		posArr = bucket.pos; uvArr = bucket.uv; tintArr = bucket.tint; nrmArr = bucket.nrm;
		var triCount = posArr.length / 9;
		for (var ti = 0; ti < triCount; ti++) tri(ti * 9, ti * 6);
	}

	// ---- 描边：内描边 / 部件外描边 / 轮廓描边，三套互相独立 ----
	// 内描边：几何像素上的轮廓 / 深度断层 / 法线断层 / 部件分界，按宽度向该部件内部膨胀；
	// 部件外描边：对“每个部件”的可见剪影向外膨胀，可以压到别的部件身上，也可以落到背景；
	// 轮廓描边：只把整栋建筑的剪影向外膨胀到背景上（旧版「外描边」的语义，单列出来）。
	// 部件级参数（opts.partOutlines[role]）可覆盖全局宽度与颜色，未给出的字段沿用全局。
	var legacyOutline = opts.outline === undefined ? 0 : Number(opts.outline);
	var innerPx = opts.outlineInner === undefined ? legacyOutline : Number(opts.outlineInner) || 0;
	var partOuterPx = opts.outlineOuter === undefined ? legacyOutline : Number(opts.outlineOuter) || 0;
	var silhouettePx = opts.outlineSilhouette === undefined ? 0 : Number(opts.outlineSilhouette) || 0;
	// 全局全是 0 时，仍可能有部件级描边（opts.partOutlines），所以单独探一次
	var partOutlineProbe = opts.partOutlines || {};
	var anyPartOutline = false;
	for (var pp in partOutlineProbe) {
		if (!Object.prototype.hasOwnProperty.call(partOutlineProbe, pp)) continue;
		var pe = partOutlineProbe[pp] || {};
		if (Number(pe.inner) > 0 || Number(pe.outer) > 0) { anyPartOutline = true; break; }
	}
	if (innerPx > 0 || partOuterPx > 0 || silhouettePx > 0 || anyPartOutline) {
		var depthThreshold = opts.depthThreshold === undefined ? 0.15 : Number(opts.depthThreshold);
		var normalThreshold = opts.normalThreshold === undefined ? 0.3 : Number(opts.normalThreshold);
		var roleCount = TB.PAINT_ROLES.length;
		var partCfg = opts.partOutlines || {};
		var baseInnerColor = TB.hexToRgb(opts.outlineColor || TB.OUTLINE_COLOR);
		var baseOuterColor = TB.hexToRgb(opts.outlineColorOuter || opts.outlineColor || TB.OUTLINE_COLOR);
		var silhouetteColor = TB.hexToRgb(opts.outlineColorSilhouette || opts.outlineColorOuter || opts.outlineColor || TB.OUTLINE_COLOR);
		var roleInner = new Float32Array(roleCount);
		var roleOuter = new Float32Array(roleCount);
		var roleInnerColor = new Array(roleCount);
		var roleOuterColor = new Array(roleCount);
		for (var rc = 0; rc < roleCount; rc++) {
			var pcfg = partCfg[TB.ROLES[rc]] || {};
			var hasInner = pcfg.inner !== undefined && pcfg.inner !== null;
			var hasOuter = pcfg.outer !== undefined && pcfg.outer !== null;
			roleInner[rc] = hasInner ? Math.max(0, Number(pcfg.inner) || 0) : innerPx;
			roleOuter[rc] = hasOuter ? Math.max(0, Number(pcfg.outer) || 0) : partOuterPx;
			roleInnerColor[rc] = pcfg.innerColor ? TB.hexToRgb(pcfg.innerColor) : baseInnerColor;
			roleOuterColor[rc] = pcfg.outerColor ? TB.hexToRgb(pcfg.outerColor) : baseOuterColor;
		}

		var geometry = new Uint8Array(W * H);
		var gi;
		for (gi = 0; gi < W * H; gi++) geometry[gi] = depth[gi] === Infinity ? 0 : 1;
		// 每个部件可见像素的最近深度：外描边抢像素时按「距离优先，同距靠前者赢」
		var roleDepth = new Float32Array(roleCount);
		roleDepth.fill(Infinity);
		for (gi = 0; gi < W * H; gi++) {
			if (!geometry[gi]) continue;
			var gr = pick[gi];
			if (gr < roleCount && depth[gi] < roleDepth[gr]) roleDepth[gr] = depth[gi];
		}
		var CH_DIAG = Math.SQRT2;

		// ---- 内描边 ----
		var anyInner = false;
		for (var ii = 0; ii < roleCount; ii++) if (roleInner[ii] > 0) { anyInner = true; break; }
		if (anyInner) {
			var innerDist = new Float32Array(W * H);
			innerDist.fill(1e6);
			for (var iy = 0; iy < H; iy++) {
				for (var ix = 0; ix < W; ix++) {
					var index = iy * W + ix;
					if (!geometry[index]) continue;
					var self = (depth[index] - dNear) / dRange;
					var norm0 = index * 3;
					var n0x = nbuf[norm0], n0y = nbuf[norm0 + 1], n0z = nbuf[norm0 + 2];
					var selfRole = pick[index];
					var paint = false;
					for (var k = 0; k < 4 && !paint; k++) {
						var nx2 = ix + (k === 0 ? -1 : k === 1 ? 1 : 0);
						var ny2 = iy + (k === 2 ? -1 : k === 3 ? 1 : 0);
						if (nx2 < 0 || nx2 >= W || ny2 < 0 || ny2 >= H) continue;
						var index2 = ny2 * W + nx2;
						// 剪影边界只有几何这一侧，直接归当前像素
						if (!geometry[index2]) { paint = true; break; }
						var other = (depth[index2] - dNear) / dRange;
						var edgeDepth = Math.abs(self - other) / Math.max(self, 0.25);
						var n1i = index2 * 3;
						var dot = n0x * nbuf[n1i] + n0y * nbuf[n1i + 1] + n0z * nbuf[n1i + 2];
						var isRole = pick[index2] !== selfRole;
						var isDepth = edgeDepth > depthThreshold;
						var isNormal = 1 - dot > normalThreshold;
						if (!isRole && !isDepth && !isNormal) continue;
						// 边界只归一侧：更靠前的像素拥有；深度相同则按部件角色/屏幕位置定一侧。
						// 这样两个部件交界处不会各画 1px 合成 2px 的粗线。
						if (depth[index] < depth[index2] - 1e-9) { paint = true; break; }
						if (depth[index] > depth[index2] + 1e-9) continue;
						if (isRole) {
							if (selfRole < pick[index2]) { paint = true; break; }
							continue;
						}
						if (iy > ny2 || (iy === ny2 && ix > nx2)) { paint = true; break; }
					}
					if (paint) innerDist[index] = 0;
				}
			}
			// 倒角距离只在“同一部件”的像素之间传播，内描边因此永远留在该部件内部
			for (var fy = 0; fy < H; fy++) {
				for (var fx = 0; fx < W; fx++) {
					var fi = fy * W + fx;
					if (!geometry[fi] || innerDist[fi] === 0) continue;
					var fRole = pick[fi];
					var dv = innerDist[fi];
					if (fx > 0) {
						var f1 = fi - 1;
						if (geometry[f1] && pick[f1] === fRole) dv = Math.min(dv, innerDist[f1] + 1);
					}
					if (fy > 0) {
						var f2 = fi - W;
						if (geometry[f2] && pick[f2] === fRole) dv = Math.min(dv, innerDist[f2] + 1);
						if (fx > 0) {
							var f3 = fi - W - 1;
							if (geometry[f3] && pick[f3] === fRole) dv = Math.min(dv, innerDist[f3] + CH_DIAG);
						}
						if (fx < W - 1) {
							var f4 = fi - W + 1;
							if (geometry[f4] && pick[f4] === fRole) dv = Math.min(dv, innerDist[f4] + CH_DIAG);
						}
					}
					innerDist[fi] = dv;
				}
			}
			for (var by = H - 1; by >= 0; by--) {
				for (var bx = W - 1; bx >= 0; bx--) {
					var bi = by * W + bx;
					if (!geometry[bi] || innerDist[bi] === 0) continue;
					var bRole = pick[bi];
					var dv2 = innerDist[bi];
					if (bx < W - 1) {
						var b1 = bi + 1;
						if (geometry[b1] && pick[b1] === bRole) dv2 = Math.min(dv2, innerDist[b1] + 1);
					}
					if (by < H - 1) {
						var b2 = bi + W;
						if (geometry[b2] && pick[b2] === bRole) dv2 = Math.min(dv2, innerDist[b2] + 1);
						if (bx < W - 1) {
							var b3 = bi + W + 1;
							if (geometry[b3] && pick[b3] === bRole) dv2 = Math.min(dv2, innerDist[b3] + CH_DIAG);
						}
						if (bx > 0) {
							var b4 = bi + W - 1;
							if (geometry[b4] && pick[b4] === bRole) dv2 = Math.min(dv2, innerDist[b4] + CH_DIAG);
						}
					}
					innerDist[bi] = dv2;
				}
			}
			for (var mi = 0; mi < W * H; mi++) {
				if (!geometry[mi]) continue;
				var mRole = pick[mi];
				if (!(mRole < roleCount)) continue;
				var mWidth = roleInner[mRole];
				if (mWidth <= 0) continue;
				// 宽度按输出像素连续换算：整数部分实涂，最外一圈按小数覆盖率与原色混合。
				// 这样关抗锯齿时 0.5 是一条 50% 混色的 1px 细线，而不是和 1 一样实涂。
				var limit = mWidth * ss;
				var mDist = innerDist[mi];
				if (mDist >= limit) continue;
				var fullRing = Math.floor(limit + 1e-9);
				var coverage = mDist >= fullRing ? limit - fullRing : 1;
				if (coverage <= 0) continue;
				var mCol = roleInnerColor[mRole];
				var mo = mi * 4;
				color[mo] = Math.round(color[mo] + (mCol[0] - color[mo]) * coverage);
				color[mo + 1] = Math.round(color[mo + 1] + (mCol[1] - color[mo + 1]) * coverage);
				color[mo + 2] = Math.round(color[mo + 2] + (mCol[2] - color[mo + 2]) * coverage);
				color[mo + 3] = 255;
			}
		}

		// ---- 部件外描边：每个部件各自向外扩，允许压到别的部件或背景 ----
		var anyPartOuter = false;
		for (var oi2 = 0; oi2 < roleCount; oi2++) if (roleOuter[oi2] > 0) { anyPartOuter = true; break; }
		if (anyPartOuter) {
			var bestDist = new Float32Array(W * H);
			bestDist.fill(1e6);
			var bestCov = new Float32Array(W * H);
			var bestRole = new Int16Array(W * H);
			bestRole.fill(-1);
			var distBuf = new Float32Array(W * H);
			// 每个部件可见像素的包围盒（外扩只在这个盒子 + 描边宽度内计算，省时间）
			var bMinX = new Int32Array(roleCount); bMinX.fill(W);
			var bMinY = new Int32Array(roleCount); bMinY.fill(H);
			var bMaxX = new Int32Array(roleCount); bMaxX.fill(-1);
			var bMaxY = new Int32Array(roleCount); bMaxY.fill(-1);
			var bHas = new Uint8Array(roleCount);
			for (var bi2 = 0; bi2 < W * H; bi2++) {
				if (!geometry[bi2]) continue;
				var bRole2 = pick[bi2];
				if (!(bRole2 < roleCount)) continue;
				var bX = bi2 % W, bY = (bi2 - bX) / W;
				if (bX < bMinX[bRole2]) bMinX[bRole2] = bX;
				if (bX > bMaxX[bRole2]) bMaxX[bRole2] = bX;
				if (bY < bMinY[bRole2]) bMinY[bRole2] = bY;
				if (bY > bMaxY[bRole2]) bMaxY[bRole2] = bY;
				bHas[bRole2] = 1;
			}
			for (var pr = 0; pr < roleCount; pr++) {
				if (!bHas[pr] || roleOuter[pr] <= 0) continue;
				// 宽度按输出像素连续计算：像素中心距部件边界越近，覆盖率越高。
				var pWidth = roleOuter[pr] * ss;
				var pLimit = pWidth + 1;
				var pPad = Math.ceil(pLimit) + 1;
				var cx0 = Math.max(0, bMinX[pr] - pPad), cx1 = Math.min(W - 1, bMaxX[pr] + pPad);
				var cy0 = Math.max(0, bMinY[pr] - pPad), cy1 = Math.min(H - 1, bMaxY[pr] + pPad);
				for (var ry = cy0; ry <= cy1; ry++) distBuf.fill(1e6, ry * W + cx0, ry * W + cx1 + 1);
				for (var sy = bMinY[pr]; sy <= bMaxY[pr]; sy++) {
					for (var sx = bMinX[pr]; sx <= bMaxX[pr]; sx++) {
						var si = sy * W + sx;
						if (geometry[si] && pick[si] === pr) distBuf[si] = 0;
					}
				}
				// 倒角距离变换（两遍扫描，限制在包围盒内）
				for (var qy = cy0; qy <= cy1; qy++) {
					for (var qx = cx0; qx <= cx1; qx++) {
						var qi = qy * W + qx;
						var qd = distBuf[qi];
						if (qd === 0) continue;
						if (qx > cx0) { var q1 = distBuf[qi - 1] + 1; if (q1 < qd) qd = q1; }
						if (qy > cy0) {
							var q2 = distBuf[qi - W] + 1; if (q2 < qd) qd = q2;
							if (qx > cx0) { var q3 = distBuf[qi - W - 1] + CH_DIAG; if (q3 < qd) qd = q3; }
							if (qx < cx1) { var q4 = distBuf[qi - W + 1] + CH_DIAG; if (q4 < qd) qd = q4; }
						}
						distBuf[qi] = qd;
					}
				}
				for (var uy = cy1; uy >= cy0; uy--) {
					for (var ux = cx1; ux >= cx0; ux--) {
						var ui = uy * W + ux;
						var ud = distBuf[ui];
						if (ud === 0) continue;
						if (ux < cx1) { var u1 = distBuf[ui + 1] + 1; if (u1 < ud) ud = u1; }
						if (uy < cy1) {
							var u2 = distBuf[ui + W] + 1; if (u2 < ud) ud = u2;
							if (ux < cx1) { var u3 = distBuf[ui + W + 1] + CH_DIAG; if (u3 < ud) ud = u3; }
							if (ux > cx0) { var u4 = distBuf[ui + W - 1] + CH_DIAG; if (u4 < ud) ud = u4; }
						}
						distBuf[ui] = ud;
					}
				}
				// 竞标：覆盖率更高者赢；同覆盖率更近者赢；再同则更靠前的部件赢。
				// 压到别的部件时只允许“前侧压后侧”：后侧部件不会把自己的外描边
				// 反压到前面的部件上，避免交界处两边各扩 1px 合成 2px 粗缝。
				for (var vy = cy0; vy <= cy1; vy++) {
					for (var vx = cx0; vx <= cx1; vx++) {
						var vi = vy * W + vx;
						var vd = distBuf[vi];
						var cov = pWidth - (vd - 1);
						if (cov <= 0) continue;
						if (cov > 1) cov = 1;
						// 自己的像素不画自己的外描边（那是内描边的事）
						if (geometry[vi] && pick[vi] === pr) continue;
						if (geometry[vi]) {
							var targetRole = pick[vi];
							if (roleDepth[pr] > depth[vi] + 1e-9) continue;
							if (Math.abs(roleDepth[pr] - depth[vi]) <= 1e-9 && pr > targetRole) continue;
						}
						if (cov > bestCov[vi] + 1e-6) {
							bestCov[vi] = cov;
							bestDist[vi] = vd;
							bestRole[vi] = pr;
						} else if (Math.abs(cov - bestCov[vi]) <= 1e-6) {
							if (vd < bestDist[vi] - 1e-6) {
								bestDist[vi] = vd;
								bestRole[vi] = pr;
							} else if (vd <= bestDist[vi] + 1e-6 && bestRole[vi] >= 0 && roleDepth[pr] < roleDepth[bestRole[vi]]) {
								bestRole[vi] = pr;
							}
						}
					}
				}
			}
			for (var pi = 0; pi < W * H; pi++) {
				var winRole = bestRole[pi];
				if (winRole < 0) continue;
				var winCov = bestCov[pi];
				if (winCov <= 0) continue;
				var pCol = roleOuterColor[winRole];
				var po = pi * 4;
				if (geometry[pi]) {
					// 压到别的部件上：保留该部件纹理，按覆盖率混入外描边颜色
					color[po] = Math.round(color[po] + (pCol[0] - color[po]) * winCov);
					color[po + 1] = Math.round(color[po + 1] + (pCol[1] - color[po + 1]) * winCov);
					color[po + 2] = Math.round(color[po + 2] + (pCol[2] - color[po + 2]) * winCov);
					color[po + 3] = 255;
				} else if (transparent) {
					color[po] = pCol[0]; color[po + 1] = pCol[1]; color[po + 2] = pCol[2];
					color[po + 3] = Math.round(winCov * 255);
				} else {
					color[po] = Math.round(color[po] + (pCol[0] - color[po]) * winCov);
					color[po + 1] = Math.round(color[po + 1] + (pCol[1] - color[po + 1]) * winCov);
					color[po + 2] = Math.round(color[po + 2] + (pCol[2] - color[po + 2]) * winCov);
					color[po + 3] = 255;
				}
			}
		}

		// ---- 轮廓描边：只包住整栋建筑的剪影，落在背景上 ----
		if (silhouettePx > 0) {
			var silWidth = silhouettePx * ss;
			var silDist = new Float32Array(W * H);
			silDist.fill(1e6);
			for (gi = 0; gi < W * H; gi++) if (geometry[gi]) silDist[gi] = 0;
			for (var gy = 0; gy < H; gy++) {
				for (var gx = 0; gx < W; gx++) {
					var gindex = gy * W + gx;
					var gd = silDist[gindex];
					if (gd === 0) continue;
					if (gx > 0) { var g1 = silDist[gindex - 1] + 1; if (g1 < gd) gd = g1; }
					if (gy > 0) {
						var g2 = silDist[gindex - W] + 1; if (g2 < gd) gd = g2;
						if (gx > 0) { var g3 = silDist[gindex - W - 1] + CH_DIAG; if (g3 < gd) gd = g3; }
						if (gx < W - 1) { var g4 = silDist[gindex - W + 1] + CH_DIAG; if (g4 < gd) gd = g4; }
					}
					silDist[gindex] = gd;
				}
			}
			for (var hy = H - 1; hy >= 0; hy--) {
				for (var hx = W - 1; hx >= 0; hx--) {
					var hi = hy * W + hx;
					var hd = silDist[hi];
					if (hd === 0) continue;
					if (hx < W - 1) { var h1 = silDist[hi + 1] + 1; if (h1 < hd) hd = h1; }
					if (hy < H - 1) {
						var h2 = silDist[hi + W] + 1; if (h2 < hd) hd = h2;
						if (hx < W - 1) { var h3 = silDist[hi + W + 1] + CH_DIAG; if (h3 < hd) hd = h3; }
						if (hx > 0) { var h4 = silDist[hi + W - 1] + CH_DIAG; if (h4 < hd) hd = h4; }
					}
					silDist[hi] = hd;
				}
			}
			var silLimit = silWidth + 1;
			for (var wi = 0; wi < W * H; wi++) {
				if (geometry[wi]) continue;
				var sd = silDist[wi];
				if (sd >= silLimit) continue;
				var scov = silWidth - (sd - 1);
				if (scov <= 0) continue;
				if (scov > 1) scov = 1;
				var wo = wi * 4;
				if (transparent) {
					// 背景可能已被部件外描边占了一部分，按 over 合成，避免叠加变黑
					var dstA = color[wo + 3] / 255;
					var outA = scov + dstA * (1 - scov);
					if (outA > 0) {
						color[wo] = Math.round((silhouetteColor[0] * scov + color[wo] * dstA * (1 - scov)) / outA);
						color[wo + 1] = Math.round((silhouetteColor[1] * scov + color[wo + 1] * dstA * (1 - scov)) / outA);
						color[wo + 2] = Math.round((silhouetteColor[2] * scov + color[wo + 2] * dstA * (1 - scov)) / outA);
						color[wo + 3] = Math.round(outA * 255);
					}
				} else {
					color[wo] = Math.round(color[wo] + (silhouetteColor[0] - color[wo]) * scov);
					color[wo + 1] = Math.round(color[wo + 1] + (silhouetteColor[1] - color[wo + 1]) * scov);
					color[wo + 2] = Math.round(color[wo + 2] + (silhouetteColor[2] - color[wo + 2]) * scov);
					color[wo + 3] = 255;
				}
			}
		}
	}

	// ---- 超采样降采样（预乘 alpha 平均，避免边缘发黑）----
	var outW = baseW, outH = baseH;
	var out = new Uint8ClampedArray(outW * outH * 4);
	var outPick = new Uint8Array(outW * outH);
	if (ss === 1) {
		out.set(color);
		outPick.set(pick);
	} else {
		var counts = new Uint8Array(TB.PAINT_ROLES.length);
		for (var oy = 0; oy < outH; oy++) {
			for (var ox = 0; ox < outW; ox++) {
				var sr = 0, sg = 0, sb = 0, sa = 0;
				counts.fill(0);
				for (var sy = 0; sy < ss; sy++) {
					for (var sx = 0; sx < ss; sx++) {
						var sub = (oy * ss + sy) * W + (ox * ss + sx);
						var sp = sub * 4;
						var a = color[sp + 3];
						sr += color[sp] * a;
						sg += color[sp + 1] * a;
						sb += color[sp + 2] * a;
						sa += a;
						var pid = pick[sub];
						if (pid !== 255) counts[pid]++;
					}
				}
				var op = (oy * outW + ox) * 4;
				if (sa > 0) {
					out[op] = sr / sa;
					out[op + 1] = sg / sa;
					out[op + 2] = sb / sa;
				}
				out[op + 3] = sa / (ss * ss);
				var best = 255, bestCount = 0;
				for (var ri = 0; ri < TB.PAINT_ROLES.length; ri++) {
					if (counts[ri] > bestCount) { bestCount = counts[ri]; best = ri; }
				}
				outPick[oy * outW + ox] = best;
			}
		}
	}
	return { width: outW, height: outH, data: out, pick: outPick, drawn: drawn };
};

/** 精灵表：默认横排，超过 maxWidth 自动换行（对应插件 sheet.png）。 */
TB.composeSheet = function (frames, maxWidth) {
	maxWidth = maxWidth || 16384;
	if (!frames.length) return null;
	var fw = frames[0].width, fh = frames[0].height;
	var columns = Math.max(1, Math.min(frames.length, Math.floor(maxWidth / Math.max(1, fw))));
	var rows = Math.ceil(frames.length / columns);
	var sheet = new Uint8ClampedArray(fw * columns * fh * rows * 4);
	for (var i = 0; i < frames.length; i++) {
		var cx = (i % columns) * fw;
		var cy = ((i / columns) | 0) * fh;
		var frame = frames[i];
		for (var y = 0; y < fh; y++) {
			var src = (y * fw) * 4;
			var dst = (((cy + y) * fw * columns) + cx) * 4;
			sheet.set(frame.data.subarray(src, src + fw * 4), dst);
		}
	}
	return { width: fw * columns, height: fh * rows, data: sheet };
};
})();

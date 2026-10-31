(function () {
"use strict";
/**
 * Godot 预制体导出：把同一视角下的 3D 网格 / 渲染结果换算成 2D 节点数据。
 *
 * 坐标口径（与游戏里的 2D 世界一致）：
 *   - 节点原点 = 地基占地中心（世界 0,0,0）在画布上的投影点；
 *   - 碰撞层 = 地基矩形四角按当前相机投影后的四边形（俯角 45° 时进深自然压缩）；
 *   - 遮挡层 = 渲染结果的不透明像素（填掉内部镂空）扣掉碰撞层后，每块连通区域的外轮廓；
 *   - Sprite2D 的 offset 保证世界原点落在节点原点，贴图与两层严格对齐。
 *
 * 本模块不依赖 Node / 浏览器私有 API，CLI 与网页端共用。
 */
var TB = globalThis.TB;

function num(v) {
	var n = Math.round(Number(v) * 100) / 100;
	if (!isFinite(n)) n = 0;
	if (n === 0) return "0";
	var s = n.toFixed(2);
	return s.replace(/\.?0+$/, "");
}

function sanitizeNodeName(name) {
	var text = String(name === undefined || name === null ? "" : name).trim();
	text = text.replace(/[.:@\/"\\%]+/g, "_").replace(/^_+|_+$/g, "");
	return text || "Building";
}

function sanitizeTexturePath(path) {
	var text = String(path === undefined || path === null ? "" : path).trim();
	if (!text) throw new Error("Godot 预制体需要贴图路径（例如 res://asset/village/buildings/inn.png）");
	if (text.indexOf('"') >= 0) throw new Error("贴图路径不能包含双引号：" + text);
	return text;
}

/** 世界坐标 → 画布像素（与 renderer.js 的 project 完全同口径）。 */
function project(view, yaw, p) {
	var cam = TB.cameraFor(view, yaw);
	var R = cam.R, eye = cam.eye;
	var r0 = [R.bx[0], R.by[0], R.bz[0]];
	var r1 = [R.bx[1], R.by[1], R.bz[1]];
	var r2 = [R.bx[2], R.by[2], R.bz[2]];
	var dx = p[0] - eye[0], dy = p[1] - eye[1], dz = p[2] - eye[2];
	var cx = r0[0] * dx + r0[1] * dy + r0[2] * dz;
	var cy = r1[0] * dx + r1[1] * dy + r1[2] * dz;
	var cz = r2[0] * dx + r2[1] * dy + r2[2] * dz;
	var W = view.canvas[0], H = view.canvas[1];
	if (view.perspective) {
		var denom = -cz;
		var tanV = Math.tan(TB.deg(view.fov) * 0.5);
		var tanH = tanV * view.aspect;
		return {
			x: (cx / (denom * tanH) * 0.5 + 0.5) * W,
			y: (0.5 - cy / (denom * tanV) * 0.5) * H,
			depth: denom
		};
	}
	var halfH = view.orthoSize * 0.5;
	var halfW = halfH * view.aspect;
	return {
		x: (cx / halfW * 0.5 + 0.5) * W,
		y: (0.5 - cy / halfH * 0.5) * H,
		depth: -cz
	};
}

/** 穿透测试（奇偶规则，适配凸/凹多边形）。 */
function pointInPolygon(px, py, poly) {
	var inside = false;
	for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		var xi = poly[i][0], yi = poly[i][1];
		var xj = poly[j][0], yj = poly[j][1];
		if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
			inside = !inside;
		}
	}
	return inside;
}

function clearPolygon(mask, W, H, poly) {
	var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (var i = 0; i < poly.length; i++) {
		if (poly[i][0] < minX) minX = poly[i][0];
		if (poly[i][0] > maxX) maxX = poly[i][0];
		if (poly[i][1] < minY) minY = poly[i][1];
		if (poly[i][1] > maxY) maxY = poly[i][1];
	}
	var x0 = Math.max(0, Math.floor(minX));
	var x1 = Math.min(W - 1, Math.ceil(maxX));
	var y0 = Math.max(0, Math.floor(minY));
	var y1 = Math.min(H - 1, Math.ceil(maxY));
	for (var y = y0; y <= y1; y++) {
		for (var x = x0; x <= x1; x++) {
			if (!mask[y * W + x]) continue;
			if (pointInPolygon(x + 0.5, y + 0.5, poly)) mask[y * W + x] = 0;
		}
	}
}

/** 从画布边界向内灌水，把未连到边界的透明区（内部镂空）填成不透明。 */
function fillHoles(mask, W, H) {
	var outside = new Uint8Array(W * H);
	var queue = new Int32Array(W * H);
	var head = 0, tail = 0;
	function push(index) {
		if (mask[index] || outside[index]) return;
		outside[index] = 1;
		queue[tail++] = index;
	}
	for (var x = 0; x < W; x++) {
		push(x);
		push((H - 1) * W + x);
	}
	for (var y = 0; y < H; y++) {
		push(y * W);
		push(y * W + W - 1);
	}
	while (head < tail) {
		var index = queue[head++];
		var ix = index % W, iy = (index / W) | 0;
		if (ix > 0) push(index - 1);
		if (ix < W - 1) push(index + 1);
		if (iy > 0) push(index - W);
		if (iy < H - 1) push(index + W);
	}
	for (var i = 0; i < W * H; i++) {
		if (!mask[i] && !outside[i]) mask[i] = 1;
	}
}

/**
 * 沿「不透明像素与透明像素之间的边」串成闭合环。
 * 每个环带方向：外轮廓为顺时针（屏幕 y 向下），镂空为逆时针。
 */
function boundaryLoops(mask, W, H) {
	var edges = new Map();
	function add(x1, y1, x2, y2) {
		var key = y1 * W + x1;
		var list = edges.get(key);
		if (!list) {
			list = [];
			edges.set(key, list);
		}
		list.push({ sx: x1, sy: y1, x: x2, y: y2, used: false });
	}
	for (var y = 0; y < H; y++) {
		for (var x = 0; x < W; x++) {
			if (!mask[y * W + x]) continue;
			if (y === 0 || !mask[(y - 1) * W + x]) add(x, y, x + 1, y);
			if (x === W - 1 || !mask[y * W + x + 1]) add(x + 1, y, x + 1, y + 1);
			if (y === H - 1 || !mask[(y + 1) * W + x]) add(x + 1, y + 1, x, y + 1);
			if (x === 0 || !mask[y * W + x - 1]) add(x, y + 1, x, y);
		}
	}

	// 拐角处若有两条边可选，优先右转，避免把相邻的两块粘成一个自交环。
	function turnScore(dx, dy, cdx, cdy) {
		if (cdx === -dy && cdy === dx) return 4;
		if (cdx === dx && cdy === dy) return 3;
		if (cdx === dy && cdy === -dx) return 2;
		if (cdx === -dx && cdy === -dy) return 1;
		return 0;
	}

	function trace(first) {
		var pts = [[first.sx, first.sy]];
		var used = [first];
		var cur = first;
		var maxSteps = W * H * 4 + 16;
		for (var step = 0; step < maxSteps; step++) {
			cur.used = true;
			var nx = cur.x, ny = cur.y;
			var px = pts[pts.length - 1][0], py = pts[pts.length - 1][1];
			if (nx === first.sx && ny === first.sy) return { pts: pts, used: used };
			pts.push([nx, ny]);
			var dx = nx - px, dy = ny - py;
			var list = edges.get(ny * W + nx);
			var next = null, best = -1;
			if (list) {
				for (var i = 0; i < list.length; i++) {
					var candidate = list[i];
					if (candidate.used) continue;
					var score = turnScore(dx, dy, candidate.x - nx, candidate.y - ny);
					if (score > best) {
						best = score;
						next = candidate;
					}
				}
			}
			if (!next) break;
			cur = next;
			used.push(next);
		}
		for (var k = 0; k < used.length; k++) used[k].used = false;
		return null;
	}

	var loops = [];
	edges.forEach(function (list) {
		for (var i = 0; i < list.length; i++) {
			var edge = list[i];
			if (edge.used) continue;
			var traced = trace(edge);
			if (traced && traced.pts.length >= 4) loops.push(traced.pts);
		}
	});
	return loops;
}

function signedArea(pts) {
	var sum = 0;
	for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
		sum += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
	}
	return sum * 0.5;
}

function segmentDistance2(px, py, ax, ay, bx, by) {
	var dx = bx - ax, dy = by - ay;
	var len2 = dx * dx + dy * dy;
	var t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
	t = Math.max(0, Math.min(1, t));
	var qx = ax + dx * t, qy = ay + dy * t;
	var ex = px - qx, ey = py - qy;
	return ex * ex + ey * ey;
}

function simplifyOpen(pts, tolerance) {
	if (pts.length <= 2) return pts;
	var keep = new Uint8Array(pts.length);
	keep[0] = 1;
	keep[pts.length - 1] = 1;
	var stack = [[0, pts.length - 1]];
	var limit = tolerance * tolerance;
	while (stack.length) {
		var span = stack.pop();
		var a = span[0], b = span[1];
		var worst = -1, index = -1;
		for (var i = a + 1; i < b; i++) {
			var d = segmentDistance2(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]);
			if (d > worst) {
				worst = d;
				index = i;
			}
		}
		if (worst > limit && index > 0) {
			keep[index] = 1;
			stack.push([a, index]);
			stack.push([index, b]);
		}
	}
	var out = [];
	for (var k = 0; k < pts.length; k++) if (keep[k]) out.push(pts[k]);
	return out;
}

/** 闭合环简化：以离起点最远的点切成两段，分别做 Douglas–Peucker。 */
function simplifyLoop(pts, tolerance) {
	if (tolerance <= 0 || pts.length <= 4) return pts;
	var far = 1, best = -1;
	var x0 = pts[0][0], y0 = pts[0][1];
	for (var i = 1; i < pts.length; i++) {
		var dx = pts[i][0] - x0, dy = pts[i][1] - y0;
		var d = dx * dx + dy * dy;
		if (d > best) {
			best = d;
			far = i;
		}
	}
	if (far <= 0 || far >= pts.length - 1) return pts;
	var head = simplifyOpen(pts.slice(0, far + 1), tolerance);
	var tail = simplifyOpen(pts.slice(far).concat([pts[0]]), tolerance);
	return head.concat(tail.slice(1, tail.length - 1));
}

function polygonText(pts) {
	var parts = [];
	for (var i = 0; i < pts.length; i++) parts.push(num(pts[i][0]) + ", " + num(pts[i][1]));
	return "PackedVector2Array(" + parts.join(", ") + ")";
}

function cleanPolygon(pts) {
	var out = [];
	for (var i = 0; i < pts.length; i++) {
		var p = pts[i];
		if (!out.length || out[out.length - 1][0] !== p[0] || out[out.length - 1][1] !== p[1]) out.push(p);
	}
	if (out.length > 1) {
		var first = out[0], last = out[out.length - 1];
		if (first[0] === last[0] && first[1] === last[1]) out.pop();
	}
	return out;
}

function cross(ax, ay, bx, by, cx, cy) {
	return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function segmentsHit(a, b, c, d) {
	var d1 = cross(c[0], c[1], d[0], d[1], a[0], a[1]);
	var d2 = cross(c[0], c[1], d[0], d[1], b[0], b[1]);
	var d3 = cross(a[0], a[1], b[0], b[1], c[0], c[1]);
	var d4 = cross(a[0], a[1], b[0], b[1], d[0], d[1]);
	return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Godot 的 CollisionPolygon2D 要求简单（不自交）多边形。 */
function isSimplePolygon(poly) {
	var n = poly.length;
	if (n < 3) return false;
	for (var i = 0; i < n; i++) {
		var a = poly[i], b = poly[(i + 1) % n];
		if (a[0] === b[0] && a[1] === b[1]) return false;
		for (var j = i + 1; j < n; j++) {
			if (j === i + 1) continue;
			if (i === 0 && j === n - 1) continue;
			var c = poly[j], d = poly[(j + 1) % n];
			if (segmentsHit(a, b, c, d)) return false;
		}
	}
	return true;
}

function footprintOf(mesh) {
	var fp = mesh.footprint;
	if (fp && fp.length === 2 && fp[0] > 0 && fp[1] > 0) return [fp[0], fp[1]];
	var size = mesh.bounds && mesh.bounds.size ? mesh.bounds.size : [3, 3, 3];
	return [Math.max(size[0], 0.1), Math.max(size[2], 0.1)];
}

/**
 * options = {
 *   mesh, view, frame,                 必需；frame 为同一视角的 renderFrame 结果
 *   yaw                              默认 view.yaws[0]
 *   texturePath                      .tscn 里 ext_resource 的路径（建议 res://...）
 *   name                             根节点名（默认 Building）
 *   margin                           裁剪留边（像素，默认 6）
 *   alphaThreshold                   不透明判定阈值（默认 8）
 *   minArea                          遮挡多边形最小面积（像素²，默认 16）
 *   simplify                         轮廓简化容差（像素，默认 1）
 *   transparent                      false 时用 frame.pick 判定覆盖
 * }
 */
function build(options) {
	options = options || {};
	var mesh = options.mesh, view = options.view, frame = options.frame;
	if (!mesh || !view || !frame) throw new Error("GodotPrefab.build 需要 mesh / view / frame");
	if (frame.width !== view.canvas[0] || frame.height !== view.canvas[1]) {
		throw new Error("frame 尺寸与 view.canvas 不一致：" + frame.width + "×" + frame.height);
	}
	var W = frame.width, H = frame.height;
	var yaw = options.yaw === undefined ? view.yaws[0] : Number(options.yaw);
	var texturePath = sanitizeTexturePath(options.texturePath);
	var nodeName = sanitizeNodeName(options.name);
	var margin = Math.max(0, Math.round(options.margin === undefined ? 6 : Number(options.margin)));
	var alphaThreshold = options.alphaThreshold === undefined ? 8 : Number(options.alphaThreshold);
	var minArea = options.minArea === undefined ? 16 : Number(options.minArea);
	var simplify = options.simplify === undefined ? 1 : Number(options.simplify);
	var transparent = options.transparent !== false;

	var origin = project(view, yaw, [0, 0, 0]);
	var fp = footprintOf(mesh);
	var halfW = fp[0] * 0.5, halfD = fp[1] * 0.5;
	var collisionImage = [
		[-halfW, 0, -halfD],
		[halfW, 0, -halfD],
		[halfW, 0, halfD],
		[-halfW, 0, halfD]
	].map(function (p) {
		var q = project(view, yaw, p);
		return [q.x, q.y];
	});
	if (Math.abs(signedArea(collisionImage)) < 1) {
		throw new Error("当前视角下地基投影退化（俯角过低），无法生成碰撞层；请提高 --pitch");
	}
	if (signedArea(collisionImage) < 0) collisionImage.reverse();

	function covered(index) {
		if (transparent) return frame.data[index * 4 + 3] > alphaThreshold;
		return frame.pick ? frame.pick[index] !== 255 : frame.data[index * 4 + 3] > alphaThreshold;
	}

	// ---- 裁剪到不透明边界（预制体专用贴图）----
	var minX = W, minY = H, maxX = -1, maxY = -1;
	for (var y = 0; y < H; y++) {
		for (var x = 0; x < W; x++) {
			if (!covered(y * W + x)) continue;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
	}
	if (maxX < minX || maxY < minY) throw new Error("渲染结果全透明，无法导出 Godot 预制体");
	var clipped = minX === 0 || minY === 0 || maxX === W - 1 || maxY === H - 1;
	var cropX = Math.max(0, minX - margin);
	var cropY = Math.max(0, minY - margin);
	var cropW = Math.min(W, maxX + 1 + margin) - cropX;
	var cropH = Math.min(H, maxY + 1 + margin) - cropY;
	var image = new Uint8ClampedArray(cropW * cropH * 4);
	for (var row = 0; row < cropH; row++) {
		var src = ((cropY + row) * W + cropX) * 4;
		image.set(frame.data.subarray(src, src + cropW * 4), row * cropW * 4);
	}

	// ---- 遮挡层：裁剪区内填洞 → 扣掉碰撞地基 → 逐块取外轮廓 ----
	var mask = new Uint8Array(cropW * cropH);
	for (var iy = 0; iy < cropH; iy++) {
		for (var ix = 0; ix < cropW; ix++) {
			mask[iy * cropW + ix] = covered((cropY + iy) * W + cropX + ix) ? 1 : 0;
		}
	}
	fillHoles(mask, cropW, cropH);
	var collisionCrop = collisionImage.map(function (p) {
		return [p[0] - cropX, p[1] - cropY];
	});
	clearPolygon(mask, cropW, cropH, collisionCrop);
	// 基点是地基中心（节点原点）。屏幕 y 大于基点的部分在建筑前方，角色不会被建筑遮挡，
	// 因此遮挡层只保留基点以上的像素（y < 基点）。
	var baseLocalY = origin.y - cropY;
	for (var by = 0; by < cropH; by++) {
		if (by + 0.5 < baseLocalY) continue;
		var rowStart = by * cropW;
		mask.fill(0, rowStart, rowStart + cropW);
	}

	var originInCrop = [origin.x - cropX, origin.y - cropY];
	var loops = boundaryLoops(mask, cropW, cropH);
	var occlusion = [];
	var totalVertices = 0;
	var skipped = 0;
	for (var li = 0; li < loops.length; li++) {
		var loop = loops[li];
		var area = signedArea(loop);
		if (area <= 0 || Math.abs(area) < minArea) continue;
		var simplified = cleanPolygon(simplifyLoop(loop, simplify));
		if (simplified.length < 3) continue;
		if (!isSimplePolygon(simplified)) {
			// 简化在极窄的凹口处可能自交：退回原始像素轮廓，仍不合格则跳过。
			simplified = cleanPolygon(loop);
			if (!isSimplePolygon(simplified)) {
				skipped++;
				continue;
			}
		}
		var poly = simplified.map(function (p) {
			return [p[0] + cropX - origin.x, p[1] + cropY - origin.y];
		});
		if (signedArea(poly) < 0) poly.reverse();
		occlusion.push({ area: Math.abs(area), points: poly });
		totalVertices += poly.length;
	}
	occlusion.sort(function (a, b) { return b.area - a.area; });
	var occlusionPoints = occlusion.map(function (item) { return item.points; });

	var collision = collisionImage.map(function (p) {
		return [p[0] - origin.x, p[1] - origin.y];
	});
	var spriteOffset = [
		cropW * 0.5 - originInCrop[0],
		cropH * 0.5 - originInCrop[1]
	];

	// ---- 纯内置节点的 .tscn ----
	var lines = [
		"[gd_scene load_steps=2 format=3]",
		"",
		'[ext_resource type="Texture2D" path="' + texturePath + '" id="1_tex"]',
		"",
		'[node name="' + nodeName + '" type="StaticBody2D"]',
		"collision_layer = 1",
		"collision_mask = 0",
		"",
		'[node name="Collision" type="CollisionPolygon2D" parent="."]',
		"polygon = " + polygonText(collision),
		"",
		'[node name="Sprite" type="Sprite2D" parent="."]',
		"offset = Vector2(" + num(spriteOffset[0]) + ", " + num(spriteOffset[1]) + ")",
		'texture = ExtResource("1_tex")'
	];
	if (occlusionPoints.length) {
		lines.push("");
		lines.push('[node name="遮挡层" type="Area2D" parent="."]');
		for (var oi = 0; oi < occlusionPoints.length; oi++) {
			lines.push("");
			lines.push('[node name="Polygon' + (oi + 1) + '" type="CollisionPolygon2D" parent="遮挡层"]');
			lines.push("polygon = " + polygonText(occlusionPoints[oi]));
		}
	}
	lines.push("");

	return {
		text: lines.join("\n"),
		image: { width: cropW, height: cropH, data: image },
		crop: { x: cropX, y: cropY, width: cropW, height: cropH },
		origin: { x: origin.x, y: origin.y },
		spriteOffset: spriteOffset,
		collision: collision,
		occlusion: occlusionPoints,
		stats: {
			footprint: [fp[0], fp[1]],
			canvas: [W, H],
			crop: [cropW, cropH],
			yaw: yaw,
			origin: [origin.x, origin.y],
			collisionVertices: collision.length,
			occlusionPolygons: occlusionPoints.length,
			occlusionVertices: totalVertices,
			skippedPolygons: skipped,
			clipped: clipped
		}
	};
}

TB.GodotPrefab = {
	build: build,
	project: project,
	sanitizeNodeName: sanitizeNodeName
};
})();

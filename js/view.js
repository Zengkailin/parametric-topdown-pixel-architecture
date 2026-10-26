(function () {
"use strict";
/**
 * 视角与构图：移植 sprite_studio.gd 的 _prepare_view / _place_camera / _yaws。
 *
 * 约定：
 *   - 相机基 = RotY(yaw) * RotX(-pitch)，俯角 90° 即纯顶视；
 *   - 正交投影没有消失点，画面高度 = ortho_size；
 *   - 透视投影垂直 FOV，距构图中心 distance；
 *   - 所有方向共用同一画布与缩放，方向帧比例一致。
 */
var TB = globalThis.TB;
var V = TB.V;

TB.PIXEL_SIZES = [128, 256, 384, 512, 768, 1024];
TB.ADAPTIVE_PIXEL_INDEX = 6;
TB.DIRECTION_COUNTS = [1, 2, 4, 8];

/** 相机基：先俯角绕 X，再朝向绕 Y（与 GDScript 的 Basis 相乘顺序一致）。 */
TB.cameraBasis = function (yawDeg, pitchDeg) {
	return TB.basisMul(TB.basisRotY(TB.deg(yawDeg)), TB.basisRotX(TB.deg(-pitchDeg)));
};

TB.yawList = function (directionsIndex, baseYaw) {
	var count = TB.DIRECTION_COUNTS[TB.clampInt(directionsIndex, 0, TB.DIRECTION_COUNTS.length - 1)];
	var list = [];
	for (var i = 0; i < count; i++) list.push(TB.wrapf(Number(baseYaw) + 360 * i / count, -180, 180));
	return list;
};

TB.isAdaptiveCanvas = function (cfg) { return cfg.pixelSize >= TB.ADAPTIVE_PIXEL_INDEX; };
TB.fixedCanvasSize = function (cfg) {
	return TB.PIXEL_SIZES[TB.clampInt(cfg.pixelSize, 0, TB.PIXEL_SIZES.length - 1)];
};

/**
 * cfg = {
 *   pitch, projection(0 正交 / 1 透视), directions, baseYaw, fov,
 *   pixelSize(0..6), scaleMode(0 自动适配 / 1 固定像素密度),
 *   pixelsPerMeter, padding, nearPlane
 * }
 */
TB.prepareView = function (bounds, cfg) {
	var size = bounds.size;
	if (!size || (size[0] === 0 && size[1] === 0 && size[2] === 0)) return null;
	var yaws = TB.yawList(cfg.directions, cfg.baseYaw === undefined ? 0 : cfg.baseYaw);
	var pitch = TB.clamp(Number(cfg.pitch === undefined ? 45 : cfg.pitch), 0, 90);
	var fixed = Number(cfg.scaleMode) === 1;
	var center = fixed ? [0, 0, 0] : bounds.center;

	// 投影范围：相对相机基、围绕构图中心对称统计 8 个包围盒角点。
	var extentX = 0, extentY = 0;
	var corners = boundsCorners(bounds);
	for (var y = 0; y < yaws.length; y++) {
		var R = TB.basisTranspose(TB.cameraBasis(yaws[y], pitch));
		for (var i = 0; i < corners.length; i++) {
			var p = TB.applyDir(R, V.sub(corners[i], center));
			extentX = Math.max(extentX, Math.abs(p[0]));
			extentY = Math.max(extentY, Math.abs(p[1]));
		}
	}
	extentX = Math.max(extentX, 0.001);
	extentY = Math.max(extentY, 0.001);

	var paddingMul = 1 + Number(cfg.padding === undefined ? 8 : cfg.padding) * 0.01;
	var ppm = Math.max(0.1, Number(cfg.pixelsPerMeter === undefined ? 48 : cfg.pixelsPerMeter));
	var adaptive = TB.isAdaptiveCanvas(cfg);
	var width, height;
	if (adaptive) {
		width = TB.clampInt(Math.ceil(2 * extentX * ppm * paddingMul), 16, 4096);
		height = TB.clampInt(Math.ceil(2 * extentY * ppm * paddingMul), 16, 4096);
	} else {
		width = TB.fixedCanvasSize(cfg);
		height = width;
	}
	var aspect = width / height;
	// 透视 FOV 允许 0°：FOV→0 的极限就是正交投影（相机距离→∞、消失点消失），
	// 因此 0–0.4° 直接按正交渲染，避免 tan(0)=0 造成的退化。
	var projectionRequested = Number(cfg.projection) === 1;
	var fov = TB.clamp(Number(cfg.fov === undefined ? 50 : cfg.fov), 0, 100);
	var fovLimit = projectionRequested && fov < 0.5;
	var perspective = projectionRequested && !fovLimit;
	var orthoSize = 0, distance = 0;
	if (perspective) {
		var tanV = Math.tan(TB.deg(fov) * 0.5);
		var tanH = tanV * aspect;
		if (fixed) {
			distance = height / (2 * ppm * tanV);
		} else {
			var needed = 0;
			for (var y2 = 0; y2 < yaws.length; y2++) {
				var R2 = TB.basisTranspose(TB.cameraBasis(yaws[y2], pitch));
				for (var j = 0; j < corners.length; j++) {
					var q = TB.applyDir(R2, V.sub(corners[j], center));
					needed = Math.max(needed, q[2] + Math.abs(q[1]) / tanV);
					needed = Math.max(needed, q[2] + Math.abs(q[0]) / tanH);
				}
			}
			distance = Math.max(needed * paddingMul, 0.1);
		}
	} else if (fixed || adaptive) {
		orthoSize = height / ppm;
	} else {
		orthoSize = 2 * Math.max(extentY, extentX / aspect) * paddingMul;
	}

	var length = Math.max(V.len(size), 1);
	var near, far;
	if (perspective) {
		near = Math.max(0.02, distance * 0.005);
		far = distance + length * 4;
	} else {
		distance = length * 3;
		near = 0.05;
		far = distance * 2 + length * 2;
		// 正交时 distance 只决定近远裁面，正交尺寸才是画面高度。
		distance = length * 3;
	}

	return {
		yaws: yaws,
		center: center,
		pitch: pitch,
		canvas: [width, height],
		aspect: aspect,
		perspective: perspective,
		projectionRequested: projectionRequested,
		fov: fov,
		fovLimit: fovLimit,
		orthoSize: orthoSize,
		distance: distance,
		near: near,
		far: far,
		bounds: bounds,
		ppm: ppm,
		padding: Number(cfg.padding === undefined ? 8 : cfg.padding),
		fixed: fixed,
		adaptive: adaptive
	};
};

function boundsCorners(bounds) {
	var min = bounds.min, max = bounds.max;
	var xs = [min[0], max[0]], ys = [min[1], max[1]], zs = [min[2], max[2]];
	var out = [];
	for (var i = 0; i < 2; i++) {
		for (var j = 0; j < 2; j++) {
			for (var k = 0; k < 2; k++) out.push([xs[i], ys[j], zs[k]]);
		}
	}
	return out;
}
TB.boundsCorners = boundsCorners;

/** 单方向的相机：返回世界→相机旋转 R 与相机位置 eye。 */
TB.cameraFor = function (view, yawDeg) {
	var basis = TB.cameraBasis(yawDeg, view.pitch);
	var eye = V.add(view.center, V.mul(basis.bz, view.distance));
	return { R: TB.basisTranspose(basis), eye: eye, basis: basis, yaw: yawDeg };
};

// ---------------------------------------------------------------------------
// 配方指纹 / 输出目录（对应 profile.identity() 与 _output_directory）
// ---------------------------------------------------------------------------
TB.recipeIdentity = function (profile) {
	var params = profile.params || {};
	var keys = Object.keys(params).sort();
	var stable = keys.map(function (k) { return [k, params[k]]; });
	var recipe = [
		5, 5, profile.style, profile.kind, stable,
		profile.shapeSeed, profile.detailSeed, profile.appearanceSeed,
		profile.categoryId || "", profile.typeId
	];
	return TB.hash64(JSON.stringify(recipe));
};

TB.outputFolderName = function (cfg, view, identity) {
	var suffix = "p" + Math.round(view.pitch) + "_" + view.yaws.length + "d";
	// FOV=0 时实际按正交出图，但仍保留 _persp0fov 标记，避免与真正的正交设置混淆。
	if (view.projectionRequested) suffix += "_persp" + Math.round(view.fov) + "fov";
	if (view.adaptive) suffix += "_auto";
	if (view.fixed || view.adaptive) suffix += "_s" + Math.round(view.ppm) + "ppm";
	var renderCfg = cfg.render || {};
	var inner = Number(renderCfg.outlineInner) || 0;
	var outer = Number(renderCfg.outlineOuter) || 0;
	var silhouette = Number(renderCfg.outlineSilhouette) || 0;
	if (inner > 0 || outer > 0 || silhouette > 0) {
		// oi 内描边 / oo 部件外描边 / os 轮廓描边；轮廓为 0 时保持旧的 _oi-oo 命名
		suffix += "_oi" + String(inner).replace(".", "-") + "-oo" + String(outer).replace(".", "-");
		if (silhouette > 0) suffix += "-os" + String(silhouette).replace(".", "-");
	}
	return identity + "/" + suffix;
};
})();

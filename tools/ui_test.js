/**
 * UI 自动化自测：用 Chrome DevTools 协议驱动真实页面。
 * 覆盖：首屏渲染、切换风格/建筑、视角参数、导出（PNG/ZIP/模板）、风格工坊保存、配置持久化、控制台错误。
 *
 * 用法：node tools/ui_test.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { Browser } = require("./cdp");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(__dirname, "_out");
const PAGE = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/").replace(/ /g, "%20");
const results = [];

function check(name, ok, detail) {
	results.push({ name, ok: !!ok, detail });
	console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  —  " + detail : ""));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
	fs.mkdirSync(OUT, { recursive: true });
	const browser = new Browser({ width: 1600, height: 1000, port: 9333 });
	console.log("启动 Chrome…");
	await browser.launch(PAGE);
	try {
		await browser.waitFor("!!(window.TBApp && TBApp.state && TBApp.state.frame)", 30000);
		await sleep(300);

		// ---- 1. 首屏 ----
		const first = await browser.eval(`({
			status: document.querySelector('#status').textContent,
			canvas: document.querySelector('#chipCanvas').textContent,
			proj: document.querySelector('#chipProj').textContent,
			pitch: document.querySelector('#chipPitch').textContent,
			dirs: document.querySelector('#chipDirs').textContent,
			tris: document.querySelector('#statTris').textContent,
			frame: TBApp.state.frame ? [TBApp.state.frame.width, TBApp.state.frame.height] : null,
			styleOptions: document.querySelectorAll('#styleSelect option').length,
			types: document.querySelectorAll('#typeSelect option').length,
			emptyHidden: document.querySelector('#previewEmpty').hidden,
			version: document.querySelector('#appVersion').textContent,
			toolVersion: TBApp.version
		})`);
		check("首屏渲染出画面", first.frame && first.frame[0] === 512 && first.frame[1] === 512, JSON.stringify(first.frame));
		check("状态栏为预览信息", /^预览：/.test(first.status), first.status);
		check("风格列表完整（10 内置）", first.styleOptions >= 10, String(first.styleOptions));
		check("建筑类型有选项", first.types >= 3, String(first.types));
		check("三角面统计非空", /[0-9]/.test(first.tris), first.tris);
		check("空状态提示已隐藏", first.emptyHidden === true);
		check("界面标识工具版本 v1.0", first.version === "v1.0" && first.toolVersion === "1.0", first.version + " / " + first.toolVersion);
		await browser.screenshot(path.join(OUT, "ui_01_default.png"));

		// ---- 2. 切换风格 + 建筑类型 ----
		await browser.eval(`(() => {
			const style = document.querySelector('#styleSelect'); style.value = 'forest';
			style.dispatchEvent(new Event('change', { bubbles: true }));
			const cat = document.querySelector('#categorySelect'); cat.value = 'hospitality';
			cat.dispatchEvent(new Event('change', { bubbles: true }));
			const type = document.querySelector('#typeSelect'); type.value = 'inn';
			type.dispatchEvent(new Event('change', { bubbles: true }));
		})()`);
		await browser.waitFor(`TBApp.state.cfg.styleId === 'forest' && TBApp.state.cfg.typeId === 'inn' && TBApp.state.meshKey.indexOf('"inn"') >= 0 && TBApp.state.meshKey.indexOf('"forest"') >= 0`, 30000);
		await sleep(500);
		const switched = await browser.eval(`({
			style: TBApp.state.cfg.styleId, type: TBApp.state.cfg.typeId,
			badge: document.querySelector('#styleBadge').textContent,
			tris: TBApp.state.mesh.triangles,
			floors: TBApp.state.cfg.params.floors,
			visible: Array.from(document.querySelectorAll('[data-field]')).filter(n => !n.hidden).map(n => n.dataset.field)
		})`);
		check("切换到欧式风格", switched.style === "forest", switched.style);
		check("切换到客栈", switched.type === "inn", switched.type);
		check("客栈默认 2 层", Number(switched.floors) === 2, String(switched.floors));
		check("参数行按原型显示", switched.visible.includes("floors") && switched.visible.includes("windows"), switched.visible.join(","));
		await browser.screenshot(path.join(OUT, "ui_02_forest_inn.png"));

		// ---- 3. 视角参数：俯角 / 8 方向 / 1024 / 透视 ----
		await browser.eval(`(() => {
			const set = (key, value, scope) => {
				const el = document.querySelector('[data-scope="' + scope + '"][data-key="' + key + '"]');
				if (!el) throw new Error('缺少控件 ' + key);
				if (el.type === 'checkbox') el.checked = value; else el.value = value;
				el.dispatchEvent(new Event('change', { bubbles: true }));
			};
			set('pitch', 60, 'view');
			set('directions', 3, 'view');
			set('pixelSize', 5, 'view');
			set('projection', 1, 'view');
			set('fov', 42, 'view');
		})()`);
		await browser.waitFor(`TBApp.state.view && Math.round(TBApp.state.view.pitch) === 60 && TBApp.state.view.yaws.length === 8 && TBApp.state.view.perspective && TBApp.state.view.canvas[0] === 1024 && TBApp.state.frame && TBApp.state.frame.width === 1024`, 30000);
		await sleep(200);
		const view = await browser.eval(`({
			canvas: TBApp.state.view.canvas, pitch: TBApp.state.view.pitch,
			yaws: TBApp.state.view.yaws.length, persp: TBApp.state.view.perspective,
			chip: document.querySelector('#chipCanvas').textContent,
			fovHidden: document.querySelector('[data-view-field="fov"]').hidden
		})`);
		check("画布切到 1024", view.canvas[0] === 1024 && view.canvas[1] === 1024, JSON.stringify(view.canvas));
		check("俯角生效", Math.round(view.pitch) === 60, String(view.pitch));
		check("8 方向", view.yaws === 8, String(view.yaws));
		check("透视开", view.persp === true);
		check("FOV 行可见", view.fovHidden === false);
		await browser.screenshot(path.join(OUT, "ui_03_persp_1024.png"));

		// ---- 4. 内 / 部件外 / 轮廓 三套描边 + 纯色背景 ----
		await browser.eval(`(() => {
			const set = (key, value, scope) => {
				const el = document.querySelector('[data-scope="' + scope + '"][data-key="' + key + '"]');
				if (el.type === 'checkbox') el.checked = value; else el.value = value;
				el.dispatchEvent(new Event('change', { bubbles: true }));
			};
			set('pixelSize', 3, 'view');
			set('outlineInner', 2, 'render');
			set('outlineOuter', 1, 'render');
			set('outlineSilhouette', 2, 'render');
			set('background', 1, 'render');
			const color = document.querySelector('[data-scope="render"][data-key="backgroundColor"]');
			color.value = '#f2efe6'; color.dispatchEvent(new Event('change', { bubbles: true }));
		})()`);
		await browser.waitFor(`Number(TBApp.state.cfg.render.outlineInner) === 2 && Number(TBApp.state.cfg.render.outlineOuter) === 1 && Number(TBApp.state.cfg.render.outlineSilhouette) === 2 && document.querySelector('#status').textContent.indexOf('描边 内2/外1/轮廓2px') >= 0 && TBApp.state.frame.width === 512`, 30000);
		await sleep(200);
		const outlined = await browser.eval(`({
			inner: TBApp.state.cfg.render.outlineInner,
			outer: TBApp.state.cfg.render.outlineOuter,
			silhouette: TBApp.state.cfg.render.outlineSilhouette,
			status: document.querySelector('#status').textContent,
			bgHidden: document.querySelector('[data-scope="render"][data-key="backgroundColor"]').closest('.row').hidden
		})`);
		check("内描边参数生效", Number(outlined.inner) === 2, String(outlined.inner));
		check("部件外描边参数生效", Number(outlined.outer) === 1, String(outlined.outer));
		check("轮廓描边参数生效", Number(outlined.silhouette) === 2, String(outlined.silhouette));
		check("状态栏显示三套描边", outlined.status.indexOf("描边 内2/外1/轮廓2px") >= 0, outlined.status);
		check("纯色背景时颜色行可见", outlined.bgHidden === false);
		await browser.screenshot(path.join(OUT, "ui_04_outline_bg.png"));

		// ---- 4b. FOV 0（正交极限）与俯角 0（平视）----
		await browser.eval(`(() => {
			const set = (key, value, scope) => {
				const el = document.querySelector('[data-scope="' + scope + '"][data-key="' + key + '"]');
				if (el.type === 'checkbox') el.checked = value; else el.value = value;
				el.dispatchEvent(new Event('change', { bubbles: true }));
			};
			set('fov', 0, 'view');
			set('pitch', 0, 'view');
		})()`);
		await browser.waitFor(`TBApp.state.view && TBApp.state.view.fovLimit === true && TBApp.state.view.perspective === false && Math.round(TBApp.state.view.pitch) === 0 && /正交极限/.test(document.querySelector('#status').textContent)`, 30000);
		const limitView = await browser.eval(`(() => {
			const d = TBApp.state.frame.data;
			const bg = [242, 239, 230];
			let foreground = 0;
			for (let i = 0; i < d.length; i += 4) {
				if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 24) foreground++;
			}
			return {
				fov: TBApp.state.view.fov, limit: TBApp.state.view.fovLimit, persp: TBApp.state.view.perspective,
				pitch: TBApp.state.view.pitch, chip: document.querySelector('#chipProj').textContent,
				ratio: foreground / (d.length / 4), status: document.querySelector('#status').textContent
			};
		})()`);
		check("FOV 0 自动按正交极限渲染", limitView.limit === true && limitView.persp === false && limitView.fov === 0, JSON.stringify({ fov: limitView.fov, limit: limitView.limit, persp: limitView.persp }));
		check("状态栏标注「正交极限」", /正交极限/.test(limitView.status), limitView.status);
		check("俯角 0（平视）仍能出图", limitView.ratio > 0.08, (limitView.ratio * 100).toFixed(1) + "%");
		await browser.screenshot(path.join(OUT, "ui_04b_fov0_pitch0.png"));

		await browser.eval(`(() => {
			const el = document.querySelector('[data-scope="view"][data-key="fov"]');
			el.value = 1; el.dispatchEvent(new Event('change', { bubbles: true }));
		})()`);
		await browser.waitFor(`TBApp.state.view && TBApp.state.view.perspective === true && Number(TBApp.state.view.fov) === 1`, 30000);
		check("FOV 1 仍是透视投影", true);

		// 恢复后续导出用的视角
		await browser.eval(`(() => {
			const set = (key, value, scope) => {
				const el = document.querySelector('[data-scope="' + scope + '"][data-key="' + key + '"]');
				if (el.type === 'checkbox') el.checked = value; else el.value = value;
				el.dispatchEvent(new Event('change', { bubbles: true }));
			};
			set('fov', 42, 'view');
			set('pitch', 60, 'view');
			set('projection', 1, 'view');
		})()`);
		await browser.waitFor(`TBApp.state.view && TBApp.state.view.perspective === true && Math.round(TBApp.state.view.pitch) === 60 && Number(TBApp.state.view.fov) === 42`, 30000);

		// ---- 4c. 点击部件：查看纹理 / 单独染色 / 替换纹理 ----
		const pickInfo = await browser.eval(`(() => {
			const f = TBApp.state.frame;
			const W = f.width, H = f.height;
			const role = TB.ROLES.indexOf('roof');
			let idx = -1;
			// 选一个四周也属于屋顶的像素，避免点到 1px 边缘
			for (let y = 2; y < H - 2 && idx < 0; y++) {
				for (let x = 2; x < W - 2; x++) {
					const i = y * W + x;
					if (f.pick[i] !== role) continue;
					if (f.pick[i - 2] === role && f.pick[i + 2] === role && f.pick[i - 2 * W] === role && f.pick[i + 2 * W] === role) {
						idx = i; break;
					}
				}
			}
			if (idx < 0) return { error: '画面里没有屋顶像素' };
			const x = idx % W, y = Math.floor(idx / W);
			const canvas = document.querySelector('#previewCanvas');
			const rect = canvas.getBoundingClientRect();
			const cx = Math.round(rect.left + (x + 0.5) / W * rect.width);
			const cy = Math.round(rect.top + (y + 0.5) / H * rect.height);
			document.querySelector('#previewWrap').dispatchEvent(new MouseEvent('click', { clientX: cx, clientY: cy, bubbles: true }));
			return { x, y, cx, cy, pickLength: f.pick.length, frame: [f.width, f.height] };
		})()`);
		check("拾取缓冲覆盖整张画面", pickInfo.pickLength === pickInfo.frame[0] * pickInfo.frame[1], JSON.stringify(pickInfo));
		await browser.waitFor(`!document.querySelector('#inspector').hidden && document.querySelector('#inspRole').textContent === 'roof'`, 8000);
		const inspected = await browser.eval(`({
			name: document.querySelector('#inspName').textContent,
			role: document.querySelector('#inspRole').textContent,
			origin: document.querySelector('#inspOrigin').textContent,
			thumb: document.querySelector('#inspThumb').style.backgroundImage.indexOf('url(') === 0,
			hint: document.querySelector('#inspHint').textContent
		})`);
		check("点击屋顶选中 roof 部件", inspected.role === "roof", inspected.name + " / " + inspected.role);
		check("检查器显示纹理来源", /风格图集|程序化|部件覆盖/.test(inspected.origin), inspected.origin);
		check("检查器显示该部件纹理缩略图", inspected.thumb === true);
		await browser.screenshot(path.join(OUT, "ui_04c_part_selected.png"));

		// 单独染色（先给基础纹理拍个快照，后面验证它不会被染色污染）
		await browser.eval(`window.__roofBase = TBApp.state.baseTiles.roof.data.slice()`);
		await browser.eval(`(() => {
			const el = document.querySelector('#inspTint');
			el.value = '#ff5555';
			el.dispatchEvent(new Event('change', { bubbles: true }));
		})()`);
		await browser.waitFor(`TBApp.state.partOverrides.roof && TBApp.state.partOverrides.roof.tint === '#ff5555' && document.querySelector('#status').textContent.indexOf('部件覆盖 1 项') >= 0`, 20000);
		const tinted = await browser.eval(`({
			tint: TBApp.state.partOverrides.roof.tint,
			origin: document.querySelector('#inspOrigin').textContent,
			hint: document.querySelector('#inspHint').textContent,
			baseClean: (() => {
				const b = TBApp.state.baseTiles.roof.data, s = window.__roofBase;
				if (b.length !== s.length) return false;
				for (let i = 0; i < b.length; i++) if (b[i] !== s[i]) return false;
				return true;
			})(),
			redder: (() => {
				const d = TBApp.state.tiles.roof.data;
				let r = 0, g = 0;
				for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; }
				return r > g;
			})()
		})`);
		check("部件单独染色生效", tinted.tint === "#ff5555" && tinted.redder === true, JSON.stringify(tinted));
		check("染色后来源标注部件染色", /部件染色/.test(tinted.origin), tinted.origin);
		check("染色不会污染基础纹理缓存", tinted.baseClean === true);
		await browser.screenshot(path.join(OUT, "ui_04d_part_tinted.png"));

		// 替换纹理
		const replaced = await browser.eval(`(async () => {
			const canvas = document.createElement('canvas');
			canvas.width = 64; canvas.height = 64;
			const ctx = canvas.getContext('2d');
			ctx.fillStyle = '#0a6b5a'; ctx.fillRect(0, 0, 64, 64);
			ctx.fillStyle = '#f7e2a1'; ctx.fillRect(0, 0, 32, 32);
			await TBApp.setPartTexture('roof', canvas.toDataURL());
			for (let i = 0; i < 50 && document.querySelector('#inspOrigin').textContent.indexOf('部件覆盖') < 0; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			return {
				hasTexture: !!(TBApp.state.partOverrides.roof && TBApp.state.partOverrides.roof.texture),
				origin: document.querySelector('#inspOrigin').textContent,
				hint: document.querySelector('#inspHint').textContent
			};
		})()`, true);
		check("部件替换纹理生效", replaced.hasTexture === true, replaced.origin);
		check("替换后来源标注部件覆盖", /部件覆盖/.test(replaced.origin), replaced.origin);
		await browser.screenshot(path.join(OUT, "ui_04e_part_texture.png"));

		// ---- 4e2. 纹理库：从所有已导入纹理里挑同部件贴图 ----
		const library = await browser.eval(`(async () => {
			TBApp.selectPart(TB.ROLES.indexOf('roof'));
			document.querySelector('#inspLibrary').click();
			let cards = [];
			for (let i = 0; i < 80 && cards.length === 0; i++) {
				await new Promise(r => setTimeout(r, 100));
				cards = Array.from(document.querySelectorAll('#texGrid .tex-card'));
			}
			const styles = TBApp.state.styles.length;
			const info = {
				styles,
				count: cards.length,
				thumbed: cards.filter(c => /url\\(/.test(c.querySelector('.tex-thumb').style.backgroundImage)).length,
				subs: cards.map(c => c.querySelector('.tex-sub').textContent),
				title: document.querySelector('#texTitle').textContent,
				role: document.querySelector('#texRole').textContent,
				note: document.querySelector('#texNote').textContent,
				open: document.querySelector('#textureModal').classList.contains('open')
			};
			return info;
		})()`, true);
		check("纹理库列出所有已导入纹理的同部件贴图", library.count === library.styles && library.count >= 10, library.count + " / " + library.styles);
		check("纹理库卡片带缩略图与内置/自定义标注",
			library.thumbed === library.count && library.subs.every((s) => /内置|自定义/.test(s)),
			library.subs.slice(0, 2).join(" | "));
		check("纹理库标题标注当前部件", /纹理库/.test(library.title) && /屋顶|roof/.test(library.title + library.role), library.title + " / " + library.role);
		check("纹理库统计条数", /共 \d+ 张/.test(library.note), library.note);
		check("纹理库面板已打开", library.open === true);
		await browser.screenshot(path.join(OUT, "ui_04e2_texture_library.png"));

		// 点最后一张（非当前风格）→ 立刻替换并关闭面板
		const libPick = await browser.eval(`(async () => {
			const before = TBApp.state.partOverrides.roof ? TBApp.state.partOverrides.roof.texture : null;
			const cards = Array.from(document.querySelectorAll('#texGrid .tex-card'));
			const target = cards[cards.length - 1];
			const targetStyle = target ? target.dataset.style : null;
			if (target) target.click();
			for (let i = 0; i < 80 && !(TBApp.state.partOverrides.roof && TBApp.state.partOverrides.roof.textureFrom); i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			const ov = TBApp.state.partOverrides.roof || {};
			const part = TBApp.recipe().parts.roof || {};
			return {
				targetStyle,
				changed: !!ov.texture && ov.texture !== before,
				from: ov.textureFrom || null,
				recipeFrom: part.textureFrom || null,
				closed: !document.querySelector('#textureModal').classList.contains('open'),
				origin: document.querySelector('#inspOrigin').textContent,
				hint: document.querySelector('#inspHint').textContent
			};
		})()`, true);
		check("点击纹理库卡片即替换贴图并关闭", libPick.changed === true && libPick.closed === true, libPick.from);
		check("换图来源写入配置与配方", !!libPick.from && libPick.recipeFrom === libPick.from, libPick.recipeFrom);
		check("检查器标注纹理库来源", /纹理库/.test(libPick.origin) && /纹理库/.test(libPick.hint), libPick.origin);
		await browser.screenshot(path.join(OUT, "ui_04e2b_texture_applied.png"));

		// ---- 4e3. 纹理库「改用风格原纹理」：只撤换图，保留染色 ----
		const libClear = await browser.eval(`(async () => {
			TBApp.selectPart(TB.ROLES.indexOf('roof'));
			TBApp.openTextureLibrary();
			for (let i = 0; i < 80 && !document.querySelectorAll('#texGrid .tex-card').length; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			const flagged = document.querySelectorAll('#texGrid .tex-card .tex-flag').length;
			const clearHidden = document.querySelector('#btnTextureClear').hidden;
			document.querySelector('#btnTextureClear').click();
			for (let i = 0; i < 50 && (TBApp.state.partOverrides.roof || {}).texture; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			const ov = TBApp.state.partOverrides.roof || {};
			return {
				flagged,
				clearHidden,
				texture: ov.texture || null,
				textureFrom: ov.textureFrom || null,
				tint: ov.tint || null,
				recipeTexture: (TBApp.recipe().parts.roof || {}).texture,
				origin: document.querySelector('#inspOrigin').textContent
			};
		})()`, true);
		check("纹理库标记「使用中」的卡片", libClear.flagged === 1 && libClear.clearHidden === false, String(libClear.flagged));
		check("改用风格原纹理只撤换图", libClear.texture === null && libClear.textureFrom === null && libClear.recipeTexture === null, libClear.origin);
		check("撤换图后保留部件染色", libClear.tint === "#ff5555", String(libClear.tint));
		await browser.screenshot(path.join(OUT, "ui_04e3_texture_cleared.png"));

		// ---- 4f. 部件级描边（取消继承 → 只给 roof 加洋红外描边）----
		await browser.eval(`(() => {
			const inherit = document.querySelector('#inspOuterInherit');
			inherit.checked = false;
			inherit.dispatchEvent(new Event('change', { bubbles: true }));
			const w = document.querySelector('#inspOuter');
			w.value = '3';
			w.dispatchEvent(new Event('change', { bubbles: true }));
			const c = document.querySelector('#inspOuterColor');
			c.value = '#ff00ff';
			c.dispatchEvent(new Event('change', { bubbles: true }));
		})()`);
		await browser.waitFor(`TBApp.state.partOverrides.roof && TBApp.state.partOverrides.roof.outer === 3 && TBApp.state.partOverrides.roof.outerColor === '#ff00ff'`, 20000);
		await sleep(700);
		const partOutline = await browser.eval(`(() => {
			const d = TBApp.state.frame.data;
			let magenta = 0;
			for (let i = 0; i < d.length; i += 4) if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 255) magenta++;
			return {
				magenta,
				inherit: document.querySelector('#inspOuterInherit').checked,
				width: document.querySelector('#inspOuter').value,
				hint: document.querySelector('#inspHint').textContent
			};
		})()`);
		check("部件级外描边写入配置", partOutline.width === "3" && partOutline.inherit === false, JSON.stringify(partOutline));
		check("部件级外描边参与渲染", partOutline.magenta > 50, String(partOutline.magenta));
		check("检查器提示部件级描边覆盖全局", /外描边 3px/.test(partOutline.hint), partOutline.hint);
		await browser.screenshot(path.join(OUT, "ui_04f_part_outline.png"));

		// ---- 4g. 重置：染色 + 贴图 + 描边一起回到初始状态 ----
		await browser.eval(`document.querySelector('#inspReset').click()`);
		await browser.waitFor(`!TBApp.state.partOverrides.roof`, 20000);
		await sleep(700);
		const reset = await browser.eval(`(() => {
			const cur = TBApp.state.tiles.roof.data, snap = window.__roofBase;
			let diff = 0;
			if (cur.length !== snap.length) diff = -1;
			else for (let i = 0; i < cur.length; i++) if (cur[i] !== snap[i]) diff++;
			const d = TBApp.state.frame.data;
			let magenta = 0;
			for (let i = 0; i < d.length; i += 4) if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 255) magenta++;
			return {
				diff, magenta,
				inheritInner: document.querySelector('#inspInnerInherit').checked,
				inheritOuter: document.querySelector('#inspOuterInherit').checked,
				tint: document.querySelector('#inspTint').value,
				origin: document.querySelector('#inspOrigin').textContent,
				status: document.querySelector('#status').textContent
			};
		})()`);
		check("重置后部件纹理回到初始（不再残留染色 / 换图）", reset.diff === 0, "差异字节 " + reset.diff);
		check("重置后描边恢复继承全局", reset.inheritInner === true && reset.inheritOuter === true);
		check("重置后画面不再有部件级描边色", reset.magenta === 0, String(reset.magenta));
		check("重置后来源回到风格纹理", /风格图集|程序化/.test(reset.origin), reset.origin);
		check("重置后状态栏不再计部件覆盖", reset.status.indexOf("部件覆盖") < 0, reset.status);
		await browser.screenshot(path.join(OUT, "ui_04g_part_reset.png"));

		const background = await browser.eval(`(() => {
			const canvas = document.querySelector('#previewCanvas');
			const rect = canvas.getBoundingClientRect();
			document.querySelector('#previewWrap').dispatchEvent(new MouseEvent('click', {
				clientX: rect.left + 2, clientY: rect.top + 2, bubbles: true
			}));
			return { selection: TBApp.state.selection, hidden: document.querySelector('#inspector').hidden };
		})()`);
		check("点击背景取消选中", background.selection === null && background.hidden === true, JSON.stringify(background));

		// ---- 5. 导出当前方向（拦截 blob）----
		const single = await browser.eval(`(async () => {
			window.__blobs = [];
			const orig = URL.createObjectURL.bind(URL);
			URL.createObjectURL = (b) => { window.__blobs.push(b); return orig(b); };
			await TBApp.exportCurrent();
			const sizes = await Promise.all(window.__blobs.map(b => b.arrayBuffer().then(a => a.byteLength)));
			const head = window.__blobs.length ? new Uint8Array(await window.__blobs[0].arrayBuffer()).slice(0, 8) : [];
			return { count: sizes.length, size: sizes[0] || 0, head: Array.from(head), status: document.querySelector('#status').textContent };
		})()`, true);
		check("导出当前方向生成 1 个 PNG", single.count === 1 && single.size > 1000, JSON.stringify(single));
		check("PNG 文件头正确", single.head[0] === 137 && single.head[1] === 80, single.head.join(","));

		// ---- 6. 导出全部方向（ZIP）----
		const multi = await browser.eval(`(async () => {
			window.__blobs = [];
			await TBApp.exportAll();
			const sizes = await Promise.all(window.__blobs.map(b => b.arrayBuffer().then(a => a.byteLength)));
			const buffer = window.__blobs.length ? new Uint8Array(await window.__blobs[0].arrayBuffer()) : new Uint8Array();
			return { count: sizes.length, size: sizes[0] || 0, magic: Array.from(buffer.slice(0, 4)), status: document.querySelector('#status').textContent };
		})()`, true);
		check("导出全部方向生成 ZIP", multi.count === 1 && multi.size > 20000, multi.size + " bytes");
		check("ZIP 文件头 PK", multi.magic[0] === 0x50 && multi.magic[1] === 0x4b, multi.magic.join(","));
		check("导出状态含精灵表", /精灵表/.test(multi.status), multi.status);

		// ---- 7. 图集模板 ----
		const template = await browser.eval(`(async () => {
			window.__blobs = [];
			document.querySelector('#btnTemplate').click();
			for (let i = 0; i < 40 && !window.__blobs.length; i++) await new Promise(r => setTimeout(r, 100));
			const buffer = window.__blobs.length ? new Uint8Array(await window.__blobs[0].arrayBuffer()) : new Uint8Array();
			return { count: window.__blobs.length, size: buffer.byteLength, head: Array.from(buffer.slice(0, 4)) };
		})()`, true);
		check("下载图集模板", template.count === 1 && template.head[0] === 137 && template.size > 5000, JSON.stringify(template));

		// ---- 8. 配方 JSON ----
		const recipe = await browser.eval(`(() => { const r = TBApp.recipe(); return {
			style: r.style.id, geometry: r.style.geometry, canvas: r.view.canvas,
			directions: r.view.directions, projection: r.view.projection,
			params: Object.keys(r.profile.params).length, folder: r.outputFolder,
			toolVersion: r.toolVersion
		}; })()`);
		check("配方 JSON 含完整参数", recipe.params >= 10 && recipe.canvas[0] === 512, JSON.stringify(recipe));
		check("配方 JSON 标注工具版本 v1.0", recipe.toolVersion === "1.0", String(recipe.toolVersion));
		const folderParts = String(recipe.folder).split("/");
		check("输出目录命名符合插件规则",
			folderParts.length === 2 && /^[0-9a-f]{16}$/.test(folderParts[0]) && /^p\d+_\d+d/.test(folderParts[1]),
			recipe.folder);

		// ---- 9. 风格工坊：打开、角色卡、另存为新风格 ----
		await browser.eval(`TBApp.openWorkshop()`);
		await browser.waitFor("document.querySelectorAll('#editRoles .role-card').length === 16", 15000);
		await sleep(700);
		const workshop = await browser.eval(`({
			cards: document.querySelectorAll('#editRoles .role-card').length,
			report: document.querySelector('#editAtlasReport').textContent.slice(0, 60),
			mode: document.querySelector('#workshopModeBadge').textContent,
			thumbs: Array.from(document.querySelectorAll('#editRoles .thumb')).filter(n => /url\\(/.test(n.style.backgroundImage)).length
		})`);
		check("风格工坊 16 个角色卡", workshop.cards === 16, String(workshop.cards));
		check("16 个角色缩略图都已生成", workshop.thumbs === 16, String(workshop.thumbs));
		check("内置风格标识", /内置风格/.test(workshop.mode), workshop.mode);
		await browser.screenshot(path.join(OUT, "ui_05_workshop.png"));

		const saved = await browser.eval(`(() => {
			document.querySelector('#editName').value = '测试风格·欧式暖木';
			document.querySelector('#editName').dispatchEvent(new Event('input', { bubbles: true }));
			document.querySelector('#editGeometry').value = 'forest';
			document.querySelector('#editGeometry').dispatchEvent(new Event('change', { bubbles: true }));
			document.querySelector('#btnSaveStyle').click();
			return {
				active: TBApp.state.cfg.styleId,
				options: Array.from(document.querySelectorAll('#styleSelect option')).map(o => o.textContent),
				stored: (() => { try { return JSON.parse(localStorage.getItem('tb_topdown_styles_v1') || '[]').length; } catch (e) { return -1; } })()
			};
		})()`);
		check("另存为新风格并切换", /^user_/.test(saved.active), saved.active);
		check("风格下拉出现自定义", saved.options.some((t) => /测试风格/.test(t)), saved.options.join(" | "));
		check("自定义风格写入 localStorage", saved.stored >= 1, String(saved.stored));

		// ---- 9b. 拖入 256×256 图集：接受并显示最近邻放大说明 ----
		const upload = await browser.eval(`(async () => {
			const palette = TBApp.state.styles[0].palette;
			// 256×256 图集 = 64px/格
			const atlas = TB.proceduralAtlas(TB.paletteToRgb(palette), 'jiangnan', 64);
			const canvas = document.createElement('canvas');
			canvas.width = 256; canvas.height = 256;
			canvas.getContext('2d').putImageData(new ImageData(atlas.data, 256, 256), 0, 0);
			const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
			const file = new File([blob], 'test_atlas_256.png', { type: 'image/png' });
			const dt = new DataTransfer(); dt.items.add(file);
			const drop = document.querySelector('#editAtlasDrop');
			drop.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
			for (let i = 0; i < 40 && !(TBApp.state.workshop.draft.atlas && TBApp.state.workshop.draft.atlas.name === 'test_atlas_256.png'); i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			return {
				size: TBApp.state.workshop.draft.atlas ? TBApp.state.workshop.draft.atlas.size : 0,
				name: TBApp.state.workshop.draft.atlas ? TBApp.state.workshop.draft.atlas.name : '',
				report: document.querySelector('#editAtlasReport').textContent.replace(/\\s+/g, ' ')
			};
		})()`, true);
		check("拖入 256 图集被接受", upload.size === 256 && upload.name === "test_atlas_256.png", JSON.stringify({ size: upload.size, name: upload.name }));
		check("报告标注 64px/格 与最近邻 2× 放大",
			upload.report.indexOf("64px/格") >= 0 && upload.report.indexOf("放大 2×") >= 0,
			upload.report.slice(0, 120));
		check("报告注明无插值", /无插值|无平滑/.test(upload.report), upload.report.slice(-90));
		await browser.screenshot(path.join(OUT, "ui_05b_atlas256.png"));

		// ---- 9c. 违规图集被拒绝（非正方形）----
		const rejected = await browser.eval(`(async () => {
			const canvas = document.createElement('canvas');
			canvas.width = 512; canvas.height = 384;
			const ctx = canvas.getContext('2d');
			ctx.fillStyle = '#334455'; ctx.fillRect(0, 0, 512, 384);
			const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
			const file = new File([blob], 'bad_atlas.png', { type: 'image/png' });
			const dt = new DataTransfer(); dt.items.add(file);
			document.querySelector('#editAtlasDrop').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
			await new Promise(r => setTimeout(r, 900));
			return {
				still: TBApp.state.workshop.draft.atlas ? TBApp.state.workshop.draft.atlas.name : '',
				report: document.querySelector('#editAtlasReport').textContent.replace(/\\s+/g, ' ').slice(0, 100)
			};
		})()`, true);
		check("违规图集被拒绝", rejected.still === "test_atlas_256.png" && /不符|不能|必须|正方形/.test(rejected.report), JSON.stringify(rejected));

		// ---- 9d. 新建风格 → 清空图集 → 程序化纹理 → 保存 ----
		const procedural = await browser.eval(`(() => {
			document.querySelector('#btnNewStyle').click();
			document.querySelector('#editAtlasClear').click();
			const roofColor = document.querySelector('[data-color="roof"]');
			roofColor.value = '#7a3b52';
			roofColor.dispatchEvent(new Event('input', { bubbles: true }));
			document.querySelector('#editName').value = '测试风格·程序化';
			document.querySelector('#editName').dispatchEvent(new Event('input', { bubbles: true }));
			document.querySelector('#btnSaveStyle').click();
			const styles = TBApp.state.userStyles.filter(s => /测试风格/.test(s.name));
			return {
				active: TBApp.state.cfg.styleId,
				count: styles.length,
				atlasFree: styles.length ? styles[styles.length - 1].atlas === null : false,
				roof: styles.length ? styles[styles.length - 1].palette.roof : ''
			};
		})()`);
		check("清空图集后保存为程序化风格", procedural.atlasFree === true && procedural.roof === "#7a3b52", JSON.stringify(procedural));
		check("两个自定义风格并存", procedural.count === 2, String(procedural.count));

		// ---- 10. 关闭工坊 + 新风格渲染 ----
		await browser.eval(`document.querySelector('#btnCloseWorkshop').click()`);
		await browser.waitFor(`/^预览：/.test(document.querySelector('#status').textContent) && TBApp.state.frame && TBApp.state.frame.width === 512`, 30000);
		await sleep(300);
		const custom = await browser.eval(`({ style: TBApp.state.cfg.styleId, tris: TBApp.state.mesh.triangles, status: document.querySelector('#status').textContent })`);
		check("自定义风格可渲染", custom.tris > 1000, custom.status);
		await browser.screenshot(path.join(OUT, "ui_06_custom_style.png"));

		// ---- 10b. 部件覆盖写入配方，并持久化到配置 ----
		const persisted = await browser.eval(`(async () => {
			const f = TBApp.state.frame, W = f.width, H = f.height;
			const role = TB.ROLES.indexOf('wall');
			let idx = -1;
			for (let y = 2; y < H - 2 && idx < 0; y++) {
				for (let x = 2; x < W - 2; x++) {
					const i = y * W + x;
					if (f.pick[i] !== role) continue;
					if (f.pick[i - 2] === role && f.pick[i + 2] === role && f.pick[i - 2 * W] === role && f.pick[i + 2 * W] === role) { idx = i; break; }
				}
			}
			if (idx < 0) return { error: '画面里没有墙面像素' };
			const x = idx % W, y = Math.floor(idx / W);
			const canvas = document.querySelector('#previewCanvas');
			const rect = canvas.getBoundingClientRect();
			document.querySelector('#previewWrap').dispatchEvent(new MouseEvent('click', {
				clientX: Math.round(rect.left + (x + 0.5) / W * rect.width),
				clientY: Math.round(rect.top + (y + 0.5) / H * rect.height), bubbles: true
			}));
			const el = document.querySelector('#inspTint');
			el.value = '#88aaff';
			el.dispatchEvent(new Event('change', { bubbles: true }));
			for (let i = 0; i < 50 && !(TBApp.state.partOverrides.wall && TBApp.state.partOverrides.wall.tint === '#88aaff'); i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			return {
				selected: TBApp.state.selection,
				expected: role,
				tint: TBApp.state.partOverrides.wall ? TBApp.state.partOverrides.wall.tint : null,
				recipePart: TBApp.recipe().parts.wall || null
			};
		})()`, true);
		check("点击墙面选中 wall 部件", persisted.selected === persisted.expected, JSON.stringify({ selected: persisted.selected, expected: persisted.expected }));
		check("部件覆盖写入配方 parts", persisted.recipePart && persisted.recipePart.tint === "#88aaff", JSON.stringify(persisted.recipePart));
		await sleep(700);

		// ---- 11. 刷新后配置恢复 ----
		const beforeReload = await browser.eval(`JSON.stringify({ s: TBApp.state.cfg.styleId, t: TBApp.state.cfg.typeId, p: TBApp.state.cfg.view.pixelSize, oi: TBApp.state.cfg.render.outlineInner, oo: TBApp.state.cfg.render.outlineOuter, pw: TBApp.state.partOverrides.wall ? TBApp.state.partOverrides.wall.tint : null })`);
		await browser.ws.send("Page.reload", {});
		await browser.waitFor("!!(window.TBApp && TBApp.state && TBApp.state.frame)", 30000);
		await sleep(700);
		const afterReload = await browser.eval(`JSON.stringify({ s: TBApp.state.cfg.styleId, t: TBApp.state.cfg.typeId, p: TBApp.state.cfg.view.pixelSize, oi: TBApp.state.cfg.render.outlineInner, oo: TBApp.state.cfg.render.outlineOuter, pw: TBApp.state.partOverrides.wall ? TBApp.state.partOverrides.wall.tint : null })`);
		check("刷新后配置恢复（含部件覆盖）", beforeReload === afterReload, beforeReload + " vs " + afterReload);

		// ---- 12. 控制台错误 ----
		const errors = browser.errors.filter((e) => !/favicon|net::ERR_FILE_NOT_FOUND/i.test(e));
		check("无控制台错误", errors.length === 0, errors.slice(0, 4).join(" | "));

		console.log("\n截图位于 tools/_out/ui_*.png");
	} catch (err) {
		console.error("\n自测异常：", err);
		results.push({ name: "自测异常", ok: false, detail: err.message });
	} finally {
		await browser.close();
	}
	const failed = results.filter((r) => !r.ok).length;
	console.log("\n结果：" + (results.length - failed) + " / " + results.length + " 通过");
	process.exit(failed ? 1 : 0);
})();


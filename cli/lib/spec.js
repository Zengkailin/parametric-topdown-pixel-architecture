"use strict";
/**
 * 参数规范表：CLI 里所有枚举、数值范围、默认值集中在这一处。
 *
 * 数值范围与 index.html 面板的 min/max/step 对齐，超出范围会夹取并写进
 * 摘要的 warnings（而不是直接报错），因为 agent 常常给出「差不多」的值。
 */

const ENUMS = {
	projection: ["ortho", "persp"],
	dirs: [1, 2, 4, 8],
	size: [128, 256, 384, 512, 768, 1024, "auto"],
	scale: ["auto", "fixed"],
	look: [0, 1, 2, 3],
	roof: [0, 1, 2],
	background: ["transparent", "color"]
};

const LOOK_NAMES = ["原色", "素雅", "暖色", "风化"];

/** 建筑参数（--param k=v） */
const PARAM_SPEC = {
	width: { min: 3, max: 10, step: 0.25, note: "面宽（米）" },
	depth: { min: 0.5, max: 10, step: 0.25, note: "进深（米）" },
	floors: { min: 1, max: 3, step: 1, note: "楼层数" },
	pitch: { min: 15, max: 50, step: 1, note: "屋顶坡度（不是相机俯角）" },
	eave: { min: 0.1, max: 1, step: 0.05, note: "挑檐长度" },
	windows: { min: 1, max: 4, step: 1, note: "每开间窗数" },
	height: { min: 0.3, max: 10, step: 0.1, note: "檐口高度（barn/gate/tower 等原型用）" },
	bays: { min: 1, max: 6, step: 1, note: "开间数" },
	roof: { enum: [0, 1, 2], note: "0 按风格 / 1 双坡 / 2 平顶露台" },
	porch: { bool: true, note: "门廊" },
	balcony: { bool: true, note: "二层栏廊（需 floors≥2 且非沙漠几何）" },
	ornament: { bool: true, note: "屋顶附件与装饰" }
};

/** 视角 / 渲染参数范围 */
const RANGE = {
	pitch: { min: 0, max: 90, note: "相机俯角，90 正俯视" },
	fov: { min: 0, max: 100, note: "透视 FOV，0 = 正交极限" },
	yaw: { min: -180, max: 180, note: "起始朝向" },
	ppm: { min: 4, max: 200, note: "像素密度（像素/米）" },
	padding: { min: 0, max: 40, note: "留白百分比" },
	outlineInner: { min: 0, max: 16, note: "内描边宽度" },
	outlineOuter: { min: 0, max: 16, note: "部件外描边宽度" },
	outlineSilhouette: { min: 0, max: 16, note: "整栋轮廓描边宽度" },
	depthThreshold: { min: 0.01, max: 1, note: "描边深度阈值" },
	normalThreshold: { min: 0.01, max: 1, note: "描边法线阈值" }
};

const MAIN_HELP = `参数化 Topdown 建筑 · 命令行版（给 AI agent / 脚本用）

用法：node cli/tb.js <命令> [参数]

命令
  render    渲染建筑（全参数、多方向、精灵表、ZIP、部件覆盖）
  batch     一个进程批量渲染多张（复用图集，最省时间）
  list      列出风格 / 建筑类型 / 参数范围 / 材质角色
  schema    输出机器可读的能力清单（一条命令摸清全部参数与枚举）
  rec       配方：show 查看、apply 按配方重现
  inspect   读 PNG 内嵌配方（版本 + 视角/建筑参数），可存 recipe.json 或直接回放
  styles    自定义风格库：list / get / create / import / export / delete / set-role / template
  atlas     图集工具：check 校验 PNG 是否符合 4×4 规范
  preset    常用参数组合：save / list / show / delete

通用选项
  --json      输出完整 JSON 摘要（默认就是一行 JSON）
  --quiet     只输出产物路径（每行一个）
  --help, -h  查看子命令帮助

最短开始
  node cli/tb.js render forest inn -o out/inn.png
  node cli/tb.js render jiangnan house -p 45 -d 4 --sheet --size 512
  node cli/tb.js schema
`;

const RENDER_HELP = `render —— 把一个建筑渲染成 2D 俯视像素图

用法
  node cli/tb.js render [style] [type] [选项]

必填（都有默认值）
  -s, --style <id>      风格：见 list styles（默认 jiangnan）
  -t, --type <id>       建筑类型：见 list types（默认 house）
  -o, --out <path>      输出文件或目录（默认 cli/out/<风格>_<类型>_p<俯角>_<方向数>d.png）

建筑 / 随机
      --seed <n>        形状种子 shapeSeed（默认 60421）
      --dseed <n>       细节种子 detailSeed（默认 101）
      --aseed <n>       外观种子 appearanceSeed（默认 101）
      --param k=v       覆盖建筑参数，可重复：width depth floors pitch eave windows height bays roof porch balcony ornament
      --random          随机形状 + 细节（会把实际用到的种子写进摘要，可复现）
      --random-detail   只随机细节
      --replay          按当前种子重现形状（不随机）
      --look 0..3       色调：0 原色 / 1 素雅 / 2 暖色 / 3 风化

视角 / 画布
  -p, --pitch <0..90>   相机俯角（默认 45；90 正俯视，0 平视出立面）
      --proj ortho|persp（默认 ortho）
      --fov <0..100>    透视 FOV（默认 50；0 = 正交极限）
  -d, --dirs 1|2|4|8    方向数（默认 1）
      --yaw <-180..180> 起始朝向（默认 0）
      --size 128|256|384|512|768|1024|auto（默认 512）
      --scale auto|fixed（默认 auto）
      --ppm <4..200>    像素密度（fixed / auto 时生效，默认 48）
      --padding <0..40> 留白百分比（默认 8）

描边 / 背景
      --outline-inner <px>      内描边（几何内侧，按部件分界）
      --outline-outer <px>      部件外描边（每部件向外扩）
      --outline-silhouette <px> 整栋剪影描边
      --outline-color <#hex>    内描边颜色（默认 #140f0d）
      --outline-color-outer <#hex>
      --outline-color-silhouette <#hex>
      --no-aa                   关抗锯齿（像素风建议关）
      --bg transparent|#hex     背景（默认透明）

部件级覆盖（材质角色：见 list roles）
      --part roof:tint=#ffcc00        只给屋顶染色
      --part roof:texture=./tile.png  只给屋顶换贴图（自动最近邻缩放到 64/128）
      --part roof:outer=3             只给屋顶加外描边
      --part roof:outerColor=#e0b95f  外描边颜色
      --part roof:inner=1 --part roof:innerColor=#000
      --parts-json '{"roof":{"tint":"#ffcc00"}}'   整块传（也可给文件路径）

产物
      --sheet           额外输出精灵表 sheet.png
      --zip             打包 <名称>.zip（dir_N.png + sheet.png + recipe.json）
      --recipe <file>   以配方 JSON 为输入（也接受内嵌配方的 PNG；命令行选项覆盖配方）
      --save-recipe <f> 写出配方 JSON
      --thumb [px]      额外输出缩略图（默认 128，写 <名称>_thumb_<px>.png）
      --name <slug>     自定义产物基名
      --dry-run         只解析配置并回显，不渲染（校验参数最省时间）
      --no-meta         不写内嵌元信息（默认写入：版本 + 完整配方，可用 inspect 回读）

示例
  node cli/tb.js render forest inn -p 30 -d 4 --sheet --out out/inn
  node cli/tb.js render jiangnan house --param floors=2 --param width=8 -o out/big.png
  node cli/tb.js render desert tower --no-aa --outline-silhouette 2 --thumb -o out/t.png
  node cli/tb.js render --recipe out/inn/recipe.json -o out/again
  node cli/tb.js render --recipe out/inn/dir_0.png -o out/again
`;

const INSPECT_HELP = `inspect —— 读取 PNG 里内嵌的生成参数（v1.1 起默认写入）

用法
  node cli/tb.js inspect <image.png> [--full] [--save-recipe <file>]

输出（默认一行 JSON）
  toolVersion / format / generatedAt   工具版本、元信息格式、生成时间（若存在）
  style / type / canvas / dirs          建筑与画布
  pitch / proj / fov / baseYaw          视角参数
  scaleMode / ppm / padding             缩放与留白
  seeds / params / look / parts         建筑参数与部件覆盖
  render                                描边 / 抗锯齿 / 背景
  textures                              included / omitted（贴图是否内嵌）

选项
  --full               连同完整配方（recipe 字段）一起输出
  --save-recipe <file> 把内嵌配方存成 recipe.json（可直接给 render --recipe / 网页）

回放
  node cli/tb.js rec apply <image.png> -o out/again

说明
  元信息写在 PNG 的 ancillary 文本块（Software / topdown:version / topdown:recipe），
  不影响像素；用 v1.1 之前的版本或 --no-meta 导出的图没有该信息。
`;

const BATCH_HELP = `batch —— 单进程批量渲染（图集与材质只解析一次）

用法
  node cli/tb.js batch <manifest.json|->        （- 表示从 stdin 读）

清单格式
  {
    "out": "out/batch1",              // 可选：统一输出目录
    "defaults": { "style": "jiangnan", "pitch": 45, "size": 512 },
    "jobs": [
      { "type": "house", "name": "a" },
      { "type": "inn", "style": "forest", "dirs": 4, "sheet": true },
      { "style": "desert", "type": "watchtower", "pitch": 30, "out": "out/w.png" }
    ]
  }

每个 job 的键与 render 的选项同名（去掉 --），例如 pitch / dirs / param / part / thumb。
jobs 里出现 "param": {"floors": 2} 这种对象写法也可以。
`;

const LIST_HELP = `list —— 列出可选值（默认紧凑、一行一项，适合 agent 直接读）

  node cli/tb.js list styles            风格：id 名称 几何 来源
  node cli/tb.js list types [--style id] 建筑类型：id 分类 原型 名称
  node cli/tb.js list params [type]     建筑参数：名称 默认 最小 最大 步长
  node cli/tb.js list roles             材质角色（--part 用）
  node cli/tb.js list enums             所有枚举（投影/方向/尺寸/色调…）
  node cli/tb.js list presets           参数预设
加 --json 输出结构化数组。
`;

const SCHEMA_HELP = `schema —— 一条命令拿到全部能力（命令、枚举、参数范围、示例）

  node cli/tb.js schema          精简（约 2KB，默认）
  node cli/tb.js schema --full   追加每个建筑类型的默认参数
`;

const STYLES_HELP = `styles —— 自定义风格库（存放在 cli/styles/*.json，格式与网页「风格包」一致）

  node cli/tb.js styles list
  node cli/tb.js styles get <id>
  node cli/tb.js styles create --atlas <atlas.png> --name "我的江南" [--id user_x] [--geometry jiangnan]
  node cli/tb.js styles create --palette roof=#425b61,wall=#e1dec8 --name "纯色风" [--geometry forest]
  node cli/tb.js styles set-role <id> --role roof --image <roof.png>
  node cli/tb.js styles template <id> -o out/template.png      导出 4×4 图集模板（128/格）
  node cli/tb.js styles export <pack.json> [id...]             导出风格包（可拖回网页「导入风格包」）
  node cli/tb.js styles import <pack.json>                     导入风格包
  node cli/tb.js styles delete <id>
`;

const ATLAS_HELP = `atlas —— 图集校验

  node cli/tb.js atlas check <atlas.png>
    检查：正方形 / 边长能被 4 整除 / 64..4096 / 每格是否全透明或接近纯色
`;

const PRESET_HELP = `preset —— 常用参数组合（cli/presets/<name>.json）

  node cli/tb.js preset save <name> [render 的任意选项]
  node cli/tb.js preset list
  node cli/tb.js preset show <name>
  node cli/tb.js preset delete <name>
  node cli/tb.js render --preset <name> [再覆盖其它选项]
`;

const RECIPE_HELP = `rec —— 配方（与网页导出的 recipe.json 完全兼容）

  node cli/tb.js rec show <recipe.json|image.png>      解析并回显关键配置
  node cli/tb.js rec apply <recipe.json|image.png> [选项]  按配方渲染（等价 render --recipe）

  PNG 会先读内嵌元信息（v1.1 起默认写入），再按配方回放；
  图片由旧版本 / --no-meta 导出时没有元信息，会提示先 inspect 确认。
`;

/** 编辑距离（只用于「你是不是想输入 xxx」的提示，短字符串足够快）。 */
function distance(a, b) {
	const rows = a.length + 1, cols = b.length + 1;
	let prev = new Array(cols);
	let cur = new Array(cols);
	for (let j = 0; j < cols; j++) prev[j] = j;
	for (let i = 1; i < rows; i++) {
		cur[0] = i;
		for (let j = 1; j < cols; j++) {
			const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
		}
		const swap = prev; prev = cur; cur = swap;
	}
	return prev[cols - 1];
}

/** 从候选里挑最像的几个 id，用于错误提示。 */
function suggest(word, candidates, limit) {
	const target = String(word || "").toLowerCase();
	if (!target) return [];
	const scored = [];
	(candidates || []).forEach(function (id) {
		const text = String(id).toLowerCase();
		let score = distance(target, text);
		if (text.indexOf(target) >= 0 || target.indexOf(text) >= 0) score = 0;
		scored.push({ id: id, score: score });
	});
	scored.sort(function (a, b) { return a.score - b.score; });
	const max = limit || 3;
	return scored.filter(function (row) { return row.score <= Math.max(2, Math.ceil(target.length / 3)); })
		.slice(0, max).map(function (row) { return row.id; });
}

function clampNumber(name, value, spec, warnings) {
	const n = Number(value);
	if (!isFinite(n)) {
		warnings.push(name + " 不是数字，已忽略");
		return undefined;
	}
	if (spec.enum) {
		const picked = spec.enum.reduce(function (best, candidate) {
			return Math.abs(candidate - n) < Math.abs(best - n) ? candidate : best;
		}, spec.enum[0]);
		if (picked !== n) warnings.push(name + "=" + n + " 不在枚举内，已取 " + picked);
		return picked;
	}
	let out = n;
	if (spec.min !== undefined && out < spec.min) { out = spec.min; warnings.push(name + " 低于下限，已夹到 " + spec.min); }
	if (spec.max !== undefined && out > spec.max) { out = spec.max; warnings.push(name + " 高于上限，已夹到 " + spec.max); }
	if (spec.step && spec.step > 0) out = Math.round(out / spec.step) * spec.step;
	return out;
}

module.exports = {
	ENUMS, LOOK_NAMES, PARAM_SPEC, RANGE,
	MAIN_HELP, RENDER_HELP, BATCH_HELP, LIST_HELP, SCHEMA_HELP,
	STYLES_HELP, ATLAS_HELP, PRESET_HELP, RECIPE_HELP, INSPECT_HELP,
	clampNumber, suggest, distance
};

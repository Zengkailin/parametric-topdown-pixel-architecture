# AGENTS.md — 给 AI agent 的起始指引

本仓库把**参数化 3D 建筑**渲染成**2D 俯视像素图**，零依赖、不联网。
两种入口：网页 UI（人用）、命令行（**你有且只需要这个**）。需要 Node 18+，无需 `npm install`。

---

## 0. 30 秒上手

```bat
node cli/tb.js schema                      :: 一次拿到全部枚举/范围/示例（约 2KB）
node cli/tb.js render forest inn -o out/inn.png
```

- stdout 默认**只有一行 JSON 摘要**；成功退出码 0，失败退出码 1（stderr 也是 JSON）。
- 想省 token：`--quiet`（只回产物路径）、`--dry-run`（只校验参数不出图）。
- 想确认效果：看摘要里的 `ink` / `bbox` / `visible`，或加 `--thumb` 拿一张缩略图。

---

## 1. 铁律

1. **不要读 `js/atlases.js`**（7.6MB base64 图集）。需要什么信息用 `list` / `schema` 查。
2. **不要用 `tools/` 下的零散调试脚本**（参数写死、功能不全），它们是开发自测。
3. **不要改 `js/` 和 `index.html`**：那是网页端共用内核，CLI 只是调用者。
4. **批量别 for 循环**：每次 `node cli/tb.js render` 都要重新加载内核；多张图用 `batch`（一个进程，实测 8 张 256px 约快 2.8 倍，张数越多越明显）。
5. **参数越界不报错**：会被夹到合法区间并写进 `warnings`，先看 `warnings` 再看图。
6. 输出路径是相对当前工作目录、统一正斜杠；默认落在 `cli/out/`。

---

## 2. 摘要字段怎么用

```json
{"ok":true,"style":"forest","type":"inn","canvas":[512,512],"dirs":1,"pitch":45,"proj":"ortho",
 "tris":7944,"ink":0.459,"bbox":[99,22,412,482],"ms":318,"seeds":[60421,101,101],
 "files":["cli/out/inn.png"],"visible":["roof","wood","wall","stone"]}
```

| 字段 | 判断什么 |
|---|---|
| `ink` | 画面覆盖率。≈0 → 空白/参数错；>0.95 → 顶满画面，加 `--padding` 或换 `--size` |
| `bbox` | 不透明像素包围盒，明显偏心说明构图有问题 |
| `tris` | 几何面数，0 或异常小说明类型/参数组合没生成几何 |
| `seeds` | 随机种子，配合 `--seed/--dseed/--aseed` + `--replay` 可像素级复现 |
| `meta` | 内嵌元信息：`{version, format, textures}`；`--no-meta` 时为 `false` |
| `visible` | 可见材质角色，直接对应 `--part` 的 role |
| `warnings` | 被夹取的参数，出现就说明你写的值不合法 |

---

## 3. 常用命令（可直接复制）

```bat
:: 出图
node cli/tb.js render forest inn -o out/inn.png
node cli/tb.js render inn                              :: 单个位置参数按建筑类型理解
node cli/tb.js render jiangnan inn -d 8 --sheet --zip -o out/inn8

:: 立面图（俯角 0 + 透视 FOV 0 = 正交极限）
node cli/tb.js render forest inn --pitch 0 --proj persp --fov 0 -o out/elev.png

:: 像素风
node cli/tb.js render jiangnan_pixel house --no-aa --outline-silhouette 2 --size 256 -o out/px.png

:: 改建筑参数（屋顶坡度走 --param，不是 --pitch）
node cli/tb.js render jiangnan house --param floors=2 --param width=8 --param roof=2

:: 部件级覆盖
node cli/tb.js render jiangnan house --part roof:tint=#e0b95f --part roof:outer=2
node cli/tb.js render jiangnan house --parts-json parts.json

:: 随机 → 复现
node cli/tb.js render forest house --random          :: 摘要里有实际种子
node cli/tb.js render forest house --seed 12345 --replay

:: 图片自带配方（v1.1，默认写入）：读回 / 直接重画
node cli/tb.js inspect out/inn.png                   :: 版本 + 视角/建筑参数
node cli/tb.js inspect out/inn.png --save-recipe out/a.json
node cli/tb.js rec apply out/inn.png -o out/again

:: 批量（推荐）
node cli/tb.js batch jobs.json
```

`jobs.json`：

```json
{
  "out": "out/batch1",
  "defaults": { "pitch": 45, "size": 256, "thumb": 96 },
  "jobs": [
    { "name": "house", "style": "jiangnan", "type": "house" },
    { "name": "inn4", "style": "jiangnan", "type": "inn", "dirs": 4, "sheet": true },
    { "style": "desert", "type": "watchtower", "pitch": 30, "param": { "floors": 3 } }
  ]
}
```

---

## 4. 参数地图（坑都在这）

| 项 | 取值 | 备注 |
|---|---|---|
| `--style` | 见 `list styles`（10 内置 + `cli/styles` 自定义） | 默认 `jiangnan` |
| `--type` | 见 `list types`（46 种） | 默认 `house` |
| `--pitch` | 0–90 | **相机俯角**。屋顶坡度是 `--param pitch=15..50` |
| `--proj` / `--fov` | `ortho` / `persp`；0–100 | `persp` + `fov 0` 等于正交 |
| `--dirs` | 1 / 2 / 4 / 8 | 只有这四个 |
| `--size` | 128/256/384/512/768/1024/`auto` | `auto` 配 `--ppm`（4–200） |
| `--scale` | `auto` / `fixed` | fixed = 固定像素密度 |
| `--look` | 0–3 | 原色/素雅/暖色/风化 |
| `--outline-inner/outer/silhouette` | 0–16 | 内描边 / 部件外描边 / 整栋轮廓 |
| `--bg` | `transparent` 或 `#rrggbb`（`#` 可省） | 给了颜色后 `ink` 按“与背景不同”统计 |
| `--param` | `width depth floors pitch eave windows height bays roof porch balcony ornament` | 可重复；范围见 `list params <type>` |
| `--part` | `<role>:<key>=<value>`，key ∈ `tint/texture/inner/innerColor/outer/outerColor` | role 见 `list roles`（16 个） |
| `--no-meta` | 开关 | 关闭 PNG 内嵌元信息（默认写入工具版本 + 完整配方，`inspect` 可回读） |

输出规则：

- 不给 `-o`：`cli/out/<风格>_<类型>_p<俯角>_<方向数>d.png`
- `-o` 以 `.png` 结尾 且 单方向、无 `--sheet/--zip` → 写这个文件
- 其余情况 `-o` 视为**目录**：`dir_0.png … dir_N.png`，可选 `sheet.png`、`<目录>.zip`

---

## 5. 查信息就这三条

```bat
node cli/tb.js schema --full            :: 命令/枚举/范围/每类型默认参数/示例
node cli/tb.js list styles              :: id 名称 几何 来源
node cli/tb.js list types --style forest:: id 分类 原型 中文名
node cli/tb.js list params inn          :: 参数 默认 范围 是否显示
node cli/tb.js list roles               :: 16 个材质角色（--part 用）
```

---

## 6. 配方与预设（复用已有配置）

```bat
node cli/tb.js rec show out/inn8/recipe.json      :: 看配方解析结果
node cli/tb.js rec apply out/inn8/recipe.json -o out/again
node cli/tb.js inspect out/inn8/dir_0.png         :: 直接读图片自带配方（v1.1）
node cli/tb.js rec apply out/inn8/dir_0.png -o out/again
:: 网页侧等价入口：预览下方「导入图片配方」，能读网页与 CLI 导出的 PNG
node cli/tb.js preset save pixel --style jiangnan_pixel --no-aa --size 256
node cli/tb.js render --preset pixel -t house -o out/px.png
```

配方 JSON 与网页端导出的 `recipe.json` 双向兼容（含 `config` 字段可精确回放）。

---

## 7. 自定义风格（需要时再看）

```bat
node cli/tb.js styles template jiangnan -o out/tpl.png          :: 4×4 图集模板
node cli/tb.js atlas check out/tpl.png                          :: 校验规范
node cli/tb.js styles create --atlas out/tpl.png --name "我的江南" --geometry jiangnan --id user_mine
node cli/tb.js styles create --palette roof=#425b61,wall=#e1dec8 --name "纯色风"
node cli/tb.js styles set-role user_mine --role roof --image roof.png
node cli/tb.js styles export out/pack.json
node cli/tb.js styles import out/pack.json
node cli/tb.js render --style-file out/pack.json -t inn -o out/a.png
```

图集规范：正方形、边长能被 4 整除（建议 512/1024）、16 格顺序固定（见 `README.md` 第四节）。

---

## 8. 文件地图

```
cli/tb.js          命令入口（render/batch/list/schema/rec/styles/atlas/preset）
cli/lib/           png 编解码、参数规范、配置与配方、内嵌元信息、渲染引擎、风格库
js/pngmeta.js      网页导出的 PNG 元信息写入（块名与 CLI 一致）
cli/styles/        自定义风格（*.json，与网页 localStorage 同构）
cli/presets/       参数预设
cli/out/           默认产物目录（已 gitignore）
cli/.cache/        图集解码缓存（按 js/atlases.js 的体积+mtime 自动失效）
cli/selftest.js    端到端自测：node cli/selftest.js（34 组）
cli/README.md      完整手册（含全部选项说明，按需再读）
```

---

## 9. 出问题先看这里

| 现象 | 处理 |
|---|---|
| `未知风格/类型` | 错误里已给「相近的有 …」，或 `list styles|types` |
| 图是空白 | 看 `ink`；多半是 `--param` 组合把几何挤没了，`--dry-run` 看 `tris` |
| 物体太小/太大 | 调 `--padding`（0–40）或换 `--size` |
| 边缘发软 | `--no-aa`，并把 `--size` 设为最终放大倍数的整数倍 |
| `inspect` 说没有内嵌配方 | 图片来自 v1.1 之前或用了 `--no-meta`；重新 `render` 一次即可 |
| 想改 CLI | 改完跑 `node cli/selftest.js`，别动 `js/` |

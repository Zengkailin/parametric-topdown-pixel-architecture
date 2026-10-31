# 命令行版（给 AI agent / 脚本用）

同一套几何、材质、光栅化，换成命令行出口。**零依赖**，只要 Node 18+，不需要 `npm install`。

> AI agent 请先读仓库根目录的 [`AGENTS.md`](../AGENTS.md)：它是精简版起步指引（铁律 + 命令配方 + 参数地图），
> 本文是完整手册，只在需要细节时再翻。

```bat
node cli/tb.js render forest inn -o out/inn.png
node cli/tb.js render jiangnan house -p 45 -d 4 --sheet --size 512
node cli/tb.js schema
```

Windows 下可用根目录的 `tb.cmd`：`tb render forest inn -o out/inn.png`（PowerShell 要写 `.\tb.cmd ...`）。

---

## 1. 输出约定（为省 token 设计）

- **默认 stdout 只有一行 JSON 摘要**，不打印日志、不打印进度：

```json
{"ok":true,"style":"jiangnan","type":"house","canvas":[512,512],"dirs":1,"pitch":45,"proj":"ortho",
 "tris":8226,"ink":0.417,"bbox":[35,76,476,476],"ms":212,"seeds":[60421,101,101],
 "files":["cli/out/jiangnan_house_p45_1d.png"]}
```

| 字段 | 含义 |
|---|---|
| `canvas` / `dirs` | 单帧画布尺寸、方向数 |
| `tris` | 几何三角面数 |
| `ink` | 画面覆盖率（0–1）。≈0 说明空白或参数不对；>0.95 说明建筑顶满画面（留白不足） |
| `bbox` | 不透明像素包围盒 `[x0,y0,x1,y1]`，可判断构图是否偏心 |
| `visible` | 可见材质角色（`--part` 用同一套名字） |
| `files` / `thumbs` / `sheet` / `zip` / `recipe` | 产物路径 |
| `warnings` | 参数被夹取等提示（不是错误） |

- `--quiet`：只输出产物路径，每行一个（管道最省 token）。
- 失败：退出码 1，stderr 输出 `{"ok":false,"error":"...","hint":"..."}`。
- `--thumb [px]`：额外写一张缩略图（默认 128px），视觉模型可直接看效果。
- `--dry-run`：只解析参数并回显（`params` / `canvas` / `tris` / `warnings`），不出图，最省时间。

---

## 2. 命令

| 命令 | 作用 |
|---|---|
| `render` | 渲染：全参数、1/2/4/8 方向、精灵表、ZIP、部件覆盖、缩略图 |
| `batch` | 单进程批量渲染（清单 JSON 或 stdin），图集只解析一次 |
| `list` | `styles` / `types` / `params` / `roles` / `enums` / `presets` |
| `schema` | 一条命令拿到全部枚举、参数范围、默认值、示例（约 2KB） |
| `rec` | `show` 查看配方、`apply` 按配方重现（JSON 与 PNG 都可以） |
| `inspect` | 读 PNG 内嵌配方：版本 + 视角/建筑参数；`--full` 看完整配方，`--save-recipe` 存 JSON |
| `styles` | 自定义风格库：`list/get/create/set-role/template/export/import/delete` |
| `atlas` | `check` 校验 PNG 是否符合 4×4 图集规范 |
| `preset` | 常用参数组合：`save/list/show/delete` |

每个命令都有 `--help`：`node cli/tb.js render --help`。

---

## 3. 常用配方

```bat
:: 最小调用（一切都用默认值）
node cli/tb.js render
node cli/tb.js render forest inn -o out/inn.png

:: 8 方向 + 精灵表 + 打包
node cli/tb.js render jiangnan inn -d 8 --sheet --zip -o out/inn8

:: 平视立面图（俯角 0 + 透视 FOV 0 = 正交极限）
node cli/tb.js render forest inn --pitch 0 --proj persp --fov 0 -o out/elev.png

:: 像素风：关抗锯齿 + 轮廓描边 + 小画布
node cli/tb.js render jiangnan_pixel house --no-aa --outline-silhouette 2 --size 256 -o out/px.png

:: 改建筑参数（屋顶坡度也是 pitch，但要走 --param）
node cli/tb.js render jiangnan house --param floors=2 --param width=8 --param roof=2

:: 部件级覆盖：只给屋顶染色 / 换贴图 / 加外描边
node cli/tb.js render jiangnan house --part roof:tint=#e0b95f
node cli/tb.js render jiangnan house --part roof:texture=./tile.png --part roof:outer=2
node cli/tb.js render jiangnan house --parts-json parts.json

:: 随机建筑（摘要里会回实际的种子，可复现）
node cli/tb.js render forest house --random

:: 复现某个配方（网页导出的 recipe.json 也能直接用）
node cli/tb.js rec show out/inn8/recipe.json
node cli/tb.js render --recipe out/inn8/recipe.json -o out/again

:: 图片自带配方：读回参数 / 直接重画（v1.1）
node cli/tb.js inspect out/inn.png
node cli/tb.js inspect out/inn.png --full --save-recipe out/again_recipe.json
node cli/tb.js rec apply out/inn.png -o out/again

:: 存一套常用参数，之后只写名字
node cli/tb.js preset save pixel --style jiangnan_pixel --no-aa --outline-inner 1 --size 256
node cli/tb.js render --preset pixel -t house -o out/px.png

:: 批量（一个进程；实测 8 张 256px 比循环调用快约 2.8 倍，张数越多越明显）
node cli/tb.js batch jobs.json
```

`jobs.json`：

```json
{
  "out": "out/batch1",
  "defaults": { "pitch": 45, "size": 256, "thumb": 96 },
  "jobs": [
    { "name": "jn_house", "style": "jiangnan", "type": "house" },
    { "name": "jn_inn4", "style": "jiangnan", "type": "inn", "dirs": 4, "sheet": true },
    { "style": "desert", "type": "watchtower", "pitch": 30, "param": { "floors": 3 } }
  ]
}
```

批量输出：`<out>/<name>/dir_0.png`、`sheet.png`；摘要里 `count/failed/errors` 一目了然。

---

## 4. Godot 预制体导出（可选，v1.2）

普通 PNG 输出完全不受影响；需要时额外生成一张裁剪 PNG 和一个纯内置节点的 `.tscn`：

```bat
node cli/tb.js render forest inn --size auto --scale fixed --ppm 64 --no-aa ^
  --godot-project D:/YourGodotProject ^
  --godot-texture res://prefab/village/inn.png ^
  --godot-prefab  res://prefab/village/inn.tscn ^
  -o out/inn.png
```

| 选项 | 说明 |
|---|---|
| `--godot-prefab <path>` | 启用导出；`.tscn` 路径（本地或 `res://`） |
| `--godot-texture <res://...>` | 写进 `.tscn` 的贴图路径；裁剪后的 PNG 落在同一路径 |
| `--godot-project <dir>` | `res://` 映射到的 Godot 工程根目录（`res://` 路径必填） |
| `--godot-margin <px>` | 裁剪留边，默认 6 |
| `--godot-name <name>` | 根节点名，默认取 `.tscn` 文件名 |

节点结构与口径：

```
StaticBody2D (collision_layer=1, collision_mask=0)
├─ CollisionPolygon2D   ← 地基台基（w+0.24 × d+0.24）当前相机下的投影四边形
├─ Sprite2D             ← offset 让世界原点（地基中心）落在节点原点
└─ 遮挡层 (Area2D)
   └─ CollisionPolygon2D × N ← 不透明覆盖（填内部镂空）扣除碰撞区、只保留基点（地基中心）以上后，每块连通区域的外轮廓
```

- 不挂脚本、不含 `StippleShadow`；俯角 45° 时进深按 `sin45°` 压缩，与精灵底座对齐。
- 预制体取第 1 个方向；需透明背景；俯角过低导致地基投影退化时报错。
- 摘要新增 `prefab` / `prefabTexture` / `prefabStats`；`--quiet` 也会输出这两个路径。
- `batch` 的 job 同样支持上面 5 个键。

---

## 5. 自定义风格（与网页互通）

```bat
:: 导出当前风格 4×4 图集模板（128/格），画完再导入
node cli/tb.js styles template jiangnan -o out/tpl.png

:: 校验：正方形 / 能被 4 整除 / 每格是否全透明或接近纯色
node cli/tb.js atlas check out/tpl.png

:: 建风格（两种来源：整张图集 / 调色板程序化）
node cli/tb.js styles create --atlas out/tpl.png --name "我的江南" --geometry jiangnan --id user_mine
node cli/tb.js styles create --palette roof=#425b61,wall=#e1dec8 --name "纯色风" --geometry forest

:: 单角色覆盖贴图
node cli/tb.js styles set-role user_mine --role roof --image roof.png

:: 风格包导入导出（网页「风格工坊」导出的 JSON 可直接 import）
node cli/tb.js styles export out/pack.json
node cli/tb.js styles import out/pack.json

:: 直接用风格包渲染，不写进风格库
node cli/tb.js render --style-file out/pack.json -t inn -o out/a.png
```

风格存放在 `cli/styles/*.json`，结构与网页 localStorage 里的自定义风格完全一致。

---

## 6. 目录与缓存

```
cli/
├─ tb.js              入口（命令分发）
├─ lib/               png 编解码、参数规范、配置/配方、渲染引擎、风格库
├─ styles/            自定义风格库（*.json，含内嵌图集）
├─ presets/           参数预设
├─ out/               默认产物目录（可 gitignore）
└─ .cache/            图集解码缓存（按 js/atlases.js 的体积+mtime 自动失效）
```

- 首次运行会把内置图集解码进 `.cache/`，之后单次渲染约 0.4s；`batch` 只付一次加载成本。
- `TB_NO_CACHE=1` 可禁用缓存。
- 参数越界不会报错，会夹到合法区间并写进 `warnings`；未知 id 会给出「相近的有 …」提示。

---

## 7. 图片内嵌元信息（v1.1）

每张导出的 PNG（单帧、精灵表、缩略图、ZIP 内的帧）默认写入三个 **PNG 文本块**。它们都是 ancillary chunk，放在 IHDR 之后，**像素数据一个字节都不改**，看图软件、游戏引擎导入都不会受影响：

| 文本块 | 类型 | 内容 |
|---|---|---|
| `Software` | tEXt | `topdown-building-studio-cli 1.2` |
| `topdown:version` | tEXt | 工具版本号 |
| `topdown:recipe` | iTXt | 完整配方 JSON（UTF-8，deflate 压缩） |

```bat
node cli/tb.js inspect out/inn.png                    :: 版本 + 视角/建筑参数（默认一行 JSON）
node cli/tb.js inspect out/inn.png --full              :: 追加完整 recipe 字段
node cli/tb.js inspect out/inn.png --save-recipe a.json
node cli/tb.js rec apply out/inn.png -o out/again      :: PNG 直接当配方
node cli/tb.js render --recipe out/inn.png -o out/again :: 同上，写法不同
node cli/tb.js render forest inn --no-meta             :: 关闭内嵌（默认开启）
```

`inspect` 输出字段：`toolVersion / format / generatedAt / style / type / canvas / dirs / pitch / proj / fov / baseYaw / scaleMode / ppm / padding / seeds / params / look / parts / render / textures`。

约定：

- **不含时间戳**：同一组参数渲染出的 PNG 逐字节相同（现有自测「随机可复现」按字节比较）。
- **贴图剥离**：部件贴图是 dataURL、体积大，入图时替换为 `textureFrom / textureBytes / textureCrc32`，`textures` 标记为 `omitted`，`inspect` 会给 `warnings`；复现时重新指定 `--part <角色>:texture=<文件>`。
- **网页互通**：网页版导出写同样的块名与 JSON 结构（`js/pngmeta.js`），CLI 的 `inspect` 可直接读网页导出的图；反之网页导出的 `recipe.json` 也照常可用。网页预览下方的「导入图片配方」按钮就是网页侧的 `inspect` + `rec apply`，能读 CLI 导出的图。
- 旧版本或 `--no-meta` 导出的图没有该信息，`inspect` 会以退出码 1 + `hint` 说明。
- `batch` 的 job 同样支持 `"meta": false`。

---

## 8. 自测

```bat
node cli/selftest.js
```

会跑 37 组端到端用例（发现类命令、各种渲染选项、内嵌元信息往返（含网页写入互通）、配方/预设/批量、风格库增删改查、错误路径），
临时风格与预设会自动清理，产物默认也在结束时清掉；想留下图片检查就加 `--keep`（留在 `cli/out/selftest/`）。
改完 CLI 代码后跑一遍，避免回归。

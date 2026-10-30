# 参数化 Topdown 建筑工坊（网页版）

把**参数化 3D 建筑**一键渲染成 **2D 俯视像素图**的本地网页工具。

- 内置 10 种建筑风格、46 种建筑类型，支持正交 / 透视、多角度、精灵表导出。
- **纯前端、零依赖、不联网**：不依赖 Godot，不需要启动服务器，双击即可用。
- 配套 Godot 插件 `addons/hd2d_scene_tools`（v5/v6 配方），按相同几何与参数移植。

---

## 一、环境配置（先看这里）

| 你是谁 | 需要安装什么 | 说明 |
|---|---|---|
| **普通用户**（只用工具出图） | **什么都不用装** | 双击 `index.html` 即可，见下方「快速开始」。 |
| **AI agent / 自动化脚本** | **Node.js 18+**（无需 npm install） | 用 `node cli/tb.js ...` 调同一套渲染，见「七、命令行」。 |
| **开发者**（改源码 / 跑自测 / 重新生成材质） | Python 3.10+（含 `Pillow`）和 / 或 Node.js 18+ | 仅 `tools/` 下的脚本需要，详见文末「开发者」一节。 |

> 普通出图**不需要** Node.js、Python，也不需要任何 `npm install`。`js/atlases.js` 体积较大（约 7.6 MB）是因为内嵌了 10 套图集，目的是让你在 `file://` 下双击也能读到像素数据。

### 浏览器要求
使用 **Chrome 或 Edge**（推荐）。少数浏览器在 `file://` 下会限制内嵌数据解码，改用本地服务器即可（见「常见问题」）。

---

## 二、快速开始

**方式 A：双击打开（最简单）**
1. 下载并解压整个项目文件夹。
2. 双击 `启动工具.bat`（或 `index.html`），会用默认浏览器打开工具。
3. 推荐窗口分辨率 **1600×1000** 以上。

**方式 B：本地服务器（如遇到空白页）**
```bat
cd 参数化topdown建筑
python -m http.server 8000
:: 浏览器访问 http://localhost:8000/
```

打开后：
- 左侧选「风格」和「建筑类型」，右侧实时预览。
- 滚轮缩放、拖拽平移、双击复位预览画面。

---

## 三、基本使用流程

1. **选风格 / 建筑**
   - 左侧「风格」下拉选 10 种内置风格之一（江南古镇、欧式、日式町屋、中式宫阙、哥特、蒸汽工业……）。
   - 下方选建筑类型与参数（宽 / 深 / 楼层 / 坡度 / 窗列 / 屋顶形态等），或点「随机建筑」。

2. **调视角**
   - 投影：正交（无透视）或透视（设 FOV）。
   - 俯角、方向数（1/2/4/8）、画面尺寸、留白、描边、背景等按需调整。

3. **导出**
   - 「② 导出当前方向」：存单张 PNG。
   - 「③ 导出全部方向」：打包 ZIP，内含 `dir_0.png … dir_N.png`、`sheet.png`（精灵表）、`recipe.json`（配方）。
   - 「下载图集模板」：导出当前风格 4×4 图集，方便画师重绘后重新导入。
   - **v1.1 起，导出的每张 PNG 都内嵌生成参数**（工具版本 + 完整配方，写在 PNG 文本块里，不影响像素），可用命令行 `inspect` 读回，见「七、命令行」。

4. **自定义风格（风格工坊）**
   - 点顶部「风格工坊」，上传自己的 4×4 图集（或逐角色单图 / 调色板），另存为新风格。
   - 点预览画面的任意部位，可查看该部件纹理、单独染色 / 换图 / 描边 / 重置，并写进配方。

> 所有参数会自动保存在浏览器 `localStorage`，刷新不丢。

---

## 四、材质图集规范（自定义风格时看）

- 正方形 PNG，边长能被 4 整除，建议 **512（128px/格）** 或 **1024（256px/格）**。
- **4×4 = 16 格，顺序固定**：

| 行 | 列 1 | 列 2 | 列 3 | 列 4 |
|---|---|---|---|---|
| 1 | `roof` 屋顶瓦 | `wood` 木构件 | `wall` 墙面 | `stone` 石作 |
| 2 | `trim` 饰条 | `glass` 玻璃 | `cloth` 布幔 | `metal` 金属 |
| 3 | `shadow` 内影 | `accent` 点缀 | `door` 门扇 | `window` 窗扇 |
| 4 | `roof_edge` 瓦口 | `wall_base` 墙裙 | `sign` 招牌 | `shutter` 百叶 |

- 可平铺角色（除 door/window/sign/shutter/wall_base/roof_edge 外）需四方连续。
- 用像素块表达明暗，不要依赖平滑渐变；透明像素会露底，请补满 alpha。
- 上传时会自动校验：是否正方形、是否能被 4 整除、每格是否为空 / 接近纯色。

---

## 五、常见问题

**双击后浏览器空白 / 脚本不执行？**
请用 Chrome 或 Edge；或在目录里运行 `python -m http.server 8000` 后访问 `http://localhost:8000/`。

**样式保存在哪里？**
保存在浏览器 `localStorage`。换浏览器或清理数据会丢，请用「导出全部风格」备份成 JSON（含内嵌图集），可在另一台机器「导入风格包」。

**为什么像素风看起来有点软？**
关掉「抗锯齿」，并把画面尺寸设成与最终放大倍数匹配的值（例如 256 再整数放大 3×）。

**种子和 Godot 里不一样？**
几何参数完全一致，但随机序列实现不同（PCG32 播种细节不同）。要与 Godot 完全一致，请以本工具导出的 `recipe.json` 为准重建。

**能批量出图吗？**
网页端一次导出当前建筑的全部方向；多建筑批量用命令行版一条命令即可（见「七、命令行」）：

```bat
node cli/tb.js batch jobs.json
```

---

## 六、目录结构

```
参数化topdown建筑/
├─ index.html              页面骨架（参数面板 / 预览 / 风格工坊）
├─ 启动工具.bat            用默认浏览器打开 index.html
├─ AGENTS.md               AI agent 起始指引（精简版，先读这个）
├─ tb.cmd                  命令行版快捷入口（= node cli\tb.js，需 Node 18+）
├─ css/app.css             界面样式
├─ js/                     核心逻辑（几何 / 材质 / 光栅化 / 界面）
├─ cli/                    命令行版（给 AI agent / 脚本用，见「七」）
├─ samples/                示例输出与界面截图
└─ tools/                  开发自测（不影响普通使用，见下）
```

---

## 七、命令行版（给 AI agent / 自动化脚本）

同一套几何 / 材质 / 光栅化，多一个命令行出口，**零依赖**（Node 18+，不用 `npm install`）。
完整说明见 [`cli/README.md`](cli/README.md)，这里只列最短路径：

```bat
:: 出图（默认 512、俯角 45、单方向、正交）
node cli/tb.js render forest inn -o out/inn.png

:: 8 方向 + 精灵表 + ZIP + 配方
node cli/tb.js render jiangnan inn -d 8 --sheet --zip -o out/inn8

:: 让 agent 一次摸清全部参数与枚举
node cli/tb.js schema

:: 单进程批量（图集只解析一次）
node cli/tb.js batch jobs.json

:: 读回图片里的生成参数（v1.1 起默认内嵌）
node cli/tb.js inspect out/inn.png

:: PNG 直接当配方用：按图片里的参数重画一遍
node cli/tb.js rec apply out/inn.png -o out/again
```

为 agent 做的几件事：

- **默认只回一行 JSON 摘要**：`version / canvas / dirs / tris / ink / bbox / ms / meta / files`，`ink` 与 `bbox` 能直接判断「是不是空白、构图是否偏移」；`--quiet` 只回路径，`--thumb` 附缩略图。
- **不需要读源码**：`list styles|types|params|roles|enums` 与 `schema` 给出全部可选值与参数范围。
- **少打字**：`render forest inn -o a.png` 就够；常用组合可 `preset save pixel` 后只写 `--preset pixel`。
- **可复现**：`--recipe` 吃网页导出的 `recipe.json`；v1.1 起每张 PNG 自带配方，`inspect` 回读、`rec apply <png>` 直接重画（`--save-recipe` 写出的配方也能拖回网页）。
- **全功能对齐**：多方向 / 精灵表 / 三套描边 / 部件级染色换图 / 自定义风格包导入导出 / 图集校验与模板，命令行都能做。
- **快**：图集解码结果缓存在 `cli/.cache/`，单次渲染约 0.4s；`batch` 复用同一进程。

### 图片内嵌元信息（v1.1）

每张导出的 PNG（含精灵表、缩略图、ZIP 内的帧）默认写入三个 PNG 文本块，像素数据一个字节都不改，任何看图软件都不受影响：

| 文本块 | 类型 | 内容 |
|---|---|---|
| `Software` | tEXt | 产生该图的工具与版本 |
| `topdown:version` | tEXt | 工具版本号（如 `1.1`） |
| `topdown:recipe` | iTXt | 完整配方 JSON（UTF-8，deflate 压缩） |

```bat
node cli/tb.js inspect out/inn.png                    :: 版本 + 视角/建筑参数
node cli/tb.js inspect out/inn.png --full              :: 连完整配方一起看
node cli/tb.js inspect out/inn.png --save-recipe a.json
node cli/tb.js rec apply out/inn.png -o out/again      :: 按图片参数重画
node cli/tb.js render forest inn --no-meta             :: 不要内嵌（默认写入）
```

- 内嵌数据不含时间戳：同一组参数渲染出的 PNG **逐字节相同**。
- 部件贴图是数据量大的 dataURL，入图时剥离，只保留来源文件名、字节数与 `crc32` 指纹；`inspect` 会给出提示，复现时重新指定 `--part <角色>:texture=<文件>` 即可。
- 网页版与命令行版写的是同一套块名和结构，互相都能读。

---

## 八、开发者（可选）

普通用户可忽略本节。以下脚本仅用于维护 / 验证源码，需要对应运行时：

```bat
:: 几何 / 渲染 / 采样自测（需要 Node 18+）
node tools/selftest.js
node tools/test_nearest.js
node tools/test_all_types.js
node tools/test_views.js
node tools/ui_test.js        :: 需要本机 Chrome / Edge

:: 命令行版端到端自测（需要 Node 18+）
node cli/selftest.js

:: 从 Godot 插件重新生成目录与图集（需要 Python + Pillow）
pip install Pillow
python tools/build_assets.py
:: 也可指定插件目录：
python tools/build_assets.py --addon "<插件>\addons\hd2d_scene_tools"
```

> `tools/` 下的脚本不参与出图，删掉也不影响普通用户使用。

---

## 九、开源与许可

- 欢迎 Issue / Pull Request。提交代码前请先跑一遍 `tools/` 自测确保无回归。
- 本项目为 Godot 插件 `hd2d_scene_tools` 的网页移植版，引用其几何与参数规范，请遵守其相应许可。
- 图集素材如涉及第三方版权，请在使用 / 分发前自行确认授权。

---

## 十、更新日志

### v1.1（2026-10-30）

- **命令行版**：新增 `cli/`（`render / batch / list / schema / rec / styles / atlas / preset`），零依赖、单进程批量、与网页的配方/预设/风格包互通。
- **图片内嵌元信息**：网页版与命令行导出的 PNG 默认写入「工具版本 + 完整配方」（PNG 文本块，不影响像素）；新增 `inspect` 读回，`rec apply <png>` / `render --recipe <png>` 可直接按图片参数重画；`--no-meta` 可关闭。
- 输出摘要新增 `version` / `meta` 字段；同一参数渲染出的 PNG 逐字节一致。

### v1.0

- 网页版首个版本：10 种风格、46 种建筑类型、正交/透视、多方向与精灵表导出、风格工坊与部件级覆盖。

---

祝出图愉快 🏯

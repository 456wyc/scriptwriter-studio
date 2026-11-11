# 剧本工坊 · Scriptwriter Studio

> 专为编剧打造的本地优先桌面编辑器：标准剧本排版、场景大纲、角色与台词统计、Fountain 互通、A4 PDF 导出，以及一个**目标驱动、由系统验收**的 AI 编剧智能体。

在线介绍页：<https://456wyc.github.io/scriptwriter-studio/> · Windows 预览版：<https://github.com/456wyc/scriptwriter-studio/releases/tag/v1.0.0-preview.2>

基于 Electron 构建，所有剧本保存在本机，无需账号、无需联网即可写作。AI 能力为可选项，接入任意 OpenAI 兼容端点即可启用。

---

## 功能一览

| 模块 | 说明 |
| --- | --- |
| 专业剧本排版 | 场景标题、动作描述、角色、对白、括号提示、转场、分节、备注八类元素；`Tab` 切换类型，`Enter` 智能续行 |
| 封面与正文 | 独立的封面页（标题 / 编剧 / 类型 / 一句话故事 / 稿次），导出 PDF 时单独成页 |
| 场景大纲 | 自动抽取场景列表，点击跳转；可设定目标页数并查看写作进度 |
| 角色与统计 | 自动提取角色名，统计字数、场数、预估页数、元素分布与写作提示 |
| Fountain 互通 | 导入 / 导出 `.fountain`、纯文本与本编辑器的 `.screenplay` 工程文件；支持从文本粘贴导入 |
| 导出 | A4 PDF 导出、打印，以及工程文件导出 |
| 外观自定义 | 纸张颜色、文字颜色、字体、字号、行距、纸张宽度；左右侧栏可拖拽调宽，双击恢复默认；设置重启后保留 |
| 效率工具 | 命令面板（`Ctrl+K`）、禅模式、明暗主题、快捷键、本地自动保存、自定义工作目录 |
| AI 助手 | 快捷能力（提示 / 扩写 / 润色 / 根据设定生成完整剧本）与智能体直接编辑剧本 |

### AI 智能体：目标驱动，而不是写几步就停

普通工具调用型 Agent 常由模型自行宣布「完成」，容易在整体目标未达成时中途停下。剧本工坊把终止权交给系统：

1. **制定清单**：首轮强制调用 `plan`，把整体目标拆成可验收的有序步骤，清单实时显示在 AI 面板。
2. **持续执行**：通过 `read_script`、`insert_block`、`replace_block`、`add_scene`、`add_dialogue`、`set_meta` 等工具直接改剧本，每次调用即时反映在编辑器中；`update_plan` 标记进度。
3. **系统验收**：`finish` 是一道验收门——没有计划、仍有剩余待办、实际编辑次数不足，都会被拒绝并返回剩余项。只有清单全部完成且验收通过，任务才会结束。
4. **不会早停**：模型只输出说明文字时，系统会注入「剩余待办」持续追问；上下文过长会自动分段续跑并携带清单状态；「继续任务」可从上次进度接着做，不重做已完成编辑。

可选引擎：

- **内置工具引擎**（默认）：兼容所有 OpenAI 兼容端点，无额外依赖。
- **LangChain Deep Agents**：规划型引擎，提前返回或端点不兼容时自动接续 / 回退内置引擎。

---

## 快速开始

环境要求：Node.js 20+ 与 npm。

```bash
git clone https://github.com/456wyc/scriptwriter-studio.git
cd scriptwriter-studio
npm install
npm start
```

开发模式（自动打开 DevTools）：

```bash
npm run dev
```

`electron-builder` 已在 `devDependencies` 中，直接打包即可：

```bash
npm run build      # NSIS 安装包 → dist/ScriptwriterStudio-Setup-<version>.exe
npm run pack       # 免安装目录 → dist/win-unpacked/
```

### 配置 AI（可选）

在应用右侧「AI 助手 → 配置」中填写：

| 字段 | 示例 |
| --- | --- |
| Base URL | `https://api.openai.com/v1` 或任意 OpenAI 兼容端点 |
| 模型名称 | 支持 `tools` / `tool_calls` 的对话模型 |
| API Key | 经系统加密（Windows DPAPI / macOS Keychain）存于 `userData`，不下发到渲染进程 |

不配置也能完整使用编辑、排版、导入导出与统计功能。

---

## 数据与隐私

- 剧本默认保存在「文档 / 剧本工坊」：`library.json` 为索引，`scripts/*.screenplay` 为每份剧本的独立工程文件，可在状态栏切换工作目录。
- 外观与工作目录设置随库持久化；联网请求仅在你主动调用 AI 时发生，且只发往你配置的端点。

## 常用快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Tab` | 切换当前内容块的元素类型 |
| `Enter` | 智能续行 |
| `Ctrl` + `Enter` | 新建场景 |
| `Ctrl` + `K` | 打开命令面板 |
| `Ctrl` + `O` | 打开剧本文件 |
| `Ctrl` + `S` / `Ctrl` + `P` | 保存 / 导出 PDF |

---

## 目录结构

```
├── src/
│   ├── main.js            # Electron 主进程：文件持久化、IPC、AI 请求与 Agent 引擎
│   ├── preload.js         # contextBridge 安全桥接
│   └── renderer/
│       ├── index.html     # 界面结构
│       ├── styles.css     # 主题、纸张、可拖拽布局与打印样式
│       └── app.js         # 编辑器、命令面板、AI 面板与设置
├── docs/
│   ├── index.html         # GitHub Pages 落地页
│   └── .nojekyll
├── preview-server.cjs     # 本地静态预览服务（127.0.0.1:8123，落地页在 /landing/）
├── package.json
├── LICENSE
└── README.md
```

## GitHub Pages

落地页源码在 `docs/index.html`，为无外部依赖的单文件页面，线上地址：<https://456wyc.github.io/scriptwriter-studio/>

部署由 `.github/workflows/pages.yml` 完成：推送到 `main` 且改动涉及 `docs/` 时，Actions 会把 `docs/` 上传为制品并发布；也可在 Actions 页面手动运行 `Deploy GitHub Pages`。仓库的 **Settings → Pages → Build and deployment → Source** 需设为 **GitHub Actions**（当前已按此配置）。

本地预览：

```bash
node preview-server.cjs
```

- 落地页：<http://127.0.0.1:8123/landing/>
- 编辑器静态预览：<http://127.0.0.1:8123/>

---

## 贡献

欢迎提交 Issue 与 Pull Request。改动前端后请同步更新 `src/renderer/index.html` 中的 `?v=` 资源版本号，并运行 `node --check src/main.js` 与 `node --check src/renderer/app.js`。

## 许可

[MIT](LICENSE) © 2026 Scriptwriter Studio

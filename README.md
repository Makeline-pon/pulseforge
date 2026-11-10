# PulseForge

**一个用纯 Web Audio 写成的电子音乐编辑器**——16 轨音序器、61 键钢琴卷帘、四段效果链、离线渲染 WAV。
同一套核心代码有三种形态：**DSH Desktop 插件**、**可安装的 PWA**、**Windows 桌面应用（Tauri）**。

<p align="center">
  <img src="pwa/icon-512.png" width="120" alt="PulseForge 图标" />
</p>

> 截图占位：把应用截图保存为 `docs/screenshot.png` 后取消下一行注释即可。
>
> <!-- ![PulseForge 主界面](docs/screenshot.png) -->

---

## 目录

- [特性](#特性)
- [下载与安装](#下载与安装)
- [快捷键指南](#快捷键指南)
- [效果器参数](#效果器参数)
- [性能与内存](#性能与内存)
- [开发与构建](#开发与构建)
- [项目结构](#项目结构)
- [常见问题](#常见问题)
- [开源协议](#开源协议)

---

## 特性

- **音序器**：16 轨 × 4 小节（64 步），每格 28×28px；单击切换、Shift 框选、Alt/Ctrl 涂抹、整批拖动。
- **钢琴卷帘**：C2–C7 共 61 键，黑白键分层、八度起点标记、键盘条可试听，音符可拖拽 / 改长度 / 改力度 / 删除。
- **纯合成引擎，零采样**：Kick 用正弦 + 150→45Hz 音高包络，Snare/Hat 用程序生成噪声 + 高通，Bass 锯齿 + 低通 + ADSR，合成器支持方波/锯齿/正弦。
- **四段串联效果链**：失真（`tanh` 波形整形）→ 低通（20–20000Hz、Q 0.1–20）→ 延迟（20–1000ms + 反馈 + 干湿）→ 混响（程序生成 IR + 阻尼低通），每段都有实时曲线。
- **三层参数作用域**：Master / 单条轨道 / 单个音符。音符级覆盖走 4 条链的对象池，池满自动退回轨道链并提示，不会因为几十个 Convolver 卡死浏览器。
- **音符微调**：每个音符可设 −50–50ms 的 offset，格子上和卷帘里都有可视化，也可用 `[` `]` 调整。
- **导出**：`OfflineAudioContext` 离线渲染 44.1kHz / 16-bit / 立体声 WAV（最长 8 分钟），完整包含效果链与音符级参数。
- **工程存档**：自动保存到 IndexedDB（1 秒节流），并可随时导出 JSON 备份；旧工程缺字段会自动补默认值。
- **离线可用**：PWA 用 Service Worker 预缓存全部资源，断网照常打开；新版本就绪时右下角轻提示，不打断创作。

## 下载与安装

到 [Releases](../../releases) 页面下载对应产物（每个版本都附带 `SHA256SUMS.txt`）：

| 文件 | 说明 |
| --- | --- |
| `PulseForge-Setup-v<版本>.exe` | Windows 安装程序（NSIS），含安装向导、旧版本检测、损坏自动修复 |
| `PulseForge-v<版本>-source.zip` | 完整源码，含 DSH 插件 / PWA / Tauri 三套工程 |

### Windows 桌面版

1. 下载 `PulseForge-Setup-v<版本>.exe`，双击运行。
2. 向导里可以改安装目录（默认 `C:\Program Files\PulseForge`）；安装模式为「所有用户」，需要管理员权限。
3. 如果检测到已安装的同名版本，会询问是否覆盖安装；若探测到安装残缺（主程序或清单文件缺失），会自动清理残留后重装。
4. 安装前会校验目标磁盘剩余空间，低于 150MB 会提示清理或更换磁盘。

卸载走 Windows「应用和功能」。卸载时可以保留本地作品数据（默认位于 `%LOCALAPPDATA%\dev.pulseforge.app`）。

### PWA（浏览器）

不需要安装包，用任意静态服务器打开 `pwa/` 即可（Service Worker 要求 http/https，`file://` 不行）：

```bash
npm install
npm run build:pwa
npm run serve          # http://127.0.0.1:5180
```

在 Chrome / Edge 里点地址栏右侧的安装图标，即可装成独立窗口应用。

### 作为 DSH Desktop 插件

```bash
npm install
npm run build          # 产出 client.js 与 index.js
```

然后在 DSH Desktop 里打开「插件」→ 右上角「添加插件」→ 粘贴本仓库的绝对路径 → 安装 → 重启。启动后用 `/pulseforge` 命令或侧边栏底部的波形图标打开面板。

## 快捷键指南

| 操作 | 手势 | 说明 |
| --- | --- | --- |
| 切换单格 | 左键单击 | 空格子加音符，实心格删除 |
| 批量涂抹 / 擦除 | `Alt` 或 `Ctrl` + 左键拖拽 | 从空格起笔是画，从实心格起笔是擦 |
| 框选 | `Shift` + 左键拖拽 | 拖动时格子实时高亮；指针移出面板也继续跟随，松手落选区 |
| 整体移动 | 选中后左键拖拽 | 框选出来的整批音符一起挪，越界自动收敛 |
| 改音符长度 | 拖音符右边缘 | 1–16 步 |
| 删除选中 | `Delete` / `Backspace` | — |
| 删除单个音符 | 右键单击音符 | 卷帘里生效 |
| 调整 offset | `[` / `]` | 每次 −5ms / +5ms，范围 −50–50ms |
| 改力度 | 双击音符 | 0–127 |
| 播放 / 停止 | `空格` | 输入框聚焦时不触发 |
| 关闭面板 | `Esc` | 更新日志弹窗打开时先关弹窗 |
| 小节翻页 | 顶栏 `‹` `›` | 4 小节共 64 步 |

## 效果器参数

| 效果器 | 参数 | 范围 |
| --- | --- | --- |
| 失真 Distortion | Drive | 0–1（`tanh(k·x)`，k = 1 + 49·drive） |
| 低通 Lowpass | Cutoff / Q | 20–20000Hz / 0.1–20 |
| 延迟 Delay | Time / Feedback / Wet | 20–1000ms / 0–0.9 / 0–1 |
| 混响 Reverb | Decay / Damping / Wet | 0.2–4s / 0–1 / 0–1 |

右侧面板顶部的下拉框决定你在编辑谁：`全局 Master`、某条轨道、或当前选中的音符。给音符改参数会生成该音符专属的 `fxOverrides`，网格里对应格子右上角出现小圆点。

## 性能与内存

音频节点是这里最贵的资源，一次「几十个带长混响的音符」就足以让整页 GC 停摆。当前实现的硬性约束：

| 项目 | 上限 / 策略 |
| --- | --- |
| 常驻轨道效果链 | 16 条（每轨一条，含 1 个 `ConvolverNode`） |
| 单音符独立效果链 | `NOTE_CHAIN_LIMIT = 4` 条，借满后退回轨道链并弹一次降级提示（8 秒节流） |
| 卷积器总数 | ≤ 20（16 轨道 + 4 音符链），离线导出同样遵守 |
| IR 缓存 | 按「采样率 + 时长」缓存，最多 16 条，换参数不再重算脉冲响应 |
| voice 生命周期 | `onended` 触发即 `disconnect()` 所有节点并递减计数；AudioContext 挂起时由兜底定时器强制回收 |
| 延迟回调 | 全部登记在 `pendingTimers`，停止播放与卸载时统一 `clearTimeout` |

在浏览器控制台可以随时核对有没有泄漏：

```js
__pfAudioStats()            // { voices, chainsInUse, chainsIdle, trackChains, timers, impulseCache, context }
__pfLogAudioStats('现场')    // 直接打印一行中文统计
```

播放中每 10 秒会自动打印一条「音频对象统计（播放中）」；停止播放后 `voices` 应回落到 0，`timers` 不会持续增长。如果停止后 `voices` 仍居高不下，说明还有 voice 没收到 `onended`——这正是兜底定时器要解决的情况。

## 开发与构建

需要 Node 20+。Windows 安装包还需要 [Rust](https://rustup.rs)（MSVC 工具链）与 Visual Studio Build Tools 的「使用 C++ 的桌面开发」组件。

缩进与换行由根目录 `.editorconfig` 统一：源码 2 空格 + LF，`.bat` 强制 CRLF，Markdown 保留行尾空格。VS Code / JetBrains 均原生支持，无需装插件。

```bash
npm install

npm run test:all        # 先重建产物，再跑全部测试
npm run build:release   # 产出 dist-plugin/、dist-pwa/、release/
npm run serve           # 本地预览 PWA（127.0.0.1:5180）
npm run tauri build     # 编译 Windows 安装包（需 Rust + Tauri CLI）
```

- `npm run tauri -- --check` 会打印环境体检表，缺什么直接告诉你装什么。
- 版本号单一来源是 `package.json`：`build:release` 会把它同步进 `cordis.patch.yml`、`sw.js`、`tauri.conf.json`、`Cargo.toml` 与安装目录里的清单文件，不一致会直接报错。

### 一键发布

双击 `git_push.bat`（或者跑 `npm run publish:release`），按提示填两个东西就完事：

1. **版本号** —— 直接回车就用「补丁位 +1」；
2. **提交说明** —— 写成多行，每行都会变成面板里「更新日志」弹窗的一条记录，行首可写 `feat:` / `fix:` / `chore:` 决定彩色角标。

脚本会依次：改 `package.json` 与 `src/client/10-core.ts`（版本号 + 更新日志）→ 把同一批条目按版本倒序插进根目录的 `CHANGELOG.md` → 跑 `npm run test:all`（顺带重建产物、把版本同步进 Tauri 与 Service Worker）→ `git commit` → 打标签 `v<版本>` → 推送分支与标签。任何一步失败都会把改过的文件恢复原样，不会留下「改了版本却没发布」的半成品。

| 附加参数 | 作用 |
| --- | --- |
| `--version 0.8.0 --message "feat: xxx"` | 跳过交互，适合脚本调用 |
| `--dry-run` | 只校验并打印计划，不改文件、不提交 |
| `--yes` | 跳过最后的确认 |
| `--no-test` | 跳过测试（救急用，不推荐） |
| `--no-push` | 只提交并打标签，不推送 |
| `--remote upstream` | 换个远端名，默认 `origin` |

第一次用之前，目录得先是一个 git 仓库（一次就好）：

```bash
git init
git add -A
git commit -m "init: PulseForge"
git remote add origin https://github.com/<账号>/<仓库名>.git
git branch -M main
git push -u origin main
```

脚本发现目录不是仓库时，会把这六行直接打印出来。

推送后 GitHub Actions 会自动跑测试、编译安装包、创建 Release 并上传 `release/` 里的全部产物。

### 测试

| 脚本 | 覆盖 |
| --- | --- |
| `tests/core.test.mjs` | 吸附、BPM 夹紧、offset 换算、框选命中、效果器分层、旧工程兼容 |
| `tests/smoke.mjs` | 组件树渲染、交互回调、图例与偏移可视化 |
| `tests/stress.test.mjs` | 64 步全填 + 32 个独立长混响音符的节点预算与导出 |
| `tests/dist.mjs` | 插件产物形状（ModuleLoader、工具定义、注册面） |
| `tests/pwa.test.mjs` / `tests/pwa-boot.mjs` | PWA 资产与真实启动冒烟 |
| `tests/release.test.mjs` | `dist-plugin/`、`dist-pwa/`、Tauri 配置、图标、版本一致性 |
| `tests/installer.test.mjs` | NSIS 钩子文案、磁盘校验、注册表写入、卸载清理 |
| `tests/publish.test.mjs` | 版本解析、更新日志生成、源码改写、入口脚本 |

## 项目结构

```
pulseforge/
├── index.ts                     DSH 宿主半部（注册 pulseforge_set_bpm 工具）
├── package.json                 版本单一来源（1.0.0）、脚本、依赖
├── CHANGELOG.md                 更新日志（按版本倒序，发布脚本自动追加）
├── .editorconfig               缩进 / 换行 / 编码约定
├── git_push.bat                 一键发布入口（双击 = 改版本 + 测试 + 提交 + 打标签 + 推送）
├── src/client/                  DSH 前端半部，按依赖顺序拼成 client.js
│   ├── 10-core.ts               纯函数：吸附、音高、效果器解析、工程归一化
│   ├── 20-store.ts              状态与动作（无宿主依赖，可直接复用）
│   ├── 30-idb.ts                IndexedDB 存档
│   ├── 40-audio.ts              实时音频引擎 + 音符链对象池
│   ├── 50-export.ts             离线渲染与 WAV 编码
│   ├── 80-sequencer.ts          音序器（框选 / 涂抹 / 整体拖动）
│   ├── 85-pianoroll.ts          钢琴卷帘
│   ├── 90-fx.ts                 效果器面板与曲线
│   ├── 95-window.ts             窗口、顶栏、状态栏、更新日志
│   └── 99-entry.ts              插件入口（命令、槽位注册）
├── src/pwa/                     PWA 专用：react-lite、web-entry、index.html、manifest、sw
├── src-tauri/                   Tauri 工程
│   ├── tauri.conf.json          窗口、CSP、bundle、NSIS 配置
│   ├── installer-hooks.nsh      ★ 安装向导生命周期钩子（检测 / 校验 / 磁盘 / 注册表）
│   ├── capabilities/            Tauri 权限声明
│   └── resources/package.json   安装目录里的完整性清单（构建时生成）
├── scripts/
│   ├── build-release.mjs        三端产物 + release/ 打包
│   ├── build-pwa.mjs            PWA 构建
│   ├── lib/release-bundle.mjs   安装器收集、源码 zip、校验清单
│   ├── lib/zip.mjs              无依赖 ZIP 写入器
│   ├── lib/version-json.mjs     version.json 读写与版本比较
│   ├── publish.mjs              一键发布脚本（版本 + 更新日志 + git）
│   ├── tauri.mjs                Tauri 转发器（带环境体检）
│   └── serve.mjs                本地预览服务器
├── tests/                       九个零依赖测试脚本
├── .github/workflows/release.yml  打标签自动发布
├── dist-plugin/                 插件产物（构建生成）
├── dist-pwa/                    PWA 产物（构建生成）
└── release/                     分发包（构建生成，CI 上传到 Release）
```

## 常见问题

**打开后没有声音？**
浏览器要求用户手势后才能启动音频，点一下播放键即可；状态栏会显示音频上下文状态。

**音符级的独立效果器有上限吗？**
有，同时最多 4 条（`NOTE_CHAIN_LIMIT`）。超出的音符自动使用所属轨道的效果链，并在右下角提示一次，避免几十个卷积混响拖垮主线程。

**导出的 WAV 没有声音 / 时间不对？**
导出长度按最后一个音符加效果尾巴计算，2 秒起、8 分钟封顶；导出期间状态栏会显示进度，失败会保留工程数据并弹提示。

**自动保存会丢吗？**
自动保存写在 IndexedDB，方便下次秒开；但浏览器清理站点数据会连它一起清掉。重要作品请用「导出工程 JSON」留一份文件备份。

**为什么 PWA 不直接用 React？**
为了零依赖单文件分发（也避免在没有网络的机器上装不上），`src/pwa/react-lite.ts` 实现了本项目用到的 React 子集：`createElement` 与六个 hook。副作用是它不支持 `class` 组件、Context 与 JSX。

**`npm install` 需要装 cordis 吗？**
不需要。cordis 与 schemastery 由 DSH 宿主在运行时提供，npm 上也没有可安装的 `cordis` 同名包（DSH 自带的是 `@deepseek-ai/cordis`）。所以本包的 `dependencies` 为空，宿主半部用本地结构类型描述 `Context`，干净环境 `npm install` 只装开发期工具链。

**长时间播放内存会涨吗？**
不会无限涨。每个 voice 结束时断开全部节点，延迟回调集中登记并在停止/卸载时清空，渲染器每轮渲染后还会丢掉已经不在树上的 DOM 引用。怀疑有泄漏时，在控制台调用 `__pfAudioStats()` 看 `voices` 与 `timers` 是否回落即可。

## 开源协议

[MIT](LICENSE) © PulseForge contributors

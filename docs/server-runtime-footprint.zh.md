# Halo Server 运行时与包体积瘦身方案

> 适用范围：`scripts/build-server-halo.sh` 产出的 headless server 产物（`HALO_SERVER_MODE=1`）。
> 目标：降低 server 端常驻内存、空转 CPU/网络与镜像体积，**不改变桌面客户端行为**。
> 状态：待评审。所有代码改动需逐项确认后执行。

---

## 1. 背景

Halo Server 与桌面客户端同源。当前 server 构建的做法是：

```
build-server-halo.sh
  → 临时替换 product.json 为 server.product.json
  → npm run build（与桌面完全相同的 electron-vite 构建）
  → electron-builder --linux dir --x64
  → 运行时靠 HALO_SERVER_MODE=1 走 headless 分支
```

产物与桌面客户端**是同一份 `out/main/index.mjs`**，桌面专属子系统只在运行时被跳过一部分，既没有从产物中消除，也大多仍在初始化。

本方案不改变"一份代码库、桌面能力完整保留"这一前提，只处理 server 产物**带了什么、跑了什么**。

---

## 2. 现状基线（实测）

### 2.1 包体积

产物 `dist/linux-unpacked` 共 **895 MB**：

| 组成 | 大小 | 备注 |
|---|---|---|
| Electron runtime | 264 MB | Chromium + locales(37MB) + icudtl(10MB) |
| `resources/app.asar` | 271 MB（逻辑 249 MB） | 应用代码 + 全量 `dependencies` 源码 |
| `resources/app.asar.unpacked` | 354 MB | 平台原生二进制 |
| `resources/ocr` | 7 MB | |

`app.asar` 内前 10 大项（已排除 unpacked）：

| 包 | 大小 | 性质 |
|---|---|---|
| `gpt-tokenizer` | 48.9 MB | 主进程启动即加载（见 2.2） |
| `lucide-react` | 24.0 MB | **渲染层专用，已打进 `out/renderer`，重复落盘** |
| `tiktoken` | 22.5 MB | 无直接引用，经 `@anthropic-ai/tokenizer` 传递引入 |
| `out/renderer` | 19.8 MB | HTTP 服务的前端产物，**必须保留** |
| `better-sqlite3` | 9.8 MB | 需要 |
| `out/main` | 8.6 MB | 其中 **6.0 MB 是 sourcemap** |
| `@shikijs/langs` | 7.6 MB | 渲染层专用，重复落盘 |
| `@capacitor/cli` | 6.0 MB | **移动端构建依赖，不该进产物** |
| `highlight.js` | 5.2 MB | 渲染层专用，重复落盘 |
| `react-dom` | 4.3 MB | 渲染层专用，重复落盘 |

按类别汇总的可回收量：

| 类别 | 大小 | 说明 |
|---|---|---|
| sourcemap（`*.map`） | **68.4 MB** | asar 内 4694 个文件 |
| 渲染层依赖重复落盘 | **69.6 MB** | 已被 Vite 打包，运行时无人 require |
| Chromium locales | **36 MB** | 55 个 `.pak`，实际只需 en-US + zh-CN |
| `LICENSES.chromium.html` | 8.8 MB | |
| `@capacitor/*` + `native-run` | 8.1 MB | 现有排除规则**未生效**（见 4.1） |

`app.asar.unpacked` 明细：

| 项 | 大小 | 加载方式 |
|---|---|---|
| `@openai/codex-linux-x64` | 230 MB（单二进制 216 MB） | 已 strip，无法进一步压缩 |
| `cloudflared` | 38 MB | 惰性（`services/remote/tunnel.ts:92`） |
| `tesseract.js-core` | 33 MB | 惰性（`services/ocr/engine.ts:44`），6 个 WASM 变体运行时只用 1 个 |
| `@anthropic-ai/claude-code` | 28 MB | 需要 |
| `@img/sharp-*` | 17 MB | 供 Claude CLI 子进程使用 |
| `node-pty` | 3.1 MB | **Linux 上已死代码**（`services/ai-terminal/available.ts:11` 限定 darwin/win32） |

### 2.2 启动内存

`src/main/index.ts:208` 从 barrel `./openai-compat-router` 导入 `stopOpenAICompatRouter`，该 barrel 经 `utils/token-counter.ts:14-16` 顶层静态引入三个分词器。实测：

```
gpt-tokenizer                        +73.1 MB RSS / 78 ms
gpt-tokenizer/encoding/cl100k_base   +28.3 MB RSS / 27 ms
@anthropic-ai/tokenizer              + 3.3 MB RSS /  7 ms
────────────────────────────────────────────────────────
                                    +104.7 MB RSS / 112 ms
```

**每次主进程启动无条件付出，与是否真正使用 OpenAI 兼容路由无关。**

### 2.3 空转开销

server 模式下持续运行的循环：

| 循环 | 周期 | 位置 | server 端是否需要 |
|---|---|---|---|
| 自动更新检查 | 1 h（+5 s 启动 +resume 钩子） | `services/updater.service.ts:224-238` | **否**，容器镜像不可变 |
| health fallback（shell 出 `ps` 扫进程） | 120 s | `health/health-checker/runtime-checker.ts:60` | 可降频 |
| store 升级检查 | 6 h | `store/upgrade.service.ts:56` | 应由运维控制 |
| 公告 feed 拉取 | 6 h | `services/announcement.service.ts:358` | 应由运维控制 |
| scheduler tick / 卡单清理 | 10 s / 60 s | `platform/scheduler/timer.ts:165,172` | 需要 |
| escalation 超时检查 | 5 min | `apps/runtime/service.ts:1357` | 需要 |
| 企微 bot 缓存清理 / 健康快照 | 5 min ×2 | `apps/runtime/im-channels/wecom-bot.provider.ts:380,384` | 视是否启用 |

### 2.4 无效初始化

`bootstrap` 全链路中**只有一处** `isServerMode()` 守卫（`bootstrap/extended.ts:351`，托盘）。以下在 server 模式下仍被创建/注册：

| 子系统 | 位置 | 现状 |
|---|---|---|
| 自动更新器 | `bootstrap/essential.ts:78-79` | 完整运行，含 `powerMonitor` 监听 |
| 终端 handler + `pty-host` worker | `bootstrap/essential.ts:72`、`src/worker/pty-host/` | Linux 上 pty 不可用，handler 与路由仍挂载 |
| `TrayManager` 实例 | `platform/background/index.ts:56` | 只跳过 `initTray()`，对象仍构造，`tray.ts` 仍在产物中 |
| `halo-file://` 协议 | `foundation/protocol.service.ts:24` | 浏览器客户端无法使用该 scheme |
| 原生通知 | `services/notification.service.ts:97,159` | headless Linux 上必然失效；WS 广播已覆盖远程客户端 |
| crashReporter | `src/main/index.ts:517` | `uploadToServer:false`，minidump 只在容器盘堆积 |
| analytics 订阅者 | `bootstrap/extended.ts:166` | **语义错配**：`initAnalytics()` 只在 GUI 路径调用（`index.ts:591`），server 端事件灌入未初始化的 provider |
| `display.service` | `src/main/index.ts:205` | 顶层 import |

---

## 3. 根因

以上现象来自三条缺失的架构边界。不补边界，逐条打补丁会反复退化。

### 3.1 缺构建期 target 边界

`isServerMode()`（`foundation/runtime-mode.ts:14`）是**运行时**环境变量判断。打包器无法判定分支走向，桌面代码一律保留，且顶层 `import` 带来的模块初始化照常发生。

仓库已有变体机制（`scripts/product-source.mjs`、`electron-builder.<vendor>.cjs`、`product.json` 物化），但 server 没有并入，而是靠构建脚本临时换文件 + `trap` 还原——这个 workaround 本身即是边界缺失的信号。

### 3.2 缺依赖角色边界

`package.json` 的 104 个 `dependencies` 混装了四类语义不同的东西：

1. 主进程运行时依赖 —— 必须以 node_modules 形式落盘
2. 渲染层构建依赖 —— 已被 Vite 内联，**不该落盘**
3. 移动端构建依赖（`@capacitor/*`）—— 不该落盘
4. 平台原生二进制 —— 只该留目标平台那一份

electron-builder 只认 `dependencies` / `devDependencies` 两档，于是第 2、3 类全部进包。**仅此一条浪费约 78 MB。**

### 3.3 缺惰性加载纪律

barrel 文件把"我要一个函数"放大成"加载 100 MB 分词器"。代码库中 `unpdf`、`tesseract.js`、`cloudflared` 都正确使用了 `await import()`，说明范式已确立，只是未施加到最重的边上。

---

## 4. 方案

分四阶段，按"风险递增、决策依赖递增"排序。P0/P1 可独立交付。

### P0 — 构建配置（零代码改动）

| # | 改动 | 位置 | 预计收益 |
|---|---|---|---|
| P0-1 | 产物剔除 `*.map` | `package.json#build.files` 增加 `!**/*.map`；`electron.vite.config.ts:26` 的 `sourcemap` 在 server target 下关闭 | −68 MB |
| P0-2 | 渲染层专用包移入 `devDependencies` | `package.json`（`lucide-react`、`@shikijs/*`、`highlight.js`、`react`/`react-dom`、`katex`、`@codemirror/*`、`@dnd-kit/*`、`@xterm/xterm`、`html5-qrcode`、`streamdown`、`react-*` 系列等） | −70 MB |
| P0-3 | 修复失效的 capacitor 排除规则 | `package.json#build.files` 的 `!node_modules/@capacitor/**` 实测未生效（`/node_modules/@capacitor/cli` 仍在 asar 中），改为 `!**/node_modules/@capacitor/**`；更根本的做法是移出 `dependencies` | −8 MB |
| P0-4 | 限定 Chromium 语言包 | server target 配置 `electronLanguages: ['en-US','zh-CN']` | −36 MB |
| P0-5 | afterPack 删除 `LICENSES.chromium.html` | `scripts/afterPack.cjs` | −9 MB |

> **P0-2 的验证要求**：移动依赖前必须确认 `src/main/**` 与 `src/worker/**` 无任何引用。`externalizeDepsPlugin` 只外部化主进程实际 import 的包，渲染层依赖不在其中。建议以 `out/main/**` 的 import 清单作为白名单逐一比对，而非凭包名判断。

**P0 合计约 −190 MB，不触碰任何业务代码。**

### P1 — 启动内存与惰性化（小范围代码改动）

| # | 改动 | 位置 | 预计收益 |
|---|---|---|---|
| P1-1 | 分词器改惰性加载 | `openai-compat-router/utils/token-counter.ts:14-16` 顶层静态 import 改为函数内 `await import()` | **−104 MB 启动 RSS，−112 ms 启动耗时** |
| P1-2 | 分词器改按编码 subpath 引入 | 同上：用 `gpt-tokenizer/encoding/o200k_base` 替代 barrel `gpt-tokenizer`，避免加载全部编码表 | −49 MB 产物 |
| P1-3 | 移除 `tiktoken` 传递依赖 | 评估 `@anthropic-ai/tokenizer` 是否可由 subpath 方案替代 | −22 MB |
| P1-4 | 拆 barrel 导入 | `src/main/index.ts:208` 直接 import `./openai-compat-router/server`，不经 `index.ts` barrel | 消除放大路径 |
| P1-5 | 自动更新器加 server 守卫 | `bootstrap/essential.ts:78-79` | 停止每小时外呼 + `powerMonitor` 监听 |
| P1-6 | 下线 Linux 死代码路径 | `bootstrap/essential.ts:72` 的 `registerTerminalHandlers()`、`http/routes/terminal.routes.ts`、`electron.vite.config.ts` 中 `worker/pty-host` 入口 | −3 MB，少一个 rollup 入口 |
| P1-7 | analytics 订阅者与 `initAnalytics()` 对齐 | `bootstrap/extended.ts:166` vs `index.ts:591` | 修正语义错配 |

> P1-1 需注意：`token-counter` 被 `server/request-handler.ts:736` 的请求路径调用。改惰性后首次请求会有一次 ~80 ms 的加载延迟，应在模块内缓存 promise 单例，避免并发重复加载。

### P2 — bootstrap 能力画像拆分（架构改动）

这是 P3 能够干净落地的前提。

**问题**：单加编译期常量不够。以托盘为例——

```ts
// bootstrap/extended.ts:349
import { initBackground } from '../platform/background'   // 顶层 import
const backgroundService = initBackground()                 // 无条件调用，内部构造 TrayManager
if (!isServerMode()) {
  backgroundService.initTray()                             // 只有这一行被跳过
}
```

`platform/background/index.ts:56` 在 `initBackground()` 中即构造 `TrayManager`，`tray.ts:9` 顶层 `import { Tray, nativeImage }`。因此 `tray.ts` 既在产物中、对象也真的建了。

**改法**：把桌面专属注册收进独立组合模块，server 路径根本不 import 它。

```
src/main/bootstrap/
├── essential.ts        # 保持：两种形态共用的首屏关键 handler
├── extended.ts         # 保持：两种形态共用的扩展服务
├── desktop.ts          # 新增：托盘 / 更新器 / 协议 / 菜单 / dock / 通知
└── server-mode.ts      # 已有：headless 启动序列
```

```ts
// extended.ts
if (!isServerMode()) {
  const { initializeDesktopServices } = await import('./desktop')
  initializeDesktopServices()
}
```

**边界约束**（须写入 `ARCHITECTURE.md §4`）：
- `bootstrap/desktop.ts` 是桌面专属注册的**唯一**入口，不允许在 `essential.ts` / `extended.ts` 中散落桌面守卫
- 新增服务默认进 `extended.ts`；仅当依赖窗口/托盘/菜单/原生通知等桌面会话能力时才进 `desktop.ts`
- 依赖方向不变，`bootstrap` 仍只向下依赖

**配套**：为 server 建立真正的构建变体，让上述 `if` 在 server 构建中成为编译期死代码：

- `electron.vite.config.ts` 增加 server mode，`define` 注入 `__SERVER__: true`
- `electron-builder.server.cjs` spread 基础配置，覆写 `files` / `asarUnpack` / `electronLanguages`
- `build-server-halo.sh` 改走既有 variant 机制，移除"临时换 `product.json` + `trap` 还原"
- `HALO_SERVER_MODE` 环境变量**保留**，用于桌面产物本地 headless 调试；生产 server 产物不再依赖它

> **收益预期要诚实**：`out/main` 去掉 sourcemap 后仅 2.6 MB，tree-shaking 主进程最多省几 MB。P2 的价值在于（a）消除 2.4 节的无效初始化与常驻对象，（b）修正语义错配，（c）让 P3 可表达。**不要以体积为 P2 的验收指标。**

### P3 — 可选子系统裁剪（需先定 server 形态）

以下四项体积最大，但是否保留取决于 server 的目标场景，需要产品/运维侧确认后再动：

| 子系统 | 体积 | 决策依据 |
|---|---|---|
| **Codex 引擎** | **−221 MB** | `server.product.json` 只放开 custom API 认证，而 Codex 需要独立登录态，server 上大概率不可用。二进制已 strip，无压缩空间，只能"不打包"或"按需下载" |
| **OCR（tesseract）** | −40 MB | 惰性加载，零运行时成本，纯体积。若保留，也应只打包实际会选中的 1 个 WASM 变体（现有 6 个） |
| **cloudflared** | −38 MB | 仅 `remoteAccess.tunnelEnabled` 时使用。容器部署通常前置正规 ingress |
| **Vulkan / SwiftShader** | −11 MB | `--disable-gpu --ozone-platform=headless` 下软件 GL 回退不参与。**需先验证 BrowserView 截图路径不依赖它** |

P3 的落地形态应是 `electron-builder.server.cjs` 中的 `files` / `asarUnpack` 差异 + `scripts/afterPack.cjs` 的 target 感知裁剪，而非在源码里加开关。

---

## 5. 明确不做的事

**不能把 server 换成纯 Node 进程。** Chromium 在 server 端是承重墙：

1. AI Browser 走 Electron 原生 CDP（`webContents.debugger.attach`，`services/ai-browser/context.ts:218`）
2. Web Search 使用离屏 BrowserView（`services/web-search/search-context.ts:205`）
3. daemon-browser 隐藏窗口承载自动化与企微扫码（`platform/background/daemon-browser.ts:244`）
4. `process.execPath`（Electron 二进制）被复用为所有 agent / MCP 子进程的 Node runtime（`ELECTRON_RUN_AS_NODE=1`，`services/agent/helpers.ts:74`）

**`out/renderer`（19.8 MB）必须保留**——它正是 HTTP 服务对外提供的前端（`http/server.ts:260,295`）。只有 `out/preload`（32 KB）对 server 是死的。

**不删除任何桌面代码。** 桌面客户端能力完整保留；本方案只改变"分支发生在构建期还是运行时"。

---

## 6. 验收指标

### 6.1 先测基线（P0 之前必须完成）

当前缺少运行中 server 实例的实测数据。开工前需补齐：

- 容器内 idle 状态：主进程 RSS、子进程数与各自 RSS、1 小时内累计 CPU 时间
- 单 agent 会话并发 1 / 5 / 10 时的 RSS 峰值
- 1 小时内的出站请求清单（用于验证 P1-5 等项确实消除了外呼）

### 6.2 目标

| 指标 | 现状 | 目标 |
|---|---|---|
| `dist/linux-unpacked` | 895 MB | ≤ 700 MB（P0+P1）；≤ 400 MB（含 P3） |
| 主进程启动 RSS | 待测（分词器贡献 +104.7 MB） | 较基线下降 ≥ 100 MB |
| 主进程启动耗时 | 待测（分词器贡献 +112 ms） | 较基线下降 ≥ 100 ms |
| idle 1 h 出站请求数 | 待测 | 0（除显式配置的 registry / IM 长连） |
| 桌面客户端各项指标 | — | **不得回归**（`quick.md` 规则 1） |

### 6.3 回归验证

- 桌面构建产物大小、启动耗时、托盘/更新/协议/通知功能逐项验证
- server 产物验证：HTTP 前端可访问、agent 会话可跑通、AI Browser 可用、Web Search 可用、调度任务按时触发、SIGTERM 优雅退出
- `tests/unit/apps/*`、`tests/unit/platform/*` 全绿

---

## 7. 风险

| 风险 | 缓解 |
|---|---|
| P0-2 误判某包为渲染层专用，导致运行时 `MODULE_NOT_FOUND` | 以 `out/main/**` 实际 import 清单做白名单比对；打包后跑冒烟用例 |
| P1-1 惰性化引入首次请求延迟 | 模块内缓存 promise 单例；在 server 启动完成后预热（可选，用 `registerIdleTask`） |
| P2 拆分遗漏，桌面侧功能丢失 | 拆分与守卫分两个 commit：先建 `desktop.ts` 并保证两种形态行为不变，再加编译期常量 |
| P3 裁掉了某场景实际依赖的子系统 | 先出一版保留全部子系统的 P0+P1 产物投产验证，P3 单独灰度 |
| 双 target 后 CI 构建时间翻倍 | server 产物按需构建（现状即"on demand"，见 `build-server-halo.sh` 注释），不进桌面发版流水线 |

---

## 8. 待确认事项

1. server 端是否需要 Codex 引擎？（决定 P3 中最大的 221 MB）
2. server 端是否有 OCR 场景？
3. server 是否依赖 cloudflared 隧道，还是由外部 ingress 接入？
4. store 升级检查与公告拉取在 server 端应保留、降频，还是完全交由运维？
5. 是否接受"server 产物与桌面产物走两条 electron-builder 配置"带来的维护成本？

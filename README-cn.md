# codex-telegram

Telegram Bot 网关 — 将本地 Codex 会话变成多项目、多线程、多 Agent 的远程控制面板。

适合已在本地使用 Codex 并希望：

- 通过 Telegram 继续工作
- 在一处管理多个仓库和线程
- 远程查看历史、运行状态和重试
- 从当前线程派生子 Agent
- 导入已有的 Codex / App / CLI 会话

本项目是 **本地优先** 的：bot 运行在你自己的机器上，直接管理你的 Codex home 和会话数据。

## 全授权模式 (Full-Auth)

所有 Codex 会话以 **全授权** 模式运行，不会出现审批提示：

| 调用 | 参数 | 说明 |
|------|------|------|
| `threadStart` | `approvalPolicy: 'never'`, `sandbox: 'danger-full-access'` | 线程级：不弹审批，完整权限 |
| `turnStart` | `approvalPolicy: 'never'`, `sandboxPolicy: { type: 'dangerFullAccess' }` | 每轮次强制覆盖 |

两处都传递全授权参数（见 `src/core/app-server-client.ts`），确保每个 thread 和每轮对话都运行在不受限的沙箱中。

> 注意：降级到 `codex exec` 模式（spawn 路径）时，如果 Codex 本身需要审批，可能出现 `waiting_approval` 状态。Bot 会将此标记为运行失败并提示用户重试。

> ⚠️ 这意味着 AI 可以自由读写文件、执行命令、访问网络。请在安全的环境中运行，并通过访问控制限制 Telegram 端的使用权限。

## 通道架构

Bot 通过 WebSocket 连接 Codex `app-server`，支持 Telegram 与本地 CLI 之间的实时同步：

```
┌─────────────┐     Relay WS     ┌─────────────┐     App-Server WS    ┌──────────────────┐
│ connect.ts  │◀────────────────▶│ Telegram Bot │◀───────────────────▶│  codex app-server │
│ (本地 CLI)  │                  │  (Node.js)   │                     │  (自动管理)       │
└─────────────┘                  └──────┬───────┘                     └──────────────────┘
                                        │
                                        ▼
                                  Telegram API
```

Bot 是 app-server 的唯一客户端。CLI 工具 (`connect.ts`) 通过 bot 的 relay WebSocket 间接连接，确保 bot 能接收所有事件并转发到 Telegram 和 CLI。

通道启用后：

- **流式输出**：Telegram 中逐步显示回复（"⏳ 思考中..." → 实时文本 → 最终消息）
- **双向同步**：Telegram 消息同步到 CLI，反之亦然（前缀 "🖥️ 本地:"）
- **自动导入**：通过 `connect.ts` 创建的线程自动导入 bot 数据库
- **优雅降级**：如果 `app-server` 不可用，bot 自动回退到 `codex exec` 模式

### 工作原理

1. 启动时 bot 拉起 `codex app-server`，通过 WebSocket (JSON-RPC) 连接
2. 同时启动一个 relay WebSocket 服务器（随机端口）
3. 两个 URL 保存到 `~/.codex-telegram/app-server.json`
4. Telegram 消息触发 `turn/start` 调用
5. `item/agentMessage/delta` 事件实时推送到 Telegram 和 relay 客户端
6. `connect.ts` 发送的消息也通过 app-server 处理并转发
7. app-server 崩溃时自动重连（指数退避）

## 核心概念

`codex-telegram` 在 Codex 会话之上建立了一套操作模型：

| 概念 | 说明 |
|------|------|
| `Source` | 一个 Codex home（共享或 bot 隔离） |
| `Project` | 一个仓库或工作目录 |
| `Thread` | 绑定到项目的 Codex 对话 |
| `Agent` | 从父线程派生的子任务 |
| `Run` | 一次具体的执行尝试（queued → running → completed/failed/cancelled） |

## 命令参考

### 快速参考表

| 命令 | 说明 |
|------|------|
| `/start` | 开始使用 |
| `/help` | 使用说明 |
| `/new` | 新建 thread |
| `/cwd` | 当前工作目录 |
| `/kill` | 终止当前执行 |
| `/cancel` | 取消当前执行 |
| `/undo` | 撤销上一轮 |
| `/pair <code>` | 配对授权 |
| `/ss [app]` | 截图（指定应用窗口或全屏） |
| `/unlock` | 解锁屏幕 |
| `/lock` | 锁定屏幕 |
| `/wake` | 唤醒屏幕 |
| `/windows` | 列出所有窗口 |
| `/project` | 项目管理 |
| `/thread` | 线程管理 |
| `/agent` | Agent 管理 |
| `/run` | 运行管理 |
| `/source` | 数据源管理 |

### 屏幕控制命令

这些命令用于远程控制 macOS 屏幕，定义在 `src/bot/commands/general.ts`：

**`/ss [app]`** — 截图

- 不带参数：截取全屏
- 带参数：截取指定应用窗口（例如 `/ss Ghostty`）
- 底层调用 `scripts/tg-screenshot` 脚本
- 图片自动压缩：宽度超过 2560px 时通过 Python PIL 缩小 2 倍（需要 `Pillow`）
- 超时：45 秒

**`/unlock`** — 解锁屏幕

- 需要环境变量 `SCREEN_PASSWORD`
- 唤醒屏幕 → 发送空格键 → 调用 Swift 解锁脚本输入密码
- 使用 `caffeinate` 保持唤醒状态

**`/lock`** — 锁定屏幕

- 调用 `pmset displaysleepnow` 使显示器休眠

**`/wake`** — 唤醒屏幕

- 调用 `caffeinate -u -t 10` 唤醒并保持 10 秒

**`/windows`** — 列出窗口

- 使用 CoreGraphics API 枚举所有窗口（包含最小化和其他空间的窗口）
- 自动过滤系统窗口（Dock、控制中心、通知中心、Raycast 等十余项）

### Source 命令

| 命令 | 说明 |
|------|------|
| `/source list [page] [pageSize]` | 列出数据源 |
| `/source search <keyword>` | 搜索数据源 |
| `/source show <id>` | 查看详情 |
| `/source enable <id>` | 启用 |
| `/source disable <id>` | 禁用 |
| `/source where <index\|id>` | 定位 |

### Project 命令

| 命令 | 说明 |
|------|------|
| `/project list [--sort name\|recent]` | 列出项目 |
| `/project search <keyword>` | 搜索项目 |
| `/project show` | 查看当前项目 |
| `/project new <name> [cwd]` | 新建项目 |
| `/project use <index\|id\|name\|cwd>` | 切换项目 |
| `/project rename <new_name>` | 重命名 |
| `/project archive` | 归档 |
| `/project delete` | 删除 |
| `/project set-source <shared\|bot_local>` | 设置默认数据源 |
| `/project set-source-mode <prefer\|force>` | 设置数据源模式 |
| `/project set-agent-source-override <allow\|deny>` | Agent 源覆盖策略 |
| `/project set-agent-auto-writeback <on\|off>` | Agent 自动写回 |
| `/project sync` | 同步 |
| `/project sync status` | 同步状态 |

### Thread 命令

| 命令 | 说明 |
|------|------|
| `/thread list [--sort name\|recent]` | 列出线程 |
| `/thread search <keyword>` | 搜索线程 |
| `/thread show` | 查看当前线程 |
| `/thread new` | 新建线程 |
| `/thread use <index\|thread_id>` | 切换线程 |
| `/thread rename <new_name>` | 重命名 |
| `/thread move <project>` | 移动到其他项目 |
| `/thread history [N] [--since ISO] [--until ISO]` | 查看历史 |
| `/thread turns [N] [--turn N]` | 按轮次查看 |
| `/thread summary [N]` | 摘要视图 |
| `/thread pin` / `unpin` | 置顶 / 取消置顶 |
| `/thread archive` / `delete` | 归档 / 删除 |

### Agent 命令

| 命令 | 说明 |
|------|------|
| `/agent spawn <role> <task>` | 派生子 Agent |
| `/agent list` | 列出 Agent |
| `/agent show <id>` | 查看 Agent 详情 |
| `/agent cancel <id>` | 取消 Agent |
| `/agent apply <id>` | 应用 Agent 结果 |

Agent 角色：`worker`、`explorer`、`reviewer`、`summarizer`、`general`

### Run 命令

| 命令 | 说明 |
|------|------|
| `/run list [status]` | 列出运行 |
| `/run show <run_id>` | 查看运行详情 |
| `/run cancel <run_id>` | 取消运行 |
| `/run retry <run_id>` | 重试运行 |

## tg-screenshot 脚本

位于 `scripts/tg-screenshot`，用于 macOS 截图和屏幕控制。

### 用法

```bash
# 全屏截图
tg-screenshot

# 截取指定应用窗口
tg-screenshot --app Ghostty

# 先解锁再截图
tg-screenshot --unlock <password> --app Ghostty

# 仅解锁
tg-screenshot --unlock <password>

# 仅锁屏
tg-screenshot --lock
```

### 参数

| 参数 | 说明 |
|------|------|
| `--app <name>` | 截取指定应用的窗口 |
| `--unlock <password>` | 先解锁屏幕再截图 |
| `-o <path>` | 输出文件路径 |
| `--lock` | 仅锁定屏幕 |

### 中文应用名映射

脚本内置了常见中文应用名映射，例如：

- `微信` / `wechat` → WeChat
- `QQ` → QQ / 腾讯QQ

### 窗口捕获流程

1. 通过 `osascript` 激活目标应用
2. 使用 CoreGraphics `CGWindowListCopyWindowInfo` 获取窗口 ID（含 `.optionAll` 枚举所有窗口）
3. 通过 `screencapture -x -l"$WID"` 按窗口 ID 截图
4. 如果找不到窗口，回退到全屏截图

## 环境变量

在项目根目录创建 `.env` 文件：

```dotenv
# 必须
TELEGRAM_BOT_TOKEN=your_bot_token_here      # 从 @BotFather 获取
OWNER_TELEGRAM_ID=your_telegram_id_here      # 你的 Telegram 用户 ID

# 可选
# SCREEN_PASSWORD=                           # macOS 屏幕解锁密码（/unlock 命令使用）
# CODEX_HOME=                                # 覆盖默认的共享 Codex home 路径
# CODEX_APP_SERVER_PORT=                     # app-server 固定端口（默认自动分配）
```

| 变量 | 必须 | 说明 |
|------|:----:|------|
| `TELEGRAM_BOT_TOKEN` | ✅ | Telegram Bot Token（从 @BotFather 获取） |
| `OWNER_TELEGRAM_ID` | ✅ | 机器人所有者的 Telegram 用户 ID |
| `SCREEN_PASSWORD` | ❌ | macOS 屏幕解锁密码，供 `/unlock` 命令使用 |
| `CODEX_HOME` | ❌ | 覆盖共享 Codex home 路径（默认 `~/.codex`） |
| `CODEX_APP_SERVER_PORT` | ❌ | app-server WebSocket 固定端口（默认自动分配） |

## 安装

### 前提条件

- Node.js 20+
- Telegram Bot Token（从 @BotFather 获取）
- 本地 Codex 安装且可访问
- 可持续运行 bot 进程的机器（macOS，屏幕控制命令依赖 macOS API）

### 步骤

```bash
# 克隆仓库
git clone <repo-url> ~/.codex-telegram
cd ~/.codex-telegram

# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env 填入你的 TELEGRAM_BOT_TOKEN 和 OWNER_TELEGRAM_ID
```

## 运行

```bash
# 开发模式（热重载）
npm run dev

# 生产模式
npm run start

# 本地 CLI 客户端
npm run connect -- --new
```

npm 脚本通过 `scripts/with-node.sh` 确保使用真实的 Node.js（绕过 Bun 的 `node` shim），因为 `tsx`、`vitest` 和 `better-sqlite3` 等依赖需要 Node 环境。

## 首次运行

启动后 bot 会：

1. 加载 `.env`
2. 如果设置了 `OWNER_TELEGRAM_ID`，自动创建所有者访问权限
3. 初始化状态存储和导入器
4. 开始轮询 Telegram 更新

在 Telegram 中：

1. 发送 `/start`
2. 发送 `/help` 查看帮助
3. 如需要，完成 `/pair` 配对
4. 发送消息或使用 `/new` 开始工作

## 架构

### 模块结构

**根目录模块：**

| 文件 | 说明 |
|------|------|
| `server.ts` | Bot 入口，启动和路由 |
| `session-manager.ts` | 编排层 — 项目/线程/会话生命周期 |
| `run-scheduler.ts` | 运行队列和状态机 |
| `agent-manager.ts` | 子 Agent 跟踪和写回 |
| `history-reader.ts` | 线程历史提取和摘要 |
| `importer.ts` | 增量导入和同步 |
| `state-store.ts` | SQLite 持久化存储 |
| `storage-policy.ts` | 数据源和写回策略 |
| `project-normalizer.ts` | 路径 → 项目名推断 |
| `access.ts` | 访问控制和配对 |
| `import-cursor.ts` | 导入扫描游标管理 |
| `models.ts` | 共享类型定义 |

**`src/bot/` — Telegram 交互层：**

- `commands/` — 每个命令组一个模块（`general`、`project`、`thread`、`agent`、`run`、`source`、`messages`）
- `views/` — 输出格式化（`formatting`、`pagination`、`sections`）
- `middleware/` — 请求中间件（`auth`、`ack`、`helpers`）
- `callbacks/` — 回调处理
- `i18n/` — 本地化（`zh`）
- `delivery.ts` — 消息投递和流式支持

**`src/core/` — 核心服务：**

| 文件 | 说明 |
|------|------|
| `app-server-client.ts` | JSON-RPC 协议客户端（含全授权参数） |
| `codex-bridge.ts` | app-server 进程管理和 WebSocket 桥接 |
| `execution-engine.ts` | 双路径执行：app-server 或 spawn |
| `relay-server.ts` | CLI 客户端的 relay WebSocket 服务 |
| `project-service.ts` | 项目 CRUD |
| `thread-service.ts` | 线程 CRUD |
| `undo-manager.ts` | 撤销逻辑 |
| `query-service.ts` | 搜索、分页和列表查询 |

**`src/data/` — SQLite 数据层：**

- `database.ts` — 连接和 schema 管理
- `repositories/` — 类型化仓库类（source、project、thread、agent、selection、cursor、access）
- `migrate-json.ts` — JSON → SQLite 一次性迁移
- `migrations/` — schema 迁移（schema 变更内嵌在 `database.ts` 中）

### 存储

所有 bot 状态存储在单个 SQLite 数据库中：

| 路径 | 说明 |
|------|------|
| `~/.codex` | 共享 Codex home |
| `~/.codex-telegram/codex-home` | Bot 隔离的 Codex home |
| `~/.codex-telegram/state/` | Bot 状态目录 |
| `~/.codex-telegram/state/codex-telegram.sqlite` | 主数据库 |

两个内置数据源：

- **`shared`** — 基于你的 Codex home，策略：`shared`
- **`bot_local`** — 基于 bot 自己的 Codex home，隔离策略

## 访问控制

配置在 `access.ts`，持久化到 SQLite 数据库（`~/.codex-telegram/state/codex-telegram.sqlite` 的 `access_config` 表）。

DM 策略：`pairing`、`allowlist`、`disabled`

群聊支持 per-group 白名单和 @提及 要求。

配对流程：

1. 用户发送 `/pair`
2. Bot 生成短期配对码（1 小时有效）
3. 验证成功后获得访问权限

## 数据源策略

| 概念 | 选项 | 说明 |
|------|------|------|
| `defaultSourceId` | — | 项目默认数据源 |
| `sourceMode` | `prefer` / `force` / `policy-default` | 数据源选择模式 |
| `agentSourceOverrideMode` | `allow` / `deny` / `policy-default` | Agent 是否可偏离父线程数据源 |

## 运行状态和重试

运行有明确的操作状态：`queued` → `running` → `completed` / `failed` / `cancelled`

关键行为：

- 取消操作会中止正在运行的进程，而不仅是队列项
- 非零退出码不会被视为 completed
- 重试保留重试链
- 降级模式（spawn 路径）下如 Codex 需要审批，会标记为 `waiting_approval` 失败

## 撤销语义

`/undo` 策略保守：

1. 先清除当前线程的排队/运行任务
2. 尝试撤销最近的可见用户轮次
3. 如果线程安全（bot 隔离的 Telegram 线程），执行物理重写
4. 否则回退到本地历史隐藏

## 开发

```bash
# 类型检查
npm run typecheck

# 运行测试
npm test
```

技术栈：

- TypeScript + ESM（`.js` 扩展名导入）
- `tsx` 执行（通过 `scripts/with-node.sh`）
- `grammy` — Telegram 集成
- `better-sqlite3` — SQLite 持久化
- `ws` — WebSocket
- `vitest` — 测试框架

无需构建步骤，本地开发只需 TypeScript 工具链。

## 项目结构

```text
.
├── server.ts                    # Bot 入口
├── session-manager.ts           # 编排层
├── run-scheduler.ts             # 运行队列
├── agent-manager.ts             # Agent 管理
├── history-reader.ts            # 历史提取
├── importer.ts                  # 增量导入
├── import-cursor.ts             # 导入扫描游标
├── state-store.ts               # SQLite 存储
├── access.ts                    # 访问控制
├── storage-policy.ts            # 数据源和写回策略
├── project-normalizer.ts        # 路径 → 项目名推断
├── models.ts                    # 类型定义
├── connect.ts                   # 本地 CLI 客户端
├── scripts/
│   ├── tg-screenshot            # 截图脚本（v8）
│   └── with-node.sh             # Node.js 环境包装
├── src/
│   ├── bot/
│   │   ├── commands/            # 命令处理
│   │   │   ├── general.ts       #   /start, /help, /ss, /unlock, /lock, /wake, /windows, ...
│   │   │   ├── project.ts       #   /project *
│   │   │   ├── thread.ts        #   /thread *
│   │   │   ├── agent.ts         #   /agent *
│   │   │   ├── run.ts           #   /run *
│   │   │   ├── source.ts        #   /source *
│   │   │   └── messages.ts      #   纯文本消息处理
│   │   ├── views/               # 输出格式化
│   │   ├── callbacks/           # 回调处理
│   │   ├── middleware/          # 中间件
│   │   ├── i18n/                # 本地化 (zh)
│   │   └── delivery.ts          # 消息投递
│   ├── core/                    # 核心服务
│   │   ├── app-server-client.ts #   JSON-RPC 客户端（全授权）
│   │   ├── codex-bridge.ts      #   app-server 桥接
│   │   ├── execution-engine.ts  #   双路径执行引擎
│   │   ├── relay-server.ts      #   Relay WebSocket
│   │   └── ...                  #   project/thread/undo/query
│   └── data/                    # SQLite 数据层
│       ├── database.ts
│       ├── repositories/        # 类型化仓库
│       ├── migrate-json.ts
│       └── migrations/
├── tests/                       # vitest 测试套件
├── unlock.swift                 # macOS 解锁辅助
├── tsconfig.json
└── package.json
```

## 验证通道

### 前提

1. Codex CLI 已安装（`codex --version`）
2. Bot 正在运行（`npm run dev`）
3. 已配置 Telegram 会话

### 基本验证

```bash
# 启动 bot，观察日志：
# [server] codex app-server connected via WebSocket
# [server] relay server listening on ws://127.0.0.1:XXXXX

# 创建线程：
npm run connect -- --new

# 或选择已有线程：
npm run connect --
```

### 诊断清单

| 检查项 | 预期结果 | 验证方式 |
|--------|----------|----------|
| App-server 启动 | 日志显示 `connected via WebSocket` | 观察启动日志 |
| Relay 启动 | 日志显示 `relay server listening` | 观察启动日志 |
| connect.ts 连接 | 输出 `Connected.` | `npm run connect -- --new` |
| 本地 → Telegram | Telegram 显示 "🖥️ 本地:" 消息 | 在 connect.ts 中输入 |
| Telegram → 本地 | connect.ts 实时显示流式回复 | 在 Telegram 中发消息 |
| 取消/中断 | 流式输出停止 | 回复过程中发送 `/cancel` |
| 降级模式 | 仍有回复（无流式） | 杀掉 app-server 后发消息 |

### 故障排查

- **Bot 未运行**：先启动 bot — connect.ts 读取 `~/.codex-telegram/app-server.json`
- **Relay 不可用**：重启 bot
- **connect.ts 无流式输出**：确认线程 ID 正确
- **Telegram 无转发**：检查 `.env` 中的 `OWNER_TELEGRAM_ID`
- **app-server 启动失败**：确认 `codex` 在 PATH 中

## 安全提示

- 此 bot 是特权本地控制面板 — 有 Telegram 访问权限的人可以触发本地 Codex 任务
- 全授权模式下 AI 有完整的文件/网络访问权限，请确保运行环境安全
- `scripts/tg-screenshot` 通过 `--unlock` 命令行参数读取屏幕解锁密码 — 切勿在脚本中硬编码密钥
- 高风险或高频自动化建议使用隔离数据源
- 启用自动写回前请审查策略
- 群聊场景请仔细配置白名单和 @提及 要求

## 非目标

本项目不是：

- 托管 SaaS 服务
- 通用 Telegram 框架
- Codex 的替代品
- 脱离本地 Codex home 的抽象工作流引擎

它是为本地 Codex 用户提供的实用操作层。

## License

MIT（或你选择的许可证）。发布前请添加 `LICENSE` 文件。

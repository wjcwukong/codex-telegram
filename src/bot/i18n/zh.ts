// ─── Pair messages ───────────────────────────────────────────────────────────

export const PAIR = {
  ONLY_AUTHORIZED: '该命令只能在已授权会话中使用。',
  USAGE: '用法: /pair <配对码>',
  INVALID_CODE: '配对码无效或已过期。',
  SUCCESS: '配对成功。该 Telegram 用户已加入允许列表。',
  CODE_PROMPT: (code: string) => `配对码: ${code}`,
  CODE_INSTRUCTION: (code: string) =>
    `在已授权会话中发送 /pair ${code} 完成绑定。`,
} as const

// ─── Project messages ────────────────────────────────────────────────────────

export const PROJECT = {
  NO_ACTIVE: '当前还没有激活 project。',
  NO_AVAILABLE: '当前还没有可用 project。',
  NO_IMPORT_SOURCE: '当前没有启用 import 的 source。',
  NOT_IN_LIST: (name: string) => `当前 project 不在可见列表中: ${name}`,
  NO_MATCH: (query: string) => `没有匹配的 project: ${query}`,
  LIST_HEADER: (page: number, totalPages: number, pageSize: number) =>
    `当前 projects: page ${page}/${totalPages}, pageSize ${pageSize}`,

  SEARCH_USAGE:
    '用法: /project search <keyword> [page] [pageSize] [--sort name|recent]',

  NEW_USAGE: '用法: /project new <name> [cwd]',
  CREATED: (name: string, cwd: string) =>
    `已创建并切换到 project:\n${name}\n${cwd}`,
  CREATE_FAIL: (msg: string) => `创建 project 失败: ${msg}`,

  RENAME_USAGE: '用法: /project rename <new_name>',
  RENAMED: (name: string, cwd: string) =>
    `已重命名 project:\n${name}\n${cwd}`,
  RENAME_FAIL: (msg: string) => `重命名 project 失败: ${msg}`,

  ARCHIVED: (name: string, cwd: string) =>
    `已归档 project:\n${name}\n${cwd}`,
  ARCHIVE_FAIL: (msg: string) => `归档 project 失败: ${msg}`,

  DELETED: (name: string, cwd: string) =>
    `已删除 project:\n${name}\n${cwd}`,
  DELETE_FAIL: (msg: string) => `删除 project 失败: ${msg}`,

  SET_SOURCE_USAGE: '用法: /project set-source <shared|bot_local>',
  SET_SOURCE_OK: (name: string, sourceId: string, codexHome: string) =>
    `已设置 project 默认 source:\n${name}\nsource: ${sourceId}\n${codexHome}`,
  SET_SOURCE_FAIL: (msg: string) => `设置 source 失败: ${msg}`,

  SET_SOURCE_MODE_USAGE:
    '用法: /project set-source-mode <prefer|force|policy-default>',
  SET_SOURCE_MODE_OK: (name: string, mode: string) =>
    `已设置 project source mode:\n${name}\nmode: ${mode}`,
  SET_SOURCE_MODE_FAIL: (msg: string) => `设置 source mode 失败: ${msg}`,

  SET_AGENT_SOURCE_OVERRIDE_USAGE:
    '用法: /project set-agent-source-override <allow|deny|policy-default>',
  SET_AGENT_SOURCE_OVERRIDE_OK: (name: string, mode: string) =>
    `已设置 project agent source override:\n${name}\nmode: ${mode}`,
  SET_AGENT_SOURCE_OVERRIDE_FAIL: (msg: string) =>
    `设置 agent source override 失败: ${msg}`,

  SET_AGENT_AUTO_WRITEBACK_USAGE:
    '用法: /project set-agent-auto-writeback <on|off>',
  SET_AGENT_AUTO_WRITEBACK_OK: (name: string, enabled: boolean) =>
    `已设置 project agent auto writeback:\n${name}\nenabled: ${enabled}`,
  SET_AGENT_AUTO_WRITEBACK_FAIL: (msg: string) =>
    `设置 agent auto writeback 失败: ${msg}`,

  USE_USAGE: '用法: /project use <index|id|name|cwd>',
  SWITCHED: (name: string, cwd: string) =>
    `已切换到 project:\n${name}\n${cwd}`,
  SWITCH_FAIL: (msg: string) => `切换 project 失败: ${msg}`,

  CURRENT_INFO: (name: string, cwd: string, count: number) =>
    `当前 project:\n${name}\n${cwd}\n已记录: ${count}`,
  CURRENT_NONE: (count: number) =>
    `当前还没有激活 project。\n已记录: ${count}`,

  SYNC_DONE: '项目同步完成。',

  USAGE_HELP: [
    '用法:',
    '/project current',
    '/project list',
    '/project show',
    '/project new <name> [cwd]',
    '/project rename <new_name>',
    '/project archive',
    '/project delete',
    '/project search <keyword> [page] [pageSize] [--sort name|recent]',
    '/project where [pageSize]',
    '/project set-source <shared|bot_local>',
    '/project set-source-mode <prefer|force|policy-default>',
    '/project set-agent-source-override <allow|deny|policy-default>',
    '/project set-agent-auto-writeback <on|off>',
    '/project use <index|id|name|cwd>',
    '/project sync',
    '/project sync status',
    '/project list [page] [pageSize] [--sort name|recent]',
  ].join('\n'),
} as const

// ─── Thread messages ─────────────────────────────────────────────────────────

export const THREAD = {
  NEW_THREAD: (cwd: string, codexThreadId?: string) =>
    codexThreadId
      ? `✅ 已创建 thread\n\n🆔 \`${codexThreadId}\`\n📂 ${cwd}\n\n💡 本地同步: \`npx tsx connect.ts ${codexThreadId}\``
      : `已切到新 thread。\n工作目录: ${cwd}`,
  NO_ACTIVE_PROJECT:
    '当前没有激活 project。先用 /project list 或 /project use。',
  NO_SAVED_THREADS:
    '当前 project 还没有已保存的 thread。发送一条消息后会自动创建。',
  CURRENT_PROJECT: (name: string) => `当前 project: ${name}`,
  SORT_BY_TITLE: '按 title 排序:',
  SORT_BY_UPDATED: '按 updatedAt 倒序:',

  SEARCH_USAGE:
    '用法: /thread search <keyword> [page] [pageSize] [--sort name|recent]',
  NO_MATCH: (query: string) => `当前 project 下没有匹配的 thread: ${query}`,

  NO_ACTIVE: '当前还没有激活 thread。发送一条消息或用 /thread new 新建。',
  NOT_IN_LIST: (title: string) =>
    `当前 thread 不在可见列表中: ${title}`,

  NO_HISTORY: '当前还没有可显示的历史消息。',
  NO_TURNS: '当前还没有可显示的 turns。',
  NO_SUMMARIZABLE_TURNS: '当前还没有可汇总的 turns。',

  MOVE_USAGE: '用法: /thread move <project_index|id|name|cwd>',
  MOVED: (projectName: string) => `已移动 thread 到 project: ${projectName}`,
  CWD_UNCHANGED: (cwd: string) => `cwd 保持不变: ${cwd}`,
  MOVE_FAIL: (msg: string) => `移动 thread 失败: ${msg}`,

  ARCHIVED: (title: string, id: string) =>
    `已归档 thread:\n${title}\n${id}`,
  ARCHIVE_FAIL: (msg: string) => `归档 thread 失败: ${msg}`,

  DELETED: (title: string, id: string) =>
    `已删除 thread:\n${title}\n${id}`,
  DELETE_FAIL: (msg: string) => `删除 thread 失败: ${msg}`,

  PINNED: (title: string, id: string) =>
    `已置顶 thread:\n${title}\n${id}`,
  PIN_FAIL: (msg: string) => `置顶 thread 失败: ${msg}`,

  UNPINNED: (title: string, id: string) =>
    `已取消置顶 thread:\n${title}\n${id}`,
  UNPIN_FAIL: (msg: string) => `取消置顶失败: ${msg}`,

  RENAME_USAGE: '用法: /thread rename <new_name>',
  RENAMED: (title: string, id: string) =>
    `已重命名 thread:\n${title}\n${id}`,
  RENAME_FAIL: (msg: string) => `重命名 thread 失败: ${msg}`,

  USE_USAGE: '用法: /thread use <index|thread_id>',
  IMPORTED_AND_SWITCHED: (title: string, id: string) =>
    `已导入并切换到 thread:\n${title}\n${id}`,
  SWITCHED: (title: string, id: string) =>
    `已切换到 thread:\n${title}\n${id}`,
  ALSO_SWITCHED_PROJECT: '\n(已同时切换 project)',
  SWITCH_FAIL: (msg: string) => `切换 thread 失败: ${msg}`,

  CURRENT_INFO: (
    title: string,
    id: string,
    projectName: string,
    cwd: string,
    count: number,
  ) =>
    `当前 thread:\n${title}\n${id}\nproject: ${projectName}\ncwd: ${cwd}\n已记录: ${count}`,
  CURRENT_NONE: (projectName: string, count: number) =>
    `当前还没有激活 thread。\nproject: ${projectName}\n已记录: ${count}\n发送一条消息或用 /thread new 新建。`,

  USAGE_HELP: [
    '用法:',
    '/thread current',
    '/thread history [N] [--cursor CURSOR] [--since ISO] [--until ISO] [--tools] [--agents]',
    '/thread turns [N] [--cursor CURSOR] [--turn N] [--since ISO] [--until ISO] [--tools] [--agents]',
    '/thread summary [N] [--cursor CURSOR] [--turn N] [--since ISO] [--until ISO] [--tools] [--agents]',
    '/thread list [page] [pageSize] [--sort name|recent]',
    '/thread search <keyword> [page] [pageSize] [--sort name|recent]',
    '/thread where [pageSize]',
    '/thread show',
    '/thread move <project_index|id|name|cwd>',
    '/thread new',
    '/thread undo',
    '/thread archive',
    '/thread delete',
    '/thread pin',
    '/thread unpin',
    '/thread rename <new_name>',
    '/thread use <index|thread_id>',
  ].join('\n'),
} as const

// ─── Source messages ─────────────────────────────────────────────────────────

export const SOURCE = {
  ENABLE_USAGE: '用法: /source enable <id> | /source disable <id>',
  ENABLED: (id: string, codexHome: string) =>
    `已启用 source:\n${id}\n${codexHome}`,
  DISABLED: (id: string, codexHome: string) =>
    `已禁用 source:\n${id}\n${codexHome}`,
  UPDATE_FAIL: (msg: string) => `更新 source 失败: ${msg}`,

  SHOW_USAGE: '用法: /source show <shared|bot_local>',
  UNKNOWN: (ref: string) => `未知 source: ${ref}`,

  WHERE_USAGE: '用法: /source where <index|id> [pageSize]',

  SEARCH_USAGE: '用法: /source search <keyword> [page] [pageSize]',
  NO_MATCH: (query: string) => `没有匹配的 source: ${query}`,
} as const

// ─── Agent messages ──────────────────────────────────────────────────────────

export const AGENT = {
  SPAWN_USAGE_ROLES: (roles: string) =>
    `用法: /agent spawn <${roles}> <task>`,
  SPAWN_USAGE: '用法: /agent spawn <role> <task>',
  CREATED: (id: string) => `已创建 agent: ${id}`,
  TASK_STARTED: '任务已在后台启动。',
  CREATE_FAIL: (msg: string) => `创建 agent 失败: ${msg}`,

  CANCEL_USAGE: '用法: /agent cancel <agent_id>',
  CANCELLED: (id: string) => `已取消 agent: ${id}`,
  CANCEL_FAIL: (msg: string) => `取消 agent 失败: ${msg}`,

  SHOW_USAGE: '用法: /agent show <agent_id|child_thread_id>',
  NOT_FOUND: (ref: string) => `找不到 agent: ${ref}`,

  APPLY_USAGE: '用法: /agent apply <agent_id>',
  APPLY_OK: (id: string) => `已提交 agent 回填: ${id}`,
  APPLY_FAIL: (msg: string) => `agent 回填失败: ${msg}`,

  WHERE_USAGE:
    '用法: /agent where <index|agent_id|child_thread_id> [pageSize]',
  NO_ACTIVE_THREAD:
    '当前没有激活 thread。发送一条消息或用 /thread new 新建。',

  SEARCH_USAGE: '用法: /agent search <keyword> [page] [pageSize]',
  NO_MATCH: (query: string) => `当前范围下没有匹配的 agent: ${query}`,

  NO_AGENTS: '当前还没有 agents。',
} as const

// ─── Run messages ────────────────────────────────────────────────────────────

export const RUN = {
  SHOW_USAGE: '用法: /run show <run_id>',
  NOT_FOUND: (runId: string) => `找不到 run: ${runId}`,

  CANCEL_USAGE: '用法: /run cancel <run_id>',
  CANCELLED: (runId: string) => `已取消 run: ${runId}`,
  CANCEL_UNABLE: (runId: string) => `无法取消 run: ${runId}`,

  RETRY_USAGE: '用法: /run retry <run_id>',
  RETRIED: (runId: string) => `已重试 run: ${runId}`,
  RETRY_FAIL: (msg: string) => `重试 run 失败: ${msg}`,

  WHERE_USAGE: '用法: /run where <run_id> [pageSize]',

  SEARCH_USAGE: '用法: /run search <keyword> [status] [page] [pageSize]',
  NO_MATCH: (query: string) => `当前范围下没有匹配的 run: ${query}`,

  NO_RUNS: '当前 project/thread 没有匹配的 runs。',
} as const

// ─── Cancel/Kill messages ────────────────────────────────────────────────────

export const CANCEL = {
  NO_THREAD: '当前没有激活 thread，可取消的执行为空。',
  NOTHING_RUNNING: '当前没有正在运行或排队中的任务。',
  KILLED_AND_CLEARED: '已取消当前执行，并清空该 thread 的待执行消息。',
  KILLED: '已取消当前执行。',
  CLEARED: '已清空该 thread 的待执行消息。',
} as const

// ─── Undo messages ───────────────────────────────────────────────────────────

export const UNDO = {
  MODE_REWRITTEN: '已物理撤回最近一轮 user turn',
  MODE_HIDDEN: '已隐藏最近一轮 user turn',
  NOTE_LOCAL_ONLY:
    '注意: 这是本地历史隐藏，不会修改已写入 Codex source 的原始 rollout。',
  FAIL: (msg: string) => `撤回最近一轮失败: ${msg}`,
} as const

// ─── Screen control messages ─────────────────────────────────────────────────

export const SCREEN = {
  SCREENSHOT_APP_PROGRESS: (app: string) => `截图 ${app} 窗口中...`,
  SCREENSHOT_FULL_PROGRESS: '全屏截图中...',
  SCREENSHOT_FAIL: (msg: string) => `截图失败: ${msg}`,

  SS_APP_PROGRESS: (app: string) => `截图 ${app} 中...`,
  SS_FULL_PROGRESS: '截图中...',

  NO_PASSWORD: '未配置 SCREEN_PASSWORD，请在 .env 中设置。',
  UNLOCK_PROGRESS: '解锁中...',
  UNLOCK_DONE: '解锁完成。',
  UNLOCK_FAIL: (msg: string) => `解锁失败: ${msg}`,

  WAKE_DONE: '屏幕已唤醒。',
  WAKE_FAIL: (msg: string) => `唤醒失败: ${msg}`,

  LOCK_DONE: '屏幕已锁定。',
  LOCK_FAIL: (msg: string) => `锁屏失败: ${msg}`,

  WINDOWS_LIST: (list: string) => `当前窗口:\n${list}`,
  WINDOWS_FAIL: (msg: string) => `获取窗口列表失败: ${msg}`,
  NO_WINDOWS: '(无窗口)',
} as const

// ─── General messages ────────────────────────────────────────────────────────

export const GENERAL = {
  LOOKS_LIKE_COMMAND: (cmd: string) =>
    `这条消息看起来像命令，是否想输入 /${cmd} ？\n命令必须以 / 开头，否则会被转发给 Codex。`,

  WELCOME: [
    'Codex Telegram Bot 已启动。',
    '',
    '直接发送文本会转发到当前激活的 Codex thread。',
    '发送文档会保存到 ~/.codex-telegram/inbox/ 后把路径交给 Codex。',
    '一个 Telegram 会话可以管理多个 Codex threads。',
    '',
    '常用命令：',
    '/source list|search|show|enable|disable|where 管理 sources',
    '/project current|list|show|new|rename|archive|delete|search|where|set-source|set-source-mode|set-agent-source-override|set-agent-auto-writeback|use|sync 管理多个 projects',
    '/agent list|search|show|spawn|cancel|apply|where 管理 agents',
    '/run list|search|show|cancel|retry|where 管理运行中的任务',
    '/new 切到新 thread',
    '/thread current|history|turns|summary|list|show|move|new|undo|rename|archive|delete|search|where|pin|use 管理多个 threads',
    '/cwd 查看当前工作目录',
    '/kill 终止当前执行',
    '/cancel 取消当前执行',
    '/undo 撤回最近一轮 user turn（优先物理改写 source，失败时回退为本地隐藏）',
    '/pair <code> 确认配对码',
    '/screenshot [app] 截取窗口（留空=全屏）',
    '/ss [app] 解锁+截图一键完成',
    '/unlock 唤醒+解锁屏幕',
    '/wake 唤醒屏幕',
    '/windows 列出所有窗口',
    '/help 查看帮助',
  ].join('\n'),

  HELP: (workdir: string) =>
    [
      '使用说明：',
      '1. 私聊未授权用户首次发消息时会收到配对码。',
      '2. 在已授权会话里发送 /pair <code>，把该 Telegram 用户加入允许列表。',
      '3. 之后直接发送文本即可持续复用当前激活的 Codex thread。',
      '4. /new 会切到一个新的 Codex thread。',
      '5. /thread history 可按 cursor / since / until 查看当前 thread 历史，支持 tools / agents 视图。',
      '6. /thread turns 可按 turn 分组查看历史，也支持 --turn 跳到某一轮。',
      '7. /thread summary 可快速查看每个 turn 的摘要，也支持 --turn 跳到某一轮。',
      '8. /thread show 可查看当前 thread 的完整详情。',
      '9. /thread move 可手动把当前 thread 归到别的 project。',
      '10. /thread rename 可给当前 thread 改名。',
      '11. /thread archive、/thread delete、/thread search、/thread where、/thread pin 可整理、筛选和定位 threads。',
      '12. /thread list、/thread use、/thread undo 支持分页定位，也可用 --sort name|recent 调整顺序。',
      '13. /source list、/source search、/source show、/source enable、/source disable、/source where 可查看、控制和定位 sources。',
      '14. /project show 可查看当前 project 详情。',
      '15. /project new 和 /project rename 可创建、重命名 project。',
      '16. /project archive、/project delete、/project search、/project where 可整理和定位 projects；list/search 也支持 --sort name|recent。',
      '17. /project set-source 可设置新 thread 默认落到 shared 或 bot_local。',
      '18. /project set-source-mode、/project set-agent-source-override、/project set-agent-auto-writeback 可控制 source policy 与 agent 回填策略。',
      '19. /project list 和 /project use 可在多个 projects 之间切换。',
      '20. /project sync、/project sync status 可导入 App/CLI 已有对话，并查看后台增量 sync 状态。',
      '21. /agent spawn、/agent list、/agent search、/agent show、/agent cancel、/agent apply、/agent where 可管理后台 agents 并定位结果页。',
      '22. /run list [status] [page] [pageSize]、/run search、/run show、/run cancel、/run retry、/run where 可查看、区分 waiting_approval/failed，并定位 runs。',
      '23. /kill 或 /cancel 可取消当前执行。',
      '24. /undo 可撤回最近一轮 user turn，并清空该 thread 当前执行/排队任务；优先物理改写 source，失败时回退为本地隐藏。',
      '25. 发送文档会下载到本机 inbox 目录，并把本地路径发给 Codex。',
      '',
      '屏幕控制：',
      '/screenshot [app] - 截取指定 app 窗口（留空=全屏）',
      '/ss [app] - 解锁+截图一键完成',
      '/unlock - 唤醒+解锁锁屏',
      '/wake - 仅唤醒屏幕',
      '/windows - 列出当前所有打开的窗口',
      '/source list|search|show|enable|disable|where - 查看和控制 Codex sources',
      '/project current|list|show|new|rename|archive|delete|search|where|set-source|set-source-mode|set-agent-source-override|set-agent-auto-writeback|use|sync - 管理多个 Codex projects',
      '/agent list|search|show|spawn|cancel|apply|where - 管理后台 agents',
      '/run list|search|show|cancel|retry|where - 查看和控制运行中的任务',
      '/thread current|history|turns|summary|list|show|move|new|undo|rename|archive|delete|search|where|pin|use - 管理多个 Codex threads',
      '/kill | /cancel - 取消当前执行',
      '/undo - 撤回最近一轮 user turn（优先物理改写 source，失败时回退为本地隐藏）',
      '',
      `当前工作目录: ${workdir}`,
    ].join('\n'),

  WELCOME_NAV: '👋 欢迎使用 Codex Telegram Bot!\n\n选择一个模块开始:',
  HELP_MENU: '❓ 帮助 — 选择主题:',
  SOURCE_MENU: '📦 Source 管理',
  SOURCE_LIST_TITLE: '📦 Sources',
} as const

// ─── Help topics ─────────────────────────────────────────────────────────────

export const HELP_TOPICS: Record<string, string> = {
  project: [
    '📁 项目管理',
    '',
    '/project list — 列出所有项目',
    '/project use <ref> — 切换项目',
    '/project new <name> [cwd] — 新建项目',
    '/project show — 查看当前项目详情',
    '/project rename <name> — 重命名',
    '/project archive — 归档项目',
    '/project delete — 删除项目',
    '/project search <keyword> — 搜索项目',
    '/project sync — 同步导入 App/CLI 数据',
    '',
    'Source 设置:',
    '/project set-source <shared|bot_local>',
    '/project set-source-mode <prefer|force|policy-default>',
    '/project set-agent-source-override <allow|deny|policy-default>',
    '/project set-agent-auto-writeback <on|off>',
  ].join('\n'),

  thread: [
    '💬 线程管理',
    '',
    '/thread list — 列出 threads',
    '/thread use <ref> — 切换 thread',
    '/new — 新建 thread',
    '/thread show — 查看详情',
    '/thread history [N] — 查看历史',
    '/thread turns [N] — 按轮查看',
    '/thread summary [N] — 摘要视图',
    '/thread move <project> — 移动到其他项目',
    '/thread rename <name> — 重命名',
    '/thread pin / unpin — 置顶/取消',
    '/thread archive / delete — 归档/删除',
    '/thread search <keyword> — 搜索',
  ].join('\n'),

  agent: [
    '🤖 Agent 管理',
    '',
    '/agent list — 列出 agents',
    '/agent spawn <role> <task> — 创建后台 agent',
    '/agent show <id> — 查看 agent 状态',
    '/agent cancel <id> — 取消 agent',
    '/agent apply <id> — 应用 agent 结果',
    '/agent search <keyword> — 搜索 agents',
  ].join('\n'),

  run: [
    '🏃 运行管理',
    '',
    '/run list [status] — 列出运行记录',
    '/run show <id> — 查看运行详情',
    '/run cancel <id> — 取消运行',
    '/run retry <id> — 重试运行',
    '/run search <keyword> — 搜索运行记录',
  ].join('\n'),

  source: [
    '📦 数据源管理',
    '',
    '/source list — 列出所有 sources',
    '/source show <id> — 查看 source 详情',
    '/source enable <id> — 启用 source',
    '/source disable <id> — 禁用 source',
    '/source search <keyword> — 搜索',
    '/source where <id> — 定位 source',
  ].join('\n'),

  access: [
    '🔑 权限与配对',
    '',
    '1. 未授权用户首次发消息时会收到配对码',
    '2. 在已授权会话中发送 /pair <code> 完成绑定',
    '3. 绑定后即可使用所有命令',
    '',
    '/pair <code> — 确认配对码',
  ].join('\n'),

  tips: [
    '💡 使用技巧',
    '',
    '• 直接发送文本会转发到当前 Codex thread',
    '• 发送文档会保存到 inbox 并交给 Codex 处理',
    '• /kill 或 /cancel 可随时终止执行',
    '• /undo 可撤回最近一轮操作',
    '• 支持 --sort name|recent 排序列表',
    '• search 命令支持模糊搜索',
    '',
    '屏幕控制:',
    '/screenshot [app] — 截图',
    '/ss [app] — 解锁+截图',
    '/unlock — 解锁屏幕',
    '/wake — 唤醒屏幕',
    '/windows — 列出窗口',
  ].join('\n'),
}

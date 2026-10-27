# dsh-tui

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 加一个**终端交互界面**：敲 `dsh tui`，就在当前终端里和 Agent 对话，形态类似 `claude` 或 `codex`。

官方 `dsh` 自带 web（浏览器 GUI）和 headless（一次性任务）两种前端，中间缺了「进终端一直聊」这一档。这个插件补的就是这一档。

## 它做什么

```
$ dsh tui
dsh tui · newapi-messages/deepseek-v4.1-flash · /Users/you/project
输入 /help 看命令，Ctrl-D 退出。

› 看一下这个仓库用什么测试框架

⚙ bash ls
✓
⚙ read package.json
✓
它是 Vitest，`package.json` 里的 `scripts.test` 是 `vitest run`。
```

- 流式输出回答，思考过程默认以暗色一起流出（`--no-reasoning` 关掉）
- 工具调用压成一行摘要（工具名 + 第一手参数），结果用 ✓ / ✗ 收尾
- 会话落盘，可以用 `--session-id` 续上
- `Ctrl-C` 正在生成时中断本轮、回到输入态；空闲时退出

## 安装

```bash
git clone https://github.com/xingzoudefengye/dsh-tui.git
cd dsh-tui
node scripts/setup.mjs
```

`setup.mjs` 会做三件幂等的事：

1. `dsh plugin --profile tui add github:xingzoudefengye/dsh-tui` —— 建一个叫 `tui` 的 profile
2. 把该 profile 的 `dsh.profile.bundles` 设成 `["@deepseek-ai/dsh-base", "dsh-tui"]`
3. 从 `web` profile 的补丁层里抄出 `agent-default-model` / `llm-deepseek` / `llm-pi-ai` 三条，写进 `tui` 的补丁层

第 3 步是故意的：provider 路由（自建 newapi 的 baseURL、apiKeyEnv、重试策略）你已经在上 web 那边维护了一份，没必要在两个 profile 里各写一遍还写歪。想换来源 profile：

```bash
node scripts/setup.mjs --source headless
```

装本地目录（改代码时不必每次推 GitHub）：

```bash
node scripts/setup.mjs /Users/you/Projects/dsh-tui
```

## 用法

```bash
dsh tui                                 # 新开一段对话
dsh tui --model muse-spark-1.3-contributor   # 换同一个 provider 下的另一个模型
dsh tui --no-reasoning                  # 不显示思考流
dsh tui --session-id session-…          # 继续之前的会话
```

会话内命令：

| 命令 | 作用 |
|---|---|
| `/help` | 显示帮助 |
| `/new` | 开一段新会话（旧会话仍在磁盘上） |
| `/exit`、`/quit` | 退出 |

## 实现要点

两个 Cordis 插件，照官方 headless bundle 的骨架写：

| 文件 | 角色 |
|---|---|
| `lib/startup.js` | 用 commander 解析本 app 的命令行，publish `tuiStartup` 服务 |
| `lib/index.js` | 注入 `agentDefaultModel` / `agents` / `sessions`，建 Agent 后进 REPL |
| `cordis.patch.yml` | bundle 补丁：insert 上面两行、关掉 `hmr` / `authorization` / `deepseek-account` |

驱动 Agent 的调用链和官方 headless runner 完全一致，没有自造：

```js
agents.create({ sessionId, meta: { cwd }, agentOptions, setup });   // 或 agents.resume
agent.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }));
await agent.whenIdle();                    // 配合 subagents.waitForChildren 等彻底静止
ctx.on("agent/assistant-stream", …);       // 流式增量
ctx.on("session/event", …);                // tool/call、tool/result
sessions.flush(agent.session);
```

进程生命期交给启动器：`dsh` 明确只解析自己的参数，挂载完成后把进程生命期让给插件，所以 readline 一挂着，进程就不退出；`/exit` 时调 `ctx.appExit(0)` 走正常关停。

**与 headless 的关键差别**：headless 把 `credentials` 插件关掉了，改用启动时的环境变量，所以跑之前得 `export NEWAPI_API_KEY`。TUI 是交互式的，**保留** `credentials`，直接读 `$DSH_HOME/.credentials.yaml`，不用 export 任何东西。

## 已知限制

- **没有审批 UI。** bundle 补丁里 `authorization` 是关掉的，也就是说工具调用不会停下来问你。这是 MVP 的取舍：做个 TUI 审批弹窗是下一步，不是这一版。
- **回答按原样输出，不渲染 Markdown。** 代码块没有语法高亮，表格是纯文本。
- **生成期间不能插话。** 想追加指令只能等这一轮结束；`agent.steer()` 的接口留着，但还没接。
- **`--model` 只在当前 provider 内换。** 跨 provider 换模型要走 profile 的默认模型设置。

## 关机不误事

`$DSH_HOME/profiles/tui/` 下就是普通 profile：`package.json` 里的 bundles 决定它挂什么，`cordis.patch.yml` 是它自己的补丁层。不想要了直接删目录即可，不污染 web profile。

嫌麻烦也可以只加一条 patch 叠在 web 上（`dsh web --patch …` 那种形态），但这个 bundle 的前提是「不挂 Host / HTTP / 浏览器」，所以独立 profile 更干净。

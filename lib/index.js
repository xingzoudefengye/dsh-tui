/**
 * @dsh-tui — 交互式终端前端。
 *
 * 职责只有一个：把「读一行 → 跑一轮 Agent → 流式打印」做成一个循环。
 * 驱动方式照抄官方 headless runner（agents.create / agent.followup /
 * agent.whenIdle），所以这里不碰 agent loop 内部，只做 I/O 和渲染。
 *
 * @module dsh-tui
 */
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import z from "@deepseek-ai/schemastery";
import { brandString } from "@deepseek-ai/dsh-brand";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

/** Stable Cordis plugin name. */
const name = "dsh-tui";

/** Core services required before the REPL can start. */
const inject = ["agentDefaultModel", "agents", "sessions"];

const Config = z.object({
	sessionId: z.string(),
	model: z.string(),
	reasoning: z.boolean()
});

//#region 渲染
const COLOR = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const style = (code) => (text) => COLOR ? `\u001B[${code}m${text}\u001B[0m` : String(text);
const dim = style("2");
const bold = style("1");
const cyan = style("36");
const green = style("32");
const red = style("31");
const yellow = style("33");

const PROMPT = () => `${cyan("›")} `;

/** 把任意文本压成一行预览。 */
function oneLine(text, max = 80) {
	const flat = String(text).replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 从工具的 JSON 参数里挑一个最有信息量的字段做预览。 */
function argumentPreview(name, rawArguments) {
	let parsed;
	try {
		parsed = JSON.parse(rawArguments);
	} catch {
		return oneLine(rawArguments);
	}
	if (parsed === null || typeof parsed !== "object") return oneLine(String(parsed));
	for (const key of ["command", "file_path", "path", "pattern", "query", "url", "description", "task", "prompt"]) {
		const value = parsed[key];
		if (typeof value === "string" && value.trim() !== "") return oneLine(value);
	}
	return oneLine(rawArguments);
}
//#endregion

//#region 会话
/**
 * 把默认模型选择套到新 Agent 上，与 headless runner 的 setup 一致。
 * @param selection - profile 的默认 provider/model。
 * @returns setup 回调。
 */
function installSelection(selection) {
	return (agentCtx) => {
		installModelSelection(agentCtx, { current: selection, assembled: void 0 });
	};
}

/**
 * 解析本次运行的 provider/model，并按需复用已有 Session。
 * @param ctx - 插件上下文。
 * @param config - 启动参数。
 * @returns 目标 Agent 与它的模型标签。
 */
async function resolveAgent(ctx, config) {
	const agents = ctx.get("agents");
	const defaultModel = ctx.get("agentDefaultModel");
	const selection = defaultModel.currentSelection();
	const provider = selection.provider;
	const model = config.model ?? selection.model;
	const agentOptions = { provider, model };
	const setup = installSelection({ provider, model });

	if (config.sessionId !== void 0) {
		const { agent } = await agents.resume({
			resumeSessionId: config.sessionId,
			agentOptions,
			setup
		});
		await agent.whenIdle();
		return { agent, label: `${provider}/${model}` };
	}

	const fs = ctx.get("fs");
	const cwd = fs === void 0 ? process.cwd() : fs.processPath(await fs.resolve("."));
	const sessionId = brandString(`session-${randomUUID()}`);
	const { agent } = await agents.create({
		sessionId,
		meta: { cwd },
		agentOptions,
		setup
	});
	await agent.whenIdle();
	return { agent, label: `${provider}/${model}` };
}
//#endregion

//#region 一轮
/**
 * 流式渲染一次 assistant 回合，并把工具调用压成一行摘要。
 * @param ctx - 插件上下文（事件源）。
 * @param agent - 本轮所属 Agent。
 * @param options - 是否显示思考过程。
 * @returns 停止函数。
 */
function renderStream(ctx, agent, options) {
	let openLine = false;
	const ensureNewline = () => {
		if (openLine) {
			process.stdout.write("\n");
			openLine = false;
		}
	};
	const stopStream = ctx.on("agent/assistant-stream", ({ agent: subject, frame }) => {
		if (subject !== agent) return;
		if (frame.type === "start" || frame.type === "end") {
			ensureNewline();
			return;
		}
		const chunk = frame.chunk;
		switch (chunk.type) {
			case "text-delta":
				if (chunk.text === "") return;
				process.stdout.write(chunk.text);
				openLine = !chunk.text.endsWith("\n");
				return;
			case "reasoning-delta":
				if (!options.reasoning || chunk.text === "") return;
				process.stdout.write(dim(chunk.text));
				openLine = !chunk.text.endsWith("\n");
				return;
			case "tool-call-delta":
			case "usage":
			case "finish":
			case "block-start":
			case "block-end":
				return;
			default:
				return;
		}
	});
	const stopEvents = ctx.on("session/event", (session, event) => {
		if (session !== agent.session) return;
		if (event.type === "tool/call") {
			ensureNewline();
			const summary = `${dim("⚙")} ${yellow(event.data.name)} ${dim(argumentPreview(event.data.name, event.data.arguments))}`;
			process.stdout.write(`${summary}\n`);
			return;
		}
		if (event.type === "tool/result") {
			ensureNewline();
			const failed = event.data.error !== void 0;
			process.stdout.write(`${failed ? red("✗") : green("✓")}\n`);
		}
	});
	return () => {
		ensureNewline();
		stopStream();
		stopEvents();
	};
}

/**
 * 跑一轮用户输入，等到彻底静止（含子智能体）再返回。
 * @param ctx - 插件上下文。
 * @param agent - 目标 Agent。
 * @param text - 用户输入。
 * @param options - 渲染选项。
 */
async function runTurn(ctx, agent, text, options) {
	const stop = renderStream(ctx, agent, options);
	try {
		agent.followup(createUserMessage({
			content: [{ type: "text", text }],
			source: { kind: "user" }
		}));
		const subagents = ctx.get("subagents");
		for (;;) {
			await agent.whenIdle();
			const idleSeq = agent.session.seq;
			const childrenActive = (await subagents?.waitForChildren(agent)) === true;
			if (!childrenActive && agent.status === "idle" && agent.session.seq === idleSeq) break;
		}
	} finally {
		stop();
		const sessions = ctx.get("sessions");
		await sessions?.flush(agent.session);
	}
}
//#endregion

//#region REPL
const HELP = `命令：
  /help            显示这份帮助
  /new             开一段新会话（旧会话仍保留在磁盘上）
  /exit, /quit     退出
  Ctrl-C           正在生成：中断本轮；空闲：退出
  Ctrl-D           退出`;

/**
 * 交互循环。
 * @param ctx - 插件上下文。
 * @param exit - 启动器提供的退出请求。
 * @param config - 启动参数。
 */
async function repl(ctx, exit, config) {
	// 先等整棵插件树挂载完：agent-loop 是在后面的行里注册工厂的，
	// 早一步调 agents.create 会得到 "no agent factory registered"。
	await ctx.get("loader")?.await();
	let { agent, label } = await resolveAgent(ctx, config);
	const options = { reasoning: config.reasoning !== false };

	process.stdout.write(`${bold("dsh tui")} ${dim(`· ${label} · ${process.cwd()}`)}\n`);
	process.stdout.write(dim(`输入 /help 看命令，Ctrl-D 退出。\n\n`));

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: process.stdin.isTTY === true,
		historySize: 500
	});

	// 用一个显式的行队列，而不是 rl.question：
	// 管道输入时多行会在一瞬间全部到达，question 的 one-shot 监听会把后面的行丢掉；
	// 而 stdin 的 EOF（close）也不该在回合进行中把进程退掉。
	const queue = [];
	let closed = false;
	let waiter;
	const notify = () => {
		if (waiter === void 0) return;
		const resume = waiter;
		waiter = void 0;
		resume();
	};
	rl.on("line", (line) => {
		queue.push(line);
		notify();
	});
	rl.on("close", () => {
		closed = true;
		notify();
	});

	/** 取下一行；stdin 结束且队列空时返回 null。 */
	const nextLine = () => new Promise((resolve) => {
		const attempt = () => {
			if (queue.length > 0) {
				waiter = void 0;
				resolve(queue.shift());
				return;
			}
			if (closed) {
				waiter = void 0;
				resolve(null);
				return;
			}
			waiter = attempt;
		};
		attempt();
	});

	let busy = false;
	let closing = false;
	const finish = (code) => {
		if (closing) return;
		closing = true;
		try {
			rl.close();
		} catch {
			/* 已经关了 */
		}
		exit(code);
	};

	rl.on("SIGINT", () => {
		if (busy) {
			// 正在生成：中断本轮，回到输入态，不退出进程
			process.stdout.write(`\n${dim("已中断本轮。")}\n`);
			agent.cancel({ kind: "user" });
			return;
		}
		finish(0);
	});

	const interactive = process.stdin.isTTY === true;
	rl.setPrompt(PROMPT());

	for (;;) {
		if (interactive && !closing) rl.prompt();
		const line = await nextLine();
		if (line === null) break;
		if (closing) break;
		const input = line.trim();
		if (input === "") continue;

		if (input.startsWith("/")) {
			const command = input.split(/\s+/)[0];
			if (command === "/exit" || command === "/quit") break;
			if (command === "/help") {
				process.stdout.write(`${HELP}\n\n`);
				continue;
			}
			if (command === "/new") {
				({ agent, label } = await resolveAgent(ctx, { ...config, sessionId: void 0 }));
				process.stdout.write(`${dim(`已开启新会话 · ${label} · ${agent.session.header.sessionId}`)}\n\n`);
				continue;
			}
			process.stdout.write(`${red(`未知命令 ${command}`)}${dim("，输入 /help 查看可用命令。")}\n\n`);
			continue;
		}

		busy = true;
		try {
			await runTurn(ctx, agent, input, options);
			process.stdout.write("\n");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`\n${red(`出错了：${message}`)}\n\n`);
		} finally {
			busy = false;
		}
	}

	finish(0);
}
//#endregion

/**
 * 挂载交互式前端。
 * @param ctx - 插件上下文。
 * @param config - 已校验的启动参数。
 */
function apply(ctx, config) {
	const exit = ctx.get("appExit");
	if (exit === void 0) throw new Error("dsh-tui: the launcher must provide ctx.appExit before the tree mounts");
	repl(ctx, exit, config).catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`dsh: ${message}\n`);
		exit(1);
	});
}

export { Config, apply, inject, name };

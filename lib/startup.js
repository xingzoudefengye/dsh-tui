/**
 * `dsh tui` 的命令行：解析 --session-id / --model / --no-reasoning，把结果
 * publish 成 tuiStartup 服务，供 runner 以 lazy config 消费。
 *
 * @module dsh-tui/startup
 */
import { Command } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";

/** Stable Cordis plugin name. */
const name = "tui-startup";

/** 解析前先等命令行就绪。 */
const inject = ["cmdlineArgs"];

/** 本插件提供给 runner 的服务名。 */
const TUI_STARTUP_SERVICE = "tuiStartup";

/** 本 app 的命令定义。 */
function tuiCommand() {
	return new Command().name("dsh tui").description("Chat with a DSH Session in this terminal; Ctrl-D or /exit leaves.").helpOption("-h, --help", "show this help").option("--session-id <id>", "adopt the persisted Session with this id instead of starting a new one").option("--model <model>", "override the profile's default model for this run (same provider)").option("--no-reasoning", "hide streamed reasoning").addHelpText("after", `
Examples:
  dsh tui                                   start a new conversation
  dsh tui --model deepseek-v4.1-flash       start with another model on the same provider
  dsh tui --session-id session-…            continue an earlier conversation
  dsh tui --no-reasoning                    hide the thinking stream
`);
}

/**
 * 解析命令行并发布启动参数。
 * @param ctx - 携带命令行与退出请求的插件上下文。
 */
function apply(ctx) {
	const program = tuiCommand();
	program.action(() => {
		const options = program.opts();
		const sessionId = options.sessionId;
		if (sessionId !== void 0 && sessionId.trim() === "") program.error("error: --session-id requires a non-empty session id");
		const model = options.model;
		if (model !== void 0 && model.trim() === "") program.error("error: --model requires a non-empty model id");
		ctx.provide(TUI_STARTUP_SERVICE, {
			sessionId,
			model,
			reasoning: options.reasoning !== false
		});
	});
	parseCmdline(ctx, program);
}

export { TUI_STARTUP_SERVICE, apply, inject, name };

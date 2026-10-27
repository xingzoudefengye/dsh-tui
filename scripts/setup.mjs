#!/usr/bin/env node
/**
 * 把 dsh-tui 装成一个可用的 `dsh tui` profile。
 *
 * 做四件事，每件都幂等：
 *   1. `dsh plugin --profile tui add <spec>`：建 profile 并安装本包（spec 默认取 GitHub）
 *   2. 把 profile 的 dsh.profile.bundles 设成 [dsh-base, dsh-tui]
 *   3. 从 `web` profile 的补丁层里抄出 provider / 默认模型那几行，写进 tui 的补丁层
 *      （两台机器上 provider 配置都在 web 里维护，抄一次就够，之后各自改各自的）
 *   4. 打印怎么用
 *
 * 用法：
 *   node scripts/setup.mjs                       # 从 GitHub 装
 *   node scripts/setup.mjs /path/to/dsh-tui      # 装本地目录（开发时用）
 *   node scripts/setup.mjs --source web          # 从哪个 profile 抄 provider 配置
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_SPEC = "github:xingzoudefengye/dsh-tui";
const PROFILE = "tui";
const PROVIDER_IDS = new Set(["agent-default-model", "llm-deepseek", "llm-pi-ai"]);
const MARKER = "# 由 scripts/setup.mjs 生成";

const argv = process.argv.slice(2);
let spec = DEFAULT_SPEC;
let source = "web";
for (let index = 0; index < argv.length; index += 1) {
	const argument = argv[index];
	if (argument === "--source") source = argv[++index];
	else if (!argument.startsWith("-")) spec = argument;
}

const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const profiles = join(home, "profiles");
const profileDir = join(profiles, PROFILE);

/** cmd.exe 的引号规则：只有含空白或特殊字符的参数才需要包一层双引号。 */
function quoteForCmd(argument) {
	if (!/[\s"^&|<>()]/.test(argument)) return argument;
	return `"${argument.replace(/"/g, '""')}"`;
}

/**
 * 跑一条外部命令，返回退出码。
 *
 * Windows 上 `dsh` 是 npm 生成的 `dsh.cmd` 垫片，spawnSync 不能直接执行它
 * （失败时 status 为 null，看起来就像「命令跑过但失败了」），所以经 cmd.exe 转一手。
 * spawn 本身失败时把原因打出来，否则用户只看到一句「没装上」，无从下手。
 */
function run(command, args) {
	const result = process.platform === "win32"
		? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", [command, ...args].map(quoteForCmd).join(" ")], { stdio: "inherit" })
		: spawnSync(command, args, { stdio: "inherit" });
	if (result.error !== void 0) {
		process.stderr.write(`\n⚠ 启动 ${command} 失败：${result.error.message}\n`);
		return 1;
	}
	return result.status ?? 1;
}

/**
 * 把 `github:owner/repo` 换成 GitHub 的归档 tarball 地址。
 *
 * 为什么要这条兜底：pnpm 解析 git 依赖时会先 `git ls-remote`，这一步在本机偶发
 * 返回 "Repository not found"（仓库明明是公开的，同样的命令在 shell 里手动跑又正常），
 * 一旦撞上，`dsh plugin add github:...` 直接失败。换成归档 tarball 就不经过 git，
 * 只要 HTTP 能下就行。
 */
function archiveUrl(spec, branch = "main") {
	const slug = spec.startsWith("github:") ? spec.slice("github:".length) : spec;
	return `https://github.com/${slug}/archive/refs/heads/${branch}.tar.gz`;
}

/** 装插件：先按给定规格装，git 规格失败时退到归档 tarball。 */
function addPlugin(spec) {
	const attempts = [spec];
	if (spec.startsWith("github:")) attempts.push(archiveUrl(spec));
	for (const [index, attempt] of attempts.entries()) {
		if (index > 0) process.stdout.write(`\n↻ git 规格安装失败，改用归档 tarball：${attempt}\n`);
		if (run("dsh", ["plugin", "--profile", PROFILE, "add", attempt]) === 0) return;
	}
	process.stderr.write(`\n✗ 两种方式都没装上（${attempts.join(" / ")}）\n`);
	process.exit(1);
}

/**
 * 按顶层 `- ` 切开 YAML 列表，返回 [{ id, lines }]。
 * 只处理这个仓库需要的形状（顶层列表项、`- id: xxx` 开头），不追求通用 YAML。
 */
function splitEntries(text) {
	const entries = [];
	let pending = [];
	let current;
	for (const line of text.split("\n")) {
		if (line.startsWith("- ")) {
			if (current !== void 0) entries.push(current);
			current = { id: void 0, lines: [...pending, line] };
			pending = [];
			const matched = /^-\s+id:\s*(\S+)/.exec(line);
			if (matched !== null) current.id = matched[1].replace(/["']/g, "");
			continue;
		}
		if (current === void 0) {
			if (line.trim() !== "") pending.push(line);
			continue;
		}
		// 顶格注释更像是「下一个条目」的说明，先攒着
		if (line.startsWith("#")) {
			pending.push(line);
			continue;
		}
		if (pending.length > 0) {
			current.lines.push(...pending);
			pending = [];
		}
		current.lines.push(line);
	}
	if (current !== void 0) entries.push(current);
	return entries;
}

// 1. 建 profile 并装包
mkdirSync(profileDir, { recursive: true });
addPlugin(spec);

// 2. 挂 bundle
const manifestPath = join(profileDir, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
manifest.dsh.profile.bundles = ["@deepseek-ai/dsh-base", "dsh-tui"];
manifest.dsh.profile.patchReload = "startup";
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`\n✓ ${manifestPath} 的 bundles 已设为 dsh-base + dsh-tui\n`);

// 3. 抄 provider 配置
const sourcePatch = join(profiles, source, "cordis.patch.yml");
if (!existsSync(sourcePatch)) {
	process.stderr.write(`\n⚠ 找不到 ${sourcePatch}，跳过 provider 配置。\n` +
		`  tui profile 会退回官方 deepseek 路由，需要你自己补 provider 或设置 DEEPSEEK_API_KEY。\n`);
} else {
	const entries = splitEntries(readFileSync(sourcePatch, "utf8")).filter((entry) => entry.id !== void 0 && PROVIDER_IDS.has(entry.id));
	const targetPatch = join(profileDir, "cordis.patch.yml");
	const body = entries.map((entry) => entry.lines.join("\n").replace(/\s+$/u, "")).join("\n");
	const header = [
		MARKER,
		`# 来源：profiles/${source}/cordis.patch.yml 的 ${entries.map((entry) => entry.id).join(" / ")}`,
		"# 这几条是 provider 路由和默认模型，两台机器各维护各的；重跑 setup.mjs 会覆盖本文件。",
		"",
		""
	].join("\n");
	const previous = existsSync(targetPatch) ? readFileSync(targetPatch, "utf8") : "";
	const generated = previous === "" || previous.trim() === "[]" || previous.includes(MARKER);
	if (!generated) {
		const backup = `${targetPatch}.bak-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
		copyFileSync(targetPatch, backup);
		process.stdout.write(`⚠ 已有的补丁层不是生成内容，已备份到 ${backup}\n`);
	}
	writeFileSync(targetPatch, `${header}${body}\n`);
	process.stdout.write(`✓ ${targetPatch} 已写入 ${entries.length} 条：${entries.map((entry) => entry.id).join(", ")}\n`);
}

process.stdout.write(`
装好了。用法：

  dsh tui                       新开一段对话
  dsh tui --no-reasoning        不显示思考过程
  dsh tui --session-id <id>     继续之前的会话

在会话里：/help 看命令，/new 开新会话，/exit 或 Ctrl-D 退出。
`);

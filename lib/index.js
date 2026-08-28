/**
 * dsh-temp-session —— 主机半区。
 *
 * 职责：
 *   1. 内核客户端补丁（幂等）：dsh-client-ui-conversation 的 ConversationRoot 在
 *      `workspaces.phase === "ready"` 时会把无工作区会话的 chipTitle 置空，导致
 *      组合输入框进入 inert（workspaceTrigger）—— 即"必须选工作区"的实现点。
 *      本插件启动时对该客户端 bundle 做一行最小替换（与桌面项目对待内核文件的
 *      方式一致：启动时修补安装的内核文件，保留备份、打标记、幂等），使无工作区
 *      会话获得 cwd 标签 → chipTitle 非空 → 输入框可输入、可发送。
 *      若新内核版本改变了目标代码，则跳过并高调记录（更新插件版本即可）。
 *   2. HTTP 路由 `POST /api/dsh-temp-session/reserve`：
 *      为一次新的临时会话预留独立目录 <tempRoot>/session-<uuid> 并原样返回，
 *      客户端随后以 session.create({ cwd }) 创建会话（服务端 ensureSession 会
 *      递归创建目录并写入 header.cwd）。
 *   3. 启动清理：注销因 workspace 注册表 bootstrap 而物化出来的临时目录
 *      Workspace 记录（保持"不选工作区"的会话始终 Ungrouped）；删除既不在
 *      存活 Agent 也不在持久化列表中的、超过 7 天的临时目录。
 *   4. 系统提示注入：处于临时目录中的会话，向模型说明其工作目录的临时语义
 *      （软性约束，与 dsh 沙盒"读取不设限"的设计一致）。
 *
 * 注：本插件零依赖 `@deepseek-ai/*` 包（写文件只使用 node: 内建模块），
 * 仅依赖 cordis 注入的宿主服务。
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

export const inject = ["webServer", "workspaceRegistry", "systemPrompt", "agents"];

/** 本插件 HTTP 路由前缀（与浏览器半区保持一致）。 */
const API_PREFIX = "/api/dsh-temp-session";
/** 未归属会话的临时目录保留时长：7 天后被清理。 */
const STALE_TEMP_MS = 7 * 24 * 60 * 60 * 1000;

/** 内核客户端补丁：让"工作区就绪"的无工作区会话也能有 chipTitle（输入框可用）。 */
const CONVERSATION_PATCH = {
	package: "@deepseek-ai/dsh-client-ui-conversation",
	from: '(workspaces.phase === "ready" || cwd === void 0 || cwd === "" ? void 0 : workspaceLabel(cwd))',
	to: '(/*** dsh-temp-session ***/ cwd === void 0 || cwd === "" ? void 0 : workspaceLabel(cwd))',
	mark: "/*** dsh-temp-session ***/"
};

/** 解析 DSH_HOME：$DSH_HOME 优先，否则 ~/.dsh。 */
function resolveDshHome() {
	const fromEnv = process.env.DSH_HOME;
	if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
	return join(homedir(), ".dsh");
}

/**
 * 定位被服务的 dsh-client-ui-conversation 客户端 bundle：
 *   1) 从当前 dsh 进程入口（argv[1] = …/dsh/lib/bin.js 或包装脚本）做 Node 解析；
 *   2) $DSH_HOME/profiles/node_modules 的 flat fallback 位置；
 *   3) argv[1] 的兄弟候选（@deepseek-ai/dsh-client-ui-conversation 与 dsh 同级）。
 * @param {string} bundleRel - 包内 bundle 相对路径。
 * @returns {string|undefined} 存在且可读的 bundle 路径。
 */
export function resolveConversationBundle(bundleRel = "lib/client.js") {
	const { package: pkgName } = CONVERSATION_PATCH;
	const candidates = [];
	const argv1 = process.argv[1];
	if (typeof argv1 === "string" && argv1 !== "") {
		try {
			const anchor = join(dirname(argv1), "__dsh_temp_session_anchor__.js");
			const req = createRequire(pathToFileURL(anchor));
			candidates.push(req.resolve(`${pkgName}/package.json`));
		} catch {
			/* 继续尝试其他候选 */
		}
	}
	try {
		candidates.push(join(resolveDshHome(), "profiles", "node_modules", pkgName, "package.json"));
	} catch {
		/* 忽略 */
	}
	if (typeof argv1 === "string" && argv1 !== "") {
		candidates.push(join(dirname(argv1), "..", "dsh-client-ui-conversation", "package.json"));
	}
	for (const pkgJson of candidates) {
		const bundle = join(dirname(pkgJson), bundleRel);
		if (existsSync(bundle)) return bundle;
	}
	return undefined;
}

/**
 * 对 conversation 客户端 bundle 应用（或确认已应用）内核补丁。幂等；首次修补前
 * 备份原文件为 `<bundle>.dsh-temp-session.bak`；目标代码漂移时跳过并返回 false。
 * @param {object} [logger] - cordis logger（可选）。
 * @returns {boolean} 是否已处于修补态。
 */
export function patchConversationBundle(logger) {
	try {
		const bundle = resolveConversationBundle();
		if (bundle === undefined) {
			logger?.warn?.("dsh-temp-session: could not locate the conversation client bundle; composer gate stays upstream");
			return false;
		}
		let content = readFileSync(bundle, "utf8");
		if (content.includes(CONVERSATION_PATCH.mark)) return true;
		if (!content.includes(CONVERSATION_PATCH.from)) {
			logger?.warn?.("dsh-temp-session: conversation bundle drifted from the expected code — update the plugin (target text not found)");
			return false;
		}
		copyFileSync(bundle, `${bundle}.dsh-temp-session.bak`);
		writeFileSync(bundle, content.replace(CONVERSATION_PATCH.from, CONVERSATION_PATCH.to), "utf8");
		logger?.info?.("dsh-temp-session: conversation bundle patched (optional-workspace composer)");
		return true;
	} catch (error) {
		logger?.warn?.(`dsh-temp-session: conversation bundle patch failed: ${String(error)}`);
		return false;
	}
}

/** 仅本机回环地址允许调用（与 dsh-tauri-worktree 相同的安全口径）。 */
function isLoopback(req) {
	const address = req.socket?.remoteAddress ?? "";
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** 读一个 JSON 请求体（上限 64 KiB；失败按 null 处理，路由不依赖其内容）。 */
function readJsonBody(req, limit = 64 * 1024) {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
			if (body.length > limit) {
				reject(new Error("request body too large"));
				req.destroy();
			}
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(body || "{}"));
			} catch (error) {
				reject(error);
			}
		});
		req.on("error", reject);
	});
}

function sendJson(res, code, payload) {
	res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(payload));
}

/** 路径包含判断：容忍 Windows/类 Unix 分隔符混写。 */
function isUnderRoot(root, path) {
	if (typeof path !== "string" || path === "") return false;
	const normalizedRoot = root.replace(/[/\\]+$/, "");
	const normalizedPath = path.replace(/[/\\]+$/, "");
	if (normalizedPath === normalizedRoot) return true;
	return normalizedPath.startsWith(normalizedRoot + sep)
		|| normalizedPath.startsWith(normalizedRoot + "/")
		|| normalizedPath.startsWith(normalizedRoot + "\\");
}

/**
 * 插件入口。
 * @param {object} ctx - cordis 宿主上下文。
 * @param {{ tempRoot?: string }} [config] - 行配置（见 cordis.patch.yml）。
 */
export function apply(ctx, config = {}) {
	const tempRoot = typeof config?.tempRoot === "string" && config.tempRoot !== ""
		? config.tempRoot
		: join(resolveDshHome(), "tmp-sessions");

	// 0) 内核客户端补丁（启动时同步执行，幂等；保证"可选工作区"输入框可用）。
	patchConversationBundle(ctx.logger);

	// 1) HTTP 路由：预留一个临时会话目录。
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: `${API_PREFIX}/reserve`,
			handler: async (req, res) => {
				if (req.method === "OPTIONS") {
					sendJson(res, 204, {});
					return;
				}
				if (req.method !== "POST") {
					sendJson(res, 405, { ok: false, error: "POST required" });
					return;
				}
				if (!isLoopback(req)) {
					sendJson(res, 403, { ok: false, error: "loopback only" });
					return;
				}
				try {
					await readJsonBody(req);
					const sessionId = `session-${randomUUID()}`;
					const cwd = join(tempRoot, sessionId);
					await mkdir(cwd, { recursive: true });
					sendJson(res, 200, { ok: true, sessionId, cwd });
				} catch (error) {
					sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
				}
			}
		});
		return () => dispose();
	}, "dsh-temp-session: reserve route");

	// 2) 启动清理（尽力而为，不阻塞启动）。
	ctx.effect(() => {
		void cleanup(ctx, tempRoot);
	}, "dsh-temp-session: bootstrap cleanup");

	// 3) 系统提示：临时目录会话的语义说明。
	ctx.systemPrompt.section({
		name: "plugin:dsh-temp-session",
		order: 109,
		text: (context) => {
			const session = context?.scope?.session;
			const cwd = session?.header?.cwd;
			if (typeof cwd !== "string" || !isUnderRoot(tempRoot, cwd)) return "";
			return `This session was started WITHOUT selecting a workspace. It runs in an isolated temporary scratch directory: ${cwd}. `
				+ `Treat this directory as the session's own project root and keep all writes inside it. `
				+ `It is independent from every other session and from the DeepSeek Harness Desktop installation directory; `
				+ `do not modify files under the harness application directory. If the user wants to work on a real project, `
				+ `they can switch the session to a workspace through the workspace picker.`;
		}
	});
}

/** 启动清理：注销临时目录的 Workspace 记录，并删除过期且无主的临时目录。 */
async function cleanup(ctx, tempRoot) {
	try {
		await mkdir(tempRoot, { recursive: true });

		// workspace 注册表 bootstrap 会按 header.cwd 为任何目录物化 Workspace 记录；
		// 临时目录属于本插件，启动时注销这些记录（会话与日志保留，仅取消归属），
		// 使临时会话在侧边栏保持 Ungrouped。
		const registry = ctx.workspaceRegistry;
		if (registry !== undefined && typeof registry.list === "function") {
			for (const workspace of registry.list()) {
				if (isUnderRoot(tempRoot, workspace.path)) {
					void registry.delete(workspace.id);
				}
			}
		}

		// 清理：既非存活 Agent 也不在持久化列表、且超过 7 天的临时目录。
		const live = new Set();
		if (ctx.agents !== undefined && typeof ctx.agents.list === "function") {
			for (const agent of ctx.agents.list()) {
				const id = agent?.session?.id;
				if (id !== undefined) live.add(id);
			}
		}
		const persisted = new Set();
		const persistence = ctx.get?.("sessionPersistence");
		if (persistence !== undefined && typeof persistence.list === "function") {
			for (const header of await persistence.list()) persisted.add(header.id);
		}
		const entries = await readdir(tempRoot, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const id = entry.name;
			if (live.has(id) || persisted.has(id)) continue;
			const dir = join(tempRoot, id);
			const info = await stat(dir).catch(() => null);
			if (info === null) continue;
			if (Date.now() - info.mtimeMs > STALE_TEMP_MS) {
				await rm(dir, { recursive: true, force: true }).catch(() => {});
			}
		}
	} catch (error) {
		ctx.logger?.warn?.(`dsh-temp-session: cleanup failed: ${String(error)}`);
	}
}

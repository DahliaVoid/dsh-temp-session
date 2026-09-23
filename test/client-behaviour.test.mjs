/**
 * client-behaviour.test.mjs —— 客户端半区的行为回归。
 *
 * 重点锁住 0.1.4 新增的"桌面客户端屏蔽"三件事，以及既有的芯片文案/× 对账：
 *   I.   data-dsh-composer-cwd 被摘除且保持摘除（桌面侧边栏拦截器让位的前提）；
 *   II.  findChip 取"当前可见"的芯片（桌面芯片遮蔽官方 WorkspacePicker 时，
 *        插件必须装修那个看得见的，而不是 display:none 的官方节点）；
 *   III. sessions.create 兜底改道只认桌面插件的两种形状，绝不误伤
 *        workspaceId / sessionId 形状的调用。
 *
 * 运行：node --test test/
 */
import assert from "node:assert/strict";
import test from "node:test";
import { FakeMutationObserver, flushRaf, installDom, makeChip } from "./fake-dom.mjs";

let registered = null;
globalThis.window = { __ModuleLoader__: { load: (mod) => { registered = mod; } } };
await import("../lib/client.js");

const RESERVED = { sessionId: "session-reserved", cwd: "C:\\Users\\u\\.dsh\\tmp-sessions\\session-reserved" };

/** 造一个可供 apply() 使用的宿主上下文与快照（快照可变，测试里直接改）。 */
function makeHarness() {
	const state = {
		session: { ids: [], byId: {}, current: undefined, phase: "ready" },
		workspace: { items: [], phase: "ready" }
	};
	const originalCreates = [];
	const fetches = [];
	const opens = [];
	const sessions = {
		create: async (options) => {
			originalCreates.push(options);
			// 真实宿主在没给 sessionId 时自行分配；这里按传入的 sessionId 回显，
			// 以便断言"改道后的落地会话是本插件预留的那一个"。
			return options !== null && typeof options === "object" && typeof options.sessionId === "string"
				? options.sessionId
				: "session-original";
		},
		open: (id) => {
			opens.push(id);
		},
		list: { getSnapshot: () => state.session, subscribe: () => () => {} }
	};
	const workspaces = { list: { getSnapshot: () => state.workspace, subscribe: () => () => {} } };
	const workspaceNavigationCalls = [];
	const uiWorkspace = {
		startSession: (workspaceId) => {
			workspaceNavigationCalls.push(workspaceId);
		}
	};
	const ctx = {
		sessions,
		workspaces,
		get: (name) => (name === "uiWorkspace" ? uiWorkspace : undefined)
	};
	globalThis.fetch = async (url) => {
		fetches.push(url);
		return { ok: true, json: async () => ({ ok: true, ...RESERVED }) };
	};
	return { ctx, state, sessions, uiWorkspace, originalCreates, fetches, opens, workspaceNavigationCalls };
}

function applyPlugin(ctx) {
	const exports = registered.factory(() => {
		throw new Error("client half must not require other modules");
	});
	exports.apply(ctx);
	return exports;
}

test("桌面客户端：摘除能力位、装修可见芯片、改道未分组创建", async () => {
	const dom = installDom();
	const harness = makeHarness();
	// 桌面特征：内核补丁写在 <html> 上的能力位。
	dom.html.setAttribute("data-dsh-composer-cwd", "1");
	// 官方芯片被桌面 CSS 隐藏；桌面芯片遮蔽官方 WorkspacePicker 且可见。
	const official = makeChip({ visible: false });
	const desktop = makeChip({ visible: true, classes: ["dshp-hero-workspace"] });
	dom.body.add(official, desktop);
	// 有一个"最近工作区"以抑制 autoEnsure 的自动预建，避免干扰计数。
	harness.state.workspace.items = [{ workspaceId: "w0", sessionIds: ["s1"], createdAt: "2020-01-01T00:00:00Z" }];
	harness.state.session.byId = { s1: { updatedAt: 1 } };

	applyPlugin(harness.ctx);
	flushRaf();

	// I. 能力位被摘掉。
	assert.equal(dom.html.hasAttribute("data-dsh-composer-cwd"), false, "data-dsh-composer-cwd 必须被摘除");

	// II. 文案落在"看得见的那个"芯片上，官方隐藏芯片保持原样。
	assert.equal(desktop.children[1].textContent, "选择工作区（可选）");
	assert.equal(official.children[1].textContent, "", "隐藏的官方芯片不应被改写");
	assert.equal(desktop.hasAttribute("data-dsh-temp-session-swap"), false, "未选定工作区时不应出现 ×");

	// 能力位再次写入 → 保持摘除。
	dom.html.setAttribute("data-dsh-composer-cwd", "1");
	FakeMutationObserver.triggerAll();
	assert.equal(dom.html.hasAttribute("data-dsh-composer-cwd"), false, "能力位必须保持摘除");

	// III. 兜底改道：只认桌面插件的两种形状。
	harness.fetches.length = 0;
	harness.originalCreates.length = 0;
	assert.equal(await harness.sessions.create(), RESERVED.sessionId, "无参创建必须改走本插件的临时会话");
	assert.equal(harness.fetches.length, 1);
	assert.deepEqual(harness.originalCreates, [{ sessionId: RESERVED.sessionId, cwd: RESERVED.cwd }]);

	harness.fetches.length = 0;
	harness.originalCreates.length = 0;
	await harness.sessions.create({ cwd: "C:\\Users\\u\\.dsh\\ungrouped" });
	assert.equal(harness.fetches.length, 1, "桌面 { cwd: $DSH_HOME/ungrouped } 创建必须改道");

	harness.fetches.length = 0;
	harness.originalCreates.length = 0;
	await harness.sessions.create({ workspaceId: "w0" });
	assert.equal(harness.fetches.length, 0, "带 workspaceId 的创建必须原样放行");
	assert.deepEqual(harness.originalCreates, [{ workspaceId: "w0" }]);

	harness.fetches.length = 0;
	harness.originalCreates.length = 0;
	await harness.sessions.create({ sessionId: "session-x", cwd: "D:\\tmp\\session-x" });
	assert.equal(harness.fetches.length, 0, "带 sessionId 的预留创建必须原样放行");
	assert.deepEqual(harness.originalCreates, [{ sessionId: "session-x", cwd: "D:\\tmp\\session-x" }]);

	harness.fetches.length = 0;
	harness.originalCreates.length = 0;
	await harness.sessions.create({ cwd: "D:\\projects\\ungrouped-sub" });
	assert.equal(harness.fetches.length, 0, "末段不是 ungrouped 的 { cwd } 创建不属桌面形状");
	dom.clear();
});

test("桌面客户端：已选定工作区时，× 悬停组件装在可见芯片上", async () => {
	const dom = installDom();
	const harness = makeHarness();
	dom.html.setAttribute("data-dsh-composer-cwd", "1");
	const official = makeChip({ visible: false });
	const desktop = makeChip({ visible: true, classes: ["dshp-hero-workspace"] });
	dom.body.add(official, desktop);
	harness.state.session.current = "session-abc";
	harness.state.session.ids = ["session-abc"];
	harness.state.session.byId = { "session-abc": { blank: true, cwd: "D:\\proj" } };
	harness.state.workspace.items = [{
		workspaceId: "w1",
		title: "proj",
		sessionIds: ["session-abc"],
		createdAt: "2020-01-01T00:00:00Z"
	}];

	applyPlugin(harness.ctx);
	flushRaf();

	assert.equal(desktop.children[1].textContent, "proj", "已选定工作区时标签断言回工作区标题");
	assert.equal(desktop.hasAttribute("data-dsh-temp-session-swap"), true, "可见芯片上必须装上悬停 ×");
	assert.equal(desktop.children.length, 3, "箭头是原位替换，子元素数量不变");
	assert.equal(desktop.children[2].hasAttribute("data-dsh-temp-session-swap"), true);
	assert.equal(official.hasAttribute("data-dsh-temp-session-swap"), false, "隐藏芯片不应被改动");
	dom.clear();
});

test("侧边栏「新建会话」（uiWorkspace.startSession 无参）落到本插件的临时会话", async () => {
	const dom = installDom();
	const harness = makeHarness();
	// 纯净 dsh 也要成立：这条是 0.1.3 起的原有主路径。
	const official = makeChip({ visible: true });
	dom.body.add(official);
	harness.state.workspace.items = [{ workspaceId: "w0", sessionIds: ["s1"], createdAt: "2020-01-01T00:00:00Z" }];
	harness.state.session.byId = { s1: { updatedAt: 1 } };

	applyPlugin(harness.ctx);
	flushRaf();

	harness.uiWorkspace.startSession();
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.deepEqual(harness.fetches, ["/api/dsh-temp-session/reserve"], "无参新建会话必须走本插件的预留目录");
	assert.deepEqual(harness.opens, [RESERVED.sessionId], "预留出的会话必须被打开");
	assert.deepEqual(harness.workspaceNavigationCalls, [], "不得回落到上游「继承当前/最近工作区」");
	dom.clear();
});

test("纯净 dsh / 内置 Web 界面：桌面屏蔽逻辑完全空转", async () => {
	const dom = installDom();
	const harness = makeHarness();
	const official = makeChip({ visible: true });
	dom.body.add(official);
	harness.state.workspace.items = [{ workspaceId: "w0", sessionIds: ["s1"], createdAt: "2020-01-01T00:00:00Z" }];
	harness.state.session.byId = { s1: { updatedAt: 1 } };

	applyPlugin(harness.ctx);
	flushRaf();

	assert.equal(official.children[1].textContent, "选择工作区（可选）");
	assert.equal(official.hasAttribute("data-dsh-temp-session-swap"), false);

	harness.fetches.length = 0;
	harness.originalCreates.length = 0;
	await harness.sessions.create();
	assert.equal(harness.fetches.length, 0, "无桌面特征时不得改道 sessions.create");
	assert.deepEqual(harness.originalCreates, [undefined]);
	dom.clear();
});

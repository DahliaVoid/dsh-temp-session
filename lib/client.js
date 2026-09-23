/**
 * dsh-temp-session —— 浏览器半区。
 *
 * 由 dsh-client-modules 服务为 /plugins/dsh-temp-session/client.js，
 * 以 window.__ModuleLoader__.load({ id, factory }) 的包格式被浏览器侧模块表
 * 物化为一个普通 cordis 客户端插件。本文件无任何构建步骤，无第三方 import。
 *
 * 功能：
 *   1. Hero 空状态的工作区块（WorkspaceChip）：
 *      - 当前会话未挂接工作区（临时会话 / 尚无会话）→ 文案显示
 *        "选择工作区（可选）"，行为与原来一致（点击打开选择菜单）；不显示 ×。
 *      - 当前空白会话已挂接工作区 → 右侧出现小 ×；点击 × 取消工作区选择，
 *        回到"未选定"状态（切换为一个新的临时会话）。
 *   2. 临时会话：POST /api/dsh-temp-session/reserve 取得独立目录
 *      <tempRoot>/session-<uuid>，然后 session.create({ sessionId, cwd }) 创建。
 *   3. "新建会话"（侧边栏通用按钮 / hero 预设座）：无显式工作区时默认创建
 *      临时会话（跳过上游"连接最近工作区"的行为）；工作区行内的 + 仍走原路径。
 *   4. 兜底：当前无会话时自动预建一个空白临时会话，使组合输入框可用——
 *      启动期仅在无可自动连接的最近工作区时补位（保留上游"自动恢复最近
 *      会话"）；运行期（删除/归档当前会话后 current 归零）始终补位，因为
 *      上游一次性初始选择策略不会再行动，而不补位输入框会 inert。
 *   5. 屏蔽桌面客户端的「未分组」新建会话（0.1.4，见下方"桌面客户端屏蔽"）。
 *
 * 桌面客户端屏蔽（dsh-tauri / DeepSeek Harness Desktop ≥ 0.15.9，0.1.4 起）：
 *   桌面外壳的 dsh-tauri-ui 自带一套与"临时会话"同义的功能（「未分组」新建
 *   会话，会话 cwd 落在共享的 $DSH_HOME/ungrouped），并会顶掉本插件的效果：
 *     a. 内核客户端补丁把 `data-dsh-composer-cwd="1"` 写在 <html> 上，桌面
 *        插件据此把 `composer.workspace-less` 能力位置为 true；
 *     b. 侧边栏通用「新建会话」与「未分组」分组行的 + 被桌面插件用 document
 *        捕获期 click 监听拦下（preventDefault + stopImmediatePropagation），
 *        改去创建 cwd = $DSH_HOME/ungrouped 的会话 —— 本插件的
 *        uiWorkspace.startSession 拦截因此完全收不到事件；
 *     c. hero 的 conversation.hero.workspace 是 single 槽，桌面插件以
 *        priority -1 遮蔽官方 WorkspacePicker，另用 CSS 把官方芯片
 *        （aria-label「选择工作区」）置为 display:none，于是本插件对账命中的
 *        是那个看不见的官方芯片 —— 用户看不到「选择工作区（可选）」，也悬停
 *        不出 ×。
 *   本插件对该功能的屏蔽是"逐点断电 + 兜底改道"，绝不动桌面插件的其他功能：
 *     I.  能力位：启动时摘掉 `data-dsh-composer-cwd` 并用 MutationObserver
 *         保持摘除。桌面插件对能力位的判断是调用期实时求值，因此此后侧边栏
 *         两个捕获期拦截器都会主动让位，事件回到官方处理 → 本插件的
 *         uiWorkspace.startSession 拦截 → 本插件的临时会话；
 *     II. 芯片对账改为"取当前可见的那一个"（findChip），使遮蔽官方选择器的
 *         桌面芯片同样接受本插件的「选择工作区（可选）」文案与悬停 ×，
 *         而不是把一个 display:none 的节点改成没人看得见的样子；
 *     III.兜底：包装 sessions.create —— 凡"不带 workspaceId，且不带 cwd 或
 *         cwd 末段为 ungrouped"的创建（桌面插件的两条路径），一律改走本插件
 *         预留的临时目录。即使桌面插件的 UI 入口被点到，落地的也是本插件的
 *         临时会话，而不是共享目录。
 *   仅在桌面特征存在时生效（<html> 上有 data-dsh-composer-cwd 或 DOM 里
 *   有 .dshp-hero-workspace）；纯净 dsh / 内置 Web 界面下这些代码全部空转。
 *
 * 内核适配（dsh 0.1.2-rc.x，0.1.2 起）：
 *   - 工作区快照不再提供 0.1.1-rc.x 的 baselinesReady / recentWorkspaceId，
 *     autoEnsure 的就绪守卫改用 phase === "ready"，最近工作区按 ui-workspace
 *     同款算法由 items + 会话列表复算（见 recentWorkspaceIdOf）；
 *   - "新建会话"入口已从 workspaces.startSession 迁到 uiWorkspace.startSession
 *     （WorkspaceController 上已无该成员，旧补丁为 no-op），现同步拦截
 *     uiWorkspace.startSession 的无参调用（失败时 autoEnsure 兜底）；
 *   - reconcile 的"已选定工作区"分支同步把芯片标签断言回工作区标题，
 *     修复新建工作区/会话时序里标签残留"选择工作区（可选）"的问题。
 */

window.__ModuleLoader__.load({
	id: "dsh-temp-session",
	factory: (require) => {
		"use strict";
		const exports = {};

		const API_PREFIX = "/api/dsh-temp-session";
		const CHIP_ATTR = "data-dsh-temp-session-chip";
		const CLEAR_ATTR = "data-dsh-temp-session-clear";
		const SWAP_ATTR = "data-dsh-temp-session-swap";
		const CSS_ATTR = "data-dsh-temp-session-css";
		const CLEAR_ID = "dsh-temp-session-clear";
		/** 桌面客户端 dsh-tauri-ui 的 hero 芯片类名（它遮蔽官方 WorkspacePicker 后可见的那个）。 */
		const DESKTOP_CHIP_CLASS = "dshp-hero-workspace";
		/** 桌面内核补丁写在 <html> 上的能力位：dsh-tauri-ui 据此判断"未分组"功能可用。 */
		const COMPOSER_CWD_ATTR = "data-dsh-composer-cwd";
		/** 桌面客户端"未分组"会话的目录末段（$DSH_HOME/ungrouped）。 */
		const DESKTOP_UNGROUPED_DIR = "ungrouped";
		/** 芯片 → { original: 出厂 chevron 节点, swap: 我们的悬停组件 }。 */
		const swapped = new WeakMap();
		/**
		 * 桌面客户端特性闩锁：一旦见到任何桌面特征就保持为真。
		 * 芯片只在 hero 态存在，非 hero 态会离场；闩锁保证兜底改道不会跟着闪断。
		 */
		let desktopLatched = false;

		const STRINGS = {
			zh: {
				optional: "选择工作区（可选）",
				clearTitle: "取消工作区选择",
				clearAria: "取消工作区选择"
			},
			en: {
				optional: "Choose workspace (optional)",
				clearTitle: "Clear workspace selection",
				clearAria: "Clear workspace selection"
			}
		};

		/** 当前界面语言：locale 插件会同步 <html lang>，据此取用文案。 */
		function activeLocale() {
			const lang = String(document.documentElement.lang || navigator.language || "en").toLowerCase();
			return lang.indexOf("zh") === 0 ? "zh" : "en";
		}
		function texts() {
			return STRINGS[activeLocale()];
		}

		/** Hero 工作区芯片按钮的 aria-label（dsh 官方两种语言的固定文案）。 */
		function knownChipLabels() {
			return ["选择工作区", "Choose workspace"];
		}

		/**
		 * 判定 Hero 的工作区芯片按钮（WorkspaceChip）：
		 * 只接受 aria-label = dsh 官方"选择工作区/Choose workspace"（该文案由
		 * WorkspaceChip 恒定输出，与是否已选工作区无关）。绝不做结构回退——
		 * 组合器的模型选择器按钮同样是 [图标, span 标签, 折叠箭头] 三子元素，
		 * 结构回退会误命中它（曾导致模型选择器下方多出一个 × 的 bug）。
		 * 命中后在按钮上加 CHIP_ATTR，后续直接命中。
		 *
		 * 0.1.4 起同时命中桌面客户端的芯片（.dshp-hero-workspace）：它的
		 * aria-label 与官方一致，且在 hero 的单槽里遮蔽官方 WorkspacePicker，
		 * 官方那个芯片又被桌面 CSS 置为 display:none。因此这里**优先取可见的
		 * 那一个**——否则本插件会把文案与 × 装到一个没人看得见的节点上
		 * （这正是"桌面版下插件失效"的直接原因）。
		 */
		function findChip() {
			const marked = document.querySelector("[" + CHIP_ATTR + "]");
			if (marked !== null && isChipByLabel(marked) && isVisible(marked)) return marked;
			const buttons = document.querySelectorAll("button[aria-haspopup='menu']");
			let firstMatch = null;
			let visibleMatch = null;
			for (let i = 0; i < buttons.length; i += 1) {
				const el = buttons[i];
				if (!isChipByLabel(el)) continue;
				if (firstMatch === null) firstMatch = el;
				if (isVisible(el)) {
					visibleMatch = el;
					break;
				}
			}
			const chosen = visibleMatch !== null ? visibleMatch : firstMatch;
			// 目标切换（例如桌面芯片顶替官方芯片）时，把旧目标恢复原样并撤标记，
			// 免得留下一个改了文案/换了箭头的隐藏节点。
			if (marked !== null && marked !== chosen) {
				restoreChevronSwap(marked);
				marked.removeAttribute(CHIP_ATTR);
			}
			if (chosen !== null) chosen.setAttribute(CHIP_ATTR, "");
			return chosen;
		}

		/** 元素是否真的渲染出来（display:none / 未挂载 = 不可见）。 */
		function isVisible(el) {
			if (typeof el.getClientRects !== "function") return true;
			try {
				return el.getClientRects().length > 0;
			} catch (error) {
				return true;
			}
		}

		/** 桌面客户端（dsh-tauri-ui）的"未分组"功能是否在场：能力位或它的 hero 芯片（闩锁）。 */
		function desktopUngroupedActive() {
			if (desktopLatched) return true;
			try {
				if (document.documentElement.hasAttribute(COMPOSER_CWD_ATTR)
					|| document.querySelector("." + DESKTOP_CHIP_CLASS) !== null) {
					desktopLatched = true;
					return true;
				}
			} catch (error) {
				/* 判定失败按非桌面处理：宁可不动 sessions.create。 */
			}
			return false;
		}

		/**
		 * 桌面插件 dsh-tauri-ui 的两条"未分组"创建路径的形状判定：
		 *   - `sessions.create()`：宿主回落 process.cwd()（桌面外壳固定为核心
		 *     安装目录，0.15.9 的历史 bug 就出在这里）；
		 *   - `sessions.create({ cwd })`：cwd 由它的 /ungrouped 路由解析为
		 *     `$DSH_HOME/ungrouped`，且**不带 workspaceId**。
		 * 只认这两种形状，绝不动带 workspaceId（上游 connectWorkspace）或
		 * 带 sessionId/其他字段（本插件自己的预留创建、其他插件）的调用。
		 */
		function isDesktopUngroupedCreate(options) {
			if (options === undefined || options === null) return true;
			if (typeof options !== "object") return false;
			if (typeof options.workspaceId === "string" && options.workspaceId !== "") return false;
			const keys = Object.keys(options);
			if (keys.length !== 1 || keys[0] !== "cwd") return false;
			const cwd = options.cwd;
			if (typeof cwd !== "string" || cwd.trim() === "") return true;
			return lastPathSegment(cwd).toLowerCase() === DESKTOP_UNGROUPED_DIR;
		}

		/**
		 * dsh 0.1.2-rc.x 起，工作区快照不再暴露 `recentWorkspaceId`（早期
		 * 0.1.1-rc.x 的字段），"最近工作区"改由 UI 层用 items + 会话列表实时
		 * 复算（recentWorkspace）。这里移植同一算法，供 autoEnsure 的
		 * "启动期让位给上游初始选择"守卫使用。
		 */
		function recentWorkspaceIdOf(workspaces, sessions) {
			let selected;
			let selectedTime = Number.NEGATIVE_INFINITY;
			for (let i = 0; i < workspaces.length; i += 1) {
				const workspace = workspaces[i];
				let latest = Number.NEGATIVE_INFINITY;
				const sessionIds = workspace.sessionIds || [];
				for (let j = 0; j < sessionIds.length; j += 1) {
					const session = sessions[sessionIds[j]];
					if (session !== undefined) latest = Math.max(latest, session.updatedAt);
				}
				if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt);
				if (selected === undefined || latest > selectedTime) {
					selected = workspace.workspaceId;
					selectedTime = latest;
				}
			}
			return selected;
		}

		function isChipByLabel(el) {
			const aria = el.getAttribute("aria-label") || "";
			return knownChipLabels().indexOf(aria) !== -1;
		}

		function removeClearButton() {
			const el = document.querySelector("[" + CLEAR_ATTR + "]");
			if (el !== null && el.parentElement !== null) el.parentElement.removeChild(el);
		}

		/**
		 * 注入一次性样式（每轮应用先清掉旧版本，避免残留旧规则）：
		 * 选中工作区时，悬停到大按钮上箭头→× 直接变换（透明度 + 旋转缩放过渡）。
		 */
		function ensureStyles() {
			const old = document.querySelectorAll("style[" + CSS_ATTR + "]");
			for (let i = 0; i < old.length; i += 1) {
				const parent = old[i].parentNode;
				if (parent !== null) parent.removeChild(old[i]);
			}
			const tag = document.createElement("style");
			tag.setAttribute(CSS_ATTR, "");
			tag.textContent =
				"[data-dsh-temp-session-chip][data-dsh-temp-session-swap] .ts-ts-drop,"
				+ "[data-dsh-temp-session-chip][data-dsh-temp-session-swap] .ts-ts-clear{"
				+ "position:absolute;left:0;right:0;top:0;bottom:0;margin:auto;display:block;"
				+ "transition:opacity .16s ease,transform .16s ease;}"
				+ "[data-dsh-temp-session-chip][data-dsh-temp-session-swap] .ts-ts-drop{opacity:1;transform:rotate(0deg) scale(1);}"
				+ "[data-dsh-temp-session-chip][data-dsh-temp-session-swap] .ts-ts-clear{opacity:0;transform:rotate(-90deg) scale(.5);}"
				+ "[data-dsh-temp-session-chip][data-dsh-temp-session-swap]:hover .ts-ts-drop{opacity:0;transform:rotate(90deg) scale(.5);}"
				+ "[data-dsh-temp-session-chip][data-dsh-temp-session-swap]:hover .ts-ts-clear{opacity:1;transform:rotate(0deg) scale(1);}";
			document.head.appendChild(tag);
		}

		/** 还原出厂 chevron（未选定工作区 / 芯片重建后调用；幂等）。 */
		function restoreChevronSwap(chip) {
			chip.removeAttribute(SWAP_ATTR);
			const state = swapped.get(chip);
			if (state === undefined) return;
			swapped.delete(chip);
			try {
				if (state.swap.parentElement === chip) chip.replaceChild(state.original, state.swap);
			} catch (error) {
				/* 芯片已被 React 整体替换：忽略，新的芯片会对账时重装。 */
			}
		}

		/**
		 * 把芯片的下拉箭头原位替换为"悬停显示 ×"的组件（选中工作区时）。
		 * 结构 [图标, span 标签, 箭头] 不符时退回"按钮右侧 ×"的旧式方案。
		 */
		function installChevronSwap(chip, onClear) {
			if (chip.children.length !== 3 || chip.children[1].tagName !== "SPAN") {
				ensureClearButton(chip, onClear);
				return;
			}
			const chevron = chip.children[2];
			if (chevron.getAttribute && chevron.getAttribute(SWAP_ATTR) !== null) return;
			if (swapped.has(chip)) return;
			const t = texts();
			const swap = document.createElement("span");
			swap.setAttribute(SWAP_ATTR, "");
			swap.setAttribute("role", "button");
			swap.setAttribute("aria-label", t.clearAria);
			swap.title = t.clearTitle;
			swap.style.cssText = "position:relative;display:inline-flex;align-items:center;justify-content:center;"
				+ "width:16px;height:16px;flex:none;cursor:pointer;"
				+ "color:var(--dsw-alias-label-secondary,#8b8b8b);";
			swap.innerHTML = "<svg class=\"ts-ts-drop\" width=\"12\" height=\"12\" viewBox=\"0 0 12 12\" fill=\"none\" aria-hidden=\"true\">"
				+ "<path d=\"M3.2 4.8L6 7.6l2.8-2.8\" stroke=\"currentColor\" stroke-width=\"1.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>"
				+ "<svg class=\"ts-ts-clear\" width=\"12\" height=\"12\" viewBox=\"0 0 12 12\" fill=\"none\" aria-hidden=\"true\">"
				+ "<path d=\"M3.4 3.4l5.2 5.2M8.6 3.4l-5.2 5.2\" stroke=\"currentColor\" stroke-width=\"1.3\" stroke-linecap=\"round\"/></svg>";
			swap.addEventListener("pointerdown", (e) => {
				e.stopPropagation();
				e.preventDefault();
			});
			swap.addEventListener("click", (e) => {
				e.stopPropagation();
				e.preventDefault();
				void onClear();
			});
			swapped.set(chip, { original: chevron, swap });
			chip.setAttribute(SWAP_ATTR, "");
			chip.replaceChild(swap, chevron);
			removeClearButton();
		}

		/** 回退方案（芯片结构异常时）：按钮右侧的独立 ×。 */
		function ensureClearButton(chip, onClear) {
			const row = chip.parentElement;
			if (row === null) return;
			let existing = null;
			for (let i = 0; i < row.children.length; i += 1) {
				if (row.children[i].getAttribute && row.children[i].getAttribute(CLEAR_ATTR) !== null) {
					existing = row.children[i];
					break;
				}
			}
			if (existing !== null) return;
			const t = texts();
			const btn = document.createElement("button");
			btn.setAttribute("type", "button");
			btn.setAttribute(CLEAR_ATTR, "");
			btn.setAttribute("data-testid", CLEAR_ID);
			btn.setAttribute("aria-label", t.clearAria);
			btn.title = t.clearTitle;
			btn.style.cssText = "display:inline-flex;align-items:center;justify-content:center;"
				+ "width:22px;height:22px;padding:0;border:none;border-radius:50%;"
				+ "background:transparent;color:var(--dsw-alias-label-secondary,#8b8b8b);"
				+ "cursor:pointer;flex:none;margin-left:2px;";
			btn.innerHTML = "<svg width=\"10\" height=\"10\" viewBox=\"0 0 10 10\" fill=\"none\" aria-hidden=\"true\">"
				+ "<path d=\"M2.2 2.2l5.6 5.6M7.8 2.2l-5.6 5.6\" stroke=\"currentColor\" stroke-width=\"1.3\" stroke-linecap=\"round\"/></svg>";
			btn.addEventListener("pointerdown", (e) => {
				e.stopPropagation();
				e.preventDefault();
			});
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				e.preventDefault();
				void onClear();
			});
			chip.insertAdjacentElement("afterend", btn);
		}

		/** 当前会话挂接的工作区视图（无则 undefined）。 */
		function currentWorkspaceOf(workspacesSnapshot, currentId) {
			if (currentId === undefined || currentId === null) return undefined;
			const items = workspacesSnapshot.items || [];
			for (let i = 0; i < items.length; i += 1) {
				const w = items[i];
				if ((w.sessionIds || []).indexOf(currentId) !== -1) return w;
			}
			return undefined;
		}

		/**
		 * subagent 子会话的判定：列表摘要带 origin === "subagent" 或 parentId。
		 * 子代理的空白会话同样是"空白 + 无工作区"，若不排除会被误当作临时会话
		 * 复用并打开——进而表现为"临时会话以 subagent 形式运行"，
		 * 且模型选择报 agent-busy（owned by subagent routing）。
		 */
		function isSubagentSummary(summary) {
			return summary !== undefined
				&& (summary.origin === "subagent" || summary.parentId !== undefined);
		}

		/** 取 cwd 的最后一段（兼容 Windows / 类 Unix 分隔符）。 */
		function lastPathSegment(cwd) {
			const trimmed = String(cwd).replace(/[/\\]+$/, "");
			const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
			return trimmed.slice(cut + 1);
		}

		/**
		 * 判定一个摘要是否属于本插件创建的临时会话：cwd 正是
		 * `<tempRoot>/session-<uuid>`（任意 tempRoot 下，cwd 的末段都等于
		 * 会话 id）。这是"临时会话"身份的硬校验——桌面外壳 / 其他插件也会
		 * 创建"空白 + 无工作区"的会话（例如按项目目录预建的空会话，其 cwd
		 * 是真实项目目录而非 tempRoot），只凭"空白 + 无工作区"判定会把它们
		 * 误当作本插件的临时会话复用，表现为"临时对话跑进了别的目录（如
		 * ~/.dsh/profiles/web）"。
		 */
		function isTempSessionSummary(summary) {
			if (summary === undefined) return false;
			const cwd = summary.cwd;
			if (typeof cwd !== "string" || cwd === "") return false;
			const id = summary.id;
			if (typeof id !== "string" || !/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
				return false;
			}
			return lastPathSegment(cwd) === id;
		}

		/**
		 * 找一个现成的"本插件创建的空白临时会话"（空白 + 无工作区 + 非
		 * subagent + cwd 形状符合 `<tempRoot>/session-<uuid>`）。
		 * 不存在则 undefined。
		 */
		function findExistingTempBlank(sessionSnapshot, workspacesSnapshot) {
			const ids = sessionSnapshot.ids || [];
			for (let i = 0; i < ids.length; i += 1) {
				const summary = sessionSnapshot.byId[ids[i]];
				if (summary === undefined || summary.blank !== true) continue;
				if (isSubagentSummary(summary)) continue;
				if (!isTempSessionSummary(summary)) continue;
				if (currentWorkspaceOf(workspacesSnapshot, summary.id) === undefined) return summary.id;
			}
			return undefined;
		}

		exports.name = "dsh-temp-session";
		exports.inject = ["sessions", "workspaces"];

		/**
		 * 插件入口：接线 stores、安装 DOM 观测、修补 startSession 并启动兜底逻辑。
		 * @param {object} ctx - 客户端根上下文。
		 */
		exports.apply = function apply(ctx) {
			const sessions = ctx.sessions;
			const workspaces = ctx.workspaces;
			const sessionsList = sessions.list;
			const workspacesList = workspaces.list;

			let creating = false;
			let lastAuto = 0;
			let pendingRaf = 0;
			/** 本轮应用是否出现过"当前会话"：区分启动期与运行期（见 autoEnsure）。 */
			let everHadCurrent = false;
			/** 状态订阅 / 服务补丁的卸载器（先声明，供上方补丁注册使用）。 */
			const disposers = [];

			/** 预留并创建一次临时会话；复用现成的空白临时会话时直接返回其 id。 */
			async function ensureTempSession() {
				const existing = findExistingTempBlank(sessionsList.getSnapshot(), workspacesList.getSnapshot());
				if (existing !== undefined) return existing;
				const response = await fetch(API_PREFIX + "/reserve", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}"
				});
				if (!response.ok) {
					const detail = await response.text().catch(() => "");
					throw new Error("reserve failed (" + response.status + "): " + detail);
				}
				const data = await response.json();
				if (data.ok !== true) throw new Error((data && data.error) || "reserve failed");
				return await sessions.create({ sessionId: data.sessionId, cwd: data.cwd });
			}

			/** 点击 ×：把当前空白会话从工作区切回"未选定"（临时会话）。 */
			async function clearWorkspace() {
				if (creating) return;
				const snapshot = sessionsList.getSnapshot();
				const currentId = snapshot.current;
				if (currentId === undefined) return;
				const workspace = currentWorkspaceOf(workspacesList.getSnapshot(), currentId);
				if (workspace === undefined) return;
				creating = true;
				try {
					const nextId = await ensureTempSession();
					if (sessionsList.getSnapshot().current !== nextId) sessions.open(nextId);
				} catch (error) {
					console.warn("dsh-temp-session: clear workspace failed:", error);
				} finally {
					creating = false;
				}
			}

			/** DOM 对账：更新芯片文案与 × 展示。 */
			function reconcile() {
				try {
					const chip = findChip();
					if (chip === null) {
						removeClearButton();
						return;
					}
					const snapshot = sessionsList.getSnapshot();
					const workspace = currentWorkspaceOf(workspacesList.getSnapshot(), snapshot.current);
					const t = texts();
					const labelSpan = chip.children[1];
					if (workspace === undefined) {
						// 未选定工作区（临时会话 / 尚无会话）：显示"选择工作区（可选）"，无 ×。
						if (labelSpan !== undefined && labelSpan.tagName === "SPAN" && labelSpan.textContent !== t.optional) {
							labelSpan.textContent = t.optional;
						}
						restoreChevronSwap(chip);
						removeClearButton();
					} else {
						// 已选定工作区：箭头原位替换为"悬停显示 ×"。
						// 关键：新会话/新建工作区的时序里，reconcile 可能先在
						// "工作区归属尚未到达"时把标签写成"选择工作区（可选）"，
						// 之后归属到达、React 不再重渲染标签节点（虚拟文本无变化），
						// 只剩本函数能修复 —— 因此在已选定分支里同步把标签断言回
						// 工作区标题（与未选定分支对称），彻底避免标签卡死。
						const title = workspace.title;
						if (typeof title === "string" && title !== ""
							&& labelSpan !== undefined && labelSpan.tagName === "SPAN"
							&& labelSpan.textContent !== title) {
							labelSpan.textContent = title;
						}
						installChevronSwap(chip, clearWorkspace);
					}
				} catch (error) {
					/* 任何 DOM/状态异常都不应打断应用；下一轮对账重试。 */
				}
			}

			function scheduleReconcile() {
				if (pendingRaf !== 0) return;
				pendingRaf = window.requestAnimationFrame(() => {
					pendingRaf = 0;
					reconcile();
				});
			}

			/**
			 * 兜底：当前无会话时预建一个临时空白会话。
			 * 启动期（尚未出现过当前会话）有最近工作区时让位给上游初始选择逻辑
			 * （watchNavigation 的一次性初始连接策略，只在该窗口内自动连接）；
			 * 运行期（删除/归档当前会话后 current 归零）上游不再行动，由这里补位，
			 * 否则 hero 输入框因 sessionId === void 0 被内核判为 inert（必须选工作区）。
			 *
			 * 内核适配（0.1.2-rc.x）：工作区快照从早期（0.1.1-rc.x）的
			 * `baselinesReady` / `recentWorkspaceId` 改为 `phase`（pending→ready）
			 * 与 UI 层实时复算的最近工作区。旧守卫 `baselinesReady !== true`
			 * 在新内核中永远是 early-return：当用户清空全部工作区后点"新建会话"，
			 * 上游 startSession() 目标为空只执行 sessions.clear()，本兜底又不触发，
			 * 界面就卡在"必须选择工作区"（且首次创建后标签残留"选择工作区（可选）"，
			 * 见 reconcile 的修复）。这里换成新内核的就绪信号与复算守卫。
			 */
			function autoEnsure() {
				if (creating) return;
				let snapshot;
				try {
					snapshot = sessionsList.getSnapshot();
				} catch {
					return;
				}
				const wsSnapshot = workspacesList.getSnapshot();
				if (wsSnapshot.phase !== "ready" || snapshot.phase !== "ready") return;
				if (snapshot.current !== undefined) {
					everHadCurrent = true;
					return;
				}
				if (!everHadCurrent && recentWorkspaceIdOf(wsSnapshot.items || [], snapshot.byId) !== undefined) return;
				const now = Date.now();
				if (now - lastAuto < 2000) return;
				lastAuto = now;
				creating = true;
				ensureTempSession()
					.then((id) => {
						if (sessionsList.getSnapshot().current === undefined) sessions.open(id);
					})
					.catch((error) => {
						console.warn("dsh-temp-session: auto temp session failed:", error);
					})
					.finally(() => {
						creating = false;
					});
			}

			// 1) "新建会话"入口：无显式工作区 → 临时会话（跳过上游最近工作区逻辑）。
			//    早期内核（0.1.1-rc.x）的 WorkspaceController 上有 startSession；
			//    0.1.2-rc.x 起该入口归于 uiWorkspace 服务（sidebar / hero agent
			//    预设座都经它调用）。两个面都尝试拦截：老的保持原样即可，新的
			//    在 uiWorkspace 可用时直接替换（失败则退回 autoEnsure 兜底）。
			const originalStartSession = workspaces.startSession;
			let legacyPatched = null;
			if (typeof originalStartSession === "function") {
				legacyPatched = function startSession(workspaceId) {
					if (workspaceId === undefined) {
						// 已处于"空白临时会话"的 hero 时，无需再建一个会话。
						const snapshot = sessionsList.getSnapshot();
						const currentId = snapshot.current;
						if (currentId !== undefined) {
							const current = snapshot.byId[currentId];
							const workspace = currentWorkspaceOf(workspacesList.getSnapshot(), currentId);
							if (current !== undefined && current.blank === true
								&& workspace === undefined && !isSubagentSummary(current)
								&& isTempSessionSummary(current)) return;
						}
						if (creating) return;
						creating = true;
						ensureTempSession()
							.then((id) => sessions.open(id))
							.catch((error) => {
								creating = false;
								console.warn("dsh-temp-session: new session failed:", error);
							})
							.finally(() => {
								creating = false;
							});
						return;
					}
					return originalStartSession.call(workspaces, workspaceId);
				};
				workspaces.startSession = legacyPatched;
			}

			// 1b) 0.1.2-rc.x：uiWorkspace.startSession 是"新建会话"按钮的真正入口
			//     （无参 → 上游"继承当前或最近工作区"，目标为空时仅 sessions.clear()，
			//     这正是清空工作区后第一次点"新建会话"卡住的路径）。同样在无参时
			//     改走临时会话；指定工作区时原样放行（工作区行的 + 走原路径）。
			const uiWorkspace = (() => {
				try {
					return typeof ctx.get === "function" ? ctx.get("uiWorkspace") : undefined;
				} catch {
					return undefined; /* 服务尚未由 ui-workspace 提供：退回 autoEnsure 兜底 */
				}
			})();
			const originalUiStartSession = uiWorkspace !== undefined && typeof uiWorkspace.startSession === "function"
				? uiWorkspace.startSession
				: undefined;
			if (typeof originalUiStartSession === "function") {
				const uiPatched = function startSession(workspaceId) {
					if (workspaceId === undefined) {
						// 已处于"空白临时会话"的 hero 时，无需再建一个会话。
						const snapshot = sessionsList.getSnapshot();
						const currentId = snapshot.current;
						if (currentId !== undefined) {
							const current = snapshot.byId[currentId];
							const workspace = currentWorkspaceOf(workspacesList.getSnapshot(), currentId);
							if (current !== undefined && current.blank === true
								&& workspace === undefined && !isSubagentSummary(current)
								&& isTempSessionSummary(current)) return;
						}
						if (creating) return;
						creating = true;
						ensureTempSession()
							.then((id) => sessions.open(id))
							.catch((error) => {
								creating = false;
								console.warn("dsh-temp-session: new session failed:", error);
							})
							.finally(() => {
								creating = false;
							});
						return;
					}
					return originalUiStartSession.call(uiWorkspace, workspaceId);
				};
				uiWorkspace.startSession = uiPatched;
				const originalUiStart = originalUiStartSession;
				const uiSelf = uiWorkspace;
				disposers.push(() => {
					if (uiSelf.startSession === uiPatched) uiSelf.startSession = originalUiStart;
				});
			}

			// 1c) 桌面客户端（dsh-tauri-ui）「未分组」新建会话的断电：摘掉桌面内核写在
			//     <html> 上的 data-dsh-composer-cwd。dsh-tauri-ui 的
			//     composer.workspace-less 能力位是对该属性实时求值，因此摘掉后：
			//       - 侧边栏通用「新建会话」与「未分组」分组行 + 的捕获期 click
			//         拦截器会主动让位（它们只做 warn/return，不再 preventDefault +
			//         停传播），事件回到官方处理 → 上面 1b 的
			//         uiWorkspace.startSession 拦截生效 → 本插件的临时会话；
			//       - 桌面 hero 芯片不再注册（桌面插件在本插件之后 apply），官方
			//         WorkspacePicker 与官方芯片原样保留。
			//     该属性是桌面内核补丁一次性的模块副作用；用 MutationObserver 兜住
			//     任何再次写入（HMR / 模块重求值）。
			blockDesktopComposerCapability();

			// 1d) 兜底改道：若某个桌面版本的启动时序让 dsh-tauri-ui 先完成注册
			//     （hero 的 conversation.hero.workspace 是 single 槽，它用 priority -1
			//     遮蔽官方 WorkspacePicker，插件层面无法撤销该注册），它菜单里的
			//     「未分组」项仍会调用 sessions.create() 或
			//     sessions.create({ cwd: $DSH_HOME/ungrouped })。这里包装
			//     sessions.create，把这两种形状的创建改走本插件预留的临时目录——
			//     即使该入口被点到，落地的也是本插件的临时会话。
			patchDesktopUngroupedCreate();

			/**
			 * I. 摘除桌面能力位（data-dsh-composer-cwd）并保持摘除。
			 * 观察器无条件挂上（属性过滤，代价可忽略）：即使本插件先于桌面内核补丁
			 * 的效果生效，后来的写入也会被立刻摘掉，纯净 dsh 下则始终空转。
			 */
			function blockDesktopComposerCapability() {
				try {
					const root = document.documentElement;
					const strip = () => {
						if (!root.hasAttribute(COMPOSER_CWD_ATTR)) return false;
						desktopLatched = true;
						root.removeAttribute(COMPOSER_CWD_ATTR);
						return true;
					};
					const stripped = strip();
					const guard = new MutationObserver(strip);
					guard.observe(root, { attributes: true, attributeFilter: [COMPOSER_CWD_ATTR] });
					disposers.push(() => guard.disconnect());
					if (stripped) {
						console.warn("dsh-temp-session: blocked the desktop client's ungrouped new-session feature (removed data-dsh-composer-cwd); this plugin owns workspace-free sessions");
					}
				} catch (error) {
					/* 桌面特征判定失败：不动任何东西，退回原有行为。 */
				}
			}

			/** 兜底改道（对应模块头注释里的 III）：把桌面插件的两种"未分组"创建改道到本插件的临时会话。 */
			function patchDesktopUngroupedCreate() {
				const originalCreate = sessions.create;
				if (typeof originalCreate !== "function") return;
				const patchedCreate = function create(options) {
					if (desktopUngroupedActive() && isDesktopUngroupedCreate(options)) {
						const self = this;
						const args = arguments;
						return ensureTempSession().catch((error) => {
							// 预留失败时退回桌面原行为，绝不把"新建会话"变成静默无响应。
							console.warn("dsh-temp-session: ungrouped redirect failed; falling back:", error);
							return originalCreate.apply(self, args);
						});
					}
					return originalCreate.apply(this, arguments);
				};
				try {
					sessions.create = patchedCreate;
				} catch (error) {
					return; /* 服务属性只读：放弃兜底（1c 的能力位断电仍然生效）。 */
				}
				disposers.push(() => {
					if (sessions.create === patchedCreate) sessions.create = originalCreate;
				});
			}

			// 2) 状态订阅。
			disposers.push(sessionsList.subscribe(scheduleReconcile));
			disposers.push(workspacesList.subscribe(scheduleReconcile));
			disposers.push(sessionsList.subscribe(autoEnsure));
			disposers.push(workspacesList.subscribe(autoEnsure));

			// 3) DOM 观测：React 更新芯片后立即重新对账。
			ensureStyles();
			const observer = new MutationObserver(scheduleReconcile);
			observer.observe(document.body, { childList: true, subtree: true, characterData: true });

			// 4) 首轮对账 + 首轮兜底（快照可能已就绪且无当前会话——此时无订阅事件可依）。
			scheduleReconcile();
			autoEnsure();

			return () => {
				observer.disconnect();
				for (const dispose of disposers) dispose();
				if (legacyPatched !== null && workspaces.startSession === legacyPatched) {
					workspaces.startSession = originalStartSession;
				}
			};
		};

		return exports;
	}
});

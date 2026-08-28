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
 *   4. 兜底：无工作区、无当前会话（且没有可自动连接的最近工作区）时，自动
 *      预建一个空白临时会话，使组合输入框可用。
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
		/** 芯片 → { original: 出厂 chevron 节点, swap: 我们的悬停组件 }。 */
		const swapped = new WeakMap();

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
		 */
		function findChip() {
			const marked = document.querySelector("[" + CHIP_ATTR + "]");
			if (marked !== null && isChipByLabel(marked)) return marked;
			if (marked !== null) marked.removeAttribute(CHIP_ATTR);
			const buttons = document.querySelectorAll("button[aria-haspopup='menu']");
			for (let i = 0; i < buttons.length; i += 1) {
				const el = buttons[i];
				if (isChipByLabel(el)) {
					el.setAttribute(CHIP_ATTR, "");
					return el;
				}
			}
			return null;
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

		/**
		 * 找一个现成的"空白 + 无工作区 + 非 subagent"会话（即本插件创建的临时空白会话）。
		 * 只有本插件会创建无工作区会话，因此该判定是安全的；不存在则 undefined。
		 */
		function findExistingTempBlank(sessionSnapshot, workspacesSnapshot) {
			const ids = sessionSnapshot.ids || [];
			for (let i = 0; i < ids.length; i += 1) {
				const summary = sessionSnapshot.byId[ids[i]];
				if (summary === undefined || summary.blank !== true) continue;
				if (isSubagentSummary(summary)) continue;
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

			/** 兜底：无当前会话、无最近工作区可自动连接时，预建一个临时空白会话。 */
			function autoEnsure() {
				if (creating) return;
				let snapshot;
				try {
					snapshot = sessionsList.getSnapshot();
				} catch {
					return;
				}
				const wsSnapshot = workspacesList.getSnapshot();
				if (wsSnapshot.baselinesReady !== true) return;
				if (snapshot.current !== undefined) return;
				// 有最近工作区时交给上游初始选择逻辑（它会自动连接）——这里不抢占。
				if (wsSnapshot.recentWorkspaceId !== undefined) return;
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
			const originalStartSession = workspaces.startSession;
			let patched = null;
			if (typeof originalStartSession === "function") {
				patched = function startSession(workspaceId) {
					if (workspaceId === undefined) {
						// 已处于"空白临时会话"的 hero 时，无需再建一个会话。
						const snapshot = sessionsList.getSnapshot();
						const currentId = snapshot.current;
						if (currentId !== undefined) {
							const current = snapshot.byId[currentId];
							const workspace = currentWorkspaceOf(workspacesList.getSnapshot(), currentId);
							if (current !== undefined && current.blank === true
								&& workspace === undefined && !isSubagentSummary(current)) return;
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
				workspaces.startSession = patched;
			}

			// 2) 状态订阅。
			const disposers = [];
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
				if (patched !== null && workspaces.startSession === patched) {
					workspaces.startSession = originalStartSession;
				}
			};
		};

		return exports;
	}
});

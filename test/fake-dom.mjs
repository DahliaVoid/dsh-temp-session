/**
 * fake-dom.mjs —— 只够 dsh-temp-session 客户端半区使用的最小 DOM 桩。
 *
 * 目的不是模拟浏览器，而是把 lib/client.js 里那些"选择哪个芯片、摘哪个属性、
 * 拦哪种 sessions.create"的判定放到可断言的测试里。为此只需要：
 *   - 元素树（children / parentElement / replaceChild / insertAdjacentElement）；
 *   - 属性读写与 getClientRects()（可见性判定）；
 *   - 一个支持本插件全部选择器形态的 querySelector(All)
 *     （tag、.class、[attr]、[attr='v']，逗号分隔亦可）；
 *   - MutationObserver / requestAnimationFrame 的手动驱动。
 */

/** 解析一条复合选择器（不含后代组合子）为谓词。 */
function compileSimple(selector) {
	const tagMatch = /^[a-zA-Z][\w-]*/.exec(selector);
	const tag = tagMatch === null ? null : tagMatch[0].toUpperCase();
	const classes = [];
	const attrs = [];
	const classRe = /\.([\w-]+)/g;
	const attrRe = /\[([\w-]+)(?:\s*=\s*(['"]?)([^\]]*?)\2)?\]/g;
	let match;
	while ((match = classRe.exec(selector)) !== null) classes.push(match[1]);
	while ((match = attrRe.exec(selector)) !== null) attrs.push({ name: match[1], value: match[3] });
	return (el) => {
		if (tag !== null && el.tagName !== tag) return false;
		const own = String(el.getAttribute("class") || "").split(/\s+/);
		for (const name of classes) if (own.indexOf(name) === -1) return false;
		for (const attr of attrs) {
			if (!el.hasAttribute(attr.name)) return false;
			if (attr.value !== undefined && attr.value !== "" && el.getAttribute(attr.name) !== attr.value) return false;
		}
		return true;
	};
}

function compile(selector) {
	const parts = String(selector).split(",").map((part) => part.trim()).filter((part) => part !== "");
	const predicates = parts.map(compileSimple);
	return (el) => predicates.some((predicate) => predicate(el));
}

let nextId = 0;

export class FakeElement {
	constructor(tagName) {
		this.tagName = String(tagName).toUpperCase();
		this.uid = nextId += 1;
		this.children = [];
		this.parentElement = null;
		this.attrs = new Map();
		this._text = "";
		/** 内联样式（插件往 × 组件上写 cssText）。 */
		this.style = { cssText: "" };
		/** 可见性：0 表示 display:none 之类的不可见元素。 */
		this.rectCount = 1;
	}

	get textContent() {
		if (this.children.length === 0) return this._text;
		return this._text + this.children.map((child) => child.textContent).join("");
	}

	set textContent(value) {
		this._text = String(value);
		this.children = [];
	}

	get childNodes() {
		return this.children;
	}

	getAttribute(name) {
		return this.attrs.has(name) ? this.attrs.get(name) : null;
	}

	setAttribute(name, value) {
		this.attrs.set(name, String(value));
	}

	removeAttribute(name) {
		this.attrs.delete(name);
	}

	hasAttribute(name) {
		return this.attrs.has(name);
	}

	getClientRects() {
		return this.rectCount === 0 ? [] : [{ width: 1, height: 1 }];
	}

	addEventListener() {}

	removeEventListener() {}

	appendChild(child) {
		child.parentElement = this;
		this.children.push(child);
		return child;
	}

	removeChild(child) {
		const index = this.children.indexOf(child);
		if (index !== -1) this.children.splice(index, 1);
		child.parentElement = null;
		return child;
	}

	replaceChild(next, previous) {
		const index = this.children.indexOf(previous);
		if (index === -1) throw new Error("replaceChild: node is not a child");
		next.parentElement = this;
		previous.parentElement = null;
		this.children[index] = next;
		return previous;
	}

	insertAdjacentElement(position, element) {
		if (position !== "afterend" || this.parentElement === null) return null;
		const siblings = this.parentElement.children;
		const index = siblings.indexOf(this);
		element.parentElement = this.parentElement;
		siblings.splice(index + 1, 0, element);
		return element;
	}

	querySelector(selector) {
		const found = this.querySelectorAll(selector);
		return found.length === 0 ? null : found[0];
	}

	querySelectorAll(selector) {
		const predicate = compile(selector);
		const out = [];
		const walk = (node) => {
			for (const child of node.children) {
				if (predicate(child)) out.push(child);
				walk(child);
			}
		};
		walk(this);
		return out;
	}

	/** 便捷构造：链式加子节点。 */
	add(...children) {
		for (const child of children) this.appendChild(child);
		return this;
	}
}

/** 一个只记录、不自动触发的 MutationObserver 桩。 */
export class FakeMutationObserver {
	constructor(callback) {
		this.callback = callback;
		this.targets = [];
		this.observers = FakeMutationObserver.instances;
		this.observers.push(this);
	}

	observe(target, options) {
		this.targets.push({ target, options });
	}

	disconnect() {
		this.targets = [];
		const index = this.observers.indexOf(this);
		if (index !== -1) this.observers.splice(index, 1);
	}

	/** 手动触发（模拟浏览器投递一条变更记录）。 */
	static triggerAll(records = [{}]) {
		for (const observer of [...FakeMutationObserver.instances]) {
			if (observer.targets.length === 0) continue;
			observer.callback(records, observer);
		}
	}
}
FakeMutationObserver.instances = [];

/** requestAnimationFrame 队列（手动 flush，语义与浏览器一致：回调后返回句柄）。 */
export const rafQueue = [];
export function flushRaf() {
	const pending = rafQueue.splice(0, rafQueue.length);
	for (const callback of pending) callback(0);
}

/**
 * 安装全局 window / document / MutationObserver / requestAnimationFrame。
 * @returns {{document: FakeElement, html: FakeElement, body: FakeElement, clear: () => void}}
 */
export function installDom({ lang = "zh-CN" } = {}) {
	const html = new FakeElement("html");
	html.setAttribute("lang", lang);
	const head = new FakeElement("head");
	const body = new FakeElement("body");
	html.add(head, body);

	const documentStub = {
		documentElement: html,
		head,
		body,
		createElement: (tagName) => new FakeElement(tagName),
		querySelector: (selector) => html.querySelector(selector),
		querySelectorAll: (selector) => html.querySelectorAll(selector),
		addEventListener: () => {},
		removeEventListener: () => {}
	};

	globalThis.window = {
		document: documentStub,
		requestAnimationFrame: (callback) => {
			rafQueue.push(callback);
			return rafQueue.length;
		},
		cancelAnimationFrame: () => {},
		addEventListener: () => {},
		removeEventListener: () => {}
	};
	globalThis.document = documentStub;
	// Node 的 navigator 是只读访问器，只能用 defineProperty 覆盖。
	Object.defineProperty(globalThis, "navigator", { value: { language: lang }, configurable: true });
	globalThis.MutationObserver = FakeMutationObserver;
	FakeMutationObserver.instances = [];
	rafQueue.length = 0;

	return {
		document: documentStub,
		html,
		body,
		clear: () => {
			rafQueue.length = 0;
			FakeMutationObserver.instances = [];
		}
	};
}

/** 造一个 hero 工作区芯片：[图标, SPAN 文案, 箭头]（与官方/桌面芯片同构）。 */
export function makeChip({ label = "选择工作区", visible = true, classes = [] } = {}) {
	const chip = new FakeElement("button");
	chip.setAttribute("type", "button");
	chip.setAttribute("aria-haspopup", "menu");
	chip.setAttribute("aria-label", label);
	if (classes.length > 0) chip.setAttribute("class", classes.join(" "));
	chip.rectCount = visible ? 1 : 0;
	chip.add(new FakeElement("svg"), new FakeElement("span"), new FakeElement("svg"));
	return chip;
}

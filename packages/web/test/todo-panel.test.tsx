import { JSDOM } from "jsdom";
import * as React from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { chatView } from "./support/interaction-fixtures.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	localStorage: dom.window.localStorage,
	sessionStorage: dom.window.sessionStorage,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { act } = React;
const { TodoButton, TodoPanel } = await import("../src/client/components/todo-panel.tsx");
const { TopBar } = await import("../src/client/components/top-bar.tsx");
const { storeActions } = await import("../src/client/lib/store.ts");

type Todos = NonNullable<import("@neko-harness/core").ChatView["todos"]>;
const list: Todos = {
	revision: 5,
	items: [
		{ id: "plan", text: "Write the plan", status: "completed" },
		{ id: "impl", text: "Implement the panel", status: "in_progress" },
		{ id: "ship", text: "Ship it", status: "pending" },
	],
};
const long = `${"A very long todo item that must wrap and stay readable. ".repeat(4)}<script>alert(1)</script> **x** [l](http://e)`;

let sessions = 0;
function connect(todos: Todos | null | undefined, phase: "ready" | "reconnecting" = "ready") {
	const id = `todo-session-${++sessions}`;
	storeActions.setPhase(phase);
	storeActions.setSession(id);
	storeActions.setView(chatView({ todos }));
	return id;
}

function Harness({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
	const [open, setOpen] = React.useState(initiallyOpen);
	return React.createElement(
		React.Fragment,
		null,
		React.createElement(TodoButton, { open, onToggle: () => setOpen(!open), panelId: "todo-panel" }),
		open ? React.createElement(TodoPanel, { id: "todo-panel", onClose: () => setOpen(false) }) : null,
	);
}

const mounted: { unmount(): void }[] = [];
async function mount(element: React.ReactElement = React.createElement(Harness)) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	mounted.push(root);
	await act(async () => root.render(element));
	return { host, root };
}
const entry = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("button[aria-controls]");
const click = (el: Element) => act(async () => void (el as HTMLElement).click());

afterEach(async () => {
	await act(async () => {
		for (const root of mounted.splice(0)) root.unmount();
	});
});
beforeEach(() => {
	document.body.innerHTML = "";
	storeActions.setView(null);
	storeActions.setSession(null);
});

it("shows progress in the entry and the three states in saved order with full content", async () => {
	connect({ ...list, items: [...list.items, { id: "long", text: long, status: "pending" }] });
	const { host, root } = await mount();
	const button = entry(host)!;
	expect(button.textContent).toBe("待办 1/4");
	expect(button.getAttribute("aria-label")).toBe("待办 1/4，已完成 1 项");
	expect(button.getAttribute("aria-expanded")).toBe("false");
	expect(host.querySelector("[data-todo-panel]")).toBeNull();

	await click(button);
	expect(button.getAttribute("aria-expanded")).toBe("true");
	const rows = [...host.querySelectorAll<HTMLElement>("[data-todo-panel] li")];
	expect(rows.map((row) => row.dataset.status)).toEqual(["completed", "in_progress", "pending", "pending"]);
	expect(rows[0]!.textContent).toContain("已完成");
	expect(rows[0]!.textContent).toContain("Write the plan");
	expect(rows[1]!.textContent).toContain("进行中");
	expect(rows[2]!.textContent).toContain("待办");
	expect(host.querySelector("[data-todo-panel]")!.textContent).toContain("已完成 1/4");
	// The full saved text is there (nothing clipped), as plain text.
	expect(rows[3]!.textContent).toContain(long);
	expect(host.querySelector("[data-todo-scroll] script, [data-todo-scroll] a, [data-todo-scroll] strong")).toBeNull();
	await act(async () => root.unmount());
});

it("scrolls long lists inside the panel and stays in the page flow so it cannot cover other controls", async () => {
	connect({
		revision: 1,
		items: Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, text: `item ${i}`, status: "pending" as const })),
	});
	const { host, root } = await mount(React.createElement(Harness, { initiallyOpen: true }));
	const panel = host.querySelector<HTMLElement>("[data-todo-panel]")!;
	const scroller = panel.querySelector<HTMLElement>("[data-todo-scroll]")!;
	expect(scroller.className).toContain("overflow-y-auto");
	expect(scroller.className).toContain("min-h-0");
	// The cap and shrink live on the panel, so it gives way to the composer and question card on short screens.
	expect(panel.className).toMatch(/max-h-\[min\(45dvh,/);
	expect(panel.className).toMatch(/\bshrink\b/);
	expect(scroller.getAttribute("tabindex")).toBe("0");
	expect(scroller.getAttribute("aria-label")).toBe("待办条目");
	expect(panel.querySelectorAll("li")).toHaveLength(100);
	for (const element of [panel, scroller]) expect(element.className).not.toMatch(/\b(fixed|absolute|sticky)\b/);
	for (const li of panel.querySelectorAll("li > span:last-child")) expect(li.className).toContain("break-words");
	await act(async () => root.unmount());
});

it("hides the entry and the panel for an empty list and for a gateway without todos", async () => {
	connect({ revision: 2, items: [] });
	const empty = await mount(React.createElement(Harness, { initiallyOpen: true }));
	expect(entry(empty.host)).toBeNull();
	expect(empty.host.querySelector("[data-todo-panel]")).toBeNull();
	await act(async () => empty.root.unmount());

	connect(null);
	const old = await mount(React.createElement(Harness, { initiallyOpen: true }));
	expect(entry(old.host)).toBeNull();
	expect(old.host.querySelector("[data-todo-panel]")).toBeNull();
	await act(async () => old.root.unmount());
});

it("follows committed changes live", async () => {
	connect(list);
	const { host, root } = await mount();
	expect(entry(host)!.textContent).toBe("待办 1/3");
	await act(async () => {
		storeActions.setView(
			chatView({
				todos: { revision: 6, items: list.items.map((item) => ({ ...item, status: "completed" as const })) },
			}),
		);
	});
	expect(entry(host)!.textContent).toBe("待办 3/3");
	await act(async () => {
		storeActions.setView(chatView({ todos: { revision: 7, items: [] } }));
	});
	expect(entry(host)).toBeNull();
	await act(async () => root.unmount());
});

it("keeps showing the loaded list when the connection drops, clearly marked offline", async () => {
	connect(list);
	const { host, root } = await mount(React.createElement(Harness, { initiallyOpen: true }));
	expect(host.querySelector("[data-todo-panel]")!.textContent).not.toContain("离线");
	await act(async () => {
		storeActions.setPhase("reconnecting");
		storeActions.setView(null);
	});
	const panel = host.querySelector("[data-todo-panel]")!;
	expect(panel.querySelectorAll("li")).toHaveLength(3);
	expect(panel.querySelector("output")!.textContent).toContain("离线");
	expect(entry(host)!.getAttribute("aria-label")).toBe("待办 1/3，已完成 1 项（离线）");

	// A reconnect to a gateway that does not know todos hides the stale list instead of trusting the cache.
	await act(async () => {
		storeActions.setPhase("ready");
		storeActions.setView(chatView({ todos: null }));
	});
	expect(host.querySelector("[data-todo-panel]")).toBeNull();
	expect(entry(host)).toBeNull();
	await act(async () => root.unmount());
});

it("closes with the close button and Escape without touching anything else", async () => {
	connect(list);
	const { host, root } = await mount(React.createElement(Harness, { initiallyOpen: true }));
	const close = [...host.querySelectorAll("button")].find((b) => b.textContent === "关闭")!;
	await click(close);
	expect(host.querySelector("[data-todo-panel]")).toBeNull();
	await click(entry(host)!);
	await act(async () => {
		host
			.querySelector("[data-todo-panel]")!
			.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	});
	expect(host.querySelector("[data-todo-panel]")).toBeNull();
	await act(async () => root.unmount());
});

it("puts the entry in the top bar, next to the connection state", async () => {
	connect(list);
	const { host, root } = await mount(
		React.createElement(TopBar, {
			conn: "ready",
			onToggleSessions: () => {},
			todos: { open: false, onToggle: () => {}, panelId: "p" },
		}),
	);
	expect(host.querySelector("header")!.contains(entry(host))).toBe(true);
	await act(async () => root.unmount());
	// Without the prop (e.g. other pages) there is no entry at all.
	const bare = await mount(React.createElement(TopBar, { conn: "ready", onToggleSessions: () => {} }));
	expect(entry(bare.host)).toBeNull();
	await act(async () => bare.root.unmount());
});

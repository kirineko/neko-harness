import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import type {
	WireChangeDetail,
	WireChangeList,
	WireWorkspaceDir,
	WireWorkspaceFile,
} from "@neko-harness/gateway/contract";
import { JSDOM } from "jsdom";
import * as React from "react";
import { chatView } from "./support/interaction-fixtures.ts";

const dom = new JSDOM("<!doctype html><html><head><title>neko.harness</title></head><body></body></html>", {
	url: "http://localhost/",
});
let viewportWidth = 1440;
Object.assign(dom.window, {
	matchMedia: (query: string) => {
		const max = /max-width:\s*(\d+)px/.exec(query);
		return {
			matches: max ? viewportWidth <= Number(max[1]) : false,
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		};
	},
});
Object.assign(dom.window.HTMLElement.prototype, { scrollTo: () => {} });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	localStorage: dom.window.localStorage,
	sessionStorage: dom.window.sessionStorage,
	HTMLElement: dom.window.HTMLElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});

type Handlers = {
	dir(path: string, signal?: AbortSignal): Promise<WireWorkspaceDir>;
	file(path: string, signal?: AbortSignal): Promise<WireWorkspaceFile>;
	changes(): Promise<WireChangeList>;
	change(path: string): Promise<WireChangeDetail | null>;
};
const calls = { dir: [] as string[], file: [] as string[], changes: 0, change: [] as string[] };
let handlers: Handlers;
let seenSignals: { path: string; signal?: AbortSignal }[] = [];
const workspace = {
	supported: true,
	summary: () => undefined,
	dir: (path: string, signal?: AbortSignal) => {
		calls.dir.push(path);
		seenSignals.push({ path, ...(signal ? { signal } : {}) });
		return handlers.dir(path, signal);
	},
	file: (path: string, signal?: AbortSignal) => {
		calls.file.push(path);
		return handlers.file(path, signal);
	},
	changes: () => {
		calls.changes++;
		return handlers.changes();
	},
	change: (path: string) => {
		calls.change.push(path);
		return handlers.change(path);
	},
};
const job = {
	jobId: "job-1",
	title: "build",
	command: "bun run build",
	cwd: "/w",
	status: "exited",
	startedAt: 1,
	endedAt: 2,
	exitCode: 0,
	outputBytes: 0,
};
const subagent = {
	agentId: "agent-9",
	parentId: 1,
	childId: 9,
	role: "coder",
	title: "Fix the parser",
	status: "running",
	activeRoundId: 3,
	lastRoundId: 3,
	roundCount: 1,
	taskTitle: "t",
	approvalCount: 0,
	createdAt: 1,
};
mock.module("../src/client/lib/bootstrap", () => ({
	appActions: {
		submit: async () => {},
		questionGet: async () => null,
		questionRespond: async () => ({}),
		subagent: () => ({
			view: { value: { approvals: [] }, subscribe: () => () => {} },
			history: async () => ({ items: [], next: null }),
			stop: async () => {},
		}),
		jobOutput: async () => ({ job, text: "", offset: 0, truncated: false, dropped: 0 }),
		jobStop: async () => {},
		workspace: () => workspace,
		withdraw: async () => ({ result: "unknown" }),
		steer: async () => ({ result: "unknown" }),
		abort: () => {},
		compact: async () => {},
		searchFiles: async () => ({ items: [] }),
		listSkills: async () => [],
		createSession: async () => {},
		selectSession: async () => {},
		selectWorkspace: async () => {},
		addWorkspace: async () => {},
		archiveSession: async () => {},
		configure: async () => {},
	},
	reportError: () => {},
}));
mock.module("@tanstack/react-router", () => ({
	Link: (props: { to: string; className?: string; children?: React.ReactNode }) =>
		React.createElement("a", { href: props.to, className: props.className }, props.children),
}));

const { createRoot } = await import("react-dom/client");
const { act } = React;
const { ChatPage } = await import("../src/client/pages/chat-page.tsx");
const { storeActions } = await import("../src/client/lib/store.ts");

// ---------------------------------------------------------------- fixtures
const entry = (path: string, kind: "file" | "directory" | "symlink" = "file", extra: { protected?: true } = {}) => ({
	name: path.split("/").pop()!,
	path,
	kind,
	...extra,
});
const tree: Record<string, ReturnType<typeof entry>[]> = {
	"": [
		entry("docs", "directory"),
		entry("src", "directory"),
		entry("README.md"),
		entry(".env", "file", { protected: true }),
		entry("link", "symlink"),
		entry("logo.png"),
		entry("big.log"),
	],
	src: [entry("src/ui", "directory"), entry("src/main.ts")],
	"src/ui": [entry("src/ui/button.tsx")],
	docs: [],
};
const TS_SOURCE = "const answer = 42;\nexport function run(): number {\n\treturn answer;\n}\n";
const text = (path: string, content: string, over: Partial<WireWorkspaceFile> = {}): WireWorkspaceFile => ({
	path,
	size: content.length,
	mtimeMs: 1,
	kind: "text",
	content,
	truncated: false,
	...over,
});
const files: Record<string, WireWorkspaceFile> = {
	"README.md": text("README.md", "# Title\n\nHello\n"),
	"src/main.ts": text("src/main.ts", TS_SOURCE),
	"src/ui/button.tsx": text("src/ui/button.tsx", "export const Button = () => null;\n"),
	".env": { path: ".env", size: 40, mtimeMs: 1, kind: "protected", truncated: false },
	"logo.png": { path: "logo.png", size: 2048, mtimeMs: 1, kind: "binary", truncated: false },
	"big.log": text("big.log", "line one\nline two\n", { size: 3 * 1024 * 1024, truncated: true }),
};
function defaults(): Handlers {
	return {
		dir: async (path) => ({ path, entries: tree[path] ?? [], limited: false, incomplete: false }),
		file: async (path) => {
			const found = files[path];
			if (!found) throw new Error("File not found.");
			return found;
		},
		changes: async () => ({ revision: 1, files: [], truncated: false }),
		change: async () => null,
	};
}
const abortable = <T,>(signal?: AbortSignal) =>
	new Promise<T>((_resolve, reject) => {
		signal?.addEventListener("abort", () => reject(new Error("aborted")));
	});
const summary = (revision: number, count = 0) => ({ revision, files: count, added: 0, removed: 0 });
const op = (seq: number, over: Partial<WireChangeDetail["ops"][number]> = {}) => ({
	seq,
	agent: "main",
	tool: "edit" as const,
	diff: " 1 const a = 1;\n-2 var b = 2;\n+2 const b = 3;",
	added: 1,
	removed: 1,
	truncated: false,
	...over,
});

let sessions = 0;
function connect(init: Parameters<typeof chatView>[0]) {
	const id = `ws-session-${++sessions}`;
	act(() => {
		storeActions.setWorkspace("/w");
		storeActions.setPhase("ready");
		storeActions.setSession(id);
		storeActions.setDirectory([]);
		storeActions.setView(chatView(init));
	});
	return id;
}
const setView = (init: Parameters<typeof chatView>[0]) => act(async () => storeActions.setView(chatView(init)));
const mounted: { unmount(): void }[] = [];
const flush = async () => {
	for (let i = 0; i < 4; i++) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
};
async function mount() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	mounted.push(root);
	await act(async () => root.render(React.createElement(ChatPage)));
	await flush();
	return host;
}
const click = async (el: Element | null | undefined) => {
	await act(async () => void (el as HTMLElement).click());
	await flush();
};
const key = async (el: Element, name: string) => {
	await act(async () => {
		el.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
	});
	await flush();
};
const entryButton = (host: ParentNode) => host.querySelector<HTMLButtonElement>("[data-workspace-entry]");
const panel = (host: ParentNode, label = "工作区") => host.querySelector<HTMLElement>(`aside[aria-label="${label}"]`);
const isOpen = (el: Element | null) => el !== null && !el.className.split(/\s+/).includes("hidden");
const byText = (root: ParentNode | null, selector: string, label: string) =>
	[...(root?.querySelectorAll<HTMLElement>(selector) ?? [])].find(
		(el) => el.textContent?.trim() === label || el.getAttribute("aria-label") === label,
	);
const rows = (host: ParentNode) => [...host.querySelectorAll<HTMLElement>("[role=treeitem]")];
const row = (host: ParentNode, path: string) => rows(host).find((r) => r.dataset.path === path)!;
const rowPaths = (host: ParentNode) => rows(host).map((r) => r.dataset.path);
const tab = (host: ParentNode, name: string) =>
	[...host.querySelectorAll<HTMLElement>("[role=tab]")].find((t) => t.textContent?.startsWith(name))!;
async function openWorkspace(host: ParentNode) {
	entryButton(host)!.focus();
	await click(entryButton(host));
	return panel(host)!;
}
const code = (host: ParentNode) => host.querySelector<HTMLElement>("[data-testid=file-code]");
const notice = (host: ParentNode) => host.querySelector<HTMLElement>("[data-testid=file-notice]");

beforeEach(() => {
	document.body.innerHTML = "";
	handlers = defaults();
	calls.dir.length = 0;
	calls.file.length = 0;
	calls.changes = 0;
	calls.change.length = 0;
	seenSignals = [];
	viewportWidth = 1440;
});
afterEach(async () => {
	await act(async () => {
		for (const root of mounted.splice(0)) root.unmount();
	});
	storeActions.setView(null);
	storeActions.setSession(null);
});

// ------------------------------------------------------------ entry & state
it("hides the workspace entry on a gateway without the workspace browser and keeps chat and jobs working", async () => {
	connect({ jobs: [job] as never });
	const host = await mount();
	expect(entryButton(host)).toBeNull();
	expect(panel(host)).toBeNull();
	expect(host.querySelector('section[aria-label="消息输入"]')).not.toBeNull();
	expect(byText(host.querySelector("header"), "button", "任务 1")).toBeDefined();
	expect(calls.dir).toHaveLength(0);
});

it("starts closed, never opens by itself when files change, and only the entry count follows the summary", async () => {
	connect({ changes: summary(1, 0) });
	const host = await mount();
	expect(entryButton(host)!.getAttribute("aria-label")).toBe("工作区");
	expect(isOpen(panel(host))).toBe(false);
	await setView({ changes: summary(2, 3) });
	await flush();
	expect(isOpen(panel(host))).toBe(false);
	expect(entryButton(host)!.getAttribute("aria-label")).toBe("工作区，3 个改动文件");
	expect(entryButton(host)!.textContent).toBe("3");
	// A closed panel does not touch the gateway.
	expect(calls.dir).toHaveLength(0);
	expect(calls.changes).toBe(0);
});

it("keeps tab, expanded directories and the open file across close/reopen without touching the composer", async () => {
	connect({ changes: summary(1, 0) });
	const host = await mount();
	const area = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息输入"]')!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(area, "my draft");
		area.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
	await openWorkspace(host);
	expect(calls.dir).toEqual([""]);
	await click(row(host, "src"));
	await click(row(host, "src/ui"));
	expect(calls.dir).toEqual(["", "src", "src/ui"]);
	await click(row(host, "src/ui/button.tsx"));
	expect(code(host)!.textContent).toContain("export const Button");
	// Close from the entry, then reopen.
	await click(entryButton(host));
	expect(isOpen(panel(host))).toBe(false);
	expect(area.value).toBe("my draft");
	await click(entryButton(host));
	expect(isOpen(panel(host))).toBe(true);
	expect(code(host)!.textContent).toContain("export const Button");
	expect(area.value).toBe("my draft");
	// The composer (draft, attachments) is never remounted by the panel.
	expect(host.querySelector('textarea[aria-label="消息输入"]')).toBe(area);
	// Back to the tree: expansion survived and focus lands on the file's row.
	await click(byText(panel(host), "button", "← 文件树"));
	expect(row(host, "src").getAttribute("aria-expanded")).toBe("true");
	expect(row(host, "src/ui").getAttribute("aria-expanded")).toBe("true");
	expect(rowPaths(host)).toContain("src/ui/button.tsx");
	expect(document.activeElement).toBe(row(host, "src/ui/button.tsx"));
});

it("resets the panel state when the session changes and closes it", async () => {
	connect({ changes: summary(1, 0) });
	const host = await mount();
	await openWorkspace(host);
	await click(row(host, "src"));
	expect(row(host, "src").getAttribute("aria-expanded")).toBe("true");
	connect({ changes: summary(1, 0) });
	await flush();
	expect(isOpen(panel(host))).toBe(false);
	await openWorkspace(host);
	expect(row(host, "src").getAttribute("aria-expanded")).toBe("false");
});

// -------------------------------------------------------------- slot sharing
it("shares one right-hand slot between the workspace, jobs and subagent panels", async () => {
	connect({ changes: summary(1, 0), jobs: [job] as never, agents: [subagent] as never });
	const host = await mount();
	// Legacy rule: the first delegation opens the subagent panel while nothing else holds the slot.
	expect(isOpen(panel(host, "子智能体"))).toBe(true);
	await openWorkspace(host);
	expect(isOpen(panel(host))).toBe(true);
	expect(isOpen(panel(host, "子智能体"))).toBe(false);
	await click(byText(host.querySelector("header"), "button", "任务 1"));
	expect(isOpen(panel(host, "后台任务"))).toBe(true);
	expect(isOpen(panel(host))).toBe(false);
	await click(entryButton(host));
	expect(isOpen(panel(host))).toBe(true);
	expect(isOpen(panel(host, "后台任务"))).toBe(false);
	// The in-stream tray switches back to the subagent panel.
	await click(byText(host, "button", "子智能体 · 1 个 · 1 运行中"));
	expect(isOpen(panel(host, "子智能体"))).toBe(true);
	expect(isOpen(panel(host))).toBe(false);
	expect([panel(host), panel(host, "子智能体"), panel(host, "后台任务")].filter((aside) => isOpen(aside))).toHaveLength(
		1,
	);
});

it("gives the workspace, jobs and subagent panels one shared, resizable width", async () => {
	connect({ changes: summary(1, 0), jobs: [job] as never, agents: [subagent] as never });
	const host = await mount();
	const panels = () => [panel(host), panel(host, "子智能体"), panel(host, "后台任务")];
	const widths = () => panels().map((aside) => aside?.style.getPropertyValue("--panel-w"));
	for (const aside of panels()) {
		expect(aside).not.toBeNull();
		expect(aside!.querySelectorAll("[role=separator]")).toHaveLength(1);
		expect(aside!.className).toContain("lg:w-[var(--panel-w)]");
		expect(aside!.className).toContain("lg:max-w-[60vw]");
		expect(aside!.className).toContain("lg:relative");
	}
	// The subagent panel holds the slot first; resizing it moves all three together.
	expect(isOpen(panel(host, "子智能体"))).toBe(true);
	const separator = panel(host, "子智能体")!.querySelector<HTMLElement>("[role=separator]")!;
	await key(separator, "End");
	expect(widths()).toEqual(["960px", "960px", "960px"]);
	await openWorkspace(host);
	expect(panel(host)!.querySelector("[role=separator]")!.getAttribute("aria-valuenow")).toBe("960");
	await click(byText(host.querySelector("header"), "button", "任务 1"));
	const jobSeparator = panel(host, "后台任务")!.querySelector<HTMLElement>("[role=separator]")!;
	expect(jobSeparator.getAttribute("aria-valuenow")).toBe("960");
	await key(jobSeparator, "Home");
	expect(widths()).toEqual(["320px", "320px", "320px"]);
	await key(jobSeparator, "ArrowLeft");
	expect(widths()).toEqual(["344px", "344px", "344px"]);
	// Double click restores the default for every panel.
	await act(async () => {
		jobSeparator.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
	});
	expect(widths()).toEqual(["560px", "560px", "560px"]);
});

it("restores the previous tab and browsing position when the workspace panel is reopened after another panel", async () => {
	connect({ changes: summary(1, 1), jobs: [job] as never });
	handlers.changes = async () => ({
		revision: 1,
		files: [{ path: "src/main.ts", ops: 1, added: 1, removed: 0, agents: ["main"], lastSeq: 4 }],
		truncated: false,
	});
	handlers.change = async (path) => ({ path, ops: [op(4)], truncated: false });
	const host = await mount();
	await openWorkspace(host);
	await click(tab(host, "改动"));
	await click(host.querySelector('button[data-path="src/main.ts"]'));
	expect(host.querySelector("[data-testid=change-detail]")).not.toBeNull();
	await click(byText(host.querySelector("header"), "button", "任务 1"));
	expect(isOpen(panel(host))).toBe(false);
	await click(entryButton(host));
	expect(tab(host, "改动").getAttribute("aria-selected")).toBe("true");
	expect(host.querySelector("[data-testid=change-detail]")).not.toBeNull();
});

it("does not let the first delegation take the slot from an open workspace panel", async () => {
	connect({ changes: summary(1, 0) });
	const host = await mount();
	await openWorkspace(host);
	await click(row(host, "src"));
	await setView({ changes: summary(1, 0), agents: [subagent] as never });
	await flush();
	expect(isOpen(panel(host))).toBe(true);
	expect(row(host, "src").getAttribute("aria-expanded")).toBe("true");
	expect(isOpen(panel(host, "子智能体"))).toBe(false);
	// Only the in-stream tray is offered; clicking it switches the slot.
	const tray = byText(host, "button", "子智能体 · 1 个 · 1 运行中")!;
	expect(tray).toBeDefined();
	await click(tray);
	expect(isOpen(panel(host, "子智能体"))).toBe(true);
	expect(isOpen(panel(host))).toBe(false);
	// Closing the subagent panel does not reopen anything by streaming updates.
	await click(byText(panel(host, "子智能体"), "button", "关闭"));
	await setView({ changes: summary(2, 0), agents: [{ ...subagent, roundCount: 2 }] as never });
	await flush();
	expect(isOpen(panel(host, "子智能体"))).toBe(false);
	expect(isOpen(panel(host))).toBe(false);
});

it("keeps the legacy behaviour: auto-open on first delegation, then stay closed after the user closes it", async () => {
	connect({ agents: [subagent] as never });
	const host = await mount();
	expect(isOpen(panel(host, "子智能体"))).toBe(true);
	await click(byText(panel(host, "子智能体"), "button", "关闭"));
	expect(isOpen(panel(host, "子智能体"))).toBe(false);
	await setView({ agents: [{ ...subagent, roundCount: 2 }] as never });
	await flush();
	expect(isOpen(panel(host, "子智能体"))).toBe(false);
});

// ---------------------------------------------------------------------- tree
it("loads directories lazily, keeps the served order, marks symlinks and protected files, and refreshes", async () => {
	connect({ changes: summary(1, 0) });
	const host = await mount();
	await openWorkspace(host);
	expect(calls.dir).toEqual([""]);
	expect(rowPaths(host)).toEqual(["docs", "src", "README.md", ".env", "link", "logo.png", "big.log"]);
	expect(row(host, "link").querySelector('[aria-label="符号链接"]')).not.toBeNull();
	expect(row(host, ".env").querySelector('[aria-label="受保护文件"]')).not.toBeNull();
	expect(row(host, "src").getAttribute("aria-expanded")).toBe("false");
	await click(row(host, "src"));
	expect(calls.dir).toEqual(["", "src"]);
	expect(rowPaths(host).slice(0, 5)).toEqual(["docs", "src", "src/ui", "src/main.ts", "README.md"]);
	expect(row(host, "src/ui").getAttribute("aria-level")).toBe("2");
	await click(row(host, "src"));
	expect(rowPaths(host)).not.toContain("src/main.ts");
	// Expanding again re-reads the directory; the manual refresh reloads every expanded one.
	await click(row(host, "src"));
	expect(calls.dir).toEqual(["", "src", "src"]);
	await click(host.querySelector('button[aria-label="刷新文件树"]'));
	expect(calls.dir.slice(3).sort()).toEqual(["", "src"]);
	await click(row(host, "docs"));
	expect(host.textContent).toContain("空目录");
});

it("reports an incomplete listing instead of pretending it is whole", async () => {
	handlers.dir = async (path) => ({
		path,
		entries: tree[path] ?? [],
		limited: path === "src",
		incomplete: path === "",
	});
	connect({ changes: summary(1, 0) });
	const host = await mount();
	await openWorkspace(host);
	expect(host.textContent).toContain("列表不完整：工作区文件过多，枚举已被截断。");
	await click(row(host, "src"));
	expect(host.textContent).toContain("列表不完整：该目录子项过多，仅显示部分。");
});

it("supports keyboard navigation: arrows move, right/left expand and collapse, Enter opens", async () => {
	connect({ changes: summary(1, 0) });
	const host = await mount();
	await openWorkspace(host);
	// One tab stop in the tree.
	expect(rows(host).filter((r) => r.tabIndex === 0)).toHaveLength(1);
	await act(async () => row(host, "docs").focus());
	await key(row(host, "docs"), "ArrowDown");
	expect(document.activeElement).toBe(row(host, "src"));
	await key(row(host, "src"), "ArrowRight");
	expect(row(host, "src").getAttribute("aria-expanded")).toBe("true");
	expect(calls.dir).toEqual(["", "src"]);
	await key(row(host, "src"), "ArrowRight");
	expect(document.activeElement).toBe(row(host, "src/ui"));
	await key(row(host, "src/ui"), "ArrowLeft");
	expect(document.activeElement).toBe(row(host, "src"));
	await key(row(host, "src"), "ArrowLeft");
	expect(row(host, "src").getAttribute("aria-expanded")).toBe("false");
	await key(row(host, "src"), "ArrowDown");
	expect(document.activeElement).toBe(row(host, "README.md"));
	await key(row(host, "README.md"), "End");
	expect(document.activeElement).toBe(row(host, "big.log"));
	await key(row(host, "big.log"), "Home");
	expect(document.activeElement).toBe(row(host, "docs"));
	await key(row(host, "src"), "Enter");
	expect(row(host, "src").getAttribute("aria-expanded")).toBe("true");
	await key(row(host, "src/main.ts"), "Enter");
	expect(calls.file).toEqual(["src/main.ts"]);
	expect(host.querySelector("[data-testid=file-viewer]")).not.toBeNull();
	// Esc closes the panel, also from inside the viewer.
	await key(code(host)!, "Escape");
	expect(isOpen(panel(host))).toBe(false);
});

it("shows a per-directory error with retry and keeps the rest of the tree usable", async () => {
	let failing = true;
	handlers.dir = async (path) => {
		if (path === "src" && failing) throw new Error("Permission denied");
		return { path, entries: tree[path] ?? [], limited: false, incomplete: false };
	};
	connect({ changes: summary(1, 0) });
	const host = await mount();
	await openWorkspace(host);
	await click(row(host, "src"));
	const alert = host.querySelector<HTMLElement>("[role=alert]")!;
	expect(alert.textContent).toContain("Permission denied");
	expect(rowPaths(host)).toContain("README.md");
	failing = false;
	await click(byText(alert, "button", "重试"));
	expect(host.querySelector("[role=alert]")).toBeNull();
	expect(rowPaths(host)).toContain("src/main.ts");
	expect(host.querySelector('section[aria-label="消息输入"]')).not.toBeNull();
});

it("aborts pending requests when the panel closes and drops their late results", async () => {
	let release: (value: WireWorkspaceDir) => void = () => {};
	handlers.dir = (path, signal) =>
		path === "src"
			? Promise.race([
					abortable<WireWorkspaceDir>(signal),
					new Promise<WireWorkspaceDir>((resolve) => {
						release = resolve;
					}),
				])
			: defaults().dir(path, signal);
	connect({ changes: summary(1, 0) });
	const host = await mount();
	await openWorkspace(host);
	await click(row(host, "src"));
	const pending = seenSignals.find((call) => call.path === "src")!.signal!;
	expect(pending.aborted).toBe(false);
	expect(host.textContent).toContain("加载中…");
	await click(entryButton(host));
	expect(pending.aborted).toBe(true);
	release({ path: "src", entries: tree.src!, limited: false, incomplete: false });
	await flush();
	// Reopening reloads the expanded directory instead of showing a stale or failed state.
	handlers.dir = defaults().dir;
	await click(entryButton(host));
	expect(rowPaths(host)).toContain("src/main.ts");
	expect(host.querySelector("[role=alert]")).toBeNull();
});

it("aborts requests of a session that is switched away", async () => {
	handlers.dir = (path, signal) => (path === "" ? defaults().dir(path) : abortable(signal));
	connect({ changes: summary(1, 0) });
	const host = await mount();
	await openWorkspace(host);
	await click(row(host, "src"));
	const pending = seenSignals.find((call) => call.path === "src")!.signal!;
	connect({ changes: summary(1, 0) });
	await flush();
	expect(pending.aborted).toBe(true);
	expect(isOpen(panel(host))).toBe(false);
});

// -------------------------------------------------------------------- viewer
it("shows a text file with line numbers, syntax highlighting, size, and no editing affordances", async () => {
	connect({ changes: summary(1, 0) });
	const host = await mount();
	const aside = await openWorkspace(host);
	await click(row(host, "src"));
	await click(row(host, "src/main.ts"));
	const viewer = host.querySelector("[data-testid=file-viewer]")!;
	expect(viewer.textContent).toContain(`${TS_SOURCE.length} B`);
	expect(host.querySelector("[data-testid=file-gutter]")!.textContent).toBe("1\n2\n3\n4");
	expect(code(host)!.querySelector(".hljs-keyword")).not.toBeNull();
	expect(code(host)!.textContent).toContain("return answer;");
	expect(viewer.querySelector("textarea, input, [contenteditable]")).toBeNull();
	const labels = [...aside.querySelectorAll("button")].map((b) => b.textContent);
	for (const forbidden of ["保存", "编辑", "删除", "重命名", "新建"]) expect(labels).not.toContain(forbidden);
	// Long lines scroll inside the code container, never the page.
	expect(code(host)!.className).toContain("overflow-auto");
	expect(code(host)!.firstElementChild!.className).toContain("min-w-max");
	expect(aside.className).toContain("min-w-0");
	expect(viewer.querySelector('[title="src/main.ts"]')).not.toBeNull();
});

it("zooms the code view proportionally via buttons and Ctrl+wheel, and persists the level", async () => {
	localStorage.clear();
	try {
		connect({ changes: summary(1, 0) });
		const host = await mount();
		await openWorkspace(host);
		await click(row(host, "src"));
		await click(row(host, "src/main.ts"));
		const scale = () => host.querySelector<HTMLElement>("[data-testid=file-code-scale]")!;
		const zoomIn = byText(host, "button", "放大代码")!;
		const zoomOut = byText(host, "button", "缩小代码")!;
		const reset = byText(host, "button", "重置缩放")!;
		expect(scale().style.fontSize).toBe("12px");
		expect(scale().style.lineHeight).toBe("20px");
		expect(reset.textContent).toBe("100%");
		// Buttons step by 10% and scale font size and line height together.
		await click(zoomIn);
		expect(scale().style.fontSize).toBe("13.2px");
		expect(scale().style.lineHeight).toBe("22px");
		expect(reset.textContent).toBe("110%");
		expect(localStorage.getItem("neko.fileZoom")).toBe("110");
		// Ctrl + wheel zooms too; a plain wheel just scrolls.
		await act(async () => {
			code(host)!.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
		});
		expect(scale().style.fontSize).toBe("13.2px");
		await act(async () => {
			code(host)!.dispatchEvent(
				new dom.window.WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }),
			);
		});
		await flush();
		expect(scale().style.fontSize).toBe("14.4px");
		expect(reset.textContent).toBe("120%");
		await click(zoomOut);
		expect(reset.textContent).toBe("110%");
		// Reset returns to 100% and disables itself.
		await click(reset);
		expect(reset.textContent).toBe("100%");
		expect(scale().style.fontSize).toBe("12px");
		expect((reset as HTMLButtonElement).disabled).toBe(true);
		expect(localStorage.getItem("neko.fileZoom")).toBe("100");
	} finally {
		localStorage.clear();
	}
});

it("escapes content instead of injecting it and falls back to plain text for unknown languages", async () => {
	files["evil.weird"] = text("evil.weird", '<img src=x onerror="alert(1)"><script>alert(2)</script>\n');
	tree[""]!.push(entry("evil.weird"));
	try {
		connect({ changes: summary(1, 0) });
		const host = await mount();
		await openWorkspace(host);
		await click(row(host, "evil.weird"));
		expect(code(host)!.querySelector("img, script")).toBeNull();
		expect(code(host)!.textContent).toContain("<script>alert(2)</script>");
		expect(code(host)!.querySelector(".hljs-keyword")).toBeNull();
	} finally {
		tree[""]!.pop();
		delete files["evil.weird"];
	}
});

it("states truncation, binary, protected, missing and failed reads clearly", async () => {
	connect({ changes: summary(1, 0) });
	const host = await mount();
	await openWorkspace(host);
	const back = async () => click(byText(host, "button", "← 文件树"));

	await click(row(host, "big.log"));
	expect(host.querySelector("[role=note]")!.textContent).toBe("已截断，仅显示开头部分，文件共 3.0 MiB");
	expect(code(host)!.textContent).toContain("line two");
	await back();

	await click(row(host, "logo.png"));
	expect(notice(host)!.textContent).toContain("二进制文件，不提供预览");
	expect(notice(host)!.textContent).toContain("2.0 KiB");
	expect(code(host)).toBeNull();
	await back();

	await click(row(host, ".env"));
	expect(notice(host)!.textContent).toContain("受保护文件，不提供查看");
	expect(code(host)).toBeNull();
	await back();

	// Listed in the tree but gone by the time it is opened.
	await click(row(host, "link"));
	expect(notice(host)!.textContent).toContain("文件不存在");
	files.link = text("link", "now exists\n");
	await click(byText(host, "button", "重试"));
	expect(code(host)!.textContent).toContain("now exists");
	delete files.link;
	await back();

	handlers.file = async () => {
		throw new Error("Timed out. Retry.");
	};
	await click(row(host, "README.md"));
	const failed = notice(host)!;
	expect(failed.getAttribute("role")).toBe("alert");
	expect(failed.textContent).toContain("读取失败：Timed out. Retry.");
	handlers.file = defaults().file;
	await click(byText(failed, "button", "重试"));
	expect(code(host)!.textContent).toContain("Hello");
	// The error never touched the chat surface.
	expect(host.querySelector('section[aria-label="消息输入"]')).not.toBeNull();
});

it("refreshes manually and offers a refresh when the open file appears in a newer change revision", async () => {
	let list: WireChangeList = { revision: 1, files: [], truncated: false };
	handlers.changes = async () => list;
	connect({ changes: summary(1, 0) });
	const host = await mount();
	await openWorkspace(host);
	await click(row(host, "README.md"));
	expect(calls.file).toEqual(["README.md"]);
	expect(host.textContent).not.toContain("可能已过期");
	await click(host.querySelector('button[aria-label="刷新文件内容"]'));
	expect(calls.file).toEqual(["README.md", "README.md"]);
	// The agent edits another file: no prompt. Then the open one: prompt.
	list = {
		revision: 2,
		files: [{ path: "other.ts", ops: 1, added: 1, removed: 0, agents: ["main"], lastSeq: 5 }],
		truncated: false,
	};
	await setView({ changes: summary(2, 1) });
	await flush();
	expect(host.textContent).not.toContain("可能已过期");
	list = {
		revision: 3,
		files: [{ path: "README.md", ops: 1, added: 1, removed: 0, agents: ["main"], lastSeq: 9 }, ...list.files],
		truncated: false,
	};
	await setView({ changes: summary(3, 2) });
	await flush();
	expect(host.textContent).toContain("agent 修改了此文件，当前显示的内容可能已过期。");
	files["README.md"] = text("README.md", "# Title\n\nHello again\n");
	await click(byText(host, "button", "刷新内容"));
	expect(code(host)!.textContent).toContain("Hello again");
	expect(host.textContent).not.toContain("可能已过期");
	files["README.md"] = text("README.md", "# Title\n\nHello\n");
});

// ------------------------------------------------------------------- changes
const changedFiles: WireChangeList = {
	revision: 1,
	files: [
		{ path: "src/main.ts", ops: 2, added: 5, removed: 1, agents: ["main", "Fix the parser"], lastSeq: 9 },
		{ path: "/etc/hosts", outside: true, ops: 1, added: 1, removed: 0, agents: ["main"], lastSeq: 3 },
	],
	truncated: false,
};

it("lists agent changes with counts, agents and the outside marker, and follows the revision live", async () => {
	let list = changedFiles;
	handlers.changes = async () => list;
	connect({ changes: summary(1, 2) });
	const host = await mount();
	await openWorkspace(host);
	expect(tab(host, "文件").getAttribute("aria-selected")).toBe("true");
	expect(tab(host, "改动 2")).toBeDefined();
	// The files tab does not need the list.
	expect(calls.changes).toBe(0);
	await click(tab(host, "改动"));
	expect(calls.changes).toBe(1);
	const first = host.querySelector<HTMLElement>('[data-testid=changes-list] button[data-path="src/main.ts"]')!;
	expect(first.textContent).toContain("main.ts");
	expect(first.textContent).toContain("src");
	expect(first.textContent).toContain("+5");
	expect(first.textContent).toContain("-1");
	expect(first.textContent).toContain("2 次");
	expect(first.textContent).toContain("主 agent");
	expect(first.textContent).toContain("Fix the parser");
	const outside = host.querySelector<HTMLElement>('button[data-path="/etc/hosts"]')!;
	expect(outside.textContent).toContain("工作区外");
	expect(host.textContent).toContain("仅列出 agent 通过 edit / write 工具造成的改动，不含命令行（如 bash）造成的改动");
	// A new revision refetches by itself and the tab count follows.
	list = {
		revision: 2,
		files: [{ path: "new.ts", ops: 1, added: 3, removed: 0, agents: ["main"], lastSeq: 12 }, ...changedFiles.files],
		truncated: false,
	};
	await setView({ changes: summary(2, 3) });
	await flush();
	expect(calls.changes).toBe(2);
	expect(host.querySelector('button[data-path="new.ts"]')).not.toBeNull();
	expect(tab(host, "改动 3")).toBeDefined();
	// An unchanged revision does not refetch.
	await setView({ changes: summary(2, 3), busy: false });
	await flush();
	expect(calls.changes).toBe(2);
});

it("shows the scope once in the empty state and flags an incomplete list", async () => {
	connect({ changes: summary(1, 0) });
	const host = await mount();
	await openWorkspace(host);
	await click(tab(host, "改动"));
	const empty = host.querySelector("[data-testid=changes-empty]")!;
	expect(empty.textContent).toContain("edit / write");
	expect(empty.textContent).not.toContain("命令行（如 bash）造成的改动");
	expect(host.textContent).toContain("命令行（如 bash）造成的改动");
	handlers.changes = async () => ({ ...changedFiles, truncated: true });
	await setView({ changes: summary(2, 2) });
	await flush();
	expect(host.textContent).toContain("列表不完整：改动文件过多");
});

it("shows per-operation diffs in time order, labels writes, marks truncation and jumps to current content", async () => {
	handlers.changes = async () => changedFiles;
	handlers.change = async (path) =>
		path === "src/main.ts"
			? {
					path,
					ops: [
						op(9, {
							agent: "Fix the parser",
							tool: "write",
							diff: "+ const a = 1;\n+ export {};",
							added: 2,
							removed: 0,
							truncated: true,
						}),
						op(4),
					],
					truncated: false,
				}
			: { path, outside: true, ops: [op(3)], truncated: false };
	connect({ changes: summary(1, 2) });
	const host = await mount();
	await openWorkspace(host);
	await click(tab(host, "改动"));
	await click(host.querySelector('button[data-path="src/main.ts"]'));
	const ops = [...host.querySelectorAll<HTMLElement>("[data-testid=change-op]")];
	expect(ops).toHaveLength(2);
	// Ordered by seq, not by arrival.
	expect(ops[0]!.querySelector("span")!.textContent).toBe("1");
	expect(ops[0]!.textContent).toContain("主 agent");
	expect(ops[0]!.textContent).toContain("edit");
	expect(ops[0]!.querySelector(".diff-line-add")).not.toBeNull();
	expect(ops[0]!.querySelector(".diff-line-del")).not.toBeNull();
	expect(ops[0]!.textContent).not.toContain("已截断");
	expect(ops[1]!.querySelector("span")!.textContent).toBe("2");
	expect(ops[1]!.textContent).toContain("Fix the parser");
	expect(ops[1]!.textContent).toContain("write");
	expect(ops[1]!.textContent).not.toContain("无法得知被覆盖前的内容");
	expect(ops[1]!.textContent).toContain("已截断");
	expect(ops[1]!.querySelectorAll(".diff-line-add")).toHaveLength(2);
	expect(ops[1]!.querySelector(".diff-line-del")).toBeNull();
	expect(ops[1]!.querySelector(".hljs-keyword")).not.toBeNull();
	// Jump to the current content.
	await click(byText(host, "button", "查看当前内容"));
	expect(tab(host, "文件").getAttribute("aria-selected")).toBe("true");
	expect(calls.file).toEqual(["src/main.ts"]);
	expect(code(host)!.textContent).toContain("return answer;");
	await click(byText(host, "button", "← 文件树"));
	expect(row(host, "src").getAttribute("aria-expanded")).toBe("true");
	expect(rowPaths(host)).toContain("src/main.ts");
	// Back in the changes tab the detail is still there.
	await click(tab(host, "改动"));
	expect(host.querySelector("[data-testid=change-detail]")).not.toBeNull();
	await click(byText(host, "button", "← 改动列表"));
	// Outside entries show their diff but offer no current content.
	await click(host.querySelector('button[data-path="/etc/hosts"]'));
	expect(byText(host, "button", "查看当前内容")).toBeUndefined();
	await flush();
	expect(host.querySelector("[data-testid=change-detail]")!.textContent).toContain("工作区外");
	expect(byText(host, "button", "查看当前内容")).toBeUndefined();
	expect(host.querySelectorAll("[data-testid=change-op]")).toHaveLength(1);
});

it("shows a deleted file as missing when jumping to its current content", async () => {
	handlers.changes = async () => changedFiles;
	handlers.change = async (path) => ({ path, ops: [op(4)], truncated: false });
	connect({ changes: summary(1, 2) });
	const host = await mount();
	await openWorkspace(host);
	await click(tab(host, "改动"));
	await click(host.querySelector('button[data-path="src/main.ts"]'));
	delete files["src/main.ts"];
	try {
		await click(byText(host, "button", "查看当前内容"));
		expect(notice(host)!.textContent).toContain("文件不存在");
		expect(tab(host, "改动 2")).toBeDefined();
	} finally {
		files["src/main.ts"] = text("src/main.ts", TS_SOURCE);
	}
});

it("keeps change errors inline with a retry", async () => {
	let failing = true;
	handlers.changes = async () => {
		if (failing) throw new Error("boom");
		return changedFiles;
	};
	connect({ changes: summary(1, 2) });
	const host = await mount();
	await openWorkspace(host);
	await click(tab(host, "改动"));
	expect(host.querySelector("[role=alert]")!.textContent).toContain("读取改动列表失败：boom");
	failing = false;
	await click(byText(host, "button", "重试"));
	expect(host.querySelector('button[data-path="src/main.ts"]')).not.toBeNull();
	expect(host.querySelector("[role=alert]")).toBeNull();
});

// --------------------------------------------------------- layout & a11y
it("exposes tab semantics, an accessible entry and keyboard-resizable desktop width", async () => {
	connect({ changes: summary(1, 4) });
	const host = await mount();
	const aside = await openWorkspace(host);
	expect(aside.getAttribute("role")).toBe("complementary");
	expect(aside.querySelector("[role=tablist]")!.querySelectorAll("[role=tab]")).toHaveLength(2);
	const filesTab = tab(host, "文件");
	const tabpanel = aside.querySelector("[role=tabpanel]")!;
	expect(filesTab.getAttribute("aria-controls")).toBe(tabpanel.id);
	expect(tabpanel.getAttribute("aria-labelledby")).toBe(filesTab.id);
	await key(filesTab, "ArrowRight");
	expect(tab(host, "改动").getAttribute("aria-selected")).toBe("true");
	expect(tabpanel.getAttribute("aria-labelledby")).toBe(tab(host, "改动").id);
	expect(document.activeElement).toBe(tab(host, "改动"));
	expect(entryButton(host)!.getAttribute("aria-expanded")).toBe("true");
	// Width: bounded, adjustable from the keyboard.
	const separator = aside.querySelector<HTMLElement>("[role=separator]")!;
	const width = () => aside.style.getPropertyValue("--panel-w");
	expect(width()).toBe("560px");
	await key(separator, "ArrowLeft");
	expect(width()).toBe("584px");
	for (let i = 0; i < 20; i++) await key(separator, "ArrowLeft");
	expect(width()).toBe("960px");
	expect(separator.getAttribute("aria-valuenow")).toBe("960");
	for (let i = 0; i < 40; i++) await key(separator, "ArrowRight");
	expect(width()).toBe("320px");
	await key(separator, "End");
	expect(width()).toBe("960px");
	await key(separator, "Home");
	expect(width()).toBe("320px");
	expect(isOpen(aside)).toBe(true);
});

it("is a closable drawer on narrow screens: dialog role, Esc closes, focus returns to the entry", async () => {
	viewportWidth = 375;
	connect({ changes: summary(1, 0) });
	const host = await mount();
	const aside = await openWorkspace(host);
	expect(aside.getAttribute("role")).toBe("dialog");
	expect(aside.getAttribute("aria-modal")).toBe("true");
	expect(aside.className).toContain("fixed inset-0");
	expect(document.activeElement).toBe(aside.querySelector('button[aria-label="关闭工作区栏"]'));
	// Keyboard-only: open a file from the tree, Escape closes the drawer.
	await key(row(host, "README.md"), "Enter");
	expect(code(host)!.textContent).toContain("Hello");
	await key(code(host)!, "Escape");
	expect(isOpen(aside)).toBe(false);
	expect(document.activeElement).toBe(entryButton(host));
	// Everything else became interactive again.
	expect(host.querySelector<HTMLElement>("main")!.inert).not.toBe(true);
});

it("wraps long paths and keeps long lines inside the code container", async () => {
	const longPath = `${"nested-directory-name/".repeat(6)}file-with-a-very-long-name.txt`;
	files[longPath] = text(longPath, `${"x".repeat(600)}\nshort\n`);
	tree[""]!.push(entry(longPath));
	try {
		connect({ changes: summary(1, 0) });
		const host = await mount();
		await openWorkspace(host);
		const longRow = row(host, longPath);
		expect(longRow.title).toBe(longPath);
		expect(longRow.querySelector(".truncate")).not.toBeNull();
		await click(longRow);
		const viewer = host.querySelector("[data-testid=file-viewer]")!;
		expect(viewer.querySelector(`strong[title="${longPath}"]`)!.className).toContain("truncate");
		expect(viewer.querySelector(`span[title="${longPath}"]`)!.className).toContain("break-all");
		expect(code(host)!.textContent).toContain("x".repeat(600));
		expect(code(host)!.className).toContain("overflow-auto");
	} finally {
		tree[""]!.pop();
		delete files[longPath];
	}
});

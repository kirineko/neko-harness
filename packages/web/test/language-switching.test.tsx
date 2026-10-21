import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import type { PlanRecord, QuestionRecord } from "@neko-harness/core/interactions";
import { JSDOM } from "jsdom";
import * as React from "react";
import { chatView, plan, question } from "./support/interaction-fixtures.ts";

const dom = new JSDOM("<!doctype html><html lang='zh-CN'><body></body></html>", { url: "http://localhost/" });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	localStorage: dom.window.localStorage,
	sessionStorage: dom.window.sessionStorage,
	HTMLElement: dom.window.HTMLElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	scrollTo: () => {},
	IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia ??= (() => ({
	matches: false,
	addEventListener() {},
	removeEventListener() {},
})) as unknown as typeof dom.window.matchMedia;

const none = async () => {};
let questionRecord: QuestionRecord = question();
mock.module("../src/client/lib/bootstrap", () => ({
	appActions: {
		submit: none,
		withdraw: async () => ({ result: "unknown" }),
		steer: async () => ({ result: "unknown" }),
		abort: () => {},
		compact: none,
		searchFiles: async () => ({ items: [] }),
		listSkills: async () => [],
		createSession: none,
		configure: none,
		planRespond: async () => plan(),
		planMode: async () => ({}),
		planGet: async () => null,
		questionGet: async () => questionRecord,
		questionRespond: async () => question(),
	},
	reportError: () => {},
}));

const { createRoot } = await import("react-dom/client");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { act } = React;
const { translator } = await import("../src/client/lib/i18n/index.ts");
const { languageStore } = await import("../src/client/lib/language.ts");
const { storeActions } = await import("../src/client/lib/store.ts");
const { Composer } = await import("../src/client/components/composer.tsx");
const { TopBar } = await import("../src/client/components/top-bar.tsx");
const { PlanDock } = await import("../src/client/components/plan-card.tsx");
const { QuestionDock } = await import("../src/client/components/question-card.tsx");
const { TodoPanel } = await import("../src/client/components/todo-panel.tsx");
const { SessionList } = await import("../src/client/components/session-list.tsx");
const { AppearancePanel } = await import("../src/client/components/appearance-panel.tsx");
const { ToolCard } = await import("../src/client/components/tool-card.tsx");

const zh = translator("zh");
const en = translator("en");
const store = languageStore();
const CJK = /[\u3400-\u9fff\uff00-\uffef]/;

const mounted: { unmount(): void }[] = [];
async function mount(element: React.ReactElement) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	mounted.push(root);
	await act(async () => root.render(element));
	return host;
}

/** Text content plus the user-visible attributes, so placeholders and aria labels count as visible text. */
function visible(host: HTMLElement): string {
	const attributes = [...host.querySelectorAll("[placeholder],[aria-label],[title]")].flatMap((node) =>
		["placeholder", "aria-label", "title"].map((name) => node.getAttribute(name) ?? ""),
	);
	return [host.textContent ?? "", ...attributes].join("\n");
}

const switchTo = (language: "zh" | "en") => act(async () => store.set(language));

let sessions = 0;
function connect(view: ReturnType<typeof chatView>, phase: "ready" | "reconnecting" = "ready") {
	act(() => {
		storeActions.setPhase(phase);
		storeActions.setSession(`language-session-${++sessions}`);
		storeActions.setView(view);
	});
}

beforeEach(() => {
	document.body.innerHTML = "";
	act(() => store.reset());
});

afterEach(async () => {
	for (const root of mounted.splice(0)) await act(async () => root.unmount());
	act(() => store.reset());
	dom.window.localStorage.clear();
});

it("composer: placeholder and send button follow the language", async () => {
	connect(chatView({ busy: false }));
	const host = await mount(React.createElement(Composer, { busy: false, status: null }));
	const area = host.querySelector("textarea")!;
	expect(area.getAttribute("placeholder")).toBe(zh("composer.placeholder.idle"));
	expect(host.querySelector(".btn-primary")?.textContent).toBe(zh("composer.send"));
	await switchTo("en");
	expect(area.getAttribute("placeholder")).toBe(en("composer.placeholder.idle"));
	expect(host.querySelector(".btn-primary")?.textContent).toBe(en("composer.send"));
	expect(visible(host)).not.toMatch(CJK);
	await switchTo("zh");
	expect(area.getAttribute("placeholder")).toBe(zh("composer.placeholder.idle"));
});

it("composer: the busy placeholder changes too", async () => {
	connect(chatView({ busy: true, queued: [] }));
	const host = await mount(React.createElement(Composer, { busy: true, status: null }));
	expect(host.querySelector("textarea")?.getAttribute("placeholder")).toBe(zh("composer.placeholder.busy"));
	await switchTo("en");
	expect(host.querySelector("textarea")?.getAttribute("placeholder")).toBe(en("composer.placeholder.busy"));
});

it("top bar: labels follow the language", async () => {
	connect(chatView());
	const host = await mount(
		React.createElement(TopBar, {
			conn: "ready",
			onToggleSessions: () => {},
			todos: { open: false, onToggle: () => {}, panelId: "p" },
		}),
	);
	const before = visible(host);
	expect(before).toMatch(CJK);
	await switchTo("en");
	const after = visible(host);
	expect(after).not.toMatch(CJK);
	expect(after).not.toBe(before);
	await switchTo("zh");
	expect(visible(host)).toBe(before);
});

it("session list: headings, relative time and empty state follow the language", async () => {
	const now = Date.now();
	connect(chatView());
	act(() => {
		storeActions.setWorkspace("/w");
		storeActions.setDirectory([
			{
				id: "a",
				workspaceRoot: "/w",
				title: "我的会话 title",
				firstPromptPreview: "",
				createdAt: now - 10 * 60_000,
				lastUsedAt: now - 5 * 60_000,
				lastMessageAt: now - 5 * 60_000,
				model: null,
				status: "idle",
			},
		]);
	});
	const rootRoute = createRootRoute({
		component: () => React.createElement(SessionList, { open: true, onClose: () => {} }),
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	const host = await mount(React.createElement(RouterProvider, { router }));
	const before = visible(host);
	expect(before).toContain("我的会话 title");
	expect(before).toContain("5 分钟前");
	await switchTo("en");
	const after = visible(host);
	expect(after).not.toBe(before);
	expect(after).toContain("5m");
	expect(after).toContain("我的会话 title");
	expect(after.replaceAll("我的会话 title", "")).not.toMatch(CJK);
	act(() => storeActions.setDirectory([]));
});

it("plan card: labels and buttons follow the language while plan content stays as written", async () => {
	const current: PlanRecord = plan({ title: "新增缓存层", steps: ["读取加载器", "加缓存"], note: "保持接口不变" });
	connect(chatView({ busy: false, plan: { mode: "plan", current } }));
	const host = await mount(React.createElement(PlanDock));
	const card = host.querySelector<HTMLElement>("[data-plan-card]");
	expect(card).not.toBeNull();
	const before = visible(host);
	expect(before).toContain(zh("plan.card.approve"));
	await switchTo("en");
	const after = visible(host);
	expect(after).toContain(en("plan.card.approve"));
	expect(after).not.toContain(zh("plan.card.approve"));
	for (const content of ["新增缓存层", "读取加载器", "保持接口不变"]) expect(after).toContain(content);
	expect(after.replace(/新增缓存层|读取加载器|加缓存|保持接口不变/g, "")).not.toMatch(CJK);
});

it("question card: labels follow the language while question and options stay as written", async () => {
	const record: QuestionRecord = question({
		question: "用哪个数据库？",
		options: [
			{ id: "pg", label: "Postgres", recommended: true },
			{ id: "sqlite", label: "SQLite", description: "内嵌，零配置" },
		],
	});
	questionRecord = record;
	connect(chatView({ busy: false, questions: [record] }));
	const host = await mount(React.createElement(QuestionDock));
	const before = visible(host);
	expect(before).toContain("用哪个数据库？");
	await switchTo("en");
	const after = visible(host);
	expect(after).not.toBe(before);
	expect(after).toContain("用哪个数据库？");
	expect(after).toContain("内嵌，零配置");
	expect(after.replace(/用哪个数据库？|内嵌，零配置/g, "")).not.toMatch(CJK);
});

it("todo panel: title and status labels follow the language while todo text stays as written", async () => {
	connect(
		chatView({
			todos: {
				revision: 1,
				items: [
					{ id: "a", text: "写计划", status: "completed" },
					{ id: "b", text: "实现面板", status: "in_progress" },
					{ id: "c", text: "发布", status: "pending" },
				],
			},
		}),
	);
	const host = await mount(React.createElement(TodoPanel, { id: "todo", onClose: () => {} }));
	const before = visible(host);
	await switchTo("en");
	const after = visible(host);
	expect(after).not.toBe(before);
	expect(after).toContain("实现面板");
	expect(after.replace(/写计划|实现面板|发布/g, "")).not.toMatch(CJK);
});

it("appearance settings: the panel is translated", async () => {
	const host = await mount(React.createElement(AppearancePanel));
	const before = visible(host);
	expect(before).toMatch(CJK);
	await switchTo("en");
	expect(visible(host)).not.toMatch(CJK);
	expect(visible(host)).toContain(en("appearance.reset"));
});

it("tool card: status and note follow the language, summary and output are untouched", async () => {
	const props = {
		name: "bash",
		summary: "echo 你好",
		detail: "echo 你好",
		phase: "done" as const,
		isError: true,
		output: "输出 output",
		note: "Not run: response interrupted.",
	};
	const host = await mount(React.createElement(ToolCard, props));
	await act(async () => host.querySelector<HTMLElement>("[aria-expanded]")?.click());
	const before = visible(host);
	expect(before).toContain(zh("core.note.notRun"));
	await switchTo("en");
	const after = visible(host);
	expect(after).toContain(en("core.note.notRun"));
	expect(after).not.toBe(before);
	expect(after).toContain("echo 你好");
});

import "./support/lang-en.ts";
import { afterEach, expect, it } from "bun:test";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import type { ChatView, Delegation, ToolApproval } from "@neko-harness/core";
import type { NekoGatewayConnection } from "@neko-harness/gateway/client-session";
import type { WireQuestionRecord, WireQueuedInput } from "@neko-harness/gateway/contract";
import { ApprovalDock } from "../src/approval-dock.ts";
import { BoundedEditor } from "../src/components/editor.ts";
import { StatusFooter } from "../src/components/footer.ts";
import { PickerPanel } from "../src/components/picker.ts";
import { helpLines } from "../src/help-ui.ts";
import { getLanguage, type Language, onLanguageChange, setLanguage } from "../src/i18n/index.ts";
import { commands } from "../src/labels.ts";
import { languageItems, openLanguagePanel } from "../src/language-ui.ts";
import { QUESTION_MAX_ROWS, QuestionDock } from "../src/question-dock.ts";
import { QueueRow } from "../src/queue-ui.ts";
import { getEditorTheme } from "../src/theme/index.ts";
import { sessionStatusText } from "../src/workspace.ts";

afterEach(() => setLanguage("en"));

const plain = (lines: readonly string[]) => lines.map(stripTerminalSequences).join("\n");
const tick = async () => {
	for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};
const ENTER = "\r";
const DOWN = "\x1b[B";
const TAB = "\t";

it("marks the current language in the panel and never translates the language names", () => {
	for (const language of ["zh", "en"] as const) {
		setLanguage(language);
		const items = languageItems();
		expect(items.map((item) => item.value)).toEqual(["zh", "en"]);
		expect(items.find((item) => item.value === language)?.label).toEndWith(
			language === "zh" ? "（当前）" : "(Current)",
		);
		expect(items.find((item) => item.value !== language)?.label).toBeOneOf(["中文", "English"]);
	}
	expect(languageItems("en").map((item) => item.label)).toEqual(["中文", "English (Current)"]);
});

it("chooses a language from the shared picker panel, closes it and switches at once", async () => {
	const changes: Language[] = [];
	const stop = onLanguageChange((language) => changes.push(language));
	let closed = 0;
	const panel = new PickerPanel(
		() => {},
		() => closed++,
	);
	const chosen: Language[] = [];
	const shown = openLanguagePanel(panel, (language) => {
		chosen.push(language);
		setLanguage(language);
	});
	await shown;
	const first = plain(panel.render(60));
	expect(first).toContain("Interface language");
	expect(first).toContain("English (Current)");
	panel.handleInput(ENTER);
	await tick();
	expect(chosen).toEqual(["zh"]);
	expect(panel.open).toBe(false);
	expect(closed).toBe(1);
	expect(getLanguage()).toBe("zh");

	await openLanguagePanel(panel, setLanguage);
	const second = plain(panel.render(60));
	expect(second).toContain("界面语言");
	expect(second).toContain("中文（当前）");
	panel.handleInput(DOWN);
	panel.handleInput(ENTER);
	await tick();
	expect(getLanguage()).toBe("en");
	expect(changes).toEqual(["zh", "en"]);
	stop();
	setLanguage("zh");
	expect(changes).toEqual(["zh", "en"]);
});

it("lists /language in completion and help in both languages with the command name untouched", () => {
	for (const language of ["zh", "en"] as const) {
		setLanguage(language);
		const command = commands().find((item) => item.name === "language");
		expect(command?.description).toContain("zh/en");
		expect(plain(helpLines("darwin"))).toContain("/language");
	}
	setLanguage("zh");
	expect(plain(helpLines("darwin"))).toContain("选择界面语言");
	setLanguage("en");
	expect(plain(helpLines("darwin"))).toContain("Choose the interface language");
});

it("keeps the draft, the queue selection and the busy state while the footer and queue follow the language", () => {
	const editor = new BoundedEditor(
		{ requestRender() {}, terminal: { rows: 24, columns: 80 } } as never,
		getEditorTheme(),
	);
	editor.setText("keep this draft\nsecond line");
	const queue = new QueueRow();
	const items: WireQueuedInput[] = [
		{ id: 1, mode: "followUp", preview: "first", images: 0 },
		{ id: 2, mode: "steer", preview: "", images: 2 },
	];
	queue.setItems(items);
	expect(queue.select()).toBe(true);
	const footer = new StatusFooter();
	footer.setStats({
		cwd: "/work",
		model: "deepseek/deepseek-flash",
		thinkingLevel: "high",
		busy: "Running bash...",
		usageText: "",
	});

	const before = plain(footer.render(100)) + plain(queue.render(100));
	expect(before).toContain("Enter Queue · Esc Stop");
	expect(before).toContain("Steer");
	expect(before).toContain("[2 images]");

	setLanguage("zh");
	const after = plain(footer.render(100)) + plain(queue.render(100));
	expect(after).toContain("Esc 停止");
	expect(after).toContain("引导");
	expect(after).toContain("[2 张图片]");
	expect(after).not.toContain("Esc Stop");
	expect(editor.getText()).toBe("keep this draft\nsecond line");
	expect(queue.selecting).toBe(true);
	expect(queue.current?.id).toBe(2);
});

it("shows the footer status words in the current language", () => {
	const footer = new StatusFooter();
	const stats = { cwd: "/work", model: "deepseek/deepseek-flash", thinkingLevel: null, usageText: "" };
	footer.setStats({ ...stats, busy: undefined });
	expect(plain(footer.render(100))).toContain("Ready");
	setLanguage("zh");
	expect(plain(footer.render(100))).toContain("就绪");
	footer.setStats({ ...stats, busy: undefined, planMode: true, questionCount: 2 });
	const zh = plain(footer.render(120));
	expect(zh).toContain("计划");
	expect(zh).toContain("2 个提问等待回答");
});

it("keeps what the user typed in the question note and answer fields when the language changes", async () => {
	const record: WireQuestionRecord = {
		id: 1,
		callId: "c",
		version: "v1",
		question: "Which database?",
		multiple: false,
		options: [
			{ id: "pg", label: "Postgres", recommended: true },
			{ id: "sqlite", label: "SQLite" },
		],
		status: "pending",
		answer: null,
		createdAt: 1,
		settledAt: null,
	};
	const dock = new QuestionDock({
		changed: () => {},
		notify: () => {},
		opened: () => {},
		aside: () => undefined,
		now: () => 1000,
	});
	dock.height = QUESTION_MAX_ROWS;
	dock.bind("s1", {
		supported: true,
		revision: 1,
		pending: () => [],
		get: async () => record,
		respond: async () => record,
	});
	dock.update({
		revision: 1,
		pending: [{ id: 1, version: "v1", preview: "Which", multiple: false, optionCount: 2, createdAt: 1 }],
	});
	expect(dock.openPanel()).toBe(true);
	await tick();
	dock.handleInput(TAB);
	for (const char of "my note") dock.handleInput(char);
	const english = plain(dock.render(80));
	expect(english).toContain("Assistant question");
	expect(english).toContain("my note");

	setLanguage("zh");
	const chinese = plain(dock.render(80));
	expect(chinese).toContain("助手提问");
	expect(chinese).toContain("跳过此问题");
	expect(chinese).toContain("my note");
	expect(chinese).not.toContain("Skip this question");

	dock.handleInput("\u007f");
	setLanguage("en");
	expect(plain(dock.render(80))).toContain("my not");
});

it("keeps the approval choice and the pending request while the dock follows the language", async () => {
	const item: ToolApproval = {
		id: 3,
		version: "v",
		childId: 2,
		delegationTaskId: 1,
		callId: "bash",
		command: "git status --short",
		cwd: "/work",
		timeout: null,
		status: "pending",
		createdAt: 0,
		decidedAt: null,
	};
	const decisions: string[] = [];
	const value = { approvals: [item] } as ChatView;
	const service = {
		view: {
			get value() {
				return value;
			},
			subscribe(fn: (view: ChatView) => void) {
				fn(value);
				return () => {};
			},
		},
		decideApproval: async ({ decision }: { decision: ToolApproval["status"] }) => {
			decisions.push(decision);
			return decision;
		},
	} as unknown as ReturnType<NekoGatewayConnection["subagent"]>;
	const dock = new ApprovalDock(
		() => service,
		() => {},
	);
	dock.update([{ taskId: 1, title: "Inspect", approvalCount: 1 }] as Delegation[]);
	dock.handleInput(DOWN);
	expect(plain(dock.render(80))).toContain("Deny");

	setLanguage("zh");
	const zh = plain(dock.render(80));
	expect(zh).toContain("拒绝");
	expect(zh).toContain("允许一次");
	expect(zh).toContain("git status --short");
	dock.handleInput(ENTER);
	await tick();
	expect(decisions).toEqual(["denied"]);
});

it("renders session status words and plain Text components in the current language", () => {
	expect(sessionStatusText({ status: "running" })).toBe("Running");
	setLanguage("zh");
	expect(sessionStatusText({ status: "running" })).toBe("运行中");
	expect(sessionStatusText({ status: "idle", awaitingPlan: true })).toBe("等待批准");
	expect(new Text("x").render(5).length).toBeGreaterThan(0);
});

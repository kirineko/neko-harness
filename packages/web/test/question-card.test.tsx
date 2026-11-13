import type { QuestionRecord } from "@neko-harness/core/interactions";
import { JSDOM } from "jsdom";
import * as React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chatView, question } from "./support/interaction-fixtures.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
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

type Respond = { id: number; version: string; response: unknown };
const gets: [string, number][] = [];
const responds: [string, Respond][] = [];
const submits: unknown[][] = [];
let getImpl: (sessionId: string, id: number) => Promise<QuestionRecord | null>;
let respondImpl: (sessionId: string, input: Respond) => Promise<QuestionRecord>;
vi.doMock("../src/client/lib/bootstrap", () => ({
	appActions: {
		submit: async (...args: unknown[]) => void submits.push(args),
		questionGet: (sessionId: string, id: number) => {
			gets.push([sessionId, id]);
			return getImpl(sessionId, id);
		},
		questionRespond: (sessionId: string, input: Respond) => {
			responds.push([sessionId, input]);
			return respondImpl(sessionId, input);
		},
		withdraw: async () => ({ result: "unknown" }),
		steer: async () => ({ result: "unknown" }),
		abort: () => {},
		compact: async () => {},
		searchFiles: async () => ({ items: [] }),
		listSkills: async () => [],
		createSession: async () => {},
		configure: async () => {},
	},
	reportError: () => {},
}));

const { createRoot } = await import("react-dom/client");
const { act } = React;
const { QuestionDock } = await import("../src/client/components/question-card.tsx");
const { Composer } = await import("../src/client/components/composer.tsx");
const { questionKey, questionUi } = await import("../src/client/lib/question-ui.ts");
const { storeActions } = await import("../src/client/lib/store.ts");

let sessions = 0;
let current = "";
let records = new Map<number, QuestionRecord>();
const settled = (
	over: Partial<QuestionRecord> & Pick<QuestionRecord, "status">,
	base = question(),
): QuestionRecord => ({
	...base,
	settledAt: 2000,
	...over,
});

/** Show `list` as the pending questions of a fresh session. */
function connect(list: readonly QuestionRecord[], extra: Parameters<typeof chatView>[0] = {}) {
	current = `question-session-${++sessions}`;
	records = new Map(list.map((record) => [record.id, record]));
	act(() => {
		storeActions.setPhase("ready");
		storeActions.setSession(current);
		storeActions.setView(chatView({ questions: list, ...extra }));
	});
	return current;
}
const pendingView = (list: readonly QuestionRecord[], extra: Parameters<typeof chatView>[0] = {}) =>
	chatView({ questions: list, ...extra });

const mounted: { unmount(): void }[] = [];
async function mountAll() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	mounted.push(root);
	await act(async () =>
		root.render(
			React.createElement(
				React.Fragment,
				null,
				React.createElement(QuestionDock),
				React.createElement(Composer, { busy: true, status: null }),
			),
		),
	);
	await flush();
	return host;
}
const flush = async () => {
	for (let i = 0; i < 3; i++) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
};
const card = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-question-card]");
const button = (host: ParentNode, label: string) =>
	[...host.querySelectorAll("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label)!;
const option = (host: ParentNode, label: string) =>
	[...host.querySelectorAll<HTMLInputElement>("input[type=radio], input[type=checkbox]")].find((input) =>
		input.labels?.[0]?.textContent?.startsWith(label),
	)!;
const answerArea = (host: ParentNode) => host.querySelector<HTMLTextAreaElement>("[data-question-body] textarea")!;
const composerArea = (host: ParentNode) => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息输入"]')!;
const click = (el: Element) => act(async () => void (el as HTMLElement).click());
const type = async (area: HTMLTextAreaElement, text: string) => {
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
		setter.call(area, text);
		area.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
};
const notice = (host: ParentNode) => host.querySelector("[data-question-notice]");

beforeEach(() => {
	document.body.innerHTML = "";
	gets.length = 0;
	responds.length = 0;
	submits.length = 0;
	questionUi.reset();
	getImpl = async (_session, id) => records.get(id) ?? null;
	respondImpl = async (_session, input) => {
		const record = records.get(input.id)!;
		const response = input.response as { kind: string; optionIds?: string[]; text?: string };
		return response.kind === "skip"
			? { ...record, status: "skipped", settledAt: 2000 }
			: {
					...record,
					status: "answered",
					answer: { optionIds: response.optionIds ?? [], text: response.text ?? null },
					settledAt: 2000,
				};
	};
});
afterEach(async () => {
	await act(async () => {
		for (const root of mounted.splice(0)) root.unmount();
	});
	storeActions.setView(null);
	storeActions.setSession(null);
	document.title = "";
});

it("opens a new question when the composer is idle, without moving focus or preselecting anything", async () => {
	const sid = connect([question()]);
	const host = await mountAll();
	const c = card(host)!;
	expect(c.getAttribute("aria-label")).toBe("助手提问");
	expect(c.dataset.open).toBe("true");
	expect(c.textContent).toContain("助手提问");
	expect(c.textContent).toContain("等待回答");
	expect(gets).toEqual([[sid, 7]]);
	expect(c.contains(document.activeElement)).toBe(false);

	const radios = [...c.querySelectorAll<HTMLInputElement>("input[type=radio]")];
	expect(radios.map((r) => r.checked)).toEqual([false, false]);
	expect(c.querySelector("[data-recommended]")!.textContent).toContain("推荐");
	expect(c.querySelector("[data-recommended]")!.textContent).toContain("Postgres");
	expect(c.querySelector("[data-option-id=sqlite]")!.hasAttribute("data-recommended")).toBe(false);
	expect(button(c, "提交回答").disabled).toBe(true);
	expect(button(c, "跳过").disabled).toBe(false);
	expect(answerArea(c).value).toBe("");
	expect(responds).toHaveLength(0);
});

it("renders the question, labels and descriptions as plain text only", async () => {
	const nasty =
		"**bold** <script>alert(1)</script> [link](http://evil.example) ![img](http://evil.example/a.png)\nsecond line";
	connect([
		question({
			question: nasty,
			options: [
				{ id: "a", label: "<b>x</b> `code`", description: "<img src=x onerror=alert(1)> [d](http://e.example)" },
				{ id: "b", label: "plain" },
			],
		}),
	]);
	const host = await mountAll();
	const c = card(host)!;
	const text = c.querySelector<HTMLElement>("[data-question-text]")!;
	expect(text.textContent).toBe(nasty);
	expect(text.className).toContain("whitespace-pre-wrap");
	expect(c.querySelector("script, a, img, strong, b, code, em")).toBeNull();
	expect(c.textContent).toContain("<b>x</b> `code`");
	expect(c.textContent).toContain("<img src=x onerror=alert(1)> [d](http://e.example)");
});

it("never submits on selection or fold, keeps the chat draft, and answers only through the explicit button", async () => {
	const sid = connect([question()]);
	const host = await mountAll();
	await type(composerArea(host), "my chat draft");
	const c = card(host)!;

	await click(option(c, "SQLite"));
	expect(option(c, "SQLite").checked).toBe(true);
	expect(option(c, "Postgres").checked).toBe(false);
	await click(option(c, "Postgres"));
	expect(option(c, "Postgres").checked).toBe(true);
	expect(option(c, "SQLite").checked).toBe(false);
	expect(responds).toHaveLength(0);
	expect(composerArea(host).value).toBe("my chat draft");

	// Closing is only folding: nothing is skipped or answered and the draft survives the round trip.
	await click(button(c, "折叠提问（不会跳过）"));
	expect(card(host)!.dataset.open).toBe("false");
	expect(host.querySelector("[data-question-body]")).toBeNull();
	expect(card(host)!.textContent).toContain("等待回答");
	expect(card(host)!.textContent).toContain("Which database should we use?");
	expect(card(host)!.textContent).toContain("草稿已保留");
	expect(responds).toHaveLength(0);
	await click(button(card(host)!, "展开提问"));
	expect(option(card(host)!, "Postgres").checked).toBe(true);

	await type(answerArea(card(host)!), "because it scales");
	expect(composerArea(host).value).toBe("my chat draft");
	await click(button(card(host)!, "提交回答"));
	expect(responds).toEqual([
		[sid, { id: 7, version: "v1", response: { kind: "answer", optionIds: ["pg"], text: "because it scales" } }],
	]);
	// Answering is not a chat message and leaves the composer alone.
	expect(submits).toHaveLength(0);
	expect(composerArea(host).value).toBe("my chat draft");
	expect(card(host)).toBeNull();
	expect(notice(host)!.textContent).toContain("已回答：Postgres, because it scales");
});

it("skips only through its own control", async () => {
	const sid = connect([question()]);
	const host = await mountAll();
	await click(button(card(host)!, "折叠提问（不会跳过）"));
	await click(button(card(host)!, "展开提问"));
	expect(responds).toHaveLength(0);
	await click(button(card(host)!, "跳过"));
	expect(responds).toEqual([[sid, { id: 7, version: "v1", response: { kind: "skip" } }]]);
	expect(notice(host)!.textContent).toContain("已跳过");
	expect(submits).toHaveLength(0);
});

it("prevents double submits and disables everything while a decision is in flight", async () => {
	connect([question()]);
	let release!: (record: QuestionRecord) => void;
	respondImpl = () =>
		new Promise((resolve) => {
			release = resolve;
		});
	const host = await mountAll();
	const c = card(host)!;
	await click(option(c, "SQLite"));
	const submit = button(c, "提交回答");
	await click(submit);
	expect(responds).toHaveLength(1);
	expect(submit.textContent).toBe("提交中…");
	expect(submit.disabled).toBe(true);
	expect(button(c, "跳过").disabled).toBe(true);
	expect(answerArea(c).disabled).toBe(true);
	expect(option(c, "Postgres").disabled).toBe(true);
	await click(submit);
	await click(button(c, "跳过"));
	expect(responds).toHaveLength(1);
	await act(async () => release(settled({ status: "answered", answer: { optionIds: ["sqlite"], text: null } })));
	await flush();
	expect(responds).toHaveLength(1);
	expect(card(host)).toBeNull();
	expect(notice(host)!.textContent).toContain("已回答：SQLite");
});

it("keeps the answer and shows the error when saving fails, then lets the user retry", async () => {
	connect([question()]);
	respondImpl = async () => {
		throw new Error("版本不匹配");
	};
	const host = await mountAll();
	const c = card(host)!;
	await click(option(c, "SQLite"));
	await type(answerArea(c), "details");
	await click(button(c, "提交回答"));
	const alert = c.querySelector("[role=alert]")!;
	expect(alert.textContent).toContain("版本不匹配");
	expect(alert.textContent).toContain("草稿已保留");
	expect(option(c, "SQLite").checked).toBe(true);
	expect(answerArea(c).value).toBe("details");
	expect(button(c, "提交回答").disabled).toBe(false);
	expect(card(host)).not.toBeNull();

	respondImpl = async (_session, input) =>
		settled({
			status: "answered",
			answer: { optionIds: (input.response as { optionIds: string[] }).optionIds, text: "details" },
		});
	await click(button(c, "提交回答"));
	expect(responds).toHaveLength(2);
	expect(card(host)).toBeNull();
});

it("disables the controls offline, keeps the draft and never resends after reconnecting", async () => {
	connect([question()]);
	const host = await mountAll();
	const c = card(host)!;
	await click(option(c, "SQLite"));
	await type(answerArea(c), "unsent");

	await act(async () => {
		storeActions.setPhase("reconnecting");
		storeActions.setView(null);
	});
	const offline = card(host)!;
	expect(offline.textContent).toContain("离线");
	expect(button(offline, "提交回答").disabled).toBe(true);
	expect(button(offline, "跳过").disabled).toBe(true);
	expect(answerArea(offline).disabled).toBe(true);
	expect(option(offline, "Postgres").disabled).toBe(true);
	await click(button(offline, "提交回答"));
	expect(responds).toHaveLength(0);

	await act(async () => {
		storeActions.setPhase("ready");
		storeActions.setView(pendingView([question()]));
	});
	await flush();
	const back = card(host)!;
	expect(responds).toHaveLength(0);
	expect(option(back, "SQLite").checked).toBe(true);
	expect(answerArea(back).value).toBe("unsent");
	expect(button(back, "提交回答").disabled).toBe(false);
	expect(notice(host)).toBeNull();
});

it("shows the real winner when another client settled the question, and removes the controls", async () => {
	connect([question()]);
	const host = await mountAll();
	await click(option(card(host)!, "SQLite"));
	getImpl = async () => settled({ status: "answered", answer: { optionIds: ["pg"], text: "fast" } });
	await act(async () => storeActions.setView(pendingView([])));
	await flush();
	expect(card(host)).toBeNull();
	expect(host.querySelector("input[type=radio], [data-question-body]")).toBeNull();
	expect(notice(host)!.textContent).toContain("其他端");
	expect(notice(host)!.textContent).toContain("已回答：Postgres, fast");
	expect(responds).toHaveLength(0);
	expect(questionUi.draft(questionKey(current, 7, "v1"))).toEqual({ optionIds: [], text: "" });
	await click(button(notice(host)!, "关闭结果提示"));
	expect(notice(host)).toBeNull();
});

it("reports cancellation and a missing record when the question leaves the list", async () => {
	connect([question()]);
	const host = await mountAll();
	getImpl = async () => settled({ status: "cancelled" });
	await act(async () => storeActions.setView(pendingView([])));
	await flush();
	expect(notice(host)!.textContent).toContain("已取消");

	getImpl = async (_session, id) => records.get(id) ?? null;
	connect([question({ id: 8, version: "v1" })]);
	await act(async () => {});
	await flush();
	getImpl = async () => {
		throw new Error("gone");
	};
	await act(async () => storeActions.setView(pendingView([])));
	await flush();
	expect(notice(host)!.textContent).toContain("已不在等待列表中");
});

it("shows the saved result, not the local choice, when another decision won the race", async () => {
	connect([question()]);
	respondImpl = async () => settled({ status: "skipped" });
	const host = await mountAll();
	await click(option(card(host)!, "SQLite"));
	await click(button(card(host)!, "提交回答"));
	expect(card(host)).toBeNull();
	expect(notice(host)!.textContent).toContain("其他端先处理");
	expect(notice(host)!.textContent).toContain("已跳过");
	expect(notice(host)!.textContent).not.toContain("SQLite");

	connect([question({ id: 9, version: "v9" })]);
	respondImpl = async () => settled({ status: "cancelled", id: 9, version: "v9" });
	const second = await mountAll();
	await click(button(card(second)!, "跳过"));
	expect(notice(second)!.textContent).toContain("已取消");
	expect(notice(second)!.textContent).toContain("没有保存新的回答");
});

it("hands focus back to the composer when the focused card disappears", async () => {
	connect([question()]);
	const host = await mountAll();
	option(card(host)!, "SQLite").focus();
	expect(card(host)!.contains(document.activeElement)).toBe(true);
	getImpl = async () => settled({ status: "skipped" });
	await act(async () => storeActions.setView(pendingView([])));
	await flush();
	expect(card(host)).toBeNull();
	expect(document.activeElement).toBe(composerArea(host));
});

it("isolates drafts by session, question and version and keeps them while the card is gone", async () => {
	const s1 = connect([question()]);
	const host = await mountAll();
	await click(option(card(host)!, "SQLite"));
	await type(answerArea(card(host)!), "for s1");

	// Same question id and version in another session starts empty.
	connect([question()]);
	await flush();
	expect(option(card(host)!, "SQLite").checked).toBe(false);
	expect(answerArea(card(host)!).value).toBe("");

	// A different version of the same id is a different question.
	await act(async () => {
		records.set(7, question({ version: "v2" }));
		storeActions.setView(pendingView([question({ version: "v2" })]));
	});
	await flush();
	expect(option(card(host)!, "SQLite").checked).toBe(false);

	// Back to the first session: the draft is still there.
	await act(async () => {
		storeActions.setSession(s1);
		storeActions.setView(pendingView([question()]));
	});
	records.set(7, question());
	await flush();
	expect(option(card(host)!, "SQLite").checked).toBe(true);
	expect(answerArea(card(host)!).value).toBe("for s1");
	expect(responds).toHaveLength(0);
});

it("answers a free-form question with text only and ignores blank text", async () => {
	const sid = connect([question({ options: [], question: "What should the project be called?" })]);
	const host = await mountAll();
	const c = card(host)!;
	expect(c.querySelector("fieldset")).toBeNull();
	expect(answerArea(c).labels?.[0]?.textContent).toBe("你的回答");
	expect(button(c, "提交回答").disabled).toBe(true);
	await type(answerArea(c), "   \n ");
	expect(button(c, "提交回答").disabled).toBe(true);
	await type(answerArea(c), "neko");
	expect(button(c, "提交回答").disabled).toBe(false);
	await click(button(c, "提交回答"));
	expect(responds).toEqual([[sid, { id: 7, version: "v1", response: { kind: "answer", text: "neko" } }]]);
});

it("offers checkboxes for multiple choice and submits every selected option", async () => {
	const multiple = question({
		multiple: true,
		options: [
			{ id: "a", label: "Alpha" },
			{ id: "b", label: "Beta", recommended: true },
			{ id: "c", label: "Gamma" },
		],
	});
	connect([multiple]);
	const host = await mountAll();
	const c = card(host)!;
	expect(c.querySelector("legend")!.textContent).toBe("选择一个或多个选项");
	expect(c.querySelectorAll("input[type=checkbox]")).toHaveLength(3);
	expect(c.querySelector("input[type=radio]")).toBeNull();
	expect([...c.querySelectorAll<HTMLInputElement>("input")].some((i) => i.checked)).toBe(false);
	await click(option(c, "Gamma"));
	await click(option(c, "Alpha"));
	await click(option(c, "Gamma"));
	await click(option(c, "Beta"));
	await click(button(c, "提交回答"));
	const response = responds[0]![1].response as { optionIds: string[] };
	expect([...response.optionIds].sort()).toEqual(["a", "b"]);
});

it("lets a single choice be cleared again without submitting", async () => {
	connect([question()]);
	const host = await mountAll();
	const c = card(host)!;
	await click(option(c, "Postgres"));
	expect(button(c, "提交回答").disabled).toBe(false);
	await click(button(c, "清除选择"));
	expect(option(c, "Postgres").checked).toBe(false);
	expect(button(c, "提交回答").disabled).toBe(true);
	expect(responds).toHaveLength(0);
});

it("names every control, groups the options and keeps all of them keyboard reachable", async () => {
	connect([question()]);
	const host = await mountAll();
	const c = card(host)!;
	const group = c.querySelector("fieldset")!;
	expect(group.querySelector("legend")!.textContent).toBe("选择一个选项");
	const postgres = option(c, "Postgres");
	expect(postgres.labels![0]!.textContent).toBe("Postgres 推荐");
	const sqlite = option(c, "SQLite");
	expect(sqlite.labels![0]!.textContent).toBe("SQLite");
	expect(document.getElementById(sqlite.getAttribute("aria-describedby")!)!.textContent).toBe("Embedded, zero setup");
	expect(postgres.name).toBe(sqlite.name);
	expect(answerArea(c).labels![0]!.textContent).toBe("补充说明（可选）");
	const toggle = button(c, "折叠提问（不会跳过）");
	expect(toggle.getAttribute("aria-expanded")).toBe("true");
	expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBe(
		host.querySelector("[data-question-body]"),
	);

	const order = [...c.querySelectorAll<HTMLElement>("button, input, textarea")];
	expect(
		order.map((el) => el.tagName.toLowerCase() + (el.getAttribute("type") ? `:${el.getAttribute("type")}` : "")),
	).toEqual(["button:button", "input:radio", "input:radio", "textarea", "button:button", "button:button"]);
	expect(order.map((el) => el.textContent || el.getAttribute("aria-label")).slice(4)).toEqual(["提交回答", "跳过"]);
	for (const el of order.filter((candidate) => !(candidate as HTMLButtonElement).disabled)) {
		expect(el.getAttribute("tabindex")).toBeNull();
		el.focus();
		expect(document.activeElement).toBe(el);
	}
	// Submit and skip are separate controls from the fold toggle.
	expect(new Set([toggle, button(c, "提交回答"), button(c, "跳过")]).size).toBe(3);
});

it("reads the full question on demand and recovers from a failed read", async () => {
	const long = question({ question: `${"Long question text. ".repeat(40)}END` });
	let release!: (record: QuestionRecord | null) => void;
	connect([long]);
	getImpl = () =>
		new Promise((resolve) => {
			release = resolve;
		});
	const host = await mountAll();
	let c = card(host)!;
	expect(gets).toHaveLength(1);
	expect(c.textContent).toContain("正在读取完整问题");
	expect(c.textContent).not.toContain("END");
	expect(c.querySelector("input")).toBeNull();
	expect(button(c, "提交回答").disabled).toBe(true);
	expect(button(c, "跳过").disabled).toBe(true);
	await act(async () => release(long));
	await flush();
	c = card(host)!;
	expect(c.querySelector("[data-question-text]")!.textContent).toBe(long.question);
	expect(c.textContent).toContain("END");

	getImpl = async () => {
		throw new Error("boom");
	};
	connect([question({ id: 11 })]);
	await flush();
	c = card(host)!;
	expect(c.querySelector("[role=alert]")!.textContent).toContain("boom");
	getImpl = async (_s, id) => records.get(id) ?? null;
	await click(button(c, "重试"));
	await flush();
	expect(option(card(host)!, "Postgres")).toBeDefined();
});

it("retries a failed read by itself once the connection is back, but never submits anything", async () => {
	connect([question()]);
	getImpl = async () => {
		throw new Error("offline");
	};
	const host = await mountAll();
	expect(card(host)!.querySelector("[role=alert]")).not.toBeNull();
	await act(async () => {
		storeActions.setPhase("reconnecting");
		storeActions.setView(null);
	});
	expect(card(host)!.textContent).toContain("离线");
	getImpl = async (_s, id) => records.get(id) ?? null;
	await act(async () => {
		storeActions.setPhase("ready");
		storeActions.setView(pendingView([question()]));
	});
	await flush();
	expect(option(card(host)!, "Postgres")).toBeDefined();
	expect(responds).toHaveLength(0);
});

it("auto-presents once, only when nothing else is being edited, and never again after a fold", async () => {
	// A typed chat draft keeps the card folded as a prompt bar.
	const idle = connect([]);
	const host = await mountAll();
	await type(composerArea(host), "typing something");
	await act(async () => storeActions.setView(pendingView([question()])));
	await flush();
	expect(card(host)!.dataset.open).toBe("false");
	expect(host.querySelector("[data-question-body]")).toBeNull();
	expect(gets).toHaveLength(0);
	expect(composerArea(host).value).toBe("typing something");
	expect(card(host)!.textContent).toContain("等待回答");
	// A later update of the same question does not open it.
	await act(async () => {
		storeActions.setView(pendingView([question()]));
		storeActions.setSession(idle);
	});
	expect(card(host)!.dataset.open).toBe("false");

	// Explicitly folding an auto-opened card keeps it folded across updates.
	connect([question({ id: 21 })]);
	await flush();
	expect(card(host)!.dataset.open).toBe("true");
	await click(button(card(host)!, "折叠提问（不会跳过）"));
	await act(async () => storeActions.setView(pendingView([question({ id: 21 })], { busy: true })));
	await flush();
	expect(card(host)!.dataset.open).toBe("false");
});

it("stays a prompt bar while a Bash approval or another dialog holds attention", async () => {
	connect([question({ id: 31 })], {
		subagents: [{ taskId: 3, agentId: "agent-3", title: "child", approvalCount: 1 }] as never,
	});
	const approval = await mountAll();
	expect(card(approval)!.dataset.open).toBe("false");

	document.body.innerHTML = "";
	const dialog = document.createElement("dialog");
	dialog.setAttribute("open", "");
	document.body.append(dialog);
	connect([question({ id: 32 })]);
	const host = await mountAll();
	expect(card(host)!.dataset.open).toBe("false");
});

it("opens from the composer hint, focuses the recommended option, and sending still queues normally", async () => {
	const sid = connect([question()]);
	const host = await mountAll();
	await type(composerArea(host), "please continue");
	await act(async () => storeActions.setView(pendingView([question({ id: 7 })])));
	const hint = host.querySelector("[data-question-hint]")!;
	expect(hint.textContent).toContain("助手正在等待你的回答");
	expect(hint.textContent).toContain("排队");
	expect(hint.textContent).toContain("回答或跳过后");
	expect(composerArea(host).getAttribute("placeholder")).toContain("排队");

	// Sending goes through the normal queued path and is not an answer.
	const send = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "排队")!;
	await click(send);
	expect(submits.map((args) => args[0])).toEqual(["please continue"]);
	expect(responds).toHaveLength(0);
	expect(card(host)).not.toBeNull();

	await click(card(host)!.querySelector("button[aria-expanded]")!);
	await click(card(host)!.querySelector("button[aria-expanded]")!);
	await click(button(hint, "打开问题"));
	await flush();
	expect(card(host)!.dataset.open).toBe("true");
	expect(document.activeElement).toBe(option(card(host)!, "Postgres"));
	expect(option(card(host)!, "Postgres").checked).toBe(false);
	expect(composerArea(host).value).toBe("");
	expect(sid).toBe(current);
});

it("shows no hint and no card on a gateway without questions or with none pending", async () => {
	connect([]);
	const empty = await mountAll();
	expect(card(empty)).toBeNull();
	expect(empty.querySelector("[data-question-hint]")).toBeNull();
	expect(composerArea(empty).getAttribute("placeholder")).not.toContain("等待你的回答");

	document.body.innerHTML = "";
	current = `question-session-${++sessions}`;
	act(() => {
		storeActions.setSession(current);
		storeActions.setView(chatView({ questions: null }));
	});
	const old = await mountAll();
	expect(card(old)).toBeNull();
	expect(old.querySelector("[data-question-hint]")).toBeNull();
	expect(gets).toHaveLength(0);
});

it("shows one card at a time and lets the user switch between several questions", async () => {
	const first = question({ id: 41, question: "First question?" });
	const second = question({ id: 42, question: "Second question?", options: [] });
	connect([first, second]);
	const host = await mountAll();
	expect(host.querySelectorAll("[data-question-card]")).toHaveLength(1);
	expect(host.querySelector("[data-question-dock]")!.textContent).toContain("共 2 个待回答问题，当前第 1 个");
	expect(card(host)!.textContent).toContain("First question?");
	await click(button(host, "下一个"));
	await flush();
	expect(host.querySelectorAll("[data-question-card]")).toHaveLength(1);
	expect(card(host)!.textContent).toContain("Second question?");
	expect(card(host)!.dataset.open).toBe("false");
	await click(button(host, "上一个"));
	expect(card(host)!.textContent).toContain("First question?");
});

it("keeps the footer outside the scrolling body and caps the card height for small screens", async () => {
	connect([question({ question: "Very long\n".repeat(400).slice(0, 2000) })]);
	const host = await mountAll();
	const c = card(host)!;
	const body = host.querySelector<HTMLElement>("[data-question-body]")!;
	expect(c.className).toMatch(/max-h-\[min\(42dvh,/);
	expect(body.className).toContain("overflow-y-auto");
	expect(body.className).toContain("min-h-0");
	expect(body.contains(button(c, "提交回答"))).toBe(false);
	expect(body.contains(button(c, "跳过"))).toBe(false);
	expect(c.className).not.toMatch(/\b(fixed|absolute)\b/);
	// No horizontal overflow: long words wrap inside the card.
	expect(body.querySelector("[data-question-text]")!.className).toContain("break-words");
});

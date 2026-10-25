import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
	currentToolFrame,
	type ToolCardState,
	ToolExecutionComponent,
	ToolSpinnerTicker,
} from "../src/components/tool-execution.ts";
import { diffBackgroundAnsi, theme } from "../src/theme/slots.ts";

const base: ToolCardState = {
	name: "Bash",
	summary: "npm test",
	detail: null,
	phase: "pending",
	isError: false,
	output: null,
	result: null,
	durationMs: null,
	note: null,
	diff: null,
	diffAdded: null,
	diffRemoved: null,
};

const render = (state: Partial<ToolCardState>) =>
	stripTerminalSequences(new ToolExecutionComponent({ ...base, ...state }).render(80).join("\n"));

it("renders the unified phase glyphs", () => {
	expect(render({ phase: "pending" })).toContain("…");
	expect(render({ phase: "running" })).toContain(`${currentToolFrame()} Running...`);
	expect(render({ phase: "done", durationMs: 2300 })).toContain("✓ 2.3s");
	const failed = render({ phase: "done", isError: true });
	expect(failed).toContain("✗ Failed");
	expect(failed).not.toContain("x Failed");
});

it("pads card content inside the status background", () => {
	const card = new ToolExecutionComponent({ ...base });
	// Box(1,0) 承载色块内边距(文本自身不再内缩):每行恰好 1 格前导。
	for (const line of card.render(40).map(stripTerminalSequences)) {
		expect(line.startsWith(" ⚡")).toBe(true);
	}
});

it("exposes running state for the app ticker", () => {
	const card = new ToolExecutionComponent({ ...base, phase: "running" });
	expect(card.isRunning).toBe(true);
	card.sync({ ...base, phase: "done" });
	expect(card.isRunning).toBe(false);
});

it("advances frames only while the ticker runs", async () => {
	let ticks = 0;
	const ticker = new ToolSpinnerTicker(() => ticks++, 10);
	const before = currentToolFrame();
	expect(ticker.running).toBe(false);
	ticker.start();
	ticker.start(); // 幂等
	expect(ticker.running).toBe(true);
	await new Promise((resolve) => setTimeout(resolve, 35));
	ticker.stop();
	expect(ticker.running).toBe(false);
	expect(ticks).toBeGreaterThan(0);
	expect(currentToolFrame() === before && ticks < 2).toBe(false);
	const settledTicks = ticks;
	const settledFrame = currentToolFrame();
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(ticks).toBe(settledTicks);
	expect(currentToolFrame()).toBe(settledFrame);
});

it("collapses every tool to a single row with a line-count hint until expanded", () => {
	const result = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
	for (const name of ["web_search", "Bash", "read"]) {
		const card = new ToolExecutionComponent({ ...base, name, phase: "done", durationMs: 4000, result });
		const collapsed = stripTerminalSequences(card.render(80).join("\n")).trimEnd();
		expect(collapsed.split("\n")).toHaveLength(1);
		expect(collapsed).toContain("+20 lines");
		expect(collapsed).not.toContain("line 3");
		card.setExpanded(true);
		const expanded = stripTerminalSequences(card.render(80).join("\n"));
		expect(expanded).toContain("line 0");
		expect(expanded).toContain("line 19");
		expect(expanded).not.toContain("+20 lines");
	}
});

it("shows running partial output and late results once expanded", () => {
	const card = new ToolExecutionComponent({ ...base, phase: "running", output: "partial…" });
	expect(stripTerminalSequences(card.render(80).join("\n"))).not.toContain("partial…");
	card.setExpanded(true);
	expect(stripTerminalSequences(card.render(80).join("\n"))).toContain("partial…");
	card.sync({ ...base, phase: "done", result: "final" });
	expect(stripTerminalSequences(card.render(80).join("\n"))).toContain("final");
});

it("appends diff counts to the collapsed summary for edit and write", () => {
	const edit = render({
		name: "edit",
		summary: "src/foo.ts (1 edit)",
		phase: "done",
		diff: "+ 1 a",
		diffAdded: 18,
		diffRemoved: 3,
	});
	expect(edit).toContain("src/foo.ts (1 edit) (+18/-3)");
	const write = render({
		name: "write",
		summary: "foo.ts",
		phase: "done",
		diff: "+ a",
		diffAdded: 142,
		diffRemoved: 0,
	});
	expect(write).toContain("foo.ts (+142)");
	expect(write).not.toContain("(-0)");
	// 折叠态不渲染 diff 内容,行数提示仍指结果输出。
	expect(write).not.toContain("---- Diff ----");
});

it("keeps the collapsed summary unchanged for tools without diff", () => {
	const collapsed = render({ name: "read", summary: "file.ts", phase: "done", result: "x" });
	expect(collapsed).not.toContain("(+");
	expect(collapsed).not.toContain("---- Diff ----");
});

it("renders the expanded diff with two-layer highlight", () => {
	const card = new ToolExecutionComponent({
		...base,
		name: "edit",
		summary: "foo.ts (1 edit)",
		phase: "done",
		diff: ['  1 const s = "a', "+  2 b", '  3 c";'].join("\n"),
		diffAdded: 1,
		diffRemoved: 0,
	});
	card.setExpanded(true);
	const raw = card.render(80).join("\n");
	// 语法 token 前景色(跨行字符串延续到新增行)+ 增删行底色。
	expect(raw).toContain(theme.syntaxString("b"));
	expect(raw).toContain(diffBackgroundAnsi("added"));
	const text = stripTerminalSequences(raw);
	expect(text).toContain("---- Diff ----");
	expect(text).toContain('const s = "a');
	expect(text).toContain("+  2 b");
});

it("shows write content once via the diff instead of repeating the detail", () => {
	const content = "const x = 1;";
	const card = new ToolExecutionComponent({
		...base,
		name: "write",
		summary: "foo.ts",
		detail: `foo.ts\n${content}`,
		phase: "done",
		diff: `+ ${content}`,
		diffAdded: 1,
		diffRemoved: 0,
	});
	card.setExpanded(true);
	const text = stripTerminalSequences(card.render(80).join("\n"));
	expect(text).not.toContain("---- Arguments ----");
	expect(text.split(content)).toHaveLength(2);
});

it("keeps the write detail when no diff data is available (historical calls)", () => {
	const content = "const x = 1;";
	const card = new ToolExecutionComponent({
		...base,
		name: "write",
		summary: "foo.ts",
		detail: `foo.ts\n${content}`,
		phase: "done",
	});
	card.setExpanded(true);
	const text = stripTerminalSequences(card.render(80).join("\n"));
	expect(text).toContain("---- Arguments ----");
	expect(text).toContain(content);
});

it("identifies truncated write previews and retains argument details", () => {
	const card = new ToolExecutionComponent({
		...base,
		name: "write",
		summary: "a.txt",
		detail: "a.txt\nfirst\nunshown",
		diff: "+ first",
		diffAdded: 1,
		diffRemoved: 0,
		diffTruncated: true,
	});
	card.setExpanded(true);
	const text = stripTerminalSequences(card.render(120).join("\n"));
	expect(text).toContain("Diff preview truncated");
	expect(text).toContain("---- Arguments ----");
	expect(text).toContain("unshown");
});

it("clips expanded diffs to 50 lines with a rest hint", () => {
	const diff = Array.from({ length: 60 }, (_, i) => `+ line ${i}`).join("\n");
	const card = new ToolExecutionComponent({
		...base,
		name: "write",
		summary: "big.txt",
		phase: "done",
		diff,
		diffAdded: 60,
		diffRemoved: 0,
	});
	card.setExpanded(true);
	const text = stripTerminalSequences(card.render(120).join("\n"));
	expect(text).toContain("line 49");
	expect(text).not.toContain("line 50");
	expect(text).toContain("… +10 more lines");
});

it("still renders the diff body when the target language is unknown", () => {
	const card = new ToolExecutionComponent({
		...base,
		name: "edit",
		summary: "foo.unknownext (1 edit)",
		phase: "done",
		diff: "- old\n+ new",
		diffAdded: 1,
		diffRemoved: 1,
	});
	card.setExpanded(true);
	const text = stripTerminalSequences(card.render(80).join("\n"));
	expect(text).toContain("- old");
	expect(text).toContain("+ new");
});

const call = (id: number, patch: Partial<import("@neko-harness/core").CodemodeCallView> = {}) => ({
	id,
	name: "read",
	args: `{"path":"f${id}"}`,
	status: "ok" as const,
	durationMs: 1200,
	error: null,
	...patch,
});
const script = (calls: number, extra: Partial<ToolCardState> = {}, omitted = 0): ToolCardState => ({
	...base,
	name: "codemode",
	summary: "const a = await tools.read()",
	detail: "const a = await tools.read({ path: 'a' });\ntext(a);",
	phase: "done",
	result: "Script completed\nOutput:\nhello",
	durationMs: 3400,
	codemode: {
		calls: Array.from({ length: calls }, (_, i) => call(i + 1)),
		omitted,
		fullOutputPath: "/tmp/full.txt",
	},
	...extra,
});

it("collapsed codemode cards list at most 8 nested calls and count the rest", () => {
	const text = render(script(12));
	expect(text).toContain("codemode");
	expect(text).toContain('✓ read {"path":"f8"}');
	expect(text).not.toContain('{"path":"f9"}');
	expect(text).toContain("4 more");
	expect(text).not.toContain("Script completed");
	expect(render(script(8))).not.toContain("more");
});

it("expanded codemode cards show the script, every listed call, the output and the full output path", () => {
	const card = new ToolExecutionComponent(
		script(12, {
			codemode: {
				calls: [...Array.from({ length: 12 }, (_, i) => call(i + 1))],
				omitted: 3,
				fullOutputPath: "/tmp/full.txt",
			},
		}),
	);
	card.setExpanded(true);
	const text = stripTerminalSequences(card.render(100).join("\n"));
	expect(text).toContain("Script");
	expect(text).toContain("tools.read({ path: 'a' })");
	expect(text).toContain('{"path":"f12"}');
	expect(text).toContain("Tool calls (15)");
	expect(text).toContain("3 more");
	expect(text).toContain("Script completed");
	expect(text).toContain("Full output: /tmp/full.txt");
});

it("marks running, failed and cancelled nested calls and updates live", () => {
	const card = new ToolExecutionComponent(
		script(0, {
			phase: "running",
			result: null,
			codemode: {
				calls: [
					call(1, { status: "running", durationMs: null }),
					call(2, { status: "error", error: "no match", durationMs: null }),
					call(3, { status: "cancelled", durationMs: null }),
				],
				omitted: 0,
				fullOutputPath: null,
			},
		}),
	);
	let text = stripTerminalSequences(card.render(100).join("\n"));
	expect(text).toContain(`${currentToolFrame()} read`);
	expect(text).toContain("✗ read");
	expect(text).toContain("no match");
	expect(text).toContain("↷ read");
	card.sync(script(1));
	text = stripTerminalSequences(card.render(100).join("\n"));
	expect(text).not.toContain("no match");
	expect(text).toContain("✓ read");
});

it("shows model-controlled codemode text without terminal control sequences", () => {
	const text = render(
		script(0, {
			summary: "\x1b[31mred\x1b[0m",
			codemode: {
				calls: [call(1, { name: "re\x1b]0;x\x07ad", args: "\x1b[2Jboom" })],
				omitted: 0,
				fullOutputPath: null,
			},
		}),
	);
	expect(text).not.toContain("\x1b");
	expect(text).toContain("boom");
});

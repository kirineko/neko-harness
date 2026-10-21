import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { PickerPanel } from "../src/components/picker.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
it("ignores late loads, prevents duplicate panels and restores focus on close", async () => {
	let resolve!: (items: { value: string; label: string }[]) => void;
	let closed = 0;
	const panel = new PickerPanel(
		() => {},
		() => closed++,
	);
	const loading = panel.show(
		"Models",
		() =>
			new Promise((r) => {
				resolve = r;
			}),
		async () => {},
	);
	expect(panel.render(80).join("\n")).toContain("Loading");
	await panel.show(
		"Sessions",
		async () => {
			throw new Error("must not load");
		},
		async () => {},
	);
	panel.handleInput("\x1b");
	resolve([{ value: "a", label: "A" }]);
	await loading;
	expect(panel.open).toBe(false);
	expect(closed).toBe(1);
});
it("filters, navigates, retries failure and applies at most once", async () => {
	let attempts = 0,
		picks = 0;
	let finish!: () => void;
	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	await panel.show(
		"Models",
		async () => {
			if (++attempts === 1) throw new Error("offline");
			return [
				{ value: "one", label: "One" },
				{ value: "two", label: "Two" },
			];
		},
		() => {
			picks++;
			return new Promise((r) => {
				finish = r;
			});
		},
	);
	expect(panel.render(80).join("\n")).toContain("offline");
	panel.handleInput("\r");
	await tick();
	panel.handleInput("z");
	expect(panel.render(80).join("\n")).toContain("No results");
	panel.handleInput("\x7f");
	panel.handleInput("t");
	expect(panel.render(80).join("\n")).toContain("❯ Two");
	panel.handleInput("\r");
	panel.handleInput("\r");
	expect(picks).toBe(1);
	finish();
	await tick();
	expect(panel.open).toBe(false);
});

it("moves once per Kitty key press, allows repeat and ignores release", async () => {
	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	let picked = "";
	await panel.show(
		"Sessions",
		async () => [
			{ value: "1", label: "Session 1" },
			{ value: "2", label: "Session 2" },
			{ value: "3", label: "Session 3" },
			{ value: "4", label: "Session 4" },
		],
		async (value) => {
			picked = value;
		},
	);
	panel.handleInput("\x1b[1;1:1B");
	panel.handleInput("\x1b[1;1:3B");
	expect(panel.render(80).join("\n")).toContain("❯ Session 2");
	panel.handleInput("\x1b[1;1:2B");
	expect(panel.render(80).join("\n")).toContain("❯ Session 3");
	panel.handleInput("\x1b[1;1:1A");
	panel.handleInput("\x1b[1;1:3A");
	expect(panel.render(80).join("\n")).toContain("❯ Session 2");
	panel.handleInput("\x1b[27;1:3u");
	expect(panel.open).toBe(true);
	panel.handleInput("\x1b[13;1:3u");
	expect(picked).toBe("");
	panel.handleInput("\r");
	await tick();
	expect(picked).toBe("2");
});

it("preserves selection by identity through live reorder at all supported widths", async () => {
	let chosen = "";
	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	await panel.show(
		"Sessions",
		async () => [
			{ value: "a", label: "Alpha", rightLabel: "2m" },
			{ value: "b", label: "Beta", rightLabel: "1h" },
			{ value: "c", label: "Gamma", rightLabel: "1d" },
		],
		async (value) => {
			chosen = value;
		},
	);
	panel.handleInput("\x1b[B");
	panel.update([
		{ value: "b", label: "Updated Beta", rightLabel: "now" },
		{ value: "c", label: "Gamma" },
		{ value: "a", label: "Alpha" },
	]);
	for (const [width, height] of [
		[120, 20],
		[80, 12],
		[60, 7],
	]) {
		panel.height = height!;
		const rows = panel.render(width!);
		expect(rows.join("\n")).toContain("❯ Updated Beta");
		expect(rows.length).toBe(height!);
	}
	panel.handleInput("\r");
	await tick();
	expect(chosen).toBe("b");
	panel.update([{ value: "x", label: "Should stay closed" }]);
	expect(panel.open).toBe(false);
});

it("keeps search through updates and chooses the adjacent item when selection disappears", async () => {
	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	let picked = "";
	await panel.show(
		"Sessions",
		async () => [
			{ value: "a", label: "Alpha", searchText: "shared" },
			{ value: "b", label: "Beta", searchText: "shared" },
			{ value: "c", label: "Gamma", searchText: "shared" },
		],
		async (v) => {
			picked = v;
		},
	);
	for (const c of "shared") panel.handleInput(c);
	panel.handleInput("\x1b[B");
	panel.update([
		{ value: "a", label: "Updated Alpha", searchText: "shared" },
		{ value: "c", label: "Gamma", searchText: "shared" },
		{ value: "x", label: "Excluded" },
	]);
	expect(panel.render(80).join("\n")).toContain("❯ Gamma");
	expect(panel.render(80).join("\n")).not.toContain("Excluded");
	panel.handleInput("\r");
	await tick();
	expect(picked).toBe("c");
});

it("skips header rows in navigation and hides them while filtering", async () => {
	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	const picked: string[] = [];
	await panel.show(
		"Market",
		async () => [
			{ value: "h:dev", label: "development (2)", header: true },
			{ value: "think", label: "think" },
			{ value: "hunt", label: "hunt" },
			{ value: "h:docs", label: "documents (1)", header: true },
			{ value: "pdf", label: "pdf" },
		],
		async (value) => {
			picked.push(value);
		},
	);
	// 初始选中第一个非组头项；Enter 不触发组头。
	expect(panel.render(80).join("\n")).toContain("development (2)");
	panel.handleInput("\x1b[B"); // down → hunt（跳过 dev 组头之外不移动）
	panel.handleInput("\x1b[B"); // down → pdf（跳过 documents 组头）
	panel.handleInput("\r");
	await tick();
	expect(picked).toEqual(["pdf"]);

	// 搜索时组头隐藏
	const panel2 = new PickerPanel(
		() => {},
		() => {},
	);
	await panel2.show(
		"Market",
		async () => [
			{ value: "h:dev", label: "development (1)", header: true },
			{ value: "think", label: "think" },
		],
		async () => {},
	);
	panel2.search.setValue("thi");
	panel2.handleInput("");
	const text = panel2.render(80).join("\n");
	expect(text).toContain("think");
	expect(text).not.toContain("development (1)");
});

it("opens a detail view returned by pick and pops it with Esc before closing", async () => {
	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	let closed = 0;
	const detail = {
		help: "Esc Back",
		lines: () => ["DETAIL VIEW"],
		handleKey: () => true,
	};
	await panel.show(
		"Market",
		async () => [{ value: "think", label: "think" }],
		async () => detail,
	);
	const closingPanel = new PickerPanel(
		() => {},
		() => closed++,
	);
	void closingPanel;
	panel.handleInput("\r");
	await tick();
	expect(panel.render(80).join("\n")).toContain("DETAIL VIEW");
	expect(panel.detailOpen).toBe(true);
	expect(panel.open).toBe(true);
	panel.handleInput("\x1b"); // Esc → 弹回列表
	expect(panel.detailOpen).toBe(false);
	expect(panel.open).toBe(true);
	panel.handleInput("\x1b"); // 再 Esc → 关面板
	expect(panel.open).toBe(false);
});

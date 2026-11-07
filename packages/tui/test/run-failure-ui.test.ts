import { afterEach, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { setLanguage } from "../src/i18n/index.ts";
import { continueCommand, RunFailureRow } from "../src/run-failure-ui.ts";
import "./support/lang-en.ts";

const plain = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line));

afterEach(() => setLanguage("en"));

it("shows the reason, a one-line detail and the /continue hint in one row", () => {
	const row = new RunFailureRow();
	expect(row.visible).toBe(false);
	expect(row.render(80)).toEqual([]);
	row.set({ reason: "model_error", detail: "401\ninvalid key" });
	expect(row.visible).toBe(true);
	expect(plain(row.render(80))).toEqual([" Model request failed: 401 invalid key · /continue to continue"]);
	setLanguage("zh");
	expect(plain(row.render(80))[0]).toContain("模型请求失败");
	expect(plain(row.render(80))[0]).toContain("/continue 继续");
});

it("fits the width, and offers no /continue when nothing can be answered", () => {
	const row = new RunFailureRow();
	row.set({ reason: "model_error", detail: "x".repeat(300) });
	expect(visibleWidth(row.render(40)[0]!)).toBeLessThanOrEqual(40);
	row.set({ reason: "nothing_to_answer" });
	expect(plain(row.render(80))).toEqual([" Nothing to answer"]);
	row.set(undefined);
	expect(row.visible).toBe(false);
});

it("runs /continue through the gateway client and explains a refusal or an older gateway", async () => {
	const calls: string[] = [];
	const client = (supported: boolean, error?: Error) => ({
		supported,
		continueRun: async () => {
			calls.push("continue");
			if (error) throw error;
		},
	});
	expect(await continueCommand(client(true))).toBeUndefined();
	expect(calls).toEqual(["continue"]);
	setLanguage("zh");
	expect(
		await continueCommand(
			client(true, new Error("CONTINUE_UNAVAILABLE: The last run was answered; there is nothing to continue.")),
		),
	).toBe("CONTINUE_UNAVAILABLE: 上一轮已得到回答，没有可继续的内容。");
	expect(await continueCommand(client(false))).toBe("此网关不支持继续运行。请重启网关以启用。");
	expect(calls).toHaveLength(2);
});

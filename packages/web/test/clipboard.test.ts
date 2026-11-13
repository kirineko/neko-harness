import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeClipboard } from "../src/client/lib/clipboard.ts";

type Calls = { focused: number; removed: number; execCommand: number; selected: number; restored: number };

const globals = globalThis as unknown as Record<string, unknown>;
const saved = { navigator: globals.navigator, document: globals.document };

function installDom(options: { execResult: boolean; clipboard?: { writeText(text: string): Promise<void> } }): Calls {
	const calls: Calls = { focused: 0, removed: 0, execCommand: 0, selected: 0, restored: 0 };
	const range = {};
	const selection = {
		rangeCount: 1,
		getRangeAt: () => range,
		removeAllRanges: () => {},
		addRange: () => {
			calls.restored++;
		},
	};
	const area = {
		value: "",
		style: { cssText: "" },
		setAttribute: () => {},
		select: () => {
			calls.selected++;
		},
		remove: () => {
			calls.removed++;
		},
	};
	globals.navigator = options.clipboard ? { clipboard: options.clipboard } : {};
	globals.document = {
		activeElement: {
			focus: () => {
				calls.focused++;
			},
		},
		getSelection: () => selection,
		createElement: () => area,
		body: { append: () => {} },
		execCommand: () => {
			calls.execCommand++;
			return options.execResult;
		},
	};
	return calls;
}

describe("writeClipboard", () => {
	beforeEach(() => {
		globals.navigator = {};
	});
	afterEach(() => {
		globals.navigator = saved.navigator;
		globals.document = saved.document;
	});

	it("uses the async clipboard API when it works", async () => {
		let written = "";
		const calls = installDom({
			execResult: true,
			clipboard: {
				writeText: async (text) => {
					written = text;
				},
			},
		});
		await writeClipboard("hello");
		expect(written).toBe("hello");
		expect(calls.execCommand).toBe(0);
	});

	it("falls back to execCommand when the API is missing (insecure context)", async () => {
		const calls = installDom({ execResult: true });
		await writeClipboard("hello");
		expect(calls.execCommand).toBe(1);
	});

	it("falls back to execCommand when the API rejects", async () => {
		const calls = installDom({
			execResult: true,
			clipboard: { writeText: () => Promise.reject(new Error("denied")) },
		});
		await writeClipboard("hello");
		expect(calls.execCommand).toBe(1);
	});

	it("restores focus and selection and removes the helper node after the fallback", async () => {
		const calls = installDom({ execResult: true });
		await writeClipboard("hello");
		expect(calls.selected).toBe(1);
		expect(calls.removed).toBe(1);
		expect(calls.restored).toBe(1);
		expect(calls.focused).toBe(1);
	});

	it("throws when every path fails, still restoring focus", async () => {
		const calls = installDom({
			execResult: false,
			clipboard: { writeText: () => Promise.reject(new Error("denied")) },
		});
		await expect(writeClipboard("hello")).rejects.toThrow("Clipboard unavailable");
		expect(calls.removed).toBe(1);
		expect(calls.focused).toBe(1);
	});
});

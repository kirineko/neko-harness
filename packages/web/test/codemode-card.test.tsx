import { expect, it, spyOn } from "bun:test";
import { JSDOM } from "jsdom";
import * as React from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { act } = React;
const hljs = (await import("highlight.js/lib/core")).default;
const { ToolOrCodemodeCard } = await import("../src/client/components/codemode-card.tsx");

type Props = React.ComponentProps<typeof ToolOrCodemodeCard>;
const call = (id: number, patch: Record<string, unknown> = {}) => ({
	id,
	name: "read",
	args: `{"path":"f${id}"}`,
	status: "ok" as const,
	durationMs: 1200,
	error: null,
	...patch,
});
const base: Props = {
	name: "codemode",
	summary: "const a = await tools.read()",
	detail: "const a = await tools.read({ path: 'a' });\ntext(a);",
	phase: "done",
	isError: false,
	result: "Script completed\nOutput:\nhello",
	durationMs: 3400,
	codemode: {
		calls: [call(1), call(2, { name: "edit", status: "error", error: "no match", durationMs: null })],
		omitted: 5,
		fullOutputPath: "/tmp/full-output.txt",
	},
};

async function mount(props: Props) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => root.render(React.createElement(ToolOrCodemodeCard, props)));
	return { host, unmount: () => act(async () => root.unmount()) };
}

it("shows a collapsed header with the call count and does not highlight until expanded", async () => {
	const highlight = spyOn(hljs, "highlight");
	try {
		const view = await mount(base);
		expect(view.host.querySelector("[data-codemode-card]")).not.toBeNull();
		expect(view.host.textContent).toContain("7 次调用");
		expect(view.host.querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
		expect(view.host.textContent).not.toContain("no match");
		expect(highlight).not.toHaveBeenCalled();
		await view.unmount();
	} finally {
		highlight.mockRestore();
	}
});

it("expands into script, call list, omitted count, output and the full output path", async () => {
	const view = await mount(base);
	await act(async () => view.host.querySelector("button")!.click());
	const text = view.host.textContent ?? "";
	expect(view.host.querySelector("pre code .hljs-keyword")).not.toBeNull();
	expect(text).toContain("tools.read({ path: 'a' })");
	const rows = [...view.host.querySelectorAll<HTMLElement>("li[data-call-status]")];
	expect(rows.map((row) => row.dataset.callStatus)).toEqual(["ok", "error"]);
	expect(text).toContain("no match");
	expect(text).toContain("1.2s");
	expect(text).toContain("还有 5 条未显示");
	expect(text).toContain("Script completed");
	expect(text).toContain("完整输出：/tmp/full-output.txt");
	await view.unmount();
});

it("escapes script text and call previews instead of rendering them as markup", async () => {
	const view = await mount({
		...base,
		detail: '<img src=x onerror="alert(1)">',
		codemode: { calls: [call(1, { args: "<b>bold</b>" })], omitted: 0, fullOutputPath: null },
	});
	await act(async () => view.host.querySelector("button")!.click());
	expect(view.host.querySelector("img")).toBeNull();
	expect(view.host.querySelector("b")).toBeNull();
	expect(view.host.textContent).toContain("<b>bold</b>");
	await view.unmount();
});

it("shows running calls while the script runs and falls back to the plain card without codemode data", async () => {
	const running = await mount({
		...base,
		phase: "running",
		isError: undefined,
		result: null,
		output: "partial",
		codemode: { calls: [call(1, { status: "running", durationMs: null })], omitted: 0, fullOutputPath: null },
	});
	await act(async () => running.host.querySelector("button")!.click());
	expect(running.host.querySelector('[data-call-status="running"]')).not.toBeNull();
	expect(running.host.textContent).toContain("partial");
	await running.unmount();

	const { codemode: _drop, ...plainProps } = base;
	const plain = await mount(plainProps);
	expect(plain.host.querySelector("[data-codemode-card]")).toBeNull();
	expect(plain.host.textContent).toContain("codemode");
	await plain.unmount();
});

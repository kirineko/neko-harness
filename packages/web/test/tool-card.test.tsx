import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ToolCard, type ToolCardProps } from "../src/client/components/tool-card.tsx";

// An ES module namespace cannot be spied on in place, so swap `useState` for a mock that defaults to the real hook.
vi.mock("react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react")>();
	return { ...actual, useState: vi.fn(actual.useState) };
});

const base: ToolCardProps = {
	name: "write",
	summary: "a.ts",
	detail: null,
	phase: "running",
	diff: "+ const a = 1;",
	diffAdded: 1,
	diffRemoved: 0,
};

function withCardRenderer(expanded: boolean, check: (render: (props: ToolCardProps) => string) => void): void {
	const state = vi.mocked(React.useState).mockReturnValue([expanded, () => {}] as never);
	const descriptor = Object.getOwnPropertyDescriptor(DOMPurify, "sanitize");
	// SSR 没有 DOM；这里只验证消毒调用是否延迟，消毒算法仍由浏览器中的 DOMPurify 负责。
	const sanitize = vi.fn((html: string) => html);
	Object.defineProperty(DOMPurify, "sanitize", { value: sanitize, configurable: true });
	try {
		check((props) => renderToStaticMarkup(React.createElement(ToolCard, props)));
		if (expanded) expect(sanitize).toHaveBeenCalled();
		else expect(sanitize).not.toHaveBeenCalled();
	} finally {
		state.mockRestore();
		if (descriptor) Object.defineProperty(DOMPurify, "sanitize", descriptor);
		else Reflect.deleteProperty(DOMPurify, "sanitize");
	}
}

it("keeps diff-only collapsed cards expandable without highlighting or sanitizing streamed updates", () => {
	const highlight = vi.spyOn(hljs, "highlight");
	try {
		withCardRenderer(false, (render) => {
			for (const lines of [1, 100, 2000]) {
				const html = render({ ...base, diff: "+ const a = 1;\n".repeat(lines), diffAdded: lines });
				expect(html).toContain('aria-expanded="false"');
				expect(html).toContain(`(+${lines})`);
				expect(html).not.toContain("代码变更");
			}
		});
		expect(highlight).not.toHaveBeenCalled();
	} finally {
		highlight.mockRestore();
	}
});

it("renders full write details and a truncation notice, including an empty byte-limited preview", () => {
	withCardRenderer(true, (render) => {
		for (const diff of ["+ first", ""]) {
			const html = render({ ...base, detail: "a.ts\nfirst\nunshown tail", diff, diffTruncated: true });
			expect(html).toContain('aria-expanded="true"');
			expect(html).toContain("预览已截断");
			expect(html).toContain("完整写入内容");
			expect(html).toContain("unshown tail");
		}
	});
});

it("hides duplicate complete write details and preserves code indentation and numbers", () => {
	withCardRenderer(true, (render) => {
		const html = render({
			...base,
			detail: "a.ts\n    return 1\n123 + 4",
			diff: "+     return 1\n+ 123 + 4",
			diffTruncated: false,
		});
		expect(html).not.toContain("<pre");
		expect(html).toContain('<span class="diff-gutter">+</span><span>    ');
		expect(html).toContain('<span class="hljs-number">123</span>');
	});
});

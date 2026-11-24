import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import * as React from "react";
import { beforeEach, expect, it } from "vitest";
import { chatView } from "./support/interaction-fixtures.ts";

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "http://localhost/" });
Object.assign(dom.window.HTMLElement.prototype, { scrollTo: () => {} });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	localStorage: dom.window.localStorage,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { act } = React;
const { MessageList } = await import("../src/client/components/message-list.tsx");

async function mount(element: React.ReactElement) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => root.render(element));
	return { host, unmount: () => act(async () => root.unmount()) };
}

beforeEach(() => {
	document.body.innerHTML = "";
});

it("renders the pixel whale mascot and dual-row wordmark on an empty session with distinct gradient ids", async () => {
	const empty = chatView({ items: [] });
	const { host, unmount } = await mount(
		<div>
			<MessageList view={empty} busy={false} />
			<MessageList view={empty} busy={false} />
		</div>,
	);
	try {
		const whales = [...host.querySelectorAll<HTMLElement>(".welcome-whale svg")];
		expect(whales).toHaveLength(2);
		const fills = new Set([...(whales[0]?.querySelectorAll("rect") ?? [])].map((rect) => rect.getAttribute("fill")));
		expect(fills.has("var(--whale-outline)")).toBe(true);
		expect(fills.has("var(--whale-body)")).toBe(true);
		expect(fills.has("var(--whale-cheek)")).toBe(true);
		expect(fills.has("var(--whale-spout)")).toBe(true);
		expect(fills.has("var(--whale-shine)")).toBe(true);
		expect(whales[0]?.querySelector("title")?.textContent).toContain("neko");

		const wordmarks = [...host.querySelectorAll<SVGElement>('svg[role="img"][aria-label="neko.harness"]')];
		expect(wordmarks).toHaveLength(2);
		const gradIds = wordmarks.map((svg) => svg.querySelector("linearGradient")?.getAttribute("id"));
		expect(gradIds[0]).toBeTruthy();
		expect(gradIds[0]).not.toBe(gradIds[1]);
	} finally {
		await unmount();
	}
});

it("uses the pixel whale data-uri SVG favicon in index.html", () => {
	const match = /<link\s+rel="icon"\s+href="([^"]+)"/.exec(indexHtml);
	expect(match?.[1]).toContain("data:image/svg+xml,");
	expect(match?.[1]).toContain("shape-rendering='crispEdges'");
	expect(match?.[1]).toContain("%23356bf6");
	expect(match?.[1]).toContain("%23ff9bb3");
});

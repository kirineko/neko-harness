import { readFileSync } from "node:fs";
import type { ChatView } from "@neko-harness/core";
import { JSDOM } from "jsdom";
import * as React from "react";
import { beforeEach, expect, it } from "vitest";
import { chatView } from "./support/interaction-fixtures.ts";

const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

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

function rule(selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
	if (!match?.[1]) throw new Error(`missing rule: ${selector}`);
	return match[1];
}

function declaration(block: string, property: string): string | undefined {
	return new RegExp(`${property}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
}

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

it("constrains assistant bubbles and scrolls wide code blocks and tables inside the column", () => {
	const assistant = rule(".bubble-assistant");
	expect(declaration(assistant, "max-width")).toBe("100%");
	expect(declaration(assistant, "min-width")).toBe("0");

	const user = rule(".bubble-user");
	expect(declaration(user, "min-width")).toBe("0");
	expect(declaration(user, "overflow-wrap")).toBe("break-word");

	expect(declaration(rule(".md pre"), "overflow-x")).toBe("auto");

	const table = rule(".md table");
	expect(declaration(table, "display")).toBe("block");
	expect(declaration(table, "width")).toBe("max-content");
	expect(declaration(table, "max-width")).toBe("100%");
	expect(declaration(table, "overflow-x")).toBe("auto");
	expect(declaration(table, "overflow-wrap")).toBe("normal");
});

it("applies width caps and word-wrapping classes to committed, streaming and expanded thinking rows", async () => {
	const longToken = "x".repeat(240);
	const longCode = `\`\`\`text\nDarwin host 25.6.0 ${"RELEASE_ARM64_T6000_".repeat(12)}\n\`\`\``;
	const wideTable = "| Col A | Col B | Col C |\n| --- | --- | --- |\n| `alpha` | `beta` | `gamma` |";
	const view: ChatView = {
		...chatView({
			busy: true,
			items: [
				{
					type: "user",
					key: "u1",
					id: 1,
					text: longToken,
				},
				{
					type: "user",
					key: "u2",
					id: 2,
					text: `/skill:demo ${longToken}`,
					skill: { name: "demo", location: "/skills/demo/SKILL.md", body: "body", args: longToken },
				},
				{
					type: "assistant",
					key: "a1",
					id: 3,
					thinking: longToken,
					text: `${longCode}\n\n${wideTable}`,
					stopReason: "stop",
					errorMessage: null,
					note: longToken,
				},
			],
		}),
		streaming: {
			thinking: longToken,
			text: longCode,
			toolCalls: [],
		},
	};

	const { host, unmount } = await mount(<MessageList view={view} busy={true} />);
	try {
		const assistantBubbles = [...host.querySelectorAll<HTMLElement>(".bubble-assistant")];
		expect(assistantBubbles).toHaveLength(2);
		for (const bubble of assistantBubbles) {
			expect(bubble.classList.contains("max-w-full")).toBe(true);
			expect(bubble.classList.contains("min-w-0")).toBe(true);
		}
		expect(assistantBubbles[0]?.querySelector(".md pre")).not.toBeNull();
		expect(assistantBubbles[0]?.querySelector(".md table")).not.toBeNull();

		const userBubbles = [...host.querySelectorAll<HTMLElement>(".bubble-user")];
		expect(userBubbles).toHaveLength(2);
		for (const bubble of userBubbles) {
			expect(bubble.classList.contains("break-words")).toBe(true);
		}

		const thinkingToggle = assistantBubbles[0]?.querySelector<HTMLButtonElement>("button");
		expect(thinkingToggle).not.toBeUndefined();
		await act(async () => thinkingToggle?.click());
		const expandedThinking = thinkingToggle?.parentElement?.querySelector<HTMLElement>("div");
		expect(expandedThinking?.classList.contains("break-words")).toBe(true);
	} finally {
		await unmount();
	}
});

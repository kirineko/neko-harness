import { JSDOM } from "jsdom";
import * as React from "react";
import { expect, it } from "vitest";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { act } = React;
const { ProviderCombobox } = await import("../src/client/components/provider-combobox.tsx");

const options = [
	{ id: "deepseek", name: "DeepSeek", detail: "2 个模型", tone: "on" as const },
	{ id: "openrouter", name: "OpenRouter", detail: "未配置 Key", tone: "warn" as const },
	{ id: "openai", name: "OpenAI", keywords: "OPENAI_API_KEY" },
];

async function mount(value = "deepseek") {
	const picked: string[] = [];
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const Harness = () => {
		const [current, setCurrent] = React.useState(value);
		return React.createElement(ProviderCombobox, {
			label: "服务商",
			options,
			value: current,
			onChange: (id: string) => {
				picked.push(id);
				setCurrent(id);
			},
		});
	};
	await act(async () => root.render(React.createElement(Harness)));
	const input = host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
	const key = (name: string) =>
		act(async () => {
			input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
		});
	const type = (text: string) =>
		act(async () => {
			Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, text);
			input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
		});
	const texts = () => [...host.querySelectorAll('[role="option"]')].map((item) => item.textContent);
	return { host, input, key, type, texts, picked, unmount: () => act(async () => root.unmount()) };
}

it("shows the selected provider, opens on ArrowDown at the selection and picks with Enter", async () => {
	const box = await mount("openrouter");
	expect(box.input.value).toBe("OpenRouter");
	expect(box.input.getAttribute("aria-expanded")).toBe("false");
	await box.key("ArrowDown");
	expect(box.input.getAttribute("aria-expanded")).toBe("true");
	expect(box.texts()).toEqual(["DeepSeek2 个模型", "OpenRouter未配置 Key", "OpenAI"]);
	const active = () => document.getElementById(box.input.getAttribute("aria-activedescendant") ?? "")?.textContent;
	expect(active()).toContain("OpenRouter");
	await box.key("ArrowDown");
	expect(active()).toBe("OpenAI");
	await box.key("ArrowDown");
	expect(active()).toContain("DeepSeek");
	await box.key("End");
	expect(active()).toBe("OpenAI");
	await box.key("Home");
	expect(active()).toContain("DeepSeek");
	await box.key("ArrowUp");
	expect(active()).toBe("OpenAI");
	await box.key("Enter");
	expect(box.picked).toEqual(["openai"]);
	expect(box.input.value).toBe("OpenAI");
	expect(box.input.getAttribute("aria-expanded")).toBe("false");
	await box.unmount();
});

it("filters while typing, keeps the first match active and reports no match", async () => {
	const box = await mount();
	await box.type("open");
	expect(box.texts()).toEqual(["OpenRouter未配置 Key", "OpenAI"]);
	expect(document.getElementById(box.input.getAttribute("aria-activedescendant") ?? "")?.textContent).toContain(
		"OpenRouter",
	);
	await box.type("openai_api");
	expect(box.texts()).toEqual(["OpenAI"]);
	await box.type("zzz");
	expect(box.texts()).toEqual([]);
	expect(box.host.textContent).toContain("没有匹配的服务商");
	await box.key("Enter");
	expect(box.picked).toEqual([]);
	await box.unmount();
});

it("closes on Escape without leaking it, restoring the selected label, and ignores Escape when closed", async () => {
	const box = await mount();
	let escapes = 0;
	document.addEventListener("keydown", (event) => event.key === "Escape" && escapes++);
	await box.key("Escape");
	expect(escapes).toBe(1);
	await box.type("open");
	await box.key("Escape");
	expect(escapes).toBe(1);
	expect(box.input.getAttribute("aria-expanded")).toBe("false");
	expect(box.input.value).toBe("DeepSeek");
	expect(box.picked).toEqual([]);
	await box.unmount();
});

it("picks by click and closes when the input loses focus", async () => {
	const box = await mount();
	await act(async () => box.input.click());
	expect(box.input.getAttribute("aria-expanded")).toBe("true");
	const option = [...box.host.querySelectorAll<HTMLElement>('[role="option"]')][1]!;
	await act(async () => option.click());
	expect(box.picked).toEqual(["openrouter"]);
	await act(async () => box.input.click());
	await act(async () => {
		box.input.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
	});
	expect(box.input.getAttribute("aria-expanded")).toBe("false");
	await box.unmount();
});

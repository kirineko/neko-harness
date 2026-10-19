import { afterEach, beforeEach, expect, it } from "bun:test";
import { JSDOM } from "jsdom";
import * as React from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	localStorage: dom.window.localStorage,
	sessionStorage: dom.window.sessionStorage,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { act } = React;
const { ShellNotice } = await import("../src/client/components/shell-notice.tsx");
const { storeActions } = await import("../src/client/lib/store.ts");
const { shellBannerText, shellRow } = await import("../src/client/lib/shell-status.ts");

type Root = ReturnType<typeof createRoot>;
let container: HTMLElement;
let root: Root;

beforeEach(() => {
	storeActions.setShell(null);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() => root.render(React.createElement(ShellNotice)));
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	storeActions.setShell(null);
});

const banner = () => container.querySelector("[data-shell-notice]");

it("shows a dismissible banner when Git Bash is missing", () => {
	act(() => storeActions.setShell({ status: "missing", reason: "not_found" }));
	expect(banner()?.textContent).toContain("Git for Windows");
	act(() => (container.querySelector("button") as HTMLButtonElement).click());
	expect(banner()).toBeNull();
});

it("shows the config error for an invalid shell.path", () => {
	act(() => storeActions.setShell({ status: "missing", reason: "invalid_config", detail: "shell.path 指向 WSL bash" }));
	expect(banner()?.textContent).toContain("shell.path 指向 WSL bash");
});

it("stays hidden when ready or when the gateway reports no shell", () => {
	expect(banner()).toBeNull();
	act(() => storeActions.setShell({ status: "ready", path: "C:\\Git\\bin\\bash.exe", source: "auto" }));
	expect(banner()).toBeNull();
});

it("shows again for a different missing state after dismissal", () => {
	act(() => storeActions.setShell({ status: "missing", reason: "not_found" }));
	act(() => (container.querySelector("button") as HTMLButtonElement).click());
	act(() => storeActions.setShell({ status: "missing", reason: "invalid_config", detail: "bad" }));
	expect(banner()).not.toBeNull();
});

it("describes the shell for the About page", () => {
	expect(shellRow(null)).toBeNull();
	expect(shellRow({ status: "ready", path: "C:\\Git\\bin\\bash.exe", source: "config" })).toMatchObject({
		tone: "ok",
		detail: expect.stringContaining("C:\\Git\\bin\\bash.exe"),
	});
	expect(shellRow({ status: "missing", reason: "not_found" })).toMatchObject({ tone: "warn", label: "不可用" });
	expect(shellBannerText({ status: "ready", path: "x", source: "auto" })).toBeUndefined();
});

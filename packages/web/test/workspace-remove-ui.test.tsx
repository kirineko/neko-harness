import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { chatView } from "./support/interaction-fixtures.ts";

const dom = new JSDOM("<!doctype html><html lang='zh-CN'><body></body></html>", { url: "http://localhost/" });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	localStorage: dom.window.localStorage,
	sessionStorage: dom.window.sessionStorage,
	HTMLElement: dom.window.HTMLElement,
	scrollTo: () => {},
	IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia ??= (() => ({
	matches: false,
	addEventListener() {},
	removeEventListener() {},
})) as unknown as typeof dom.window.matchMedia;
const dialog = dom.window.HTMLDialogElement.prototype as unknown as { showModal?: () => void; close?: () => void };
dialog.showModal ??= function (this: HTMLDialogElement) {
	this.setAttribute("open", "");
};
dialog.close ??= function (this: HTMLDialogElement) {
	this.removeAttribute("open");
};

const calls = { remove: [] as string[], select: [] as string[] };
let removeImpl: (path: string) => Promise<void> = async () => {};
mock.module("../src/client/lib/bootstrap", () => ({
	appActions: {
		createSession: async () => {},
		selectSession: async () => {},
		selectWorkspace: async (path: string) => {
			calls.select.push(path);
		},
		addWorkspace: async () => {},
		archiveSession: async () => {},
		removeWorkspace: (path: string) => {
			calls.remove.push(path);
			return removeImpl(path);
		},
	},
	reportError: () => {},
}));

const { createRoot } = await import("react-dom/client");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { act } = React;
const { translator } = await import("../src/client/lib/i18n/index.ts");
const { languageStore } = await import("../src/client/lib/language.ts");
const { storeActions } = await import("../src/client/lib/store.ts");
const { SessionList } = await import("../src/client/components/session-list.tsx");

const zh = translator("zh");
const store = languageStore();
const mounted: { unmount(): void }[] = [];

const summary = (id: string, workspaceRoot: string) => ({
	id,
	workspaceRoot,
	title: id,
	firstPromptPreview: "",
	createdAt: 1,
	lastUsedAt: 1,
	lastMessageAt: 1,
	model: null,
	status: "idle" as const,
});

async function setup(workspaces: string[], current: string, launchRoot: string) {
	act(() => {
		storeActions.setPhase("ready");
		storeActions.setSession("s1");
		storeActions.setView(chatView());
		storeActions.setWebInfo({
			webVersion: "1",
			installedVersion: null,
			serverId: "x",
			gatewaySpawned: false,
			launchRoot,
		});
		storeActions.setWorkspaces(workspaces.map((path) => ({ path, createdAt: 1 })));
		storeActions.setWorkspace(current);
		storeActions.setDirectory([summary("s-b1", "/b"), summary("s-c1", "/c"), summary("s-c2", "/c")]);
	});
	const rootRoute = createRootRoute({
		component: () => React.createElement(SessionList, { open: true, onClose: () => {} }),
	});
	const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ["/"] }) });
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	mounted.push(root);
	await act(async () => root.render(React.createElement(RouterProvider, { router })));
	await act(async () => {
		document.querySelector<HTMLButtonElement>(".workspace-trigger")!.click();
	});
}

const rows = () => [...document.querySelectorAll<HTMLElement>(".workspace-row")];
const removeButton = (name: string) =>
	document.querySelector<HTMLButtonElement>(
		`.row-remove[aria-label="${zh("sessions.removeWorkspaceAria", { name })}"]`,
	)!;
const click = (element: HTMLElement) => act(async () => element.click());

beforeEach(() => {
	document.body.innerHTML = "";
	calls.remove = [];
	calls.select = [];
	removeImpl = async () => {};
	act(() => store.reset());
});
afterEach(async () => {
	for (const root of mounted.splice(0)) await act(async () => root.unmount());
	act(() => {
		storeActions.setDirectory([]);
		storeActions.setWorkspaces([]);
	});
	dom.window.localStorage.clear();
});

it("offers a remove button per row, disables the launch directory and does not switch workspace", async () => {
	await setup(["/a", "/b", "/c"], "/b", "/a");
	expect(rows()).toHaveLength(3);
	expect(removeButton("a").disabled).toBe(true);
	expect(removeButton("a").title).toBe(zh("sessions.removeWorkspaceLaunch"));
	const describedBy = removeButton("a").getAttribute("aria-describedby")!;
	expect(document.getElementById(describedBy)?.textContent).toBe(zh("sessions.removeWorkspaceLaunch"));
	expect(removeButton("b").disabled).toBe(false);
	expect(removeButton("c").disabled).toBe(false);
	await click(removeButton("c"));
	expect(calls.select).toEqual([]);
	expect(calls.remove).toEqual([]);
});

it("disables the only remaining workspace with the reason", async () => {
	await setup(["/b"], "/b", "/elsewhere");
	expect(removeButton("b").disabled).toBe(true);
	expect(removeButton("b").title).toBe(zh("sessions.removeWorkspaceLast"));
});

it("confirms with the path and hidden session count, then removes once", async () => {
	await setup(["/a", "/b", "/c"], "/b", "/a");
	await click(removeButton("c"));
	const dialogElement = document.querySelector("dialog")!;
	expect(dialogElement.textContent).toContain("/c");
	expect(dialogElement.textContent).toContain(zh("sessions.removeWorkspaceNoFiles"));
	expect(dialogElement.textContent).toContain(zh("sessions.removeWorkspaceHidden", { count: 2 }));
	expect(dialogElement.textContent).toContain(zh("sessions.removeWorkspaceRestore"));
	expect(calls.remove).toEqual([]);

	let release = () => {};
	removeImpl = () =>
		new Promise<void>((resolve) => {
			release = resolve;
		});
	const confirm = dialogElement.querySelector<HTMLButtonElement>(".btn-danger")!;
	await click(confirm);
	await click(confirm);
	expect(calls.remove).toEqual(["/c"]);
	expect(confirm.disabled).toBe(true);
	await act(async () => release());
	expect(document.querySelector("dialog")).toBeNull();
});

it("shows the localized server rejection inside the dialog and keeps it open", async () => {
	await setup(["/a", "/b", "/c"], "/b", "/a");
	removeImpl = async () => {
		throw new Error("WORKSPACE_BUSY: Stop or finish the running sessions of this workspace first.");
	};
	await click(removeButton("c"));
	await click(document.querySelector<HTMLButtonElement>("dialog .btn-danger")!);
	const alert = document.querySelector("dialog [role=alert]")!;
	expect(alert.textContent).toBe(zh("core.error.workspaceBusy"));
	expect(document.querySelector("dialog")).not.toBeNull();
	expect(document.querySelector<HTMLButtonElement>("dialog .btn-danger")!.disabled).toBe(false);
});

it("cancel closes the dialog without removing anything", async () => {
	await setup(["/a", "/b", "/c"], "/b", "/a");
	await click(removeButton("c"));
	await click(document.querySelector<HTMLButtonElement>("dialog .btn-outline")!);
	expect(document.querySelector("dialog")).toBeNull();
	expect(calls.remove).toEqual([]);
});

import { afterEach, expect, it } from "bun:test";
import { JSDOM } from "jsdom";
import * as React from "react";

const dom = new JSDOM("<!doctype html><html><head><title>neko.harness</title></head><body></body></html>", {
	url: "http://localhost/",
});
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
const { ResizeHandle } = await import("../src/client/components/resize-handle.tsx");
const { SIDE_PANEL_WIDTH } = await import("../src/client/lib/layout.ts");

const BODY_CLASS = "is-resizing-panel";

type Spy = { changes: number[]; commits: number; resets: number };
const roots: { unmount(): void }[] = [];
afterEach(() => {
	act(() => {
		for (const root of roots.splice(0)) root.unmount();
	});
	document.body.className = "";
	document.body.replaceChildren();
});

/** Controlled host that behaves like a panel: `onChange` feeds the handle's `width` back. */
function mount(initial: number = SIDE_PANEL_WIDTH.initial) {
	const spy: Spy = { changes: [], commits: 0, resets: 0 };
	function Host() {
		const [width, setWidth] = React.useState(initial);
		return React.createElement(ResizeHandle, {
			width,
			onChange: (next: number) => {
				spy.changes.push(next);
				setWidth(next);
			},
			onCommit: () => {
				spy.commits++;
			},
			onReset: () => {
				spy.resets++;
				setWidth(SIDE_PANEL_WIDTH.initial);
			},
		});
	}
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(React.createElement(Host)));
	const handle = host.querySelector<HTMLElement>("[role=separator]")!;
	return { spy, handle };
}

const pointer = (type: string, props: { pointerId?: number; clientX?: number; button?: number } = {}) => {
	const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
	return Object.assign(event, { pointerId: 1, clientX: 0, button: 0, ...props });
};
const fire = (el: Element, event: Event) => act(() => void el.dispatchEvent(event));
const press = (el: Element, name: string) => {
	const event = new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
	fire(el, event);
	return event;
};

it("exposes an accessible vertical separator with its bounds", () => {
	const { handle } = mount();
	expect(handle.getAttribute("aria-orientation")).toBe("vertical");
	expect(handle.getAttribute("aria-label")).toBe("调整面板宽度");
	expect(handle.getAttribute("aria-valuemin")).toBe(String(SIDE_PANEL_WIDTH.min));
	expect(handle.getAttribute("aria-valuemax")).toBe(String(SIDE_PANEL_WIDTH.max));
	expect(handle.getAttribute("aria-valuenow")).toBe(String(SIDE_PANEL_WIDTH.initial));
	expect(handle.tabIndex).toBe(0);
	// Hidden on narrow screens (drawer), shown from the lg breakpoint on.
	expect(handle.className).toContain("hidden");
	expect(handle.className).toContain("lg:block");
});

it("widens with ArrowLeft, narrows with ArrowRight, jumps with Home/End, and stays within bounds", () => {
	const { spy, handle } = mount();
	const now = () => Number(handle.getAttribute("aria-valuenow"));
	press(handle, "ArrowLeft");
	expect(now()).toBe(SIDE_PANEL_WIDTH.initial + SIDE_PANEL_WIDTH.step);
	press(handle, "ArrowRight");
	expect(now()).toBe(SIDE_PANEL_WIDTH.initial);
	press(handle, "End");
	expect(now()).toBe(SIDE_PANEL_WIDTH.max);
	press(handle, "ArrowLeft");
	expect(now()).toBe(SIDE_PANEL_WIDTH.max);
	press(handle, "Home");
	expect(now()).toBe(SIDE_PANEL_WIDTH.min);
	press(handle, "ArrowRight");
	expect(now()).toBe(SIDE_PANEL_WIDTH.min);
	// Every key press is a finished adjustment.
	expect(spy.commits).toBe(6);
});

it("keeps handled keys away from the panel and ignores other keys", () => {
	const { spy, handle } = mount();
	let reached = 0;
	document.body.addEventListener("keydown", () => reached++);
	const handled = press(handle, "ArrowLeft");
	expect(handled.defaultPrevented).toBe(true);
	expect(reached).toBe(0);
	const escapeKey = press(handle, "Escape");
	const tabKey = press(handle, "Tab");
	expect(escapeKey.defaultPrevented).toBe(false);
	expect(tabKey.defaultPrevented).toBe(false);
	expect(reached).toBe(2);
	expect(spy.commits).toBe(1);
});

it("resizes live while dragging and commits once on release", () => {
	Object.assign(dom.window, { innerWidth: 1600 });
	const { spy, handle } = mount();
	fire(handle, pointer("pointerdown", { clientX: 1040 }));
	expect(document.body.classList.contains(BODY_CLASS)).toBe(true);
	expect(handle.getAttribute("data-dragging")).toBe("true");
	fire(handle, pointer("pointermove", { clientX: 1000 }));
	fire(handle, pointer("pointermove", { clientX: 900 }));
	expect(spy.changes).toEqual([600, 700]);
	expect(handle.getAttribute("aria-valuenow")).toBe("700");
	expect(spy.commits).toBe(0);
	fire(handle, pointer("pointerup"));
	expect(spy.commits).toBe(1);
	expect(document.body.classList.contains(BODY_CLASS)).toBe(false);
	fire(handle, pointer("lostpointercapture"));
	expect(spy.commits).toBe(1);
	fire(handle, pointer("pointermove", { clientX: 500 }));
	expect(spy.changes).toEqual([600, 700]);
});

it("clamps a drag to the bounds and to 60% of the viewport", () => {
	Object.assign(dom.window, { innerWidth: 1000 });
	const { spy, handle } = mount();
	fire(handle, pointer("pointerdown"));
	fire(handle, pointer("pointermove", { clientX: 0 }));
	fire(handle, pointer("pointermove", { clientX: 990 }));
	expect(spy.changes).toEqual([600, SIDE_PANEL_WIDTH.min]);
	Object.assign(dom.window, { innerWidth: 3000 });
	fire(handle, pointer("pointermove", { clientX: 0 }));
	expect(spy.changes.at(-1)).toBe(SIDE_PANEL_WIDTH.max);
	fire(handle, pointer("pointerup"));
});

it("ignores other pointers and non-primary buttons", () => {
	Object.assign(dom.window, { innerWidth: 1600 });
	const { spy, handle } = mount();
	fire(handle, pointer("pointerdown", { button: 2 }));
	expect(document.body.classList.contains(BODY_CLASS)).toBe(false);
	fire(handle, pointer("pointerdown", { pointerId: 7 }));
	fire(handle, pointer("pointermove", { pointerId: 8, clientX: 900 }));
	expect(spy.changes).toEqual([]);
	fire(handle, pointer("pointermove", { pointerId: 7, clientX: 900 }));
	expect(spy.changes).toEqual([700]);
	fire(handle, pointer("pointerup", { pointerId: 7 }));
});

it("ends an interrupted drag on pointercancel and on lost capture", () => {
	Object.assign(dom.window, { innerWidth: 1600 });
	const { spy, handle } = mount();
	fire(handle, pointer("pointerdown"));
	fire(handle, pointer("pointercancel"));
	expect(spy.commits).toBe(1);
	expect(document.body.classList.contains(BODY_CLASS)).toBe(false);
	fire(handle, pointer("pointermove", { clientX: 900 }));
	expect(spy.changes).toEqual([]);
	fire(handle, pointer("pointerdown"));
	fire(handle, pointer("lostpointercapture"));
	expect(spy.commits).toBe(2);
	expect(document.body.classList.contains(BODY_CLASS)).toBe(false);
});

it("restores the default on double click", () => {
	const { spy, handle } = mount(800);
	expect(handle.getAttribute("aria-valuenow")).toBe("800");
	fire(handle, new dom.window.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
	expect(spy.resets).toBe(1);
	expect(handle.getAttribute("aria-valuenow")).toBe(String(SIDE_PANEL_WIDTH.initial));
});

it("never leaves the resizing class behind when unmounted mid-drag", () => {
	Object.assign(dom.window, { innerWidth: 1600 });
	const { spy, handle } = mount();
	fire(handle, pointer("pointerdown"));
	expect(document.body.classList.contains(BODY_CLASS)).toBe(true);
	act(() => {
		for (const root of roots.splice(0)) root.unmount();
	});
	expect(document.body.classList.contains(BODY_CLASS)).toBe(false);
	expect(spy.commits).toBe(1);
});

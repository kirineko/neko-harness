import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import type { TerminalColors, TUI } from "@earendil-works/pi-tui";
import { followTerminalTheme, modeFromColors } from "../src/detect-theme.ts";

it("invalidates pending replies, late replies and notifications across manual choice, restart and exit", async () => {
	type Query = Parameters<TUI["queryTerminalColors"]>[0];
	const requests: { resolve: (colors: TerminalColors) => void; options: Query }[] = [];
	const notifications: ((scheme: "light" | "dark") => void)[] = [];
	const enabled: boolean[] = [];
	let unsubscribed = 0;
	const ui = {
		queryTerminalColors: (options: Query) =>
			new Promise<TerminalColors>((resolve) => requests.push({ resolve, options })),
		setTerminalColorSchemeNotifications: (value: boolean) => {
			enabled.push(value);
		},
		onTerminalColorSchemeChange: (fn: (scheme: "light" | "dark") => void) => {
			notifications.push(fn);
			return () => {
				unsubscribed++;
			};
		},
	};
	const applied: string[] = [];
	const dark = { background: { r: 0, g: 0, b: 0 } };
	const light = { background: { r: 255, g: 255, b: 255 } };
	const tick = async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	};
	const first = followTerminalTheme(ui, (mode) => applied.push(mode));
	first(); // manual selection stops auto
	const second = followTerminalTheme(ui, (mode) => applied.push(mode));
	requests[0]!.resolve(dark);
	requests[0]!.options?.onLateReply?.(dark);
	notifications[0]!("dark");
	await tick();
	expect(applied).toEqual([]);
	requests[1]!.resolve(light);
	await tick();
	expect(applied).toEqual(["light"]);
	requests[1]!.options?.onLateReply?.(dark);
	notifications[1]!("light");
	expect(applied).toEqual(["light", "dark", "light"]);
	second(); // exit
	notifications[1]!("dark");
	requests[1]!.options?.onLateReply?.(dark);
	expect(applied).toEqual(["light", "dark", "light"]);
	expect(enabled).toEqual([true, false, true, false]);
	expect(unsubscribed).toBe(2);
	expect(modeFromColors({})).toBeUndefined();
});

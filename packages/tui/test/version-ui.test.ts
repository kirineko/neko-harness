import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { APPLICATION_PROTOCOL, type UpdateState } from "../../core/src/application-version.ts";
import { PickerPanel } from "../src/components/picker.ts";
import { openVersion, versionNotice, versionOverview } from "../src/version-ui.ts";

const state: UpdateState = {
	runningVersion: "1.0.0",
	installedVersion: "1.0.0",
	protocolVersion: APPLICATION_PROTOCOL,
	checkState: "ok",
	latestVersion: "1.0.0",
	checkedAt: 1,
};
const options = { runningVersion: "1.0.0", platform: "darwin" as const };
it("keeps the default overview concise and distinguishes incomplete check states", () => {
	expect(versionOverview(state, "1.0.0", options)).toBe("Current: v1.0.0\nUp to date");
	for (const [checkState, expected] of [
		["unknown", "Not checked"],
		["checking", "Checking for updates"],
		["failed", "Check failed"],
		["development", "Development build"],
	] as const) {
		const body = versionOverview({ ...state, checkState }, "1.0.0", options);
		expect(body).toContain(expected);
		expect(body).not.toContain("Up to date");
	}
	for (const missing of [
		null,
		{ ...state, latestVersion: null },
		{ ...state, installedVersion: null },
		{ ...state, checkedAt: null },
	])
		expect(versionOverview(missing, "1.0.0", options)).toContain("Check not available");
	expect(versionOverview(state, null, options)).toContain("Check not available");
	expect(versionOverview(null, null, { runningVersion: "development" })).toContain("Development build");
});

it("shows only the necessary action and never suggests a downgrade", () => {
	const newerRelease = { ...state, latestVersion: "1.1.0" };
	for (const platform of ["darwin", "linux", "win32"] as const) {
		const command = platform === "win32" ? "bun add --global neko-harness@latest" : "neko update";
		const body = versionOverview(newerRelease, "1.0.0", { ...options, platform });
		expect(body).toContain("Latest: v1.1.0");
		expect(body).toContain(command);
		expect(body).not.toContain("Gateway:");
		expect(versionNotice(newerRelease, "1.0.0", { ...options, platform })).toContain(command);
	}
	const oldGateway = { ...newerRelease, installedVersion: "1.1.0" };
	const restart = versionOverview(oldGateway, "1.1.0", options);
	expect(restart).toContain("Restart neko");
	expect(restart).toContain("TUI/Web and any neko serve");
	expect(restart).not.toContain("Latest:");
	expect(restart).not.toContain("Run neko update");
	expect(versionOverview({ ...oldGateway, checkState: "failed" }, "1.1.0", options)).toContain("Check failed");
	const newGateway = { ...oldGateway, runningVersion: "1.1.0" };
	expect(versionOverview(newGateway, "1.1.0", options)).toContain("Restart neko tui");
	const ahead = { ...state, runningVersion: "1.2.0", latestVersion: "1.1.0" };
	expect(versionOverview(ahead, "1.0.0", { ...options, runningVersion: "1.2.0" })).not.toContain("Update available");
	expect(versionNotice(ahead, "1.0.0", { ...options, runningVersion: "1.2.0" })).toBe("");
	expect(versionOverview({ ...state, protocolVersion: APPLICATION_PROTOCOL + 1 }, "1.0.0", options)).toContain(
		"Protocol incompatible",
	);
	expect(versionNotice(null, null, options)).toBe("");
});

it("separates details, preserves failed-check feedback, and returns through the menu", async () => {
	for (const width of [60, 80]) {
		let closed = 0;
		const panel = new PickerPanel(
			() => {},
			() => {
				closed++;
			},
		);
		panel.height = 10;
		await openVersion(
			panel,
			async () => ({ state, installed: "1.0.0" }),
			async () => {
				throw new Error("offline");
			},
			options,
		);
		const text = () => stripTerminalSequences(panel.render(width).join("\n"));
		const enter = async () => {
			panel.handleInput("\r");
			await Bun.sleep(0);
		};
		await enter();
		expect(text()).toContain("Up to date");
		expect(text()).not.toContain("Gateway:");
		panel.handleInput("\x1b");
		panel.handleInput("\x1b[B");
		await enter();
		expect(text()).toContain("Check failed");
		expect(text()).not.toContain("Up to date");
		panel.handleInput("\x1b");
		panel.handleInput("\x1b[B");
		await enter();
		expect(text()).toContain("Gateway: 1.0.0");
		expect(text()).toContain("Installed: 1.0.0");
		panel.handleInput("\x1b");
		expect(panel.open).toBe(true);
		panel.handleInput("\x1b");
		expect(panel.open).toBe(false);
		expect(closed).toBe(1);
	}
});

it("uses the returned check result and makes the Windows command accessible in a small panel", async () => {
	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	panel.height = 8;
	await openVersion(
		panel,
		async () => ({ state, installed: "1.0.0" }),
		async () => ({ ...state, latestVersion: "1.1.0" }),
		{
			...options,
			platform: "win32",
		},
	);
	panel.handleInput("\x1b[B");
	panel.handleInput("\r");
	await Bun.sleep(0);
	let output = "";
	for (let n = 0; n < 12; n++) {
		const lines = panel.render(60);
		expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
		output += stripTerminalSequences(lines.join("\n"));
		panel.handleInput("\x1b[B");
	}
	expect(output).toContain("Latest: v1.1.0");
	expect(output).toContain("bun add --global neko-harness@latest");
	panel.close();
});

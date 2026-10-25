import { expect, it } from "bun:test";
import {
	CODEMODE_MODES,
	isCodemodeMode,
	parseCodemodeMode,
	parseCodemodeSettings,
	resolveCodemodeSettings,
} from "../src/codemode-mode.ts";

it("accepts exactly the three modes", () => {
	expect(CODEMODE_MODES).toEqual(["off", "on", "only"]);
	for (const mode of CODEMODE_MODES) expect(isCodemodeMode(mode)).toBe(true);
	for (const bad of ["auto", "ON", "", null, undefined, 1, {}]) expect(isCodemodeMode(bad)).toBe(false);
	expect(() => parseCodemodeMode("auto")).toThrow(/codemode\.mode.*off, on, only/);
	expect(parseCodemodeMode("on")).toBe("on");
});

it("validates the configuration block", () => {
	expect(parseCodemodeSettings({})).toEqual({});
	expect(parseCodemodeSettings({ mode: "only" })).toEqual({ mode: "only" });
	expect(() => parseCodemodeSettings([])).toThrow(/codemode/);
	expect(() => parseCodemodeSettings({ mode: 1 })).toThrow(/codemode\.mode/);
	expect(() => parseCodemodeSettings({ other: true })).toThrow(/codemode\.other/);
});

it("resolves saved > config > default", () => {
	expect(resolveCodemodeSettings(undefined, null)).toEqual({ effective: { mode: "off" }, source: "default" });
	expect(resolveCodemodeSettings({}, undefined)).toEqual({ effective: { mode: "off" }, source: "default" });
	expect(resolveCodemodeSettings({ mode: "on" }, null)).toEqual({ effective: { mode: "on" }, source: "config" });
	expect(resolveCodemodeSettings({ mode: "on" }, "only")).toEqual({ effective: { mode: "only" }, source: "saved" });
	expect(resolveCodemodeSettings({ mode: "on" }, "off")).toEqual({ effective: { mode: "off" }, source: "saved" });
});

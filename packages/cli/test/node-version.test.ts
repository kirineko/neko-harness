import { expect, it } from "bun:test";
import { unsupportedNode } from "../src/node-version.ts";

it("accepts the minimum and anything newer, ignoring prerelease and build suffixes", () => {
	for (const current of [
		"22.19.0",
		"22.19.1",
		"22.20.0",
		"24.0.0",
		"v24.15.0",
		"22.19.0-nightly20250101",
		"23.0.0+build",
	])
		expect(unsupportedNode(current, "22.19.0")).toBeUndefined();
});

it("rejects older versions with one line naming the required and the current version", () => {
	for (const current of ["22.18.9", "22.9.0", "20.11.1", "18.20.4", "22.18.0-rc.1"]) {
		const message = unsupportedNode(current, "22.19.0");
		expect(message).toContain("22.19.0");
		expect(message).toContain(current);
		expect(message).not.toContain("\n");
	}
});

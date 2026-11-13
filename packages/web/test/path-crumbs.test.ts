import { describe, expect, it } from "vitest";
import { pathCrumbs } from "../src/client/lib/path-crumbs.ts";

describe("pathCrumbs", () => {
	it("splits POSIX paths with / root (unchanged behavior)", () => {
		expect(pathCrumbs("/home/user/code")).toEqual({
			root: "/",
			rootLabel: "/",
			crumbs: [
				{ label: "home", path: "/home" },
				{ label: "user", path: "/home/user" },
				{ label: "code", path: "/home/user/code" },
			],
		});
	});

	it("splits Windows drive paths: root goes to the drive list, first crumb is the drive root", () => {
		expect(pathCrumbs("D:\\code\\neko-harness")).toEqual({
			root: "/",
			rootLabel: "此电脑",
			crumbs: [
				{ label: "D:", path: "D:\\" },
				{ label: "code", path: "D:\\code" },
				{ label: "neko-harness", path: "D:\\code\\neko-harness" },
			],
		});
	});

	it("accepts forward slashes in drive paths", () => {
		const { root, crumbs } = pathCrumbs("D:/code");
		expect(root).toBe("/");
		expect(crumbs.at(-1)).toEqual({ label: "code", path: "D:\\code" });
	});

	it("never produces the /D:\\code mangled form", () => {
		for (const crumb of pathCrumbs("D:\\code").crumbs) {
			expect(crumb.path.startsWith("/")).toBe(false);
		}
	});
});

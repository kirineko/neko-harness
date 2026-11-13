import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "../../../test/temp-dir.ts";
import {
	gatewayPortFilePath,
	readGatewayPortFile,
	removeGatewayPortFile,
	writeGatewayPortFile,
} from "../src/port-file.ts";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "neko-port-file-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("gateway port file", () => {
	it("writes, reads and removes the port file", async () => {
		await writeGatewayPortFile(dir, "srv-1", "ws://127.0.0.1:8321");
		expect(existsSync(gatewayPortFilePath(dir, "srv-1"))).toBe(true);
		expect(await readGatewayPortFile(dir, "srv-1")).toBe("ws://127.0.0.1:8321");
		await removeGatewayPortFile(dir, "srv-1");
		expect(existsSync(gatewayPortFilePath(dir, "srv-1"))).toBe(false);
	});

	it("treats a missing file as no live gateway", async () => {
		expect(await readGatewayPortFile(dir, "missing")).toBeUndefined();
	});

	it("treats stale garbage content as no live gateway", async () => {
		await writeFile(gatewayPortFilePath(dir, "srv-2"), "not-a-url\n");
		expect(await readGatewayPortFile(dir, "srv-2")).toBeUndefined();
	});

	it("remove is idempotent", async () => {
		await removeGatewayPortFile(dir, "never-existed");
	});
});

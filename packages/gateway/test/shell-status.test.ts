import { expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WindowsShellResolver, WindowsShellStatus } from "@neko-harness/core";
import { Value } from "typebox/value";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import { ApplicationInfoSchema } from "../src/contract.ts";
import { startGateway } from "../src/gateway.ts";
import { connectTestClient, IS_WINDOWS, testSocketPath, trackGateway, waitFor } from "./helpers.ts";

const FOUND: WindowsShellStatus = {
	kind: "found",
	path: "C:\\Program Files\\Git\\bin\\bash.exe",
	source: "auto",
};
const MISSING: WindowsShellStatus = {
	kind: "missing",
	reason: "not_found",
	detail: "No Git Bash was found.",
	searched: [],
};

async function open(shellResolver?: WindowsShellResolver) {
	const dir = await mkdtemp(join(tmpdir(), "neko-shell-status-"));
	const gateway = trackGateway(
		await startGateway({
			storage: "memory",
			storagePath: join(dir, "neko.sqlite"),
			socketPath: testSocketPath(dir),
			port: 0,
			providers: [fauxProvider().provider],
			model: { provider: "faux", modelId: "faux-1" },
			// Windows-only behavior is exercised on every platform through the injected probe.
			...(shellResolver === undefined ? {} : { shellResolver }),
		}),
	);
	return { dir, gateway };
}

it("publishes a ready shell with its path and source", async () => {
	const { dir, gateway } = await open({ status: () => FOUND });
	const client = await connectTestClient(gateway);
	try {
		expect(client.application.info.value.shell).toEqual({ status: "ready", path: FOUND.path, source: "auto" });
	} finally {
		await client.close();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
});

it("publishes a missing shell with its reason", async () => {
	const { dir, gateway } = await open({ status: () => MISSING });
	const client = await connectTestClient(gateway);
	try {
		expect(client.application.info.value.shell).toEqual({
			status: "missing",
			reason: "not_found",
			detail: "No Git Bash was found.",
		});
	} finally {
		await client.close();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
});

it.skipIf(IS_WINDOWS)("omits the shell field on non-Windows gateways", async () => {
	const { dir, gateway } = await open();
	const client = await connectTestClient(gateway);
	try {
		expect(client.application.info.value).not.toHaveProperty("shell");
	} finally {
		await client.close();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
});

it("re-evaluates the shell on every application-info check and publishes the change", async () => {
	let current: WindowsShellStatus = MISSING;
	const { dir, gateway } = await open({
		status: (options) => {
			if (options?.refresh === true) current = FOUND;
			return current;
		},
	});
	const client = await connectTestClient(gateway);
	try {
		expect(client.application.info.value.shell?.status).toBe("missing");
		const checked = await client.application.check(null);
		expect(checked.shell).toEqual({ status: "ready", path: FOUND.path, source: "auto" });
		await waitFor(() => client.application.info.value.shell?.status === "ready", "published ready shell");
	} finally {
		await client.close();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
});

it("still accepts application info without a shell field (older gateways)", () => {
	const legacy = {
		runningVersion: "1.0.0",
		installedVersion: null,
		protocolVersion: 1,
		latestVersion: null,
		checkedAt: null,
		checkState: "unknown",
		serverId: "legacy",
	};
	expect(Value.Check(ApplicationInfoSchema, legacy)).toBe(true);
	expect(Value.Check(ApplicationInfoSchema, { ...legacy, shell: { status: "missing", reason: "not_found" } })).toBe(
		true,
	);
	expect(Value.Check(ApplicationInfoSchema, { ...legacy, shell: { status: "broken" } })).toBe(false);
});

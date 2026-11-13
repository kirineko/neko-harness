import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "../../../../test/temp-dir.ts";
import {
	MOBILE_DEFAULT_PORT,
	MOBILE_STATE_FORMAT_VERSION,
	type MobileDeviceRecord,
	type MobilePairReceipt,
	MobileStore,
	readSecretFile,
	writeSecretFile,
} from "../../src/mobile/store.ts";

const IS_WINDOWS = process.platform === "win32";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "neko-mobile-store-"));
});
afterEach(async () => {
	await chmod(join(dir, "mobile"), 0o700).catch(() => undefined);
	await rm(dir, { recursive: true, force: true });
});

function credentialHash(): string {
	return createHash("sha256").update(randomBytes(32)).digest("hex");
}

function device(overrides: Partial<MobileDeviceRecord> = {}): MobileDeviceRecord {
	return {
		deviceId: randomUUID(),
		name: "Pixel 9",
		credentialHash: credentialHash(),
		grantRevision: 1,
		pairedAt: 1_728_883_200_000,
		lastSeenAt: 1_728_883_200_000,
		...overrides,
	};
}

function receipt(overrides: Partial<MobilePairReceipt> = {}): MobilePairReceipt {
	return {
		pairRequestId: randomUUID(),
		deviceId: randomUUID(),
		credentialHash: credentialHash(),
		grantRevision: 1,
		expiresAt: 1_728_889_800_000,
		...overrides,
	};
}

describe("mobile store", () => {
	it("starts disabled with default state and creates the mobile directories", async () => {
		const store = await MobileStore.open(dir);
		expect(store.getState()).toEqual({
			formatVersion: MOBILE_STATE_FORMAT_VERSION,
			enabled: false,
			address: null,
			port: MOBILE_DEFAULT_PORT,
			devices: [],
			receipts: [],
			lastConnectedAddress: null,
		});
		expect(existsSync(store.statePath)).toBe(false);
		expect(existsSync(store.mobileDir)).toBe(true);
		expect(existsSync(store.tlsDir)).toBe(true);
	});

	it("reads back persisted config, devices and receipts after reopening", async () => {
		const store = await MobileStore.open(dir);
		const deviceA = device();
		const deviceB = device();
		const receiptA = receipt({ deviceId: deviceA.deviceId, credentialHash: deviceA.credentialHash });
		await store.updateConfig({ enabled: true, address: "192.168.1.20", port: 8323 });
		await store.upsertDevice(deviceA);
		await store.upsertDevice(deviceB);
		const final = await store.putReceipt(receiptA);

		const reopened = await MobileStore.open(dir);
		expect(reopened.getState()).toEqual(final);
		expect(JSON.parse(await readFile(reopened.statePath, "utf8")) as unknown).toEqual(final);

		await reopened.updateConfig({ enabled: false, address: null });
		const reread = await MobileStore.open(dir);
		expect(reread.getState().enabled).toBe(false);
		expect(reread.getState().address).toBeNull();
		expect(reread.getState().devices).toEqual([deviceA, deviceB]);
		expect(reread.getState().receipts).toEqual([receiptA]);
	});

	it("replaces devices and receipts by id and removes them", async () => {
		const store = await MobileStore.open(dir);
		const original = device();
		await store.upsertDevice(original);
		const replacement = { ...original, name: "renamed", grantRevision: 2, credentialHash: credentialHash() };
		const state = await store.upsertDevice(replacement);
		expect(state.devices).toEqual([replacement]);

		const pairReceipt = receipt({ deviceId: original.deviceId });
		await store.putReceipt(pairReceipt);
		const withoutDevice = await store.removeDevice(original.deviceId);
		expect(withoutDevice.devices).toEqual([]);
		expect(withoutDevice.receipts).toEqual([pairReceipt]);
		const withoutReceipt = await store.removeReceipt(pairReceipt.pairRequestId);
		expect(withoutReceipt.receipts).toEqual([]);
	});

	it("persists a device and its pairing receipt in one atomic write", async () => {
		const store = await MobileStore.open(dir);
		const hash = credentialHash();
		const pairedAt = Date.now();
		const state = await store.completePairing({
			pairRequestId: "req-1",
			deviceId: "dev-1",
			name: "Pixel 9",
			credentialHash: hash,
			pairedAt,
			receiptExpiresAt: pairedAt + 600_000,
		});
		expect(state.devices).toHaveLength(1);
		expect(state.devices[0]).toEqual({
			deviceId: "dev-1",
			name: "Pixel 9",
			credentialHash: hash,
			grantRevision: 1,
			pairedAt,
			lastSeenAt: pairedAt,
		});
		expect(state.receipts).toHaveLength(1);
		expect(state.receipts[0]).toEqual({
			pairRequestId: "req-1",
			deviceId: "dev-1",
			credentialHash: hash,
			grantRevision: 1,
			expiresAt: pairedAt + 600_000,
		});
		expect(JSON.parse(await readFile(store.statePath, "utf8")) as unknown).toEqual(state);

		const replacedHash = credentialHash();
		const rePairedAt = pairedAt + 60_000;
		const again = await store.completePairing({
			pairRequestId: "req-2",
			deviceId: "dev-1",
			name: "Pixel 10",
			credentialHash: replacedHash,
			pairedAt: rePairedAt,
			receiptExpiresAt: rePairedAt + 600_000,
		});
		expect(again.devices).toHaveLength(1);
		expect(again.devices[0]).toEqual({
			deviceId: "dev-1",
			name: "Pixel 10",
			credentialHash: replacedHash,
			grantRevision: 2,
			pairedAt: rePairedAt,
			lastSeenAt: rePairedAt,
		});
		expect(again.receipts).toHaveLength(2);

		const reopened = await MobileStore.open(dir);
		expect(reopened.getState()).toEqual(again);
	});

	it.skipIf(IS_WINDOWS)("completePairing failure leaves neither a device nor a receipt behind", async () => {
		const store = await MobileStore.open(dir);
		await store.updateConfig({ enabled: true, port: 8324 });
		const diskBefore = await readFile(store.statePath, "utf8");
		await chmod(store.mobileDir, 0o500);
		try {
			await expect(
				store.completePairing({
					pairRequestId: "req-1",
					deviceId: "dev-1",
					name: "Pixel 9",
					credentialHash: credentialHash(),
					pairedAt: Date.now(),
					receiptExpiresAt: Date.now() + 600_000,
				}),
			).rejects.toThrow();
		} finally {
			await chmod(store.mobileDir, 0o700);
		}
		expect(store.getState().devices).toEqual([]);
		expect(store.getState().receipts).toEqual([]);
		expect(await readFile(store.statePath, "utf8")).toBe(diskBefore);
	});

	it("persists the last connected address and deduplicates repeated writes", async () => {
		const store = await MobileStore.open(dir);
		expect(store.getState().lastConnectedAddress).toBeNull();

		const first = await store.rememberConnectedAddress("192.168.31.71");
		expect(first.lastConnectedAddress).toBe("192.168.31.71");
		expect(JSON.parse(await readFile(store.statePath, "utf8")) as unknown).toEqual(first);

		const reopened = await MobileStore.open(dir);
		expect(reopened.getState().lastConnectedAddress).toBe("192.168.31.71");

		const diskBefore = await readFile(store.statePath, "utf8");
		const again = await store.rememberConnectedAddress("192.168.31.71");
		expect(again.lastConnectedAddress).toBe("192.168.31.71");
		expect(await readFile(store.statePath, "utf8")).toBe(diskBefore);

		const replaced = await store.rememberConnectedAddress("10.0.0.5");
		expect(replaced.lastConnectedAddress).toBe("10.0.0.5");
		expect((await MobileStore.open(dir)).getState().lastConnectedAddress).toBe("10.0.0.5");
	});

	it("loads a legacy state file without lastConnectedAddress as null", async () => {
		const stateDir = join(dir, "legacy");
		const statePath = join(stateDir, "mobile", "state.json");
		await mkdir(join(stateDir, "mobile"), { recursive: true });
		await writeFile(
			statePath,
			JSON.stringify({
				formatVersion: MOBILE_STATE_FORMAT_VERSION,
				enabled: true,
				address: "192.168.1.20",
				port: MOBILE_DEFAULT_PORT,
				devices: [],
				receipts: [],
			}),
			"utf8",
		);

		const store = await MobileStore.open(stateDir);
		expect(store.getState().enabled).toBe(true);
		expect(store.getState().lastConnectedAddress).toBeNull();
		// 旧文件照常可写回（补齐字段）。
		const updated = await store.rememberConnectedAddress("192.168.1.20");
		expect(updated.lastConnectedAddress).toBe("192.168.1.20");
	});

	it("returns the updated state from mutations", async () => {
		const store = await MobileStore.open(dir);
		const state = await store.updateConfig({ enabled: true });
		expect(state.enabled).toBe(true);
		expect(store.getState()).toEqual(state);
	});

	it.skipIf(IS_WINDOWS)("rejects failed writes without changing memory or disk state", async () => {
		const store = await MobileStore.open(dir);
		const before = await store.updateConfig({ enabled: true, port: 8324 });
		const diskBefore = await readFile(store.statePath, "utf8");

		await chmod(store.mobileDir, 0o500);
		try {
			await expect(store.updateConfig({ port: 9000 })).rejects.toThrow();
			await expect(store.upsertDevice(device())).rejects.toThrow();
		} finally {
			await chmod(store.mobileDir, 0o700);
		}

		expect(store.getState()).toEqual(before);
		expect(await readFile(store.statePath, "utf8")).toBe(diskBefore);

		const after = await store.updateConfig({ enabled: false });
		expect(after.port).toBe(8324);
		expect(after.enabled).toBe(false);
	});

	const corruptCases: ReadonlyArray<{ readonly name: string; readonly content: string }> = [
		{ name: "not JSON", content: "{ not json" },
		{
			name: "wrong formatVersion",
			content: JSON.stringify({
				formatVersion: 99,
				enabled: false,
				address: null,
				port: MOBILE_DEFAULT_PORT,
				devices: [],
				receipts: [],
			}),
		},
		{
			name: "invalid field type",
			content: JSON.stringify({
				formatVersion: MOBILE_STATE_FORMAT_VERSION,
				enabled: "yes",
				address: null,
				port: MOBILE_DEFAULT_PORT,
				devices: [],
				receipts: [],
			}),
		},
		{
			name: "invalid device entry",
			content: JSON.stringify({
				formatVersion: MOBILE_STATE_FORMAT_VERSION,
				enabled: false,
				address: null,
				port: MOBILE_DEFAULT_PORT,
				devices: [{ deviceId: "", name: "x", credentialHash: "zz", grantRevision: -1, pairedAt: 1, lastSeenAt: 1 }],
				receipts: [],
			}),
		},
		{
			name: "lastConnectedAddress invalid type",
			content: JSON.stringify({
				formatVersion: MOBILE_STATE_FORMAT_VERSION,
				enabled: false,
				address: null,
				port: MOBILE_DEFAULT_PORT,
				devices: [],
				receipts: [],
				lastConnectedAddress: 123,
			}),
		},
		{
			name: "receipts not an array",
			content: JSON.stringify({
				formatVersion: MOBILE_STATE_FORMAT_VERSION,
				enabled: false,
				address: null,
				port: MOBILE_DEFAULT_PORT,
				devices: [],
				receipts: {},
			}),
		},
	];
	for (const corrupt of corruptCases) {
		it(`refuses to open and does not overwrite corrupt state (${corrupt.name})`, async () => {
			const stateDir = join(dir, "case");
			const statePath = join(stateDir, "mobile", "state.json");
			await mkdir(join(stateDir, "mobile"), { recursive: true });
			await writeFile(statePath, corrupt.content, "utf8");

			await expect(MobileStore.open(stateDir)).rejects.toThrow(statePath);
			expect(await readFile(statePath, "utf8")).toBe(corrupt.content);
		});
	}

	it("serializes concurrent updates without lost updates and leaves no temp files", async () => {
		const store = await MobileStore.open(dir);
		const devices = Array.from({ length: 16 }, () => device());
		const bad = store.updateConfig({ port: 70000 });
		const good = Promise.all([
			...devices.map((d) => store.upsertDevice(d)),
			store.updateConfig({ enabled: true, address: "10.0.0.5" }),
			store.putReceipt(receipt()),
		]);
		await expect(bad).rejects.toThrow("port must be an integer");
		await good;

		const barrier = await store.upsertDevice(device());
		const state = store.getState();
		expect(state.devices).toHaveLength(17);
		expect(state.enabled).toBe(true);
		expect(state.address).toBe("10.0.0.5");
		expect(state.port).toBe(MOBILE_DEFAULT_PORT);
		for (const d of devices) {
			expect(state.devices.some((x) => x.deviceId === d.deviceId)).toBe(true);
		}
		expect(barrier.devices).toEqual(state.devices);

		expect(JSON.parse(await readFile(store.statePath, "utf8")) as unknown).toEqual(state);
		expect((await readdir(store.mobileDir)).sort()).toEqual(["state.json", "tls"]);
	});

	it.skipIf(IS_WINDOWS)("applies explicit POSIX permissions to directories, state, token and secrets", async () => {
		const store = await MobileStore.open(dir);
		await store.updateConfig({ enabled: true });
		await store.ensureAdminToken();
		const keyPath = join(store.tlsDir, "key.pem");
		await writeSecretFile(keyPath, "secret-material");

		const mode = async (target: string) => (await stat(target)).mode & 0o777;
		expect(await mode(store.mobileDir)).toBe(0o700);
		expect(await mode(store.tlsDir)).toBe(0o700);
		expect(await mode(store.statePath)).toBe(0o600);
		expect(await mode(store.adminTokenPath)).toBe(0o600);
		expect(await mode(keyPath)).toBe(0o600);
	});

	it("generates a 32-byte random admin token that is stable across restarts", async () => {
		const store = await MobileStore.open(dir);
		const token = await store.ensureAdminToken();
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(Buffer.from(token, "base64url")).toHaveLength(32);

		expect(await store.ensureAdminToken()).toBe(token);

		const reopened = await MobileStore.open(dir);
		expect(await reopened.ensureAdminToken()).toBe(token);
		const onDisk = await readSecretFile(reopened.adminTokenPath);
		expect(onDisk?.trim()).toBe(token);

		const otherDir = await mkdtemp(join(tmpdir(), "neko-mobile-store-other-"));
		try {
			const other = await MobileStore.open(otherDir);
			expect(await other.ensureAdminToken()).not.toBe(token);
		} finally {
			await rm(otherDir, { recursive: true, force: true });
		}
	});

	it("rejects an invalid admin token file with a readable error", async () => {
		const store = await MobileStore.open(dir);
		await writeFile(store.adminTokenPath, "garbage-not-a-token\n", { mode: 0o600 });
		await expect(store.ensureAdminToken()).rejects.toThrow(store.adminTokenPath);
	});
});

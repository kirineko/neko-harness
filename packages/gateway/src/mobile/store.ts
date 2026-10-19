import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renameWithRetry } from "@neko-harness/core";

export const MOBILE_STATE_FORMAT_VERSION = 1;
export const MOBILE_DEFAULT_PORT = 8323;

const MOBILE_ADMIN_TOKEN_BYTES = 32;
const POSIX = process.platform !== "win32";
const ADMIN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CREDENTIAL_HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

export type MobileDeviceRecord = {
	readonly deviceId: string;
	readonly name: string;
	readonly credentialHash: string;
	readonly grantRevision: number;
	readonly pairedAt: number;
	readonly lastSeenAt: number;
};

export type MobilePairReceipt = {
	readonly pairRequestId: string;
	readonly deviceId: string;
	readonly credentialHash: string;
	readonly grantRevision: number;
	readonly expiresAt: number;
};

export type MobileStoreState = {
	readonly formatVersion: typeof MOBILE_STATE_FORMAT_VERSION;
	readonly enabled: boolean;
	readonly address: string | null;
	readonly port: number;
	readonly devices: readonly MobileDeviceRecord[];
	readonly receipts: readonly MobilePairReceipt[];
	/** 手机最近一次成功接入时 listener socket 的本地地址；未知为 null（旧 state.json 缺该字段）。 */
	readonly lastConnectedAddress: string | null;
};

export type MobileConfigPatch = {
	readonly enabled?: boolean;
	readonly address?: string | null;
	readonly port?: number;
};

export type MobileCompletePairingInput = {
	readonly pairRequestId: string;
	readonly deviceId: string;
	readonly name: string;
	readonly credentialHash: string;
	readonly pairedAt: number;
	readonly receiptExpiresAt: number;
};

function defaultState(): MobileStoreState {
	return {
		formatVersion: MOBILE_STATE_FORMAT_VERSION,
		enabled: false,
		address: null,
		port: MOBILE_DEFAULT_PORT,
		devices: [],
		receipts: [],
		lastConnectedAddress: null,
	};
}

function freezeState(state: MobileStoreState): MobileStoreState {
	for (const device of state.devices) Object.freeze(device);
	Object.freeze(state.devices);
	for (const receipt of state.receipts) Object.freeze(receipt);
	Object.freeze(state.receipts);
	return Object.freeze(state);
}

function isNotFound(error: unknown): boolean {
	return (error as { code?: unknown } | null | undefined)?.code === "ENOENT";
}

function invalidState(statePath: string, detail: string): Error {
	return new Error(`Invalid mobile state file ${statePath}: ${detail}`);
}

function readString(value: unknown, what: string, statePath: string): string {
	if (typeof value !== "string") throw invalidState(statePath, `${what} must be a string`);
	return value;
}

function readNonEmptyString(value: unknown, what: string, statePath: string): string {
	const text = readString(value, what, statePath);
	if (text === "") throw invalidState(statePath, `${what} must be a non-empty string`);
	return text;
}

function readCredentialHash(value: unknown, what: string, statePath: string): string {
	const text = readString(value, what, statePath);
	if (!CREDENTIAL_HASH_PATTERN.test(text)) throw invalidState(statePath, `${what} must be a 64-character hex string`);
	return text;
}

function readRevision(value: unknown, what: string, statePath: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw invalidState(statePath, `${what} must be a non-negative integer`);
	return value;
}

function readTimestamp(value: unknown, what: string, statePath: string): number {
	if (typeof value !== "number" || !Number.isFinite(value))
		throw invalidState(statePath, `${what} must be a finite number`);
	return value;
}

function parseDevice(raw: unknown, index: number, statePath: string): MobileDeviceRecord {
	const what = `devices[${index}]`;
	if (typeof raw !== "object" || raw === null) throw invalidState(statePath, `${what} must be an object`);
	const record = raw as Record<string, unknown>;
	return {
		deviceId: readNonEmptyString(record.deviceId, `${what}.deviceId`, statePath),
		name: readString(record.name, `${what}.name`, statePath),
		credentialHash: readCredentialHash(record.credentialHash, `${what}.credentialHash`, statePath),
		grantRevision: readRevision(record.grantRevision, `${what}.grantRevision`, statePath),
		pairedAt: readTimestamp(record.pairedAt, `${what}.pairedAt`, statePath),
		lastSeenAt: readTimestamp(record.lastSeenAt, `${what}.lastSeenAt`, statePath),
	};
}

function parseReceipt(raw: unknown, index: number, statePath: string): MobilePairReceipt {
	const what = `receipts[${index}]`;
	if (typeof raw !== "object" || raw === null) throw invalidState(statePath, `${what} must be an object`);
	const record = raw as Record<string, unknown>;
	return {
		pairRequestId: readNonEmptyString(record.pairRequestId, `${what}.pairRequestId`, statePath),
		deviceId: readNonEmptyString(record.deviceId, `${what}.deviceId`, statePath),
		credentialHash: readCredentialHash(record.credentialHash, `${what}.credentialHash`, statePath),
		grantRevision: readRevision(record.grantRevision, `${what}.grantRevision`, statePath),
		expiresAt: readTimestamp(record.expiresAt, `${what}.expiresAt`, statePath),
	};
}

function parseState(raw: unknown, statePath: string): MobileStoreState {
	if (typeof raw !== "object" || raw === null) throw invalidState(statePath, "root must be an object");
	const record = raw as Record<string, unknown>;
	if (record.formatVersion !== MOBILE_STATE_FORMAT_VERSION)
		throw invalidState(statePath, `unsupported formatVersion (expected ${MOBILE_STATE_FORMAT_VERSION})`);
	if (typeof record.enabled !== "boolean") throw invalidState(statePath, "enabled must be a boolean");
	if (record.address !== null && typeof record.address !== "string")
		throw invalidState(statePath, "address must be a string or null");
	const port = record.port;
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
		throw invalidState(statePath, "port must be an integer between 1 and 65535");
	if (!Array.isArray(record.devices)) throw invalidState(statePath, "devices must be an array");
	if (!Array.isArray(record.receipts)) throw invalidState(statePath, "receipts must be an array");
	const lastConnectedAddress =
		record.lastConnectedAddress === undefined || record.lastConnectedAddress === null
			? null
			: readString(record.lastConnectedAddress, "lastConnectedAddress", statePath);
	return {
		formatVersion: MOBILE_STATE_FORMAT_VERSION,
		enabled: record.enabled,
		address: record.address,
		port,
		devices: record.devices.map((device, index) => parseDevice(device, index, statePath)),
		receipts: record.receipts.map((receipt, index) => parseReceipt(receipt, index, statePath)),
		lastConnectedAddress,
	};
}

function assertPort(port: number): number {
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error("port must be an integer between 1 and 65535");
	return port;
}

let tempCounter = 0;

async function writeFileAtomic(filePath: string, contents: string, mode: number): Promise<void> {
	const tempPath = `${filePath}.tmp-${process.pid}-${++tempCounter}`;
	try {
		await writeFile(tempPath, contents, { mode });
		if (POSIX) await chmod(tempPath, mode);
		await renameWithRetry(tempPath, filePath);
	} catch (error) {
		await rm(tempPath, { force: true });
		throw error;
	}
}

export async function writeSecretFile(filePath: string, contents: string): Promise<void> {
	await writeFileAtomic(filePath, contents, 0o600);
}

export async function readSecretFile(filePath: string): Promise<string | undefined> {
	try {
		return await readFile(filePath, "utf8");
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw error;
	}
}

async function loadState(statePath: string): Promise<MobileStoreState> {
	let raw: string;
	try {
		raw = await readFile(statePath, "utf8");
	} catch (error) {
		if (isNotFound(error)) return freezeState(defaultState());
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw invalidState(statePath, "not valid JSON");
	}
	return freezeState(parseState(parsed, statePath));
}

export class MobileStore {
	readonly mobileDir: string;
	readonly tlsDir: string;
	readonly statePath: string;
	readonly adminTokenPath: string;

	private current: MobileStoreState;
	private queue: Promise<unknown> = Promise.resolve();

	private constructor(mobileDir: string, initial: MobileStoreState) {
		this.mobileDir = mobileDir;
		this.tlsDir = join(mobileDir, "tls");
		this.statePath = join(mobileDir, "state.json");
		this.adminTokenPath = join(mobileDir, "admin-token");
		this.current = initial;
	}

	static async open(nekoDir: string): Promise<MobileStore> {
		const mobileDir = join(nekoDir, "mobile");
		const tlsDir = join(mobileDir, "tls");
		await mkdir(mobileDir, { recursive: true, mode: 0o700 });
		await mkdir(tlsDir, { recursive: true, mode: 0o700 });
		if (POSIX) {
			await chmod(mobileDir, 0o700);
			await chmod(tlsDir, 0o700);
		}
		return new MobileStore(mobileDir, await loadState(join(mobileDir, "state.json")));
	}

	getState(): MobileStoreState {
		return this.current;
	}

	updateConfig(patch: MobileConfigPatch): Promise<MobileStoreState> {
		return this.mutate((state) => ({
			...state,
			...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
			...(patch.address !== undefined ? { address: patch.address } : {}),
			...(patch.port !== undefined ? { port: assertPort(patch.port) } : {}),
		}));
	}

	upsertDevice(device: MobileDeviceRecord): Promise<MobileStoreState> {
		return this.mutate((state) => ({
			...state,
			devices: state.devices.some((d) => d.deviceId === device.deviceId)
				? state.devices.map((d) => (d.deviceId === device.deviceId ? device : d))
				: [...state.devices, device],
		}));
	}

	removeDevice(deviceId: string): Promise<MobileStoreState> {
		return this.mutate((state) => ({
			...state,
			devices: state.devices.filter((d) => d.deviceId !== deviceId),
		}));
	}

	completePairing(input: MobileCompletePairingInput): Promise<MobileStoreState> {
		return this.mutate((state) => {
			const now = Date.now();
			const existing = state.devices.find((d) => d.deviceId === input.deviceId);
			const grantRevision = existing === undefined ? 1 : existing.grantRevision + 1;
			const device: MobileDeviceRecord = {
				deviceId: input.deviceId,
				name: input.name,
				credentialHash: input.credentialHash,
				grantRevision,
				pairedAt: input.pairedAt,
				lastSeenAt: input.pairedAt,
			};
			const receipt: MobilePairReceipt = {
				pairRequestId: input.pairRequestId,
				deviceId: input.deviceId,
				credentialHash: input.credentialHash,
				grantRevision,
				expiresAt: input.receiptExpiresAt,
			};
			return {
				...state,
				devices:
					existing === undefined
						? [...state.devices, device]
						: state.devices.map((d) => (d.deviceId === input.deviceId ? device : d)),
				receipts: [
					...state.receipts.filter((r) => r.expiresAt > now && r.pairRequestId !== input.pairRequestId),
					receipt,
				],
			};
		});
	}

	putReceipt(receipt: MobilePairReceipt): Promise<MobileStoreState> {
		return this.mutate((state) => ({
			...state,
			receipts: state.receipts.some((r) => r.pairRequestId === receipt.pairRequestId)
				? state.receipts.map((r) => (r.pairRequestId === receipt.pairRequestId ? receipt : r))
				: [...state.receipts, receipt],
		}));
	}

	removeReceipt(pairRequestId: string): Promise<MobileStoreState> {
		return this.mutate((state) => ({
			...state,
			receipts: state.receipts.filter((r) => r.pairRequestId !== pairRequestId),
		}));
	}

	touchDevice(deviceId: string, lastSeenAt: number): Promise<MobileStoreState> {
		return this.mutate((state) => {
			const existing = state.devices.find((d) => d.deviceId === deviceId);
			if (existing === undefined) return state;
			return {
				...state,
				devices: state.devices.map((d) => (d.deviceId === deviceId ? { ...d, lastSeenAt } : d)),
			};
		});
	}

	/** 记录手机最近一次成功接入的 listener 本地地址（重复值不触发落盘）。 */
	rememberConnectedAddress(address: string): Promise<MobileStoreState> {
		if (this.current.lastConnectedAddress === address) return Promise.resolve(this.current);
		return this.mutate((state) => ({ ...state, lastConnectedAddress: address }));
	}

	clearMobileAuthorizations(): Promise<MobileStoreState> {
		return this.mutate((state) => ({ ...state, devices: [], receipts: [] }));
	}

	ensureAdminToken(): Promise<string> {
		return this.enqueue(async () => {
			const existing = await readSecretFile(this.adminTokenPath);
			if (existing !== undefined) {
				const token = existing.trim();
				if (ADMIN_TOKEN_PATTERN.test(token)) return token;
				throw new Error(`Invalid mobile admin token file ${this.adminTokenPath}: expected a base64url token`);
			}
			const token = randomBytes(MOBILE_ADMIN_TOKEN_BYTES).toString("base64url");
			await writeSecretFile(this.adminTokenPath, `${token}\n`);
			return token;
		});
	}

	private mutate(recipe: (state: MobileStoreState) => MobileStoreState): Promise<MobileStoreState> {
		return this.enqueue(async () => {
			const next = freezeState(recipe(this.current));
			await writeFileAtomic(this.statePath, `${JSON.stringify(next, null, "\t")}\n`, 0o600);
			this.current = next;
			return next;
		});
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task);
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}
}

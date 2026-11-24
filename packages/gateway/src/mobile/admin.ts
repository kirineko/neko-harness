import { createHash, timingSafeEqual } from "node:crypto";
import { ChordError, str as chordStr, forbidden, method, remote } from "@earendil-works/chord";
import { arr, bool, int, lit, nul, obj, opt, str, union } from "@earendil-works/pi-schema";
import { type ClientRef, GATEWAY_ADDRESS } from "../contract.ts";
import { type GatewayPrincipal, isMobilePrincipal } from "../principal.ts";
import type { MobileGateway } from "./listener.ts";
import { MobileStore } from "./store.ts";

const listenerStateSchema = union([
	obj({ status: lit("disabled") }, { open: true }),
	obj({ status: lit("starting") }, { open: true }),
	obj(
		{
			status: lit("listening"),
			address: str(),
			port: int({ minimum: 1, maximum: 65535 }),
			bindAddress: opt(str()),
			mode: opt(union([lit("direct"), lit("wsl-relay")])),
		},
		{ open: true },
	),
	obj({ status: lit("error"), error: str() }, { open: true }),
	obj({ status: lit("stopping") }, { open: true }),
]);

const adminDeviceSchema = obj(
	{
		deviceId: str(),
		name: str(),
		pairedAt: int(),
		lastSeenAt: int(),
		online: bool(),
	},
	{ open: true },
);

export const NekoMobileAdmin = remote("neko.mobile-admin", {
	version: 1,
	params: { token: chordStr() },
	hostAddress: () => GATEWAY_ADDRESS,
	variants: {
		admin: {
			methods: {
				status: method(
					undefined,
					obj(
						{
							state: listenerStateSchema,
							candidates: arr(str()),
							port: int({ minimum: 1, maximum: 65535 }),
							certificate: union([obj({ fingerprint: str(), expiresAt: int() }, { open: true }), nul()]),
							devices: arr(adminDeviceSchema),
							lastConnectedAddress: union([str(), nul()]),
							wsl: opt(union([obj({ interop: bool(), error: union([str(), nul()]) }, { open: true }), nul()])),
						},
						{ open: true },
					),
				),
				enable: method(
					obj({
						address: str(),
						port: opt(int({ minimum: 1, maximum: 65535 })),
					}),
					obj(
						{
							status: lit("listening"),
							address: str(),
							port: int({ minimum: 1, maximum: 65535 }),
							bindAddress: opt(str()),
							mode: opt(union([lit("direct"), lit("wsl-relay")])),
						},
						{ open: true },
					),
				),
				disable: method(undefined, listenerStateSchema),
				createPairing: method(undefined, obj({ pairingText: str(), expiresAt: int() }, { open: true })),
				cancelPairing: method(),
				revoke: method(obj({ deviceId: str({ minLength: 1 }) }), obj({ revoked: bool() }, { open: true })),
				regenerateCertificate: method(undefined, obj({ fingerprint: str(), expiresAt: int() }, { open: true })),
			},
		},
	},
});
export type NekoMobileAdmin = ClientRef<typeof NekoMobileAdmin>;

export type NekoMobileAdminInput = { readonly token: string };
export type NekoMobileAdminHandle = ClientRef<typeof NekoMobileAdmin>;

function digest(value: string): Buffer {
	return createHash("sha256").update(value, "utf8").digest();
}

async function tokenMatches(token: string, store: MobileStore | undefined): Promise<boolean> {
	if (store === undefined) return false;
	let adminToken: string;
	try {
		adminToken = await store.ensureAdminToken();
	} catch {
		return false;
	}
	const expected = digest(adminToken);
	const provided = digest(token);
	return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export type MobileAdminDeps = {
	readonly mobile: MobileGateway;
	readonly store: MobileStore | undefined;
};

export type MobileAdminDepsProvider = MobileAdminDeps | (() => MobileAdminDeps | undefined);

/** Web/脚本等服务端进程读取（首次则安全创建）与 gateway 同一的 admin-token 文件；绝不向浏览器提供。 */
export async function readOrCreateMobileAdminToken(nekoDir: string): Promise<string> {
	return (await MobileStore.open(nekoDir)).ensureAdminToken();
}

function resolveDeps(source: MobileAdminDepsProvider): MobileAdminDeps {
	const deps = typeof source === "function" ? source() : source;
	if (deps === undefined) throw new ChordError({ code: "unavailable", message: "mobile gateway is not ready" });
	return deps;
}

/** D5 admin 服务（任务 4.1 完整方法集；createGatewayConnection 不绑定本契约）。 */
export function createMobileAdminFactory(depsSource: MobileAdminDepsProvider) {
	return (input: NekoMobileAdminInput, principal: GatewayPrincipal) => {
		if (isMobilePrincipal(principal)) throw forbidden("mobile principals cannot administer pairing");
		const guard = async (): Promise<MobileAdminDeps> => {
			const deps = resolveDeps(depsSource);
			if (!(await tokenMatches(input.token, deps.store))) throw forbidden("forbidden");
			return deps;
		};
		return {
			variant: "admin" as const,
			members: {
				async status() {
					const deps = await guard();
					return deps.mobile.adminState();
				},
				async enable(params: { readonly address: string; readonly port?: number }) {
					const deps = await guard();
					const state = await deps.mobile.enable({ address: params.address, port: params.port });
					if (state.status !== "listening")
						throw new ChordError({ code: "unavailable", message: `mobile listener failed: ${state.status}` });
					return state;
				},
				async disable() {
					const deps = await guard();
					return deps.mobile.disable();
				},
				async createPairing() {
					const deps = await guard();
					return deps.mobile.createPairing();
				},
				async cancelPairing() {
					const deps = await guard();
					deps.mobile.cancelPairing();
					return null;
				},
				async revoke(params: { readonly deviceId: string }) {
					const deps = await guard();
					return { revoked: await deps.mobile.revoke(params.deviceId) };
				},
				async regenerateCertificate() {
					const deps = await guard();
					return deps.mobile.regenerateCertificate();
				},
			},
		};
	};
}

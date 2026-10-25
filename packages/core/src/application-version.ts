/** Release builds replace these literals; workspace execution never trusts environment values. */
declare const NEKO_BUILD_VERSION: string;
export const RUNNING_VERSION = typeof NEKO_BUILD_VERSION === "undefined" ? "development" : NEKO_BUILD_VERSION;
export const APPLICATION_PROTOCOL = 10;
export function upgradeCommand(platform: string): string {
	return platform === "win32" ? "bun add --global neko-harness@latest" : "neko update";
}
export type UpdateState = {
	runningVersion: string;
	installedVersion: string | null;
	protocolVersion: number;
	latestVersion: string | null;
	checkedAt: number | null;
	checkState: "unknown" | "checking" | "ok" | "failed" | "development";
};
export function stableVersion(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) &&
		value.split(".").every((n) => Number.isSafeInteger(Number(n)))
	);
}
export function newer(left: string | null | undefined, right: string | null | undefined): boolean {
	if (!stableVersion(left) || !stableVersion(right)) return false;
	const a = left.split(".").map(Number),
		b = right.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i]! > b[i]!;
	}
	return false;
}
export type UpdateAction = "none" | "install" | "restart-service" | "restart-tui" | "refresh-page" | "incompatible";
export function updateAction(input: {
	gateway: UpdateState | null;
	frontend: string;
	installed: string | null;
	web?: { runningVersion: string; installedVersion: string | null };
}): UpdateAction {
	const { gateway, frontend, installed, web } = input;
	if (gateway && gateway.protocolVersion !== APPLICATION_PROTOCOL) return "incompatible";
	if (
		gateway &&
		(newer(gateway.installedVersion, gateway.runningVersion) ||
			newer(installed, gateway.runningVersion) ||
			newer(frontend, gateway.runningVersion))
	)
		return "restart-service";
	if (
		web &&
		(newer(web.installedVersion, web.runningVersion) ||
			newer(gateway?.runningVersion, web.runningVersion) ||
			newer(frontend, web.runningVersion))
	)
		return "restart-service";
	if (web) {
		if (newer(web.runningVersion, frontend)) return "refresh-page";
	} else if (newer(installed, frontend) || newer(gateway?.runningVersion, frontend)) return "restart-tui";
	if (gateway?.checkState === "ok" && newer(gateway.latestVersion, installed)) return "install";
	return "none";
}
export class ApplicationProtocolError extends Error {
	constructor() {
		super("Application protocol incompatible. Update neko, then restart its TUI/Web or serve.");
		this.name = "ApplicationProtocolError";
	}
}

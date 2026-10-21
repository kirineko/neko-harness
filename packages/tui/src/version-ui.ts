import { matchesKey, Text } from "@earendil-works/pi-tui";
import {
	newer,
	RUNNING_VERSION,
	stableVersion,
	type UpdateState,
	updateAction,
	upgradeCommand,
} from "@neko-harness/core/application-version";
import type { PickerDetail, PickerPanel } from "./components/picker.ts";
import { t } from "./i18n/index.ts";

type VersionOptions = { runningVersion?: string; platform?: NodeJS.Platform };
function actionFor(state: UpdateState | null, installed: string | null, runningVersion: string) {
	const action = updateAction({ gateway: state, frontend: runningVersion, installed });
	// A newer running build must never be directed to install an older registry version.
	return action === "install" && !newer(state?.latestVersion, runningVersion) ? "none" : action;
}
export function versionNotice(
	state: UpdateState | null,
	installed: string | null,
	options: VersionOptions = {},
): string {
	const action = actionFor(state, installed, options.runningVersion ?? RUNNING_VERSION);
	return {
		none: "",
		install: t("version.notice.install", { command: upgradeCommand(options.platform ?? process.platform) }),
		"restart-service": t("version.notice.restartService"),
		"restart-tui": t("version.notice.restartTui"),
		"refresh-page": "",
		incompatible: t("version.notice.incompatible"),
	}[action];
}
export function versionOverview(
	state: UpdateState | null,
	installed: string | null,
	options: VersionOptions = {},
): string {
	const running = options.runningVersion ?? RUNNING_VERSION;
	const command = upgradeCommand(options.platform ?? process.platform);
	const current = t("version.current", { version: stableVersion(running) ? `v${running}` : running });
	const action = actionFor(state, installed, running);
	let status: string;
	switch (action) {
		case "incompatible":
			status = t("version.incompatible", { command });
			break;
		case "restart-service":
			status = t("version.restartService");
			break;
		case "restart-tui":
			status = t("version.restartTui");
			break;
		case "install":
			status = t("version.install", { latest: state!.latestVersion ?? "", command });
			break;
		default:
			if (!stableVersion(running) || state?.checkState === "development") status = t("version.development");
			else if (!state) status = t("version.unavailable");
			else if (state.checkState === "checking") status = t("version.checking");
			else if (state.checkState === "failed") status = t("version.checkFailed");
			else if (state.checkState === "unknown") status = t("version.notChecked");
			else if (
				!stableVersion(installed) ||
				!stableVersion(state.installedVersion) ||
				!stableVersion(state.runningVersion) ||
				!stableVersion(state.latestVersion) ||
				state.checkedAt === null
			)
				status = t("version.unavailable");
			else status = t("version.upToDate");
	}
	// A failed explicit check stays visible even when an actionable restart has priority.
	if (state?.checkState === "failed" && !status.includes(t("version.checkFailed")))
		status += `\n${t("version.checkFailed")}`;
	return `${current}\n${status}`;
}
class VersionDetail implements PickerDetail {
	get help() {
		return t("version.help");
	}
	#offset = 0;
	readonly body: string;
	constructor(body: string) {
		this.body = body;
	}
	lines(width: number, height: number) {
		const lines = new Text(this.body, 0, 0).render(width);
		this.#offset = Math.min(this.#offset, Math.max(0, lines.length - height));
		return lines.slice(this.#offset, this.#offset + height);
	}
	handleKey(data: string) {
		if (matchesKey(data, "up")) this.#offset = Math.max(0, this.#offset - 1);
		else if (matchesKey(data, "down")) this.#offset++;
		else return false;
		return true;
	}
}
export function openVersion(
	panel: PickerPanel,
	read: () => Promise<{ state: UpdateState | null; installed: string | null }>,
	check: () => Promise<UpdateState>,
	options: VersionOptions = {},
): Promise<void> {
	return panel.show(
		t("version.title"),
		async () => [
			{ value: "info", label: t("version.title") },
			{ value: "check", label: t("version.checkForUpdates") },
			{ value: "details", label: t("version.details") },
		],
		async (value) => {
			let checked: UpdateState | undefined;
			let failed = false;
			if (value === "check") {
				try {
					checked = await check();
				} catch {
					failed = true;
				}
			}
			const { state, installed } = await read();
			if (value === "details") {
				const unknown = t("common.unknown");
				return new VersionDetail(
					t("version.detailsBody", {
						tui: options.runningVersion ?? RUNNING_VERSION,
						installed: installed ?? unknown,
						gateway: state?.runningVersion ?? unknown,
						gatewayInstalled: state?.installedVersion ?? unknown,
						latest: state?.latestVersion ?? unknown,
					}),
				);
			}
			const result = failed && state ? { ...state, checkState: "failed" as const } : (checked ?? state);
			let body = versionOverview(result, installed, options);
			if (failed && !body.includes(t("version.checkFailed"))) body += `\n${t("version.checkFailed")}`;
			return new VersionDetail(body);
		},
	);
}

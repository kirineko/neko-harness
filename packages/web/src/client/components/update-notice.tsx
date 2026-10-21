import { RUNNING_VERSION, updateAction } from "@neko-harness/core/application-version";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { getT, useT } from "../lib/i18n/index.ts";
import { storeActions, useNekoState } from "../lib/store";
import { reloadForUpgrade } from "./composer";
import { DismissButton } from "./primitives";

export async function copyUpdateCommand(): Promise<string> {
	const t = getT();
	let text: string;
	try {
		await navigator.clipboard.writeText("neko update");
		text = t("update.copied");
	} catch {
		text = t("update.copyManually");
	}
	storeActions.notice({ level: "info", text });
	return text;
}
export function useUpdateAction() {
	const { updates, webInfo } = useNekoState();
	return updateAction({
		gateway: updates,
		frontend: RUNNING_VERSION,
		installed: webInfo?.installedVersion ?? null,
		web: webInfo ? { runningVersion: webInfo.webVersion, installedVersion: webInfo.installedVersion } : undefined,
	});
}
export function UpdateNotice() {
	const action = useUpdateAction();
	const t = useT();
	// 仅本次页面内关闭；状态变化（如新版本或需重启）会重新提示。
	const [dismissed, setDismissed] = useState<string | null>(null);
	if (action === "none" || dismissed === action) return null;
	const text =
		action === "install"
			? t("update.install")
			: action === "refresh-page"
				? t("update.refreshPage")
				: action === "incompatible"
					? t("update.incompatible")
					: t("update.restart");
	return (
		<output className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1 border-b border-sakura-100 bg-sakura-50 px-4 py-1.5 text-xs text-ink-700">
			<span>{text}</span>
			{action === "install" ? (
				<button
					type="button"
					className="focus-neko rounded px-2 py-1 text-sakura-700"
					onClick={() => void copyUpdateCommand()}
				>
					{t("update.copyCommand")}
				</button>
			) : action === "refresh-page" ? (
				<button type="button" className="focus-neko rounded px-2 py-1 text-sakura-700" onClick={reloadForUpgrade}>
					{t("update.refresh")}
				</button>
			) : (
				<Link to="/about" className="focus-neko rounded px-2 py-1 text-sakura-700">
					{t("update.viewSteps")}
				</Link>
			)}
			<DismissButton label={t("update.dismiss")} onClick={() => setDismissed(action)} />
		</output>
	);
}

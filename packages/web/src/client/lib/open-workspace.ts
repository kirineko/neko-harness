/** 浏览器侧封装：/api/local/session 取 CSRF 与可用目标，/api/open 在本机打开工作区目录。 */

import { getT } from "./i18n/index.ts";
import { localizeServerText } from "./i18n/server-text.ts";

export type OpenTargetId = "vscode" | "file-manager";

export type OpenTargetInfo = {
	readonly id: OpenTargetId;
	readonly label: string;
	readonly available: boolean;
	readonly reason?: string;
};

export type OpenSession = { readonly csrf: string; readonly targets: readonly OpenTargetInfo[] };

export const OPEN_TARGET_KEY = "neko.openTarget";

export function readStoredTarget(storage: Pick<Storage, "getItem"> = localStorage): OpenTargetId | undefined {
	try {
		const value = storage.getItem(OPEN_TARGET_KEY);
		return value === "vscode" || value === "file-manager" ? value : undefined;
	} catch {
		return undefined;
	}
}

export function writeStoredTarget(target: OpenTargetId, storage: Pick<Storage, "setItem"> = localStorage): void {
	try {
		storage.setItem(OPEN_TARGET_KEY, target);
	} catch {
		// 浏览器禁用存储时只是不记忆。
	}
}

/** 记住的目标可用则用它，否则回退到第一个可用目标，缺省偏向 VS Code。 */
export function chooseTarget(
	targets: readonly OpenTargetInfo[],
	stored: OpenTargetId | undefined,
): OpenTargetInfo | undefined {
	const remembered = targets.find((target) => target.id === stored && target.available);
	return remembered ?? targets.find((target) => target.available);
}

function isSession(value: unknown): value is OpenSession {
	if (typeof value !== "object" || value === null) return false;
	const { csrf, targets } = value as { csrf?: unknown; targets?: unknown };
	return (
		typeof csrf === "string" &&
		Array.isArray(targets) &&
		targets.every(
			(target) =>
				typeof target === "object" &&
				target !== null &&
				((target as OpenTargetInfo).id === "vscode" || (target as OpenTargetInfo).id === "file-manager") &&
				typeof (target as OpenTargetInfo).label === "string" &&
				typeof (target as OpenTargetInfo).available === "boolean",
		)
	);
}

/** 不在本机访问、旧 Web 服务或网络失败时返回 null，前端据此隐藏入口。 */
export async function fetchOpenSession(): Promise<OpenSession | null> {
	try {
		const response = await fetch("/api/local/session", { cache: "no-store" });
		if (!response.ok) return null;
		const body: unknown = await response.json();
		return isSession(body) ? body : null;
	} catch {
		return null;
	}
}

export class OpenWorkspaceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OpenWorkspaceError";
	}
}

async function errorMessage(response: Response): Promise<string> {
	let code: string | undefined;
	let message: string | undefined;
	try {
		const body = (await response.json()) as { code?: unknown; message?: unknown };
		if (typeof body.code === "string") code = body.code;
		if (typeof body.message === "string") message = body.message;
	} catch {
		// 使用默认信息。
	}
	const t = getT();
	if (response.status === 403) return t("open.forbidden");
	if (code === "invalid_path") return t("open.invalidPath");
	if ((code === "unavailable" || code === "launch_failed") && message !== undefined && message !== "") {
		return localizeServerText(message, t);
	}
	return t("open.requestFailedStatus", { status: response.status });
}

export async function openWorkspace(csrf: string, target: OpenTargetId, path: string): Promise<void> {
	let response: Response;
	try {
		response = await fetch("/api/open", {
			method: "POST",
			headers: { "content-type": "application/json", "x-neko-csrf": csrf },
			body: JSON.stringify({ target, path }),
		});
	} catch (error) {
		throw new OpenWorkspaceError(
			getT()("open.requestFailed", { error: error instanceof Error ? error.message : String(error) }),
		);
	}
	if (!response.ok) throw new OpenWorkspaceError(await errorMessage(response));
}

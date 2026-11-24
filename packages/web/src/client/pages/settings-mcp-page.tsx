import { McpSettingsPanel } from "../components/mcp-settings-panel";
import { SettingsShell } from "../components/settings-shell";
import { appActions } from "../lib/bootstrap";
import { useT } from "../lib/i18n/index.ts";
import { useNekoState } from "../lib/store";

export function SettingsMcpPage() {
	const { mcp, phase } = useNekoState();
	const t = useT();
	return (
		<SettingsShell active="mcp">
			<div className="mx-auto w-full max-w-4xl px-5 pt-6 pb-3">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<h1 className="text-xl font-bold text-ink-900">{t("settings.mcp.title")}</h1>
					<span className="ml-auto text-xs text-ink-500">
						{phase === "ready" ? t("common.connected") : t("common.connecting")}
					</span>
				</div>
				<p className="mt-1 text-sm text-ink-500">{t("settings.mcp.intro")}</p>
			</div>
			<main className="mx-auto w-full max-w-4xl px-5 pb-8">
				<McpSettingsPanel
					state={mcp}
					ready={phase === "ready"}
					actions={{
						upsertServer: (name, config) => appActions.upsertMcpServer(name, config),
						removeServer: (name) => appActions.removeMcpServer(name),
						setEnabled: (name, enabled) => appActions.setMcpServerEnabled(name, enabled),
						saveRawConfig: (rawJson) => appActions.saveMcpRawConfig(rawJson),
						reconnect: (name) => appActions.reconnectMcpServer(name),
						beginSignIn: (server) => appActions.beginMcpSignIn(server),
						pasteSignIn: (id, redirectUrl) => appActions.pasteMcpSignIn(id, redirectUrl),
						cancelSignIn: (id) => appActions.cancelMcpSignIn(id),
						signOut: (server) => appActions.signOutMcpServer(server),
					}}
				/>
			</main>
		</SettingsShell>
	);
}

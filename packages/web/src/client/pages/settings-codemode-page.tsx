import { CodemodeSettingsPanel } from "../components/codemode-settings-panel";
import { SettingsShell } from "../components/settings-shell";
import { appActions } from "../lib/bootstrap";
import { useT } from "../lib/i18n/index.ts";
import { useNekoState } from "../lib/store";

export function SettingsCodemodePage() {
	const { codemodeSettings, phase } = useNekoState();
	const t = useT();
	return (
		<SettingsShell active="codemode">
			<div className="mx-auto w-full max-w-4xl px-5 pt-6 pb-3">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<h1 className="text-xl font-bold text-ink-900">{t("settings.codemode.title")}</h1>
					<span className="ml-auto text-xs text-ink-500">
						{phase === "ready" ? t("common.connected") : t("common.connecting")}
					</span>
				</div>
				<p className="mt-1 text-sm text-ink-500">{t("settings.codemode.intro")}</p>
			</div>
			<main className="mx-auto w-full max-w-4xl px-5 pb-8">
				<CodemodeSettingsPanel
					settings={codemodeSettings}
					ready={phase === "ready"}
					onSelect={(mode) => appActions.setCodemodeMode(mode)}
					onReset={() => appActions.resetCodemodeMode()}
				/>
			</main>
		</SettingsShell>
	);
}

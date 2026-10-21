import { AppearancePanel } from "../components/appearance-panel";
import { SettingsShell } from "../components/settings-shell";
import { useT } from "../lib/i18n/index.ts";

export function SettingsAppearancePage() {
	const t = useT();
	return (
		<SettingsShell active="appearance">
			<div className="mx-auto w-full max-w-4xl px-5 pt-6 pb-3">
				<h1 className="text-xl font-bold text-ink-900">{t("settings.appearance.title")}</h1>
				<p className="mt-1 text-sm text-ink-500">{t("settings.appearance.intro")}</p>
			</div>
			<main className="mx-auto w-full max-w-4xl px-5 pb-8">
				<AppearancePanel />
			</main>
		</SettingsShell>
	);
}

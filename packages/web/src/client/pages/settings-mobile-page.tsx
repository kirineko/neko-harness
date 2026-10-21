import { MobilePairing } from "../components/mobile-pairing";
import { SettingsShell } from "../components/settings-shell";
import { useT } from "../lib/i18n/index.ts";

export function SettingsMobilePage() {
	const t = useT();
	return (
		<SettingsShell active="mobile">
			<div className="mx-auto w-full max-w-4xl px-5 pt-6 pb-3">
				<h1 className="text-xl font-bold text-ink-900">{t("settings.mobile.title")}</h1>
				<p className="mt-1 text-sm text-ink-500">{t("settings.mobile.intro")}</p>
			</div>
			<main className="mx-auto w-full max-w-4xl px-5 pb-8">
				<MobilePairing />
			</main>
		</SettingsShell>
	);
}

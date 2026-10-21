import { MODEL_PROVIDERS } from "@neko-harness/core/credential-providers";
import { useEffect, useState } from "react";
import { ProviderCombobox } from "../components/provider-combobox";
import { ProviderCredentialCard } from "../components/provider-credential-card";
import { SettingsShell } from "../components/settings-shell";
import { appActions } from "../lib/bootstrap";
import { useT } from "../lib/i18n/index.ts";
import type { ProviderOption } from "../lib/providers";
import { useNekoState } from "../lib/store";

type ProviderSpec = (typeof MODEL_PROVIDERS)[number];

const HASH_PREFIX = "credential-";

function providerFromHash(): string {
	const hash = typeof window === "undefined" ? "" : window.location.hash.slice(1);
	const id = hash.startsWith(HASH_PREFIX) ? hash.slice(HASH_PREFIX.length) : "";
	return MODEL_PROVIDERS.some((spec) => spec.id === id) ? id : "deepseek";
}

export function SettingsPage() {
	const { credentials, phase } = useNekoState();
	const t = useT();
	const ready = phase === "ready" && credentials !== null;
	const [selected, setSelected] = useState(providerFromHash);
	useEffect(() => {
		const sync = () => setSelected(providerFromHash());
		window.addEventListener("hashchange", sync);
		window.addEventListener("popstate", sync);
		return () => {
			window.removeEventListener("hashchange", sync);
			window.removeEventListener("popstate", sync);
		};
	}, []);
	const spec: ProviderSpec = MODEL_PROVIDERS.find((item) => item.id === selected) ?? MODEL_PROVIDERS[0];
	const enabledOf = (item: ProviderSpec) => credentials?.statuses[item.id]?.enabled !== false;
	const options: ProviderOption[] = MODEL_PROVIDERS.map((item) => {
		const status = credentials?.statuses[item.id];
		const enabled = enabledOf(item);
		return {
			id: item.id,
			name: item.name,
			keywords: item.envVar,
			detail: !enabled
				? t("settings.credentials.disabled")
				: status && status.source !== "none"
					? t("settings.credentials.configured")
					: t("settings.credentials.keyMissing"),
			tone: !enabled ? "off" : status && status.source !== "none" ? "on" : "warn",
		};
	});
	const enabledCount = MODEL_PROVIDERS.filter(enabledOf).length;
	const hasCredentials = credentials !== null;
	useEffect(() => {
		if (hasCredentials && window.location.hash === `#${HASH_PREFIX}${selected}`) {
			document.getElementById(`${HASH_PREFIX}${selected}`)?.scrollIntoView?.({ block: "center" });
		}
	}, [hasCredentials, selected]);
	return (
		<SettingsShell active="credentials">
			<div className="mx-auto w-full max-w-4xl px-5 pt-6 pb-3">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<h1 className="text-xl font-bold text-ink-900">{t("settings.credentials.title")}</h1>
					<span className="ml-auto text-xs text-ink-500">
						{phase === "ready" ? t("common.connected") : t("common.connecting")}
					</span>
				</div>
				<p className="mt-1 text-sm text-ink-500">{t("settings.credentials.intro")}</p>
			</div>
			<main className="mx-auto w-full max-w-4xl px-5 pb-8">
				<div className="flex flex-col gap-4">
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
						<div className="w-full min-w-0 sm:w-80">
							<ProviderCombobox
								label={t("settings.credentials.providerLabel")}
								options={options}
								value={spec.id}
								onChange={setSelected}
							/>
						</div>
						<span className="text-xs text-ink-500">
							{t("settings.credentials.enabledCount", { enabled: enabledCount, total: MODEL_PROVIDERS.length })}
						</span>
					</div>
					<ProviderCredentialCard
						key={spec.id}
						spec={spec}
						status={credentials?.statuses[spec.id]}
						ready={ready}
						enable={{
							enabled: enabledOf(spec),
							locked: spec.id === "deepseek",
							onChange: (value) => appActions.setProviderEnabled(spec.id, value),
						}}
					/>
				</div>
			</main>
		</SettingsShell>
	);
}

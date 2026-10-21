import type { CredentialStatus } from "@neko-harness/core";
import type { CredentialProviderSpec } from "@neko-harness/core/credential-providers";
import { useRef, useState } from "react";
import { appActions } from "../lib/bootstrap";
import { type PlainKey, useT } from "../lib/i18n/index.ts";

export const credentialSources: Record<CredentialStatus["source"], PlainKey> = {
	saved: "credential.source.saved",
	environment: "credential.source.environment",
	runtime: "credential.source.runtime",
	keyless: "credential.source.keyless",
	none: "credential.source.none",
};

export type EnableControl = {
	enabled: boolean;
	/** DeepSeek is the default model and search fallback, so it cannot be turned off. */
	locked: boolean;
	onChange: (enabled: boolean) => Promise<void>;
};

export function ProviderCredentialCard(props: {
	spec: CredentialProviderSpec;
	status: (CredentialStatus & { enabled?: boolean }) | undefined;
	ready: boolean;
	enable?: EnableControl;
	/** Extra explanation appended to the env-var line, e.g. that the key is shared with another page. */
	note?: string;
}) {
	const { spec, status, ready, enable, note } = props;
	const name = spec.name;
	const t = useT();
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState(false);
	const pending = useRef(false);
	const [message, setMessage] = useState("");
	async function run(action: () => Promise<void>, done: string) {
		if (pending.current) return;
		pending.current = true;
		setBusy(true);
		setMessage("");
		try {
			await action();
			setMessage(done);
		} catch {
			setMessage(t("credential.failed"));
		} finally {
			pending.current = false;
			setBusy(false);
		}
	}
	async function update(remove: boolean) {
		await run(
			async () => {
				if (remove) await appActions.removeCredential(spec.id);
				else await appActions.saveCredential(spec.id, key);
				setKey("");
			},
			remove ? t("credential.removed") : t("credential.saved"),
		);
	}
	const disabled = busy || !ready || !status;
	return (
		<section id={`credential-${spec.id}`} className="rounded-2xl border border-sakura-200 bg-surface p-5 shadow-soft">
			<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
				<h2 className="text-base font-bold text-ink-900">{name}</h2>
				<div className="flex flex-wrap items-center gap-2">
					{enable && (
						<label
							className={`inline-flex items-center gap-1.5 rounded-full border border-sakura-200 px-3 py-1 text-xs ${
								enable.locked ? "text-ink-500" : "cursor-pointer text-ink-700"
							}`}
						>
							<input
								type="checkbox"
								checked={enable.enabled}
								disabled={disabled || enable.locked}
								aria-label={t("credential.enableAria", { name })}
								onChange={(event) =>
									void run(
										() => enable.onChange(event.target.checked),
										event.target.checked ? t("credential.enabledDone") : t("credential.disabledDone"),
									)
								}
							/>
							{enable.locked ? t("credential.alwaysOn") : t("credential.enable")}
						</label>
					)}
					<span className="rounded-full bg-tianyi-50 px-3 py-1 text-xs text-tianyi-800">
						{status ? t(credentialSources[status.source]) : t("common.loading")}
					</span>
				</div>
			</div>
			<p className="mb-3 text-xs text-ink-500">
				{t("credential.envVar", {
					state: status
						? status.environmentConfigured
							? t("credential.envConfigured")
							: t("credential.envMissing")
						: t("common.loading"),
					envVar: spec.envVar,
				})}
				{spec.keyless ? t("credential.keylessNote") : ""}
				{note ? ` · ${note}` : ""}
			</p>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void update(false);
				}}
			>
				<label className="sr-only" htmlFor={`${spec.id}-key`}>
					{t("credential.keyLabel", { name })}
				</label>
				<input
					id={`${spec.id}-key`}
					type="password"
					autoComplete="off"
					spellCheck={false}
					value={key}
					maxLength={4096}
					disabled={disabled}
					onChange={(event) => setKey(event.target.value)}
					placeholder={status?.savedConfigured ? t("credential.placeholderReplace") : t("credential.placeholderNew")}
					className="focus-neko w-full min-w-0 rounded-xl border border-sakura-200 bg-base px-3 py-2.5 text-sm"
				/>
				<div className="mt-3 flex flex-wrap items-center gap-3">
					<button
						type="submit"
						disabled={disabled || !key.trim()}
						className="focus-neko rounded-full bg-sakura-100 px-4 py-1.5 text-sm font-semibold text-sakura-800 disabled:opacity-50"
					>
						{busy ? t("credential.working") : t("credential.save")}
					</button>
					{status?.savedConfigured && (
						<button
							type="button"
							disabled={disabled}
							onClick={() => void update(true)}
							className="focus-neko rounded-full px-3 py-1.5 text-sm text-ink-500 disabled:opacity-50"
						>
							{t("credential.remove")}
						</button>
					)}
					<a
						href={spec.signupUrl}
						target="_blank"
						rel="noreferrer"
						className="focus-neko ml-auto inline-block rounded text-xs text-sakura-700"
					>
						{t("credential.getKey", { name })}
					</a>
				</div>
			</form>
			<output className="mt-2 block min-h-4 text-xs text-tianyi-800">{message}</output>
		</section>
	);
}

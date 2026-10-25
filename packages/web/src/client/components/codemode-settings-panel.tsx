import { CODEMODE_MODES, type CodemodeMode } from "@neko-harness/core/codemode-mode";
import { useRef, useState } from "react";
import type { NekoCodemodeSettingsState } from "../lib/contract";
import { type PlainKey, useT } from "../lib/i18n/index.ts";

const MODE_TEXT: Record<CodemodeMode, { label: PlainKey; description: PlainKey }> = {
	off: { label: "codemode.mode.off.label", description: "codemode.mode.off.description" },
	on: { label: "codemode.mode.on.label", description: "codemode.mode.on.description" },
	only: { label: "codemode.mode.only.label", description: "codemode.mode.only.description" },
};
const SOURCE_TEXT: Record<NekoCodemodeSettingsState["source"], PlainKey> = {
	default: "context.source.default",
	config: "context.source.config",
	saved: "context.source.saved",
};

export function CodemodeSettingsPanel(props: {
	settings: NekoCodemodeSettingsState | null;
	ready: boolean;
	onSelect: (mode: CodemodeMode) => Promise<void>;
	onReset: () => Promise<void>;
}) {
	const { settings, ready, onSelect, onReset } = props;
	const t = useT();
	const [busy, setBusy] = useState(false);
	const pending = useRef(false);
	const [message, setMessage] = useState("");
	const disabled = busy || !ready || !settings;

	async function run(work: () => Promise<void>, done: string) {
		if (pending.current) return;
		pending.current = true;
		setBusy(true);
		setMessage("");
		try {
			await work();
			setMessage(done);
		} catch {
			setMessage(t("codemode.saveFailed"));
		} finally {
			pending.current = false;
			setBusy(false);
		}
	}

	if (!settings) return <p className="text-sm text-ink-500">{t("common.loading")}</p>;
	const current = settings.effective.mode;
	return (
		<section
			className="rounded-2xl border border-sakura-200 bg-surface p-5 shadow-soft"
			aria-labelledby="codemode-mode"
		>
			<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
				<h2 id="codemode-mode" className="text-base font-bold text-ink-900">
					{t("codemode.modeTitle")}
				</h2>
				<span className="rounded-full bg-tianyi-50 px-3 py-1 text-xs text-tianyi-800">
					{t("codemode.current", { mode: t(MODE_TEXT[current].label), source: t(SOURCE_TEXT[settings.source]) })}
				</span>
			</div>
			<p className="mb-3 text-xs text-ink-500">{t("codemode.newSessionsOnly")}</p>
			<fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" disabled={disabled}>
				<legend className="sr-only">{t("codemode.modeTitle")}</legend>
				{CODEMODE_MODES.map((mode) => (
					<label
						key={mode}
						className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 text-sm ${
							mode === current ? "border-sakura-400 bg-sakura-50" : "border-sakura-100"
						} ${disabled ? "opacity-60" : ""}`}
					>
						<input
							type="radio"
							name="codemode-mode"
							value={mode}
							checked={mode === current}
							onChange={() => mode !== current && void run(() => onSelect(mode), t("codemode.saved"))}
							className="mt-1"
						/>
						<span className="min-w-0 flex-1">
							<span className="font-semibold text-ink-900">{t(MODE_TEXT[mode].label)}</span>
							<span className="block text-xs text-ink-500">{t(MODE_TEXT[mode].description)}</span>
						</span>
					</label>
				))}
			</fieldset>
			{settings.source === "config" && <p className="mt-2 text-[11px] text-ink-400">{t("codemode.fromConfig")}</p>}
			<div className="mt-3 flex flex-wrap items-center gap-3">
				<button
					type="button"
					disabled={disabled || settings.source !== "saved"}
					onClick={() => void run(onReset, t("codemode.restored"))}
					className="focus-neko rounded-full border border-sakura-200 bg-surface px-4 py-1.5 text-xs text-ink-700 hover:bg-sakura-50 disabled:opacity-50"
				>
					{t("codemode.restore")}
				</button>
				<output aria-live="polite" className="min-h-4 text-xs text-tianyi-800">
					{message}
				</output>
			</div>
		</section>
	);
}

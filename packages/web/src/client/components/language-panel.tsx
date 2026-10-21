import { useT } from "../lib/i18n/index.ts";
import { LANGUAGES, type Language, type LanguageStore, languageStore, useLanguage } from "../lib/language.ts";

/** 单选组：原生 radio（键盘方向键与 checked 语义）；选项以各自语言书写，便于在不熟悉的语言下辨认。 */
export function LanguagePanel({ store = languageStore() }: { store?: LanguageStore }) {
	const t = useT();
	const language = useLanguage(store);
	const labels: Record<Language, string> = { zh: t("language.option.zh"), en: t("language.option.en") };
	return (
		<fieldset className="m-0 min-w-0 rounded-2xl border border-sakura-200 bg-surface p-5 shadow-soft">
			<legend className="sr-only">{t("language.legend")}</legend>
			<div className="flex flex-wrap gap-1.5">
				{LANGUAGES.map((id) => (
					<label
						key={id}
						className={`choice-focus cursor-pointer rounded-full border px-4 py-1.5 text-sm transition-colors ${
							language === id
								? "border-sakura-400 bg-sakura-100 font-semibold text-sakura-800"
								: "border-sakura-200 bg-surface text-ink-700 hover:bg-sakura-50"
						}`}
					>
						<input
							type="radio"
							className="sr-only"
							name="ui-language"
							value={id}
							lang={id === "zh" ? "zh-CN" : "en"}
							checked={language === id}
							onChange={() => store.set(id)}
						/>
						{labels[id]}
					</label>
				))}
			</div>
		</fieldset>
	);
}

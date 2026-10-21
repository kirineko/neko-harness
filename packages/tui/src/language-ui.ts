import type { PickerItem, PickerPanel } from "./components/picker.ts";
import { getLanguage, isLanguage, LANGUAGES, type Language, t } from "./i18n/index.ts";

/** Language rows of the `/language` panel; the current one is marked, names are never translated. */
export function languageItems(current: Language = getLanguage()): PickerItem[] {
	return LANGUAGES.map((language) => ({
		value: language,
		label: `${t(`language.name.${language}`)}${language === current ? t("common.currentSuffix") : ""}`,
	}));
}

/** Opens the `/language` panel on the shared picker; resolves once it is shown. */
export function openLanguagePanel(panel: PickerPanel, choose: (language: Language) => void): Promise<void> {
	return panel.show(
		t("language.title"),
		async () => languageItems(),
		async (value) => {
			if (isLanguage(value)) choose(value);
		},
	);
}

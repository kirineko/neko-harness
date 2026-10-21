import { setLanguage } from "../../src/i18n/index.ts";

// Product text defaults to zh; the suites assert the English wording, so every test file pins `en` explicitly.
setLanguage("en");

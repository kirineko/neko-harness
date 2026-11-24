/**
 * Credential provider descriptors. Free of Node imports so browser bundles
 * (the Web settings page) can use it via the `@neko-harness/core/credential-providers` subpath.
 */

export type CredentialProviderKind = "model" | "search";

export type CredentialProviderSpec = {
	readonly id: string;
	readonly kind: CredentialProviderKind;
	/** Display name shown by frontends. */
	readonly name: string;
	/** Primary environment variable surfaced by frontends and probed first for status display and request auth; the DeepSeek key serves both the model and web search. */
	readonly envVar: string;
	/** Additional upstream fallback environment variables accepted for request auth and environment status. */
	readonly fallbackEnvVars?: readonly string[];
	/** Where users obtain a key; surfaced by frontends. */
	readonly signupUrl: string;
	/** True when the provider works without any key in a rate-limited keyless mode. */
	readonly keyless: boolean;
};

const model = (id: string, name: string, envVar: string, signupUrl: string, fallbackEnvVars?: readonly string[]) =>
	({
		id,
		kind: "model",
		name,
		envVar,
		...(fallbackEnvVars ? { fallbackEnvVars } : {}),
		signupUrl,
		keyless: false,
	}) as const;

/**
 * Closed catalog of pure API-key providers from the pinned pi-ai build. Environment variables are
 * reconciled against pi-ai by a test, so a Pi upgrade that changes them fails loudly.
 */
export const MODEL_PROVIDERS = [
	model("deepseek", "DeepSeek", "DEEPSEEK_API_KEY", "https://platform.deepseek.com/api_keys"),
	model("openrouter", "OpenRouter", "OPENROUTER_API_KEY", "https://openrouter.ai/keys"),
	model("opencode-go", "OpenCode Go", "OPENCODE_API_KEY", "https://opencode.ai/auth"),
	model("opencode", "OpenCode Zen", "OPENCODE_API_KEY", "https://opencode.ai/auth"),
	model("openai", "OpenAI", "OPENAI_API_KEY", "https://platform.openai.com/api-keys"),
	model("google", "Google", "GEMINI_API_KEY", "https://aistudio.google.com/apikey"),
	model("groq", "Groq", "GROQ_API_KEY", "https://console.groq.com/keys"),
	model("mistral", "Mistral", "MISTRAL_API_KEY", "https://console.mistral.ai/api-keys"),
	model("xai", "xAI", "XAI_API_KEY", "https://console.x.ai"),
	model("together", "Together", "TOGETHER_API_KEY", "https://api.together.ai/settings/api-keys"),
	model("fireworks", "Fireworks", "FIREWORKS_API_KEY", "https://fireworks.ai/account/api-keys"),
	model("cerebras", "Cerebras", "CEREBRAS_API_KEY", "https://cloud.cerebras.ai"),
	model("nvidia", "NVIDIA", "NVIDIA_API_KEY", "https://build.nvidia.com/settings/api-keys"),
	model("huggingface", "Hugging Face", "HF_TOKEN", "https://huggingface.co/settings/tokens"),
	model("vercel-ai-gateway", "Vercel AI Gateway", "AI_GATEWAY_API_KEY", "https://vercel.com/ai-gateway"),
	model("moonshotai", "Moonshot AI", "MOONSHOT_API_KEY", "https://platform.moonshot.ai/console/api-keys"),
	model("moonshotai-cn", "Moonshot AI CN", "MOONSHOT_API_KEY", "https://platform.moonshot.cn/console/api-keys"),
	model("minimax", "MiniMax", "MINIMAX_API_KEY", "https://platform.minimax.io"),
	model("minimax-cn", "MiniMax CN", "MINIMAX_CN_API_KEY", "https://platform.minimaxi.com"),
	model("zai", "Z.AI", "ZAI_API_KEY", "https://z.ai/manage-apikey/apikey-list"),
	model("zai-coding-cn", "Z.AI Coding CN", "ZAI_CODING_CN_API_KEY", "https://bigmodel.cn/usercenter/proj-mgmt/apikeys"),
	model(
		"qwen-token-plan",
		"Qwen Token Plan Team",
		"QWEN_TOKEN_PLAN_TEAM_API_KEY",
		"https://modelstudio.console.alibabacloud.com",
		["QWEN_TOKEN_PLAN_API_KEY"],
	),
	model(
		"qwen-token-plan-cn",
		"Qwen Token Plan Team CN",
		"QWEN_TOKEN_PLAN_TEAM_CN_API_KEY",
		"https://bailian.console.aliyun.com",
		["QWEN_TOKEN_PLAN_CN_API_KEY"],
	),
	model(
		"qwen-token-plan-individual",
		"Qwen Token Plan Individual",
		"QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY",
		"https://modelstudio.console.alibabacloud.com",
		["QWEN_TOKEN_PLAN_API_KEY"],
	),
	model(
		"qwen-token-plan-individual-cn",
		"Qwen Token Plan Individual CN",
		"QWEN_TOKEN_PLAN_INDIVIDUAL_CN_API_KEY",
		"https://bailian.console.aliyun.com",
		["QWEN_TOKEN_PLAN_CN_API_KEY"],
	),
	model("xiaomi", "Xiaomi MiMo", "XIAOMI_API_KEY", "https://platform.xiaomimimo.com"),
	model(
		"xiaomi-token-plan-cn",
		"Xiaomi Token Plan CN",
		"XIAOMI_TOKEN_PLAN_CN_API_KEY",
		"https://platform.xiaomimimo.com",
	),
	model(
		"xiaomi-token-plan-ams",
		"Xiaomi Token Plan AMS",
		"XIAOMI_TOKEN_PLAN_AMS_API_KEY",
		"https://platform.xiaomimimo.com",
	),
	model(
		"xiaomi-token-plan-sgp",
		"Xiaomi Token Plan SGP",
		"XIAOMI_TOKEN_PLAN_SGP_API_KEY",
		"https://platform.xiaomimimo.com",
	),
	model("baseten", "Baseten", "BASETEN_API_KEY", "https://app.baseten.co/settings/api_keys"),
	model("ant-ling", "Ant Ling", "ANT_LING_API_KEY", "https://ling.tbox.cn"),
	model("kimi-coding", "Kimi For Coding", "KIMI_API_KEY", "https://www.kimi.com/code/console"),
	model("meta", "Meta", "META_API_KEY", "https://llama.developer.meta.com"),
] as const satisfies readonly CredentialProviderSpec[];

export type ModelProviderId = (typeof MODEL_PROVIDERS)[number]["id"];

/** Web-search credentials; not model providers and never enabled or disabled. */
export const SEARCH_CREDENTIAL_PROVIDERS = [
	{
		id: "tavily",
		kind: "search",
		name: "Tavily",
		envVar: "TAVILY_API_KEY",
		signupUrl: "https://app.tavily.com",
		keyless: true,
	},
] as const satisfies readonly CredentialProviderSpec[];

/** Every credential-bearing provider the runtime knows about; the set is deliberately closed. */
export type CredentialProviderId = ModelProviderId | (typeof SEARCH_CREDENTIAL_PROVIDERS)[number]["id"];

export const CREDENTIAL_PROVIDERS: readonly CredentialProviderSpec[] = [
	...MODEL_PROVIDERS,
	...SEARCH_CREDENTIAL_PROVIDERS,
];

/** Model providers enabled for a user who never changed the setting; also cannot be disabled. */
export const DEFAULT_ENABLED_PROVIDERS: readonly ModelProviderId[] = ["deepseek"];
export const LOCKED_PROVIDERS: readonly ModelProviderId[] = ["deepseek"];

export function isModelProvider(id: string): id is ModelProviderId {
	return MODEL_PROVIDERS.some((item) => item.id === id);
}

export function providerEnvVars(spec: CredentialProviderSpec): readonly string[] {
	return spec.fallbackEnvVars ? [spec.envVar, ...spec.fallbackEnvVars] : [spec.envVar];
}

export function isCredentialProvider(id: string): id is CredentialProviderId {
	return CREDENTIAL_PROVIDERS.some((item) => item.id === id);
}

export function credentialProvider(id: string): CredentialProviderSpec {
	const spec = CREDENTIAL_PROVIDERS.find((item) => item.id === id);
	if (!spec) throw new Error(`Unknown credential provider: ${id}`);
	return spec;
}

/** Normalize a saved enabled list: keep catalog members only, always include the locked ones, stable catalog order. */
export function normalizeEnabledProviders(saved: readonly string[] | null | undefined): ModelProviderId[] {
	const wanted = new Set<string>([...LOCKED_PROVIDERS, ...(saved ?? DEFAULT_ENABLED_PROVIDERS)]);
	return MODEL_PROVIDERS.map((item) => item.id).filter((id) => wanted.has(id));
}

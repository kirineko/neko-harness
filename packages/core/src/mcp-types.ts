/**
 * Shared, browser-safe MCP types, limits and display helpers used by core, gateway, web and TUI.
 */

export const MCP_EXPOSURES = ["auto", "direct"] as const;
export type McpExposure = (typeof MCP_EXPOSURES)[number];

export const MCP_TRANSPORTS = ["stdio", "http"] as const;
export type McpTransportKind = (typeof MCP_TRANSPORTS)[number];

export const MCP_SERVER_STATUSES = [
	"disabled",
	"connecting",
	"connected",
	"disconnected",
	"auth_required",
	"error",
] as const;
export type McpServerStatus = (typeof MCP_SERVER_STATUSES)[number];

export const MCP_SIGN_IN_STATUSES = ["waiting", "failed"] as const;
export type McpSignInStatus = (typeof MCP_SIGN_IN_STATUSES)[number];

export const MCP_LIMITS = {
	defaultTimeoutSec: 60,
	maxSummaryChars: 250,
	maxStderrTailBytes: 4096,
	maxConfigBytes: 512 * 1024,
	signInTtlMs: 10 * 60 * 1000,
	connectWaitMs: 5_000,
	reconnectBaseMs: 1_000,
	reconnectMaxMs: 60_000,
	watchDebounceMs: 250,
} as const;

export type McpOAuthSettingsInput = {
	readonly clientId?: string;
	readonly clientSecret?: string;
	readonly callbackPort?: number;
	readonly callbackUrl?: string;
	readonly scope?: string;
	readonly clientName?: string;
	readonly clientRegistration?: "auto" | "dcr";
	readonly authServerMetadataUrl?: string;
};

export type McpServerConfigBase = {
	readonly enabled?: boolean;
	readonly description?: string;
	readonly timeout?: number;
	readonly exposure?: McpExposure;
};

export type McpStdioConfigInput = McpServerConfigBase & {
	readonly transport: "stdio";
	readonly command: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly cwd?: string;
};

export type McpHttpConfigInput = McpServerConfigBase & {
	readonly transport: "http";
	readonly url: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly oauth?: McpOAuthSettingsInput;
};

export type McpServerConfigInput = McpStdioConfigInput | McpHttpConfigInput;

export type McpToolInfo = {
	readonly name: string;
	readonly registeredName: string;
	readonly title?: string;
	readonly description: string;
	readonly readOnly: boolean;
};

export type McpServerSnapshot = {
	readonly name: string;
	readonly transport: McpTransportKind;
	readonly enabled: boolean;
	readonly exposure: McpExposure;
	readonly config: McpServerConfigInput;
	readonly status: McpServerStatus;
	readonly error: string | null;
	readonly stderrTail: string;
	readonly tools: readonly McpToolInfo[];
	readonly oauth: {
		readonly supported: boolean;
		readonly signedIn: boolean;
	};
};

export type McpSignInSnapshot = {
	readonly id: string;
	readonly server: string;
	readonly status: McpSignInStatus;
	readonly authorizationUrl: string;
	readonly error: string | null;
};

export type McpSnapshot = {
	readonly revision: number;
	readonly configPath: string;
	readonly configError: string | null;
	readonly entryErrors: readonly string[];
	readonly rawJson: string;
	readonly servers: readonly McpServerSnapshot[];
	readonly signIns: readonly McpSignInSnapshot[];
};

export type McpBeginSignInResult =
	| { readonly status: "authorized" }
	| { readonly status: "redirect"; readonly id: string; readonly authorizationUrl: string };

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const ENV_TEMPLATE_PATTERN = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;
const PURE_ENV_TEMPLATE_PATTERN = /^(?:Bearer\s+)?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/i;
const SENSITIVE_KEY_PATTERN = /(?:auth|token|secret|key|pass|cookie|cred|bearer|session)/i;

export function isMcpExposure(value: unknown): value is McpExposure {
	return value === "auto" || value === "direct";
}

export function isMcpServerName(name: string): boolean {
	return SERVER_NAME_PATTERN.test(name);
}

/** Parse `mcp__<server>__<tool>` into `{ server, tool }`, or `null` for non-MCP tool names. */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
	if (!name.startsWith("mcp__")) return null;
	const rest = name.slice("mcp__".length);
	const sep = rest.indexOf("__");
	if (sep <= 0 || sep === rest.length - 2) return null;
	return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

export function containsEnvTemplate(value: string): boolean {
	return ENV_TEMPLATE_PATTERN.test(value);
}

export function isPureEnvTemplate(value: string): boolean {
	return PURE_ENV_TEMPLATE_PATTERN.test(value.trim());
}

export function isSensitiveFieldKey(key: string): boolean {
	return SENSITIVE_KEY_PATTERN.test(key);
}

/** Mask plaintext secret values while keeping `${VAR}` templates readable. */
export function maskSecretValue(value: string): string {
	if (!value || isPureEnvTemplate(value)) return value;
	return "••••••••";
}

/**
 * Whether an MCP server actually requires or uses OAuth in the UI.
 * Public unauthenticated HTTP servers (connected with no `oauth` config and no 401 challenge) return `false`.
 */
export function isOAuthRelevant(
	server: Pick<McpServerSnapshot, "status" | "oauth" | "config">,
	signIn?: Pick<McpSignInSnapshot, "status">,
): boolean {
	if (!server.oauth.supported) return false;
	if (server.status === "auth_required" || server.oauth.signedIn) return true;
	if (server.config.transport === "http" && server.config.oauth !== undefined) return true;
	return signIn !== undefined;
}

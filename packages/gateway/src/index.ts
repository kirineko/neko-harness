export {
	connectNekoGateway,
	connectNekoGatewayLink,
	type NekoGatewayAddress,
	type NekoGatewayClient,
} from "./client.ts";
export {
	assertGatewayIdentity,
	safeValue,
	subscribeNative,
	subscribeState,
	waitForLive,
} from "./client-session.ts";
export {
	type ClientHeld,
	type ClientRef,
	decodeSubagentTarget,
	encodeSubagentTarget,
	GATEWAY_ADDRESS,
	GatewayKind,
	NekoApplicationInfo,
	NekoChat,
	NekoCodemodeSettings,
	type NekoCodemodeSettingsState,
	NekoContextSettings,
	type NekoContextSettingsPatch,
	type NekoContextSettingsState,
	type NekoCreateSessionOptions,
	type NekoCredentialState,
	NekoCredentials,
	NekoDefaultModel,
	type NekoDefaultModelState,
	type NekoDirectoryState,
	type NekoMarketInstallResult,
	type NekoMarketPreview,
	type NekoMarketSkill,
	NekoMcp,
	type NekoMcpBeginSignInResult,
	type NekoMcpServer,
	type NekoMcpServerConfigInput,
	type NekoMcpSignIn,
	type NekoMcpState,
	NekoModels,
	NekoSearchSettings,
	type NekoSearchSettingsState,
	NekoSessionDirectory,
	NekoSessionManagement,
	type NekoSessionSummary,
	NekoSkillMarket,
	type NekoSubmitInput,
	wrapClientHeld,
	wrapClientRef,
} from "./contract.ts";
export {
	type NekoGateway,
	type NekoGatewayOptions,
	startGateway,
} from "./gateway.ts";
export { isServerId } from "./identity.ts";
export { createClientHost, type GatewayLink, observableLink } from "./link.ts";
export { NekoMobileAdmin, readOrCreateMobileAdminToken } from "./mobile/admin.ts";
export { gatewayPortFilePath, readGatewayPortFile, removeGatewayPortFile } from "./port-file.ts";
export { gatewayCommand, stopGatewayProcess } from "./process.ts";
export {
	DEFAULT_SHUTDOWN_TIMEOUT_MS,
	installShutdown,
	type ShutdownController,
	type ShutdownOptions,
	type ShutdownProcess,
} from "./shutdown.ts";
export { createUnixLink } from "./unix-link.ts";
export {
	createWsLink,
	createWsListener,
	type WsListener,
	type WsListenerOptions,
} from "./ws-listener.ts";

/** Who a request acts as on the gateway host. Chord supplies none; the gateway stamps one per connection. */
export type GatewayPrincipal =
	| { readonly kind: "host" }
	| { readonly kind: "local"; readonly connectionId: string }
	| {
			readonly kind: "mobile";
			readonly connectionId: string;
			readonly deviceId: string;
			readonly grantRevision: number;
	  };

/** Revocation keys matched by `gatewayRevokedBy` when `chord.revoke(revocation, ctx)` runs. */
export type GatewayRevocation =
	| { readonly kind: "mobile-all" }
	| { readonly kind: "device"; readonly deviceId: string }
	| { readonly kind: "grant"; readonly deviceId: string; readonly grantRevision: number }
	| { readonly kind: "connection"; readonly connectionId: string };

export const HOST_PRINCIPAL: GatewayPrincipal = { kind: "host" };

/** Mobile keys carry device, grant revision and connection so a revoked grant never reaches a live object. */
export function gatewayPrincipalKey(principal: GatewayPrincipal): string {
	switch (principal.kind) {
		case "mobile":
			return `mobile:${principal.deviceId}:${principal.grantRevision}:${principal.connectionId}`;
		case "local":
			return `local:${principal.connectionId}`;
		case "host":
			return "host";
	}
}

export function gatewayRevokedBy(principal: GatewayPrincipal): readonly GatewayRevocation[] {
	if (principal.kind !== "mobile") return [];
	return [
		{ kind: "mobile-all" },
		{ kind: "device", deviceId: principal.deviceId },
		{ kind: "grant", deviceId: principal.deviceId, grantRevision: principal.grantRevision },
		{ kind: "connection", connectionId: principal.connectionId },
	];
}

export function isMobilePrincipal(principal: unknown): principal is Extract<GatewayPrincipal, { kind: "mobile" }> {
	return typeof principal === "object" && principal !== null && (principal as { kind?: unknown }).kind === "mobile";
}

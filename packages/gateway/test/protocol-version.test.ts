// A peer on another Chord link protocol version is refused and never disturbs other peers.

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { binaryCodec, createHost, memoryLinkPair } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createNekoRuntime } from "@neko-harness/core";
import { ApplicationProtocolError } from "@neko-harness/core/application-version";
import { expect, it } from "vitest";
import { fauxProvider } from "../../../test/faux.ts";
import { createGatewayConnection } from "../src/client-session.ts";
import { GATEWAY_ADDRESS } from "../src/contract.ts";
import { observableLink } from "../src/link.ts";
import {
	type GatewayPrincipal,
	type GatewayRevocation,
	gatewayPrincipalKey,
	gatewayRevokedBy,
	HOST_PRINCIPAL,
} from "../src/principal.ts";
import { createNekoServerServices } from "../src/server-services.ts";

async function serve() {
	const runtime = await createNekoRuntime({
		storage: "memory",
		providers: [fauxProvider().provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	const protocolErrors: string[] = [];
	const host = createHost<GatewayPrincipal, GatewayRevocation>({
		address: GATEWAY_ADDRESS,
		principal: HOST_PRINCIPAL,
		principalKey: gatewayPrincipalKey,
		revokedBy: gatewayRevokedBy,
		onError(event) {
			if (event.kind === "protocol_error") {
				protocolErrors.push(event.error instanceof Error ? event.error.message : String(event.error));
			}
		},
	});
	const services = await createNekoServerServices({
		host,
		runtime,
		context: runtime.context,
		serverId: "protocol-test",
		marketUrl: "https://unused.invalid",
	});
	let connections = 0;
	const accept = (link: Parameters<typeof host.accept>[0]) =>
		host.accept(
			link,
			{
				principal: { kind: "local", connectionId: `c${++connections}` },
			},
			BACKGROUND_CONTEXT,
		);
	return {
		host,
		protocolErrors,
		accept,
		async close() {
			await host.close(BACKGROUND_CONTEXT);
			await services.dispose();
			await runtime.close();
		},
	};
}

it("closes a client on another protocol version while healthy clients continue", async () => {
	const gateway = await serve();
	const [healthyLink, healthyPeer] = memoryLinkPair();
	gateway.accept(healthyPeer);
	const healthy = createGatewayConnection(healthyLink, "protocol-test");
	const [staleLink, rawStalePeer] = memoryLinkPair();
	const stalePeer = observableLink(rawStalePeer);
	gateway.accept(stalePeer);
	try {
		await healthy.ready();
		let closed = false;
		staleLink.onClose(() => {
			closed = true;
		});
		staleLink.send(binaryCodec.encode({ kind: "hello", protocol: 999, incarnation: randomUUID() } as never));
		await sleep(20);
		expect(gateway.protocolErrors).toEqual([expect.stringContaining("handshake: protocol 999")]);
		expect(closed).toBe(true);
		expect(stalePeer.closed).toBe(true);
		expect((await healthy.models.list()).length).toBeGreaterThan(0);
	} finally {
		await healthy.close();
		await gateway.close();
	}
});

it("reports a gateway on another protocol version as incompatible instead of timing out or retrying", async () => {
	const [rawClientLink, gatewayLink] = memoryLinkPair();
	const clientLink = observableLink(rawClientLink);
	const client = createGatewayConnection(clientLink, "protocol-test");
	try {
		gatewayLink.send(binaryCodec.encode({ kind: "hello", protocol: 999, incarnation: randomUUID() } as never));
		await expect(client.ready()).rejects.toBeInstanceOf(ApplicationProtocolError);
		expect(clientLink.closed).toBe(true);
	} finally {
		await client.close();
	}
});

it("reports a Pi <= 1.5 JSON gateway, whose handshake this version cannot parse, as incompatible", async () => {
	const [clientLink, gatewayLink] = memoryLinkPair();
	const client = createGatewayConnection(clientLink, "protocol-test");
	try {
		gatewayLink.send(
			new TextEncoder().encode(
				JSON.stringify({ t: "hello", name: "neko-gateway", kind: "host", codeVersion: 1, protocol: 4 }),
			),
		);
		await expect(client.ready()).rejects.toBeInstanceOf(ApplicationProtocolError);
	} finally {
		await client.close();
	}
});

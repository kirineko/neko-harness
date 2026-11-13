// A peer on another Chord link protocol version is refused with a recognizable reason and never disturbs other peers.

import { setTimeout as sleep } from "node:timers/promises";
import { createHost, memoryLinkPair } from "@earendil-works/chord";
import { createNekoRuntime } from "@neko-harness/core";
import { ApplicationProtocolError } from "@neko-harness/core/application-version";
import { expect, it } from "vitest";
import { fauxProvider } from "../../../test/faux.ts";
import { createGatewayConnection } from "../src/client-session.ts";
import { GATEWAY_HOST } from "../src/contract.ts";
import { type GatewayPrincipal, HOST_PRINCIPAL } from "../src/principal.ts";
import { createNekoServerServices } from "../src/server-services.ts";

async function serve() {
	const runtime = await createNekoRuntime({
		storage: "memory",
		providers: [fauxProvider().provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	const mismatches: (number | undefined)[] = [];
	const host = createHost<GatewayPrincipal>({ name: GATEWAY_HOST, self: HOST_PRINCIPAL, dev: true, onError() {} });
	const services = await createNekoServerServices({
		host,
		runtime,
		context: runtime.context,
		serverId: "protocol-test",
		marketUrl: "https://unused.invalid",
	});
	let connections = 0;
	const accept = (link: Parameters<typeof host.accept>[0]) =>
		host.accept(link, {
			principal: { kind: "local", connectionId: `c${++connections}` },
			onProtocolMismatch: ({ peer }) => mismatches.push(peer),
		});
	return {
		host,
		mismatches,
		accept,
		async close() {
			await host.close();
			await services.dispose();
			await runtime.close();
		},
	};
}

it("closes a client on another protocol version with a recognizable reason while healthy clients continue", async () => {
	const gateway = await serve();
	const [healthyLink, healthyPeer] = memoryLinkPair();
	gateway.accept(healthyPeer);
	const healthy = createGatewayConnection(healthyLink, "protocol-test");
	const [staleLink, stalePeer] = memoryLinkPair();
	gateway.accept(stalePeer);
	try {
		await healthy.ready();
		const reasons: string[] = [];
		staleLink.onClose((reason) => reasons.push(reason));
		staleLink.send({ t: "hello", name: "stale", kind: "client", codeVersion: 0, protocol: 1 });
		await sleep(20);
		expect(gateway.mismatches).toEqual([1]);
		expect(reasons.some((reason) => reason.startsWith("protocol-version "))).toBe(true);
		expect(stalePeer.closed).toBe(true);
		expect((await healthy.models.list(null)).length).toBeGreaterThan(0);
	} finally {
		await healthy.close();
		await gateway.close();
	}
});

it("reports a gateway on another protocol version as incompatible instead of timing out or retrying", async () => {
	const [clientLink, gatewayLink] = memoryLinkPair();
	const client = createGatewayConnection(clientLink, "protocol-test");
	try {
		gatewayLink.send({ t: "hello", name: GATEWAY_HOST, kind: "host", codeVersion: 1 });
		await expect(client.ready()).rejects.toBeInstanceOf(ApplicationProtocolError);
		expect(clientLink.closed).toBe(true);
	} finally {
		await client.close();
	}
});

it("reports a Pi 1.2 gateway, whose handshake this version cannot parse, as incompatible", async () => {
	const [clientLink, gatewayLink] = memoryLinkPair();
	const client = createGatewayConnection(clientLink, "protocol-test");
	try {
		gatewayLink.send({ t: "hello", name: "protocol-test", kind: "host", epoch: 1 } as never);
		await expect(client.ready()).rejects.toBeInstanceOf(ApplicationProtocolError);
	} finally {
		await client.close();
	}
});

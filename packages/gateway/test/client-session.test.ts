import { setTimeout as sleep } from "node:timers/promises";
import { createHost, type Link, memoryLinkPair } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createNekoRuntime } from "@neko-harness/core";
import { expect, it } from "vitest";
import { fauxProvider } from "../../../test/faux.ts";
import { createGatewayConnection, GatewayIdentityError } from "../src/client-session.ts";
import { GATEWAY_ADDRESS } from "../src/contract.ts";
import {
	type GatewayPrincipal,
	type GatewayRevocation,
	gatewayPrincipalKey,
	gatewayRevokedBy,
	HOST_PRINCIPAL,
} from "../src/principal.ts";
import { createNekoServerServices } from "../src/server-services.ts";

class HeldLink implements Link {
	private link: Link;
	private receiver?: (bytes: Uint8Array) => void;
	frames: Uint8Array[] = [];
	hold = true;
	constructor(link: Link) {
		this.link = link;
	}
	send(bytes: Uint8Array) {
		this.link.send(bytes);
	}
	onClose(handler: () => void) {
		this.link.onClose(handler);
	}
	close() {
		this.link.close();
	}
	onMessage(handler: (bytes: Uint8Array) => void) {
		this.receiver = handler;
		this.link.onMessage((bytes) => {
			if (this.hold) this.frames.push(bytes);
			else handler(bytes);
		});
	}
	flush() {
		this.hold = false;
		for (const frame of this.frames.splice(0)) this.receiver!(frame);
	}
}

it("waits for delayed initial state and returns native handles through async boundaries", async () => {
	const faux = fauxProvider();
	const runtime = await createNekoRuntime({
		storage: "memory",
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	const server = createHost<GatewayPrincipal, GatewayRevocation>({
		address: GATEWAY_ADDRESS,
		principal: HOST_PRINCIPAL,
		principalKey: gatewayPrincipalKey,
		revokedBy: gatewayRevokedBy,
		onError() {},
	});
	const services = await createNekoServerServices({
		host: server,
		runtime,
		context: runtime.context,
		serverId: "session-test",
		marketUrl: "https://unused.invalid",
	});
	const [clientLink, serverLink] = memoryLinkPair();
	server.accept(serverLink, { principal: { kind: "local", connectionId: "test" } }, BACKGROUND_CONTEXT);
	const link = new HeldLink(clientLink);
	const client = createGatewayConnection(link, "session-test");
	try {
		let ready = false;
		const pending = client.ready().then(() => {
			ready = true;
		});
		await sleep(10);
		expect(ready).toBe(false);
		expect(client.application.state.value.kind).toBe("loading");
		expect(() => client.directory).toThrow("Gateway protocol not checked");
		link.flush();
		await pending;
		expect(client.directory.snapshot.value.sessions[0]?.id).toBe("1");
		const chat = await (async () => client.attach("1"))();
		expect("then" in chat).toBe(false);
		expect(chat.view.value.cwd).toBeDefined();
		expect((await client.models.list()).length).toBeGreaterThan(0);
		await Promise.all([client.detach(), client.detach()]);
		await expect(chat.usage()).rejects.toThrow();
		link.hold = true;
		const controller = new AbortController();
		const cancelled = client.host.root(
			(ctx) => client.attach("1", ctx),
			withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
		);
		await sleep(10);
		controller.abort();
		await expect(cancelled).rejects.toThrow();
		link.flush();
		expect((await client.attach("1")).view.value).toBeDefined();
	} finally {
		await Promise.all([client.close(), client.close()]);
		await server.close(BACKGROUND_CONTEXT);
		await services.dispose();
		await runtime.close();
	}
});

it("bounds gateway readiness when the peer never delivers a snapshot", async () => {
	const [link, peer] = memoryLinkPair();
	const client = createGatewayConnection(link, "absent", { readyTimeoutMs: 100 });
	try {
		await expect(client.ready()).rejects.toThrow("timed out");
	} finally {
		await Promise.all([client.close(), client.close()]);
		peer.close();
	}
}, 5000);

it("rejects a gateway whose server id differs before binding any business service", async () => {
	const faux = fauxProvider();
	const runtime = await createNekoRuntime({
		storage: "memory",
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	const server = createHost<GatewayPrincipal, GatewayRevocation>({
		address: GATEWAY_ADDRESS,
		principal: HOST_PRINCIPAL,
		principalKey: gatewayPrincipalKey,
		revokedBy: gatewayRevokedBy,
		onError() {},
	});
	const services = await createNekoServerServices({
		host: server,
		runtime,
		context: runtime.context,
		serverId: "actual",
		marketUrl: "https://unused.invalid",
	});
	const [clientLink, serverLink] = memoryLinkPair();
	server.accept(serverLink, { principal: { kind: "local", connectionId: "test" } }, BACKGROUND_CONTEXT);
	const client = createGatewayConnection(clientLink, "expected");
	try {
		await expect(client.ready()).rejects.toBeInstanceOf(GatewayIdentityError);
		expect(() => client.directory).toThrow("Gateway protocol not checked");
	} finally {
		await client.close();
		await server.close(BACKGROUND_CONTEXT);
		await services.dispose();
		await runtime.close();
	}
});

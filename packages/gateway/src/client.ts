import type { Link } from "@earendil-works/chord";
import { createGatewayConnection, type NekoGatewayConnection } from "./client-session.ts";
import { createUnixLink } from "./unix-link.ts";
import { createWsLink } from "./ws-listener.ts";
export type NekoGatewayAddress =
	| { readonly transport: "unix"; readonly socketPath: string; readonly serverId: string }
	| { readonly transport: "ws"; readonly url: string; readonly serverId: string };
export type NekoGatewayClient = NekoGatewayConnection;
export async function connectNekoGateway(
	address: NekoGatewayAddress,
	signal?: AbortSignal,
): Promise<NekoGatewayClient> {
	signal?.throwIfAborted();
	const link =
		address.transport === "unix" ? await createUnixLink(address.socketPath, signal) : createWsLink(address.url, signal);
	return connectNekoGatewayLink(link, address.serverId, signal);
}

/** 在已建立的链路（Unix、WebSocket 或进程内链路）上完成网关握手与身份校验。 */
export async function connectNekoGatewayLink(
	link: Link,
	serverId: string,
	signal?: AbortSignal,
): Promise<NekoGatewayClient> {
	signal?.throwIfAborted();
	const connection = createGatewayConnection(link, serverId);
	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	link.onClose((reason) => controller.abort(new Error(`Gateway connection closed: ${reason}`)));
	try {
		await connection.ready(controller.signal);
		return connection;
	} catch (error) {
		await connection.close();
		throw error;
	} finally {
		signal?.removeEventListener("abort", abort);
	}
}

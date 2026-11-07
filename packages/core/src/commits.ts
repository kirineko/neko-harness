import type { CommitPublication, Session } from "@earendil-works/pi-durable";

/**
 * Calls `listener` with every stored commit until the returned function is called or the Session ends. The listener
 * runs synchronously inside Pi's publication and must not throw or await (start async work with `void`).
 */
export function onCommits(session: Session, listener: (publication: CommitPublication) => void): () => void {
	const observation = session.observeCommits({ advance: (publication) => listener(publication), end: () => {} });
	return () => observation.detach();
}

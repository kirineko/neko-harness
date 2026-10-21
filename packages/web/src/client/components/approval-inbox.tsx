import { ApprovalQueue } from "@neko-harness/gateway/client-session";
import { useEffect, useRef, useState } from "react";
import { appActions } from "../lib/bootstrap";
import { useT } from "../lib/i18n/index.ts";
import { useNekoState } from "../lib/store";
import { ApprovalCard } from "./approval-card";

/** Only unresolved requests live here; transcript panels do not own approval. */
export function ApprovalInbox() {
	const t = useT();
	const { phase, operating, currentSessionId, view } = useNekoState();
	const [, redraw] = useState(0);
	const live = useRef<ApprovalQueue | null>(null);
	const [queue, setQueue] = useState<ApprovalQueue | null>(null);
	const ready = phase === "ready" && !operating && view !== null;
	useEffect(() => {
		if (!ready || !currentSessionId) return;
		let alive = true;
		const next = new ApprovalQueue(
			(id) => appActions.subagent(id),
			() => {
				if (alive) redraw((n) => n + 1);
			},
		);
		live.current = next;
		setQueue(next);
		return () => {
			alive = false;
			live.current = null;
			next.close();
			setQueue(null);
		};
	}, [ready, currentSessionId]);
	useEffect(() => {
		if (ready && queue === live.current) queue?.update(view?.subagents ?? []);
	}, [queue, ready, view?.subagents]);
	if (!ready || !queue) return null;
	const pending = queue.pending;
	if (!pending.length && !queue.error) return null;
	return (
		<section aria-label={t("approval.inbox")} className="max-h-[40dvh] shrink-0 space-y-2 overflow-auto px-3 py-2">
			{pending.map(({ item, title, service }) => (
				<ApprovalCard
					key={`${item.id}:${item.version}`}
					item={item}
					title={title}
					decide={(decision) => service.decideApproval({ id: item.id, version: item.version, decision })}
				/>
			))}
			{queue.error && (
				<p role="alert" className="text-sm text-sakura-800">
					{queue.error}
				</p>
			)}
		</section>
	);
}

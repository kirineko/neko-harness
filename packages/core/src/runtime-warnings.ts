type Emitter = { emitWarning: (warning: string | Error, ...rest: unknown[]) => void };

/**
 * Node 22 marks `node:sqlite` as experimental and prints a warning as soon as it is loaded (Node 24 no longer does).
 * Storage always goes through it, so drop that one warning and forward everything else.
 * Must run before the storage modules are imported; this module therefore has no imports of its own and, being part
 * of the published launchers, sticks to syntax that very old Node versions can still parse.
 */
export function silenceSqliteWarning(target: Emitter = process as Emitter): void {
	const emit = target.emitWarning;
	target.emitWarning = (warning, ...rest) => {
		const options = rest[0];
		let type = typeof warning === "string" ? undefined : warning.name;
		if (typeof options === "string") type = options;
		else if (options && typeof (options as { type?: unknown }).type === "string")
			type = (options as { type: string }).type;
		const message = typeof warning === "string" ? warning : warning.message;
		if (type === "ExperimentalWarning" && message.startsWith("SQLite")) return;
		emit.call(target, warning, ...rest);
	};
}

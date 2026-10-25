/** Bounds of the per-session change index; hitting one is reported as `truncated`, never dropped silently. */
export const CHANGE_LIMITS = {
	files: 500,
	opsPerFile: 50,
	diffBytes: 2 * 1024 * 1024,
	opDiffBytes: 64 * 1024,
	conversations: 64,
	/** Edit/write calls made by scripts that the session keeps for the change index. */
	nestedRecords: 1000,
};

/** Display diff cut to the per-operation byte limit; the cut is reported, never silent. */
export function clipDiff(diff: string): { diff: string; truncated: boolean } {
	if (Buffer.byteLength(diff, "utf8") <= CHANGE_LIMITS.opDiffBytes) return { diff, truncated: false };
	const lines = diff.split("\n");
	const kept: string[] = [];
	let bytes = 0;
	for (const line of lines) {
		bytes += Buffer.byteLength(line, "utf8") + 1;
		if (bytes > CHANGE_LIMITS.opDiffBytes) break;
		kept.push(line);
	}
	return { diff: kept.join("\n"), truncated: true };
}

/** Returns the message to print when `current` is older than `minimum`; both are `major.minor.patch`, suffixes ignored. */
export function unsupportedNode(current: string, minimum: string): string | undefined {
	const parse = (version: string) =>
		version
			.replace(/^v/, "")
			.split(/[-+]/)[0]!
			.split(".")
			.map((part) => Number.parseInt(part, 10) || 0);
	const have = parse(current);
	const need = parse(minimum);
	for (let i = 0; i < 3; i++) {
		const diff = (have[i] || 0) - (need[i] || 0);
		if (diff > 0) return undefined;
		if (diff < 0) return `neko 需要 Node.js ${minimum} 或更高版本，当前为 ${current}。请升级 Node.js 后重试。`;
	}
	return undefined;
}

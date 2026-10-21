/**
 * Read-only bash allowlist for plan mode, in the spirit of pi's `plan-mode/utils.ts`: regular expressions, not a
 * shell parser. It is a guardrail against a cooperative model's mistakes, not a sandbox.
 *
 * A command passes only when every segment (split on unquoted `;` `&&` `||` `|` and newlines) starts with an
 * allowlisted program and has no dangerous flag, output redirection, heredoc, background `&` or command substitution.
 * Anything not allowlisted (`rm`, `git commit`, `bun run test`, ...) is rejected without needing its own deny rule.
 */

const SAFE_PATTERNS: readonly RegExp[] = [
	/^\s*(cat|head|tail|nl|tac|rev|cut|tr|paste|column|fold|comm|wc|sort|uniq|diff|file|stat|du|df|tree)\b/,
	/^\s*(grep|egrep|fgrep|rg|fd|find|jq|bat|eza|ls|pwd|echo|printf|true|cd)\b/,
	/^\s*(basename|dirname|realpath|readlink|which|whereis|type|sha256sum|shasum|md5sum)\b/,
	/^\s*(uname|whoami|id|date|cal|uptime|ps|free)\b/,
	/^\s*env\s*$/,
	/^\s*printenv\b/,
	/^\s*sed\s+-n\b/,
	/^\s*awk\b/,
	/^\s*curl\b/,
	/^\s*wget\s+-O\s*-/,
	/^\s*git\s+(status|log|diff|show|blame|rev-parse|describe|shortlog|grep|cat-file|merge-base|name-rev|reflog|show-ref|for-each-ref|ls-[\w-]+)\b/,
	/^\s*git\s+config\s+--get\b/,
	/^\s*git\s+stash\s+list\b/,
	/^\s*git\s+branch(\s+(-a|-r|-v|-vv|-l|--all|--remotes|--list|--show-current))*\s*$/,
	/^\s*git\s+remote(\s+(-v|show\b.*|get-url\b.*))?\s*$/,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/,
	/^\s*(bun|pnpm)\s+(pm\s+ls|list|ls|why|outdated|info|view)\b/,
	/^\s*yarn\s+(list|info|why|audit)\b/,
	/^\s*(node|python3?|bun|deno)\s+(-v|--version)\s*$/,
];

/** Flags of allowlisted programs that write, upload or execute. Matched with quoted text removed. */
const DANGEROUS_FLAGS: readonly RegExp[] = [
	/--output\b/,
	/\bfind\b[^|;&]*\s-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)\b/,
	/\bsed\b[^|;&]*(\s-[A-Za-z]*i|--in-place)/,
	/\bsort\b[^|;&]*\s-[A-Za-z]*o/,
	/\btree\b[^|;&]*\s-o\b/,
	/\brg\b[^|;&]*--pre\b/,
	/\bfd\b[^|;&]*(\s-[xX]\b|--exec)/,
	/\bcurl\b[^|;&]*\s(-[A-Za-z]*[oOdXTF]\b|--(output|remote-name|data[\w-]*|request|upload-file|form|json)\b)/,
	/\bnpm\s+audit\s+fix\b/,
];

/** Scripts embedded in quotes (awk programs, sed commands) that write or execute. Matched on the raw segment. */
const DANGEROUS_CONTENT: readonly RegExp[] = [
	/\bawk\b.*(system\s*\(|\bgetline\b|\|\s*"|\bprintf?\b[^}]*>)/,
	/\bsed\b.*['"\s;{0-9$/,][wWe]\s+\S/,
];

interface Segment {
	/** The segment as written. */
	raw: string;
	/** The segment with the content of quotes removed, so `rg "=>"` has no `>`. */
	bare: string;
}

/** Split on unquoted separators. Returns null for unterminated quotes. */
function segments(command: string): Segment[] | null {
	const result: Segment[] = [];
	let raw = "";
	let bare = "";
	let quote: "'" | '"' | null = null;
	const flush = () => {
		if (raw.trim() !== "") result.push({ raw, bare });
		raw = "";
		bare = "";
	};
	for (let i = 0; i < command.length; i++) {
		const char = command[i] as string;
		if (quote) {
			raw += char;
			if (char === "\\" && quote === '"' && i + 1 < command.length) raw += command[++i];
			else if (char === quote) {
				quote = null;
				bare += char;
			}
			continue;
		}
		if (char === "\\" && i + 1 < command.length) {
			raw += char + command[++i];
			bare += " ";
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			raw += char;
			bare += char;
			continue;
		}
		const two = command.slice(i, i + 2);
		if (two === "&&" || two === "||") {
			flush();
			i++;
			continue;
		}
		if (char === ";" || char === "|" || char === "\n") {
			flush();
			continue;
		}
		raw += char;
		bare += char;
	}
	if (quote) return null;
	flush();
	return result;
}

/** Remove redirections that cannot write to a file: `2>&1`, `>/dev/null`, `2>/dev/null`, `&>/dev/null`. */
const stripHarmlessRedirects = (text: string) =>
	text.replace(/[0-9]?>&[0-9-]/g, " ").replace(/(?:[0-9]|&)?>>?\s*\/dev\/null\b/g, " ");

export function isSafeCommand(command: string): boolean {
	const parts = segments(command);
	if (!parts?.length) return false;
	// Substitution runs inside double quotes too; only single quotes make it literal.
	if (/\$\(|`|<\(|>\(/.test(command.replace(/'[^']*'/g, "''"))) return false;
	return parts.every(({ raw, bare }) => {
		const text = stripHarmlessRedirects(bare);
		if (/[>&]|<</.test(text)) return false;
		return (
			SAFE_PATTERNS.some((pattern) => pattern.test(text)) &&
			!DANGEROUS_FLAGS.some((pattern) => pattern.test(text)) &&
			!DANGEROUS_CONTENT.some((pattern) => pattern.test(raw))
		);
	});
}

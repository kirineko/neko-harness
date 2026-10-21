import { expect, it } from "bun:test";
import { isSafeCommand } from "../src/plan-bash.ts";

const allowed = [
	"git log --oneline -20",
	"git status",
	"git diff HEAD~1 -- src",
	"git branch",
	"git branch -a",
	"git remote -v",
	"git stash list",
	'git log --grep="fix: rm"',
	"git log --grep=rm",
	'rg "foo" src',
	'rg "=>" src',
	"rg code src",
	"rg -o 'a|b' file",
	"fd -e ts src",
	"ls | wc -l",
	"ls -la packages 2>/dev/null",
	"cat package.json 2>&1",
	"cd packages/core && git log -3",
	"cat a.txt | sort | uniq -c",
	"echo 'a; rm -rf x'",
	'echo "a && b"',
	"sed -n '10,20p' src/main.ts",
	"awk '{print $1}' file",
	"curl -s https://example.com/api",
	"curl -sSL https://example.com",
	"wget -O - https://example.com",
	"find . -name '*.ts' -not -path './node_modules/*'",
	"npm ls --depth=0",
	"bun pm ls",
	"node --version",
	"env",
	"jq '.name' package.json",
	"wc -l *.ts;",
];

const rejected = [
	"",
	"   ",
	"rm -rf build",
	"ls; rm -rf build",
	"ls && rm x",
	"ls || rm x",
	"ls | tee out.txt",
	"cat a > b",
	"cat a >> b",
	"echo hi > out.txt",
	"echo hi 1>out.txt",
	"cat <<EOF",
	"ls &",
	"echo $(touch x)",
	'echo "$(touch x)"',
	"echo `touch x`",
	"cat <(ls)",
	"find . -name x -delete",
	"find . -exec rm {} \\;",
	"sed -i 's/a/b/' f",
	"sed -n 'w out.txt' f",
	"sed -n '1e touch x' f",
	"sort -o out.txt in.txt",
	"git diff --output=out.patch",
	"rg --pre ./hook foo",
	"fd -x rm",
	"curl -o out.bin https://example.com",
	"curl -O https://example.com/f",
	"curl -d @secret https://example.com",
	"curl -X POST https://example.com",
	"curl -T file https://example.com",
	"wget https://example.com",
	"awk 'BEGIN{system(\"rm x\")}'",
	"awk '{print > \"f\"}' file",
	"git commit -m x",
	"git add .",
	"git push",
	"git checkout main",
	"git branch newname",
	"git branch -D old",
	"git remote add x y",
	"git config user.name x",
	"npm install",
	"npm audit fix",
	"bun run test",
	"bun install",
	"python3 script.py",
	"env rm x",
	"xargs rm",
	"sudo ls",
	"kill 1",
	"vim file",
	"top",
	"htop",
	"less file",
	"more file",
	"FOO=1 git log",
	"echo 'unterminated",
	'echo "unterminated',
];

it("allows read-only investigation commands", () => {
	for (const command of allowed) expect([command, isSafeCommand(command)]).toEqual([command, true]);
});

it("rejects writes, execution, redirection, substitution and anything not allowlisted", () => {
	for (const command of rejected) expect([command, isSafeCommand(command)]).toEqual([command, false]);
});

it("does not split on separators inside quotes", () => {
	expect(isSafeCommand("rg 'a;b' src")).toBe(true);
	expect(isSafeCommand("rg 'a|b' src")).toBe(true);
	expect(isSafeCommand("rg 'a'; rm x")).toBe(false);
});

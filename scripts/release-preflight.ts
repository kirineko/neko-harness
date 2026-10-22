import { appendFileSync, existsSync, statSync } from "node:fs";
import manifest from "../package.json";

// Release preflight. A tag push is a real release and must satisfy every rule;
// a manual dispatch is a rehearsal and only needs a stable package version.
// RELEASE_MAIN_REF lets the rules be exercised locally against a different ref.
const isRelease = process.env.GITHUB_EVENT_NAME === "push";
const version = manifest.version;
const errors: string[] = [];

if (!/^\d+\.\d+\.\d+$/.test(version)) errors.push(`package.json version "${version}" is not a stable X.Y.Z version`);

const notes = `docs/releases/v${version}.md`;
if (isRelease) {
	const tag = process.env.GITHUB_REF_NAME ?? "";
	if (tag !== `v${version}`) errors.push(`tag "${tag}" does not match package.json version (expected v${version})`);

	const sha = process.env.GITHUB_SHA ?? "HEAD";
	const mainRef = process.env.RELEASE_MAIN_REF ?? "origin/main";
	const ancestor = Bun.spawnSync(["git", "merge-base", "--is-ancestor", sha, mainRef], { stderr: "pipe" });
	if (ancestor.exitCode !== 0) errors.push(`commit ${sha} is not on ${mainRef}; release only commits that are on main`);

	if (!existsSync(notes) || statSync(notes).size === 0) errors.push(`release notes ${notes} are missing or empty`);
}

if (errors.length > 0) {
	for (const error of errors) console.error(`::error::${error}`);
	process.exit(1);
}

console.log(`${isRelease ? "Release" : "Rehearsal"} preflight passed for ${version}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);

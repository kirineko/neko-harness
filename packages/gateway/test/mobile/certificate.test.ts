import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import forge from "node-forge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "../../../../test/temp-dir.ts";
import { MobileCertificate, minimalPositiveIntegerHex } from "../../src/mobile/certificate.ts";
import { MobileStore } from "../../src/mobile/store.ts";

const IS_WINDOWS = process.platform === "win32";
const VALIDITY_MS = 825 * 24 * 60 * 60 * 1000;

let dir: string;
let store: MobileStore;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "neko-mobile-cert-"));
	store = await MobileStore.open(dir);
});
afterEach(async () => {
	await chmod(join(dir, "mobile"), 0o700).catch(() => undefined);
	await rm(dir, { recursive: true, force: true });
});

function load(serverId: string): Promise<MobileCertificate> {
	return MobileCertificate.load(store, serverId);
}

function fingerprintOf(certPem: string): string {
	return new X509Certificate(certPem).fingerprint256.replaceAll(":", "").toLowerCase();
}

type NamedExtension = { readonly name: string } & Record<string, unknown>;
function extension(certPem: string, name: string): NamedExtension | undefined {
	const parsed = forge.pki.certificateFromPem(certPem);
	return (parsed.extensions as NamedExtension[]).find((e) => e.name === name);
}

type DerElement = { readonly tag: number; readonly content: Buffer; readonly next: number };
function derElement(buffer: Buffer, offset: number): DerElement {
	const tag = buffer.readUInt8(offset);
	const lengthByte = buffer.readUInt8(offset + 1);
	let length = lengthByte;
	let cursor = offset + 2;
	if ((lengthByte & 0x80) !== 0) {
		const count = lengthByte & 0x7f;
		length = buffer.readUIntBE(cursor, count);
		cursor += count;
	}
	return { tag, content: buffer.subarray(cursor, cursor + length), next: cursor + length };
}

function derSerialContent(certPem: string): Buffer {
	const x509 = new X509Certificate(certPem);
	const certificate = derElement(x509.raw, 0);
	const tbs = derElement(certificate.content, 0);
	let field = derElement(tbs.content, 0);
	if (field.tag === 0xa0) field = derElement(tbs.content, field.next);
	if (field.tag !== 0x02) throw new Error("certificate serialNumber INTEGER not found");
	return field.content;
}

describe("mobile certificate", () => {
	it("generates and persists a certificate and key on first load", async () => {
		const serverId = randomUUID();
		const cert = await load(serverId);
		const expectedCn = `neko-${serverId.slice(0, 8)}.invalid`;

		expect(await readFile(cert.certPath, "utf8")).toBe(cert.certPem);
		expect(await readFile(cert.keyPath, "utf8")).toBe(cert.keyPem);
		const x509 = new X509Certificate(cert.certPem);
		expect(x509.subjectAltName).toBe(`DNS:${expectedCn}`);
		expect(cert.fingerprint).toBe(fingerprintOf(cert.certPem));
	});

	it("issues the design D3 certificate profile", async () => {
		const serverId = randomUUID();
		const cert = await load(serverId);
		const expectedCn = `neko-${serverId.slice(0, 8)}.invalid`;
		const x509 = new X509Certificate(cert.certPem);
		const now = Date.now();

		expect(x509.publicKey.asymmetricKeyType).toBe("rsa");
		expect(x509.publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
		expect(cert.fingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(createHash("sha256").update(x509.raw).digest("hex")).toBe(cert.fingerprint);

		expect(x509.validFromDate.getTime()).toBeLessThanOrEqual(now);
		expect(cert.expiresAt).toBe(x509.validToDate.getTime());
		expect(cert.expiresAt - x509.validFromDate.getTime()).toBe(VALIDITY_MS);
		expect(cert.expiresAt).toBeGreaterThan(now + VALIDITY_MS - 60_000);

		expect(x509.ca).toBe(false);
		const serial = BigInt(`0x${x509.serialNumber}`);
		expect(serial > 0n).toBe(true);
		expect(serial < 1n << 128n).toBe(true);

		const basicConstraints = extension(cert.certPem, "basicConstraints");
		expect(basicConstraints?.cA).toBe(false);
		const keyUsage = extension(cert.certPem, "keyUsage");
		expect(keyUsage?.digitalSignature).toBe(true);
		expect(keyUsage?.keyEncipherment).toBe(true);
		expect(keyUsage?.keyCertSign).toBe(false);
		const extKeyUsage = extension(cert.certPem, "extKeyUsage");
		expect(extKeyUsage?.serverAuth).toBe(true);
		const san = extension(cert.certPem, "subjectAltName");
		expect(san?.altNames).toEqual([{ type: 2, value: expectedCn }]);

		const parsed = forge.pki.certificateFromPem(cert.certPem);
		const subjectAttributes = parsed.subject.attributes as ReadonlyArray<{ name: string; value: string }>;
		expect(subjectAttributes.map((a) => `${a.name}=${a.value}`)).toEqual([`commonName=${expectedCn}`]);
		const issuerAttributes = parsed.issuer.attributes as ReadonlyArray<{ name: string; value: string }>;
		expect(issuerAttributes.map((a) => `${a.name}=${a.value}`)).toEqual([`commonName=${expectedCn}`]);
		expect(parsed.siginfo.algorithmOid).toBe("1.2.840.113549.1.1.11");
	});

	it("encodes injected serial bytes as a minimal positive DER INTEGER", () => {
		const zeros = (count: number) => Array<number>(count).fill(0);
		expect(minimalPositiveIntegerHex(Uint8Array.from([0x80, ...zeros(15)]))).toBe(`0080${"00".repeat(15)}`);
		expect(minimalPositiveIntegerHex(Uint8Array.from(Array<number>(16).fill(0xff)))).toBe(`00${"ff".repeat(16)}`);
		expect(minimalPositiveIntegerHex(Uint8Array.from([0x00, 0x80, ...zeros(14)]))).toBe(`0080${"00".repeat(14)}`);
		expect(minimalPositiveIntegerHex(Uint8Array.from([0x01, ...zeros(15)]))).toBe(`01${"00".repeat(15)}`);
		expect(minimalPositiveIntegerHex(Uint8Array.from(zeros(16)))).toBe("00");
		expect(minimalPositiveIntegerHex(Uint8Array.from([...zeros(15), 0x01]))).toBe("01");
		expect(minimalPositiveIntegerHex(Uint8Array.from([0x7f, ...zeros(15)]))).toBe(`7f${"00".repeat(15)}`);

		const max = minimalPositiveIntegerHex(Uint8Array.from(Array<number>(16).fill(0xff)));
		expect(BigInt(`0x${max}`)).toBe((1n << 128n) - 1n);
		const high = minimalPositiveIntegerHex(Uint8Array.from([0x80, ...zeros(15)]));
		expect(BigInt(`0x${high}`)).toBe(1n << 127n);
	});

	it("serializes full-entropy serial numbers as positive minimal DER INTEGERs", async () => {
		const serverId = randomUUID();
		const cert = await load(serverId);
		let sawPaddedHighBit = false;
		for (let attempt = 0; attempt < 20 && !sawPaddedHighBit; attempt++) {
			const pem = attempt === 0 ? cert.certPem : (await cert.regenerate()).certPem;
			const content = derSerialContent(pem);
			expect(content.length).toBeGreaterThan(0);
			expect(content.length).toBeLessThanOrEqual(17);
			expect(((content[0] ?? 0) & 0x80) === 0).toBe(true);
			if (content.length > 1) {
				expect(content[0] !== 0x00 || ((content[1] ?? 0) & 0x80) !== 0).toBe(true);
			}
			const value = BigInt(`0x${content.toString("hex")}`);
			expect(value).toBe(BigInt(`0x${new X509Certificate(pem).serialNumber}`));
			expect(value).toBe(BigInt(`0x${forge.pki.certificateFromPem(pem).serialNumber}`));
			if (content.length > 1 && content[0] === 0x00 && ((content[1] ?? 0) & 0x80) !== 0) {
				expect(value >= 1n << 127n).toBe(true);
				sawPaddedHighBit = true;
			}
		}
		expect(sawPaddedHighBit).toBe(true);
	});

	it("lowercases the server id in the common name", async () => {
		const serverId = randomUUID();
		const cert = await load(serverId.toUpperCase());
		const x509 = new X509Certificate(cert.certPem);
		expect(x509.subjectAltName).toBe(`DNS:neko-${serverId.slice(0, 8)}.invalid`);
	});

	it("does not regenerate on restart and reloads identical material", async () => {
		const serverId = randomUUID();
		const cert = await load(serverId);
		const diskBefore = await readFile(cert.certPath, "utf8");

		const reopenedStore = await MobileStore.open(dir);
		const reopened = await MobileCertificate.load(reopenedStore, serverId);
		expect(reopened.fingerprint).toBe(cert.fingerprint);
		expect(reopened.expiresAt).toBe(cert.expiresAt);
		expect(reopened.certPem).toBe(cert.certPem);
		expect(reopened.keyPem).toBe(cert.keyPem);
		expect(await readFile(cert.certPath, "utf8")).toBe(diskBefore);
	});

	it("regenerate replaces the persisted certificate with a fresh positive serial", async () => {
		const serverId = randomUUID();
		const expectedCn = `neko-${serverId.slice(0, 8)}.invalid`;
		const cert = await load(serverId);
		const before = cert.fingerprint;
		const serials = [new X509Certificate(cert.certPem).serialNumber];

		const updated = await cert.regenerate();
		expect(updated.fingerprint).not.toBe(before);
		expect(cert.fingerprint).toBe(updated.fingerprint);
		expect(new X509Certificate(updated.certPem).subjectAltName).toBe(`DNS:${expectedCn}`);
		serials.push(new X509Certificate(updated.certPem).serialNumber);

		const reopenedStore = await MobileStore.open(dir);
		const reloaded = await MobileCertificate.load(reopenedStore, serverId);
		expect(reloaded.fingerprint).toBe(updated.fingerprint);
		expect(reloaded.certPem).toBe(updated.certPem);
		expect(await readFile(reloaded.certPath, "utf8")).toBe(updated.certPem);

		const again = await cert.regenerate();
		serials.push(new X509Certificate(again.certPem).serialNumber);
		expect(again.expiresAt - Date.now()).toBeGreaterThan(VALIDITY_MS - 60_000);
		for (const hex of serials) {
			const serial = BigInt(`0x${hex}`);
			expect(serial > 0n).toBe(true);
			expect(serial < 1n << 128n).toBe(true);
		}
		expect(new Set(serials).size).toBe(serials.length);
	});

	it.skipIf(IS_WINDOWS)("writes the private key with 0600 inside the 0700 tls directory", async () => {
		const cert = await load(randomUUID());
		const mode = async (target: string) => (await stat(target)).mode & 0o777;
		expect(await mode(cert.keyPath)).toBe(0o600);
		expect(await mode(store.tlsDir)).toBe(0o700);
	});

	it("rejects a partially written tls directory without adopting either file", async () => {
		const serverId = randomUUID();
		const cert = await load(serverId);
		await rm(cert.keyPath);
		const reopenedStore = await MobileStore.open(dir);
		await expect(MobileCertificate.load(reopenedStore, serverId)).rejects.toThrow("cert.pem");
		await expect(MobileCertificate.load(reopenedStore, serverId)).rejects.toThrow("key.pem");

		const otherDir = await mkdtemp(join(tmpdir(), "neko-mobile-cert-other-"));
		try {
			const otherStore = await MobileStore.open(otherDir);
			const other = await MobileCertificate.load(otherStore, randomUUID());
			await writeFile(cert.keyPath, other.keyPem);
			const failure = await MobileCertificate.load(reopenedStore, serverId).then(
				() => undefined,
				(error: unknown) => error as Error,
			);
			expect(String(failure?.message)).toContain(cert.certPath);
			expect(String(failure?.message)).toContain(cert.keyPath);
		} finally {
			await rm(otherDir, { recursive: true, force: true });
		}
	});

	it("rejects corrupted certificate or key files with a readable error and does not overwrite them", async () => {
		const serverId = randomUUID();
		const cert = await load(serverId);
		const reopenedStore = await MobileStore.open(dir);

		await writeFile(cert.certPath, "not a certificate", "utf8");
		await expect(MobileCertificate.load(reopenedStore, serverId)).rejects.toThrow(cert.certPath);
		expect(await readFile(cert.certPath, "utf8")).toBe("not a certificate");

		const certPem = cert.certPem;
		await writeFile(cert.certPath, certPem, "utf8");
		await writeFile(cert.keyPath, "not a private key", "utf8");
		await expect(MobileCertificate.load(reopenedStore, serverId)).rejects.toThrow(cert.keyPath);
		expect(await readFile(cert.keyPath, "utf8")).toBe("not a private key");
	});

	it("rejects a certificate that does not match the private key", async () => {
		const serverId = randomUUID();
		const cert = await load(serverId);
		const otherDir = await mkdtemp(join(tmpdir(), "neko-mobile-cert-swap-"));
		try {
			const otherStore = await MobileStore.open(otherDir);
			const other = await MobileCertificate.load(otherStore, randomUUID());

			await writeFile(cert.keyPath, other.keyPem, "utf8");
			const storeAfterKeySwap = await MobileStore.open(dir);
			await expect(MobileCertificate.load(storeAfterKeySwap, serverId)).rejects.toThrow("does not match");
			expect(await readFile(cert.certPath, "utf8")).toBe(cert.certPem);

			await writeFile(cert.keyPath, cert.keyPem, "utf8");
			await writeFile(cert.certPath, other.certPem, "utf8");
			const storeAfterCertSwap = await MobileStore.open(dir);
			await expect(MobileCertificate.load(storeAfterCertSwap, serverId)).rejects.toThrow("does not match");
		} finally {
			await rm(otherDir, { recursive: true, force: true });
		}
	});

	it("never prints or logs the private key", async () => {
		const serverId = randomUUID();
		const logSpy = vi.spyOn(console, "log");
		const infoSpy = vi.spyOn(console, "info");
		const warnSpy = vi.spyOn(console, "warn");
		const errorSpy = vi.spyOn(console, "error");
		let keyPem = "";
		try {
			const cert = await load(serverId);
			keyPem = cert.keyPem;
			await cert.regenerate();
			const reopenedStore = await MobileStore.open(dir);
			await MobileCertificate.load(reopenedStore, serverId);
		} finally {
			logSpy.mockRestore();
			infoSpy.mockRestore();
			warnSpy.mockRestore();
			errorSpy.mockRestore();
		}
		const calls = [...logSpy.mock.calls, ...infoSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
		for (const call of calls) {
			const text = call.map((arg) => String(arg)).join(" ");
			expect(text.includes("PRIVATE KEY")).toBe(false);
			expect(text.includes(keyPem.trim())).toBe(false);
		}
	});
});

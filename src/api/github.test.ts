import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	parseRepo,
	githubFilePath,
	gitBlobSha,
	githubGetFile,
	githubListFolder,
	githubPutFile,
	githubTestConnection,
	GithubTarget,
} from "./github";
import { FakeGithub } from "../plugin/__tests__/sync-test-harness";

// api/github.ts imports requestUrl/arrayBufferToBase64 from "obsidian" (types only on the npm side,
// see scryfall.test.ts): requestUrl is redirected to an in-memory fake GitHub server.
const mocks = vi.hoisted(() => ({ gh: null as unknown as FakeGithub }));

vi.mock("obsidian", () => ({
	requestUrl: (p: Parameters<FakeGithub["request"]>[0]) => mocks.gh.request(p),
	arrayBufferToBase64: (b: ArrayBuffer) => Buffer.from(b).toString("base64"),
	Notice: class {},
	Platform: {},
	normalizePath: (p: string) => p,
}));

let gh: FakeGithub;
const target = (over: Partial<GithubTarget> = {}): GithubTarget => ({
	repo: gh.repo,
	branch: "main",
	path: "mtg-collection",
	token: gh.token,
	...over,
});
const NAME = "list-a.json.gz";
const FILE = `mtg-collection/${NAME}`;
const LEGACY = "mtg-collection/data.json";
const storedSha = (path = FILE) => gh.files.get(path)!.sha;

beforeEach(() => {
	gh = new FakeGithub();
	mocks.gh = gh;
});

describe("parseRepo / githubFilePath", () => {
	it("accepts owner/name only", () => {
		expect(parseRepo("Louis1190/mtg-data")).toEqual({ owner: "Louis1190", name: "mtg-data" });
		expect(parseRepo("  a.b/c_d-e ")).toEqual({ owner: "a.b", name: "c_d-e" });
		for (const bad of ["", "nope", "a/b/c", "/b", "a/", "a b/c", "https://github.com/a/b"]) expect(parseRepo(bad), bad).toBeNull();
	});

	it("normalizes the folder and refuses to climb out of it", () => {
		const t = (path: string) => githubFilePath(target({ path }), "core.json.gz");
		expect(t("mtg-collection")).toBe("mtg-collection/core.json.gz");
		expect(t("/a//b/")).toBe("a/b/core.json.gz");
		expect(t("../../etc")).toBe("etc/core.json.gz");
		expect(t("")).toBe("core.json.gz");
		expect(t(" ./ ")).toBe("core.json.gz");
	});
});

describe("gitBlobSha", () => {
	it("matches git's own blob hashes", async () => {
		expect(await gitBlobSha(new TextEncoder().encode(""))).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
		expect(await gitBlobSha(new TextEncoder().encode("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
	});

	it("hashes bytes, not characters", async () => {
		const text = "Æther Vial — « Lim-Dûl » 日本語 🎴";
		expect(await gitBlobSha(new TextEncoder().encode(text))).toBe(FakeGithub.sha(Buffer.from(text, "utf8")));
	});
});

describe("githubGetFile", () => {
	it("reports a file that does not exist yet", async () => {
		expect((await githubGetFile(target(), NAME)).kind).toBe("missing");
	});

	it("returns the exact text and the blob sha of the STORED (compressed) bytes", async () => {
		const text = JSON.stringify({ name: "Æther « Vial »", n: 1 });
		gh.setFile(FILE, text);
		expect(await githubGetFile(target(), NAME)).toMatchObject({ kind: "ok", text, sha: storedSha() });
		gh.setFile(FILE, text + " ");
		expect(await githubGetFile(target(), NAME)).toMatchObject({ kind: "ok", text: text + " ", sha: storedSha() });
	});

	it("rejects a bad token as a lasting failure, without leaking the token", async () => {
		const got = await githubGetFile(target({ token: "ghp_SECRET_VALUE_123" }), NAME);
		expect(got).toMatchObject({ kind: "error", status: 401, fatal: true });
		expect(JSON.stringify(got)).not.toContain("SECRET_VALUE");
	});

	it("treats a missing branch as a lasting failure, not as 'file missing'", async () => {
		expect(await githubGetFile(target({ branch: "nope" }), NAME)).toMatchObject({ kind: "error", status: 404, fatal: true });
	});

	it("tells a rate limit (retry later) from a refused token (lasting)", async () => {
		const real = gh.request;
		gh.request = async (p) => ({ ...(await real(p)), status: 403, headers: { "x-ratelimit-remaining": "0", "retry-after": "90" }, json: {} });
		expect(await githubGetFile(target(), NAME)).toMatchObject({ kind: "error", status: 403, fatal: false, retryAfterS: 90 });
		gh.request = async (p) => ({ ...(await real(p)), status: 403, headers: {}, json: { message: "Resource not accessible" } });
		expect(await githubGetFile(target(), NAME)).toMatchObject({ kind: "error", status: 403, fatal: true });
	});

	it("treats a server error and a network failure as temporary", async () => {
		gh.forcedStatus = 503;
		expect(await githubGetFile(target(), NAME)).toMatchObject({ kind: "error", status: 503, fatal: false });
		gh.forcedStatus = null;
		gh.offline = true;
		expect(await githubGetFile(target(), NAME)).toMatchObject({ kind: "error", status: 0, fatal: false });
	});

	it("refuses a repository that is not owner/name before any request", async () => {
		const got = await githubGetFile(target({ repo: "oops" }), NAME);
		expect(got).toMatchObject({ kind: "error", fatal: true });
		expect(gh.calls).toEqual([]);
	});
});

describe("githubListFolder", () => {
	it("lists every file of the folder with its blob sha, without downloading any", async () => {
		gh.setFile("mtg-collection/core.json.gz", JSON.stringify({ filler: "x".repeat(2_000_000) }));
		gh.setFile(FILE, "{}");
		gh.setFile("mtg-collection/README.md", "hi");
		const listing = await githubListFolder(target(), null);
		expect(listing.kind).toBe("ok");
		if (listing.kind !== "ok") return;
		expect(listing.entries.map((e) => [e.name, e.sha]).sort()).toEqual(
			[
				["README.md", storedSha("mtg-collection/README.md")],
				["core.json.gz", storedSha("mtg-collection/core.json.gz")],
				[NAME, storedSha()],
			].sort()
		);
		expect(listing.etag).toBeTruthy();
		expect(gh.rawGets).toBe(0);
		expect(gh.listings).toBe(1);
	});

	it("is conditional: nothing changed is a free 304, any change anywhere is a new listing", async () => {
		gh.setFile(FILE, "one");
		const first = await githubListFolder(target(), null);
		const etag = first.kind === "ok" ? first.etag : null;
		expect(await githubListFolder(target(), etag)).toEqual({ kind: "notModified" });
		gh.setFile(FILE, "two");
		expect(await githubListFolder(target(), etag)).toMatchObject({ kind: "ok" });
		gh.setFile("mtg-collection/new.json.gz", "x");
		const after = await githubListFolder(target(), null);
		expect(after.kind === "ok" && after.entries.length).toBe(2);
	});

	it("a folder that does not exist yet is 'missing', not an error", async () => {
		expect(await githubListFolder(target(), null)).toEqual({ kind: "missing" });
	});

	it("lists the repository root when the folder name is empty", async () => {
		gh.setFile("data.json.gz", "{}");
		const listing = await githubListFolder(target({ path: "" }), null);
		expect(listing.kind === "ok" && listing.entries.map((e) => e.name)).toEqual(["data.json.gz"]);
	});

	it("an answer it cannot trust is an error, never a silent partial sync", async () => {
		gh.setFile(FILE, "x");
		gh.listingFault = "object";
		expect(await githubListFolder(target(), null)).toMatchObject({ kind: "error", fatal: true, message: expect.stringMatching(/not a folder listing/) });
		gh.listingFault = 422;
		expect(await githubListFolder(target(), null)).toMatchObject({ kind: "error", fatal: false });
	});

	it("refuses a listing that GitHub cut at 1 000 files", async () => {
		const real = gh.request;
		gh.request = async (p) => {
			const res = await real(p);
			return res.status === 200 ? { ...res, json: Array.from({ length: 1000 }, (_, i) => ({ name: `f${i}`, type: "file", sha: "0".repeat(40), size: 1 })) } : res;
		};
		gh.setFile(FILE, "x");
		expect(await githubListFolder(target(), null)).toMatchObject({ kind: "error", fatal: true, message: expect.stringMatching(/1 000 files/) });
	});

	it("still reports a bad token, a wrong branch and a network failure as such", async () => {
		gh.setFile(FILE, "x");
		expect(await githubListFolder(target({ token: "bad" }), null)).toMatchObject({ kind: "error", status: 401, fatal: true });
		expect(await githubListFolder(target({ branch: "dev" }), null)).toMatchObject({ kind: "error", status: 404, fatal: true });
		gh.offline = true;
		expect(await githubListFolder(target(), null)).toMatchObject({ kind: "error", status: 0, fatal: false });
	});
});

describe("a request that never answers", () => {
	const hang = () => {
		gh.request = () => new Promise(() => {}); // neither a response nor an error, ever
	};

	it("gives up after the timeout instead of blocking forever, with a readable reason", async () => {
		hang();
		const t = target({ timeoutMs: 40 });
		const listing = await githubListFolder(t, null);
		expect(listing).toMatchObject({ kind: "error", status: 0, fatal: false, message: expect.stringMatching(/listing the data folder: no answer after/) });
		expect(await githubGetFile(t, NAME)).toMatchObject({ kind: "error", fatal: false, message: expect.stringMatching(/downloading a data file: no answer/) });
		expect(await githubPutFile(t, NAME, "x", null, "m")).toMatchObject({ kind: "error", fatal: false, message: expect.stringMatching(/uploading: no answer/) });
	});

	it("keeps the cause of a real network error, and never the token", async () => {
		gh.request = async () => {
			throw new Error("net::ERR_CERT_DATE_INVALID while using github_pat_SECRETSECRET123");
		};
		const got = await githubGetFile(target(), NAME);
		expect(got).toMatchObject({ kind: "error", message: expect.stringMatching(/ERR_CERT_DATE_INVALID/) });
		expect(JSON.stringify(got)).not.toContain("SECRETSECRET");
	});
});

describe("compression", () => {
	it("stores the data gzip-compressed, about 8 times smaller on a realistic payload", async () => {
		const cards = Array.from({ length: 3000 }, (_, i) => ({
			id: `id${i}`,
			name: `Card number ${i}`,
			imageUrl: `https://cards.scryfall.io/normal/front/a/b/${i}-0000-4000-8000-000000000000.jpg?1700000000`,
			oracleText: "Flying, vigilance. Whenever this creature attacks, you gain 2 life.",
			count: 1,
		}));
		const text = JSON.stringify({ collection: cards });
		await githubPutFile(target(), NAME, text, null, "m");
		const stored = gh.files.get(FILE)!.bytes;
		expect([stored[0], stored[1]]).toEqual([0x1f, 0x8b]); // gzip magic number
		expect(stored.length).toBeLessThan(text.length / 5);
		const got = await githubGetFile(target(), NAME);
		expect(got.kind === "ok" && got.text === text).toBe(true);
	});

	it("reads the old uncompressed file as plain text when asked to", async () => {
		gh.setFile(LEGACY, '{"collection":[{"id":"a"}]}');
		const got = await githubGetFile(target(), "data.json");
		expect(got).toMatchObject({ kind: "ok", text: '{"collection":[{"id":"a"}]}', sha: storedSha(LEGACY) });
	});

	it("reports a data file that is not valid gzip as a lasting failure", async () => {
		gh.setRaw(FILE, Buffer.from("this is not gzip at all"));
		expect(await githubGetFile(target(), NAME)).toMatchObject({ kind: "error", fatal: true, message: expect.stringMatching(/not valid compressed/) });
	});

	it("tells a device without gzip support instead of silently diverging", async () => {
		const real = globalThis.CompressionStream;
		(globalThis as { CompressionStream?: unknown }).CompressionStream = undefined;
		try {
			expect(await githubGetFile(target(), NAME)).toMatchObject({ kind: "error", fatal: true, message: expect.stringMatching(/cannot read the compressed/) });
			expect(await githubPutFile(target(), NAME, "x", null, "m")).toMatchObject({ kind: "error", fatal: true });
			expect((await githubTestConnection(target())).lines[0]).toMatch(/cannot read the compressed/);
		} finally {
			(globalThis as { CompressionStream?: unknown }).CompressionStream = real;
		}
	});
});

describe("githubPutFile", () => {
	it("creates a file, then replaces it with the sha it was given", async () => {
		const created = await githubPutFile(target(), NAME, "one", null, "m");
		expect(created).toMatchObject({ kind: "ok", sha: storedSha() });
		expect(gh.text(FILE)).toBe("one");
		const updated = await githubPutFile(target(), NAME, "two", created.kind === "ok" ? created.sha : null, "m");
		expect(updated.kind).toBe("ok");
		expect(gh.text(FILE)).toBe("two");
		expect(gh.calls).toEqual(["PUT 201", "PUT 200"]);
	});

	it("is a compare-and-swap: a stale sha, or no sha for an existing file, is a conflict", async () => {
		gh.setFile(FILE, "theirs");
		expect(await githubPutFile(target(), NAME, "mine", "0".repeat(40), "m")).toEqual({ kind: "conflict" });
		expect(await githubPutFile(target(), NAME, "mine", null, "m")).toEqual({ kind: "conflict" });
		expect(gh.text(FILE)).toBe("theirs");
	});

	it("reports the sha of what it wrote even if the reply omits it", async () => {
		const real = gh.request;
		gh.request = async (p) => ({ ...(await real(p)), json: {} });
		const put = await githubPutFile(target(), NAME, "content", null, "m");
		expect(put).toEqual({ kind: "ok", sha: storedSha() });
	});

	it("round-trips non-ASCII text and a multi-megabyte payload byte for byte", async () => {
		const big = JSON.stringify({ cards: Array.from({ length: 30000 }, (_, i) => ({ id: i, name: `Æther Vial ${i} « é »`, price: "1.23" })) });
		expect(big.length).toBeGreaterThan(1_500_000);
		await githubPutFile(target(), NAME, big, null, "m");
		const got = await githubGetFile(target(), NAME);
		expect(got.kind === "ok" && got.text === big).toBe(true);
	});

	it("does not turn another 422 into a conflict", async () => {
		const real = gh.request;
		gh.request = async (p) => ({ ...(await real(p)), status: 422, json: { message: "Invalid request: path is protected" } });
		expect(await githubPutFile(target(), NAME, "x", null, "m")).toMatchObject({ kind: "error", status: 422 });
	});

	it("a wrong repository is a lasting failure", async () => {
		expect(await githubPutFile(target({ repo: "louis/other" }), NAME, "x", null, "m")).toMatchObject({ kind: "error", status: 404, fatal: true });
	});
});

describe("githubTestConnection", () => {
	it("walks token, repository, branch and file", async () => {
		const ok = await githubTestConnection(target());
		expect(ok.ok).toBe(true);
		expect(ok.lines.join("\n")).toMatch(/Token accepted.*louis/);
		expect(ok.lines.join("\n")).toMatch(/does not exist yet/);
		gh.setFile("mtg-collection/core.json.gz", "{}");
		expect((await githubTestConnection(target())).lines.join("\n")).toMatch(/already holds 1 data file.*MERGE/);
		gh.setFile(FILE, "{}");
		expect((await githubTestConnection(target())).lines.join("\n")).toMatch(/already holds 2 data files/);
	});

	it("recognizes the data of an earlier version, and an empty folder", async () => {
		gh.setFile("mtg-collection/data.json.gz", "{}");
		expect((await githubTestConnection(target())).lines.join("\n")).toMatch(/earlier version \(data\.json\.gz\).*split it into several files/);
		gh.files.clear();
		gh.setFile("mtg-collection/notes.txt", "hello");
		expect((await githubTestConnection(target())).lines.join("\n")).toMatch(/has no data yet/);
	});

	it("explains each way it can fail", async () => {
		expect((await githubTestConnection(target({ token: "bad" }))).lines[0]).toMatch(/rejected the token/);
		expect((await githubTestConnection(target({ token: "" }))).lines[0]).toMatch(/No token/);
		expect((await githubTestConnection(target({ repo: "louis/other" }))).lines.join(" ")).toMatch(/not found/i);
		expect((await githubTestConnection(target({ branch: "dev" }))).lines.join(" ")).toMatch(/Branch "dev" not found/);
		gh.canPush = false;
		expect((await githubTestConnection(target())).lines.join(" ")).toMatch(/cannot write/);
		gh.canPush = true;
		gh.offline = true;
		expect((await githubTestConnection(target())).lines[0]).toMatch(/Could not reach GitHub/);
	});

	it("warns when the repository is public", async () => {
		gh.isPrivate = false;
		const r = await githubTestConnection(target());
		expect(r.ok).toBe(true);
		expect(r.lines.join(" ")).toMatch(/PUBLIC/);
	});
});

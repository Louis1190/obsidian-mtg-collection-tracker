import { arrayBufferToBase64, requestUrl, RequestUrlResponse } from "obsidian";

/* -------------------------------------------------------------------------- */
/* Minimal client for GitHub's REST API (Contents) for data synchronization
    (2026-10-03, split into shards since 2026-10-05) — see src/plugin/github-sync.ts for
    the engine and core/github-shards.ts for the split.

    Choices, all for the same reason (a few files, a few MB, a single user):
    - "Contents" API (one PUT = one commit) rather than Git Data
      (blobs/trees/commits/refs): one request instead of four, and the `sha` required to
      replace a file is exactly the compare-and-swap we need (409/422 if someone got in
      between).
    - Reading as `raw`: no 1 MB limit as with the JSON representation (which returns
      empty content between 1 and 100 MB). The `sha` of this content is therefore
      COMPUTED here (sha1 of a git blob), not read: it thus matches exactly the bytes we
      just merged, and not a version that arrived between a read and a second metadata
      request.
    - Polling through the folder listing, as a conditional request (If-None-Match): an
      authenticated 304 does not count against the 5,000 requests/hour limit, and a 200
      gives the sha of all the files at once.
    - Writes are SEQUENTIAL: two simultaneous PUTs on the same branch reject each other
      (each creates a commit on the same head).
    No function here logs or returns the token. */
/* -------------------------------------------------------------------------- */

export const GITHUB_API_BASE = "https://api.github.com";
// Since 1.0.512 the data is split into several files (core.json.gz, list-<id>.json.gz… — see
// core/github-shards.ts), all in the same folder. The two old single files are now only READ, once, to seed
// the shards: `data.json.gz` (1.0.507 to 1.0.511, gzip of the compact JSON) and `data.json` (≤ 1.0.506, raw
// JSON).
export const GITHUB_DATA_FILE = "data.json.gz";
export const GITHUB_LEGACY_FILE = "data.json";
const API_VERSION = "2022-11-28";

export interface GithubTarget {
	/** "owner/name" */
	repo: string;
	branch: string;
	/** Folder of the repository that contains the file ("" = root). */
	path: string;
	token: string;
	/** Overridable for tests; GITHUB_API_BASE otherwise. */
	apiBase?: string;
	/** Maximum duration of a read (ms); REQUEST_TIMEOUT_MS otherwise. Uploading gets triple. */
	timeoutMs?: number;
}

export const REQUEST_TIMEOUT_MS = 20 * 1000;

function withTimeout<T>(request: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => reject(new Error(`no answer after ${Math.round(ms / 1000)} s`)), ms);
		request.then(
			(v) => {
				window.clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				window.clearTimeout(timer);
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		);
	});
}

export type GithubGetResult =
	| { kind: "missing" }
	| { kind: "ok"; text: string; sha: string }
	| GithubFailure;

export interface GithubEntry {
	name: string;
	/** sha of the file's git blob (the one of the STORED, compressed bytes). */
	sha: string;
	size: number;
}

export type GithubListResult =
	| { kind: "ok"; entries: GithubEntry[]; etag: string | null }
	| { kind: "notModified" }
	/** The folder doesn't exist yet (the repository and the branch do). */
	| { kind: "missing" }
	| GithubFailure;

export type GithubPutResult =
	| { kind: "ok"; sha: string }
	/** The file has changed (or already exists) since the version being replaced: re-read, merge, retry. */
	| { kind: "conflict" }
	| GithubFailure;

export interface GithubFailure {
	kind: "error";
	status: number; // 0 = no response (network)
	/** Ready-to-display sentence, never the raw content of the response. */
	message: string;
	/** Lasting fault (token, permissions, repository): no point retrying as is. */
	fatal: boolean;
	retryAfterS?: number;
}

/* ------------------------------- compression ------------------------------- */

// CompressionStream / DecompressionStream: Chromium (Obsidian desktop, Android WebView) and WebKit
// 16.4+ (iOS / iPadOS). A device that lacks them cannot read the GitHub file: we tell it so rather than
// let it silently diverge.
export function compressionSupported(): boolean {
	return typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";
}

async function pipeThrough(bytes: Uint8Array, transform: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }) {
	const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform);
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
	return pipeThrough(bytes, new CompressionStream("gzip") as never);
}

export function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
	return pipeThrough(bytes, new DecompressionStream("gzip") as never);
}

export function parseRepo(repo: string): { owner: string; name: string } | null {
	const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo.trim());
	return m ? { owner: m[1], name: m[2] } : null;
}

function cleanPath(path: string): string {
	return path
		.split("/")
		.map((s) => s.trim())
		.filter((s) => s.length > 0 && s !== "." && s !== "..")
		.join("/");
}

// Path of a file of the data folder in the repository.
export function githubFilePath(target: GithubTarget, name: string): string {
	const dir = cleanPath(target.path);
	return dir ? `${dir}/${name}` : name;
}

function repoBase(target: GithubTarget): string | null {
	const r = parseRepo(target.repo);
	if (!r) return null;
	return `${target.apiBase ?? GITHUB_API_BASE}/repos/${r.owner}/${r.name}/contents`;
}

// URL of the "contents" API for a file of the data folder (name) or for the folder itself (name = null).
function contentsUrl(target: GithubTarget, name: string | null, withRef: boolean): string | null {
	const base = repoBase(target);
	if (!base) return null;
	const path = name === null ? cleanPath(target.path) : githubFilePath(target, name);
	const encoded = path
		.split("/")
		.filter((seg) => seg.length > 0)
		.map(encodeURIComponent)
		.join("/");
	const url = `${base}${encoded ? `/${encoded}` : ""}`;
	return withRef ? `${url}?ref=${encodeURIComponent(target.branch || "main")}` : url;
}

function authHeaders(target: GithubTarget, accept: string): Record<string, string> {
	return {
		Authorization: `Bearer ${target.token}`,
		Accept: accept,
		"X-GitHub-Api-Version": API_VERSION,
		"Cache-Control": "no-cache",
		Pragma: "no-cache",
	};
}

// A counter, not just the time: two polls within the same millisecond (and the tests' frozen clock)
// would otherwise give the same URL.
let freshCounter = 0;
function freshUrl(url: string): string {
	return `${url}${url.includes("?") ? "&" : "?"}_=${Date.now().toString(36)}${(++freshCounter).toString(36)}`;
}

// sha1 of a git blob: sha1("blob <size>\0" + bytes). This is the `sha` the API
// expects in order to replace a file.
export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
	const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
	const all = new Uint8Array(header.length + bytes.length);
	all.set(header, 0);
	all.set(bytes, header.length);
	const digest = await crypto.subtle.digest("SHA-1", all);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function header(res: RequestUrlResponse, name: string): string | null {
	const h = res.headers ?? {};
	return h[name] ?? h[name.toLowerCase()] ?? null;
}

function failure(res: RequestUrlResponse | null, fallback: string): GithubFailure {
	if (!res) return { kind: "error", status: 0, message: fallback, fatal: false };
	const status = res.status;
	if (status === 401) {
		return { kind: "error", status, fatal: true, message: "GitHub rejected the token (wrong, expired or revoked)." };
	}
	const remaining = header(res, "x-ratelimit-remaining");
	const retryAfter = Number(header(res, "retry-after"));
	if (status === 429 || (status === 403 && (remaining === "0" || Number.isFinite(retryAfter) && retryAfter > 0))) {
		return {
			kind: "error",
			status,
			fatal: false,
			message: "GitHub is rate-limiting this token; sync will retry shortly.",
			retryAfterS: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60,
		};
	}
	if (status === 403) {
		return {
			kind: "error",
			status,
			fatal: true,
			message: 'The token is not allowed to do this. It needs "Contents: Read and write" on the repository.',
		};
	}
	if (status === 404) {
		return {
			kind: "error",
			status,
			fatal: true,
			message:
				"Repository or branch not found (GitHub also answers 404 when the token has no access to a private repository).",
		};
	}
	if (status >= 500) return { kind: "error", status, fatal: false, message: `GitHub is unavailable (${status}).` };
	return { kind: "error", status, fatal: false, message: `Unexpected answer from GitHub (${status}).` };
}

const NETWORK_FAILURE = "Could not reach GitHub (offline, or a network that blocks it).";

// The message of a network exception is what tells "offline" apart from a rejected certificate, a blocking
// DNS or a timeout: we add it to the displayed text (never the token, never the full URL).
function networkMessage(step: string, e: unknown): string {
	console.warn(`MTG Collection Tracker: GitHub request failed (${step}).`, e);
	const reason = (e instanceof Error ? e.message : String(e))
		.replace(/\s+/g, " ")
		.replace(/(github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, "…")
		.slice(0, 140);
	return `${NETWORK_FAILURE} [${step}: ${reason || "no detail"}]`;
}

// Reads a file of the data folder and returns its text (decompressed if it ends in .gz) and its sha.
// Read as `raw`: no 1 MB limit as with the JSON representation. The sha is COMPUTED over the bytes received,
// not read: it matches exactly what we just merged, even if the file changed between a listing and this read.
export async function githubGetFile(target: GithubTarget, name: string): Promise<GithubGetResult> {
	const gz = name.endsWith(".gz");
	if (gz && !compressionSupported()) return unsupportedCompression();
	const url = contentsUrl(target, name, true);
	if (!url) return { kind: "error", status: 0, fatal: true, message: 'The repository must look like "owner/name".' };
	let res: RequestUrlResponse;
	try {
		res = await withTimeout(
			requestUrl({ url: freshUrl(url), method: "GET", headers: authHeaders(target, "application/vnd.github.raw+json"), throw: false }),
			target.timeoutMs ?? REQUEST_TIMEOUT_MS
		);
	} catch (e) {
		return failure(null, networkMessage("downloading a data file", e));
	}
	if (res.status === 200) {
		const bytes = new Uint8Array(res.arrayBuffer);
		const sha = await gitBlobSha(bytes);
		let text: string;
		try {
			text = new TextDecoder().decode(gz ? await gunzipBytes(bytes) : bytes);
		} catch {
			return { kind: "error", status: 0, fatal: true, message: "A data file on GitHub is not valid compressed data." };
		}
		return { kind: "ok", text, sha };
	}
	// File missing (the repository and branch exist, the file doesn't yet) ≠ repository not found:
	// GitHub answers 404 to both, only the message tells them apart.
	if (res.status === 404 && /not found/i.test(safeMessage(res)) && !/repository|branch|ref/i.test(safeMessage(res))) {
		return { kind: "missing" };
	}
	return failure(res, NETWORK_FAILURE);
}

function unsupportedCompression(): GithubFailure {
	return {
		kind: "error",
		status: 0,
		fatal: true,
		message: "This device's web view cannot read the compressed data files (it needs a recent Obsidian / iOS 16.4 or later).",
	};
}

function safeMessage(res: RequestUrlResponse): string {
	try {
		const m = (res.json as { message?: unknown } | undefined)?.message;
		return typeof m === "string" ? m : "";
	} catch {
		return "";
	}
}

// Lists the data folder: the name and sha of each file, a few hundred bytes per file whatever their size.
// This is the polling: a conditional request (If-None-Match) whose 304 answer costs nothing, and whose 200
// gives the fingerprints of ALL the shards at once — we only download those whose sha has changed. The API
// truncates a folder at 1,000 files: we complain rather than silently synchronize part of the data.
export async function githubListFolder(target: GithubTarget, etag: string | null): Promise<GithubListResult> {
	const url = contentsUrl(target, null, true);
	if (!url) return { kind: "error", status: 0, fatal: true, message: 'The repository must look like "owner/name".' };
	const headers = authHeaders(target, "application/vnd.github+json");
	if (etag) headers["If-None-Match"] = etag;
	let res: RequestUrlResponse;
	try {
		res = await withTimeout(
			requestUrl({ url: freshUrl(url), method: "GET", headers, throw: false }),
			target.timeoutMs ?? REQUEST_TIMEOUT_MS
		);
	} catch (e) {
		return failure(null, networkMessage("listing the data folder", e));
	}
	if (res.status === 304) return { kind: "notModified" };
	if (res.status === 200) {
		const listing = res.json as unknown;
		if (!Array.isArray(listing)) {
			return { kind: "error", status: 200, fatal: true, message: "GitHub answered with something that is not a folder listing (is the folder name a file?)." };
		}
		if (listing.length >= 1000) {
			return { kind: "error", status: 200, fatal: true, message: "The data folder holds 1 000 files or more: GitHub cuts its listing there. Use a folder with fewer files." };
		}
		const entries: GithubEntry[] = [];
		for (const e of listing) {
			if (!e || typeof e !== "object") continue;
			const o = e as { name?: unknown; type?: unknown; sha?: unknown; size?: unknown };
			if (o.type === "file" && typeof o.name === "string" && typeof o.sha === "string") {
				entries.push({ name: o.name, sha: o.sha, size: typeof o.size === "number" ? o.size : 0 });
			}
		}
		return { kind: "ok", entries, etag: header(res, "etag") };
	}
	if (res.status === 404 && /not found/i.test(safeMessage(res)) && !/repository|branch|ref/i.test(safeMessage(res))) {
		return { kind: "missing" }; // folder not created yet: neither are the files
	}
	return failure(res, NETWORK_FAILURE);
}

// Writes a file of the data folder (always compressed). `sha` = the version being replaced (null = we create it).
export async function githubPutFile(
	target: GithubTarget,
	name: string,
	text: string,
	sha: string | null,
	message: string
): Promise<GithubPutResult> {
	const url = contentsUrl(target, name, false);
	if (!url) return { kind: "error", status: 0, fatal: true, message: 'The repository must look like "owner/name".' };
	if (!compressionSupported()) return unsupportedCompression();
	const bytes = await gzipBytes(new TextEncoder().encode(text));
	const body: Record<string, unknown> = {
		message,
		content: arrayBufferToBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer),
		branch: target.branch || "main",
	};
	if (sha) body.sha = sha;
	let res: RequestUrlResponse;
	try {
		res = await withTimeout(
			requestUrl({
				url,
				method: "PUT",
				headers: authHeaders(target, "application/vnd.github+json"),
				contentType: "application/json",
				body: JSON.stringify(body),
				throw: false,
			}),
			(target.timeoutMs ?? REQUEST_TIMEOUT_MS) * 3
		);
	} catch (e) {
		return failure(null, networkMessage("uploading", e));
	}
	if (res.status === 200 || res.status === 201) {
		const created = (res.json as { content?: { sha?: unknown } } | undefined)?.content?.sha;
		// With no sha in the response, we recompute it: it is the one of the bytes we just sent.
		return { kind: "ok", sha: typeof created === "string" ? created : await gitBlobSha(bytes) };
	}
	// 409: the file has changed since `sha`. 422: "sha wasn't supplied" (it already exists) or
	// "does not match" — same remedy, re-read then merge. Other 422s are real errors.
	if (res.status === 409) return { kind: "conflict" };
	if (res.status === 422 && /\bsha\b/i.test(safeMessage(res))) return { kind: "conflict" };
	return failure(res, NETWORK_FAILURE);
}

export interface GithubConnectionReport {
	ok: boolean;
	lines: string[];
}

// Checks, without writing anything, that the token does open the repository, that the
// branch exists and what is already in it. Write permissions can only be proven by a write:
// they are judged on the first upload.
export async function githubTestConnection(target: GithubTarget): Promise<GithubConnectionReport> {
	const r = parseRepo(target.repo);
	if (!r) return { ok: false, lines: ['✕ The repository must look like "owner/name".'] };
	if (!target.token) return { ok: false, lines: ["✕ No token set on this device."] };
	if (!compressionSupported()) return { ok: false, lines: [`✕ ${unsupportedCompression().message}`] };
	const base = target.apiBase ?? GITHUB_API_BASE;
	const get = async (path: string): Promise<RequestUrlResponse | null> => {
		try {
			return await requestUrl({ url: `${base}${path}`, method: "GET", headers: authHeaders(target, "application/vnd.github+json"), throw: false });
		} catch {
			return null;
		}
	};
	const lines: string[] = [];
	const user = await get("/user");
	if (!user) return { ok: false, lines: [`✕ ${NETWORK_FAILURE}`] };
	if (user.status !== 200) return { ok: false, lines: [`✕ ${failure(user, "").message}`] };
	lines.push(`✓ Token accepted (${String((user.json as { login?: unknown })?.login ?? "?")}).`);

	const repo = await get(`/repos/${r.owner}/${r.name}`);
	if (!repo || repo.status !== 200) return { ok: false, lines: [...lines, `✕ ${failure(repo, NETWORK_FAILURE).message}`] };
	const info = repo.json as { private?: boolean; permissions?: { push?: boolean } };
	lines.push(info.private ? "✓ Repository found (private)." : "⚠ Repository found, but it is PUBLIC — your collection would be readable by anyone.");
	if (info.permissions && info.permissions.push === false) {
		return { ok: false, lines: [...lines, '✕ The token cannot write to this repository (needs "Contents: Read and write").'] };
	}

	const branch = await get(`/repos/${r.owner}/${r.name}/branches/${encodeURIComponent(target.branch || "main")}`);
	if (!branch || branch.status !== 200) {
		return {
			ok: false,
			lines: [...lines, `✕ Branch "${target.branch || "main"}" not found (an empty repository has none: create it with a README).`],
		};
	}
	lines.push(`✓ Branch "${target.branch || "main"}" exists.`);

	const listing = await githubListFolder(target, null);
	if (listing.kind === "error") return { ok: false, lines: [...lines, `✕ ${listing.message}`] };
	const dir = cleanPath(target.path) || "(repository root)";
	if (listing.kind === "missing") lines.push(`✓ Folder ${dir} does not exist yet: the first sync will create it.`);
	else if (listing.kind === "ok") {
		const names = new Set(listing.entries.map((e) => e.name));
		const shards = listing.entries.filter((e) => e.name === "core.json.gz" || /^(list|wantlist|deck)-.+\.json\.gz$/.test(e.name)).length;
		if (shards > 0) lines.push(`✓ Folder ${dir} already holds ${shards} data file${shards === 1 ? "" : "s"}: the first sync will MERGE with them.`);
		else if (names.has(GITHUB_DATA_FILE) || names.has(GITHUB_LEGACY_FILE)) {
			lines.push(`✓ Folder ${dir} holds the data of an earlier version (${names.has(GITHUB_DATA_FILE) ? GITHUB_DATA_FILE : GITHUB_LEGACY_FILE}): the first sync will MERGE with it and split it into several files.`);
		} else lines.push(`✓ Folder ${dir} has no data yet: the first sync will create it.`);
	}
	return { ok: true, lines };
}

import { arrayBufferToBase64, requestUrl, RequestUrlResponse } from "obsidian";

/* -------------------------------------------------------------------------- */
/*  Client minimal de l'API REST GitHub (Contents) pour la synchronisation des
    données (2026-10-03, découpées en fragments depuis 2026-10-05) — voir
    src/plugin/github-sync.ts pour le moteur et core/github-shards.ts pour le découpage.

    Choix, tous pour la même raison (quelques fichiers, quelques Mo, un seul
    utilisateur) :
    - API "Contents" (un PUT = un commit) plutôt que Git Data (blobs/arbres/
      commits/refs) : une requête au lieu de quatre, et le `sha` exigé pour
      remplacer un fichier est exactement la compare-and-swap dont on a besoin
      (409/422 si quelqu'un est passé entre-temps).
    - Lecture en `raw` : pas de limite de 1 Mo comme pour la représentation JSON
      (qui renvoie un contenu vide entre 1 et 100 Mo). Le `sha` de ce contenu est
      donc CALCULÉ ici (sha1 d'un blob git), pas lu : il correspond ainsi
      exactement aux octets qu'on vient de fusionner, et pas à une version
      arrivée entre une lecture et une seconde requête de métadonnées.
    - Sondage par le listage du dossier, en requête conditionnelle (If-None-Match) :
      un 304 authentifié ne compte pas dans la limite de 5 000 requêtes/heure, et un
      200 donne le sha de tous les fichiers d'un coup.
    - Les écritures sont SÉQUENTIELLES : deux PUT simultanés sur la même branche se
      refusent mutuellement (chacun crée un commit sur la même tête).
    Aucune fonction ici ne journalise ni ne renvoie le jeton.  */
/* -------------------------------------------------------------------------- */

export const GITHUB_API_BASE = "https://api.github.com";
// Depuis 1.0.512 les données sont découpées en plusieurs fichiers (core.json.gz, list-<id>.json.gz… — voir
// core/github-shards.ts), tous dans le même dossier. Les deux anciens fichiers uniques ne sont plus que LUS,
// une fois, pour amorcer les fragments : `data.json.gz` (1.0.507 à 1.0.511, gzip du JSON compact) et
// `data.json` (≤ 1.0.506, JSON brut).
export const GITHUB_DATA_FILE = "data.json.gz";
export const GITHUB_LEGACY_FILE = "data.json";
const API_VERSION = "2022-11-28";

export interface GithubTarget {
	/** "propriétaire/nom" */
	repo: string;
	branch: string;
	/** Dossier du dépôt qui contient le fichier ("" = racine). */
	path: string;
	token: string;
	/** Surchargeable pour les tests ; GITHUB_API_BASE sinon. */
	apiBase?: string;
	/** Délai maximum d'une lecture (ms) ; REQUEST_TIMEOUT_MS sinon. L'envoi a le triple. */
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
	/** sha du blob git du fichier (celui des octets STOCKÉS, compressés). */
	sha: string;
	size: number;
}

export type GithubListResult =
	| { kind: "ok"; entries: GithubEntry[]; etag: string | null }
	| { kind: "notModified" }
	/** Le dossier n'existe pas encore (le dépôt et la branche, eux, existent). */
	| { kind: "missing" }
	| GithubFailure;

export type GithubPutResult =
	| { kind: "ok"; sha: string }
	/** Le fichier a changé (ou existe déjà) depuis la version qu'on remplace : relire, fusionner, réessayer. */
	| { kind: "conflict" }
	| GithubFailure;

export interface GithubFailure {
	kind: "error";
	status: number; // 0 = pas de réponse (réseau)
	/** Phrase prête à afficher, jamais le contenu brut de la réponse. */
	message: string;
	/** Faute durable (jeton, droits, dépôt) : inutile de réessayer tel quel. */
	fatal: boolean;
	retryAfterS?: number;
}

/* ------------------------------- compression ------------------------------- */

// CompressionStream / DecompressionStream : Chromium (Obsidian desktop, WebView Android) et WebKit
// 16.4+ (iOS / iPadOS). Un appareil qui ne les a pas ne peut pas lire le fichier GitHub : on le lui dit
// plutôt que de le laisser diverger en silence.
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

// Chemin d'un fichier du dossier de données dans le dépôt.
export function githubFilePath(target: GithubTarget, name: string): string {
	const dir = cleanPath(target.path);
	return dir ? `${dir}/${name}` : name;
}

function repoBase(target: GithubTarget): string | null {
	const r = parseRepo(target.repo);
	if (!r) return null;
	return `${target.apiBase ?? GITHUB_API_BASE}/repos/${r.owner}/${r.name}/contents`;
}

// URL de l'API "contents" d'un fichier du dossier de données (name) ou du dossier lui-même (name = null).
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

// Un compteur, pas seulement l'heure : deux sondages dans la même milliseconde (et l'horloge figée des
// tests) donneraient sinon la même URL.
let freshCounter = 0;
function freshUrl(url: string): string {
	return `${url}${url.includes("?") ? "&" : "?"}_=${Date.now().toString(36)}${(++freshCounter).toString(36)}`;
}

// sha1 d'un blob git : sha1("blob <taille>\0" + octets). C'est le `sha` que l'API
// attend pour remplacer un fichier.
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

// Le message d'une exception réseau est ce qui distingue "hors ligne" d'un certificat refusé, d'un DNS qui
// bloque ou d'un délai dépassé : on l'ajoute au texte affiché (jamais le jeton, jamais l'URL complète).
function networkMessage(step: string, e: unknown): string {
	console.warn(`MTG Collection Tracker: GitHub request failed (${step}).`, e);
	const reason = (e instanceof Error ? e.message : String(e))
		.replace(/\s+/g, " ")
		.replace(/(github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, "…")
		.slice(0, 140);
	return `${NETWORK_FAILURE} [${step}: ${reason || "no detail"}]`;
}

// Lit un fichier du dossier de données et rend son texte (décompressé s'il se termine par .gz) et son sha.
// Lecture en `raw` : pas de limite de 1 Mo comme pour la représentation JSON. Le sha est CALCULÉ sur les octets
// reçus, pas lu : il correspond exactement à ce qu'on vient de fusionner, même si le fichier a changé entre
// un listage et cette lecture.
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
	// Fichier absent (dépôt et branche existent, le fichier pas encore) ≠ dépôt introuvable : GitHub
	// répond 404 aux deux, seul le message les distingue.
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

// Liste le dossier de données : le nom et le sha de chaque fichier, quelques centaines d'octets par fichier
// quelle que soit leur taille. C'est le sondage : une requête conditionnelle (If-None-Match) dont la réponse
// 304 ne coûte rien, et dont un 200 donne d'un coup les empreintes de TOUS les fragments — on ne télécharge
// que ceux dont le sha a changé. L'API tronque un dossier à 1 000 fichiers : on s'en plaint plutôt que de
// synchroniser une partie des données en silence.
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
		return { kind: "missing" }; // dossier pas encore créé : les fichiers non plus
	}
	return failure(res, NETWORK_FAILURE);
}

// Écrit un fichier du dossier de données (toujours compressé). `sha` = version qu'on remplace (null = on le crée).
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
		// Sans sha dans la réponse, on le recalcule : c'est celui des octets qu'on vient d'envoyer.
		return { kind: "ok", sha: typeof created === "string" ? created : await gitBlobSha(bytes) };
	}
	// 409 : le fichier a changé depuis `sha`. 422 : "sha wasn't supplied" (il existe déjà) ou "does
	// not match" — même remède, relire puis fusionner. Les autres 422 sont de vraies erreurs.
	if (res.status === 409) return { kind: "conflict" };
	if (res.status === 422 && /\bsha\b/i.test(safeMessage(res))) return { kind: "conflict" };
	return failure(res, NETWORK_FAILURE);
}

export interface GithubConnectionReport {
	ok: boolean;
	lines: string[];
}

// Vérifie, sans rien écrire, que le jeton ouvre bien le dépôt, que la branche existe et ce
// qui s'y trouve déjà. Les droits d'écriture ne se prouvent que par une écriture : ils sont
// jugés au premier envoi.
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

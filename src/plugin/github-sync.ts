import { Notice, Platform } from "obsidian";
import {
	githubGetFile,
	githubListFolder,
	githubPutFile,
	githubTestConnection,
	parseRepo,
	GITHUB_DATA_FILE,
	GITHUB_LEGACY_FILE,
	GithubConnectionReport,
	GithubEntry,
	GithubFailure,
	GithubTarget,
} from "../api/github";
import { omitDeviceLocal } from "../core/device-settings";
import { CORE_SHARD, SHARD_FORMAT, assembleShards, encodeShards, isShardFileName, shardsEqual } from "../core/github-shards";
import type { ShardObj } from "../core/github-shards";
import { githubHomeStatus as homeStatusOf } from "../core/github-status";
import type { GithubHomeStatus } from "../core/github-status";
import { omitKeys } from "../core/settings-merge";
import { mergeForeignText, prepareLocal } from "./settings-sync";
import type MTGCollectionPlugin from "../plugin";


export const GITHUB_POLL_ACTIVE_MS = 2 * 1000;
export const GITHUB_POLL_IDLE_MS = 10 * 1000;
export const GITHUB_ACTIVE_WINDOW_MS = 60 * 1000;
// Le minuteur bat plus vite que la cadence la plus rapide : c'est lui qui décide, à chaque battement, si
// un sondage est dû (un setInterval à durée fixe ne saurait pas changer de cadence).
export const GITHUB_TICK_MS = 1000;
// Envoi : 1 s après la première modification (le temps de grouper une rafale), puis au plus un envoi
// toutes les 6 s. Chaque envoi est un commit du fichier entier : si l'utilisateur édite sans arrêt
// (3 envois ou plus dans la dernière minute), l'écart passe à 20 s pour ne pas gonfler le dépôt.
export const GITHUB_PUSH_DEBOUNCE_MS = 1 * 1000;
export const GITHUB_MIN_GAP_MS = 6 * 1000;
export const GITHUB_BUSY_GAP_MS = 20 * 1000;
export const GITHUB_BUSY_PUSHES = 3;
const BUSY_WINDOW_MS = 60 * 1000;
// Lectures/envois successifs dans un même cycle (un conflit en provoque un de plus).
const MAX_PASSES = 4;
// Après un échec : 5 s, 10 s, 20 s, 40 s, puis 1 min au plus pour un serveur en erreur ; pour une simple panne de
// réseau (téléphone qui change de Wi-Fi, mise en veille) on réessaie bien plus vite, 3 s doublées jusqu'à 15 s :
// l'attente d'une minute (5 min avant) se payait en synchronisations qui ne partaient plus alors que le réseau
// était revenu depuis longtemps.
const BACKOFF_BASE_MS = 5 * 1000;
const BACKOFF_MAX_MS = 60 * 1000;
const NETWORK_BACKOFF_BASE_MS = 3 * 1000;
const NETWORK_BACKOFF_MAX_MS = 15 * 1000;
const TOKEN_SECRET_ID = "mtg-collection-github-token";
const TOKEN_LOCAL_KEY = "mtg-collection-tracker:github-token";

// Ce que GitHub ne reçoit jamais : un secret ne quitte pas l'appareil dans un fichier (même politique
// que les sauvegardes). Retiré aussi des comparaisons et de la fusion avec ce que GitHub renvoie.
export const GITHUB_UNSHARED_KEYS: ReadonlySet<string> = new Set(["cardbaseApiKey"]);

export type GithubSyncReason = "poll" | "focus" | "push" | "flush" | "manual" | "startup";

// Un fragment tel que GitHub le porte : le sha de ses octets stockés et son texte JSON.
export interface ShardInfo {
	sha: string;
	text: string;
}

export interface GithubSyncState {
	chain: Promise<void>;
	pollQueued: boolean;
	/** L'état local contient peut-être quelque chose que GitHub n'a pas. */
	dirty: boolean;
	/** Ce que GitHub porte, fragment par fragment (nom du fichier → sha + texte), tel qu'on l'a lu ou envoyé. */
	shards: Map<string, ShardInfo>;
	/** Dernière version recomposée VENUE de GitHub : point de départ des fusions (jamais nos envois). */
	baseText: string | null;
	/** L'ancien fichier unique (data.json.gz, ou data.json) a déjà été lu (une fois) pour amorcer les fragments. */
	legacyTried: boolean;
	/** ETag du dernier listage du dossier : un 304 veut dire "rien n'a changé nulle part". */
	listEtag: string | null;
	pushTimer: number | null;
	lastPushAt: number;
	/** Dates des derniers envois réussis (pour reconnaître une édition continue). */
	pushTimes: number[];
	failures: number;
	retryAt: number;
	/** L'attente en cours vient d'une limite de débit de GitHub : à respecter même quand l'utilisateur revient sur l'appli. */
	rateLimited: boolean;
	/** Dernier échange réussi (pour dire depuis quand ça ne marche plus). */
	lastOkAt: number;
	/** Délai maximum d'une requête (ms) ; celui de l'API par défaut. Les tests le raccourcissent. */
	requestTimeoutMs?: number;
	/** Jeton / dépôt / droits : inutile de réessayer avant que l'utilisateur ne change quelque chose. */
	fatal: boolean;
	status: { state: "off" | "idle" | "syncing" | "error"; message: string; at: number };
	/** Appelés à chaque changement d'état (l'écran Home affiche l'état sans ouvrir les réglages). */
	listeners: Set<() => void>;
	/** Jusqu'à quand le sondage reste rapide même si la fenêtre n'est pas visible (voir pollIntervalMs). */
	activeUntil: number;
	/** Dernier sondage lancé par le minuteur (pour savoir si le suivant est dû). */
	lastPollAt: number;
}

export function createGithubState(): GithubSyncState {
	return {
		chain: Promise.resolve(),
		pollQueued: false,
		dirty: false,
		shards: new Map(),
		baseText: null,
		legacyTried: false,
		listEtag: null,
		pushTimer: null,
		lastPushAt: 0,
		pushTimes: [],
		failures: 0,
		retryAt: 0,
		rateLimited: false,
		lastOkAt: 0,
		fatal: false,
		status: { state: "off", message: "", at: 0 },
		listeners: new Set(),
		activeUntil: 0,
		lastPollAt: 0,
	};
}

/* ------------------------------ configuration ------------------------------ */

export function getGithubToken(this: MTGCollectionPlugin): string {
	try {
		const store = (this.app as unknown as { secretStorage?: { getSecret?: (id: string) => string | null } }).secretStorage;
		if (store && typeof store.getSecret === "function") {
			const v = store.getSecret(TOKEN_SECRET_ID);
			if (v) return v;
		}
	} catch {
		/* repli ci-dessous */
	}
	try {
		const v: unknown = this.app.loadLocalStorage(TOKEN_LOCAL_KEY);
		return typeof v === "string" ? v : "";
	} catch {
		return "";
	}
}

export function setGithubToken(this: MTGCollectionPlugin, token: string): void {
	const value = token.trim();
	try {
		const store = (this.app as unknown as { secretStorage?: { setSecret?: (id: string, v: string) => void } }).secretStorage;
		if (store && typeof store.setSecret === "function") {
			store.setSecret(TOKEN_SECRET_ID, value);
			// Plus rien en clair dans le stockage local si le coffre sécurisé existe.
			this.app.saveLocalStorage(TOKEN_LOCAL_KEY, null);
			return;
		}
	} catch (e) {
		console.warn("MTG Collection Tracker: secret storage unavailable, keeping the token in this device's local storage.", e);
	}
	this.app.saveLocalStorage(TOKEN_LOCAL_KEY, value || null);
}

function githubEnabled(plugin: MTGCollectionPlugin): boolean {
	return plugin.settings.githubSyncEnabled === true;
}

function githubTarget(plugin: MTGCollectionPlugin): GithubTarget | null {
	if (!githubEnabled(plugin) || !parseRepo(plugin.settings.githubRepo)) return null;
	const token = plugin.getGithubToken();
	if (!token) return null;
	return {
		repo: plugin.settings.githubRepo.trim(),
		branch: plugin.settings.githubBranch.trim() || "main",
		path: plugin.settings.githubPath,
		token,
		apiBase: plugin.settings.githubApiBase.trim().replace(/\/+$/, "") || undefined,
		timeoutMs: plugin.github.requestTimeoutMs,
	};
}

/* --------------------------------- état ------------------------------------ */

function setStatus(plugin: MTGCollectionPlugin, state: GithubSyncState["status"]["state"], message: string) {
	plugin.github.status = { state, message, at: Date.now() };
	// Un abonné qui plante (vue en cours de fermeture…) ne doit jamais empêcher la synchronisation.
	for (const listener of [...plugin.github.listeners]) {
		try {
			listener();
		} catch (e) {
			console.warn("MTG Collection Tracker: a GitHub status listener failed.", e);
		}
	}
}

// S'abonne aux changements d'état ; renvoie la fonction qui se désabonne. Pas de relance à chaque sondage :
// l'état est réécrit toutes les ~4 s tant que ça marche, l'abonné repeint peu et sans rien reconstruire.
export function subscribeGithubStatus(this: MTGCollectionPlugin, listener: () => void): () => void {
	const listeners = this.github.listeners;
	listeners.add(listener);
	return () => void listeners.delete(listener);
}

// La ligne d'état de Home (voir core/github-status.ts).
export function githubHomeStatus(this: MTGCollectionPlugin): GithubHomeStatus | null {
	const st = this.github;
	return homeStatusOf({
		enabled: githubEnabled(this),
		configured: !!parseRepo(this.settings.githubRepo) && !!this.getGithubToken(),
		state: st.status.state,
		fatal: st.fatal,
		message: st.status.message,
		lastOkAt: st.lastOkAt,
	});
}

export function githubStatusLine(plugin: MTGCollectionPlugin): string {
	const { state, message, at } = plugin.github.status;
	if (!githubEnabled(plugin)) return "Off.";
	if (!parseRepo(plugin.settings.githubRepo)) return 'Enter the repository as "owner/name".';
	if (!plugin.getGithubToken()) return "Paste a token to start syncing on this device.";
	const time = at ? new Date(at).toLocaleTimeString() : "";
	if (state === "error") {
		const since = plugin.github.lastOkAt ? ` Last success: ${new Date(plugin.github.lastOkAt).toLocaleTimeString()}.` : "";
		const times = plugin.github.failures > 1 ? ` Failed ${plugin.github.failures} times in a row.` : "";
		return `⚠ ${message}${time ? ` (${time})` : ""}${times}${since}`;
	}
	if (state === "syncing") return "Syncing…";
	return at ? `✓ In sync — last check ${time}${message ? `. ${message}` : ""}` : "Waiting for the first sync…";
}

function fail(plugin: MTGCollectionPlugin, f: GithubFailure) {
	const st = plugin.github;
	st.failures++;
	if (f.fatal) {
		const first = !st.fatal;
		st.fatal = true;
		if (first) new Notice(`MTG Collection Tracker: GitHub sync stopped. ${f.message}`, 15000);
	} else {
		st.rateLimited = f.retryAfterS !== undefined;
		const n = st.failures - 1;
		const wait = f.retryAfterS
			? f.retryAfterS * 1000
			: f.status === 0
				? Math.min(NETWORK_BACKOFF_MAX_MS, NETWORK_BACKOFF_BASE_MS * 2 ** n)
				: Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** n);
		st.retryAt = Date.now() + wait;
	}
	setStatus(plugin, "error", f.message);
}

function commitMessage(): string {
	const device = Platform.isIosApp ? "iOS" : Platform.isAndroidApp ? "Android" : "desktop";
	return `Sync from ${device}`;
}

// Ce qui part sur GitHub : les réglages partagés, sans ce qui est propre à l'appareil et sans la clé d'API
// cardbase (même politique que les sauvegardes : un secret ne quitte pas l'appareil dans un fichier).
function sharedView(plugin: MTGCollectionPlugin): Record<string, unknown> {
	return omitKeys(omitDeviceLocal(plugin.settings), GITHUB_UNSHARED_KEYS);
}

/* ---------------------------------- cycle ---------------------------------- */

const NOT_JSON: GithubFailure = {
	kind: "error",
	status: 0,
	fatal: true,
	message: "A data file on GitHub is not valid JSON. Fix or delete it there, then sync again.",
};

// Fragments téléchargés en parallèle (les ENVOIS, eux, se font un par un : deux écritures simultanées sur la
// même branche se refusent mutuellement).
const DOWNLOAD_CONCURRENCY = 4;

function parseShard(text: string): ShardObj | null {
	try {
		const o: unknown = JSON.parse(text);
		return o !== null && typeof o === "object" && !Array.isArray(o) ? (o as ShardObj) : null;
	} catch {
		return null;
	}
}

// Télécharge `names`. Rend les fragments lus, ou la première erreur (rien n'est alors appliqué : un fragment lu
// mais pas fusionné ne serait plus jamais retéléchargé, son sha étant déjà connu).
async function downloadShards(target: GithubTarget, names: string[]): Promise<Map<string, ShardInfo> | GithubFailure> {
	const out = new Map<string, ShardInfo>();
	let failure: GithubFailure | null = null;
	let next = 0;
	const worker = async () => {
		while (failure === null) {
			const i = next++;
			if (i >= names.length) return;
			const got = await githubGetFile(target, names[i]);
			if (got.kind === "error") {
				failure = got;
				return;
			}
			// Disparu entre le listage et la lecture : le sondage suivant le dira.
			if (got.kind === "ok") out.set(names[i], { sha: got.sha, text: got.text });
		}
	};
	await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, names.length) }, worker));
	return failure ?? out;
}

// Fusionne un texte venu de GitHub dans l'état local. null = ce n'est pas un JSON de réglages.
function absorb(plugin: MTGCollectionPlugin, text: string, onReceived: () => void): { needsWrite: boolean } | null {
	const st = plugin.github;
	prepareLocal(plugin);
	const merged = mergeForeignText(plugin, text, st.baseText, GITHUB_UNSHARED_KEYS);
	if (!merged) return null;
	st.baseText = text;
	// Le fichier local (et donc Syncthing) doit suivre ce que GitHub vient d'apporter.
	if (merged.changedLocal) {
		void plugin.persistSettings();
		onReceived();
		noteActivity(st); // l'autre appareil est actif : on reste réactif pour la suite
	}
	return { needsWrite: merged.needsWrite };
}

// Ce que le listage dit de GitHub → ce qu'il faut en télécharger, puis fusion de l'état recomposé. Rend une
// erreur à signaler, ou null.
async function pullFromListing(
	plugin: MTGCollectionPlugin,
	target: GithubTarget,
	entries: GithubEntry[],
	onReceived: () => void
): Promise<GithubFailure | null> {
	const st = plugin.github;
	const listed = new Map<string, GithubEntry>();
	for (const e of entries) if (isShardFileName(e.name)) listed.set(e.name, e);
	const toFetch = [...listed.values()].filter((e) => st.shards.get(e.name)?.sha !== e.sha).map((e) => e.name);
	const vanished = [...st.shards.keys()].filter((n) => !listed.has(n));

	// Tant que le fragment commun n'existe pas, la migration depuis l'ancien fichier unique (1.0.507-1.0.511,
	// puis ≤ 1.0.506) n'est pas finie — le fragment commun est écrit EN DERNIER : on lit l'ancien fichier, UNE
	// fois, pour que ce qu'il contient ne soit jamais perdu. L'ancien fichier, lui, n'est plus jamais touché.
	let legacyText: string | null = null;
	if (!listed.has(CORE_SHARD) && !st.legacyTried) {
		const names = new Set(entries.map((e) => e.name));
		const legacyName = names.has(GITHUB_DATA_FILE) ? GITHUB_DATA_FILE : names.has(GITHUB_LEGACY_FILE) ? GITHUB_LEGACY_FILE : null;
		if (legacyName) {
			const got = await githubGetFile(target, legacyName);
			if (got.kind === "error") return got;
			if (got.kind === "ok") legacyText = got.text;
		}
		st.legacyTried = true;
	}
	if (toFetch.length === 0 && vanished.length === 0 && legacyText === null) return null;

	const fetched = await downloadShards(target, toFetch);
	if (!(fetched instanceof Map)) return fetched;

	const next = new Map(st.shards);
	for (const n of vanished) next.delete(n);
	for (const [n, info] of fetched) next.set(n, info);
	const parsed = new Map<string, ShardObj>();
	for (const [n, info] of next) {
		const obj = parseShard(info.text);
		if (!obj) return NOT_JSON;
		parsed.set(n, obj);
	}

	// Tout d'un coup, sans aucun await : l'état local ne peut pas bouger entre le calcul de la fusion et son application.
	st.shards = next;
	let needsWrite = false;
	if (legacyText !== null) {
		if (!absorb(plugin, legacyText, onReceived)) return NOT_JSON;
		needsWrite = true; // les fragments n'existent pas (tous) encore : il faut les créer
	}
	if (parsed.size > 0) {
		const outcome = absorb(plugin, JSON.stringify(assembleShards(parsed)), onReceived);
		if (!outcome) return NOT_JSON;
		needsWrite = needsWrite || outcome.needsWrite;
	}
	st.dirty = needsWrite;
	return null;
}

type PushOutcome = { kind: "ok"; sent: boolean } | { kind: "conflict" } | { kind: "error"; failure: GithubFailure };

// Un fragment que GitHub a encore plein de cartes dont nous n'avons plus aucune (supprimées, ou déplacées dans une
// autre liste) est vidé, pour ne pas laisser traîner des cartes que seule une pierre tombale (90 jours) masque.
function emptyShardFor(name: string): ShardObj {
	if (name.startsWith("list-")) return { _shard: SHARD_FORMAT, collection: [] };
	if (name.startsWith("wantlist-")) return { _shard: SHARD_FORMAT, wantlist: [] };
	return { _shard: SHARD_FORMAT, decks: [] };
}

// Envoie, un par un, les fragments qui diffèrent de ce que GitHub porte — le fragment commun en dernier.
async function pushDirty(plugin: MTGCollectionPlugin, target: GithubTarget): Promise<PushOutcome> {
	const st = plugin.github;
	const version = plugin.dataVersion;
	prepareLocal(plugin); // suppressions encore dans le délai de regroupement
	const local = encodeShards(sharedView(plugin));

	const toSend: { name: string; text: string }[] = [];
	for (const name of new Set([...local.keys(), ...st.shards.keys()])) {
		const mine = local.get(name);
		const held = st.shards.get(name);
		const heldObj = held ? parseShard(held.text) : null;
		// Même égalité que la fusion : ni l'ordre, ni les prix, ni les dates de rafraîchissement n'y comptent.
		if (shardsEqual(name, mine, heldObj ?? undefined)) continue;
		toSend.push({ name, text: JSON.stringify(mine ?? emptyShardFor(name)) });
	}
	if (toSend.length === 0) {
		// Seuls des prix (ou des dates de rafraîchissement) ont changé : les autres appareils les ignorent, rien à envoyer.
		st.dirty = false;
		return { kind: "ok", sent: false };
	}
	toSend.sort((a, b) => (a.name === CORE_SHARD ? 1 : b.name === CORE_SHARD ? -1 : a.name < b.name ? -1 : 1));

	for (const item of toSend) {
		const put = await githubPutFile(target, item.name, item.text, st.shards.get(item.name)?.sha ?? null, commitMessage());
		if (put.kind === "ok") {
			st.shards.set(item.name, { sha: put.sha, text: item.text });
			continue;
		}
		if (put.kind === "conflict") return { kind: "conflict" }; // ce qui est déjà parti reste parti
		return { kind: "error", failure: put };
	}
	st.lastPushAt = Date.now();
	st.pushTimes = [...st.pushTimes.filter((t) => st.lastPushAt - t < BUSY_WINDOW_MS), st.lastPushAt];
	// Une modification arrivée pendant l'envoi reste à envoyer.
	st.dirty = plugin.dataVersion !== version;
	return { kind: "ok", sent: true };
}

async function cycle(plugin: MTGCollectionPlugin, reason: GithubSyncReason): Promise<void> {
	const st = plugin.github;
	if (!plugin.settingsLoaded) return;
	const target = githubTarget(plugin);
	if (!target) {
		st.dirty = false;
		setStatus(plugin, "off", "");
		return;
	}
	if (st.fatal && reason !== "manual") return;
	// L'utilisateur qui revient sur l'appli ("focus", "flush") ou qui touche le bouton ("manual") n'attend pas la
	// fin d'une attente après une panne réseau ; une limite de débit de GitHub, elle, reste respectée.
	const userDriven = reason === "manual" || reason === "focus" || reason === "flush";
	if (Date.now() < st.retryAt && reason !== "manual" && !(userDriven && !st.rateLimited)) return;
	if (reason === "manual" || reason === "startup") setStatus(plugin, "syncing", "");

	let note = "";
	try {
		for (let pass = 0; pass < MAX_PASSES; pass++) {
			// 1. Le dossier a-t-il changé ? (léger : un 304 ne coûte rien) Si oui, on télécharge ce qui a changé et on fusionne.
			const listing = await githubListFolder(target, st.listEtag);
			if (listing.kind === "error") return fail(plugin, listing);
			if (listing.kind !== "notModified") {
				st.listEtag = listing.kind === "ok" ? listing.etag : null;
				const failure = await pullFromListing(plugin, target, listing.kind === "ok" ? listing.entries : [], () => {
					note = "Received changes.";
				});
				if (failure) return fail(plugin, failure);
			}
			if (!st.dirty) break;

			// 2. Envoyer ce que GitHub n'a pas.
			const outcome = await pushDirty(plugin, target);
			if (outcome.kind === "error") return fail(plugin, outcome.failure);
			if (outcome.kind === "conflict") {
				st.listEtag = null; // quelqu'un est passé : relire pour de bon, fusionner, réessayer
				if (pass === MAX_PASSES - 1) return fail(plugin, { kind: "error", status: 409, fatal: false, message: "GitHub keeps changing under us; retrying shortly." });
				continue;
			}
			if (outcome.sent) note = "Sent changes.";
			break;
		}
		st.failures = 0;
		st.retryAt = 0;
		st.rateLimited = false;
		st.lastOkAt = Date.now();
		st.fatal = false;
		setStatus(plugin, "idle", note);
		if (st.dirty && st.pushTimer === null) scheduleGithubPush(plugin);
	} catch (e) {
		console.error("MTG Collection Tracker: GitHub sync failed.", e);
		fail(plugin, { kind: "error", status: 0, fatal: false, message: "GitHub sync hit an unexpected error; retrying shortly." });
	}
}

function enqueue(plugin: MTGCollectionPlugin, task: () => Promise<void>): Promise<void> {
	const run = plugin.github.chain.then(task).catch((e) => {
		console.error("MTG Collection Tracker: GitHub sync failed.", e);
	});
	plugin.github.chain = run;
	return run;
}

export function githubSync(this: MTGCollectionPlugin, reason: GithubSyncReason = "poll"): Promise<void> {
	const st = this.github;
	if (!githubEnabled(this)) return Promise.resolve();
	if (reason === "poll") {
		if (st.pollQueued) return Promise.resolve();
		st.pollQueued = true;
	}
	return enqueue(this, async () => {
		if (reason === "poll") st.pollQueued = false;
		await cycle(this, reason);
	});
}

/* ------------------------------ planification ------------------------------ */

// Cadence de sondage : rapide si la fenêtre est visible ou si une activité récente l'a "réveillée".
export function pollIntervalMs(visible: boolean, now: number, activeUntil: number): number {
	return visible || now < activeUntil ? GITHUB_POLL_ACTIVE_MS : GITHUB_POLL_IDLE_MS;
}

// Un sondage est-il dû à cet instant ?
export function pollDue(visible: boolean, now: number, lastPollAt: number, activeUntil: number): boolean {
	return now - lastPollAt >= pollIntervalMs(visible, now, activeUntil);
}

// Quelque chose vient de se passer ici (modification, retour sur l'appli, changement reçu) : sondage rapide
// pendant la minute qui suit, même si la fenêtre se cache entre-temps.
function noteActivity(st: GithubSyncState) {
	st.activeUntil = Date.now() + GITHUB_ACTIVE_WINDOW_MS;
}

// Délai avant le prochain envoi : jamais moins que le groupement d'une rafale, et pas avant la fin de
// l'écart minimum depuis le dernier envoi — plus long quand l'utilisateur édite sans arrêt.
export function pushDelay(now: number, lastPushAt: number, pushTimes: number[]): number {
	const busy = pushTimes.filter((t) => now - t < BUSY_WINDOW_MS).length >= GITHUB_BUSY_PUSHES;
	const gap = busy ? GITHUB_BUSY_GAP_MS : GITHUB_MIN_GAP_MS;
	return Math.max(GITHUB_PUSH_DEBOUNCE_MS, lastPushAt + gap - now);
}

function scheduleGithubPush(plugin: MTGCollectionPlugin) {
	const st = plugin.github;
	if (st.pushTimer !== null) return; // l'envoi qui viendra prendra l'état le plus récent
	const wait = pushDelay(Date.now(), st.lastPushAt, st.pushTimes);
	st.pushTimer = window.setTimeout(() => {
		st.pushTimer = null;
		void plugin.githubSync("push");
	}, wait);
}

// Appelé par saveSettings() et quand une autre source (Syncthing) vient de changer l'état local.
export function markGithubDirty(this: MTGCollectionPlugin): void {
	if (!githubEnabled(this)) return;
	this.github.dirty = true;
	noteActivity(this.github);
	scheduleGithubPush(this);
}

// Appli passée en arrière-plan / fermeture : envoyer tout de suite ce qui attend (au mieux : un
// mobile peut suspendre la requête).
export function flushGithubSync(this: MTGCollectionPlugin): Promise<void> {
	const st = this.github;
	if (st.pushTimer !== null) {
		window.clearTimeout(st.pushTimer);
		st.pushTimer = null;
	}
	if (!st.dirty) return Promise.resolve();
	return this.githubSync("flush");
}

// À appeler quand la configuration change (dépôt, branche, dossier, jeton, activation) :
// on repart d'un état neuf — rien de ce qu'on savait ne vaut pour une autre cible.
export function resetGithubSync(this: MTGCollectionPlugin): void {
	const st = this.github;
	if (st.pushTimer !== null) window.clearTimeout(st.pushTimer);
	Object.assign(st, createGithubState(), { chain: st.chain, listeners: st.listeners });
	if (githubTarget(this)) {
		st.dirty = true; // la première synchro fusionne puis envoie ce qui manque
		void this.githubSync("manual");
	} else {
		setStatus(this, "off", "");
	}
}

export async function githubTestNow(this: MTGCollectionPlugin): Promise<GithubConnectionReport> {
	const target = githubTarget(this);
	if (!target) {
		return {
			ok: false,
			lines: ['✕ Enable the option, enter the repository as "owner/name" and paste a token first.'],
		};
	}
	return githubTestConnection(target);
}

function windowVisible(): boolean {
	return typeof document === "undefined" || document.visibilityState === "visible";
}

export function setupGithubSync(this: MTGCollectionPlugin): void {
	this.registerInterval(
		window.setInterval(() => {
			const st = this.github;
			const now = Date.now();
			if (!pollDue(windowVisible(), now, st.lastPollAt, st.activeUntil)) return;
			st.lastPollAt = now;
			void this.githubSync("poll");
		}, GITHUB_TICK_MS)
	);
	this.registerDomEvent(window, "focus", () => {
		noteActivity(this.github);
		void this.githubSync("focus");
	});
	this.registerDomEvent(document, "visibilitychange", () => {
		if (document.visibilityState === "visible") {
			noteActivity(this.github);
			void this.githubSync("focus");
		} else void this.flushGithubSync();
	});
	// Au démarrage : un premier échange sans attendre le premier sondage. Marqué sale, car on ne sait
	// pas ce que GitHub a reçu de cet appareil pendant qu'il était éteint.
	if (githubTarget(this)) {
		this.github.dirty = true;
		void this.githubSync("startup");
	}
}

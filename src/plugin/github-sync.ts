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
// The timer beats faster than the fastest pace: it is what decides, at each beat, whether a poll is due
// (a fixed-duration setInterval couldn't change pace).
export const GITHUB_TICK_MS = 1000;
// Upload: 1 s after the first change (time to group a burst), then at most one upload every 6 s.
// Each upload is a commit of the whole file: if the user edits non-stop (3 uploads or more in the
// last minute), the gap goes to 20 s so as not to bloat the repository.
export const GITHUB_PUSH_DEBOUNCE_MS = 1 * 1000;
export const GITHUB_MIN_GAP_MS = 6 * 1000;
export const GITHUB_BUSY_GAP_MS = 20 * 1000;
export const GITHUB_BUSY_PUSHES = 3;
const BUSY_WINDOW_MS = 60 * 1000;
// Successive reads/uploads within a single cycle (a conflict causes one more).
const MAX_PASSES = 4;
// After a failure: 5 s, 10 s, 20 s, 40 s, then 1 min at most for a server in error; for a simple network outage
// (phone changing Wi-Fi, sleep) we retry much faster, 3 s doubled up to 15 s: the one-minute wait (5 min before)
// was paid for in syncs that no longer went out although the network had been back for a long time.
const BACKOFF_BASE_MS = 5 * 1000;
const BACKOFF_MAX_MS = 60 * 1000;
const NETWORK_BACKOFF_BASE_MS = 3 * 1000;
const NETWORK_BACKOFF_MAX_MS = 15 * 1000;
const TOKEN_SECRET_ID = "mtg-collection-github-token";
const TOKEN_LOCAL_KEY = "mtg-collection-tracker:github-token";

// What GitHub never receives: a secret does not leave the device in a file (same policy as backups).
// Also removed from the comparisons and from the merge with what GitHub sends back.
export const GITHUB_UNSHARED_KEYS: ReadonlySet<string> = new Set(["cardbaseApiKey"]);

export type GithubSyncReason = "poll" | "focus" | "push" | "flush" | "manual" | "startup";

// A shard as GitHub holds it: the sha of its stored bytes and its JSON text.
export interface ShardInfo {
	sha: string;
	text: string;
}

export interface GithubSyncState {
	chain: Promise<void>;
	pollQueued: boolean;
	/** The local state perhaps contains something GitHub doesn't have. */
	dirty: boolean;
	/** What GitHub holds, shard by shard (file name → sha + text), as read or sent. */
	shards: Map<string, ShardInfo>;
	/** Last recomposed version COMING from GitHub: starting point of the merges (never our uploads). */
	baseText: string | null;
	/** The old single file (data.json.gz, or data.json) has already been read (once) to seed the shards. */
	legacyTried: boolean;
	/** ETag of the last folder listing: a 304 means "nothing has changed anywhere". */
	listEtag: string | null;
	pushTimer: number | null;
	lastPushAt: number;
	/** Dates of the last successful uploads (to recognize continuous editing). */
	pushTimes: number[];
	failures: number;
	retryAt: number;
	/** The wait in progress comes from a GitHub rate limit: to be respected even when the user comes back to the app. */
	rateLimited: boolean;
	/** Last successful exchange (to say since when it hasn't been working). */
	lastOkAt: number;
	/** Maximum duration of a request (ms); the API's default one. Tests shorten it. */
	requestTimeoutMs?: number;
	/** Token / repository / permissions: no point retrying before the user changes something. */
	fatal: boolean;
	status: { state: "off" | "idle" | "syncing" | "error"; message: string; at: number };
	/** Called on every state change (the Home screen shows the state without opening the settings). */
	listeners: Set<() => void>;
	/** Until when polling stays fast even if the window isn't visible (see pollIntervalMs). */
	activeUntil: number;
	/** Last poll launched by the timer (to know whether the next is due). */
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
			// Nothing left in plain text in local storage if the secure vault exists.
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

/* --------------------------------- state ------------------------------------ */

function setStatus(plugin: MTGCollectionPlugin, state: GithubSyncState["status"]["state"], message: string) {
	plugin.github.status = { state, message, at: Date.now() };
	// A subscriber that crashes (view being closed…) must never prevent synchronization.
	for (const listener of [...plugin.github.listeners]) {
		try {
			listener();
		} catch (e) {
			console.warn("MTG Collection Tracker: a GitHub status listener failed.", e);
		}
	}
}

// Subscribes to state changes; returns the function that unsubscribes. No re-launch on each poll: the state
// is rewritten every ~4 s as long as it works, the subscriber repaints little and without rebuilding
// anything.
export function subscribeGithubStatus(this: MTGCollectionPlugin, listener: () => void): () => void {
	const listeners = this.github.listeners;
	listeners.add(listener);
	return () => void listeners.delete(listener);
}

// Home's status line (see core/github-status.ts).
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

// What goes to GitHub: the shared settings, without what is specific to the device and without the
// cardbase API key (same policy as backups: a secret does not leave the device in a file).
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

// Shards downloaded in parallel (the UPLOADS, for their part, are done one by one: two simultaneous writes
// on the same branch refuse each other).
const DOWNLOAD_CONCURRENCY = 4;

function parseShard(text: string): ShardObj | null {
	try {
		const o: unknown = JSON.parse(text);
		return o !== null && typeof o === "object" && !Array.isArray(o) ? (o as ShardObj) : null;
	} catch {
		return null;
	}
}

// Downloads `names`. Returns the shards read, or the first error (nothing is then applied: a shard read but not
// merged would never be downloaded again, its sha being already known).
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
			// Disappeared between the listing and the read: the next poll will say.
			if (got.kind === "ok") out.set(names[i], { sha: got.sha, text: got.text });
		}
	};
	await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, names.length) }, worker));
	return failure ?? out;
}

// Merges a text coming from GitHub into the local state. null = this is not a settings JSON.
function absorb(plugin: MTGCollectionPlugin, text: string, onReceived: () => void): { needsWrite: boolean } | null {
	const st = plugin.github;
	prepareLocal(plugin);
	const merged = mergeForeignText(plugin, text, st.baseText, GITHUB_UNSHARED_KEYS);
	if (!merged) return null;
	st.baseText = text;
	// The local file (and therefore Syncthing) must follow what GitHub has just brought.
	if (merged.changedLocal) {
		void plugin.persistSettings();
		onReceived();
		noteActivity(st); // the other device is active: we stay responsive for what follows
	}
	return { needsWrite: merged.needsWrite };
}

// What the listing says about GitHub → what has to be downloaded from it, then merge of the recomposed
// state. Returns an error to report, or null.
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

	// As long as the common shard doesn't exist, the migration from the old single file (1.0.507-1.0.511, then
	// ≤ 1.0.506) isn't finished — the common shard is written LAST: we read the old file, ONCE, so that what
	// it contains is never lost. The old file, for its part, is never touched again.
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

	// All at once, with no await: the local state can't move between the computation of the merge and its application.
	st.shards = next;
	let needsWrite = false;
	if (legacyText !== null) {
		if (!absorb(plugin, legacyText, onReceived)) return NOT_JSON;
		needsWrite = true; // the shards don't (all) exist yet: they have to be created
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

// A shard that GitHub still holds full of cards of which we have none left (deleted, or moved to another list)
// is emptied, so as not to leave lying around cards that only a (90-day) tombstone masks.
function emptyShardFor(name: string): ShardObj {
	if (name.startsWith("list-")) return { _shard: SHARD_FORMAT, collection: [] };
	if (name.startsWith("wantlist-")) return { _shard: SHARD_FORMAT, wantlist: [] };
	return { _shard: SHARD_FORMAT, decks: [] };
}

// Uploads, one by one, the shards that differ from what GitHub holds — the common shard last.
async function pushDirty(plugin: MTGCollectionPlugin, target: GithubTarget): Promise<PushOutcome> {
	const st = plugin.github;
	const version = plugin.dataVersion;
	prepareLocal(plugin); // deletions still within the grouping delay
	const local = encodeShards(sharedView(plugin));

	const toSend: { name: string; text: string }[] = [];
	for (const name of new Set([...local.keys(), ...st.shards.keys()])) {
		const mine = local.get(name);
		const held = st.shards.get(name);
		const heldObj = held ? parseShard(held.text) : null;
		// Same equality as the merge: neither the order, nor the prices, nor the refresh dates count there.
		if (shardsEqual(name, mine, heldObj ?? undefined)) continue;
		toSend.push({ name, text: JSON.stringify(mine ?? emptyShardFor(name)) });
	}
	if (toSend.length === 0) {
		// Only prices (or refresh dates) changed: the other devices ignore them, nothing to send.
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
		if (put.kind === "conflict") return { kind: "conflict" }; // what has already gone out stays out
		return { kind: "error", failure: put };
	}
	st.lastPushAt = Date.now();
	st.pushTimes = [...st.pushTimes.filter((t) => st.lastPushAt - t < BUSY_WINDOW_MS), st.lastPushAt];
	// A change that arrived during the upload remains to be uploaded.
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
	// A user coming back to the app ("focus", "flush") or touching the button ("manual") doesn't wait for the end
	// of a wait after a network outage; a GitHub rate limit, however, is still respected.
	const userDriven = reason === "manual" || reason === "focus" || reason === "flush";
	if (Date.now() < st.retryAt && reason !== "manual" && !(userDriven && !st.rateLimited)) return;
	if (reason === "manual" || reason === "startup") setStatus(plugin, "syncing", "");

	let note = "";
	try {
		for (let pass = 0; pass < MAX_PASSES; pass++) {
			// 1. Has the folder changed? (lightweight: a 304 costs nothing) If so, we download what changed and merge.
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

			// 2. Send what GitHub doesn't have.
			const outcome = await pushDirty(plugin, target);
			if (outcome.kind === "error") return fail(plugin, outcome.failure);
			if (outcome.kind === "conflict") {
				st.listEtag = null; // someone got in between: re-read for real, merge, retry
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

// Polling pace: fast if the window is visible or if recent activity has "woken it up".
export function pollIntervalMs(visible: boolean, now: number, activeUntil: number): number {
	return visible || now < activeUntil ? GITHUB_POLL_ACTIVE_MS : GITHUB_POLL_IDLE_MS;
}

// Is a poll due at this moment?
export function pollDue(visible: boolean, now: number, lastPollAt: number, activeUntil: number): boolean {
	return now - lastPollAt >= pollIntervalMs(visible, now, activeUntil);
}

// Something has just happened here (change, return to the app, received change): fast polling for the
// following minute, even if the window hides in the meantime.
function noteActivity(st: GithubSyncState) {
	st.activeUntil = Date.now() + GITHUB_ACTIVE_WINDOW_MS;
}

// Delay before the next upload: never less than the grouping of a burst, and not before the end of
// the minimum gap since the last upload — longer when the user edits non-stop.
export function pushDelay(now: number, lastPushAt: number, pushTimes: number[]): number {
	const busy = pushTimes.filter((t) => now - t < BUSY_WINDOW_MS).length >= GITHUB_BUSY_PUSHES;
	const gap = busy ? GITHUB_BUSY_GAP_MS : GITHUB_MIN_GAP_MS;
	return Math.max(GITHUB_PUSH_DEBOUNCE_MS, lastPushAt + gap - now);
}

function scheduleGithubPush(plugin: MTGCollectionPlugin) {
	const st = plugin.github;
	if (st.pushTimer !== null) return; // the upload that comes will take the most recent state
	const wait = pushDelay(Date.now(), st.lastPushAt, st.pushTimes);
	st.pushTimer = window.setTimeout(() => {
		st.pushTimer = null;
		void plugin.githubSync("push");
	}, wait);
}

// Called by saveSettings() and when another source (Syncthing) has just changed the local state.
export function markGithubDirty(this: MTGCollectionPlugin): void {
	if (!githubEnabled(this)) return;
	this.github.dirty = true;
	noteActivity(this.github);
	scheduleGithubPush(this);
}

// App moved to the background / closing: send right away what is waiting (best effort: a mobile
// may suspend the request).
export function flushGithubSync(this: MTGCollectionPlugin): Promise<void> {
	const st = this.github;
	if (st.pushTimer !== null) {
		window.clearTimeout(st.pushTimer);
		st.pushTimer = null;
	}
	if (!st.dirty) return Promise.resolve();
	return this.githubSync("flush");
}

// To be called when the configuration changes (repository, branch, folder, token,
// activation): we start again from a fresh state — nothing we knew holds for another
// target.
export function resetGithubSync(this: MTGCollectionPlugin): void {
	const st = this.github;
	if (st.pushTimer !== null) window.clearTimeout(st.pushTimer);
	Object.assign(st, createGithubState(), { chain: st.chain, listeners: st.listeners });
	if (githubTarget(this)) {
		st.dirty = true; // the first sync merges then sends what is missing
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
	// At startup: a first exchange without waiting for the first poll. Marked dirty, because we don't
	// know what GitHub received from this device while it was off.
	if (githubTarget(this)) {
		this.github.dirty = true;
		void this.githubSync("startup");
	}
}

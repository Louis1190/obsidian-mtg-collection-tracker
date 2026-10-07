import { Notice, normalizePath } from "obsidian";
import { DEFAULT_SETTINGS, type MTGCollectionSettings } from "../core/data-model";
import { DEVICE_LOCAL_KEYS, omitDeviceLocal, pickDeviceLocal } from "../core/device-settings";
import {
	applySettingsInPlace,
	mergeSettings,
	recordEntityStamps,
	recordScalarStamps,
	recordTombstones,
	snapshotEntityPrints,
	snapshotKeys,
	snapshotScalars,
} from "../core/settings-merge";
import type MTGCollectionPlugin from "../plugin";

/* -------------------------------------------------------------------------- */
/*  Synchronisation multi-appareils de data.json (2026-10-03).

    data.json voyage par Syncthing entre le Mac, l'iPad et le téléphone. Avant
    ce fichier, le plugin ne le lisait qu'au démarrage et le réécrivait en
    entier à chaque modification : un appareil qui recevait une version plus
    récente la gardait sur disque mais pas en mémoire, puis l'écrasait à sa
    prochaine sauvegarde (6 data.sync-conflict-*.json dans la vault en
    témoignent). Désormais :

    - toute écriture est précédée d'un contrôle du disque (stat, quasi gratuit) ;
      si le fichier a changé ailleurs, on FUSIONNE (core/settings-merge.ts) au
      lieu d'écraser ;
    - le plugin surveille aussi le fichier hors écriture : hook Obsidian
      `onExternalSettingsChange` (instantané sur desktop), sondage toutes les
      20 s, retour au premier plan — Obsidian mobile est suspendu en arrière-
      plan, un fichier arrivé pendant ce temps n'y déclenche aucun événement.

    TOUT ce qui touche au fichier passe par une seule file (`persistChain`) :
    jamais deux lectures/fusions/écritures en même temps. */
/* -------------------------------------------------------------------------- */

// Un contrôle de sondage ne coûte qu'un stat tant que le fichier n'a pas bougé : on peut
// le faire souvent. C'est le filet des cas où Obsidian n'émet aucun événement (mobile
// suspendu, horloge d'un appareil qui dérive) ; l'événement lui-même reste instantané.
export const SETTINGS_POLL_MS = 5 * 1000;
// Stockage local de l'appareil (Obsidian le limite au coffre ET à l'appareil, jamais synchronisé).
export const DEVICE_SETTINGS_STORAGE_KEY = "mtg-collection-tracker:device-settings";
export const SYNC_BACKUP_DIR = "sync-backups";
export const SYNC_BACKUP_KEEP = 3;
// Au-delà, une fusion qui supprime (ou ajoute) autant d'éléments localement garde
// d'abord une copie de l'état local et prévient. Une grosse suppression venue d'un
// autre appareil (gros "Delete list") ou un gros import est légitime, mais doit rester
// récupérable ; un gros AJOUT est aussi ce que donnerait un appareil resté sur une
// ancienne version du plugin (sans pierres tombales) qui réécrit un vieux fichier :
// les cartes supprimées depuis reviendraient, et il faut pouvoir revenir en arrière.
export const BIG_REMOVAL_THRESHOLD = 25;
export const BIG_ADDITION_THRESHOLD = 200;
// Écart toléré entre l'mtime demandé à l'écriture et celui relu juste après :
// au-delà, quelqu'un d'autre a touché le fichier dans l'intervalle. Large à dessein :
// certains systèmes de fichiers (FAT/exFAT d'un stockage externe Android) arrondissent
// l'mtime à 2 s, et un fichier livré par Syncthing porte la date de SON auteur.
const WRITE_RACE_TOLERANCE_MS = 5000;
// Nombre maximal de lectures successives avant d'écrire (voir reconcileUntilStable).
const MAX_RECONCILE_PASSES = 3;
const SAVE_RETRY_MS = 5000;
// Garde-fou : au plus MERGE_WRITE_MAX écritures déclenchées par un contrôle
// externe (donc pas par une modification de l'utilisateur) par fenêtre. Deux
// appareils qui se renverraient indéfiniment chacun leur version d'un même
// réglage (chacun juge que l'autre n'a "rien changé") réécriraient 6 Mo toutes
// les quelques secondes, sans fin ; ici la boucle s'arrête d'elle-même et la
// prochaine vraie modification reprend la main.
export const MERGE_WRITE_WINDOW_MS = 2 * 60 * 1000;
export const MERGE_WRITE_MAX = 4;

export interface DiskSignature {
	mtime: number;
	size: number;
}

type Obj = Record<string, unknown>;

// Nom du fichier de données dans un dossier choisi par l'utilisateur (dans le dossier du plugin, c'est
// le data.json d'Obsidian, comme avant).
export const CUSTOM_DATA_FILE_NAME = "mtg-collection-data.json";

// "" = le dossier du plugin. Sinon un chemin relatif à la vault, sans ".." ni "." : null si invalide.
export function normalizeDataFolder(input: string): string | null {
	const parts = input
		.trim()
		.split(/[\\/]+/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0 && p !== ".");
	if (parts.some((p) => p === "..")) return null;
	return parts.join("/");
}

function defaultDataPath(plugin: MTGCollectionPlugin): string | null {
	return plugin.manifest.dir ? normalizePath(`${plugin.manifest.dir}/data.json`) : null;
}

function dataFilePath(plugin: MTGCollectionPlugin): string | null {
	const folder = plugin.dataFolderInUse;
	return folder ? normalizePath(`${folder}/${CUSTOM_DATA_FILE_NAME}`) : defaultDataPath(plugin);
}

function parseSettingsText(text: string): Obj | null {
	try {
		const v: unknown = JSON.parse(text);
		return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
	} catch {
		return null;
	}
}

// Une seule file pour toutes les opérations disque : la chaîne ne rejette
// jamais (toute erreur est journalisée ici), sinon un seul échec bloquerait
// définitivement les suivantes.
function enqueue(plugin: MTGCollectionPlugin, task: () => Promise<void>): Promise<void> {
	const run = plugin.persistChain.then(task).catch((e) => {
		console.error("MTG Collection Tracker: settings sync failed.", e);
	});
	plugin.persistChain = run;
	return run;
}

/* ------------------------------- chargement -------------------------------- */

// Remplace loadData() pour le chargement initial : on a besoin du TEXTE du
// fichier (version de départ de la fusion, détection d'écho) et de sa signature,
// que loadData() ne donne pas. Même résultat par ailleurs (fichier absent ou
// illisible → null → réglages par défaut), avec une précaution en plus : un
// fichier illisible est mis de côté avant que la première sauvegarde ne
// l'écrase par des réglages vides.
export async function readSettingsFromDisk(this: MTGCollectionPlugin): Promise<Partial<MTGCollectionSettings> | null> {
	// Où est le fichier ? C'est un réglage propre à l'appareil, donc lu dans le stockage de l'appareil
	// AVANT le fichier lui-même (les autres réglages propres à l'appareil sont repris juste après).
	const stored = readLocalStore(this);
	const storedFolder = stored !== null && typeof stored === "object" ? (stored as Obj).dataFolder : "";
	this.dataFolderInUse = (typeof storedFolder === "string" && normalizeDataFolder(storedFolder)) || "";

	let path = dataFilePath(this);
	if (!path) return ((await this.loadData()) as Partial<MTGCollectionSettings> | null) ?? null;
	const adapter = this.app.vault.adapter;
	let seeding = false;
	if (!(await adapter.exists(path))) {
		// Dossier choisi mais fichier pas (encore) là — par exemple pas encore livré par Syncthing sur
		// un nouvel appareil : plutôt que de démarrer sur une collection VIDE (on croirait tout perdu),
		// on repart des données de l'emplacement d'origine ; la première sauvegarde créera le fichier.
		const fallback = this.dataFolderInUse ? defaultDataPath(this) : null;
		if (!fallback || !(await adapter.exists(fallback))) return null;
		path = fallback;
		seeding = true;
	}
	let text: string;
	try {
		text = await adapter.read(path);
	} catch (e) {
		console.error("MTG Collection Tracker: could not read the data file.", e);
		return null;
	}
	const data = parseSettingsText(text);
	if (!data) {
		const copy = normalizePath(`${this.manifest.dir}/data.unreadable-${Date.now()}.json`);
		try {
			await adapter.write(copy, text);
			new Notice(`MTG Collection Tracker: data.json could not be read. A copy was kept as ${copy}.`, 15000);
		} catch (e) {
			console.error("MTG Collection Tracker: could not keep a copy of the unreadable data.json.", e);
		}
		return null;
	}
	if (seeding) return data; // rien n'est lu "depuis" l'emplacement actif
	this.diskText = text;
	this.syncBaseText = text;
	const st = await adapter.stat(path);
	this.diskSig = st ? { mtime: st.mtime, size: st.size } : null;
	return data;
}

export type DataFolderResult = { ok: true; mergedExisting: boolean } | { ok: false; message: string };

// Change le dossier qui contient le fichier de données (réglage "Data folder"). Jamais de perte :
// 1. l'ancien fichier est mis à jour une dernière fois puis laissé en place — rien n'est supprimé ;
// 2. si un fichier de données existe déjà dans le nouveau dossier (celui d'un autre appareil que
//    Syncthing y a livré, par exemple), il est FUSIONNÉ avec les données en mémoire, pas écrasé ;
// 3. à la moindre erreur on revient à l'emplacement précédent.
// Tout passe par la file des opérations disque.
export function changeDataFolder(this: MTGCollectionPlugin, folder: string): Promise<DataFolderResult> {
	return new Promise((resolve) => {
		void enqueue(this, async () => {
			const next = normalizeDataFolder(folder);
			if (next === null) return resolve({ ok: false, message: 'A folder cannot contain "..".' });
			const previous = this.dataFolderInUse;
			if (next === previous) return resolve({ ok: true, mergedExisting: false });
			const adapter = this.app.vault.adapter;
			const oldPath = dataFilePath(this);
			try {
				if (oldPath && this.settingsLoaded) {
					prepareLocal(this);
					await reconcileUntilStable(this, oldPath);
					await writeToDisk(this, oldPath);
				}
				this.dataFolderInUse = next;
				const newPath = dataFilePath(this);
				if (!newPath) throw new Error("No place to store the data.");
				if (next && !(await adapter.exists(next))) await adapter.mkdir(next);
				this.diskText = null;
				this.diskSig = null;
				this.syncBaseText = null;
				let merged = false;
				if (await adapter.exists(newPath)) {
					const text = await adapter.read(newPath);
					prepareLocal(this);
					const outcome = mergeForeignText(this, text, null);
					if (!outcome) throw new Error("The data file already in that folder is not valid.");
					this.syncBaseText = text;
					this.diskText = text;
					if (outcome.changedLocal) this.markGithubDirty();
					merged = true;
				}
				await writeToDisk(this, newPath);
				const st = await adapter.stat(newPath);
				if (!st) throw new Error("The data file could not be created there.");
				this.diskSig = { mtime: st.mtime, size: st.size };
				this.settings.dataFolder = next;
				this.saveDeviceLocalSettings();
				resolve({ ok: true, mergedExisting: merged });
			} catch (e) {
				console.error("MTG Collection Tracker: changing the data folder failed, keeping the previous one.", e);
				this.dataFolderInUse = previous;
				this.diskText = null;
				this.diskSig = null; // le prochain contrôle relira l'ancien fichier
				this.syncBaseText = null;
				resolve({ ok: false, message: e instanceof Error ? e.message : String(e) });
			}
		});
	});
}

// À appeler une fois les réglages chargés ET migrés : les suppressions seront
// détectées par rapport à cet état.
export function markSettingsLoaded(this: MTGCollectionPlugin) {
	this.knownKeys = snapshotKeys(this.settings as unknown as Obj);
	this.knownScalars = snapshotScalars(this.settings as unknown as Obj);
	this.knownPrints = snapshotEntityPrints(this.settings as unknown as Obj);
	this.settingsLoaded = true;
}

/* ------------------------ réglages propres à l'appareil ---------------------- */

// Lecture du stockage local ; repli sur localStorage si l'API d'Obsidian (≥ 1.8.7) manque.
function readLocalStore(plugin: MTGCollectionPlugin): unknown {
	try {
		const app = plugin.app as unknown as { loadLocalStorage?: (k: string) => unknown };
		if (typeof app.loadLocalStorage === "function") return app.loadLocalStorage(DEVICE_SETTINGS_STORAGE_KEY);
		const raw = window.localStorage.getItem(DEVICE_SETTINGS_STORAGE_KEY);
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

function writeLocalStore(plugin: MTGCollectionPlugin, value: Obj): void {
	try {
		const app = plugin.app as unknown as { saveLocalStorage?: (k: string, v: unknown) => void };
		if (typeof app.saveLocalStorage === "function") app.saveLocalStorage(DEVICE_SETTINGS_STORAGE_KEY, value);
		else window.localStorage.setItem(DEVICE_SETTINGS_STORAGE_KEY, JSON.stringify(value));
	} catch (e) {
		console.warn("MTG Collection Tracker: could not save this device's display settings.", e);
	}
}

// Appelé juste après la lecture de data.json : les valeurs propres à CET appareil
// reprennent le dessus. Premier lancement après la mise à jour (rien en stock) : on
// garde ce que data.json contenait jusque-là — l'appareil ne change donc pas d'aspect —
// et on le met en stock tout de suite, car data.json n'en portera plus.
export function loadDeviceLocalSettings(this: MTGCollectionPlugin) {
	const stored = readLocalStore(this);
	if (stored !== null && typeof stored === "object" && !Array.isArray(stored)) {
		const target = this.settings as unknown as Obj;
		const defaults = DEFAULT_SETTINGS as unknown as Obj;
		for (const [k, v] of Object.entries(stored as Obj)) {
			// Seulement une clé connue, du bon type : un stock périmé ou trafiqué ne doit rien casser.
			if (DEVICE_LOCAL_KEYS.has(k) && typeof v === typeof defaults[k]) target[k] = v;
		}
	}
	this.saveDeviceLocalSettings();
}

// Synchrone et peu coûteux (une trentaine de valeurs) : appelé à chaque saveSettings().
export function saveDeviceLocalSettings(this: MTGCollectionPlugin) {
	const picked = pickDeviceLocal(this.settings);
	const serialized = JSON.stringify(picked);
	if (serialized === this.lastDeviceLocal) return;
	this.lastDeviceLocal = serialized;
	writeLocalStore(this, picked);
}

/* -------------------------------- écriture --------------------------------- */

// Chemin de toutes les sauvegardes (voir saveSettings, flushPendingSave).
export function persistSettings(this: MTGCollectionPlugin): Promise<void> {
	return enqueue(this, async () => {
		const path = dataFilePath(this);
		if (!path) {
			await this.saveData(this.settings);
			return;
		}
		prepareLocal(this);
		await reconcileUntilStable(this, path);
		await writeToDisk(this, path);
	}).then(() => {
		// Écriture ratée : une seule nouvelle tentative différée — Obsidian
		// avalait silencieusement ce genre d'échec (saveData), la modification
		// restait alors en mémoire seulement jusqu'à la sauvegarde suivante.
		if (this.saveFailed && this.saveRetryTimer === null) {
			this.saveRetryTimer = window.setTimeout(() => {
				this.saveRetryTimer = null;
				void this.persistSettings();
			}, SAVE_RETRY_MS);
		}
	});
}

// Contrôle (et fusion éventuelle) hors écriture : hook Obsidian, sondage,
// retour au premier plan. Un seul contrôle en attente à la fois.
export function checkForExternalChange(this: MTGCollectionPlugin, _reason = "poll"): Promise<void> {
	if (!this.settingsLoaded || this.externalCheckQueued) return Promise.resolve();
	this.externalCheckQueued = true;
	return enqueue(this, async () => {
		this.externalCheckQueued = false;
		const path = dataFilePath(this);
		if (!path) return;
		// Le fichier n'a pas bougé : rien à fusionner, donc rien à préparer non plus.
		const st = await this.app.vault.adapter.stat(path);
		const known = this.diskSig;
		if (!st || (known && known.mtime === st.mtime && known.size === st.size)) return;
		prepareLocal(this);
		const { needsWrite } = await reconcileUntilStable(this, path);
		if (!needsWrite) return;
		const now = Date.now();
		this.mergeWrites = this.mergeWrites.filter((t) => now - t < MERGE_WRITE_WINDOW_MS);
		if (this.mergeWrites.length >= MERGE_WRITE_MAX) {
			console.warn("MTG Collection Tracker: too many merge rewrites in a row, pausing until the next local change.");
			return;
		}
		this.mergeWrites.push(now);
		await writeToDisk(this, path);
	});
}

// Appelé par Obsidian quand data.json change sur le disque hors du plugin
// (compare l'mtime à celui de sa dernière lecture/écriture — voir app.js,
// Plugin._onConfigFileChange). Fiable sur desktop ; sur mobile et quand
// l'horloge d'un appareil dérive il peut manquer : d'où le sondage ci-dessous.
export function onExternalSettingsChange(this: MTGCollectionPlugin): Promise<void> {
	return this.checkForExternalChange("watcher");
}

export function setupSettingsSync(this: MTGCollectionPlugin) {
	this.registerInterval(window.setInterval(() => void this.checkForExternalChange("poll"), SETTINGS_POLL_MS));
	this.registerDomEvent(window, "focus", () => void this.checkForExternalChange("focus"));
	this.registerDomEvent(document, "visibilitychange", () => {
		if (document.visibilityState === "visible") void this.checkForExternalChange("visible");
	});
}

/* --------------------------------- internes -------------------------------- */

// Inscrit les suppressions faites depuis la dernière écriture AVANT toute
// fusion : une suppression locale encore dans le délai de regroupement n'a pas
// de pierre tombale, la copie encore présente à distance la ferait revenir.
export function prepareLocal(plugin: MTGCollectionPlugin) {
	if (!plugin.knownKeys || !plugin.knownScalars || !plugin.knownPrints) return;
	const settings = plugin.settings as unknown as Obj;
	const now = Date.now();
	recordTombstones(settings, plugin.knownKeys, now);
	recordScalarStamps(settings, plugin.knownScalars, now);
	recordEntityStamps(settings, plugin.knownPrints, now);
	plugin.knownKeys = snapshotKeys(settings);
	plugin.knownScalars = snapshotScalars(settings);
	plugin.knownPrints = snapshotEntityPrints(settings);
}

// Fusionne, puis re-contrôle le disque juste avant de rendre la main : un fichier arrivé
// pendant la lecture/fusion (Syncthing renomme le sien par-dessus) serait sinon écrasé
// par l'écriture qui suit. La fenêtre qui reste est celle d'un seul stat → write.
async function reconcileUntilStable(plugin: MTGCollectionPlugin, path: string): Promise<{ needsWrite: boolean }> {
	let needsWrite = false;
	for (let pass = 0; pass < MAX_RECONCILE_PASSES; pass++) {
		const outcome = await reconcile(plugin, path);
		needsWrite = needsWrite || outcome.needsWrite;
		const st = await plugin.app.vault.adapter.stat(path);
		const known = plugin.diskSig;
		if (!st || (known && known.mtime === st.mtime && known.size === st.size)) break;
	}
	return { needsWrite };
}

export interface ForeignMergeOutcome {
	/** L'état local a changé (il faut le sauvegarder et rafraîchir les vues). */
	changedLocal: boolean;
	/** L'état fusionné contient quelque chose que la source n'a pas : il faut le lui renvoyer. */
	needsWrite: boolean;
}

// Fusionne `text` (le contenu d'une source extérieure : le fichier du disque que Syncthing a pu
// remplacer, ou le fichier GitHub) dans les réglages en mémoire. `baseText` = dernière version
// VENUE DE CETTE SOURCE (jamais nos propres écritures — voir core/settings-merge.ts). Renvoie
// null si `text` n'est pas un JSON de réglages. Synchrone de bout en bout : aucun await entre le
// calcul de la fusion et son application, l'état local ne peut pas bouger entre les deux.
// `ignore` : clés que cette source ne transporte pas (voir omitKeys).
export function mergeForeignText(
	plugin: MTGCollectionPlugin,
	text: string,
	baseText: string | null,
	ignore?: ReadonlySet<string>
): ForeignMergeOutcome | null {
	const remote = parseSettingsText(text);
	if (!remote) return null;
	const local = plugin.settings as unknown as Obj;
	const base = baseText ? parseSettingsText(baseText) : null;
	const { merged, report } = mergeSettings(base, local, remote, ignore, DEFAULT_SETTINGS as unknown as Obj);

	if (report.needsWrite) void saveSyncBackup(plugin, "remote", text);
	if (report.removed >= BIG_REMOVAL_THRESHOLD || report.added >= BIG_ADDITION_THRESHOLD) {
		void saveSyncBackup(plugin, "local", JSON.stringify(local, null, 2));
		const what =
			report.removed >= BIG_REMOVAL_THRESHOLD
				? `removed ${report.removed} items`
				: `added ${report.added} items`;
		new Notice(
			`MTG Collection Tracker: another device ${what}. A copy of this device's previous data was kept in ${SYNC_BACKUP_DIR}.`,
			12000
		);
	}
	if (report.changedLocal) {
		applySettingsInPlace(local, merged);
		plugin.dataVersion++;
		plugin.cachedArtists = null;
		plugin.cachedSets = null;
		plugin.refreshOpenViews();
	}
	if (report.added + report.removed + report.updated > 0) {
		console.debug(
			`MTG Collection Tracker: merged data from another device (+${report.added} −${report.removed} ~${report.updated}).`
		);
	}
	// Ce qui vient d'être fusionné n'est PAS une modification locale : sans cette
	// remise à jour, le prochain contrôle l'horodaterait comme telle.
	plugin.knownKeys = snapshotKeys(local);
	plugin.knownScalars = snapshotScalars(local);
	plugin.knownPrints = snapshotEntityPrints(local);
	return { changedLocal: report.changedLocal, needsWrite: report.needsWrite };
}

async function reconcile(plugin: MTGCollectionPlugin, path: string): Promise<{ needsWrite: boolean }> {
	const adapter = plugin.app.vault.adapter;
	const st = await adapter.stat(path);
	if (!st) return { needsWrite: false }; // fichier supprimé : la prochaine écriture le recrée
	const sig: DiskSignature = { mtime: st.mtime, size: st.size };
	const known = plugin.diskSig;
	if (known && known.mtime === sig.mtime && known.size === sig.size) return { needsWrite: false };

	const text = await adapter.read(path);
	if (text === plugin.diskText) {
		plugin.diskSig = sig; // mtime retouché, contenu identique
		return { needsWrite: false };
	}
	const outcome = mergeForeignText(plugin, text, plugin.syncBaseText);
	if (!outcome) {
		// Illisible (copie partielle, autre outil de sync…) : on ne touche à rien,
		// la prochaine écriture le remplacera par un fichier valide.
		console.warn("MTG Collection Tracker: data.json on disk is not valid JSON, ignoring it.");
		plugin.diskSig = sig;
		return { needsWrite: false };
	}
	plugin.syncBaseText = text;
	plugin.diskText = text;
	plugin.diskSig = sig;
	// Ce que Syncthing vient d'apporter doit aussi partir vers GitHub (s'il est activé).
	if (outcome.changedLocal) plugin.markGithubDirty();
	return { needsWrite: outcome.needsWrite };
}

async function writeToDisk(plugin: MTGCollectionPlugin, path: string): Promise<void> {
	// Sans les réglages propres à l'appareil : un changement de tri ne doit ni réécrire 6 Mo ni partir ailleurs.
	const text = JSON.stringify(omitDeviceLocal(plugin.settings), null, 2);
	if (text === plugin.diskText) return; // le disque a déjà exactement cet état
	const adapter = plugin.app.vault.adapter;
	const mtime = Date.now();
	plugin.saveFailed = false;
	try {
		try {
			await adapter.write(path, text, { mtime });
		} catch (e) {
			// Dossier choisi par l'utilisateur, supprimé depuis : on le recrée une fois plutôt que de
			// perdre la sauvegarde.
			if (!plugin.dataFolderInUse || (await adapter.exists(plugin.dataFolderInUse))) throw e;
			await adapter.mkdir(plugin.dataFolderInUse);
			await adapter.write(path, text, { mtime });
		}
	} catch (e) {
		plugin.saveFailed = true;
		throw e;
	}
	const st = await adapter.stat(path);
	plugin.diskText = text;
	if (st && Math.abs(st.mtime - mtime) <= WRITE_RACE_TOLERANCE_MS) {
		plugin.diskSig = { mtime: st.mtime, size: st.size };
	} else {
		// Le fichier ne porte pas l'mtime qu'on vient de lui donner : un autre
		// processus l'a réécrit entre-temps. On oublie la signature pour que
		// le prochain contrôle relise et fusionne.
		plugin.diskSig = null;
		void plugin.checkForExternalChange("write-race");
	}
}

// Copie de secours dans le dossier du plugin (les 3 plus récentes par type).
// Jamais bloquant : un échec ici ne doit ni empêcher la fusion ni l'écriture.
async function saveSyncBackup(plugin: MTGCollectionPlugin, kind: "remote" | "local", text: string): Promise<void> {
	try {
		const adapter = plugin.app.vault.adapter;
		const dir = normalizePath(`${plugin.manifest.dir}/${SYNC_BACKUP_DIR}`);
		if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		await adapter.write(`${dir}/data-${kind}-${stamp}.json`, text);
		const listing = await adapter.list(dir);
		const mine = listing.files.filter((f) => f.split("/").pop()!.startsWith(`data-${kind}-`)).sort();
		for (const old of mine.slice(0, Math.max(0, mine.length - SYNC_BACKUP_KEEP))) await adapter.remove(old);
	} catch (e) {
		console.warn("MTG Collection Tracker: could not write a sync backup.", e);
	}
}

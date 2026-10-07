import { App, normalizePath } from "obsidian";

// Écriture d'un fichier d'export DANS la vault + remise à la feuille de
// partage native d'Obsidian mobile — la couche basse de ui/file-export.ts et
// de modals/export-destination-modal.ts. Séparée de l'une comme de l'autre
// pour qu'aucune des deux n'ait à importer l'autre (file-export.ts ouvre la
// modale, la modale écrit via ce fichier) : sinon import circulaire.
//
// Un plugin Obsidian ne peut écrire QUE dans la vault (vault.adapter) — ni
// fenêtre système "Enregistrer sous" ni dossier arbitraire de l'appareil sur
// iOS/Android. Le "où enregistrer" proposé à l'utilisateur est donc un
// dossier de la vault ; pour sortir de la vault, la seule porte est la
// feuille de partage native (shareVaultFile).

// Dossier par défaut des exports mobiles — même convention de nommage que
// le dossier de sauvegardes automatiques par défaut ("MTG Backups",
// lifecycle.ts).
export const DEFAULT_EXPORT_FOLDER = "MTG Exports";

export type ExportContent = string | ArrayBuffer;

const LAST_FOLDER_KEY = "mtg-collection-tracker:export-folder";
// Idem pour le dernier dossier de l'APPAREIL (Android, voir plus bas) — par
// nature propre à cet appareil, donc jamais dans un fichier synchronisé.
const LAST_DEVICE_FOLDER_KEY = "mtg-collection-tracker:export-device-folder";

// Caractères interdits dans un nom de fichier sur au moins une des deux
// plateformes mobiles — les noms construits par les appelants n'en
// contiennent jamais (tout passe par un [^a-z0-9]+ → "-"), mais la modale
// laisse maintenant l'utilisateur taper le nom lui-même. Un "/" créerait
// sinon un sous-dossier inexistant.
export function sanitizeFileName(name: string, fallback = "export"): string {
	const cleaned = name.replace(/[\\/:*?"<>|]/g, "-").trim();
	return cleaned === "" || /^\.+$/.test(cleaned) ? fallback : cleaned;
}

// Chemin saisi par l'utilisateur pour un NOUVEAU dossier → chemin de vault
// normalisé, ou null s'il n'est pas acceptable. Refuse tout segment commençant
// par "." : ça exclut ".." (remonter hors de la vault) mais aussi
// ".obsidian" et autres dossiers cachés, où un export n'a rien à faire.
export function sanitizeFolderPath(input: string): string | null {
	const segments = input
		.split(/[\\/]+/)
		.map((s) => s.trim())
		.filter((s) => s !== "");
	if (segments.length === 0) return null;
	if (segments.some((s) => s.startsWith(".") || /[:*?"<>|]/.test(s))) return null;
	return normalizePath(segments.join("/"));
}

function isVaultRoot(folder: string): boolean {
	return folder === "/" || folder === "";
}

// La racine de la vault s'appelle "/" côté Obsidian : la concaténer telle
// quelle donnerait "//nom" au lieu de "nom".
export function joinVaultPath(folder: string, filename: string): string {
	return isVaultRoot(folder) ? normalizePath(filename) : normalizePath(`${folder}/${filename}`);
}

export function folderDisplayName(folder: string): string {
	return isVaultRoot(folder) ? "Vault root" : folder;
}

// Même chose, mais pour l'insérer dans une phrase ("Saved x.csv to the vault
// root." plutôt que "to Vault root.").
export function folderSentenceName(folder: string): string {
	return isVaultRoot(folder) ? "the vault root" : folder;
}

// Crée chaque niveau à tour de rôle plutôt qu'un seul mkdir sur le chemin
// complet : on ne sait pas si adapter.mkdir crée les parents manquants sur
// tous les adaptateurs (desktop/Capacitor) — un dossier saisi à la main peut
// être imbriqué ("Decks/Exports").
export async function ensureFolder(app: App, folder: string): Promise<void> {
	if (isVaultRoot(folder)) return;
	const adapter = app.vault.adapter;
	let current = "";
	for (const segment of normalizePath(folder).split("/")) {
		current = current === "" ? segment : `${current}/${segment}`;
		if (await adapter.exists(current)) continue;
		// Peut légitimement lever si un autre export vient de créer le dossier
		// entre-temps — ignoré volontairement, l'écriture qui suit fera
		// surface toute vraie erreur (même idiome que runAutoBackup).
		try {
			await adapter.mkdir(current);
		} catch {
			/* voir commentaire ci-dessus */
		}
	}
}

export function exportTargetExists(app: App, folder: string, filename: string): Promise<boolean> {
	return app.vault.adapter.exists(joinVaultPath(folder, sanitizeFileName(filename)));
}

// vault.adapter.write plutôt que vault.create : Vault.create() lève "File
// already exists." dès que le fichier existe SUR DISQUE (il interroge
// adapter.exists, pas l'index de la vault), donc un 2ème export du même nom
// échouerait ; adapter.write écrase, et CapacitorAdapter.write réindexe le
// fichier ensuite (reconcileInternalFile) exactement comme vault.create le
// ferait. Lève en cas d'échec — c'est à l'appelant d'afficher l'erreur.
export async function writeExportFile(
	app: App,
	folder: string,
	filename: string,
	content: ExportContent
): Promise<string> {
	const path = joinVaultPath(folder, sanitizeFileName(filename));
	await ensureFolder(app, folder);
	const adapter = app.vault.adapter;
	if (typeof content === "string") await adapter.write(path, content);
	else await adapter.writeBinary(path, content);
	return path;
}

// openWithDefaultApp n'est pas dans les typings publics d'Obsidian (mais bien
// présent à l'exécution, desktop et mobile — c'est l'appel derrière l'action
// "Share" du menu fichier d'Obsidian mobile, voir CLAUDE.md, "File export").
// Accès gardé : s'il disparaît un jour, l'appelant a déjà dit où le fichier
// vit. Appelée comme méthode de `app` (elle lit this.vault), jamais
// détachée. Elle avale elle-même ses erreurs natives (Notice d'Obsidian) ; le
// try/catch ne couvre qu'un rejet inattendu.
export async function shareVaultFile(app: App, path: string): Promise<void> {
	const openWithDefaultApp = (app as unknown as { openWithDefaultApp?: (path: string) => Promise<void> })
		.openWithDefaultApp;
	if (typeof openWithDefaultApp !== "function") return;
	try {
		await openWithDefaultApp.call(app, path);
	} catch (e) {
		console.error("MTG Collection Tracker: could not open the share sheet.", e);
	}
}

export function getLastExportFolder(): string {
	try {
		const stored = window.localStorage?.getItem(LAST_FOLDER_KEY);
		if (typeof stored === "string" && stored !== "") return stored;
	} catch {
		/* localStorage peut être indisponible (données de site bloquées, etc.) */
	}
	return DEFAULT_EXPORT_FOLDER;
}

export function rememberExportFolder(folder: string): void {
	try {
		window.localStorage?.setItem(LAST_FOLDER_KEY, folder);
	} catch {
		/* voir getLastExportFolder */
	}
}

/* -------------------------------------------------------------------------- */
/*  Dossier de l'appareil (Android uniquement, expérimental)                  */
/* -------------------------------------------------------------------------- */

// Sur Android la feuille de partage système ne liste que des applications :
// aucun "Enregistrer dans un dossier" (contrairement à iOS, dont la feuille
// propose "Enregistrer dans Fichiers"). Obsidian, lui, sait déjà faire
// exactement ça pour ses propres vaults sur le stockage de l'appareil : un
// sélecteur de dossier natif (le plugin Capacitor "Filesystem", méthode
// `choose`) puis des écritures via la couche fichiers de l'adaptateur de la
// vault (`app.vault.adapter.fs`). Rien de tout ça n'est documenté pour les
// plugins — voir CLAUDE.md, "File export" — d'où l'isolation ici et les
// garde-fous ci-dessous.
//
// Ce qui rend la chose cohérente : pour une vault sur le stockage de
// l'appareil, basePath de l'adaptateur EST le résultat d'un choose() fait à la
// création de la vault, et chaque écriture passe par fs.write(join(basePath,
// chemin relatif)). Un nouveau choose() donne donc un chemin dans le MÊME
// espace que celui que l'adaptateur passe déjà à fs.write — qu'il soit
// absolu ou relatif à la racine du stockage, on n'a pas à le deviner, juste à
// ne pas le normaliser (normalizePath retirerait un "/" initial).

interface NativeFilesystemPlugin {
	choose?: () => Promise<{ path?: string; isRoot?: boolean } | undefined>;
}

interface MobileVaultFs {
	dir?: string | null;
	write?: (path: string, data: string) => Promise<void>;
	writeBinary?: (path: string, data: ArrayBuffer) => Promise<void>;
	exists?: (path: string) => Promise<boolean>;
	stat?: (path: string) => Promise<unknown>;
}

// Valeurs de `fs.dir` (le `Directory` de Capacitor, étendu par Obsidian) pour
// lesquelles un chemin renvoyé par choose() vit dans le même espace que les
// écritures de la vault : la racine du stockage partagé, ou aucune (chemins
// absolus). Une vault dans le stockage PRIVÉ de l'app (DOCUMENTS, DATA,
// EXTERNAL, ICLOUD…) écrit ses chemins relativement à un autre dossier — y
// écrire un chemin choisi atterrirait dans ce stockage privé, invisible.
const DEVICE_STORAGE_DIRS = new Set(["", "EXTERNAL_STORAGE"]);

function getVaultFs(app: App): MobileVaultFs | null {
	const fs = (app.vault.adapter as unknown as { fs?: MobileVaultFs }).fs;
	return fs && typeof fs.write === "function" ? fs : null;
}

export function getDeviceFolderSupport(app: App): { ok: true } | { ok: false; reason: string } {
	const fs = getVaultFs(app);
	if (!fs) {
		return { ok: false, reason: "This version of Obsidian doesn't let plugins write to device storage." };
	}
	if (!DEVICE_STORAGE_DIRS.has(fs.dir ?? "")) {
		return {
			ok: false,
			reason: "Your vault is in Obsidian's private app storage, so it can only write inside the vault. Use Save or Share… instead.",
		};
	}
	return { ok: true };
}

// Ouvre le sélecteur de dossier natif d'Obsidian. null = annulé par
// l'utilisateur (Obsidian lui-même reconnaît l'annulation à un message
// contenant "canceled", dans son propre écran de création de vault) ; toute
// autre erreur est relancée telle quelle pour être affichée. Le proxy des
// plugins Capacitor répond à N'IMPORTE QUEL nom de méthode par une fonction
// (l'appel échoue seulement à l'exécution) : un `typeof choose === "function"`
// ne prouverait donc rien, c'est l'appel qui tranche.
export async function pickDeviceFolder(): Promise<string | null> {
	const plugin = (window as { Capacitor?: { Plugins?: { Filesystem?: NativeFilesystemPlugin } } }).Capacitor
		?.Plugins?.Filesystem;
	if (!plugin?.choose) throw new Error("Obsidian's folder picker is not available on this device.");
	let picked: { path?: string; isRoot?: boolean } | undefined;
	try {
		picked = await plugin.choose();
	} catch (e) {
		const message = String((e as { message?: unknown } | null)?.message ?? e);
		if (/cancel/i.test(message)) return null;
		throw e;
	}
	if (!picked || typeof picked.path !== "string") return null;
	// Même refus qu'Obsidian pour une vault : la racine du stockage n'est pas
	// un dossier où déposer un fichier. Un chemin vide vaut la racine : sans ce
	// refus, joinDevicePath("", nom) donnerait "/nom", à la racine du système.
	if (picked.isRoot || picked.path.trim() === "") {
		throw new Error("Please choose a folder inside your device storage, not its root.");
	}
	return picked.path;
}

// Sans normalizePath : il retirerait un "/" initial, et le chemin doit rester
// tel que choose() l'a rendu (voir le commentaire de section ci-dessus).
function joinDevicePath(folder: string, name: string): string {
	return folder.replace(/\/+$/, "") + "/" + name;
}

// "a.csv" + 2 → "a (2).csv" ; sans extension : "a" + 2 → "a (2)".
export function withNumericSuffix(name: string, n: number): string {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

// true/false, ou null quand la couche fichiers n'offre aucun moyen de le
// savoir (ne jamais confondre "inconnu" avec "n'existe pas").
async function probeDevicePath(fs: MobileVaultFs, path: string): Promise<boolean | null> {
	if (typeof fs.exists === "function") return fs.exists(path);
	if (typeof fs.stat === "function") {
		try {
			await fs.stat(path);
			return true;
		} catch {
			return false;
		}
	}
	return null;
}

async function deviceFileExists(fs: MobileVaultFs, path: string): Promise<boolean> {
	return (await probeDevicePath(fs, path)) === true;
}

// Écrit dans un dossier de l'appareil choisi via pickDeviceFolder(). Contrairement
// à writeExportFile (qui écrase, dans un dossier de la vault que l'utilisateur
// gère), on n'écrase JAMAIS ici : un dossier quelconque de l'appareil (Documents,
// Téléchargements…) peut contenir un fichier du même nom qui n'est pas le nôtre —
// on numérote ("a (2).csv") à la place. Vérifie enfin que le fichier existe bien
// là où on l'attend : si l'écriture a "réussi" sans y atterrir, on le dit au lieu
// d'annoncer un enregistrement qui n'a pas eu lieu.
export async function writeToDeviceFolder(
	app: App,
	folder: string,
	filename: string,
	content: ExportContent
): Promise<{ path: string; name: string }> {
	const fs = getVaultFs(app);
	if (!fs) throw new Error("This version of Obsidian doesn't let plugins write to device storage.");
	if (folder.trim() === "") throw new Error("No folder was chosen.");
	const base = sanitizeFileName(filename);
	let name = base;
	for (let n = 2; await deviceFileExists(fs, joinDevicePath(folder, name)); n++) {
		if (n > 99) throw new Error("There are too many files with this name in that folder.");
		name = withNumericSuffix(base, n);
	}
	const path = joinDevicePath(folder, name);
	if (typeof content === "string") {
		await fs.write!(path, content);
	} else {
		if (typeof fs.writeBinary !== "function") throw new Error("This version of Obsidian can't write binary files here.");
		await fs.writeBinary(path, content);
	}
	if (!(await deviceFileExists(fs, path))) {
		throw new Error("The file wasn't found in that folder after writing — Obsidian may not be allowed to write there.");
	}
	return { path, name };
}

// Dernier dossier de l'appareil utilisé avec succès, par appareil : permet à la
// fenêtre d'export (Android) de proposer un "Save to <dossier>" en un seul
// geste, sans rouvrir le sélecteur natif à chaque fois. null = aucun.
export function getLastDeviceFolder(): string | null {
	try {
		const stored = window.localStorage?.getItem(LAST_DEVICE_FOLDER_KEY);
		if (typeof stored === "string" && stored.trim() !== "") return stored;
	} catch {
		/* voir getLastExportFolder */
	}
	return null;
}

export function rememberDeviceFolder(folder: string): void {
	if (folder.trim() === "") return;
	try {
		window.localStorage?.setItem(LAST_DEVICE_FOLDER_KEY, folder);
	} catch {
		/* voir getLastExportFolder */
	}
}

// Forme lisible d'un chemin d'appareil, pour un bouton ou un message : retire
// le préfixe du stockage principal ("/storage/emulated/0/Documents/Decks" →
// "Documents/Decks"). Un chemin relatif à la racine du stockage, ou situé sur
// un autre volume, est laissé tel quel — le chemin réel, lui, n'est jamais
// modifié (il reste celui que choose() a rendu, voir plus haut).
export function deviceFolderDisplayPath(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	const stripped = trimmed.replace(/^\/(?:storage\/emulated\/\d+|sdcard)\//, "");
	return stripped === "" ? trimmed : stripped;
}

// Message d'échec pour une écriture dans un dossier DÉJÀ mémorisé : si le
// dossier n'existe plus (supprimé, déplacé, carte SD retirée), le dire en clair
// plutôt que d'afficher l'erreur native brute. Appelé APRÈS l'échec, jamais
// avant l'écriture : un faux "n'existe pas" de la couche fichiers ne doit pas
// pouvoir bloquer une écriture qui aurait réussi.
export async function describeDeviceFolderError(app: App, folder: string, error: unknown): Promise<string> {
	const message = String((error as { message?: unknown } | null)?.message ?? error);
	const fs = getVaultFs(app);
	if (fs) {
		try {
			if ((await probeDevicePath(fs, folder)) === false) {
				return `The folder “${deviceFolderDisplayPath(folder)}” doesn't exist anymore. Pick another one.`;
			}
		} catch {
			/* on garde le message d'origine */
		}
	}
	return message;
}

import { App, normalizePath } from "obsidian";

// Writing an export file INTO the vault + handing over to Obsidian mobile's
// native share sheet — the low layer of ui/file-export.ts and of
// modals/export-destination-modal.ts. Separated from both so that neither
// has to import the other (file-export.ts opens the modal, the modal writes
// via this file): otherwise a circular import.
//
// An Obsidian plugin can ONLY write into the vault (vault.adapter) — neither
// a system "Save as" window nor an arbitrary device folder on iOS/Android.
// The "where to save" offered to the user is therefore a vault folder; to
// get out of the vault, the only way is the native share sheet
// (shareVaultFile).

// Default folder of mobile exports — same naming convention as the default
// automatic backups folder ("MTG Backups", lifecycle.ts).
export const DEFAULT_EXPORT_FOLDER = "MTG Exports";

export type ExportContent = string | ArrayBuffer;

const LAST_FOLDER_KEY = "mtg-collection-tracker:export-folder";
// Same for the last DEVICE folder (Android, see below) — specific to this
// device by nature, so never in a synchronized file.
const LAST_DEVICE_FOLDER_KEY = "mtg-collection-tracker:export-device-folder";

// Characters forbidden in a file name on at least one of the two mobile
// platforms — the names built by the callers never contain any (everything
// goes through a [^a-z0-9]+ → "-"), but the modal now lets the user type
// the name themselves. A "/" would otherwise create a non-existent
// subfolder.
export function sanitizeFileName(name: string, fallback = "export"): string {
	const cleaned = name.replace(/[\\/:*?"<>|]/g, "-").trim();
	return cleaned === "" || /^\.+$/.test(cleaned) ? fallback : cleaned;
}

// Path typed by the user for a NEW folder → normalized vault path, or null if
// it isn't acceptable. Refuses any segment starting with ".": that excludes
// ".." (going up out of the vault) but also ".obsidian" and other hidden
// folders, where an export has no business being.
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

// The vault root is called "/" on Obsidian's side: concatenating it as is
// would give "//name" instead of "name".
export function joinVaultPath(folder: string, filename: string): string {
	return isVaultRoot(folder) ? normalizePath(filename) : normalizePath(`${folder}/${filename}`);
}

export function folderDisplayName(folder: string): string {
	return isVaultRoot(folder) ? "Vault root" : folder;
}

// Same thing, but to insert it into a sentence ("Saved x.csv to the vault
// root." rather than "to Vault root.").
export function folderSentenceName(folder: string): string {
	return isVaultRoot(folder) ? "the vault root" : folder;
}

// Creates each level in turn rather than a single mkdir on the full path: we
// don't know whether adapter.mkdir creates the missing parents on all
// adapters (desktop/Capacitor) — a folder typed by hand can be nested
// ("Decks/Exports").
export async function ensureFolder(app: App, folder: string): Promise<void> {
	if (isVaultRoot(folder)) return;
	const adapter = app.vault.adapter;
	let current = "";
	for (const segment of normalizePath(folder).split("/")) {
		current = current === "" ? segment : `${current}/${segment}`;
		if (await adapter.exists(current)) continue;
		// May legitimately throw if another export has just created the folder in
		// the meantime — deliberately ignored, the write that follows will surface
		// any real error (same idiom as runAutoBackup).
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

// vault.adapter.write rather than vault.create: Vault.create() throws "File
// already exists." as soon as the file exists ON DISK (it queries
// adapter.exists, not the vault's index), so a 2nd export of the same name
// would fail; adapter.write overwrites, and CapacitorAdapter.write
// re-indexes the file afterwards (reconcileInternalFile) exactly as
// vault.create would. Throws on failure — it's up to the caller to display
// the error.
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

// openWithDefaultApp is not in Obsidian's public typings (but is present at
// runtime, desktop and mobile — it's the call behind the "Share" action of
// Obsidian mobile's file menu, see CLAUDE.md, "File export"). Guarded access:
// if it ever disappears, the caller has already said where the file lives.
// Called as a method of `app` (it reads this.vault), never detached. It
// swallows its native errors itself (Obsidian Notice); the try/catch only
// covers an unexpected rejection.
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
		/* localStorage may be unavailable (site data blocked, etc.) */
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
/* Device folder (Android only, experimental) */
/* -------------------------------------------------------------------------- */

// On Android the system share sheet only lists applications: no "Save to a
// folder" (unlike iOS, whose sheet offers "Save to Files"). Obsidian, for its
// part, already knows how to do exactly that for its own vaults on the
// device's storage: a native folder picker (the Capacitor "Filesystem" plugin,
// `choose` method) then writes through the file layer of the vault's adapter
// (`app.vault.adapter.fs`). None of this is documented for plugins — see
// CLAUDE.md, "File export" — hence the isolation here and the safeguards
// below.
//
// What makes the thing coherent: for a vault on the device's storage, the
// adapter's basePath IS the result of a choose() done when the vault was
// created, and every write goes through fs.write(join(basePath, relative
// path)). A new choose() therefore gives a path in the SAME space as the one
// the adapter already passes to fs.write — whether absolute or relative to the
// storage root, we don't have to guess, just not normalize it (normalizePath
// would remove a leading "/").

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

// Values of `fs.dir` (Capacitor's `Directory`, extended by Obsidian) for
// which a path returned by choose() lives in the same space as the vault's
// writes: the root of the shared storage, or none (absolute paths). A vault
// in the app's PRIVATE storage (DOCUMENTS, DATA, EXTERNAL, ICLOUD…) writes
// its paths relative to another folder — writing a chosen path there would
// land in that private storage, invisible.
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

// Opens Obsidian's native folder picker. null = canceled by the user (Obsidian
// itself recognizes the cancellation by a message containing "canceled", in
// its own vault creation screen); any other error is rethrown as is to be
// displayed. The Capacitor plugin proxy answers ANY method name with a
// function (the call only fails at runtime): a `typeof choose === "function"`
// would therefore prove nothing, it's the call that decides.
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
	// Same refusal as Obsidian for a vault: the storage root is not a folder in
	// which to drop a file. An empty path is equivalent to the root: without
	// this refusal, joinDevicePath("", name) would give "/name", at the root of
	// the system.
	if (picked.isRoot || picked.path.trim() === "") {
		throw new Error("Please choose a folder inside your device storage, not its root.");
	}
	return picked.path;
}

// Without normalizePath: it would remove a leading "/", and the path must
// remain as choose() returned it (see the section comment above).
function joinDevicePath(folder: string, name: string): string {
	return folder.replace(/\/+$/, "") + "/" + name;
}

// "a.csv" + 2 → "a (2).csv"; no extension: "a" + 2 → "a (2)".
export function withNumericSuffix(name: string, n: number): string {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

// true/false, or null when the file layer offers no way of knowing (never
// confuse "unknown" with "doesn't exist").
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

// Writes into a device folder chosen via pickDeviceFolder(). Unlike
// writeExportFile (which overwrites, in a vault folder that the user manages), we
// NEVER overwrite here: any device folder (Documents, Downloads…) may contain a
// file of the same name that isn't ours — we number it ("a (2).csv") instead.
// Finally checks that the file does exist where we expect it: if the write
// "succeeded" without landing there, we say so instead of announcing a save that
// didn't take place.
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

// Last device folder used successfully, per device: lets the export window
// (Android) offer a "Save to <folder>" in a single gesture, without reopening
// the native picker each time. null = none.
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

// Readable form of a device path, for a button or a message: removes the main
// storage prefix ("/storage/emulated/0/Documents/Decks" → "Documents/Decks").
// A path relative to the storage root, or located on another volume, is left
// as is — the real path itself is never modified (it remains the one choose()
// returned, see above).
export function deviceFolderDisplayPath(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	const stripped = trimmed.replace(/^\/(?:storage\/emulated\/\d+|sdcard)\//, "");
	return stripped === "" ? trimmed : stripped;
}

// Failure message for a write into an ALREADY remembered folder: if the folder
// no longer exists (deleted, moved, SD card removed), say so plainly rather
// than displaying the raw native error. Called AFTER the failure, never before
// the write: a false "doesn't exist" from the file layer must not be able to
// block a write that would have succeeded.
export async function describeDeviceFolderError(app: App, folder: string, error: unknown): Promise<string> {
	const message = String((error as { message?: unknown } | null)?.message ?? error);
	const fs = getVaultFs(app);
	if (fs) {
		try {
			if ((await probeDevicePath(fs, folder)) === false) {
				return `The folder “${deviceFolderDisplayPath(folder)}” doesn't exist anymore. Pick another one.`;
			}
		} catch {
			/* keep the original message */
		}
	}
	return message;
}

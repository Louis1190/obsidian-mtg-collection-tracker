import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { App } from "obsidian";

// vault-export.ts n'importe que normalizePath depuis "obsidian" — même
// contrainte que scryfall.test.ts : le paquet npm "obsidian" ne fournit que
// des types, pas d'implémentation runtime. Reproduit les deux
// comportements réels utiles ici : collapse des "/" multiples et retrait des
// "/" de début/fin.
vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/[\\/]+/g, "/").replace(/^\/+|\/+$/g, ""),
}));

import {
	DEFAULT_EXPORT_FOLDER,
	sanitizeFileName,
	sanitizeFolderPath,
	joinVaultPath,
	folderDisplayName,
	folderSentenceName,
	ensureFolder,
	exportTargetExists,
	writeExportFile,
	shareVaultFile,
	getLastExportFolder,
	rememberExportFolder,
	withNumericSuffix,
	getDeviceFolderSupport,
	pickDeviceFolder,
	writeToDeviceFolder,
	getLastDeviceFolder,
	rememberDeviceFolder,
	deviceFolderDisplayPath,
	describeDeviceFolderError,
} from "./vault-export";

function makeApp(opts: { withOpen?: boolean } = {}) {
	const existing = new Set<string>();
	const adapter = {
		exists: vi.fn(async (p: string) => existing.has(p)),
		mkdir: vi.fn(async (p: string) => {
			existing.add(p);
		}),
		write: vi.fn().mockResolvedValue(undefined),
		writeBinary: vi.fn().mockResolvedValue(undefined),
	};
	const openWithDefaultApp = vi.fn().mockResolvedValue(undefined);
	const app = {
		vault: { adapter },
		...(opts.withOpen === false ? {} : { openWithDefaultApp }),
	};
	return { app: app as unknown as App, adapter, existing, openWithDefaultApp };
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("sanitizeFileName", () => {
	it("replaces characters that would break the path with '-'", () => {
		expect(sanitizeFileName("my/list: v2?.csv")).toBe("my-list- v2-.csv");
	});

	it("trims, and falls back when nothing usable is left", () => {
		expect(sanitizeFileName("  a.csv  ")).toBe("a.csv");
		expect(sanitizeFileName("")).toBe("export");
		expect(sanitizeFileName("   ")).toBe("export");
		expect(sanitizeFileName("..")).toBe("export");
		expect(sanitizeFileName("", "")).toBe("");
	});
});

describe("sanitizeFolderPath", () => {
	it("normalizes a typed path, including nested ones and stray slashes", () => {
		expect(sanitizeFolderPath("Decks")).toBe("Decks");
		expect(sanitizeFolderPath("/Decks//Exports/")).toBe("Decks/Exports");
		expect(sanitizeFolderPath("  Decks \\ Exports ")).toBe("Decks/Exports");
	});

	it("rejects anything that could leave the vault or land in a hidden folder", () => {
		expect(sanitizeFolderPath("..")).toBeNull();
		expect(sanitizeFolderPath("a/../b")).toBeNull();
		expect(sanitizeFolderPath(".obsidian")).toBeNull();
		expect(sanitizeFolderPath("a/.hidden")).toBeNull();
		expect(sanitizeFolderPath("a:b")).toBeNull();
		expect(sanitizeFolderPath("a?b")).toBeNull();
	});

	it("rejects an empty path", () => {
		expect(sanitizeFolderPath("")).toBeNull();
		expect(sanitizeFolderPath(" / / ")).toBeNull();
	});
});

describe("joinVaultPath / folderDisplayName", () => {
	it("joins a normal folder and a file name", () => {
		expect(joinVaultPath("Decks/Exports", "a.csv")).toBe("Decks/Exports/a.csv");
	});

	it("never produces a leading slash for the vault root", () => {
		expect(joinVaultPath("/", "a.csv")).toBe("a.csv");
		expect(joinVaultPath("", "a.csv")).toBe("a.csv");
	});

	it("names the root in plain words", () => {
		expect(folderDisplayName("/")).toBe("Vault root");
		expect(folderDisplayName("")).toBe("Vault root");
		expect(folderDisplayName("Decks")).toBe("Decks");
	});

	it("has a sentence form too, so a message never reads 'to Vault root'", () => {
		expect(folderSentenceName("/")).toBe("the vault root");
		expect(folderSentenceName("")).toBe("the vault root");
		expect(folderSentenceName("Decks/Exports")).toBe("Decks/Exports");
	});
});

describe("ensureFolder", () => {
	it("creates a single-level folder that does not exist yet", async () => {
		const { app, adapter } = makeApp();

		await ensureFolder(app, DEFAULT_EXPORT_FOLDER);

		expect(adapter.exists).toHaveBeenCalledWith(DEFAULT_EXPORT_FOLDER);
		expect(adapter.mkdir).toHaveBeenCalledWith(DEFAULT_EXPORT_FOLDER);
	});

	it("creates each level of a nested folder in order, skipping the ones that exist", async () => {
		const { app, adapter, existing } = makeApp();
		existing.add("Decks");

		await ensureFolder(app, "Decks/Exports/2026");

		expect(adapter.mkdir.mock.calls.map((c) => c[0])).toEqual(["Decks/Exports", "Decks/Exports/2026"]);
	});

	it("does nothing for the vault root or an existing folder", async () => {
		const { app, adapter, existing } = makeApp();
		existing.add("Decks");

		await ensureFolder(app, "/");
		await ensureFolder(app, "Decks");

		expect(adapter.mkdir).not.toHaveBeenCalled();
	});

	it("keeps going when mkdir throws because the folder was created concurrently", async () => {
		const { app, adapter } = makeApp();
		adapter.mkdir.mockRejectedValue(new Error("Folder already exists."));

		await expect(ensureFolder(app, "Decks/Exports")).resolves.toBeUndefined();
		expect(adapter.mkdir).toHaveBeenCalledTimes(2);
	});
});

describe("writeExportFile", () => {
	it("writes text into the chosen folder, creating it, and returns the vault path", async () => {
		const { app, adapter } = makeApp();

		const path = await writeExportFile(app, "Decks", "mtg-deck.txt", "3 - Lightning Bolt");

		expect(path).toBe("Decks/mtg-deck.txt");
		expect(adapter.mkdir).toHaveBeenCalledWith("Decks");
		expect(adapter.write).toHaveBeenCalledWith("Decks/mtg-deck.txt", "3 - Lightning Bolt");
	});

	it("writes binary content (zip) with writeBinary, not write", async () => {
		const { app, adapter } = makeApp();
		const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer;

		const path = await writeExportFile(app, "Decks", "lists.zip", bytes);

		expect(path).toBe("Decks/lists.zip");
		expect(adapter.writeBinary).toHaveBeenCalledWith("Decks/lists.zip", bytes);
		expect(adapter.write).not.toHaveBeenCalled();
	});

	it("writes at the vault root without a leading slash", async () => {
		const { app, adapter } = makeApp();

		const path = await writeExportFile(app, "/", "a.csv", "x");

		expect(path).toBe("a.csv");
		expect(adapter.write).toHaveBeenCalledWith("a.csv", "x");
		expect(adapter.mkdir).not.toHaveBeenCalled();
	});

	it("overwrites a file of the same name instead of failing", async () => {
		const { app, adapter, existing } = makeApp();
		existing.add("Decks");
		existing.add("Decks/a.csv");

		await writeExportFile(app, "Decks", "a.csv", "second");

		expect(adapter.write).toHaveBeenCalledWith("Decks/a.csv", "second");
	});

	it("sanitizes the file name it is given", async () => {
		const { app, adapter } = makeApp();

		const path = await writeExportFile(app, "Decks", "my/list: v2?.csv", "x");

		expect(path).toBe("Decks/my-list- v2-.csv");
		expect(adapter.write).toHaveBeenCalledWith("Decks/my-list- v2-.csv", "x");
	});

	it("propagates a write failure to the caller (the dialog shows it)", async () => {
		const { app, adapter } = makeApp();
		adapter.write.mockRejectedValue(new Error("disk full"));

		await expect(writeExportFile(app, "Decks", "a.csv", "x")).rejects.toThrow("disk full");
	});
});

describe("exportTargetExists", () => {
	it("checks the exact target path", async () => {
		const { app, existing } = makeApp();
		existing.add("Decks/a.csv");

		await expect(exportTargetExists(app, "Decks", "a.csv")).resolves.toBe(true);
		await expect(exportTargetExists(app, "Decks", "b.csv")).resolves.toBe(false);
		await expect(exportTargetExists(app, "Other", "a.csv")).resolves.toBe(false);
	});
});

describe("shareVaultFile", () => {
	it("opens the native share sheet as a method of app (it reads this.vault)", async () => {
		const { app, openWithDefaultApp } = makeApp();

		await shareVaultFile(app, "Decks/a.csv");

		expect(openWithDefaultApp).toHaveBeenCalledWith("Decks/a.csv");
		expect(openWithDefaultApp.mock.contexts[0]).toBe(app);
	});

	it("does nothing, without throwing, when openWithDefaultApp does not exist", async () => {
		const { app } = makeApp({ withOpen: false });

		await expect(shareVaultFile(app, "a.csv")).resolves.toBeUndefined();
	});

	it("swallows an unexpected rejection", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const { app, openWithDefaultApp } = makeApp();
		openWithDefaultApp.mockRejectedValue(new Error("native failure"));

		await expect(shareVaultFile(app, "a.csv")).resolves.toBeUndefined();
		expect(consoleError).toHaveBeenCalled();
	});
});

describe("last export folder (per device, localStorage)", () => {
	let store: Record<string, string>;
	beforeEach(() => {
		store = {};
		vi.stubGlobal("localStorage", {
			getItem: (k: string) => (k in store ? store[k] : null),
			setItem: (k: string, v: string) => {
				store[k] = v;
			},
		});
	});

	it("defaults to the export folder until one has been remembered", () => {
		expect(getLastExportFolder()).toBe(DEFAULT_EXPORT_FOLDER);
	});

	it("remembers the last chosen folder, including the vault root", () => {
		rememberExportFolder("Decks/Exports");
		expect(getLastExportFolder()).toBe("Decks/Exports");
		rememberExportFolder("/");
		expect(getLastExportFolder()).toBe("/");
	});

	it("falls back to the default when storage throws (blocked site data)", () => {
		vi.stubGlobal("localStorage", {
			getItem: () => {
				throw new Error("SecurityError");
			},
			setItem: () => {
				throw new Error("SecurityError");
			},
		});

		expect(getLastExportFolder()).toBe(DEFAULT_EXPORT_FOLDER);
		expect(() => rememberExportFolder("Decks")).not.toThrow();
	});

	it("falls back to the default when localStorage does not exist at all", () => {
		vi.stubGlobal("localStorage", undefined);
		expect(getLastExportFolder()).toBe(DEFAULT_EXPORT_FOLDER);
		expect(() => rememberExportFolder("Decks")).not.toThrow();
	});
});

// --- Dossier de l'appareil (Android) -----------------------------------------

function makeDeviceApp(opts: { dir?: string | null; files?: string[]; noFs?: boolean; writeAddsFile?: boolean } = {}) {
	const files = new Set(opts.files ?? []);
	const fs = {
		dir: opts.dir,
		exists: vi.fn(async (p: string) => files.has(p)),
		write: vi.fn(async (p: string) => {
			if (opts.writeAddsFile !== false) files.add(p);
		}),
		writeBinary: vi.fn(async (p: string) => {
			if (opts.writeAddsFile !== false) files.add(p);
		}),
	};
	const app = { vault: { adapter: opts.noFs ? {} : { fs } } } as unknown as App;
	return { app, fs, files };
}

describe("withNumericSuffix", () => {
	it("inserts the number before the extension", () => {
		expect(withNumericSuffix("a.csv", 2)).toBe("a (2).csv");
		expect(withNumericSuffix("my.list.csv", 3)).toBe("my.list (3).csv");
	});

	it("appends it when there is no extension (or only a leading dot)", () => {
		expect(withNumericSuffix("notes", 2)).toBe("notes (2)");
		expect(withNumericSuffix(".hidden", 2)).toBe(".hidden (2)");
	});
});

describe("getDeviceFolderSupport", () => {
	it("is available for a vault on shared device storage (or with absolute paths)", () => {
		expect(getDeviceFolderSupport(makeDeviceApp({ dir: "EXTERNAL_STORAGE" }).app)).toEqual({ ok: true });
		expect(getDeviceFolderSupport(makeDeviceApp({ dir: undefined }).app)).toEqual({ ok: true });
		expect(getDeviceFolderSupport(makeDeviceApp({ dir: null }).app)).toEqual({ ok: true });
		expect(getDeviceFolderSupport(makeDeviceApp({ dir: "" }).app)).toEqual({ ok: true });
	});

	it("is refused, with a reason, for a vault in Obsidian's private app storage", () => {
		for (const dir of ["DOCUMENTS", "DATA", "EXTERNAL", "LIBRARY", "CACHE", "ICLOUD"]) {
			const support = getDeviceFolderSupport(makeDeviceApp({ dir }).app);
			expect(support.ok).toBe(false);
			if (!support.ok) expect(support.reason).toContain("private app storage");
		}
	});

	it("is refused when the adapter exposes no file layer at all", () => {
		const support = getDeviceFolderSupport(makeDeviceApp({ noFs: true }).app);
		expect(support.ok).toBe(false);
	});
});

describe("pickDeviceFolder", () => {
	function stubCapacitor(choose: (() => Promise<unknown>) | undefined) {
		vi.stubGlobal("Capacitor", { Plugins: { Filesystem: choose ? { choose } : {} } });
	}

	it("returns the path chosen in the native picker", async () => {
		stubCapacitor(async () => ({ path: "Documents/Decks", isRoot: false }));
		await expect(pickDeviceFolder()).resolves.toBe("Documents/Decks");
	});

	it("returns null when the user cancels, whatever shape the rejection has", async () => {
		stubCapacitor(() => Promise.reject(new Error("User canceled folder picker")));
		await expect(pickDeviceFolder()).resolves.toBeNull();
		stubCapacitor(() => Promise.reject({ message: "canceled" }));
		await expect(pickDeviceFolder()).resolves.toBeNull();
	});

	it("re-throws any other native error so it can be shown", async () => {
		stubCapacitor(() => Promise.reject(new Error("Permission denied")));
		await expect(pickDeviceFolder()).rejects.toThrow("Permission denied");
	});

	it("refuses the root of the device storage, like Obsidian does for a vault", async () => {
		stubCapacitor(async () => ({ path: "", isRoot: true }));
		await expect(pickDeviceFolder()).rejects.toThrow("not its root");
	});

	it("treats an empty answer as a cancel", async () => {
		stubCapacitor(async () => undefined);
		await expect(pickDeviceFolder()).resolves.toBeNull();
		stubCapacitor(async () => ({}));
		await expect(pickDeviceFolder()).resolves.toBeNull();
	});

	it("explains itself when there is no native picker at all", async () => {
		stubCapacitor(undefined);
		await expect(pickDeviceFolder()).rejects.toThrow("not available");
		vi.stubGlobal("Capacitor", undefined);
		await expect(pickDeviceFolder()).rejects.toThrow("not available");
	});
});

describe("writeToDeviceFolder", () => {
	it("writes into a folder given relative to the storage root", async () => {
		const { app, fs } = makeDeviceApp({ dir: "EXTERNAL_STORAGE" });

		const result = await writeToDeviceFolder(app, "Download/Decks", "a.csv", "x,y");

		expect(result).toEqual({ path: "Download/Decks/a.csv", name: "a.csv" });
		expect(fs.write).toHaveBeenCalledWith("Download/Decks/a.csv", "x,y");
	});

	it("keeps an absolute folder absolute (no normalizePath: it would drop the leading slash)", async () => {
		const { app, fs } = makeDeviceApp();

		const result = await writeToDeviceFolder(app, "/storage/emulated/0/Documents/", "a.csv", "x");

		expect(result.path).toBe("/storage/emulated/0/Documents/a.csv");
		expect(fs.write).toHaveBeenCalledWith("/storage/emulated/0/Documents/a.csv", "x");
	});

	it("never overwrites: numbers the file instead", async () => {
		const { app, fs } = makeDeviceApp({ files: ["Docs/a.csv", "Docs/a (2).csv"] });

		const result = await writeToDeviceFolder(app, "Docs", "a.csv", "new");

		expect(result).toEqual({ path: "Docs/a (3).csv", name: "a (3).csv" });
		expect(fs.write).toHaveBeenCalledTimes(1);
		expect(fs.write).toHaveBeenCalledWith("Docs/a (3).csv", "new");
	});

	it("gives up cleanly when a hundred files already carry the name", async () => {
		const { app, fs } = makeDeviceApp();
		fs.exists.mockResolvedValue(true);

		await expect(writeToDeviceFolder(app, "Docs", "a.csv", "x")).rejects.toThrow("too many files");
		expect(fs.write).not.toHaveBeenCalled();
	});

	it("writes binary content (zip) with writeBinary", async () => {
		const { app, fs } = makeDeviceApp();
		const bytes = new Uint8Array([0x50, 0x4b, 3, 4]).buffer;

		const result = await writeToDeviceFolder(app, "Docs", "lists.zip", bytes);

		expect(result.path).toBe("Docs/lists.zip");
		expect(fs.writeBinary).toHaveBeenCalledWith("Docs/lists.zip", bytes);
		expect(fs.write).not.toHaveBeenCalled();
	});

	it("sanitizes the file name", async () => {
		const { app, fs } = makeDeviceApp();

		const result = await writeToDeviceFolder(app, "Docs", "my/list: v2?.csv", "x");

		expect(result.name).toBe("my-list- v2-.csv");
		expect(fs.write).toHaveBeenCalledWith("Docs/my-list- v2-.csv", "x");
	});

	it("says so when the write 'succeeded' but the file is not where it should be", async () => {
		const { app } = makeDeviceApp({ writeAddsFile: false });

		await expect(writeToDeviceFolder(app, "Docs", "a.csv", "x")).rejects.toThrow("wasn't found in that folder");
	});

	it("propagates a native write failure", async () => {
		const { app, fs } = makeDeviceApp();
		fs.write.mockRejectedValue(new Error("EACCES: permission denied"));

		await expect(writeToDeviceFolder(app, "Docs", "a.csv", "x")).rejects.toThrow("EACCES");
	});

	it("refuses when the adapter exposes no file layer", async () => {
		const { app } = makeDeviceApp({ noFs: true });

		await expect(writeToDeviceFolder(app, "Docs", "a.csv", "x")).rejects.toThrow("doesn't let plugins");
	});
});

// --- Dossier de l'appareil mémorisé (Android) --------------------------------

describe("last device folder (per device, localStorage)", () => {
	let store: Record<string, string>;
	beforeEach(() => {
		store = {};
		vi.stubGlobal("localStorage", {
			getItem: (k: string) => (k in store ? store[k] : null),
			setItem: (k: string, v: string) => {
				store[k] = v;
			},
		});
	});

	it("is null until a device folder has been remembered", () => {
		expect(getLastDeviceFolder()).toBeNull();
	});

	it("remembers the last folder exactly as the picker returned it", () => {
		rememberDeviceFolder("/storage/emulated/0/Documents/Decks");
		expect(getLastDeviceFolder()).toBe("/storage/emulated/0/Documents/Decks");
		rememberDeviceFolder("Documents");
		expect(getLastDeviceFolder()).toBe("Documents");
	});

	it("is independent of the remembered VAULT folder", () => {
		rememberExportFolder("Decks");
		expect(getLastDeviceFolder()).toBeNull();
		rememberDeviceFolder("Documents");
		expect(getLastExportFolder()).toBe("Decks");
	});

	it("never remembers an empty folder (it would read back as a root write)", () => {
		rememberDeviceFolder("");
		rememberDeviceFolder("   ");
		// Vérifie ce qui est ÉCRIT, pas seulement ce que getLastDeviceFolder()
		// relit : la lecture refuse déjà une valeur vide, elle masquerait un
		// garde-fou d'écriture retiré.
		expect(Object.keys(store)).toEqual([]);
		expect(getLastDeviceFolder()).toBeNull();
	});

	it("still refuses an empty stored value when reading (a value written by another version)", () => {
		store["mtg-collection-tracker:export-device-folder"] = "";
		expect(getLastDeviceFolder()).toBeNull();
		store["mtg-collection-tracker:export-device-folder"] = "   ";
		expect(getLastDeviceFolder()).toBeNull();
	});

	it("degrades to 'nothing remembered' when storage throws or does not exist", () => {
		vi.stubGlobal("localStorage", {
			getItem: () => {
				throw new Error("SecurityError");
			},
			setItem: () => {
				throw new Error("SecurityError");
			},
		});
		expect(getLastDeviceFolder()).toBeNull();
		expect(() => rememberDeviceFolder("Documents")).not.toThrow();
		vi.stubGlobal("localStorage", undefined);
		expect(getLastDeviceFolder()).toBeNull();
	});
});

describe("deviceFolderDisplayPath", () => {
	it("drops the primary-storage prefix", () => {
		expect(deviceFolderDisplayPath("/storage/emulated/0/Documents/Decks")).toBe("Documents/Decks");
		expect(deviceFolderDisplayPath("/storage/emulated/10/Download")).toBe("Download");
		expect(deviceFolderDisplayPath("/sdcard/Documents")).toBe("Documents");
	});

	it("leaves relative paths and other volumes alone, minus trailing slashes", () => {
		expect(deviceFolderDisplayPath("Documents/Decks")).toBe("Documents/Decks");
		expect(deviceFolderDisplayPath("Documents/")).toBe("Documents");
		expect(deviceFolderDisplayPath("/storage/1234-5678/Docs")).toBe("/storage/1234-5678/Docs");
	});

	it("does not reduce a bare storage root to nothing", () => {
		expect(deviceFolderDisplayPath("/storage/emulated/0")).toBe("/storage/emulated/0");
		expect(deviceFolderDisplayPath("/storage/emulated/0/")).toBe("/storage/emulated/0");
	});
});

describe("describeDeviceFolderError", () => {
	it("says so plainly when the remembered folder no longer exists", async () => {
		const { app } = makeDeviceApp({ files: [] });

		const message = await describeDeviceFolderError(app, "/storage/emulated/0/Documents/Gone", new Error("ENOENT"));

		expect(message).toBe("The folder “Documents/Gone” doesn't exist anymore. Pick another one.");
	});

	it("keeps the native message when the folder is still there", async () => {
		const { app } = makeDeviceApp({ files: ["Documents"] });

		await expect(describeDeviceFolderError(app, "Documents", new Error("EACCES: permission denied"))).resolves.toBe(
			"EACCES: permission denied"
		);
	});

	it("never claims a folder is gone when the file layer cannot tell", async () => {
		const app = { vault: { adapter: { fs: { write: vi.fn() } } } } as unknown as App;

		await expect(describeDeviceFolderError(app, "Documents", new Error("boom"))).resolves.toBe("boom");
	});

	it("keeps the original message when the existence probe itself throws", async () => {
		const { app, fs } = makeDeviceApp();
		fs.exists.mockRejectedValue(new Error("probe failed"));

		await expect(describeDeviceFolderError(app, "Documents", new Error("EACCES"))).resolves.toBe("EACCES");
	});

	it("copes with a non-Error rejection", async () => {
		const { app } = makeDeviceApp({ files: ["Documents"] });

		await expect(describeDeviceFolderError(app, "Documents", { message: "native failure" })).resolves.toBe("native failure");
		await expect(describeDeviceFolderError(app, "Documents", "plain string")).resolves.toBe("plain string");
	});
});

describe("device folder — empty path guards", () => {
	it("pickDeviceFolder treats an empty path like the root", async () => {
		vi.stubGlobal("Capacitor", { Plugins: { Filesystem: { choose: async () => ({ path: "", isRoot: false }) } } });

		await expect(pickDeviceFolder()).rejects.toThrow("not its root");
	});

	it("writeToDeviceFolder refuses an empty folder instead of writing to '/name'", async () => {
		const { app, fs } = makeDeviceApp();

		await expect(writeToDeviceFolder(app, "", "a.csv", "x")).rejects.toThrow("No folder was chosen");
		await expect(writeToDeviceFolder(app, "   ", "a.csv", "x")).rejects.toThrow("No folder was chosen");
		expect(fs.write).not.toHaveBeenCalled();
	});
});

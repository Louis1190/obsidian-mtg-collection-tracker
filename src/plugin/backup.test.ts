import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
	class TFile {
		constructor(public path: string, public stat: { mtime: number; size: number }) {}
		get name() {
			return this.path.split("/").pop()!;
		}
	}
	class TFolder {
		children: unknown[] = [];
		constructor(public path: string) {}
	}
	return { TFile, TFolder, normalizePath: (p: string) => p.replace(/[\\/]+/g, "/").replace(/^\/|\/$/g, "") };
});

import { TFile, TFolder } from "obsidian";
import { backupFolderPath, exportBackup, listBackupFiles, parseBackupFile, pruneAutoBackups, readBackupFile, restoreBackup, runAutoBackup } from "./backup";
import type MTGCollectionPlugin from "../plugin";

// The real Obsidian classes have no usable constructor here: we build those of the mock above.
const makeFile = (path: string, stat: { mtime: number; size: number }) => new (TFile as unknown as new (p: string, s: unknown) => TFile)(path, stat);
const makeFolder = (path: string) => new (TFolder as unknown as new (p: string) => TFolder)(path);

// A fake vault: a backups folder with two files and a subfolder, and the reading of a file.
function fakePlugin(folderSetting: string, entries: Record<string, unknown>) {
	const folder = makeFolder("MTG Backups");
	folder.children = [
		makeFile("MTG Backups/mtg-collection-backup-auto-2026-10-05.json", { mtime: 5, size: 111 }),
		makeFile("MTG Backups/notes.txt", { mtime: 1, size: 3 }),
		makeFolder("MTG Backups/old"),
	];
	const read = vi.fn(async (file: TFile) => `content of ${file.path}`);
	const plugin = {
		settings: { autoBackupFolder: folderSetting },
		app: { vault: { getAbstractFileByPath: (path: string) => (path === "MTG Backups" ? folder : entries[path] ?? null), read } },
	};
	return { plugin: plugin as unknown as MTGCollectionPlugin, read };
}

describe("backupFolderPath", () => {
	it("uses the setting, normalised, and falls back to the default name when it is blank", () => {
		expect(backupFolderPath({ settings: { autoBackupFolder: " Sauvegardes//MTG/ " } } as MTGCollectionPlugin)).toBe("Sauvegardes/MTG");
		expect(backupFolderPath({ settings: { autoBackupFolder: "   " } } as MTGCollectionPlugin)).toBe("MTG Backups");
	});
});

describe("listBackupFiles", () => {
	it("returns the files of the backup folder (not its sub-folders) with their name, date and size", () => {
		const { plugin } = fakePlugin("MTG Backups", {});
		expect(listBackupFiles.call(plugin)).toEqual([
			{ path: "MTG Backups/mtg-collection-backup-auto-2026-10-05.json", name: "mtg-collection-backup-auto-2026-10-05.json", mtime: 5, size: 111 },
			{ path: "MTG Backups/notes.txt", name: "notes.txt", mtime: 1, size: 3 },
		]);
	});

	it("is empty, not an error, when the folder does not exist (yet)", () => {
		const { plugin } = fakePlugin("Elsewhere", {});
		expect(listBackupFiles.call(plugin)).toEqual([]);
	});
});

describe("readBackupFile", () => {
	it("reads the file through the Vault API", async () => {
		const file = makeFile("MTG Backups/b.json", { mtime: 1, size: 1 });
		const { plugin, read } = fakePlugin("MTG Backups", { "MTG Backups/b.json": file });
		await expect(readBackupFile.call(plugin, "MTG Backups/b.json")).resolves.toBe("content of MTG Backups/b.json");
		expect(read).toHaveBeenCalledTimes(1);
	});

	it("says so when the file is gone (deleted between the list and the click)", async () => {
		const { plugin } = fakePlugin("MTG Backups", {});
		await expect(readBackupFile.call(plugin, "MTG Backups/gone.json")).rejects.toThrow("no longer exists");
	});
});

describe("restoreBackup and the value history", () => {
	const point = (day: string, usd: number, dateModified = 1000) => ({ day, usd, eur: usd, cards: 5, dateModified });

	function restoring(current: unknown) {
		const plugin = {
			settings: { cardbaseApiKey: "key", valueHistory: current },
			runSettingsMigrations: vi.fn(async () => {}),
			saveSettings: vi.fn(async () => {}),
			refreshAccentColor: vi.fn(),
			refreshCollectionRibbonIcon: vi.fn(),
			refreshOpenViews: vi.fn(),
		};
		return plugin as unknown as MTGCollectionPlugin & { settings: { valueHistory?: unknown } };
	}

	it("does not rewind the curve: what was recorded since the backup stays, the backup's older days are added", async () => {
		const plugin = restoring([point("2026-11-20", 20), point("2026-11-21", 21)]);
		await restoreBackup.call(plugin, { collection: [], valueHistory: [point("2026-11-10", 10), point("2026-11-20", 99, 1)] } as never);
		const days = (plugin.settings.valueHistory as { day: string; usd: number }[]).map((p) => [p.day, p.usd]);
		expect(days).toEqual([
			["2026-11-10", 10],
			["2026-11-20", 20],
			["2026-11-21", 21],
		]);
	});

	it("keeps the current history when the backup predates it", async () => {
		const plugin = restoring([point("2026-11-20", 20)]);
		await restoreBackup.call(plugin, { collection: [] } as never);
		expect(plugin.settings.valueHistory).toHaveLength(1);
	});

	it("takes the backup's history when there is none yet, and leaves none when neither has any", async () => {
		const fresh = restoring(undefined);
		await restoreBackup.call(fresh, { valueHistory: [point("2026-11-10", 10)] } as never);
		expect(fresh.settings.valueHistory).toHaveLength(1);
		const none = restoring(undefined);
		await restoreBackup.call(none, {} as never);
		expect("valueHistory" in none.settings).toBe(false);
	});

	it("does not trust a history of the file: junk is dropped", async () => {
		const plugin = restoring(undefined);
		await restoreBackup.call(plugin, { valueHistory: [null, { day: "nope" }, point("2026-11-10", 10)] } as never);
		expect(plugin.settings.valueHistory).toHaveLength(1);
	});
});

describe("the layout of a backup file", () => {
	// Two cards with accents and a quote, so that the layout is compared on something that has to be escaped.
	const settings = {
		collection: [{ id: "a", name: "Séance \"Éclair\"", count: 2 }, { id: "b", name: "Mox Ruby", count: 1 }],
		lists: [{ id: "l1", name: "Main" }],
		decks: [],
		wantlist: [],
		wantlists: [],
		cardbaseApiKey: "never-in-the-file",
		autoBackupFolder: "MTG Backups",
		autoBackupKeepCount: 7,
	};

	function fakeBackupPlugin() {
		const written = new Map<string, string>();
		const vault = {
			getAbstractFileByPath: (path: string) => (path === "MTG Backups" ? makeFolder("MTG Backups") : written.has(path) ? makeFile(path, { mtime: 1, size: 1 }) : null),
			createFolder: vi.fn(async () => {}),
			create: vi.fn(async (path: string, content: string) => void written.set(path, content)),
			modify: vi.fn(async (file: { path: string }, content: string) => void written.set(file.path, content)),
		};
		const plugin = {
			settings: { ...settings, lastAutoBackup: 0 },
			manifest: { version: "9.9.9" },
			app: { vault, fileManager: { trashFile: vi.fn() } },
			saveSettings: vi.fn(async () => {}),
			exportBackup,
			pruneAutoBackups,
		};
		return { plugin: plugin as unknown as MTGCollectionPlugin, written };
	}

	it("the manual export stays indented (a person may open it), the key is left out", () => {
		const { plugin } = fakeBackupPlugin();
		const text = exportBackup.call(plugin);
		expect(text).toMatch(/\n {2}"format"/);
		expect(text).not.toContain("never-in-the-file");
	});

	it("an automatic backup is written compact: one line, the same content", async () => {
		const { plugin, written } = fakeBackupPlugin();
		const manual = JSON.parse(exportBackup.call(plugin)); // before the run: it records lastAutoBackup afterwards
		const result = await runAutoBackup.call(plugin);
		expect("path" in result).toBe(true);
		const [[path, text]] = [...written];
		expect(path).toMatch(/^MTG Backups\/mtg-collection-backup-auto-\d{4}-\d{2}-\d{2}\.json$/);
		expect(text).not.toMatch(/\n/);
		expect(text).toBe(JSON.stringify(JSON.parse(text))); // not one space outside a string
		expect(text).not.toContain("never-in-the-file");
		const auto = JSON.parse(text);
		expect({ ...auto, exportedAt: 0 }).toEqual({ ...manual, exportedAt: 0 }); // only the layout differs
	});

	it("restoring reads both layouts and gives the same summary and settings", () => {
		const { plugin } = fakeBackupPlugin();
		const indented = parseBackupFile.call(plugin, exportBackup.call(plugin));
		const compact = parseBackupFile.call(plugin, exportBackup.call(plugin, true));
		expect("error" in indented).toBe(false);
		expect("error" in compact).toBe(false);
		if ("error" in indented || "error" in compact) return;
		expect(compact.summary.cards).toBe(2);
		expect({ ...compact.summary, exportedAt: 0 }).toEqual({ ...indented.summary, exportedAt: 0 });
		expect(compact.settings).toEqual(indented.settings);
	});

	it("a compact backup is smaller than the indented one for the same content", () => {
		const { plugin } = fakeBackupPlugin();
		expect(exportBackup.call(plugin, true).length).toBeLessThan(exportBackup.call(plugin).length);
	});
});

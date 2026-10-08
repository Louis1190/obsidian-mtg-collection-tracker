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
import { backupFolderPath, listBackupFiles, readBackupFile } from "./backup";
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

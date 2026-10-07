import { describe, expect, it } from "vitest";
import { backupDate, backupKind, BackupFileInfo, formatFileSize, isBackupFileName, listBackups } from "./backup-files";

const file = (name: string, mtime = 0, size = 1000): BackupFileInfo => ({ path: "MTG Backups/" + name, name, mtime, size });

describe("isBackupFileName / backupKind", () => {
	it("recognises the automatic backups and the manual exports, nothing else", () => {
		expect(isBackupFileName("mtg-collection-backup-auto-2026-10-05.json")).toBe(true);
		expect(isBackupFileName("mtg-collection-backup-2026-10-05.json")).toBe(true);
		expect(isBackupFileName("mtg-collection-backup-2026-10-05.JSON")).toBe(true);
		expect(isBackupFileName("notes.json")).toBe(false);
		expect(isBackupFileName("mtg-collection-backup-2026-10-05.json.sync-conflict")).toBe(false);
		expect(isBackupFileName("mtg-collection-backup-2026-10-05.txt")).toBe(false);
		expect(isBackupFileName("my-mtg-collection-backup-2026-10-05.json")).toBe(false);
	});

	it("tells an automatic backup from a manual export", () => {
		expect(backupKind("mtg-collection-backup-auto-2026-10-05.json")).toBe("automatic");
		expect(backupKind("mtg-collection-backup-2026-10-05.json")).toBe("manual");
	});
});

describe("backupDate", () => {
	it("reads the date in the name (a vault sync rewrites mtime, never the name)", () => {
		expect(backupDate(file("mtg-collection-backup-auto-2026-09-28.json", Date.UTC(2030, 0, 1)))).toBe("2026-09-28");
	});

	it("falls back to the modification date when the name has none", () => {
		const local = new Date(2026, 9, 5, 14, 30).getTime();
		expect(backupDate(file("mtg-collection-backup-copy.json", local))).toBe("2026-10-05");
	});
});

describe("listBackups", () => {
	it("keeps only backups and lists the newest first", () => {
		const list = listBackups([
			file("mtg-collection-backup-auto-2026-09-21.json"),
			file("readme.md"),
			file("mtg-collection-backup-auto-2026-10-05.json"),
			file("mtg-collection-backup-2026-09-30.json"),
			file("data.json"),
		]);
		expect(list.map((b) => b.name)).toEqual([
			"mtg-collection-backup-auto-2026-10-05.json",
			"mtg-collection-backup-2026-09-30.json",
			"mtg-collection-backup-auto-2026-09-21.json",
		]);
		expect(list.map((b) => b.kind)).toEqual(["automatic", "manual", "automatic"]);
	});

	it("orders two backups of the same day by modification time, then by name, so the order is stable", () => {
		const list = listBackups([
			file("mtg-collection-backup-2026-10-05.json", 100),
			file("mtg-collection-backup-auto-2026-10-05.json", 200),
			file("mtg-collection-backup-b-2026-10-05.json", 100),
		]);
		expect(list.map((b) => b.name)).toEqual([
			"mtg-collection-backup-auto-2026-10-05.json",
			"mtg-collection-backup-2026-10-05.json",
			"mtg-collection-backup-b-2026-10-05.json",
		]);
	});

	it("is empty when there is nothing to list", () => {
		expect(listBackups([])).toEqual([]);
		expect(listBackups([file("other.json")])).toEqual([]);
	});
});

describe("formatFileSize", () => {
	it("picks a readable unit", () => {
		expect(formatFileSize(512)).toBe("512 B");
		expect(formatFileSize(2048)).toBe("2 KB");
		expect(formatFileSize(6.3 * 1024 * 1024)).toBe("6.3 MB");
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	Notice: class {},
	Platform: {},
	normalizePath: (p: string) => p,
	TFile: class {},
	TFolder: class {},
}));

import { parseBackupFile, BACKUP_FORMAT_MARKER } from "./backup";
import { parseShard } from "./github-sync";
import { parseSettingsText } from "./settings-sync";

// The three doors through which text written elsewhere becomes settings: the data file (another device, Syncthing),
// a shard downloaded from the GitHub repository, and a backup file somebody sent. None may let a "__proto__" key in
// (core/safe-json.ts; the audit of 2026-11-15, docs/history/code-audit-2026-11-15.md).

const BASELINE = new Set(Object.getOwnPropertyNames(Object.prototype));
const polluted = (): string[] => Object.getOwnPropertyNames(Object.prototype).filter((k) => !BASELINE.has(k));
afterEach(() => {
	for (const k of polluted()) delete (Object.prototype as any)[k];
});

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

const hostileTombstones = '"syncTombstones":{"__proto__":{"polluted":123456},"collection":{"gone":42}}';

describe("parseSettingsText (data.json read from disk, and the text of a foreign file)", () => {
	it("returns the settings without the __proto__ key and keeps the real tombstones", () => {
		const s = parseSettingsText(`{"collection":[],${hostileTombstones}}`) as any;
		expect(hasOwn(s.syncTombstones, "__proto__")).toBe(false);
		expect(s.syncTombstones.collection).toEqual({ gone: 42 });
	});

	it("returns null for what is not a settings object", () => {
		expect(parseSettingsText("[]")).toBeNull();
		expect(parseSettingsText("{broken")).toBeNull();
		expect(parseSettingsText("")).toBeNull();
	});

	it("an ordinary file comes back unchanged", () => {
		const text = JSON.stringify({ collection: [{ id: "a", name: "Black Lotus", count: 1 }], priceCurrency: "eur" });
		expect(parseSettingsText(text)).toEqual(JSON.parse(text));
	});
});

describe("parseShard (a file of the GitHub data repository)", () => {
	it("returns the shard without the __proto__ key, at any depth", () => {
		const s = parseShard('{"v":2,"data":{"__proto__":{"polluted":1},"items":[{"__proto__":{"polluted":2},"id":"a"}]}}') as any;
		expect(hasOwn(s.data, "__proto__")).toBe(false);
		expect(hasOwn(s.data.items[0], "__proto__")).toBe(false);
		expect(s.data.items[0].id).toBe("a");
		expect(polluted()).toEqual([]);
	});

	it("returns null for a file that is not a JSON object", () => {
		expect(parseShard("[1]")).toBeNull();
		expect(parseShard("nope")).toBeNull();
	});
});

describe("parseBackupFile (a backup file chosen by the user)", () => {
	const envelope = (settings: string) => `{"format":"${BACKUP_FORMAT_MARKER}","schemaVersion":1,"exportedAt":5,"settings":${settings}}`;

	it("restores nothing hostile: the settings it hands back have no __proto__ key", () => {
		const r = parseBackupFile.call(null as never, envelope(`{"collection":[{"id":"a"}],"lists":[],${hostileTombstones}}`)) as any;
		expect(r.error).toBeUndefined();
		expect(hasOwn(r.settings.syncTombstones, "__proto__")).toBe(false);
		expect(r.summary.cards).toBe(1);
		// What restoreBackup does next with these settings must not be able to reach the prototype either.
		const restored: any = Object.assign({}, { priceCurrency: "usd" }, r.settings);
		expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
		expect(polluted()).toEqual([]);
	});

	it("a hostile key at the top of the settings object cannot swap the restored settings' prototype", () => {
		const r = parseBackupFile.call(null as never, envelope('{"collection":[],"__proto__":{"githubRepo":"attacker/repo"}}')) as any;
		const restored: any = Object.assign({}, { githubRepo: "" }, r.settings);
		expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
		expect(restored.githubRepo).toBe("");
	});

	it("still rejects what is not a backup, and still reads a good one", () => {
		expect((parseBackupFile.call(null as never, "not json") as any).error).toMatch(/valid JSON/);
		expect((parseBackupFile.call(null as never, '{"format":"other","settings":{}}') as any).error).toMatch(/backup file/);
		const ok = parseBackupFile.call(null as never, envelope('{"collection":[{"id":"a"},{"id":"b"}],"lists":[{"id":"l"}]}')) as any;
		expect(ok.summary).toMatchObject({ cards: 2, lists: 1, exportedAt: 5 });
	});
});

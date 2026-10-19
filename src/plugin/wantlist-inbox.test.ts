import { describe, it, expect, vi } from "vitest";

// wantlist-mutations.ts imports api/scryfall.ts, which imports `requestUrl` from
// "obsidian" at module level (a types-only package: no runtime under Node).
vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

import { INBOX_WANTLIST_ID, Wantlist } from "../core/data-model";
import {
	deleteWantlist,
	bulkDeleteWantlists,
	renameWantlist,
	mergeWantlists,
	createWantlistSilent,
	findWantlistDuplicateGroups,
	mergeWantlistDuplicateGroup,
} from "./wantlist-mutations";
import type MTGCollectionPlugin from "../plugin";

// The wantlist Inbox is protected on the plugin side (the UI shows no Delete/Rename for it, these
// guards are the defense in depth: see renderWantlistTile / InboxSettingsModal).

type Row = { id: string; listId: string; scryfallId: string; finish: string; count: number; dateAdded: number; dateModified: number };

function fakePlugin() {
	const wantlists: Wantlist[] = [
		{ id: INBOX_WANTLIST_ID, name: "Inbox", dateCreated: 1, isInbox: true },
		{ id: "w1", name: "Trades", dateCreated: 2 },
		{ id: "w2", name: "Bulk", dateCreated: 3 },
	];
	const row = (id: string, listId: string, scryfallId = id): Row => ({
		id,
		listId,
		scryfallId,
		finish: "regular",
		count: 1,
		dateAdded: 1,
		dateModified: 1,
	});
	const wantlist = [row("c1", INBOX_WANTLIST_ID), row("c2", "w1"), row("c3", "w2")];
	const self = {
		settings: { wantlists, wantlist },
		saveSettings: vi.fn(async () => {}),
	} as unknown as MTGCollectionPlugin & { settings: { wantlists: Wantlist[]; wantlist: Row[] } };
	// the methods the mutations call on `this`
	(self as any).createWantlistSilent = createWantlistSilent;
	(self as any).findWantlistDuplicateGroups = findWantlistDuplicateGroups;
	(self as any).mergeWantlistDuplicateGroup = mergeWantlistDuplicateGroup;
	return self;
}

const ids = (p: ReturnType<typeof fakePlugin>) => p.settings.wantlists.map((w) => w.id);

describe("the wantlist Inbox is protected", () => {
	it("deleteWantlist leaves the Inbox and its cards alone, still deletes a normal wantlist", () => {
		const p = fakePlugin();
		deleteWantlist.call(p, INBOX_WANTLIST_ID);
		expect(ids(p)).toContain(INBOX_WANTLIST_ID);
		expect(p.settings.wantlist.map((c) => c.id)).toContain("c1");
		expect(p.saveSettings).not.toHaveBeenCalled();

		deleteWantlist.call(p, "w1");
		expect(ids(p)).toEqual([INBOX_WANTLIST_ID, "w2"]);
		expect(p.settings.wantlist.map((c) => c.id)).toEqual(["c1", "c3"]);
	});

	it("bulkDeleteWantlists skips the Inbox even when it is in the selection", () => {
		const p = fakePlugin();
		bulkDeleteWantlists.call(p, [INBOX_WANTLIST_ID, "w1"]);
		expect(ids(p)).toEqual([INBOX_WANTLIST_ID, "w2"]);
		expect(p.settings.wantlist.map((c) => c.id)).toEqual(["c1", "c3"]);
	});

	it("renameWantlist refuses to rename the Inbox but renames the others", () => {
		const p = fakePlugin();
		renameWantlist.call(p, INBOX_WANTLIST_ID, "Hacked");
		expect(p.settings.wantlists[0].name).toBe("Inbox");
		renameWantlist.call(p, "w1", "Renamed");
		expect(p.settings.wantlists[1].name).toBe("Renamed");
	});

	it("mergeWantlists never absorbs (and deletes) the Inbox", () => {
		const p = fakePlugin();
		const merged = mergeWantlists.call(p, [INBOX_WANTLIST_ID, "w1", "w2"], "Merged");
		expect(ids(p)).toContain(INBOX_WANTLIST_ID);
		expect(ids(p)).not.toContain("w1");
		expect(ids(p)).not.toContain("w2");
		// the Inbox keeps its card; the two others moved to the new wantlist
		expect(p.settings.wantlist.find((c) => c.id === "c1")?.listId).toBe(INBOX_WANTLIST_ID);
		expect(p.settings.wantlist.filter((c) => c.listId === merged.id).map((c) => c.id).sort()).toEqual(["c2", "c3"]);
	});
});

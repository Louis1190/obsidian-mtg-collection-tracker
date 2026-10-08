import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { App } from "obsidian";

// file-export.ts imports Notice/Platform from "obsidian" at module level, as
// does the modal (which extends Modal) — same constraint as
// scryfall.test.ts: the npm package "obsidian" only provides types, no
// runtime implementation. `platform` is a shared MUTABLE object: each test
// switches isMobileApp itself (the code reads Platform.isMobileApp on every
// call). Each Notice constructed is recorded with its whole message history
// (constructor then setMessage): the code updates a SINGLE Notice in place
// rather than stacking several.
type FakeNotice = { history: string[]; duration: number | undefined; hidden: boolean };
type FakeModalCall = { app: unknown; content: unknown; filename: string; opened: boolean };

const mocks = vi.hoisted(() => ({
	notices: [] as FakeNotice[],
	modals: [] as FakeModalCall[],
	modalOpenThrows: false,
	platform: { isMobileApp: false },
}));

vi.mock("obsidian", () => ({
	Platform: mocks.platform,
	Notice: class {
		record: FakeNotice;
		constructor(message: string, duration?: number) {
			this.record = { history: [message], duration, hidden: false };
			mocks.notices.push(this.record);
		}
		setMessage(message: string) {
			this.record.history.push(message);
			return this;
		}
		hide() {
			this.record.hidden = true;
		}
	},
	normalizePath: (p: string) => p.replace(/[\\/]+/g, "/").replace(/^\/+|\/+$/g, ""),
}));

// The real modal (DOM, Obsidian's Modal) can't be executed under Node: here
// we only test the DECISION of file-export.ts — open it on mobile, fall back
// to direct export if it can't open. The content of the modal itself is
// verified separately (see CLAUDE.md, "File export").
vi.mock("../modals/export-destination-modal", () => ({
	ExportDestinationModal: class {
		call: FakeModalCall;
		constructor(app: unknown, content: unknown, filename: string) {
			this.call = { app, content, filename, opened: false };
			mocks.modals.push(this.call);
		}
		open() {
			if (mocks.modalOpenThrows) throw new Error("modal exploded");
			this.call.opened = true;
		}
	},
}));

import { saveExportedFile } from "./file-export";
import { DEFAULT_EXPORT_FOLDER } from "./vault-export";

function makeApp(opts: { withOpen?: boolean } = {}) {
	const adapter = {
		exists: vi.fn().mockResolvedValue(false),
		mkdir: vi.fn().mockResolvedValue(undefined),
		write: vi.fn().mockResolvedValue(undefined),
		writeBinary: vi.fn().mockResolvedValue(undefined),
	};
	const openWithDefaultApp = vi.fn().mockResolvedValue(undefined);
	const app = {
		vault: { adapter },
		...(opts.withOpen === false ? {} : { openWithDefaultApp }),
	};
	return { app: app as unknown as App, adapter, openWithDefaultApp };
}

beforeEach(() => {
	mocks.notices.length = 0;
	mocks.modals.length = 0;
	mocks.modalOpenThrows = false;
	mocks.platform.isMobileApp = false;
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("saveExportedFile — desktop", () => {
	it("downloads through an <a download> click and never touches the vault or the dialog", async () => {
		const anchor = { href: "", download: "", click: vi.fn() };
		vi.stubGlobal("createEl", vi.fn(() => anchor));
		const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake");
		const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		const { app, adapter, openWithDefaultApp } = makeApp();

		await saveExportedFile(app, "a,b\n1,2", "mtg-list.csv", "text/csv");

		expect(anchor.download).toBe("mtg-list.csv");
		expect(anchor.href).toBe("blob:fake");
		expect(anchor.click).toHaveBeenCalledTimes(1);
		const blob = createObjectURL.mock.calls[0][0] as Blob;
		expect(blob.type).toBe("text/csv");
		expect(await blob.text()).toBe("a,b\n1,2");
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
		expect(adapter.write).not.toHaveBeenCalled();
		expect(openWithDefaultApp).not.toHaveBeenCalled();
		expect(mocks.modals).toEqual([]);
		expect(mocks.notices).toEqual([]);
	});
});

describe("saveExportedFile — mobile app (iOS/Android)", () => {
	beforeEach(() => {
		mocks.platform.isMobileApp = true;
	});

	it("opens the destination dialog, synchronously, with the content and file name", async () => {
		const { app, adapter } = makeApp();

		const pending = saveExportedFile(app, "3 - Lightning Bolt", "mtg-deck.txt", "text/plain");

		// Opened in the very stack of the click — before any await.
		expect(mocks.modals).toHaveLength(1);
		expect(mocks.modals[0]).toEqual({
			app,
			content: "3 - Lightning Bolt",
			filename: "mtg-deck.txt",
			opened: true,
		});
		await pending;
		// The window alone controls the writing: nothing is written until the user
		// has chosen Save/Share.
		expect(adapter.write).not.toHaveBeenCalled();
		expect(mocks.notices).toEqual([]);
	});

	it("passes binary content (zip) through untouched", async () => {
		const { app } = makeApp();
		const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer;

		await saveExportedFile(app, bytes, "mtg-lists-selection.zip", "application/zip");

		expect(mocks.modals[0].content).toBe(bytes);
		expect(mocks.modals[0].filename).toBe("mtg-lists-selection.zip");
	});

	it("never falls back to the browser download (document is not even touched)", async () => {
		// The Vitest environment is "node": `document` doesn't exist, so touching
		// the <a download> path would throw a ReferenceError.
		const { app } = makeApp();
		await expect(saveExportedFile(app, "x", "a.csv", "text/csv")).resolves.toBeUndefined();
	});
});

describe("saveExportedFile — mobile fallback when the dialog cannot open", () => {
	beforeEach(() => {
		mocks.platform.isMobileApp = true;
		mocks.modalOpenThrows = true;
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("saves into the default folder and opens the native share sheet instead", async () => {
		const { app, adapter, openWithDefaultApp } = makeApp();

		await saveExportedFile(app, "3 - Lightning Bolt", "mtg-deck.txt", "text/plain");

		expect(adapter.mkdir).toHaveBeenCalledWith(DEFAULT_EXPORT_FOLDER);
		expect(adapter.write).toHaveBeenCalledWith(`${DEFAULT_EXPORT_FOLDER}/mtg-deck.txt`, "3 - Lightning Bolt");
		expect(openWithDefaultApp).toHaveBeenCalledWith(`${DEFAULT_EXPORT_FOLDER}/mtg-deck.txt`);
		// openWithDefaultApp reads this.vault: it must be called as a method of
		// `app`, never detached.
		expect(openWithDefaultApp.mock.contexts[0]).toBe(app);
	});

	it("shows visible feedback synchronously, before any async work (the original bug was total silence)", async () => {
		const { app, adapter } = makeApp();
		// None of the vault operations completes until we decide so — simulates a
		// slow/blocked write on mobile.
		let releaseWrite!: () => void;
		adapter.write.mockReturnValue(new Promise<void>((resolve) => (releaseWrite = resolve)));

		const pending = saveExportedFile(app, "x", "mtg-list.csv", "text/csv");

		// Right after the "tap": already a Notice, persistent (duration 0), BEFORE
		// exists()/write() have even returned control.
		expect(mocks.notices).toHaveLength(1);
		expect(mocks.notices[0].history).toEqual(["Exporting mtg-list.csv…"]);
		expect(mocks.notices[0].duration).toBe(0);
		expect(mocks.notices[0].hidden).toBe(false);

		releaseWrite();
		await pending;
	});

	it("updates that single Notice to a 'Saved' message, then hides it after a few seconds", async () => {
		vi.useFakeTimers();
		const { app } = makeApp();

		await saveExportedFile(app, "x", "mtg-deck.txt", "text/plain");

		expect(mocks.notices).toHaveLength(1);
		const [notice] = mocks.notices;
		expect(notice.history).toEqual([
			"Exporting mtg-deck.txt…",
			`Saved mtg-deck.txt to the ${DEFAULT_EXPORT_FOLDER} folder of your vault.`,
		]);
		expect(notice.hidden).toBe(false);
		vi.advanceTimersByTime(5999);
		expect(notice.hidden).toBe(false);
		vi.advanceTimersByTime(1);
		expect(notice.hidden).toBe(true);
	});

	it("writes binary content (zip) with writeBinary, not write", async () => {
		const { app, adapter, openWithDefaultApp } = makeApp();
		const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer;

		await saveExportedFile(app, bytes, "mtg-lists-selection.zip", "application/zip");

		expect(adapter.writeBinary).toHaveBeenCalledWith(`${DEFAULT_EXPORT_FOLDER}/mtg-lists-selection.zip`, bytes);
		expect(adapter.write).not.toHaveBeenCalled();
		expect(openWithDefaultApp).toHaveBeenCalledWith(`${DEFAULT_EXPORT_FOLDER}/mtg-lists-selection.zip`);
	});

	it("reports a failed write in the same Notice and skips the share sheet", async () => {
		const { app, adapter, openWithDefaultApp } = makeApp();
		adapter.write.mockRejectedValue(new Error("disk full"));

		await saveExportedFile(app, "x", "a.csv", "text/csv");

		expect(openWithDefaultApp).not.toHaveBeenCalled();
		expect(mocks.notices).toHaveLength(1);
		expect(mocks.notices[0].history).toEqual(["Exporting a.csv…", "Could not export a.csv: disk full"]);
	});

	it("reports an unexpected error thrown before the write instead of rejecting silently", async () => {
		// No app.vault at all: accessing app.vault.adapter throws a TypeError —
		// without this safety net, it would reject the promise (discarded by the
		// callers) with no message at all.
		const brokenApp = {} as unknown as App;

		await expect(saveExportedFile(brokenApp, "x", "a.csv", "text/csv")).resolves.toBeUndefined();

		expect(mocks.notices).toHaveLength(1);
		expect(mocks.notices[0].history[0]).toBe("Exporting a.csv…");
		expect(mocks.notices[0].history[1]).toContain("Could not export a.csv");
	});

	it("still tells where the file is when openWithDefaultApp does not exist", async () => {
		const { app, adapter } = makeApp({ withOpen: false });

		await expect(saveExportedFile(app, "x", "a.csv", "text/csv")).resolves.toBeUndefined();

		expect(adapter.write).toHaveBeenCalledTimes(1);
		expect(mocks.notices[0].history[1]).toContain(DEFAULT_EXPORT_FOLDER);
	});
});

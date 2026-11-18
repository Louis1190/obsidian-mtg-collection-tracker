import { beforeEach, describe, expect, it, vi } from "vitest";

const requestUrl = vi.fn();
// the card recognition exists on phones, tablets and computers with a webcam (availability.ts): these tests are about the feature on a phone, a computer's cases have their own tests
const platform = vi.hoisted(() => ({ isMobileApp: true }));
vi.mock("obsidian", () => ({ requestUrl: (...a: unknown[]) => requestUrl(...a), normalizePath: (p: string) => p.replace(/\/+/g, "/"), Platform: platform }));

import type MTGCollectionPlugin from "../../plugin";
import { lookForWebcam, resetWebcamForTests } from "../availability";
import { buildTestFiles } from "../fingerprint/__tests__/fingerprint-scenes";
import { DOWNLOAD_TIMEOUT_MS, MOVED_KEY, deviceSavesData, fingerprintBaseOf, fingerprintDeps, fingerprintEnabled, prepareFingerprint, releaseFingerprint, stopFingerprintBase } from "./fingerprint-base";

function fakePlugin(over: { enabled?: boolean; url?: string; local?: Map<string, string> } = {}) {
	const disk = new Map<string, ArrayBuffer>();
	const local = over.local ?? new Map<string, string>();
	const adapter = {
		exists: async (p: string) => disk.has(p),
		readBinary: async (p: string) => disk.get(p)!,
		writeBinary: async (p: string, data: ArrayBuffer) => void disk.set(p, data),
		remove: async (p: string) => void disk.delete(p),
		list: async (dir: string) => ({ files: [...disk.keys()].filter((k) => k.startsWith(dir + "/")), folders: [] as string[] }),
	};
	const plugin = {
		settings: { cardRecognitionEnabled: over.enabled ?? true },
		fingerprintBaseUrl: over.url ?? "http://localhost:8767/fp",
		manifest: { dir: ".obsidian/plugins/mtg-collection-tracker" },
		app: { vault: { adapter }, loadLocalStorage: (k: string) => local.get(k) ?? null, saveLocalStorage: (k: string, v: string | null) => (v === null ? local.delete(k) : local.set(k, v)) },
	} as unknown as MTGCollectionPlugin;
	return { plugin, disk, local };
}

beforeEach(() => {
	// braces: a function returned from a hook is run by vitest as its clean-up, and this one would call the mock (a rejecting one left an unhandled rejection)
	requestUrl.mockReset();
	platform.isMobileApp = true;
});

describe("fingerprintEnabled / fingerprintDeps", () => {
	it("is off on a computer with no webcam even with the setting on there: no deps for the scan panel, so no base is made, read or downloaded", () => {
		platform.isMobileApp = false;
		resetWebcamForTests();
		const { plugin } = fakePlugin();
		expect(fingerprintEnabled(plugin)).toBe(false);
		expect(fingerprintDeps(plugin)).toBeUndefined();
		expect(requestUrl).not.toHaveBeenCalled();
	});
	it("is on a computer where a webcam is found, once the setting is on (and still off with the setting off)", async () => {
		platform.isMobileApp = false;
		resetWebcamForTests();
		await lookForWebcam({ enumerateDevices: async () => [{ kind: "videoinput" }] });
		expect(fingerprintEnabled(fakePlugin().plugin)).toBe(true);
		expect(fingerprintEnabled(fakePlugin({ enabled: false }).plugin)).toBe(false);
		resetWebcamForTests();
	});
	it("is on with the setting on, address or not (without an address the base can only come from the files in the plugin's folder)", () => {
		expect(fingerprintEnabled(fakePlugin().plugin)).toBe(true);
		expect(fingerprintEnabled(fakePlugin({ url: "" }).plugin)).toBe(true);
		expect(fingerprintEnabled(fakePlugin({ enabled: false }).plugin)).toBe(false);
		expect(fingerprintEnabled(fakePlugin({ enabled: false, url: "" }).plugin)).toBe(false);
	});
	it("hands the scan panel nothing while the setting is off, so the panel runs as before", () => {
		expect(fingerprintDeps(fakePlugin({ enabled: false }).plugin)).toBeUndefined();
		expect(fingerprintDeps(fakePlugin({ enabled: false, url: "" }).plugin)).toBeUndefined();
		for (const url of ["http://localhost:8767/fp", ""]) {
			const deps = fingerprintDeps(fakePlugin({ url }).plugin);
			expect(typeof deps?.database).toBe("function");
			expect(typeof deps?.lookupIllustrations).toBe("function");
			expect(typeof deps?.cardPixels).toBe("function");
			expect(deps?.cornerCard).toBeUndefined(); // no engine handed in: the corner is never read
		}
	});
	it("reads the corner through the engine it is given, asking Scryfall for the card at the set code and number it read, and takes the three-letter set code of a token with its T", async () => {
		const readCornerCard = vi.fn(async (_photo: unknown, _quad: unknown, _outer: boolean, lookup: (printed: unknown) => Promise<unknown>, _signal?: AbortSignal) => {
			await lookup({ number: "1", set: "hob", lang: "en", rarity: "T" });
			await lookup({ number: null, set: "hob", lang: "en", rarity: null });
			await lookup({ number: "5", set: "pm", lang: "en", rarity: null }); // too few letters to look anything up
			return null;
		});
		requestUrl.mockResolvedValue({ status: 404, headers: {}, json: null, text: "" });
		const deps = fingerprintDeps(fakePlugin().plugin, () => ({ readCornerCard }) as never);
		const signal = new AbortController().signal;
		const photo = { rgba: new Uint8ClampedArray(4), w: 1, h: 1 };
		const quad = [[0, 0], [1, 0], [1, 1], [0, 1]] as never;
		await deps!.cornerCard!(photo, quad, true, signal);
		expect(readCornerCard.mock.calls[0].slice(0, 3)).toEqual([photo, quad, true]);
		expect(readCornerCard.mock.calls[0][4]).toBe(signal);
		expect(requestUrl.mock.calls.map((c) => (c[0] as { url: string }).url)).toEqual([expect.stringContaining("/cards/thob/1")]);
	});
});

describe("the base of a plugin", () => {
	it("is one object per plugin; with an empty address and no files there is no base, nothing is asked and `prepareFingerprint` says so (the title reader is warmed instead)", async () => {
		const { plugin } = fakePlugin({ url: "" });
		const a = fingerprintBaseOf(plugin);
		expect(fingerprintBaseOf(plugin)).toBe(a);
		expect(a.configured).toBe(false);
		expect(await a.database()).toBeNull();
		expect(await prepareFingerprint(plugin)).toBe(false);
		expect(requestUrl).not.toHaveBeenCalled();
		releaseFingerprint(plugin);
		stopFingerprintBase(plugin);
	});

	it("with an empty address it reads the files the person's sync put in the plugin's folder (the real disk functions, the real hash and decompression), and never touches the network", async () => {
		const { plugin, disk } = fakePlugin({ url: "" });
		const files = buildTestFiles(Array.from({ length: 40 }, (_, i) => i + 1), 32);
		const dir = ".obsidian/plugins/mtg-collection-tracker";
		for (const [name, bytes] of files.site) disk.set(`${dir}/${name === "index.json" ? "fp-index.json" : "fp-" + name}`, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
		const before = [...disk.keys()].sort();
		expect(await prepareFingerprint(plugin)).toBe(true);
		expect((await fingerprintBaseOf(plugin).database())?.n).toBe(40);
		expect(requestUrl).not.toHaveBeenCalled();
		expect([...disk.keys()].sort()).toEqual(before); // nothing written, nothing removed
		releaseFingerprint(plugin);
		stopFingerprintBase(plugin);
	});

	it("reads the site through the plugin's own request, a refusal being a null (the title is read instead)", async () => {
		const { plugin } = fakePlugin();
		requestUrl.mockResolvedValue({ status: 404, arrayBuffer: new ArrayBuffer(0) });
		expect(await fingerprintBaseOf(plugin).database()).toBeNull();
		expect(requestUrl.mock.calls[0][0]).toMatchObject({ url: "http://localhost:8767/fp/index.json", method: "GET", throw: false });
		expect(DOWNLOAD_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
	});

	it("takes a request that fails (offline) for a null as well", async () => {
		const { plugin } = fakePlugin();
		requestUrl.mockImplementation(() => Promise.reject(new Error("offline")));
		expect(await fingerprintBaseOf(plugin).database()).toBeNull();
	});

	it("keeps nothing in the vault's visible files: only fp- files in the plugin's own folder", async () => {
		const { plugin, disk } = fakePlugin();
		requestUrl.mockResolvedValue({ status: 404, arrayBuffer: new ArrayBuffer(0) });
		await fingerprintBaseOf(plugin).database();
		expect([...disk.keys()].every((k) => k.startsWith(".obsidian/plugins/mtg-collection-tracker/fp-"))).toBe(true);
	});
});

describe("a device that asks to save data", () => {
	// `navigator.connection` does not exist under Node: set it on the instance for one call and take it away again (never `vi.unstubAllGlobals`, which would also remove the window the setup installs)
	async function withSaveData<T>(value: boolean | undefined, run: () => Promise<T> | T): Promise<T> {
		Object.defineProperty(navigator, "connection", { value: value === undefined ? undefined : { saveData: value }, configurable: true });
		try {
			return await run();
		} finally {
			delete (navigator as unknown as { connection?: unknown }).connection;
		}
	}
	const dir = ".obsidian/plugins/mtg-collection-tracker";
	function putBase(disk: Map<string, ArrayBuffer>) {
		const files = buildTestFiles(Array.from({ length: 40 }, (_, i) => i + 1), 32);
		for (const [name, bytes] of files.site) disk.set(`${dir}/${name === "index.json" ? "fp-index.json" : "fp-" + name}`, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
	}

	it("is read from the device's own report, only when it says `saveData: true`", async () => {
		expect(deviceSavesData()).toBe(false); // no `connection` at all (a desktop browser, Node)
		expect(await withSaveData(true, deviceSavesData)).toBe(true);
		expect(await withSaveData(false, deviceSavesData)).toBe(false);
		expect(await withSaveData(undefined, deviceSavesData)).toBe(false);
	});

	it("downloads nothing and has no base when there is no copy on disk, so the title is read instead (with an address set)", async () => {
		const { plugin, disk } = fakePlugin();
		await withSaveData(true, async () => {
			expect(await prepareFingerprint(plugin)).toBe(false);
			expect(await fingerprintBaseOf(plugin).database()).toBeNull();
		});
		expect(requestUrl).not.toHaveBeenCalled();
		expect(disk.size).toBe(0);
		releaseFingerprint(plugin);
		stopFingerprintBase(plugin);
	});

	it("uses a copy already on disk, and neither asks the site nor writes nor removes anything", async () => {
		const { plugin, disk } = fakePlugin();
		putBase(disk);
		disk.set(`${dir}/fp-s99.bin.gz`, new ArrayBuffer(4)); // an old shard the site's index would have removed
		const before = [...disk.keys()].sort();
		await withSaveData(true, async () => {
			expect(await prepareFingerprint(plugin)).toBe(true);
			expect((await fingerprintBaseOf(plugin).database())?.n).toBe(40);
		});
		expect(requestUrl).not.toHaveBeenCalled();
		expect([...disk.keys()].sort()).toEqual(before);
		releaseFingerprint(plugin);
		stopFingerprintBase(plugin);
	});

	it("asks the site as usual when the device does not ask to save data", async () => {
		const { plugin } = fakePlugin();
		requestUrl.mockResolvedValue({ status: 404, arrayBuffer: new ArrayBuffer(0) });
		await withSaveData(false, async () => {
			expect(await fingerprintBaseOf(plugin).database()).toBeNull();
		});
		expect(requestUrl.mock.calls[0][0]).toMatchObject({ url: "http://localhost:8767/fp/index.json" });
		stopFingerprintBase(plugin);
	});
});

describe("downloads that go wrong, through the plugin's own request", () => {
	const SITE = "http://localhost:8767/fp";
	const files = buildTestFiles(Array.from({ length: 40 }, (_, i) => i + 1), 32);
	const buffer = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
	/** Serves the test site; `by` answers differently for the files it names (a status, or a promise that never settles). */
	function serve(by: Record<string, number | "stall"> = {}) {
		requestUrl.mockImplementation(({ url }: { url: string }) => {
			const name = url.slice(SITE.length + 1);
			const special = by[name];
			if (special === "stall") return new Promise(() => undefined);
			if (typeof special === "number") return Promise.resolve({ status: special, arrayBuffer: new ArrayBuffer(0) });
			const bytes = files.site.get(name);
			return Promise.resolve(bytes ? { status: 200, arrayBuffer: buffer(bytes) } : { status: 404, arrayBuffer: new ArrayBuffer(0) });
		});
	}
	const shardName = [...files.site.keys()].find((k) => k !== "index.json")!;

	it.each([301, 403, 404, 429, 500, 503])("a shard answered %i is no base and writes nothing; the next session, once the pause is over, tries again", async (status) => {
		const { plugin, disk } = fakePlugin();
		serve({ [shardName]: status });
		expect(await fingerprintBaseOf(plugin).database()).toBeNull();
		expect([...disk.keys()].some((k) => k.endsWith("fp-index.json"))).toBe(false);
		expect([...disk.keys()].some((k) => k.endsWith(`fp-${shardName}`))).toBe(false);
		serve(); // the site is fine again
		stopFingerprintBase(plugin);
		const again = fakePlugin(); // a new plugin object stands for a new session (the pause is the base object's own memory)
		expect((await fingerprintBaseOf(again.plugin).database())?.n).toBe(40);
	});

	it.each([301, 403, 404, 429, 500, 503])("an index answered %i is no base from the site (null without a copy on disk)", async (status) => {
		const { plugin } = fakePlugin();
		serve({ "index.json": status });
		expect(await fingerprintBaseOf(plugin).database()).toBeNull();
	});

	it("a shard that never arrives is given up on after the download delay, with no base and nothing kept; a stalled index after its own, shorter one", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const { plugin, disk } = fakePlugin();
			serve({ [shardName]: "stall" });
			const pending = fingerprintBaseOf(plugin).database();
			await vi.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS + 1000);
			expect(await pending).toBeNull();
			expect([...disk.keys()].some((k) => k.endsWith("fp-index.json"))).toBe(false);
			const other = fakePlugin();
			serve({ "index.json": "stall" });
			const stalled = fingerprintBaseOf(other.plugin).database();
			await vi.advanceTimersByTimeAsync(6500);
			expect(await stalled).toBeNull(); // the index's own delay (6 s), not the download's 30 s
		} finally {
			vi.useRealTimers();
		}
	});

	it("a request that throws before it even returns a promise is a null as well", async () => {
		const { plugin } = fakePlugin();
		requestUrl.mockImplementation(() => {
			throw new Error("blocked");
		});
		expect(await fingerprintBaseOf(plugin).database()).toBeNull();
	});
});

describe("a `moved` pointer, through the plugin's own request and this device's storage", () => {
	const OLD = "https://old.example.org/fp";
	const NEW = "https://files.example.org/fp";
	const files = buildTestFiles(Array.from({ length: 40 }, (_, i) => i + 1), 32);
	const buffer = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
	const withMoved = (moved: unknown) => {
		const index = JSON.parse(new TextDecoder().decode(files.site.get("index.json")!)) as Record<string, unknown>;
		if (moved !== undefined && moved !== null) index.moved = moved;
		return new TextEncoder().encode(JSON.stringify(index));
	};
	/** OLD answers an index that points to NEW (or to `oldMoved`, null: no pointer); NEW answers a plain one; every request is recorded. */
	function serve(oldMoved: unknown = NEW, up: { old: boolean; neu: boolean } = { old: true, neu: true }) {
		const asked: string[] = [];
		requestUrl.mockImplementation(({ url }: { url: string }) => {
			asked.push(url);
			const host = url.startsWith(`${OLD}/`) ? OLD : url.startsWith(`${NEW}/`) ? NEW : null;
			if (host === null || (host === OLD && !up.old) || (host === NEW && !up.neu)) return Promise.resolve({ status: 404, arrayBuffer: new ArrayBuffer(0) });
			const name = url.slice(host.length + 1);
			const bytes = name === "index.json" ? withMoved(host === OLD ? oldMoved : undefined) : files.site.get(name);
			return Promise.resolve(bytes ? { status: 200, arrayBuffer: buffer(bytes) } : { status: 404, arrayBuffer: new ArrayBuffer(0) });
		});
		return asked;
	}

	it("follows the pointer, keeps the address in this device's own storage tied to the address it came from, and the next session on this device goes there directly", async () => {
		const local = new Map<string, string>();
		const { plugin } = fakePlugin({ url: OLD, local });
		const asked = serve();
		expect((await fingerprintBaseOf(plugin).database())?.n).toBe(40);
		expect(JSON.parse(local.get(MOVED_KEY)!)).toEqual({ from: OLD, to: NEW });
		expect(asked.filter((u) => u.includes("bin.gz")).every((u) => u.startsWith(`${NEW}/`))).toBe(true);
		// another session (a new plugin object), the old site gone: the remembered address answers
		const next = fakePlugin({ url: OLD, local });
		serve(NEW, { old: false, neu: true });
		expect((await fingerprintBaseOf(next.plugin).database())?.n).toBe(40);
	});

	it("an address learned from another configured address is not used (a newer plugin that ships a different address starts again from its own)", async () => {
		const local = new Map([[MOVED_KEY, JSON.stringify({ from: "https://elsewhere.example.org/fp", to: NEW })]]);
		const { plugin } = fakePlugin({ url: OLD, local });
		const asked = serve(null);
		expect((await fingerprintBaseOf(plugin).database())?.n).toBe(40);
		expect(asked.every((u) => u.startsWith(`${OLD}/`))).toBe(true);
	});

	it.each([["not JSON", "{oops"], ["an array", "[]"], ["no address", JSON.stringify({ from: OLD })], ["an http address", JSON.stringify({ from: OLD, to: "http://files.example.org/fp" })], ["a number", "42"]])("ignores a stored value that is %s", async (_label, stored) => {
		const local = new Map([[MOVED_KEY, stored]]);
		const { plugin } = fakePlugin({ url: OLD, local });
		const asked = serve(null);
		expect((await fingerprintBaseOf(plugin).database())?.n).toBe(40);
		expect(asked.every((u) => u.startsWith(`${OLD}/`))).toBe(true);
	});

	it("a device whose storage refuses still gets the base, and follows the pointer again next time", async () => {
		const { plugin } = fakePlugin({ url: OLD });
		(plugin.app as unknown as { loadLocalStorage: () => never }).loadLocalStorage = () => {
			throw new Error("blocked");
		};
		(plugin.app as unknown as { saveLocalStorage: () => never }).saveLocalStorage = () => {
			throw new Error("blocked");
		};
		serve();
		expect((await fingerprintBaseOf(plugin).database())?.n).toBe(40);
	});

	it("with Data Saver on, a remembered address is not asked either: nothing is requested", async () => {
		const local = new Map([[MOVED_KEY, JSON.stringify({ from: OLD, to: NEW })]]);
		const { plugin } = fakePlugin({ url: OLD, local });
		(navigator as unknown as { connection?: unknown }).connection = { saveData: true };
		try {
			serve();
			expect(await fingerprintBaseOf(plugin).database()).toBeNull();
			expect(requestUrl).not.toHaveBeenCalled();
		} finally {
			delete (navigator as unknown as { connection?: unknown }).connection;
		}
	});
});

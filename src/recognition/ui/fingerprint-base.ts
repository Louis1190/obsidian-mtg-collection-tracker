// The image fingerprint's glue with the plugin: the base of fingerprints (recognition/fingerprint/lazy-database.ts) given the plugin's own file access and requests, and what the scan panel needs
// from it. PRIVATE like src/recognition/. Everything here is OFF while `plugin.fingerprintBaseUrl` is empty (recognition/fingerprint/config.ts): `fingerprintDeps` answers undefined and the scan
// panel runs exactly as it did before.

import { normalizePath, requestUrl } from "obsidian";
import { fetchPrintingBySetAndNumber, fetchPrintingsOfIllustrations, type ScryfallCard } from "../../api/scryfall";
import { gunzipBytes } from "../../api/github";
import type MTGCollectionPlugin from "../../plugin";
import { cardRecognitionAvailable } from "../availability";
import { CARD_H, CARD_W } from "../fingerprint/descriptors";
import { parseMovedAddress } from "../fingerprint/database";
import { FILE_PREFIX, FingerprintBase, type BaseDeps } from "../fingerprint/lazy-database";
import type { FingerprintDeps } from "../fingerprint/scan-fingerprint";
import type { CardRecognition } from "../service";
import { lookupSetCode } from "./card-scan";

/** A shard (~1.3 MB) or the index that has not arrived after this long is given up on (`requestUrl` has no timeout of its own). */
export const DOWNLOAD_TIMEOUT_MS = 30_000;

/** The device's own storage key of the address a `moved` pointer sent it to (never synced: each device learns it from the site). Holds `{"from": <configured address>, "to": <address>}`. */
export const MOVED_KEY = "mtg-card-fingerprint-moved";

const bases = new WeakMap<MTGCollectionPlugin, FingerprintBase>();

/**
 * True when the device asks to save data (Data Saver on Android, Low Data Mode where the browser reports it). The base (10.6 MB) is then NOT downloaded: the same rule as the neighbour prefetch
 * (plugin/neighbor-prefetch.ts). Read at each load, not once, because the person can change it at any time.
 */
export function deviceSavesData(): boolean {
	return (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
}

/**
 * True when the feature exists on this device (a phone, a tablet, or a computer with a webcam, availability.ts) and the setting is on for it. The base itself may be absent: with an address it comes from the site (or the copy on
 * disk), without one only from the `fp-*` files in the plugin's folder (the person's own sync carries them there); with neither, `prepareFingerprint` answers false and the scan reads the title as it
 * always did.
 */
export function fingerprintEnabled(plugin: MTGCollectionPlugin): boolean {
	return cardRecognitionAvailable() && plugin.settings.cardRecognitionEnabled;
}

function baseDeps(plugin: MTGCollectionPlugin): BaseDeps {
	const adapter = plugin.app.vault.adapter;
	const dir = plugin.manifest.dir;
	const path = (name: string) => normalizePath(`${dir}/${name}`);
	return {
		// With Data Saver on this answers no address: the base is then read from the files already on disk and nothing is downloaded, written or removed (lazy-database.ts)
		baseUrl: () => (deviceSavesData() ? "" : plugin.fingerprintBaseUrl),
		get: (url) =>
			// the handlers sit on the request the moment it exists (a rejection is then never left unhandled), and the timer gives up on a request that stalls
			new Promise<Uint8Array | null>((resolve) => {
				const timer = window.setTimeout(() => resolve(null), DOWNLOAD_TIMEOUT_MS);
				const done = (bytes: Uint8Array | null) => {
					window.clearTimeout(timer);
					resolve(bytes);
				};
				try {
					requestUrl({ url, method: "GET", throw: false }).then(
						(res) => done(res.status === 200 ? new Uint8Array(res.arrayBuffer) : null),
						() => done(null),
					);
				} catch {
					done(null);
				}
			}),
		files: {
			read: async (name) => {
				try {
					return (await adapter.exists(path(name))) ? new Uint8Array(await adapter.readBinary(path(name))) : null;
				} catch {
					return null;
				}
			},
			write: async (name, bytes) => {
				await adapter.writeBinary(path(name), bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
			},
			remove: async (name) => {
				await adapter.remove(path(name));
			},
			list: async () => {
				const listed = await adapter.list(normalizePath(dir ?? ""));
				return listed.files.map((f) => f.slice(f.lastIndexOf("/") + 1)).filter((n) => n.startsWith(FILE_PREFIX));
			},
		},
		sha256: async (bytes) => {
			const digest = await crypto.subtle.digest("SHA-256", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
			return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
		},
		gunzip: gunzipBytes,
		moved: {
			// tied to the configured address it was learned from: a plugin version that ships another address does not inherit a pointer meant for the old one
			read: (from) => {
				try {
					const raw: unknown = plugin.app.loadLocalStorage(MOVED_KEY);
					const stored: unknown = typeof raw === "string" ? JSON.parse(raw) : null;
					if (typeof stored !== "object" || stored === null) return null;
					const { from: was, to } = stored as Record<string, unknown>;
					return was === from ? parseMovedAddress(to) : null;
				} catch {
					return null;
				}
			},
			write: (from, to) => {
				try {
					plugin.app.saveLocalStorage(MOVED_KEY, to === null ? null : JSON.stringify({ from, to }));
				} catch {
					// a device whose storage refuses simply follows the pointer again next time
				}
			},
		},
	};
}

/** The plugin's one base object (made on first use; holds nothing until a scan asks for it). */
export function fingerprintBaseOf(plugin: MTGCollectionPlugin): FingerprintBase {
	let base = bases.get(plugin);
	if (!base) {
		base = new FingerprintBase(baseDeps(plugin));
		bases.set(plugin, base);
	}
	return base;
}

/** The person tapped the camera button: the base loads now, while the photo is taken, and stays up between photos until the window closes. Answers whether there is a base. */
export function prepareFingerprint(plugin: MTGCollectionPlugin): Promise<boolean> {
	return fingerprintBaseOf(plugin).prepare();
}

/** The window that scans closed: the base goes after the usual idle time. Builds nothing when nothing was ever started. */
export function releaseFingerprint(plugin: MTGCollectionPlugin): void {
	bases.get(plugin)?.unpin();
}

/** The setting went off or the plugin unloads: the base is let go now (the files on disk stay). */
export function stopFingerprintBase(plugin: MTGCollectionPlugin): void {
	bases.get(plugin)?.stop();
}

/** A printing's small picture as 96 x 134 RGB, or null when it cannot be had. Through the plugin's request (the image servers have no limit), decoded with `createImageBitmap`, drawn once. */
async function cardPixels(card: ScryfallCard): Promise<Uint8Array | null> {
	const url = card.image_uris?.small ?? card.card_faces?.[0]?.image_uris?.small;
	if (!url) return null;
	try {
		const res = await requestUrl({ url, method: "GET", throw: false });
		if (res.status !== 200) return null;
		const bitmap = await createImageBitmap(new Blob([res.arrayBuffer]));
		try {
			const canvas = createEl("canvas");
			canvas.width = CARD_W;
			canvas.height = CARD_H;
			const ctx = canvas.getContext("2d", { willReadFrequently: true });
			if (!ctx) return null;
			ctx.imageSmoothingQuality = "high";
			ctx.drawImage(bitmap, 0, 0, CARD_W, CARD_H);
			const rgba = ctx.getImageData(0, 0, CARD_W, CARD_H).data;
			const rgb = new Uint8Array(CARD_W * CARD_H * 3);
			for (let i = 0, j = 0; i < CARD_W * CARD_H; i++, j += 3) {
				rgb[j] = rgba[i * 4];
				rgb[j + 1] = rgba[i * 4 + 1];
				rgb[j + 2] = rgba[i * 4 + 2];
			}
			return rgb;
		} finally {
			bitmap.close();
		}
	} catch {
		return null;
	}
}

/**
 * What the scan panel passes to `startCardScan`; undefined while the feature is off, so nothing changes. `recognition`: the title reader's engine, which the scan starts only for a photo the fingerprint
 * is not sure of, to read the printed corner (scan-fingerprint.ts CORNER_CHECK_SCORE); handed in, never imported here, so this file stays loadable where the OCR engine's library is not. Without it the
 * corner is never read.
 */
export function fingerprintDeps(plugin: MTGCollectionPlugin, recognition?: () => Pick<CardRecognition, "readCornerCard">): FingerprintDeps | undefined {
	if (!fingerprintEnabled(plugin)) return undefined;
	const base = fingerprintBaseOf(plugin);
	return {
		database: (onProgress) => base.database(onProgress),
		lookupIllustrations: fetchPrintingsOfIllustrations,
		cardPixels,
		// the card is the one Scryfall has at the set code and number the corner prints
		cornerCard: recognition
			? (photo, quad, outer, signal) =>
					recognition().readCornerCard<ScryfallCard>(
						photo,
						quad,
						outer,
						(printed) => {
							const set = lookupSetCode(printed);
							return set && printed.number ? fetchPrintingBySetAndNumber(set, printed.number) : Promise.resolve(null);
						},
						signal,
					)
			: undefined,
	};
}

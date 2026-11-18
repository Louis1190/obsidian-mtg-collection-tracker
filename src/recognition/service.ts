// The card recognition as the plugin uses it: one object that owns the OCR engine (started on first use, stopped after a while without a reading) and the
// catalogue (parsed and indexed on first use), and reads photos. The one place that imports the embedded assets and Tesseract.js; nothing else in the
// plugin needs to know.

import Tesseract from "tesseract.js/dist/tesseract.esm.min.js";
import { loadCatalogueText, loadEngineAssets } from "./assets";
import { buildSetScopeIndex, catalogueIndex, namesOfRow, parseCatalogue, rowIndexByName, shortNameIndex, type CatalogueRow } from "./catalogue";
import { CATALOGUE_SNAPSHOT } from "./catalogue-snapshot-info";
import type { Quad } from "./card-finder";
import type { NameIndex } from "./name-match";
import { LazyOcr, OcrEngine } from "./ocr-engine";
import type { PrintedInfo } from "./printed";
import { findCornerCard, scanPhoto, type Photo, type RecognitionScanOptions, type ScanResult, type SetScope, type ShortcutCard } from "./scan";

export interface LoadedCatalogue {
	rows: CatalogueRow[];
	index: NameIndex;
	/** the same catalogue, only the names of 3 to 5 letters (read by their own reader) */
	shortIndex: NameIndex;
	/** the row of each card by its lower-cased English name (and by each face of a double name) */
	rowByName: Map<string, number>;
}

export class CardRecognition {
	private readonly ocr: LazyOcr;
	private loaded: Promise<LoadedCatalogue> | null = null;

	/** `idleMs`: how long the engine (about 80 MB) is kept after the last reading. */
	constructor(idleMs = 60_000) {
		this.ocr = new LazyOcr(async () => OcrEngine.start(await loadEngineAssets(), Tesseract.createWorker), idleMs);
	}

	/** The day of the names the snapshot holds (shown to the person: a card newer than that is not recognised). */
	get catalogueDate(): string {
		return CATALOGUE_SNAPSHOT.date;
	}

	/** The catalogue, parsed and indexed on the first call (about 1 s on a phone, measured on a laptop at 0.7 s); a failure is not kept. */
	catalogue(): Promise<LoadedCatalogue> {
		if (!this.loaded) {
			const p = (async () => {
				const rows = parseCatalogue(await loadCatalogueText());
				return { rows, index: catalogueIndex(rows, CATALOGUE_SNAPSHOT.languages), shortIndex: shortNameIndex(rows, CATALOGUE_SNAPSHOT.languages), rowByName: rowIndexByName(rows) };
			})();
			this.loaded = p;
			p.catch(() => {
				if (this.loaded === p) this.loaded = null;
			});
		}
		return this.loaded;
	}

	/**
	 * Starts the engine and loads the catalogue in the background: called when the person taps the camera button, so both are up while they take the photo (the first reading of a
	 * session used to wait for them). Never throws: a scan that still finds them failing says so itself.
	 */
	async prepare(): Promise<void> {
		try {
			await Promise.all([this.ocr.warm(), this.catalogue()]);
		} catch {
			// reported by the scan that needs them
		}
	}

	/** Keeps the engine up between photos while a window that scans is open (see `LazyOcr.pin`). */
	pin(): void {
		this.ocr.pin();
	}

	/** The window closed: the engine goes back to stopping after the usual idle time. */
	release(): void {
		this.ocr.unpin();
	}

	/** Reads a photo. `rows[owner]` of a proposal is the card (the rows are the catalogue's, plus one for each card of the printed set the catalogue does not know, when the set's list was used). */
	async scan(photo: Photo, opts: RecognitionScanOptions = {}): Promise<{ result: ScanResult; rows: CatalogueRow[] }> {
		const { rows, index, shortIndex, rowByName } = await this.catalogue();
		const { exactName, setCards, ...rest } = opts;
		// the corner names a card by Scryfall's name for it: a row of the catalogue lets the title confirm it; no row (a token, a newer card) lets the corner decide alone
		const shortcut = exactName
			? async (printed: PrintedInfo): Promise<ShortcutCard | null> => {
					const name = await exactName(printed);
					if (!name) return null;
					const owner = rowByName.get(name.toLowerCase());
					return owner === undefined ? { owner: null, names: [] } : { owner, names: namesOfRow(rows[owner], CATALOGUE_SNAPSHOT.languages) };
				}
			: undefined;
		// the cards of the set the corner names, to read the title among them (see ScanOptions.setScope); a card of the list the catalogue does not know gets a row past its own
		const extraRows: CatalogueRow[] = [];
		const setScope = setCards
			? async (printed: PrintedInfo): Promise<SetScope | null> => {
					const names = await setCards(printed);
					return names && names.length > 0 ? { index: buildSetScopeIndex(names, rows, rowByName, CATALOGUE_SNAPSHOT.languages, extraRows) } : null;
				}
			: undefined;
		const result = await scanPhoto(photo, this.ocr, index, { ...rest, shortcut, setScope, shortIndex });
		return { result, rows: extraRows.length > 0 ? [...rows, ...extraRows] : rows };
	}

	/**
	 * The card the corner of a photo names, for a photo whose card the image fingerprint already found (`quad`; `outer`: it is the card's own edge): the engine starts if it is not up, reads the corner
	 * and `lookup` answers the card at the set code and number read. No catalogue is needed. Never throws; null when nothing could be read or found.
	 */
	async readCornerCard<T>(photo: Photo, quad: Quad, outer: boolean, lookup: (printed: PrintedInfo) => Promise<T | null>, signal?: AbortSignal): Promise<T | null> {
		return (await findCornerCard(photo, quad, outer, this.ocr, lookup, signal)).card;
	}

	/** Ends the engine now (the window closed, the plugin unloads) and lets the catalogue go. */
	async stop(): Promise<void> {
		this.loaded = null;
		await this.ocr.stop();
	}
}

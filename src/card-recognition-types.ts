// What the rest of the plugin may ask of the card-recognition feature (adding a card from a photo, beta). This file is the whole contract: the real implementation
// (src/recognition/entry.ts, reached through src/card-recognition-entry.ts) and the stub the public copy ships (src/card-recognition-entry.stub.ts) are both typed
// against it, so neither can drift from the other without `tsc` failing. Public: it names no private module.
// Plan and reasons: docs/history/public-stubs-plan.md.

import type { Setting } from "obsidian";
import type { ScryfallCard } from "./api/scryfall";
import type MTGCollectionPlugin from "./plugin";

/** What the "Add cards" window's `renderAddControl` accepts for a card shown outside its carousel (a block of the list of scanned cards). */
export interface AddControlOptions {
	host?: HTMLElement;
	compact?: boolean;
	track?: boolean;
	onAddedChange?: (added: boolean) => void;
}

/** What the "Add cards" window hands over so the scan can live in it without owning any of its state. */
export interface AddCardsScanHost {
	plugin: MTGCollectionPlugin;
	/** The section under the title: the scan's pill and panel are put in it. */
	topSection: HTMLElement;
	/** The block that holds the results carousel: hidden while the list of scanned cards shows. */
	resultsBlock: HTMLElement;
	/** Adds a card exactly as a search tile does, from a block of the list of scanned cards. Answers what takes the control away again. */
	renderAddControl(block: HTMLElement, card: ScryfallCard, opts: AddControlOptions): () => void;
	/** The list of scanned cards was shown or hidden: "Add all" follows it. */
	updateAddAllButtonState(): void;
}

/** One "Add cards" window's scan. */
export interface AddCardsScan {
	/** Draws the camera button and its file input in the search bar's row (only when the setting is on for this device). */
	mountCameraButton(searchBarRow: HTMLElement): void;
	/** True while the list of scanned cards replaces the carousel. */
	isShowingScan(): boolean;
	/** A typed search shows the carousel again (the scanned cards stay in their list). */
	showSearchView(): void;
	/** The window closed: the readings stop and what was started for them is let go. */
	close(): void;
}

/** One row of the settings tab (the same shape as the tab's own rows). */
export interface CardRecognitionSettingRow {
	name: string;
	desc?: string;
	aliases?: string[];
	render?: (setting: Setting) => void | (() => void);
}

export interface CardRecognitionEntry {
	/** The scan of one "Add cards" window; null where the feature does not exist. */
	createAddCardsScan(host: AddCardsScanHost): AddCardsScan | null;
	/** The settings rows of the feature (none where it does not exist). */
	cardRecognitionSettingRows(plugin: MTGCollectionPlugin): CardRecognitionSettingRow[];
	/** The setting went off or the plugin unloads: whatever the feature keeps in memory is let go. */
	stopCardRecognition(plugin: MTGCollectionPlugin): void;
	/** Where the base of image fingerprints can be downloaded from; empty = nowhere. */
	readonly FINGERPRINT_BASE_URL: string;
}

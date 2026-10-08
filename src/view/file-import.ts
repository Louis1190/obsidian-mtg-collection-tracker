import { Notice } from "obsidian";
import { formatImportSummary } from "../core/import-summary";
import { ImportProgressModal, DecklistImportResultModal } from "../modals/import-progress-modal";
import type { MTGCollectionView } from "../view";

/* -------------------------------------------------------------------------- */
/*  Importing a file picked by the user (CSV or decklist .txt)                */
/* -------------------------------------------------------------------------- */
// The plugin's six file imports (CSV and decklist .txt, for My Collection, My Wantlists and My Decks) follow the
// same flow: file picker, progress window, plugin call, summary in a Notice, view refresh, error shown in the
// window. Written here ONCE; each section only states what changes (the accepted extension, the title, the
// plugin method, how to summarize its result) via its trigger* functions (collection-render.ts,
// wantlist-render.ts, deck-render.ts).

interface FileImport<R> {
	accept: string;
	// Title of the progress window; absent = the default one of ImportProgressModal.
	progressTitle?: string;
	run: (text: string, onStatus: (msg: string) => void) => Promise<R>;
	// See formatImportSummary: without "Done: " and without a final period.
	summarize: (result: R) => string;
	// After the view refresh; an exception here is displayed as an import error.
	afterRender?: (result: R) => void;
}

function importFromFile<R>(view: MTGCollectionView, spec: FileImport<R>) {
	const input = createEl("input");
	input.type = "file";
	input.accept = spec.accept;
	const onFilePicked = async () => {
		const file = input.files?.[0];
		if (!file) return;
		const text = await file.text();

		const modal = new ImportProgressModal(view.app, spec.progressTitle);
		modal.open();
		try {
			const result = await spec.run(text, (msg) => modal.setStatus(msg));
			const summary = spec.summarize(result);
			modal.setStatus(`Done: ${summary}.`);
			new Notice(`Import complete: ${summary}.`);
			view.render();
			spec.afterRender?.(result);
		} catch (e) {
			modal.setStatus(`Error: ${(e as Error).message}`);
		}
	};
	input.addEventListener("change", () => void onFilePicked());
	input.click();
}

// CSV: the plugin returns what it added, updated and discarded. `skippedLabel` names the discarded rows
// ("not found" for a collection/wantlist, "skipped" for a deck).
export function importCsvFile(
	view: MTGCollectionView,
	spec: {
		accept: string;
		progressTitle?: string;
		skippedLabel: string;
		run: (text: string, onStatus: (msg: string) => void) => Promise<{ added: number; updated: number; skipped: number }>;
	}
) {
	importFromFile(view, {
		accept: spec.accept,
		progressTitle: spec.progressTitle,
		run: spec.run,
		summarize: (r) => formatImportSummary(r.added, r.updated, r.skipped, spec.skippedLabel),
	});
}

// Decklist .txt (Moxfield/Archidekt/plain text) into an existing list, deck or wantlist: the lines that Scryfall
// doesn't resolve open DecklistImportResultModal (already used by NewDeckModal for the same need). `entityName`
// is read AFTER the import (a rename in the meantime is seen there); `noun` serves as a fallback if there is no
// name anymore.
export function importDecklistFile(
	view: MTGCollectionView,
	spec: {
		noun: "list" | "deck" | "wantlist";
		entityName: () => string | undefined;
		run: (text: string, onStatus: (msg: string) => void) => Promise<{ added: number; updated?: number; unresolved: string[] }>;
	}
) {
	importFromFile(view, {
		accept: ".txt,text/plain",
		progressTitle: `Importing ${spec.noun}…`,
		run: spec.run,
		summarize: (r) => formatImportSummary(r.added, r.updated, r.unresolved.length, "not found"),
		afterRender: (r) => {
			if (r.unresolved.length > 0) {
				new DecklistImportResultModal(view.app, spec.entityName() ?? spec.noun, r.added, r.unresolved).open();
			}
		},
	});
}

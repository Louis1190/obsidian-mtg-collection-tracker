import { Notice } from "obsidian";
import { formatImportSummary } from "../core/import-summary";
import { ImportProgressModal, DecklistImportResultModal } from "../modals/import-progress-modal";
import type { MTGCollectionView } from "../view";

/* -------------------------------------------------------------------------- */
/*  Importing a file picked by the user (CSV or decklist .txt)                */
/* -------------------------------------------------------------------------- */
// Les six imports de fichier du plugin (CSV et decklist .txt, pour My Collection, My Wantlists et My Decks)
// suivent le même flux : sélecteur de fichier, fenêtre de progression, appel du plugin, résumé en Notice,
// rafraîchissement de la vue, erreur affichée dans la fenêtre. Écrit ici UNE fois ; chaque section n'indique que
// ce qui change (l'extension acceptée, le titre, la méthode du plugin, comment résumer son résultat) via ses
// trigger* (collection-render.ts, wantlist-render.ts, deck-render.ts).

interface FileImport<R> {
	accept: string;
	// Titre de la fenêtre de progression ; absent = celui par défaut d'ImportProgressModal.
	progressTitle?: string;
	run: (text: string, onStatus: (msg: string) => void) => Promise<R>;
	// Voir formatImportSummary : sans « Done: » ni point final.
	summarize: (result: R) => string;
	// Après le rafraîchissement de la vue ; une exception ici s'affiche comme une erreur d'import.
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

// CSV : le plugin renvoie ce qu'il a ajouté, mis à jour et écarté. `skippedLabel` nomme les lignes écartées
// (« not found » pour une collection/wantlist, « skipped » pour un deck).
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

// Decklist .txt (Moxfield/Archidekt/texte brut) dans une liste, un deck ou une wantlist existant(e) : les lignes que
// Scryfall ne résout pas ouvrent DecklistImportResultModal (déjà utilisée par NewDeckModal pour le même besoin).
// `entityName` est lu APRÈS l'import (un renommage entre-temps y est vu) ; `noun` sert de repli s'il n'y a plus de nom.
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

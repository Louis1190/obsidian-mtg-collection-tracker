import { App, Notice, Platform } from "obsidian";
import { ExportDestinationModal } from "../modals/export-destination-modal";
import {
	DEFAULT_EXPORT_FOLDER,
	ExportContent,
	sanitizeFileName,
	shareVaultFile,
	writeExportFile,
} from "./vault-export";

export async function saveExportedFile(
	app: App,
	content: ExportContent,
	filename: string,
	mimeType: string
): Promise<void> {
	if (!Platform.isMobileApp) {
		downloadViaBrowser(content, filename, mimeType);
		return;
	}
	try {
		new ExportDestinationModal(app, content, filename).open();
	} catch (e) {
		console.error("MTG Collection Tracker: could not open the export dialog, saving directly.", e);
		await quickSaveAndShare(app, content, filename);
	}
}

function downloadViaBrowser(content: ExportContent, filename: string, mimeType: string): void {
	const blob = new Blob([content], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const a = createEl("a");
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

// Repli sans fenêtre : écrit dans le dossier par défaut puis ouvre la feuille
// de partage — exactement le comportement validé sur Android et iPad avant
// l'existence de la modale (1.0.453).
async function quickSaveAndShare(app: App, content: ExportContent, filename: string): Promise<void> {
	const safeName = sanitizeFileName(filename);

	// Créé AVANT toute opération asynchrone, dans la pile même du clic : un
	// tap sur "Export" produit ainsi un retour visible immédiat, et le bug
	// d'origine (un silence total, aucun message) ne peut plus se reproduire
	// sans qu'on sache lequel des trois cas s'est produit — aucun message du
	// tout (le code n'a pas tourné : version périmée du plugin), "Exporting…"
	// qui reste affiché (l'écriture dans la vault est bloquée), ou "Saved…"
	// sans feuille de partage (seul l'appel natif d'Obsidian est en cause).
	// Durée 0 (persistant) plutôt qu'un délai fixe : un gros export peut
	// mettre plusieurs secondes à s'écrire sur mobile, un Notice à délai fixe
	// aurait disparu avant que setMessage ne dise quoi que ce soit.
	const notice = new Notice(`Exporting ${safeName}…`, 0);
	const finish = (message: string) => {
		notice.setMessage(message);
		window.setTimeout(() => notice.hide(), 6000);
	};

	let path: string;
	try {
		path = await writeExportFile(app, DEFAULT_EXPORT_FOLDER, safeName, content);
	} catch (e) {
		// Le try englobe aussi l'accès à app.vault.adapter (dans
		// writeExportFile) : sans ça, une erreur inattendue rejetterait la
		// promesse (jetée par les appelants via `void`) sans le moindre
		// retour visible.
		console.error("MTG Collection Tracker: could not save the export file.", e);
		finish(`Could not export ${safeName}: ${e instanceof Error ? e.message : String(e)}`);
		return;
	}

	// Dit aussi où le fichier vit désormais — utile si la feuille de partage
	// ne s'ouvre pas (les .csv/.txt n'apparaissent pas dans l'explorateur
	// d'Obsidian tant que "Detect all file extensions" est désactivé, mais
	// existent bel et bien dans la vault, donc aussi dans toute synchro de
	// dossier en place).
	finish(`Saved ${safeName} to the ${DEFAULT_EXPORT_FOLDER} folder of your vault.`);
	await shareVaultFile(app, path);
}

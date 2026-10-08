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

// Fallback without a window: writes into the default folder then opens the
// share sheet — exactly the behavior validated on Android and iPad before the
// modal existed (1.0.453).
async function quickSaveAndShare(app: App, content: ExportContent, filename: string): Promise<void> {
	const safeName = sanitizeFileName(filename);

	// Created BEFORE any asynchronous operation, in the very stack of the
	// click: a tap on "Export" thus produces immediate visible feedback, and
	// the original bug (total silence, no message) can't reproduce again
	// without us knowing which of the three cases occurred — no message at all
	// (the code didn't run: stale version of the plugin), "Exporting…" that
	// stays displayed (the write into the vault is blocked), or "Saved…"
	// without a share sheet (only Obsidian's native call is at fault).
	// Duration 0 (persistent) rather than a fixed delay: a big export can take
	// several seconds to write on mobile, a Notice with a fixed delay would
	// have disappeared before setMessage says anything.
	const notice = new Notice(`Exporting ${safeName}…`, 0);
	const finish = (message: string) => {
		notice.setMessage(message);
		window.setTimeout(() => notice.hide(), 6000);
	};

	let path: string;
	try {
		path = await writeExportFile(app, DEFAULT_EXPORT_FOLDER, safeName, content);
	} catch (e) {
		// The try also encloses the access to app.vault.adapter (in
		// writeExportFile): without that, an unexpected error would reject the
		// promise (discarded by the callers via `void`) without the slightest
		// visible feedback.
		console.error("MTG Collection Tracker: could not save the export file.", e);
		finish(`Could not export ${safeName}: ${e instanceof Error ? e.message : String(e)}`);
		return;
	}

	// Also says where the file now lives — useful if the share sheet doesn't
	// open (.csv/.txt files don't appear in Obsidian's explorer while "Detect
	// all file extensions" is disabled, but do exist in the vault, hence also
	// in any folder sync in place).
	finish(`Saved ${safeName} to the ${DEFAULT_EXPORT_FOLDER} folder of your vault.`);
	await shareVaultFile(app, path);
}

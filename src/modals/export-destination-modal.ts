import { App, Modal, Notice, Platform, setIcon } from "obsidian";
import { applyModalOpenAnimation, closeModalAnimated, addModalCloseButton } from "../ui/modal-animation";
import {
	DEFAULT_EXPORT_FOLDER,
	ExportContent,
	describeDeviceFolderError,
	deviceFolderDisplayPath,
	exportTargetExists,
	folderDisplayName,
	folderSentenceName,
	getDeviceFolderSupport,
	getLastDeviceFolder,
	getLastExportFolder,
	pickDeviceFolder,
	rememberDeviceFolder,
	rememberExportFolder,
	sanitizeFileName,
	sanitizeFolderPath,
	shareVaultFile,
	writeExportFile,
	writeToDeviceFolder,
} from "../ui/vault-export";

// Beyond that, the list says to keep typing to narrow down — a vault of
// several hundred folders has no interest in rendering them all at once on a
// phone.
const MAX_FOLDER_ROWS = 150;

// "Save as" window for exports on mobile (iOS/Android), opened by
// saveExportedFile (ui/file-export.ts) — see CLAUDE.md, "File export". No
// plugin can open the system "Save as" window on mobile nor write outside the
// vault via the public API: the destination offered here is therefore a vault
// folder, and "Share…" is the way out to the rest of the device (Save to
// Files, other apps) via the native share sheet. On Android, whose share
// sheet only lists apps (no "Save to a folder", unlike iOS), a "Device
// folder…" button opens Obsidian's native folder picker to write to any
// folder of the phone — undocumented API, isolated in vault-export.ts. Once a
// folder has been used successfully, it is remembered (per device): the
// window then offers "Save to <folder>" (immediate write, no picker) and
// "Other…" to choose another.
//
// Two screens in the SAME modal (form / choice of the vault folder) rather
// than a second stacked modal: same scheme as ListSettingsModal's sub-screens
// (draw() that rewires according to a state), which keeps the round cross and
// the animation shared by all of the plugin's modals.
export class ExportDestinationModal extends Modal {
	private exportContent: ExportContent;
	private fileName: string;
	private folder: string;
	private screen: "form" | "folders" = "form";
	private folderQuery = "";
	private busy = false;
	// Token of the last "this file already exists" check: a response that
	// arrived after a more recent keystroke is ignored.
	private existsCheckId = 0;

	constructor(app: App, content: ExportContent, filename: string) {
		super(app);
		this.exportContent = content;
		this.fileName = sanitizeFileName(filename);
		this.folder = getLastExportFolder();
	}

	onOpen() {
		// Opening fade + zoom, shared by all of the plugin's modals — see
		// modal-animation.ts.
		applyModalOpenAnimation(this);
		// Round close cross + hiding of Obsidian's native cross, shared by all of
		// the plugin's modals — see modal-animation.ts.
		addModalCloseButton(this);
		this.contentEl.addClass("mtg-new-deck-modal");
		this.contentEl.addClass("mtg-export-modal");
		this.draw();
	}

	private draw() {
		this.contentEl.empty();
		if (this.screen === "folders") this.drawFolderScreen();
		else this.drawFormScreen();
	}

	private drawFormScreen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Save export" });

		const nameField = contentEl.createDiv({ cls: "mtg-search-field" });
		nameField.createEl("label", { text: "File name" });
		const nameInput = nameField.createEl("input", { type: "text" });
		nameInput.value = this.fileName;

		const folderField = contentEl.createDiv({ cls: "mtg-search-field" });
		folderField.createEl("label", { text: "Save to" });
		const folderBtn = folderField.createEl("button", { cls: "mtg-export-folder-btn" });
		setIcon(folderBtn.createSpan({ cls: "mtg-export-folder-btn-icon" }), "folder");
		folderBtn.createSpan({ cls: "mtg-export-folder-btn-label", text: folderDisplayName(this.folder) });
		setIcon(folderBtn.createSpan({ cls: "mtg-export-folder-btn-caret" }), "chevron-right");
		folderBtn.addEventListener("click", () => {
			if (this.busy) return;
			this.screen = "folders";
			this.folderQuery = "";
			this.draw();
		});

		const warningEl = contentEl.createDiv({ cls: "mtg-export-warning" });
		const errorEl = contentEl.createDiv({ cls: "mtg-error mtg-export-error" });

		const actions = contentEl.createDiv({ cls: "mtg-card-detail-actions mtg-export-actions" });
		const saveBtn = actions.createEl("button", { text: "Save", cls: "mtg-search-add-btn" });
		const shareBtn = actions.createEl("button", { text: "Share…", cls: "mtg-modal-cancel-btn" });
		// Android: with a device folder already used, "Save to <folder>" writes it
		// right away (no picker) and "Other…" chooses another; with no remembered
		// folder, a single "Device folder…" button opens the picker.
		const rememberedDevice = Platform.isAndroidApp ? getLastDeviceFolder() : null;
		let deviceQuickBtn: HTMLButtonElement | null = null;
		let deviceBtn: HTMLButtonElement | null = null;
		if (Platform.isAndroidApp) {
			if (rememberedDevice !== null) {
				const row = actions.createDiv({ cls: "mtg-export-device-row" });
				deviceQuickBtn = row.createEl("button", {
					cls: "mtg-modal-cancel-btn mtg-export-device-quick",
				});
				// The label in a <span>: text-overflow doesn't truncate (with "…") the
				// direct text of an inline-flex button, only that of a block container —
				// and a folder path can be long.
				deviceQuickBtn.createSpan({
					cls: "mtg-export-device-quick-label",
					text: `Save to ${deviceFolderDisplayPath(rememberedDevice)}`,
				});
				// The full path in a tooltip: the label may be truncated.
				deviceQuickBtn.setAttribute("title", rememberedDevice);
				deviceBtn = row.createEl("button", {
					text: "Other…",
					cls: "mtg-modal-cancel-btn mtg-export-device-other",
				});
			} else {
				deviceBtn = actions.createEl("button", { text: "Device folder…", cls: "mtg-modal-cancel-btn" });
			}
		}
		const cancelBtn = actions.createEl("button", { text: "Cancel", cls: "mtg-modal-cancel-btn" });
		contentEl.createDiv({
			cls: "mtg-export-hint",
			text: !Platform.isAndroidApp
				? "Share… hands the file to your device's share menu (Save to Files, other apps…)."
				: rememberedDevice !== null
					? "Share… opens the Android share menu. “Save to …” reuses your last device folder; “Other…” picks another one."
					: "Share… opens the Android share menu. Device folder… saves straight into a folder you pick on this phone.",
		});

		// Empty name → no write button, rather than a silent click that would do
		// nothing (same reasoning as NewListModal).
		const refresh = () => {
			const valid = sanitizeFileName(this.fileName, "") !== "";
			saveBtn.disabled = !valid || this.busy;
			shareBtn.disabled = !valid || this.busy;
			if (deviceBtn) deviceBtn.disabled = !valid || this.busy;
			if (deviceQuickBtn) deviceQuickBtn.disabled = !valid || this.busy;
			void this.refreshExistsWarning(warningEl);
		};
		nameInput.addEventListener("input", () => {
			this.fileName = nameInput.value;
			refresh();
		});
		refresh();

		const submit = async (share: boolean) => {
			const name = sanitizeFileName(this.fileName, "");
			if (name === "" || this.busy) return;
			this.busy = true;
			errorEl.setText("");
			saveBtn.disabled = true;
			shareBtn.disabled = true;
			saveBtn.setText("Saving…");
			try {
				const path = await writeExportFile(this.app, this.folder, name, this.exportContent);
				rememberExportFolder(this.folder);
				new Notice(`Saved ${name} to ${folderSentenceName(this.folder)}.`);
				this.close();
				// After the closing: the native sheet presents itself over the app, not
				// over this modal that is disappearing.
				if (share) await shareVaultFile(this.app, path);
			} catch (e) {
				console.error("MTG Collection Tracker: could not save the export file.", e);
				this.busy = false;
				saveBtn.setText("Save");
				refresh();
				errorEl.setText(`Could not save ${name}: ${e instanceof Error ? e.message : String(e)}`);
			}
		};
		saveBtn.addEventListener("click", () => void submit(false));
		shareBtn.addEventListener("click", () => void submit(true));
		cancelBtn.addEventListener("click", () => this.close());

		// Android only: direct write into a device folder — the remembered folder
		// ("Save to …") or a folder chosen in Obsidian's native picker
		// ("Other…"/"Device folder…"). Never overwrites (see writeToDeviceFolder).
		// Each failure is shown HERE, in the window, rather than letting people
		// think nothing happened.
		const saveToDevice = async (knownFolder: string | null) => {
			const name = sanitizeFileName(this.fileName, "");
			if (name === "" || this.busy) return;
			const support = getDeviceFolderSupport(this.app);
			if (!support.ok) {
				errorEl.setText(support.reason);
				return;
			}
			this.busy = true;
			errorEl.setText("");
			refresh();
			let folder = knownFolder;
			try {
				if (folder === null) {
					folder = await pickDeviceFolder();
					if (folder === null) {
						// Cancelled in the native picker: nothing to report.
						this.busy = false;
						refresh();
						return;
					}
				}
				const written = await writeToDeviceFolder(this.app, folder, name, this.exportContent);
				rememberDeviceFolder(folder);
				new Notice(`Saved ${written.name} to ${deviceFolderDisplayPath(folder)}.`);
				this.close();
			} catch (e) {
				console.error("MTG Collection Tracker: could not save to a device folder.", e);
				this.busy = false;
				refresh();
				// An already known folder may have disappeared since: say so plainly
				// rather than display the raw native error.
				const message =
					folder !== null
						? await describeDeviceFolderError(this.app, folder, e)
						: String((e as { message?: unknown } | null)?.message ?? e);
				errorEl.setText(`Could not save to a device folder: ${message}`);
			}
		};
		deviceQuickBtn?.addEventListener("click", () => void saveToDevice(rememberedDevice));
		deviceBtn?.addEventListener("click", () => void saveToDevice(null));
	}

	// Overwrites without asking on each export of the same name at the same
	// place, that's the intended behavior (an export is regenerated at any
	// time) — but with a folder AND a name chosen by hand, the user must at
	// least be warned that an existing file is going to be replaced.
	private async refreshExistsWarning(warningEl: HTMLElement) {
		const id = ++this.existsCheckId;
		const name = sanitizeFileName(this.fileName, "");
		let exists = false;
		if (name !== "") {
			try {
				exists = await exportTargetExists(this.app, this.folder, name);
			} catch {
				exists = false;
			}
		}
		if (id !== this.existsCheckId) return;
		warningEl.setText(exists ? "A file with this name already exists in this folder and will be replaced." : "");
	}

	private drawFolderScreen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Save to" });

		const searchField = contentEl.createDiv({ cls: "mtg-search-field" });
		const searchInput = searchField.createEl("input", {
			type: "text",
			placeholder: "Search, or type a new folder…",
		});
		searchInput.value = this.folderQuery;

		const paths = this.listFolderPaths();
		const listEl = contentEl.createDiv({ cls: "mtg-export-folder-list" });
		// Only rebuilds the list on each keystroke, never this <input> itself —
		// same reasoning (focus loss while typing) as
		// SelectListModal/CopyCardModal.
		const renderRows = () => this.renderFolderRows(listEl, paths, searchInput.value);
		searchInput.addEventListener("input", () => {
			this.folderQuery = searchInput.value;
			renderRows();
		});
		renderRows();

		const actions = contentEl.createDiv({ cls: "mtg-card-detail-actions" });
		const backBtn = actions.createEl("button", { text: "Back", cls: "mtg-modal-cancel-btn" });
		backBtn.addEventListener("click", () => {
			this.screen = "form";
			this.draw();
		});
	}

	// Root, default folder and current folder are always offered even if they
	// don't exist yet (the first export on a blank vault, a remembered folder
	// since deleted) — ensureFolder will create them on write.
	private listFolderPaths(): string[] {
		const set = new Set<string>(this.app.vault.getAllFolders(true).map((f) => (f.path === "" ? "/" : f.path)));
		set.add("/");
		set.add(DEFAULT_EXPORT_FOLDER);
		set.add(this.folder === "" ? "/" : this.folder);
		return Array.from(set).sort((a, b) => {
			// Root first, then the default folder, then alphabetical order.
			const rank = (p: string) => (p === "/" ? 0 : p === DEFAULT_EXPORT_FOLDER ? 1 : 2);
			return rank(a) - rank(b) || a.localeCompare(b);
		});
	}

	private renderFolderRows(listEl: HTMLElement, paths: string[], query: string) {
		listEl.empty();
		const q = query.trim().toLowerCase();
		const rows: { path: string; isNew: boolean }[] = [];

		// A typed path that matches no existing folder becomes a "Create folder"
		// row at the head of the list.
		const typed = q === "" ? null : sanitizeFolderPath(query);
		if (typed && !paths.some((p) => p.toLowerCase() === typed.toLowerCase())) {
			rows.push({ path: typed, isNew: true });
		}
		const matches = paths.filter((p) => folderDisplayName(p).toLowerCase().includes(q));
		matches.slice(0, MAX_FOLDER_ROWS).forEach((path) => rows.push({ path, isNew: false }));

		if (rows.length === 0) {
			listEl.createDiv({ cls: "mtg-export-folder-empty", text: "No matching folder." });
			return;
		}
		rows.forEach(({ path, isNew }) => {
			const row = listEl.createDiv({ cls: "mtg-export-folder-row" });
			row.toggleClass("is-selected", !isNew && path === this.folder);
			setIcon(row.createSpan({ cls: "mtg-export-folder-row-icon" }), isNew ? "folder-plus" : "folder");
			row.createSpan({
				cls: "mtg-export-folder-row-label",
				text: isNew ? `Create folder “${path}”` : folderDisplayName(path),
			});
			if (!isNew && path === DEFAULT_EXPORT_FOLDER) {
				row.createSpan({ cls: "mtg-export-folder-row-tag", text: "default" });
			}
			if (!isNew && path === this.folder) {
				setIcon(row.createSpan({ cls: "mtg-export-folder-row-check" }), "check");
			}
			row.addEventListener("click", () => {
				this.folder = path;
				this.screen = "form";
				this.draw();
			});
		});
		if (matches.length > MAX_FOLDER_ROWS) {
			listEl.createDiv({
				cls: "mtg-export-folder-empty",
				text: `Showing the first ${MAX_FOLDER_ROWS} of ${matches.length} folders — type to narrow the list.`,
			});
		}
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}

// The list of photos behind the camera button (card recognition by photo, beta). The camera is the
// system's, so it closes after every shot: instead of making the person wait for the reading, each photo becomes a block in a list at once, the readings run one after another in the
// background (the OCR engine and the finder are one CPU, and the time cap of a reading is wall time: two at once would each get half of it), and the person goes on to the next photo.
// A block is first "waiting", then the reading panel of card-scan.ts, then what the reading found (drawn by the caller), or the failure message. Nothing is ever added by itself.
//
// Everything that touches the window (the real reading, the block of a result) is handed in, so a test plays every outcome with nothing real.

import type { PhotoSource } from "../photo-input";
import type { CardScanHandle, ScanOutcome } from "./card-scan";

export type QueueItemState = "waiting" | "reading" | "cards" | "failed";
export type CardsOutcome = Extract<ScanOutcome, { kind: "cards" }>;

export interface QueueItem {
	readonly id: number;
	/**
	 * The photo, only until its reading has ended: once the item is done, failed, dismissed or the list closed, it is let go (null), so a list of fifteen scanned cards does not keep fifteen
	 * photos alive. Nothing needs it afterwards: a retake asks for a NEW photo, and the result block is made of what the reading found.
	 */
	file: PhotoSource | null;
	/** the item's own container in the list: its content is the waiting row, the reading panel, the result block or the failure */
	readonly el: HTMLElement;
	state: QueueItemState;
	/** The running reading, only while there is one: its closures reach the photo's pixels, so it is let go (null) with the file. */
	handle: CardScanHandle | null;
}

export interface ScanQueueDeps {
	/** Starts reading `file` in `el` (the real one is `startCardScan` with the window's dependencies). `onRetry` is what the panel's "Retake" and "Try another photo" call. */
	start(el: HTMLElement, file: PhotoSource, onRetry: () => void): CardScanHandle;
	/** Draws what a finished reading found in `el`, which is empty. */
	renderCards(el: HTMLElement, outcome: CardsOutcome, item: QueueItem): void;
	/** The person asked for another photo from an item (its "Retake", its "Try another photo"): the item is already gone from the list, the camera is to open. */
	onRetake(): void;
	/** The list changed: an item came, went or changed state. */
	onChange?(): void;
}

/** Lets go of what an item holds of its photo: the file, and the handle whose closures keep the decoded pixels (card-scan.ts). Safe to repeat. */
function release(item: QueueItem): void {
	item.file = null;
	item.handle = null;
}

export class ScanQueue {
	private items: QueueItem[] = [];
	private active: QueueItem | null = null;
	private nextId = 1;
	private destroyed = false;

	constructor(
		private readonly listEl: HTMLElement,
		private readonly deps: ScanQueueDeps,
	) {}

	/** How many items the list holds, whatever their state. */
	get size(): number {
		return this.items.length;
	}

	/** Whether some photo is still waiting or being read. */
	get busy(): boolean {
		return this.items.some((i) => i.state === "waiting" || i.state === "reading");
	}

	/** Puts a photo at the top of the list (the newest is the one the person looks at) and reads it as soon as the ones before it are done. */
	add(file: PhotoSource): QueueItem {
		const el = this.listEl.createDiv({ cls: "mtg-scan-item is-waiting" });
		// the newest first: createDiv appended it at the end
		this.listEl.insertBefore(el, this.listEl.firstChild);
		const item: QueueItem = { id: this.nextId++, file, el, state: "waiting", handle: null };
		this.items.push(item);
		const row = el.createDiv({ cls: "mtg-scan-item-waiting" });
		row.createSpan({ text: "Waiting for the previous photo…" });
		this.addDismissButton(row, item);
		this.deps.onChange?.();
		this.pump();
		return item;
	}

	/** Takes an item away: a waiting one never starts, a reading one is stopped, a finished one is just removed. */
	dismiss(item: QueueItem): void {
		const index = this.items.indexOf(item);
		if (index < 0) return;
		this.items.splice(index, 1);
		if (item.state === "reading") item.handle?.cancel();
		release(item);
		item.el.remove();
		this.deps.onChange?.();
		// the reading of a dismissed item ends by itself (cancelled) and starts the next one; a waiting one was never active
		if (item.state === "waiting") this.pump();
	}

	/** The window closed: everything stops, nothing is read any more. */
	destroy(): void {
		this.destroyed = true;
		for (const item of this.items) {
			item.handle?.cancel();
			release(item);
		}
		this.items = [];
		this.active = null;
	}

	private addDismissButton(host: HTMLElement, item: QueueItem): void {
		const button = host.createEl("button", { cls: "mtg-scan-item-dismiss", text: "×", attr: { "aria-label": "Remove this photo", title: "Remove this photo" } });
		button.addEventListener("click", () => this.dismiss(item));
	}

	private pump(): void {
		if (this.destroyed || this.active) return;
		const item = this.items.find((i) => i.state === "waiting");
		if (!item) return;
		item.state = "reading";
		item.el.removeClass("is-waiting");
		item.el.addClass("is-reading");
		item.el.empty();
		this.active = item;
		// a waiting item still has its photo: it is only let go when the item ends
		const handle = this.deps.start(item.el, item.file!, () => {
			this.dismiss(item);
			this.deps.onRetake();
		});
		item.handle = handle;
		this.deps.onChange?.();
		void handle.done.then((outcome) => this.finish(item, outcome));
	}

	private finish(item: QueueItem, outcome: ScanOutcome): void {
		if (this.active === item) this.active = null;
		// the reading has ended, whatever it ended with: the photo and the reading's closures are let go before anything is drawn
		release(item);
		if (this.destroyed) return;
		// dismissed while it was read, or stopped from its own panel ("Cancel"): nothing is left to show
		const present = this.items.includes(item);
		if (present && outcome.kind === "cancelled") {
			this.items.splice(this.items.indexOf(item), 1);
			item.el.remove();
		} else if (present && outcome.kind === "cards") {
			item.state = "cards";
			item.el.removeClass("is-reading");
			item.el.addClass("is-done");
			item.el.empty();
			this.deps.renderCards(item.el, outcome, item);
		} else if (present) {
			item.state = "failed";
			item.el.removeClass("is-reading");
			item.el.addClass("is-failed");
			// the failure panel stays (its message, its "Try another photo"); the item can also just be removed
			this.addDismissButton(item.el, item);
		}
		this.deps.onChange?.();
		this.pump();
	}
}

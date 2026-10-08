// Reads, text chunk by text chunk, a JSON response of the form {"meta":{…},"data":[{…},{…},…]} and hands each
// object of the "data" array to `onRow` as JSON TEXT, without ever keeping the whole response in memory. Written
// for the Card Kingdom pricelist (65 MB, 152,000 rows) on mobile: requestUrl encodes the whole response as
// base64 there (86 MB more) and the Android app crashes (OutOfMemoryError); read as a stream by fetch(), memory
// stays bounded by ONE chunk (≤ 1 MB) plus the current row.
//
// The chunk boundaries are arbitrary: they can fall in the middle of a string, of an escape (\" cut into \ then
// "), of a number. Braces and quotes inside a string don't count. Everything that precedes the array (the
// "meta") is kept in `prefix`, bounded: if the array doesn't appear within the first MAX_PREFIX characters, the
// stream is abandoned (`failed`).
const MAX_PREFIX = 100_000;
const CHAR_QUOTE = 34; // "
const CHAR_BACKSLASH = 92; // \
const CHAR_OPEN_BRACE = 123; // {
const CHAR_CLOSE_BRACE = 125; // }
const CHAR_CLOSE_BRACKET = 93; // ]

export class JsonArrayRowStream {
	private state: "seeking" | "between" | "row" | "done" = "seeking";
	private head = "";
	private row = "";
	private depth = 0;
	private inString = false;
	private escaped = false;
	private arrayPattern: RegExp;
	// The text that precedes the array, for example {"meta":{…}, — available from the first row handed to onRow.
	prefix = "";
	// True if the array was never found (a response that doesn't have the expected shape).
	failed = false;

	constructor(key: string, private onRow: (rowJson: string) => void) {
		this.arrayPattern = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*\\[`);
	}

	push(chunk: string): void {
		if (this.state === "done") return;
		if (this.state === "seeking") {
			this.head += chunk;
			const match = this.arrayPattern.exec(this.head);
			if (!match) {
				if (this.head.length > MAX_PREFIX) {
					this.failed = true;
					this.state = "done";
					this.head = "";
				}
				return;
			}
			const rest = this.head.slice(match.index + match[0].length);
			this.prefix = this.head.slice(0, match.index);
			this.head = "";
			this.state = "between";
			this.scan(rest);
			return;
		}
		this.scan(chunk);
	}

	private scan(text: string): void {
		let segmentStart = 0; // start, within `text`, of the part of the current row not yet appended to this.row
		for (let i = 0; i < text.length; i++) {
			const c = text.charCodeAt(i);
			if (this.state === "between") {
				if (c === CHAR_OPEN_BRACE) {
					this.state = "row";
					this.depth = 1;
					this.inString = false;
					this.escaped = false;
					segmentStart = i;
				} else if (c === CHAR_CLOSE_BRACKET) {
					this.state = "done";
					return;
				}
				continue;
			}
			// state === "row"
			if (this.inString) {
				if (this.escaped) this.escaped = false;
				else if (c === CHAR_BACKSLASH) this.escaped = true;
				else if (c === CHAR_QUOTE) this.inString = false;
			} else if (c === CHAR_QUOTE) {
				this.inString = true;
			} else if (c === CHAR_OPEN_BRACE) {
				this.depth++;
			} else if (c === CHAR_CLOSE_BRACE) {
				this.depth--;
				if (this.depth === 0) {
					const json = this.row + text.slice(segmentStart, i + 1);
					this.row = "";
					this.state = "between";
					this.onRow(json);
				}
			}
		}
		if (this.state === "row") this.row += text.slice(segmentStart);
	}
}

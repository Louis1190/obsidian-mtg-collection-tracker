// Lit, morceau de texte par morceau de texte, une réponse JSON de la forme {"meta":{…},"data":[{…},{…},…]} et remet chaque objet du
// tableau "data" à `onRow` sous forme de TEXTE JSON, sans jamais garder la réponse entière en mémoire. Écrit pour le tarif Card Kingdom
// (65 Mo, 152 000 lignes) sur mobile : requestUrl y encode toute la réponse en base64 (86 Mo de plus) et l'application Android plante
// (OutOfMemoryError) ; lue en flux par fetch(), la mémoire reste bornée par UN morceau (≤ 1 Mo) plus la ligne en cours.
//
// Le découpage des morceaux est quelconque : il peut tomber au milieu d'une chaîne, d'un échappement (\" coupé en \ puis "), d'un nombre.
// Les accolades et guillemets à l'intérieur d'une chaîne ne comptent pas. Tout ce qui précède le tableau (le « meta ») est gardé dans
// `prefix`, borné : si le tableau n'apparaît pas dans les premiers MAX_PREFIX caractères, le flux est abandonné (`failed`).
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
	// Le texte qui précède le tableau, par exemple {"meta":{…}, — disponible dès la première ligne remise à onRow.
	prefix = "";
	// Vrai si le tableau n'a jamais été trouvé (réponse qui n'a pas la forme attendue).
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
		let segmentStart = 0; // début, dans `text`, de la part de la ligne en cours pas encore ajoutée à this.row
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

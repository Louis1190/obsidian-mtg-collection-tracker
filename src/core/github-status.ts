
export interface GithubStatusInput {
	/** La synchronisation GitHub est activée SUR CET APPAREIL. */
	enabled: boolean;
	/** Dépôt valide ET jeton présents. */
	configured: boolean;
	state: "off" | "idle" | "syncing" | "error";
	/** Faute durable (jeton, droits, dépôt) : rien ne repartira tant que l'utilisateur n'agit pas. */
	fatal: boolean;
	message: string;
	/** Dernier échange réussi (ms), 0 = aucun depuis le démarrage. */
	lastOkAt: number;
}

export interface GithubHomeStatus {
	tone: "ok" | "warn" | "error";
	text: string;
}

function defaultClock(ms: number): string {
	return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// null = rien à montrer (synchro désactivée sur cet appareil). `clock` est injectable pour les tests.
export function githubHomeStatus(input: GithubStatusInput, clock: (ms: number) => string = defaultClock): GithubHomeStatus | null {
	if (!input.enabled) return null;
	if (!input.configured) {
		return { tone: "warn", text: "GitHub sync is on, but this device needs a repository and a token." };
	}
	if (input.state === "error") {
		if (input.fatal) {
			const reason = input.message.trim();
			return { tone: "error", text: `GitHub sync has stopped${reason ? `: ${reason}` : "."} Open the settings to fix it.` };
		}
		const since = input.lastOkAt ? ` (last synced at ${clock(input.lastOkAt)})` : "";
		return {
			tone: "warn",
			text: `GitHub isn't answering right now${since}. Your changes are kept on this device and will be sent when it does.`,
		};
	}
	if (!input.lastOkAt) return { tone: "ok", text: "Syncing with GitHub…" };
	return { tone: "ok", text: `Synced with GitHub — checked at ${clock(input.lastOkAt)}` };
}

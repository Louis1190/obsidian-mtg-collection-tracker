
export interface GithubStatusInput {
	/** GitHub synchronization is enabled ON THIS DEVICE. */
	enabled: boolean;
	/** Valid repository AND token present. */
	configured: boolean;
	state: "off" | "idle" | "syncing" | "error";
	/** Lasting fault (token, permissions, repository): nothing will be sent again until the user acts. */
	fatal: boolean;
	message: string;
	/** Last successful exchange (ms), 0 = none since startup. */
	lastOkAt: number;
}

export interface GithubHomeStatus {
	tone: "ok" | "warn" | "error";
	text: string;
}

function defaultClock(ms: number): string {
	return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// null = nothing to show (sync disabled on this device). `clock` is injectable for the tests.
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

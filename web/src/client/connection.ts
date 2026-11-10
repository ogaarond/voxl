// What the page says while the stream's connection is down, from the worker's guess
// at why (DownReason in protocol.ts).
import type { DownReason } from '../protocol';

/** "for 25 s" / "for 3 min", once the outage is long enough to be worth saying. */
function howLong(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 10) return '';
	return s < 120
		? ` (down for ${s} s)`
		: ` (down for ${Math.round(s / 60)} min)`;
}

export function downMessage(
	why: DownReason,
	detail: string | undefined,
	down: number
): string {
	switch (why) {
		case 'lost':
			return 'Connection lost. Reconnecting…';
		case 'unreachable':
			return `Can’t reach the voxl server: it may be restarting, asleep or offline. Retrying…${howLong(down)}`;
		case 'auth':
			return 'The server didn’t accept this page’s password (it may have changed). Reload the page to sign in again.';
		case 'refused':
			return detail || 'The server refused this page’s connection.';
		case 'ws':
			return `The server is up, but the stream’s connection failed; a proxy in between may not pass WebSockets. Retrying…${howLong(down)}`;
	}
}

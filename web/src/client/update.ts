// Upgrade notice: the page carries the build of the web client it was served with
// (<meta name="voxl-build">), and every hello says which build the server serves now.
// After an upgrade the socket reconnects to the new server; if the builds differ, this
// page's scripts are stale, so offer a reload (never forced: the viewer may be typing).
import type { App } from './app';
import { el } from './app';

export function createUpdateCheck(app: App) {
	const mine = document
		.querySelector<HTMLMetaElement>('meta[name="voxl-build"]')
		?.content.trim();
	const banner = el('update');
	let dismissed = '';

	el('update-reload').addEventListener('click', () => location.reload());
	el('update-close').addEventListener('click', () => {
		dismissed = banner.dataset.build || '';
		banner.classList.remove('show');
		app.kbd.focus({ preventScroll: true });
	});
	// Keep clicks on the banner off the desktop underneath.
	banner.addEventListener('pointerdown', (e) => e.stopPropagation());

	return {
		/** From each hello: the build the server serves now. */
		check(build: string | undefined) {
			// Unset on either side (an older server, or a page served without the
			// placeholder filled in) means there is nothing to compare.
			if (!build || !mine || mine.startsWith('{{')) return;
			const stale = build !== mine && build !== dismissed;
			banner.dataset.build = build;
			banner.classList.toggle('show', stale);
		},
	};
}

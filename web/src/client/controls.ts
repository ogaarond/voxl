// Controls panel: send shortcuts the viewer's own OS or browser would grab (⌘Tab,
// Ctrl+Alt+Del, Ctrl+W, ...), mute desktop audio and show the stats overlay. The
// toggles are saved in localStorage, which is per origin, so per voxl host.
import { cmd } from '../protocol';
import type { App } from './app';
import { el } from './app';

const CTRL = 0xffe3,
	ALT = 0xffe9,
	SUPER = 0xffeb,
	TAB = 0xff09,
	ESC = 0xff1b,
	UP = 0xff52,
	DEL = 0xffff,
	F4 = 0xffc1,
	SPACE = 0x20;
const ch = (c: string) => c.codePointAt(0)!;

/** A shortcut: modifiers, then the key, all as X keysyms (Super is Command on a Mac). */
interface Combo {
	label: string;
	hint: string;
	keys: number[];
}
// No Shift in these: a Mac desktop takes Shift from the character typed, so it would
// drop it from a letter or digit.
const MAC: Combo[] = [
	{ label: 'App switcher', hint: '⌘Tab', keys: [SUPER, TAB] },
	{ label: 'Spotlight', hint: '⌘Space', keys: [SUPER, SPACE] },
	{ label: 'Mission Control', hint: '⌃↑', keys: [CTRL, UP] },
	{ label: 'Force Quit', hint: '⌥⌘Esc', keys: [SUPER, ALT, ESC] },
	{ label: 'Close window', hint: '⌘W', keys: [SUPER, ch('w')] },
	{ label: 'New window', hint: '⌘N', keys: [SUPER, ch('n')] },
	{ label: 'New tab', hint: '⌘T', keys: [SUPER, ch('t')] },
	{ label: 'Lock screen', hint: '⌃⌘Q', keys: [CTRL, SUPER, ch('q')] },
];
const OTHER: Combo[] = [
	{ label: 'Ctrl+Alt+Del', hint: '', keys: [CTRL, ALT, DEL] },
	{ label: 'Switch windows', hint: 'Alt+Tab', keys: [ALT, TAB] },
	{ label: 'Start / Activities', hint: 'Super', keys: [SUPER] },
	{ label: 'Close app', hint: 'Alt+F4', keys: [ALT, F4] },
	{ label: 'Close tab', hint: 'Ctrl+W', keys: [CTRL, ch('w')] },
	{ label: 'New window', hint: 'Ctrl+N', keys: [CTRL, ch('n')] },
	{ label: 'New tab', hint: 'Ctrl+T', keys: [CTRL, ch('t')] },
	{ label: 'Lock screen', hint: 'Super+L', keys: [SUPER, ch('l')] },
];

interface Prefs {
	mute: boolean;
	stats: boolean;
}
const STORE = 'voxl.prefs';
function load(): Prefs {
	try {
		const v = JSON.parse(localStorage.getItem(STORE) || '{}');
		return { mute: v?.mute === true, stats: v?.stats === true };
	} catch {
		return { mute: false, stats: false };
	}
}
function save(p: Prefs) {
	try {
		localStorage.setItem(STORE, JSON.stringify(p));
	} catch {
		// Storage blocked: the setting lasts this visit.
	}
}

export function createControls(
	app: App,
	hooks: { setMute(on: boolean): void; setStats(on: boolean): void }
) {
	const prefs = load();
	const panel = el('controls');
	const grid = el('controls-keys');
	const audioRow = el('controls-audio-row');
	const keysSection = el('controls-keys-section');
	const audio = el<HTMLInputElement>('controls-audio');
	const stats = el<HTMLInputElement>('controls-stats');
	// ?stats in the URL turns the overlay on regardless of the saved setting.
	const statsUrl = new URLSearchParams(location.search).has('stats');
	let renderedFor: boolean | null = null;

	function sendCombo(keys: number[]) {
		for (const k of keys) app.send(cmd.key(k, true));
		for (let i = keys.length - 1; i >= 0; i--)
			app.send(cmd.key(keys[i], false));
	}
	function renderKeys() {
		if (renderedFor === app.remoteMac) return;
		renderedFor = app.remoteMac;
		grid.textContent = '';
		for (const c of app.remoteMac ? MAC : OTHER) {
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'c-key';
			const l = document.createElement('span');
			l.textContent = c.label;
			b.append(l);
			if (c.hint) {
				const h = document.createElement('kbd');
				h.textContent = c.hint;
				b.append(h);
			}
			b.addEventListener('click', () => {
				sendCombo(c.keys);
				app.kbd.focus({ preventScroll: true });
			});
			grid.append(b);
		}
	}

	audio.checked = !prefs.mute;
	stats.checked = prefs.stats || statsUrl;
	hooks.setMute(prefs.mute);
	hooks.setStats(stats.checked);
	audio.addEventListener('change', () => {
		prefs.mute = !audio.checked;
		save(prefs);
		hooks.setMute(prefs.mute);
	});
	stats.addEventListener('change', () => {
		prefs.stats = stats.checked;
		save(prefs);
		hooks.setStats(stats.checked);
	});

	const isOpen = () => panel.classList.contains('open');
	function open() {
		// One panel at a time: they share the top-right corner.
		for (const [id, closeBtn] of [
			['files', 'files-close'],
			['keys', 'keys-close'],
		])
			if (document.getElementById(id)?.classList.contains('open'))
				el(closeBtn).click();
		renderKeys();
		panel.classList.add('open');
	}
	function close() {
		panel.classList.remove('open');
		app.kbd.focus({ preventScroll: true });
	}
	el('controls-btn').addEventListener('click', () =>
		isOpen() ? close() : open()
	);
	el('controls-close').addEventListener('click', close);
	for (const id of ['files-btn', 'keys-btn'])
		el(id).addEventListener('click', () => {
			if (isOpen()) close();
		});
	document.addEventListener('keydown', (e) => {
		if (
			e.key === 'Escape' &&
			isOpen() &&
			e.target !== app.kbd &&
			e.target !== app.surface
		)
			close();
	});

	return {
		/**
		 * From each hello: hide the audio switch when the server sends no audio, and
		 * the shortcuts when the viewer is read-only (the server would drop them).
		 */
		setup(hasAudio: boolean, readOnly: boolean) {
			audioRow.style.display = hasAudio ? '' : 'none';
			keysSection.style.display = readOnly ? 'none' : '';
			if (isOpen()) renderKeys();
		},
	};
}

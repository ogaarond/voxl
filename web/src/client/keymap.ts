// Key mapping panel: remap a key on the viewer's keyboard to another key on the
// desktop (Left Alt as Command, Caps Lock as Escape, ...). Mappings are keyed by the
// physical key (KeyboardEvent.code) and saved in this browser's localStorage, which is
// per origin, so each voxl host keeps its own.
import type { App } from './app';
import { el } from './app';

/** A key the desktop can receive: its X keysym and how each kind of desktop names it. */
interface Target {
	id: string;
	ks: number;
	mac: string;
	other: string;
}
/** Keysym 0: the key does nothing on the desktop. */
const DISABLED = 'none';
const TARGETS: Target[] = [
	{
		id: 'MetaLeft',
		ks: 0xffeb,
		mac: 'Left Command',
		other: 'Left Super / Win',
	},
	{
		id: 'MetaRight',
		ks: 0xffec,
		mac: 'Right Command',
		other: 'Right Super / Win',
	},
	{ id: 'AltLeft', ks: 0xffe9, mac: 'Left Option', other: 'Left Alt' },
	{ id: 'AltRight', ks: 0xffea, mac: 'Right Option', other: 'Right Alt' },
	{ id: 'ControlLeft', ks: 0xffe3, mac: 'Left Control', other: 'Left Ctrl' },
	{ id: 'ControlRight', ks: 0xffe4, mac: 'Right Control', other: 'Right Ctrl' },
	{ id: 'ShiftLeft', ks: 0xffe1, mac: 'Left Shift', other: 'Left Shift' },
	{ id: 'ShiftRight', ks: 0xffe2, mac: 'Right Shift', other: 'Right Shift' },
	{ id: 'CapsLock', ks: 0xffe5, mac: 'Caps Lock', other: 'Caps Lock' },
	{ id: 'Escape', ks: 0xff1b, mac: 'Escape', other: 'Escape' },
	{ id: 'Tab', ks: 0xff09, mac: 'Tab', other: 'Tab' },
	{ id: 'Enter', ks: 0xff0d, mac: 'Return', other: 'Enter' },
	{
		id: 'Backspace',
		ks: 0xff08,
		mac: 'Delete (Backspace)',
		other: 'Backspace',
	},
	{ id: 'Delete', ks: 0xffff, mac: 'Forward Delete', other: 'Delete' },
	{ id: 'Insert', ks: 0xff63, mac: 'Help / Insert', other: 'Insert' },
	{ id: 'ContextMenu', ks: 0xff67, mac: 'Menu', other: 'Menu' },
	{
		id: DISABLED,
		ks: 0,
		mac: 'Nothing (disabled)',
		other: 'Nothing (disabled)',
	},
];
const BY_ID = new Map(TARGETS.map((t) => [t.id, t]));
const STORE = 'voxl.keymap';

function load(): Record<string, string> {
	try {
		const v = JSON.parse(localStorage.getItem(STORE) || '{}');
		if (!v || typeof v !== 'object') return {};
		const out: Record<string, string> = {};
		for (const [k, t] of Object.entries(v))
			if (typeof t === 'string' && BY_ID.has(t)) out[k] = t;
		return out;
	} catch {
		return {};
	}
}
function save(m: Record<string, string>) {
	try {
		localStorage.setItem(STORE, JSON.stringify(m));
	} catch {
		// Storage blocked (private window, site data off): the mapping lasts this visit.
	}
}

/** A physical key's name on the viewer's keyboard: "Left Alt", "A", "F5". */
function keyName(code: string, isMac: boolean): string {
	const m = /^(Shift|Control|Alt|Meta|OS)(Left|Right)$/.exec(code);
	if (m) {
		const base =
			m[1] === 'Control'
				? isMac
					? 'Control'
					: 'Ctrl'
				: m[1] === 'Alt'
					? isMac
						? 'Option'
						: 'Alt'
					: m[1] === 'Shift'
						? 'Shift'
						: isMac
							? 'Command'
							: 'Windows';
		return `${m[2]} ${base}`;
	}
	if (/^Key[A-Z]$/.test(code)) return code.slice(3);
	if (/^Digit\d$/.test(code)) return code.slice(5);
	if (code.startsWith('Numpad')) return 'Numpad ' + code.slice(6);
	return code.replace(/([a-z])([A-Z])/g, '$1 $2');
}

export function createKeymap(app: App) {
	let map = load();
	const panel = el('keys');
	const list = el('keys-list');
	const addBtn = el<HTMLButtonElement>('keys-add');
	const addLabel = addBtn.querySelector('span')!;
	let capturing = false;

	function render() {
		list.textContent = '';
		const codes = Object.keys(map);
		if (!codes.length) {
			const e = document.createElement('div');
			e.className = 'k-empty';
			e.textContent =
				'No keys remapped. Add a mapping, then press the key on your keyboard you want to change.';
			list.append(e);
			return;
		}
		for (const code of codes) {
			const row = document.createElement('div');
			row.className = 'k-row';
			const from = document.createElement('span');
			from.className = 'k-from';
			from.textContent = keyName(code, app.isMac);
			const arrow = document.createElement('span');
			arrow.className = 'k-arrow';
			arrow.textContent = '→';
			const sel = document.createElement('select');
			sel.setAttribute('aria-label', `What ${from.textContent} sends`);
			for (const t of TARGETS) {
				const o = document.createElement('option');
				o.value = t.id;
				o.textContent = app.remoteMac ? t.mac : t.other;
				sel.append(o);
			}
			sel.value = map[code];
			sel.addEventListener('change', () => {
				map[code] = sel.value;
				save(map);
			});
			const del = document.createElement('button');
			del.type = 'button';
			del.className = 'ib sm';
			del.title = 'Remove';
			del.setAttribute('aria-label', `Remove mapping for ${from.textContent}`);
			del.innerHTML =
				'<svg class="i" viewBox="0 0 24 24" fill="none"><path d="M8 8L16 16M16 8L8 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
			del.addEventListener('click', () => {
				delete map[code];
				save(map);
				render();
			});
			row.append(from, arrow, sel, del);
			list.append(row);
		}
	}

	function setCapturing(on: boolean) {
		capturing = on;
		addBtn.classList.toggle('on', on);
		addLabel.textContent = on
			? 'Press a key… (click to cancel)'
			: 'Add mapping';
	}
	// While adding, the next key pressed anywhere is the key to remap, Esc included;
	// it doesn't reach the desktop or the page's other shortcuts.
	window.addEventListener(
		'keydown',
		(e) => {
			if (!capturing) return;
			e.preventDefault();
			e.stopImmediatePropagation();
			if (!e.code) return;
			setCapturing(false);
			if (!map[e.code])
				map[e.code] = app.remoteMac ? 'MetaLeft' : 'ControlLeft';
			save(map);
			render();
			list
				.querySelector<HTMLSelectElement>('.k-row:last-child select')
				?.focus();
		},
		true
	);
	window.addEventListener(
		'keyup',
		(e) => {
			if (capturing) e.stopImmediatePropagation();
		},
		true
	);
	addBtn.addEventListener('click', () => setCapturing(!capturing));

	function open() {
		// One panel at a time: the Files panel sits in the same corner.
		const files = document.getElementById('files');
		if (files?.classList.contains('open')) el('files-close').click();
		render();
		panel.classList.add('open');
	}
	function close() {
		setCapturing(false);
		panel.classList.remove('open');
		app.kbd.focus({ preventScroll: true });
	}
	el('keys-btn').addEventListener('click', () =>
		panel.classList.contains('open') ? close() : open()
	);
	el('keys-close').addEventListener('click', close);
	document.addEventListener('keydown', (e) => {
		if (
			e.key === 'Escape' &&
			panel.classList.contains('open') &&
			e.target !== app.kbd &&
			e.target !== app.surface
		)
			close();
	});
	el('files-btn').addEventListener('click', () => {
		if (panel.classList.contains('open')) close();
	});

	return {
		/** The keysym a physical key is remapped to: undefined if it isn't, 0 if disabled. */
		get(code: string): number | undefined {
			const id = map[code];
			return id === undefined ? undefined : BY_ID.get(id)!.ks;
		},
	};
}

export type Keymap = ReturnType<typeof createKeymap>;

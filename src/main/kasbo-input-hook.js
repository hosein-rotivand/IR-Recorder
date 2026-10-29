'use strict';

const EventEmitter = require('events');
const { screen } = require('electron');

let uIOhook = null;
let UiohookKey = {};
let kasboHookLoadError = null;

try {
	({ uIOhook, UiohookKey } = require('uiohook-napi'));
} catch (err) {
	kasboHookLoadError = err;
}

const KASBO_MODIFIER_NAMES = ['Ctrl', 'CtrlRight', 'Alt', 'AltRight', 'Shift', 'ShiftRight', 'Meta', 'MetaRight'];

const KASBO_KEY_LABELS = {
	Escape: 'Esc',
	Enter: 'Enter',
	Backspace: '⌫',
	Delete: 'Del',
	Tab: 'Tab',
	Space: 'Space',
	CapsLock: 'Caps',
	ArrowUp: '↑',
	ArrowDown: '↓',
	ArrowLeft: '←',
	ArrowRight: '→',
	PageUp: 'PgUp',
	PageDown: 'PgDn',
	PrintScreen: 'PrtSc',
	Semicolon: ';',
	Equal: '=',
	Comma: ',',
	Minus: '-',
	Period: '.',
	Slash: '/',
	Backquote: '`',
	BracketLeft: '[',
	Backslash: '\\',
	BracketRight: ']',
	Quote: '\'',
	NumpadMultiply: '*',
	NumpadAdd: '+',
	NumpadSubtract: '-',
	NumpadDecimal: '.',
	NumpadDivide: '/'
};

// Keys that are worth showing even without a modifier in "shortcuts" mode.
const KASBO_SPECIAL_KEYS = new Set(['Esc', 'Enter', 'Tab', 'Del', 'PrtSc']);

/**
 * Builds keycode -> label lookup from uiohook's key table.
 */
function kasboBuildKeyMap() {
	const map = new Map();
	const modifiers = new Set();
	for (const [name, code] of Object.entries(UiohookKey)) {
		if (KASBO_MODIFIER_NAMES.includes(name)) {
			modifiers.add(code);
			continue;
		}
		if (map.has(code)) {
			continue;
		}
		let label = KASBO_KEY_LABELS[name] || name;
		if (/^Numpad\d$/.test(name)) {
			label = name.slice(-1);
		}
		map.set(code, label);
	}
	return { map, modifiers };
}

class KasboInputHook extends EventEmitter {
	constructor() {
		super();
		this.running = false;
		this.cursorTimer = null;
		this.lastCursor = { x: NaN, y: NaN };
		this.keyMap = kasboBuildKeyMap();
		this.onMouseDown = this.onMouseDown.bind(this);
		this.onKeyDown = this.onKeyDown.bind(this);
	}

	get isAvailable() {
		return !!uIOhook;
	}

	get loadError() {
		return kasboHookLoadError ? String(kasboHookLoadError.message || kasboHookLoadError) : null;
	}

	start() {
		if (this.running) {
			return;
		}
		this.running = true;

		// Cursor position is polled natively; it is cheap and needs no hook.
		this.cursorTimer = setInterval(() => {
			const p = screen.getCursorScreenPoint();
			if (p.x !== this.lastCursor.x || p.y !== this.lastCursor.y) {
				this.lastCursor = p;
				this.emit('cursor', { x: p.x, y: p.y });
			}
		}, 16);

		if (uIOhook) {
			uIOhook.on('mousedown', this.onMouseDown);
			uIOhook.on('keydown', this.onKeyDown);
			try {
				uIOhook.start();
			} catch (err) {
				console.error('[kasbo] Input hook failed to start:', err);
			}
		}
	}

	stop() {
		if (!this.running) {
			return;
		}
		this.running = false;
		clearInterval(this.cursorTimer);
		this.cursorTimer = null;
		this.lastCursor = { x: NaN, y: NaN };

		if (uIOhook) {
			uIOhook.removeListener('mousedown', this.onMouseDown);
			uIOhook.removeListener('keydown', this.onKeyDown);
			try {
				uIOhook.stop();
			} catch (err) {
				console.error('[kasbo] Input hook failed to stop:', err);
			}
		}
	}

	onMouseDown(e) {
		// Hook coordinates are physical pixels; Electron's cursor point is DIP like everything else.
		const p = screen.getCursorScreenPoint();
		this.emit('click', { x: p.x, y: p.y, button: e.button });
	}

	onKeyDown(e) {
		if (this.keyMap.modifiers.has(e.keycode)) {
			return;
		}
		const label = this.keyMap.map.get(e.keycode);
		if (!label) {
			return;
		}
		this.emit('key', {
			key: label,
			ctrl: !!e.ctrlKey,
			alt: !!e.altKey,
			shift: !!e.shiftKey,
			meta: !!e.metaKey,
			printable: label.length === 1,
			special: KASBO_SPECIAL_KEYS.has(label) || /^F\d{1,2}$/.test(label)
		});
	}
}

module.exports = { KasboInputHook };

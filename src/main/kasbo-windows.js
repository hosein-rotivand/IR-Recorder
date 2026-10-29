'use strict';

const path = require('path');
const { BrowserWindow } = require('electron');

const KASBO_RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const KASBO_PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const KASBO_ICON = path.join(__dirname, '..', 'assets', 'icon.png');

function kasboWebPreferences(extra = {}) {
	return {
		preload: KASBO_PRELOAD,
		contextIsolation: true,
		sandbox: true,
		nodeIntegration: false,
		webSecurity: true,
		spellcheck: false,
		...extra
	};
}

function kasboPage(name) {
	return path.join(KASBO_RENDERER_DIR, name, 'index.html');
}

class KasboWindows {
	constructor() {
		this.panel = null;
		this.spareRecorder = null;
	}

	createPanel() {
		const win = new BrowserWindow({
			width: 460,
			height: 820,
			minWidth: 420,
			minHeight: 620,
			show: false,
			title: 'IR Recorder',
			icon: KASBO_ICON,
			backgroundColor: '#0D0F13',
			autoHideMenuBar: true,
			titleBarStyle: 'hidden',
			titleBarOverlay: {
				color: '#0D0F13',
				symbolColor: '#8B93A3',
				height: 40
			},
			webPreferences: kasboWebPreferences()
		});
		win.once('ready-to-show', () => win.show());
		win.loadFile(kasboPage('panel'));
		this.panel = win;
		return win;
	}

	/**
	 * Every creator returns the window right away; `win.kasboReady` resolves once the page has loaded.
	 * Transparent full-display layer used for region selection, countdown and drawing.
	 * Content protection keeps it out of the capture on Windows 10 2004+.
	 */
	createOverlay(display) {
		const { x, y, width, height } = display.bounds;
		const win = new BrowserWindow({
			x, y, width, height,
			frame: false,
			transparent: true,
			resizable: false,
			movable: false,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			skipTaskbar: true,
			hasShadow: false,
			alwaysOnTop: true,
			enableLargerThanScreen: true,
			show: false,
			backgroundColor: '#00000000',
			webPreferences: kasboWebPreferences()
		});
		win.setAlwaysOnTop(true, 'screen-saver');
		win.setContentProtection(true);
		win.setBounds(display.bounds);
		win.kasboReady = win.loadFile(kasboPage('overlay'));
		win.kasboReady.catch(() => {});
		return win;
	}

	/**
	 * Keeps one loaded recorder page ready so recording starts without waiting for a page load.
	 */
	prewarmRecorder() {
		if (!this.spareRecorder || this.spareRecorder.isDestroyed()) {
			this.spareRecorder = this.createRecorder();
		}
	}

	takeRecorder() {
		const spare = this.spareRecorder;
		this.spareRecorder = null;
		return spare && !spare.isDestroyed() ? spare : this.createRecorder();
	}

	createRecorder() {
		const win = new BrowserWindow({
			width: 320,
			height: 240,
			show: false,
			skipTaskbar: true,
			webPreferences: kasboWebPreferences({ backgroundThrottling: false })
		});
		win.kasboReady = win.loadFile(kasboPage('recorder'));
		win.kasboReady.catch(() => {});
		return win;
	}

	createControlBar(display) {
		const width = 384;
		const height = 64;
		const area = display.workArea;
		const win = new BrowserWindow({
			width,
			height,
			x: Math.round(area.x + (area.width - width) / 2),
			y: Math.round(area.y + area.height - height - 24),
			frame: false,
			transparent: true,
			resizable: false,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			skipTaskbar: true,
			hasShadow: false,
			alwaysOnTop: true,
			show: false,
			backgroundColor: '#00000000',
			webPreferences: kasboWebPreferences()
		});
		win.setAlwaysOnTop(true, 'screen-saver', 1);
		win.setContentProtection(true);
		win.kasboReady = win.loadFile(kasboPage('controlbar')).then(() => {
			if (!win.isDestroyed()) {
				win.showInactive();
			}
		}).catch(() => {});
		return win;
	}

	static destroy(win) {
		if (win && !win.isDestroyed()) {
			win.destroy();
		}
	}
}

module.exports = { KasboWindows };

'use strict';

const fsp = require('fs').promises;
const {
	app,
	ipcMain,
	session,
	screen,
	dialog,
	shell,
	globalShortcut,
	Menu
} = require('electron');
const { KasboSettings } = require('./kasbo-settings');
const { KasboWindows } = require('./kasbo-windows');
const { KasboInputHook } = require('./kasbo-input-hook');
const { KasboEncoder } = require('./kasbo-encoder');
const { KasboRecordingSession } = require('./kasbo-session');

const KASBO_HOTKEYS = {
	'Alt+Shift+R': (s) => s.toggleRecord(),
	'Alt+Shift+P': (s) => s.togglePause(),
	'Alt+Shift+D': (s) => s.toggleDraw(),
	'Alt+Shift+X': (s) => s.clearDrawings(),
	'Alt+Shift+Z': (s) => s.toggleZoom(),
	'Alt+Shift+F': (s) => s.toggleFollow(),
	'Alt+Shift+C': (s) => s.cycleWebcamCorner(),
	'Alt+Shift+M': (s) => s.toggleMic()
};

const KASBO_ALLOWED_PERMISSIONS = new Set(['media', 'display-capture']);

class KasboApp {
	constructor() {
		this.settings = null;
		this.windows = null;
		this.inputHook = null;
		this.encoder = null;
		this.recSession = null;
		this.failedHotkeys = [];
	}

	init() {
		if (!app.requestSingleInstanceLock()) {
			app.quit();
			return;
		}

		app.on('second-instance', () => this.focusPanel());
		app.on('window-all-closed', () => app.quit());
		app.on('will-quit', () => {
			globalShortcut.unregisterAll();
			if (this.recSession) {
				this.recSession.shutdown();
			}
		});
		app.on('web-contents-created', (_event, contents) => {
			contents.setWindowOpenHandler(() => ({ action: 'deny' }));
			contents.on('will-navigate', (e) => e.preventDefault());
		});

		app.whenReady().then(() => this.onReady());
	}

	onReady() {
		Menu.setApplicationMenu(null);

		this.settings = new KasboSettings();
		this.windows = new KasboWindows();
		this.inputHook = new KasboInputHook();
		this.encoder = new KasboEncoder();
		this.recSession = new KasboRecordingSession({
			settings: this.settings,
			windows: this.windows,
			inputHook: this.inputHook,
			encoder: this.encoder
		});

		this.configureSession();
		this.registerIpc();
		this.registerHotkeys();

		this.recSession.on('status', (status) => {
			this.sendPanel('panel:status', status);
			if (status.state === 'idle') {
				// Ready the next recording engine in the background.
				setTimeout(() => this.windows.prewarmRecorder(), 400);
			}
		});

		const panel = this.windows.createPanel();
		// The hidden spare recorder must not keep the app alive.
		panel.on('closed', () => app.quit());
		panel.once('ready-to-show', () => setTimeout(() => this.windows.prewarmRecorder(), 600));
	}

	configureSession() {
		const ses = session.defaultSession;
		const isAppPage = (url) => typeof url === 'string' && url.startsWith('file://');

		ses.setPermissionRequestHandler((wc, permission, callback, details) => {
			const url = (details && details.requestingUrl) || wc.getURL();
			callback(KASBO_ALLOWED_PERMISSIONS.has(permission) && isAppPage(url));
		});
		ses.setPermissionCheckHandler((wc, permission) => {
			return KASBO_ALLOWED_PERMISSIONS.has(permission) && !!wc && isAppPage(wc.getURL());
		});
		ses.setDisplayMediaRequestHandler(
			(request, callback) => this.recSession.handleDisplayMediaRequest(request, callback),
			{ useSystemPicker: false }
		);
	}

	registerHotkeys() {
		for (const [accelerator, action] of Object.entries(KASBO_HOTKEYS)) {
			const ok = globalShortcut.register(accelerator, () => action(this.recSession));
			if (!ok) {
				this.failedHotkeys.push(accelerator);
			}
		}
	}

	isPanel(event) {
		const panel = this.windows.panel;
		return !!panel && !panel.isDestroyed() && event.sender === panel.webContents;
	}

	isCtxWindow(event, key) {
		const ctx = this.recSession.ctx;
		return !!ctx && this.recSession.isSender(event, ctx[key]);
	}

	registerIpc() {
		const rs = this.recSession;

		const panelHandle = (channel, handler) => {
			ipcMain.handle(channel, (event, ...args) => {
				if (!this.isPanel(event)) {
					throw new Error('Forbidden');
				}
				return handler(...args);
			});
		};
		const ctxHandle = (channel, key, handler) => {
			ipcMain.handle(channel, (event, ...args) => (this.isCtxWindow(event, key) ? handler(...args) : null));
		};
		const ctxOn = (channel, key, handler) => {
			ipcMain.on(channel, (event, ...args) => {
				if (this.isCtxWindow(event, key)) {
					handler(...args);
				}
			});
		};

		/* Panel */
		panelHandle('app:get-info', () => ({
			version: app.getVersion(),
			platform: process.platform,
			ffmpeg: this.encoder.isAvailable,
			inputHook: this.inputHook.isAvailable,
			failedHotkeys: [...this.failedHotkeys],
			outputDir: this.settings.getOutputDir(),
			state: rs.state
		}));
		panelHandle('settings:get', () => this.settings.get());
		panelHandle('settings:update', (patch) => this.settings.update(patch));
		panelHandle('displays:list', () => {
			const primaryId = screen.getPrimaryDisplay().id;
			return screen.getAllDisplays().map((d, i) => ({
				id: d.id,
				index: i + 1,
				width: Math.round(d.bounds.width * d.scaleFactor),
				height: Math.round(d.bounds.height * d.scaleFactor),
				primary: d.id === primaryId
			}));
		});
		panelHandle('session:start', () => {
			rs.start();
			return true;
		});
		panelHandle('app:choose-folder', async () => {
			const result = await dialog.showOpenDialog(this.windows.panel, {
				properties: ['openDirectory', 'createDirectory'],
				defaultPath: this.settings.getOutputDir()
			});
			if (result.canceled || !result.filePaths[0]) {
				return null;
			}
			this.settings.update({ outputDir: result.filePaths[0] });
			return this.settings.getOutputDir();
		});
		panelHandle('app:open-output-dir', async () => {
			const dir = this.settings.getOutputDir();
			await fsp.mkdir(dir, { recursive: true });
			return shell.openPath(dir);
		});
		panelHandle('app:open-file', (file) => (rs.isKnownOutput(file) ? shell.openPath(file) : 'denied'));
		panelHandle('app:reveal-file', (file) => {
			if (rs.isKnownOutput(file)) {
				shell.showItemInFolder(file);
			}
			return true;
		});

		/* Overlay */
		ctxHandle('overlay:get-config', 'overlay', () => rs.getOverlayConfig());
		ctxOn('overlay:confirm', 'overlay', (rect) => rs.confirmRegion(rect));
		ctxOn('overlay:cancel', 'overlay', () => rs.cancel());
		ctxOn('overlay:countdown-done', 'overlay', () => rs.countdownDone());
		ctxOn('overlay:exit-draw', 'overlay', () => rs.toggleDraw(false));
		ctxOn('draw:update', 'overlay', (stroke) => rs.updateStroke(stroke));
		ctxOn('draw:remove', 'overlay', (id) => rs.removeStroke(id));
		ctxOn('draw:clear', 'overlay', () => rs.clearDrawings());

		/* Recorder */
		ctxHandle('recorder:get-config', 'recorder', () => rs.getRecorderConfig());
		ctxOn('recorder:chunk', 'recorder', (data) => rs.writeChunk(data));
		ctxOn('recorder:finished', 'recorder', () => rs.recorderFinished());
		ctxOn('recorder:region', 'recorder', (pos) => rs.forwardRegion(pos));
		ctxOn('recorder:fatal', 'recorder', (message) => {
			console.error('[kasbo] Recorder fatal:', message);
			rs.stop();
		});

		/* Control bar */
		ctxHandle('ctrl:get-state', 'controlBar', () => rs.getControlState());
		ctxOn('ctrl:action', 'controlBar', (action) => rs.handleControlAction(action));
	}

	sendPanel(channel, payload) {
		const panel = this.windows && this.windows.panel;
		if (panel && !panel.isDestroyed()) {
			panel.webContents.send(channel, payload);
		}
	}

	focusPanel() {
		const panel = this.windows && this.windows.panel;
		if (panel && !panel.isDestroyed() && this.recSession.state === 'idle') {
			if (panel.isMinimized()) {
				panel.restore();
			}
			panel.show();
			panel.focus();
		}
	}
}

new KasboApp().init();

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { screen, desktopCapturer } = require('electron');
const { KasboWindows } = require('./kasbo-windows');
const { kasboIsRect } = require('./kasbo-settings');

const KASBO_FPS = 60;
const KASBO_MAX_LONG_SIDE = 2560;
const KASBO_MIN_REGION = 120;

const KASBO_PRESETS = {
	reels: { aspect: 9 / 16, width: 1080, height: 1920, label: 'Reels' },
	youtube: { aspect: 16 / 9, width: 1920, height: 1080, label: 'YouTube' },
	custom: { aspect: null, label: 'Browser' },
	fullscreen: { aspect: null, label: 'Screen' }
};

const KASBO_WEBCAM_CORNERS = ['bottom-right', 'bottom-left', 'top-left', 'top-right'];
const KASBO_DRAW_TOOLS = ['pen', 'arrow', 'rect'];
const KASBO_ACTIVE_STATES = ['recording', 'paused'];
const KASBO_STARTING_STATES = ['selecting', 'preparing', 'countdown'];

class KasboCancelled extends Error {}

function kasboEven(v) {
	return Math.max(2, Math.round(v / 2) * 2);
}

function kasboClamp(v, min, max) {
	return Math.min(max, Math.max(min, v));
}

function kasboDeferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	promise.catch(() => {});
	return { promise, resolve, reject };
}

function kasboWithTimeout(promise, ms, message) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), ms);
		})
	]).finally(() => clearTimeout(timer));
}

function kasboTimestamp() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/**
 * Orchestrates one recording: region selection -> capture -> countdown -> record -> encode.
 */
class KasboRecordingSession extends EventEmitter {
	constructor({ settings, windows, inputHook, encoder }) {
		super();
		this.settings = settings;
		this.windows = windows;
		this.inputHook = inputHook;
		this.encoder = encoder;
		this.state = 'idle';
		this.ctx = null;
		this.pendingCapture = null;
		this.outputs = new Set();

		this.onCursor = (p) => this.forwardInput('input:cursor', p);
		this.onClick = (p) => this.forwardInput('input:click', p);
		this.onKey = (k) => this.forwardInput('input:key', k);
	}

	/* ------------------------------------------------------------------ state */

	setState(state, extra = {}) {
		this.state = state;
		this.emit('status', { state, ...extra });
		this.pushControlState();
	}

	isActive() {
		return KASBO_ACTIVE_STATES.includes(this.state);
	}

	isSender(event, win) {
		return !!win && !win.isDestroyed() && event.sender === win.webContents;
	}

	/* ------------------------------------------------------------------ start */

	async start() {
		if (this.state !== 'idle') {
			return false;
		}

		const settings = this.settings.get();
		const display = this.resolveDisplay(settings.displayId);
		const ctx = {
			settings,
			display,
			mode: settings.mode,
			region: null,
			overlay: null,
			recorder: null,
			controlBar: null,
			select: null,
			countdown: null,
			finished: null,
			writeStream: null,
			tempFile: null,
			outputSize: null,
			recorderInfo: null,
			cancelled: false,
			startedAt: 0,
			pausedAt: 0,
			pausedTotal: 0,
			micMuted: false,
			drawing: false,
			zoom: settings.autoZoom,
			follow: settings.followCursor && settings.mode !== 'fullscreen',
			webcamCorner: settings.webcamCorner
		};
		this.ctx = ctx;
		this.setState('selecting');

		if (this.windows.panel && !this.windows.panel.isDestroyed()) {
			this.windows.panel.hide();
		}

		try {
			ctx.overlay = this.windows.createOverlay(display);
			ctx.overlay.on('closed', () => {
				if (this.ctx === ctx && KASBO_STARTING_STATES.includes(this.state)) {
					this.cancel();
				}
			});
			await ctx.overlay.kasboReady;
			this.throwIfCancelled(ctx);

			if (ctx.mode === 'fullscreen') {
				ctx.region = { ...display.bounds };
			} else {
				ctx.select = kasboDeferred();
				ctx.overlay.show();
				ctx.overlay.focus();
				ctx.region = await ctx.select.promise;
				this.settings.setRegion(ctx.mode, ctx.region);
			}
			this.throwIfCancelled(ctx);

			// Overlay becomes a click-through frame from here on.
			ctx.overlay.setIgnoreMouseEvents(true);
			this.sendOverlay('overlay:phase', { phase: 'preparing', region: this.toLocal(ctx.region) });
			this.setState('preparing');

			await this.prepareCapture(ctx);
			this.throwIfCancelled(ctx);

			this.setState('countdown');
			ctx.countdown = kasboDeferred();
			if (!ctx.overlay.isVisible()) {
				ctx.overlay.showInactive();
			}
			this.sendOverlay('overlay:phase', {
				phase: 'record',
				region: this.toLocal(ctx.region),
				countdown: settings.countdown ? 3 : 0,
				showFrame: ctx.mode !== 'fullscreen'
			});
			await kasboWithTimeout(ctx.countdown.promise, 15000, 'Countdown timed out.');
			this.throwIfCancelled(ctx);

			this.beginRecording(ctx);
			return true;
		} catch (err) {
			if (err instanceof KasboCancelled) {
				this.cleanup();
			} else {
				this.fail(err);
			}
			return false;
		}
	}

	throwIfCancelled(ctx) {
		if (ctx.cancelled || this.ctx !== ctx) {
			throw new KasboCancelled();
		}
	}

	async prepareCapture(ctx) {
		ctx.outputSize = this.computeOutputSize(ctx);
		const source = await this.findScreenSource(ctx.display);
		if (!source) {
			throw new Error('هیچ صفحه‌ای برای ضبط پیدا نشد.');
		}

		ctx.tempFile = path.join(os.tmpdir(), `ir-recorder-${Date.now()}-${process.pid}.part`);
		ctx.writeStream = fs.createWriteStream(ctx.tempFile);
		ctx.writeStream.on('error', (err) => {
			console.error('[kasbo] Temp file write failed:', err);
			if (this.ctx === ctx && this.isActive()) {
				this.stop();
			}
		});

		ctx.recorder = this.windows.takeRecorder();
		await ctx.recorder.kasboReady;
		this.throwIfCancelled(ctx);

		this.pendingCapture = {
			source,
			audio: ctx.settings.systemAudio,
			webContents: ctx.recorder.webContents
		};

		try {
			// User gesture is required by getDisplayMedia, so the call is made with one.
			const info = await kasboWithTimeout(
				ctx.recorder.webContents.executeJavaScript('window.kasboRecorderPrepare()', true),
				20000,
				'آماده‌سازی ضبط بیش از حد طول کشید.'
			);
			if (!info || !info.ok) {
				throw new Error((info && info.error) || 'آماده‌سازی ضبط ناموفق بود.');
			}
			ctx.recorderInfo = info;
		} finally {
			this.pendingCapture = null;
		}
	}

	beginRecording(ctx) {
		ctx.startedAt = Date.now();
		this.inputHook.on('cursor', this.onCursor);
		this.inputHook.on('click', this.onClick);
		this.inputHook.on('key', this.onKey);
		this.inputHook.start();

		this.sendRecorder('rec:start');
		this.setState('recording');

		ctx.controlBar = this.windows.createControlBar(ctx.display);
	}

	/* ------------------------------------------------------------------ display media */

	/**
	 * Answers getDisplayMedia() from the recorder window with the chosen screen.
	 */
	handleDisplayMediaRequest(request, callback) {
		const pending = this.pendingCapture;
		const frame = request.frame;
		const mainFrame = pending && !pending.webContents.isDestroyed() ? pending.webContents.mainFrame : null;
		const fromRecorder = !!frame && !!mainFrame
			&& frame.processId === mainFrame.processId
			&& frame.routingId === mainFrame.routingId;

		if (!pending || !fromRecorder) {
			callback({});
			return;
		}

		const streams = { video: pending.source };
		if (pending.audio && request.audioRequested && process.platform === 'win32') {
			streams.audio = 'loopback';
		}
		callback(streams);
	}

	async findScreenSource(display) {
		const sources = await desktopCapturer.getSources({
			types: ['screen'],
			thumbnailSize: { width: 0, height: 0 }
		});
		const match = sources.find((s) => s.display_id === String(display.id));
		if (match) {
			return match;
		}
		const index = screen.getAllDisplays().findIndex((d) => d.id === display.id);
		return sources[index] || sources[0] || null;
	}

	/* ------------------------------------------------------------------ geometry */

	resolveDisplay(displayId) {
		const displays = screen.getAllDisplays();
		return displays.find((d) => d.id === displayId) || screen.getPrimaryDisplay();
	}

	toLocal(rect) {
		const b = this.ctx.display.bounds;
		return { x: rect.x - b.x, y: rect.y - b.y, width: rect.width, height: rect.height };
	}

	computeOutputSize(ctx) {
		const preset = KASBO_PRESETS[ctx.mode];
		if (preset.width) {
			return { width: preset.width, height: preset.height };
		}
		const sf = ctx.display.scaleFactor || 1;
		const w = ctx.region.width * sf;
		const h = ctx.region.height * sf;
		const scale = Math.min(1, KASBO_MAX_LONG_SIDE / Math.max(w, h));
		return { width: kasboEven(w * scale), height: kasboEven(h * scale) };
	}

	/**
	 * Keeps a region inside the display, at least the minimum size and on the mode's aspect ratio.
	 */
	fitRegion(rect, bounds, aspect) {
		let width = kasboClamp(rect.width, KASBO_MIN_REGION, bounds.width);
		let height = kasboClamp(rect.height, KASBO_MIN_REGION, bounds.height);
		if (aspect) {
			if (width / height > aspect) {
				width = height * aspect;
			} else {
				height = width / aspect;
			}
			if (Math.min(width, height) < KASBO_MIN_REGION) {
				if (aspect < 1) {
					width = KASBO_MIN_REGION;
					height = width / aspect;
				} else {
					height = KASBO_MIN_REGION;
					width = height * aspect;
				}
			}
		}
		const x = kasboClamp(rect.x, bounds.x, bounds.x + bounds.width - width);
		const y = kasboClamp(rect.y, bounds.y, bounds.y + bounds.height - height);
		return {
			x: Math.round(x),
			y: Math.round(y),
			width: Math.round(width),
			height: Math.round(height)
		};
	}

	defaultRegion(mode, bounds) {
		const aspect = KASBO_PRESETS[mode].aspect;
		let width;
		let height;
		if (aspect && aspect < 1) {
			height = bounds.height * 0.86;
			width = height * aspect;
		} else if (aspect) {
			width = bounds.width * 0.7;
			height = width / aspect;
		} else {
			width = bounds.width * 0.7;
			height = bounds.height * 0.7;
		}
		return {
			x: bounds.x + (bounds.width - width) / 2,
			y: bounds.y + (bounds.height - height) / 2,
			width,
			height
		};
	}

	/* ------------------------------------------------------------------ renderer configs */

	getOverlayConfig() {
		const ctx = this.ctx;
		if (!ctx) {
			return null;
		}
		const bounds = ctx.display.bounds;
		const aspect = KASBO_PRESETS[ctx.mode].aspect;
		const saved = ctx.settings.regions[ctx.mode];
		const fitsDisplay = kasboIsRect(saved)
			&& saved.x >= bounds.x && saved.y >= bounds.y
			&& saved.x + saved.width <= bounds.x + bounds.width
			&& saved.y + saved.height <= bounds.y + bounds.height;
		const initial = this.fitRegion(fitsDisplay ? saved : this.defaultRegion(ctx.mode, bounds), bounds, aspect);

		return {
			phase: ctx.mode === 'fullscreen' ? 'hidden' : 'select',
			mode: ctx.mode,
			aspect,
			minSize: KASBO_MIN_REGION,
			scaleFactor: ctx.display.scaleFactor || 1,
			preset: KASBO_PRESETS[ctx.mode].width
				? { width: KASBO_PRESETS[ctx.mode].width, height: KASBO_PRESETS[ctx.mode].height }
				: null,
			region: this.toLocal(initial)
		};
	}

	getRecorderConfig() {
		const ctx = this.ctx;
		if (!ctx || !ctx.region) {
			return null;
		}
		const s = ctx.settings;
		return {
			mode: ctx.mode,
			fps: KASBO_FPS,
			display: {
				bounds: { ...ctx.display.bounds },
				scaleFactor: ctx.display.scaleFactor || 1
			},
			region: { ...ctx.region },
			output: { ...ctx.outputSize },
			audio: {
				system: s.systemAudio && process.platform === 'win32',
				systemGain: s.systemGain,
				mic: s.mic,
				micDeviceId: s.micDeviceId,
				micGain: s.micGain
			},
			webcam: {
				enabled: s.webcam,
				deviceId: s.webcamDeviceId,
				corner: s.webcamCorner,
				size: s.webcamSize
			},
			features: {
				follow: ctx.follow,
				followSpeed: s.followSpeed,
				autoZoom: s.autoZoom,
				zoomLevel: s.zoomLevel,
				clickHighlight: s.clickHighlight,
				keystrokes: s.keystrokes,
				keystrokeMode: s.keystrokeMode
			}
		};
	}

	getControlState() {
		const ctx = this.ctx;
		if (!ctx) {
			return { state: this.state };
		}
		return {
			state: this.state,
			now: Date.now(),
			startedAt: ctx.startedAt,
			pausedAt: ctx.pausedAt,
			pausedTotal: ctx.pausedTotal,
			micEnabled: !!(ctx.recorderInfo && ctx.recorderInfo.hasMic),
			micMuted: ctx.micMuted,
			drawing: ctx.drawing,
			zoom: ctx.zoom,
			follow: ctx.follow,
			followAvailable: ctx.mode !== 'fullscreen'
		};
	}

	/* ------------------------------------------------------------------ messaging */

	sendOverlay(channel, payload) {
		const win = this.ctx && this.ctx.overlay;
		if (win && !win.isDestroyed()) {
			win.webContents.send(channel, payload);
		}
	}

	sendRecorder(channel, payload) {
		const win = this.ctx && this.ctx.recorder;
		if (win && !win.isDestroyed()) {
			win.webContents.send(channel, payload);
		}
	}

	pushControlState() {
		const win = this.ctx && this.ctx.controlBar;
		if (win && !win.isDestroyed()) {
			win.webContents.send('ctrl:state', this.getControlState());
		}
	}

	forwardInput(channel, payload) {
		if (this.state === 'recording') {
			this.sendRecorder(channel, payload);
		}
	}

	/* ------------------------------------------------------------------ IPC entry points */

	confirmRegion(localRect) {
		const ctx = this.ctx;
		if (!ctx || !ctx.select || this.state !== 'selecting' || !kasboIsRect(localRect)) {
			return;
		}
		const b = ctx.display.bounds;
		const absolute = {
			x: localRect.x + b.x,
			y: localRect.y + b.y,
			width: localRect.width,
			height: localRect.height
		};
		ctx.select.resolve(this.fitRegion(absolute, b, KASBO_PRESETS[ctx.mode].aspect));
	}

	countdownDone() {
		if (this.ctx && this.ctx.countdown) {
			this.ctx.countdown.resolve();
		}
	}

	writeChunk(data) {
		const ctx = this.ctx;
		if (!ctx || !ctx.writeStream || !(data instanceof Uint8Array)) {
			return;
		}
		if (!this.isActive() && this.state !== 'stopping') {
			return;
		}
		ctx.writeStream.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
	}

	recorderFinished() {
		if (this.ctx && this.ctx.finished) {
			this.ctx.finished.resolve();
		}
	}

	/**
	 * Validates a stroke from the overlay and forwards it in absolute screen coordinates.
	 */
	updateStroke(stroke) {
		const ctx = this.ctx;
		if (!ctx || !this.isActive() || !stroke || typeof stroke !== 'object') {
			return;
		}
		const valid = typeof stroke.id === 'string' && stroke.id.length <= 40
			&& KASBO_DRAW_TOOLS.includes(stroke.tool)
			&& typeof stroke.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(stroke.color)
			&& typeof stroke.width === 'number' && stroke.width >= 1 && stroke.width <= 40
			&& Array.isArray(stroke.points) && stroke.points.length > 0 && stroke.points.length <= 4000;
		if (!valid) {
			return;
		}
		const b = ctx.display.bounds;
		const points = [];
		for (const p of stroke.points) {
			if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
				return;
			}
			points.push({ x: p.x + b.x, y: p.y + b.y });
		}
		this.sendRecorder('draw:update', {
			id: stroke.id,
			tool: stroke.tool,
			color: stroke.color,
			width: stroke.width,
			points
		});
	}

	/**
	 * Mirrors the moving capture frame on the overlay outline.
	 */
	forwardRegion(pos) {
		const ctx = this.ctx;
		if (!ctx || !this.isActive() || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
			return;
		}
		const b = ctx.display.bounds;
		this.sendOverlay('overlay:region', { x: pos.x - b.x, y: pos.y - b.y });
	}

	removeStroke(id) {
		if (this.isActive() && typeof id === 'string' && id.length <= 40) {
			this.sendRecorder('draw:remove', id);
		}
	}

	clearDrawings() {
		if (!this.isActive()) {
			return;
		}
		this.sendOverlay('overlay:clear');
		this.sendRecorder('draw:clear');
	}

	handleControlAction(action) {
		switch (action) {
			case 'stop':
				this.stop();
				break;
			case 'pause':
				this.togglePause();
				break;
			case 'draw':
				this.toggleDraw();
				break;
			case 'mic':
				this.toggleMic();
				break;
			case 'zoom':
				this.toggleZoom();
				break;
			case 'follow':
				this.toggleFollow();
				break;
			case 'clear':
				this.clearDrawings();
				break;
			default:
				break;
		}
	}

	/* ------------------------------------------------------------------ live controls */

	togglePause() {
		const ctx = this.ctx;
		if (!ctx) {
			return;
		}
		if (this.state === 'recording') {
			ctx.pausedAt = Date.now();
			this.sendRecorder('rec:pause');
			this.setState('paused');
		} else if (this.state === 'paused') {
			ctx.pausedTotal += Date.now() - ctx.pausedAt;
			ctx.pausedAt = 0;
			this.sendRecorder('rec:resume');
			this.setState('recording');
		}
	}

	toggleDraw(force) {
		const ctx = this.ctx;
		if (!ctx || !this.isActive() || !ctx.overlay || ctx.overlay.isDestroyed()) {
			return;
		}
		ctx.drawing = typeof force === 'boolean' ? force : !ctx.drawing;
		ctx.overlay.setIgnoreMouseEvents(!ctx.drawing);
		if (ctx.drawing) {
			ctx.overlay.focus();
		}
		this.sendOverlay('overlay:draw', ctx.drawing);
		this.pushControlState();
	}

	toggleMic() {
		const ctx = this.ctx;
		if (!ctx || !this.isActive() || !(ctx.recorderInfo && ctx.recorderInfo.hasMic)) {
			return;
		}
		ctx.micMuted = !ctx.micMuted;
		this.sendRecorder('rec:mic-mute', ctx.micMuted);
		this.pushControlState();
	}

	toggleZoom() {
		const ctx = this.ctx;
		if (!ctx || !this.isActive()) {
			return;
		}
		ctx.zoom = !ctx.zoom;
		this.sendRecorder('rec:zoom', ctx.zoom);
		this.pushControlState();
	}

	toggleFollow() {
		const ctx = this.ctx;
		if (!ctx || !this.isActive() || ctx.mode === 'fullscreen') {
			return;
		}
		ctx.follow = !ctx.follow;
		this.sendRecorder('rec:follow', ctx.follow);
		this.pushControlState();
	}

	cycleWebcamCorner() {
		const ctx = this.ctx;
		if (!ctx || !this.isActive() || !(ctx.recorderInfo && ctx.recorderInfo.hasWebcam)) {
			return;
		}
		const index = KASBO_WEBCAM_CORNERS.indexOf(ctx.webcamCorner);
		ctx.webcamCorner = KASBO_WEBCAM_CORNERS[(index + 1) % KASBO_WEBCAM_CORNERS.length];
		this.sendRecorder('rec:webcam-corner', ctx.webcamCorner);
	}

	/* ------------------------------------------------------------------ stop / cancel */

	toggleRecord() {
		if (this.state === 'idle') {
			this.start();
		} else if (this.isActive()) {
			this.stop();
		} else if (KASBO_STARTING_STATES.includes(this.state)) {
			this.cancel();
		}
	}

	cancel() {
		const ctx = this.ctx;
		if (!ctx || !KASBO_STARTING_STATES.includes(this.state) || ctx.cancelled) {
			return;
		}
		ctx.cancelled = true;
		const err = new KasboCancelled();
		if (ctx.select) {
			ctx.select.reject(err);
		}
		if (ctx.countdown) {
			ctx.countdown.reject(err);
		}
	}

	async stop() {
		const ctx = this.ctx;
		if (KASBO_STARTING_STATES.includes(this.state)) {
			this.cancel();
			return;
		}
		if (!ctx || !this.isActive()) {
			return;
		}

		if (this.state === 'paused') {
			ctx.pausedTotal += Date.now() - ctx.pausedAt;
			ctx.pausedAt = 0;
		}
		const durationSec = Math.max(0, (Date.now() - ctx.startedAt - ctx.pausedTotal) / 1000);

		this.setState('stopping');
		this.detachInput();

		ctx.finished = kasboDeferred();
		this.sendRecorder('rec:stop');
		try {
			await kasboWithTimeout(ctx.finished.promise, 15000, 'Recorder did not finish in time.');
		} catch (err) {
			console.error('[kasbo]', err);
		}

		await this.closeStream(ctx);
		this.destroyWindows(ctx);
		this.showPanel();
		await this.encode(ctx, durationSec);
	}

	async encode(ctx, durationSec) {
		const outputDir = this.settings.getOutputDir();
		const baseName = `IR-${KASBO_PRESETS[ctx.mode].label}-${kasboTimestamp()}`;
		const info = ctx.recorderInfo || {};
		let strategy = 'full';
		if (info.h264 && ctx.settings.fastSave) {
			strategy = info.container === 'mp4' ? 'copy' : 'video-copy';
		}

		try {
			await fsp.mkdir(outputDir, { recursive: true });
			const stat = await fsp.stat(ctx.tempFile);
			if (stat.size === 0) {
				throw new Error('empty');
			}
		} catch (err) {
			await this.removeTemp(ctx);
			this.ctx = null;
			this.setState('idle', { error: 'ویدیویی ضبط نشد. دوباره امتحان کن.' });
			return;
		}

		const output = path.join(outputDir, `${baseName}.mp4`);
		this.setState('encoding', { progress: 0, strategy });

		const run = (mode) => this.encoder.encode({
			input: ctx.tempFile,
			output,
			durationSec,
			fps: KASBO_FPS,
			strategy: mode,
			onProgress: (progress) => this.emit('status', { state: 'encoding', progress, strategy: mode })
		});

		try {
			try {
				await run(strategy);
			} catch (fastErr) {
				if (strategy === 'full') {
					throw fastErr;
				}
				console.error('[kasbo] Fast save failed, re-encoding:', fastErr);
				this.emit('status', { state: 'encoding', progress: 0, strategy: 'full' });
				await run('full');
			}
			await this.removeTemp(ctx);
			this.outputs.add(output);
			this.ctx = null;
			this.setState('idle', { done: { file: output, duration: durationSec } });
		} catch (err) {
			console.error('[kasbo] Encoding failed:', err);
			// Keep the raw capture so nothing is lost.
			const fallback = path.join(outputDir, `${baseName}.${info.container === 'mp4' ? 'mp4' : 'webm'}`);
			let saved = null;
			try {
				await fsp.copyFile(ctx.tempFile, fallback);
				await this.removeTemp(ctx);
				saved = fallback;
				this.outputs.add(fallback);
			} catch (copyErr) {
				console.error('[kasbo] Fallback copy failed:', copyErr);
			}
			this.ctx = null;
			this.setState('idle', {
				error: saved
					? 'ساخت نسخه‌ی نهایی انجام نشد؛ فایل خام ضبط ذخیره شد.'
					: 'ذخیره‌ی ویدیو با خطا مواجه شد.',
				done: saved ? { file: saved, duration: durationSec } : null
			});
		}
	}

	fail(err) {
		console.error('[kasbo] Session failed:', err);
		this.cleanup({ error: String((err && err.message) || err) });
	}

	cleanup(extra = {}) {
		const ctx = this.ctx;
		this.pendingCapture = null;
		this.detachInput();
		if (ctx) {
			if (ctx.writeStream) {
				ctx.writeStream.destroy();
			}
			this.destroyWindows(ctx);
			this.removeTemp(ctx);
		}
		this.ctx = null;
		this.showPanel();
		this.setState('idle', extra);
	}

	detachInput() {
		this.inputHook.stop();
		this.inputHook.removeListener('cursor', this.onCursor);
		this.inputHook.removeListener('click', this.onClick);
		this.inputHook.removeListener('key', this.onKey);
	}

	closeStream(ctx) {
		return new Promise((resolve) => {
			if (!ctx.writeStream || ctx.writeStream.destroyed) {
				resolve();
				return;
			}
			ctx.writeStream.end(resolve);
		});
	}

	async removeTemp(ctx) {
		if (ctx.tempFile) {
			await fsp.unlink(ctx.tempFile).catch(() => {});
		}
	}

	destroyWindows(ctx) {
		KasboWindows.destroy(ctx.controlBar);
		KasboWindows.destroy(ctx.overlay);
		KasboWindows.destroy(ctx.recorder);
		ctx.controlBar = null;
		ctx.overlay = null;
		ctx.recorder = null;
	}

	showPanel() {
		const panel = this.windows.panel;
		if (panel && !panel.isDestroyed()) {
			panel.show();
			panel.focus();
		}
	}

	/**
	 * Only files this app produced may be opened from the panel.
	 */
	isKnownOutput(file) {
		return typeof file === 'string' && this.outputs.has(file);
	}

	shutdown() {
		this.encoder.cancel();
		if (this.ctx) {
			this.cleanup();
		}
	}
}

module.exports = { KasboRecordingSession, KASBO_PRESETS };

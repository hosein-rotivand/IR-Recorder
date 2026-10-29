'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const KASBO_MODES = ['reels', 'youtube', 'custom', 'fullscreen'];
const KASBO_REGION_MODES = ['reels', 'youtube', 'custom'];

const KASBO_DEFAULTS = Object.freeze({
	mode: 'youtube',
	displayId: null,
	regions: {},
	systemAudio: true,
	systemGain: 1,
	mic: false,
	micDeviceId: 'default',
	micGain: 1,
	webcam: false,
	webcamDeviceId: '',
	webcamCorner: 'bottom-right',
	webcamSize: 'm',
	followCursor: true,
	followSpeed: 'normal',
	autoZoom: true,
	zoomLevel: 1.8,
	clickHighlight: true,
	keystrokes: true,
	keystrokeMode: 'shortcuts',
	countdown: true,
	fastSave: true,
	outputDir: ''
});

const kasboIsBool = (v) => typeof v === 'boolean';
const kasboIsString = (max) => (v) => typeof v === 'string' && v.length <= max;
const kasboIsNumber = (min, max) => (v) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const kasboIsOneOf = (list) => (v) => list.includes(v);

const KASBO_SCHEMA = {
	mode: kasboIsOneOf(KASBO_MODES),
	displayId: (v) => v === null || Number.isSafeInteger(v),
	systemAudio: kasboIsBool,
	systemGain: kasboIsNumber(0, 2),
	mic: kasboIsBool,
	micDeviceId: kasboIsString(512),
	micGain: kasboIsNumber(0, 2),
	webcam: kasboIsBool,
	webcamDeviceId: kasboIsString(512),
	webcamCorner: kasboIsOneOf(['top-left', 'top-right', 'bottom-left', 'bottom-right']),
	webcamSize: kasboIsOneOf(['s', 'm', 'l']),
	followCursor: kasboIsBool,
	followSpeed: kasboIsOneOf(['soft', 'normal', 'fast']),
	autoZoom: kasboIsBool,
	zoomLevel: kasboIsNumber(1.2, 3),
	clickHighlight: kasboIsBool,
	keystrokes: kasboIsBool,
	keystrokeMode: kasboIsOneOf(['shortcuts', 'all']),
	countdown: kasboIsBool,
	fastSave: kasboIsBool,
	outputDir: kasboIsString(1024)
};

/**
 * Validates a rectangle in screen DIP coordinates.
 */
function kasboIsRect(rect) {
	return !!rect
		&& typeof rect === 'object'
		&& ['x', 'y', 'width', 'height'].every((k) => typeof rect[k] === 'number' && Number.isFinite(rect[k]))
		&& rect.width >= 50
		&& rect.height >= 50;
}

class KasboSettings {
	constructor() {
		this.file = path.join(app.getPath('userData'), 'settings.json');
		this.data = this.load();
	}

	load() {
		const data = { ...KASBO_DEFAULTS, regions: {} };
		try {
			const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
			this.applyPatch(data, raw);
			if (raw && typeof raw.regions === 'object') {
				for (const mode of KASBO_REGION_MODES) {
					if (kasboIsRect(raw.regions[mode])) {
						data.regions[mode] = this.pickRect(raw.regions[mode]);
					}
				}
			}
		} catch (err) {
			// First run or unreadable file: defaults are used.
		}
		return data;
	}

	applyPatch(target, patch) {
		if (!patch || typeof patch !== 'object') {
			return;
		}
		for (const key of Object.keys(KASBO_SCHEMA)) {
			if (Object.prototype.hasOwnProperty.call(patch, key) && KASBO_SCHEMA[key](patch[key])) {
				target[key] = patch[key];
			}
		}
	}

	pickRect(rect) {
		return {
			x: Math.round(rect.x),
			y: Math.round(rect.y),
			width: Math.round(rect.width),
			height: Math.round(rect.height)
		};
	}

	get() {
		return JSON.parse(JSON.stringify(this.data));
	}

	update(patch) {
		this.applyPatch(this.data, patch);
		this.save();
		return this.get();
	}

	setRegion(mode, rect) {
		if (KASBO_REGION_MODES.includes(mode) && kasboIsRect(rect)) {
			this.data.regions[mode] = this.pickRect(rect);
			this.save();
		}
	}

	getOutputDir() {
		return this.data.outputDir || path.join(app.getPath('videos'), 'IR Recorder');
	}

	save() {
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			const tmp = `${this.file}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
			fs.renameSync(tmp, this.file);
		} catch (err) {
			console.error('[kasbo] Failed to save settings:', err);
		}
	}
}

module.exports = { KasboSettings, KASBO_MODES, KASBO_REGION_MODES, kasboIsRect };

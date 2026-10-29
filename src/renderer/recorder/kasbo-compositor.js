'use strict';

const KASBO_WEBCAM_SIZES = { s: 0.2, m: 0.26, l: 0.34 };
const KASBO_FONT = '"Segoe UI", system-ui, sans-serif';
const KASBO_KEY_VISIBLE_MS = 1700;
const KASBO_KEY_FADE_MS = 300;
const KASBO_RIPPLE_MS = 520;

/**
 * Paints every frame: zoomed screen, drawings, click ripples, keystrokes and webcam.
 */
class KasboCompositor {
	constructor({ canvas, screenVideo, webcamVideo, camera, config }) {
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
		this.ctx.imageSmoothingEnabled = true;
		this.ctx.imageSmoothingQuality = 'high';
		this.screenVideo = screenVideo;
		this.webcamVideo = webcamVideo;
		this.camera = camera;
		this.display = config.display.bounds;
		this.region = config.region;
		this.W = canvas.width;
		this.H = canvas.height;
		this.unit = Math.min(this.W, this.H) / 1080;
		this.portrait = this.H > this.W;
		this.view = { x: 0, y: 0, w: 1, h: 1 };

		this.ripples = [];
		this.strokes = new Map();
		this.keys = { caps: [], typing: false, shownAt: -1e9 };
		this.webcam = {
			corner: config.webcam.corner,
			size: config.webcam.size,
			pos: null
		};
	}

	/* ------------------------------------------------------------------ mapping */

	sourceRect() {
		const v = this.screenVideo;
		const kx = v.videoWidth / this.display.width;
		const ky = v.videoHeight / this.display.height;
		return {
			x: (this.region.x - this.display.x) * kx,
			y: (this.region.y - this.display.y) * ky,
			w: this.region.width * kx,
			h: this.region.height * ky
		};
	}

	normalize(x, y) {
		return {
			nx: (x - this.region.x) / this.region.width,
			ny: (y - this.region.y) / this.region.height
		};
	}

	toOutput(x, y) {
		const { nx, ny } = this.normalize(x, y);
		return {
			x: ((nx - this.view.x) / this.view.w) * this.W,
			y: ((ny - this.view.y) / this.view.h) * this.H
		};
	}

	/** Output pixels per screen DIP at the current zoom. */
	dipScale() {
		return this.W / (this.region.width * this.view.w);
	}

	/* ------------------------------------------------------------------ inputs */

	addRipple(x, y, button, now) {
		this.ripples.push({ x, y, start: now, secondary: button === 2 });
		if (this.ripples.length > 12) {
			this.ripples.shift();
		}
	}

	showKey(k, mode, now) {
		const keys = this.keys;
		const combo = k.ctrl || k.alt || k.meta;
		const recent = now - keys.shownAt < KASBO_KEY_VISIBLE_MS;

		if (combo) {
			const caps = [];
			if (k.ctrl) caps.push('Ctrl');
			if (k.shift) caps.push('Shift');
			if (k.alt) caps.push('Alt');
			if (k.meta) caps.push('Win');
			caps.push(k.key);
			keys.caps = caps;
			keys.typing = false;
		} else if (mode === 'shortcuts') {
			if (!k.special) {
				return;
			}
			keys.caps = [k.key];
			keys.typing = false;
		} else if (k.printable || k.key === 'Space') {
			const ch = k.key === 'Space' ? ' ' : (k.shift ? k.key : k.key.toLowerCase());
			const base = keys.typing && recent ? keys.caps[0] : '';
			keys.caps = [(base + ch).slice(-28)];
			keys.typing = true;
		} else if (k.key === '⌫' && keys.typing && recent && keys.caps[0].length > 1) {
			keys.caps = [keys.caps[0].slice(0, -1)];
		} else {
			keys.caps = [k.key];
			keys.typing = false;
		}
		keys.shownAt = now;
	}

	setStroke(stroke) {
		this.strokes.set(stroke.id, stroke);
	}

	removeStroke(id) {
		this.strokes.delete(id);
	}

	clearStrokes() {
		this.strokes.clear();
	}

	setWebcamCorner(corner) {
		this.webcam.corner = corner;
	}

	/* ------------------------------------------------------------------ render */

	render(now, dt) {
		const c = this.ctx;
		this.view = this.camera.view();

		c.fillStyle = '#000';
		c.fillRect(0, 0, this.W, this.H);

		const v = this.screenVideo;
		if (v.readyState >= 2 && v.videoWidth > 0) {
			const r = this.sourceRect();
			c.drawImage(
				v,
				r.x + this.view.x * r.w,
				r.y + this.view.y * r.h,
				this.view.w * r.w,
				this.view.h * r.h,
				0, 0, this.W, this.H
			);
		}

		this.drawStrokes();
		this.drawRipples(now);
		this.drawKeys(now);
		this.drawWebcam(dt);
	}

	drawStrokes() {
		if (!this.strokes.size) {
			return;
		}
		const c = this.ctx;
		const ds = this.dipScale();
		c.save();
		c.lineCap = 'round';
		c.lineJoin = 'round';
		c.shadowColor = 'rgba(0, 0, 0, 0.35)';
		c.shadowBlur = 6 * this.unit;

		for (const s of this.strokes.values()) {
			const pts = s.points.map((p) => this.toOutput(p.x, p.y));
			const lw = Math.max(1, s.width * ds);
			c.strokeStyle = s.color;
			c.fillStyle = s.color;
			c.lineWidth = lw;

			window.KasboDraw.stroke(c, s.tool, pts, lw, this.unit);
		}
		c.restore();
	}

	drawRipples(now) {
		if (!this.ripples.length) {
			return;
		}
		const c = this.ctx;
		const ds = Math.min(this.dipScale(), 3);
		this.ripples = this.ripples.filter((r) => now - r.start < KASBO_RIPPLE_MS);

		for (const r of this.ripples) {
			const t = (now - r.start) / KASBO_RIPPLE_MS;
			const ease = 1 - Math.pow(1 - t, 3);
			const p = this.toOutput(r.x, r.y);
			const radius = (12 + 30 * ease) * ds;
			const alpha = 1 - t;
			const rgb = r.secondary ? '255, 197, 61' : '124, 92, 255';

			c.beginPath();
			c.arc(p.x, p.y, radius, 0, Math.PI * 2);
			c.fillStyle = `rgba(${rgb}, ${0.22 * alpha})`;
			c.fill();
			c.lineWidth = 3 * ds;
			c.strokeStyle = `rgba(${rgb}, ${0.9 * alpha})`;
			c.stroke();
		}
	}

	drawKeys(now) {
		const keys = this.keys;
		const age = now - keys.shownAt;
		if (!keys.caps.length || age > KASBO_KEY_VISIBLE_MS) {
			return;
		}
		const c = this.ctx;
		const u = this.unit;
		const fadeStart = KASBO_KEY_VISIBLE_MS - KASBO_KEY_FADE_MS;
		const alpha = age > fadeStart ? 1 - (age - fadeStart) / KASBO_KEY_FADE_MS : Math.min(1, age / 90);

		const fontSize = Math.round(30 * u);
		const capH = fontSize + 24 * u;
		const capPad = 16 * u;
		const gap = 10 * u;
		const boxPad = 12 * u;

		c.save();
		c.globalAlpha = Math.max(0, alpha);
		c.font = `600 ${fontSize}px ${KASBO_FONT}`;
		c.textBaseline = 'middle';
		c.textAlign = 'center';

		const plus = keys.typing ? 0 : c.measureText('+').width;
		const widths = keys.caps.map((t) => Math.max(capH, c.measureText(t).width + capPad * 2));
		const inner = widths.reduce((sum, w) => sum + w, 0) + (keys.caps.length - 1) * (plus + gap * 2);
		const boxW = inner + boxPad * 2;
		const boxH = capH + boxPad * 2;
		const x0 = (this.W - boxW) / 2;
		const y0 = this.portrait ? this.H * 0.7 : this.H - boxH - 56 * u;

		c.fillStyle = 'rgba(13, 15, 19, 0.82)';
		c.beginPath();
		c.roundRect(x0, y0, boxW, boxH, 16 * u);
		c.fill();

		let x = x0 + boxPad;
		const cy = y0 + boxPad + capH / 2;
		keys.caps.forEach((text, i) => {
			const w = widths[i];
			c.beginPath();
			c.roundRect(x, y0 + boxPad, w, capH, 10 * u);
			c.fillStyle = 'rgba(255, 255, 255, 0.08)';
			c.fill();
			c.lineWidth = Math.max(1, 1.5 * u);
			c.strokeStyle = 'rgba(255, 255, 255, 0.18)';
			c.stroke();
			c.fillStyle = '#FFFFFF';
			c.fillText(text, x + w / 2, cy);
			x += w;
			if (i < keys.caps.length - 1) {
				c.fillStyle = 'rgba(255, 255, 255, 0.55)';
				c.fillText('+', x + gap + plus / 2, cy);
				x += plus + gap * 2;
			}
		});
		c.restore();
	}

	webcamTarget(d) {
		const m = Math.min(this.W, this.H);
		const margin = 0.035 * m;
		const corner = this.webcam.corner;
		const left = corner.endsWith('left');
		const top = corner.startsWith('top');
		const x = left ? margin : this.W - d - margin;
		let y;
		if (top) {
			y = this.portrait ? this.H * 0.07 : margin;
		} else {
			// Keep clear of the Reels caption area in portrait.
			y = this.portrait ? this.H - d - this.H * 0.16 : this.H - d - margin;
		}
		return { x, y };
	}

	drawWebcam(dt) {
		const v = this.webcamVideo;
		if (!v || v.readyState < 2 || !v.videoWidth) {
			return;
		}
		const c = this.ctx;
		const u = this.unit;
		const d = (KASBO_WEBCAM_SIZES[this.webcam.size] || KASBO_WEBCAM_SIZES.m) * Math.min(this.W, this.H);
		const target = this.webcamTarget(d);

		if (!this.webcam.pos) {
			this.webcam.pos = { ...target };
		} else {
			const k = 1 - Math.exp(-dt * 8);
			this.webcam.pos.x += (target.x - this.webcam.pos.x) * k;
			this.webcam.pos.y += (target.y - this.webcam.pos.y) * k;
		}
		const { x, y } = this.webcam.pos;
		const r = d / 2;

		c.save();
		c.shadowColor = 'rgba(0, 0, 0, 0.45)';
		c.shadowBlur = 32 * u;
		c.shadowOffsetY = 8 * u;
		c.fillStyle = '#111';
		c.beginPath();
		c.arc(x + r, y + r, r, 0, Math.PI * 2);
		c.fill();
		c.restore();

		c.save();
		c.beginPath();
		c.arc(x + r, y + r, r, 0, Math.PI * 2);
		c.clip();
		const side = Math.min(v.videoWidth, v.videoHeight);
		const sx = (v.videoWidth - side) / 2;
		const sy = (v.videoHeight - side) / 2;
		c.translate(x + d, y);
		c.scale(-1, 1);
		c.drawImage(v, sx, sy, side, side, 0, 0, d, d);
		c.restore();

		c.beginPath();
		c.arc(x + r, y + r, r, 0, Math.PI * 2);
		c.lineWidth = Math.max(3, d * 0.02);
		c.strokeStyle = 'rgba(255, 255, 255, 0.92)';
		c.stroke();
	}
}

window.KasboCompositor = KasboCompositor;

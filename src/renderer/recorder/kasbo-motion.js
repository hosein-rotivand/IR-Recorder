'use strict';

/**
 * Critically damped spring: eases in and out without overshoot.
 * Uses the closed-form solution, so it is stable for any frame time.
 */
class KasboSpring {
	constructor(value, omega) {
		this.value = value;
		this.target = value;
		this.velocity = 0;
		this.omega = omega;
	}

	update(dt) {
		const w = this.omega;
		const x0 = this.value - this.target;
		const v0 = this.velocity;
		const e = Math.exp(-w * dt);
		const c = v0 + w * x0;
		this.value = this.target + (x0 + c * dt) * e;
		this.velocity = (v0 - w * c * dt) * e;
		if (Math.abs(this.value - this.target) < 1e-4 && Math.abs(this.velocity) < 1e-3) {
			this.value = this.target;
			this.velocity = 0;
		}
		return this.value;
	}

	set(value) {
		this.value = value;
		this.target = value;
		this.velocity = 0;
	}
}

const KASBO_FOLLOW_SPEEDS = { soft: 3, normal: 4.6, fast: 7.5 };

/**
 * Moves the capture frame across the display so it follows the cursor,
 * like a camera operator tracking the action.
 */
class KasboFollow {
	constructor({ region, bounds, enabled, speed }) {
		this.bounds = bounds;
		this.region = { ...region };
		this.enabled = !!enabled;
		this.margin = 0.1;
		this.cursor = null;
		const omega = KASBO_FOLLOW_SPEEDS[speed] || KASBO_FOLLOW_SPEEDS.normal;
		this.x = new KasboSpring(region.x, omega);
		this.y = new KasboSpring(region.y, omega);
	}

	setEnabled(enabled) {
		this.enabled = !!enabled;
	}

	onCursor(x, y) {
		this.cursor = { x, y };
	}

	clampAxis(value, size, start, length) {
		return Math.min(start + length - size, Math.max(start, value));
	}

	/**
	 * Re-centres an axis on the cursor once it reaches the edge zone of where the frame is heading.
	 */
	retarget() {
		const r = this.region;
		const b = this.bounds;
		const { x, y } = this.cursor;
		const mx = r.width * this.margin;
		const my = r.height * this.margin;

		if (x < this.x.target + mx || x > this.x.target + r.width - mx) {
			this.x.target = this.clampAxis(x - r.width / 2, r.width, b.x, b.width);
		}
		if (y < this.y.target + my || y > this.y.target + r.height - my) {
			this.y.target = this.clampAxis(y - r.height / 2, r.height, b.y, b.height);
		}
	}

	/** Returns true when the frame moved this tick. */
	update(dt) {
		if (this.enabled && this.cursor) {
			this.retarget();
		}
		const px = this.region.x;
		const py = this.region.y;
		this.region.x = this.x.update(dt);
		this.region.y = this.y.update(dt);
		return Math.abs(this.region.x - px) > 0.01 || Math.abs(this.region.y - py) > 0.01;
	}
}

window.KasboSpring = KasboSpring;
window.KasboFollow = KasboFollow;

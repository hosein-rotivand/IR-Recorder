'use strict';

/**
 * Virtual camera for auto zoom. Works in region-normalized space (0..1).
 * A click zooms in on that point, the view follows the cursor while zoomed,
 * and it eases back out after a short idle period. Motion uses springs.
 */
class KasboCamera {
	constructor({ enabled, zoomLevel }) {
		this.enabled = !!enabled;
		this.zoomLevel = zoomLevel || 1.8;
		this.holdMs = 2400;
		this.scale = new window.KasboSpring(1, 5.5);
		this.cx = new window.KasboSpring(0.5, 6.5);
		this.cy = new window.KasboSpring(0.5, 6.5);
		this.lastActivity = 0;
		this.cursor = null;
	}

	setEnabled(enabled) {
		this.enabled = !!enabled;
		if (!this.enabled) {
			this.resetTarget();
		}
	}

	resetTarget() {
		this.scale.target = 1;
		this.cx.target = 0.5;
		this.cy.target = 0.5;
	}

	static inside(nx, ny) {
		return nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1;
	}

	onCursor(nx, ny) {
		this.cursor = { nx, ny };
	}

	onClick(nx, ny, now) {
		if (!this.enabled || !KasboCamera.inside(nx, ny)) {
			return;
		}
		this.lastActivity = now;
		if (this.scale.target === 1) {
			this.cx.target = nx;
			this.cy.target = ny;
		}
		this.scale.target = this.zoomLevel;
	}

	/**
	 * Typing keeps the current zoom alive without moving it.
	 */
	onKeepAlive(now) {
		if (this.enabled && this.scale.target > 1) {
			this.lastActivity = now;
		}
	}

	update(dt, now) {
		if (this.enabled && this.scale.target > 1) {
			if (now - this.lastActivity > this.holdMs) {
				this.resetTarget();
			} else if (this.cursor && KasboCamera.inside(this.cursor.nx, this.cursor.ny)) {
				// Pan only when the cursor leaves the comfortable middle of the view.
				const margin = (0.5 / this.scale.target) * 0.6;
				const dx = this.cursor.nx - this.cx.target;
				const dy = this.cursor.ny - this.cy.target;
				if (Math.abs(dx) > margin) {
					this.cx.target = this.cursor.nx - Math.sign(dx) * margin;
				}
				if (Math.abs(dy) > margin) {
					this.cy.target = this.cursor.ny - Math.sign(dy) * margin;
				}
			}
		}

		const halfT = 0.5 / this.scale.target;
		this.cx.target = Math.min(1 - halfT, Math.max(halfT, this.cx.target));
		this.cy.target = Math.min(1 - halfT, Math.max(halfT, this.cy.target));

		this.scale.update(dt);
		this.cx.update(dt);
		this.cy.update(dt);

		const half = 0.5 / Math.max(1, this.scale.value);
		this.cx.value = Math.min(1 - half, Math.max(half, this.cx.value));
		this.cy.value = Math.min(1 - half, Math.max(half, this.cy.value));
	}

	view() {
		const size = 1 / Math.max(1, this.scale.value);
		return {
			x: this.cx.value - size / 2,
			y: this.cy.value - size / 2,
			w: size,
			h: size
		};
	}
}

window.KasboCamera = KasboCamera;

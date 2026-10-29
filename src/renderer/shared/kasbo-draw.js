'use strict';

/**
 * Shared stroke painter so the on-screen overlay and the recorded video match exactly.
 * `pts` are already in the target canvas space.
 */
window.KasboDraw = {
	stroke(c, tool, pts, lineWidth, unit) {
		if (!pts.length) {
			return;
		}
		if (tool === 'pen') {
			this.pen(c, pts, lineWidth);
		} else if (tool === 'arrow' && pts.length > 1) {
			this.arrow(c, pts[0], pts[pts.length - 1], lineWidth, unit);
		} else if (tool === 'rect' && pts.length > 1) {
			const a = pts[0];
			const b = pts[pts.length - 1];
			c.beginPath();
			c.roundRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y), lineWidth * 2);
			c.stroke();
		}
	},

	pen(c, pts, lineWidth) {
		if (pts.length === 1) {
			c.beginPath();
			c.arc(pts[0].x, pts[0].y, lineWidth / 2, 0, Math.PI * 2);
			c.fill();
			return;
		}
		c.beginPath();
		c.moveTo(pts[0].x, pts[0].y);
		for (let i = 1; i < pts.length - 1; i++) {
			const mx = (pts[i].x + pts[i + 1].x) / 2;
			const my = (pts[i].y + pts[i + 1].y) / 2;
			c.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
		}
		const last = pts[pts.length - 1];
		c.lineTo(last.x, last.y);
		c.stroke();
	},

	arrow(c, a, b, lineWidth, unit) {
		const angle = Math.atan2(b.y - a.y, b.x - a.x);
		const head = Math.max(lineWidth * 3.5, 14 * unit);
		const baseX = b.x - Math.cos(angle) * head * 0.8;
		const baseY = b.y - Math.sin(angle) * head * 0.8;

		c.beginPath();
		c.moveTo(a.x, a.y);
		c.lineTo(baseX, baseY);
		c.stroke();

		c.beginPath();
		c.moveTo(b.x, b.y);
		c.lineTo(b.x - head * Math.cos(angle - 0.45), b.y - head * Math.sin(angle - 0.45));
		c.lineTo(b.x - head * Math.cos(angle + 0.45), b.y - head * Math.sin(angle + 0.45));
		c.closePath();
		c.fill();
	}
};

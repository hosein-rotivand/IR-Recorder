'use strict';

(() => {
	const api = window.kasbo;
	const body = document.body;
	const frame = document.getElementById('kasbo-frame');
	const sizeBadge = document.getElementById('kasbo-size');
	const selectBar = document.getElementById('kasbo-select-bar');
	const modeLabel = document.getElementById('kasbo-mode-label');
	const countdown = document.getElementById('kasbo-countdown');
	const countdownNum = document.getElementById('kasbo-countdown-num');
	const canvas = document.getElementById('kasbo-draw');
	const drawBar = document.getElementById('kasbo-draw-bar');
	const widthDot = document.getElementById('kasbo-width-dot');
	const ctx = canvas.getContext('2d');

	const KASBO_MODE_LABELS = {
		reels: 'ریلز · 9:16',
		youtube: 'یوتیوب · 16:9',
		custom: 'کادر آزاد · تب مرورگر',
		fullscreen: 'تمام صفحه'
	};
	const KASBO_WIDTHS = [4, 8, 14];

	const state = {
		cfg: null,
		phase: 'hidden',
		region: { x: 0, y: 0, width: 0, height: 0 },
		drag: null,
		countdownStarted: false,
		drawing: false,
		tool: 'pen',
		color: '#FF4D5E',
		widthIndex: 0,
		strokes: [],
		current: null,
		sendQueued: false
	};

	const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
	const even = (v) => Math.max(2, Math.round(v / 2) * 2);
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	/* ------------------------------------------------------------------ layout */

	function setPhase(phase) {
		state.phase = phase;
		body.dataset.phase = phase;
	}

	function layout() {
		const r = state.region;
		frame.style.left = `${r.x}px`;
		frame.style.top = `${r.y}px`;
		frame.style.width = `${r.width}px`;
		frame.style.height = `${r.height}px`;

		if (state.cfg) {
			const sf = state.cfg.scaleFactor;
			const out = state.cfg.preset || { width: even(r.width * sf), height: even(r.height * sf) };
			sizeBadge.textContent = `${out.width} × ${out.height}`;
		}

		if (state.phase === 'select') {
			placeSelectBar();
		}
		countdown.style.left = `${r.x + r.width / 2}px`;
		countdown.style.top = `${r.y + r.height / 2}px`;
	}

	function placeSelectBar() {
		const r = state.region;
		const barW = selectBar.offsetWidth || 360;
		const barH = selectBar.offsetHeight || 52;
		const gap = 14;
		let top = r.y + r.height + gap;
		if (top + barH > window.innerHeight - 8) {
			top = r.y - barH - gap;
		}
		if (top < 8) {
			top = r.y + r.height - barH - gap;
		}
		const left = clamp(r.x + r.width / 2 - barW / 2, 8, window.innerWidth - barW - 8);
		selectBar.style.left = `${left}px`;
		selectBar.style.top = `${top}px`;
	}

	/* ------------------------------------------------------------------ selection */

	function pointer(e) {
		return { x: e.clientX, y: e.clientY };
	}

	function startDrag(e, type, handle) {
		if (state.phase !== 'select' || e.button !== 0) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		const p = pointer(e);
		state.drag = { type, handle, start: { ...state.region }, origin: p };
		body.setPointerCapture(e.pointerId);
	}

	function moveRegion(p) {
		const d = state.drag;
		state.region.x = clamp(d.start.x + p.x - d.origin.x, 0, window.innerWidth - d.start.width);
		state.region.y = clamp(d.start.y + p.y - d.origin.y, 0, window.innerHeight - d.start.height);
	}

	function drawNewRegion(p) {
		const o = state.drag.origin;
		const min = state.cfg.minSize;
		const x = clamp(Math.min(o.x, p.x), 0, window.innerWidth);
		const y = clamp(Math.min(o.y, p.y), 0, window.innerHeight);
		state.region = {
			x,
			y,
			width: Math.max(min, Math.min(Math.abs(p.x - o.x), window.innerWidth - x)),
			height: Math.max(min, Math.min(Math.abs(p.y - o.y), window.innerHeight - y))
		};
	}

	function resizeRegion(p) {
		const { handle, start } = state.drag;
		const W = window.innerWidth;
		const H = window.innerHeight;
		const min = state.cfg.minSize;
		const aspect = state.cfg.aspect;

		let left = start.x;
		let top = start.y;
		let right = start.x + start.width;
		let bottom = start.y + start.height;

		if (handle.includes('w')) left = clamp(p.x, 0, right - min);
		if (handle.includes('e')) right = clamp(p.x, left + min, W);
		if (handle.includes('n')) top = clamp(p.y, 0, bottom - min);
		if (handle.includes('s')) bottom = clamp(p.y, top + min, H);

		if (aspect) {
			// Locked ratio: grow from the opposite corner.
			const ax = handle.includes('w') ? right : left;
			const ay = handle.includes('n') ? bottom : top;
			let w = right - left;
			let h = bottom - top;
			if (w / h > aspect) {
				h = w / aspect;
			} else {
				w = h * aspect;
			}
			const maxW = handle.includes('w') ? ax : W - ax;
			const maxH = handle.includes('n') ? ay : H - ay;
			if (w > maxW) {
				w = maxW;
				h = w / aspect;
			}
			if (h > maxH) {
				h = maxH;
				w = h * aspect;
			}
			const minW = aspect < 1 ? min : min * aspect;
			if (w < minW) {
				w = minW;
				h = w / aspect;
			}
			left = handle.includes('w') ? ax - w : ax;
			top = handle.includes('n') ? ay - h : ay;
			right = left + w;
			bottom = top + h;
		}

		state.region = { x: left, y: top, width: right - left, height: bottom - top };
	}

	function onPointerMove(e) {
		if (!state.drag) {
			return;
		}
		const p = pointer(e);
		if (state.drag.type === 'move') {
			moveRegion(p);
		} else if (state.drag.type === 'new') {
			drawNewRegion(p);
		} else {
			resizeRegion(p);
		}
		layout();
	}

	function onPointerUp(e) {
		if (state.drag) {
			state.drag = null;
			if (body.hasPointerCapture(e.pointerId)) {
				body.releasePointerCapture(e.pointerId);
			}
		}
	}

	function confirmRegion() {
		if (state.phase !== 'select') {
			return;
		}
		const r = state.region;
		api.send('overlay:confirm', {
			x: Math.round(r.x),
			y: Math.round(r.y),
			width: Math.round(r.width),
			height: Math.round(r.height)
		});
		setPhase('preparing');
	}

	/* ------------------------------------------------------------------ countdown */

	async function runCountdown(seconds) {
		if (state.countdownStarted) {
			return;
		}
		state.countdownStarted = true;
		if (seconds > 0) {
			countdown.classList.add('is-visible');
			const ring = countdown.firstElementChild;
			for (let n = seconds; n > 0; n--) {
				countdownNum.textContent = String(n);
				ring.classList.remove('is-tick');
				void ring.offsetWidth;
				ring.classList.add('is-tick');
				await wait(1000);
			}
			countdown.classList.remove('is-visible');
			// Let the compositor drop the countdown frame before capture begins.
			await wait(60);
		}
		api.send('overlay:countdown-done');
	}

	/* ------------------------------------------------------------------ drawing */

	function resizeCanvas() {
		const dpr = window.devicePixelRatio || 1;
		canvas.width = Math.round(window.innerWidth * dpr);
		canvas.height = Math.round(window.innerHeight * dpr);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		renderStrokes();
	}

	function renderStrokes() {
		ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		for (const s of state.strokes) {
			ctx.strokeStyle = s.color;
			ctx.fillStyle = s.color;
			ctx.lineWidth = s.width;
			window.KasboDraw.stroke(ctx, s.tool, s.points, s.width, 1);
		}
	}

	function strokeId() {
		return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	}

	function queueSend() {
		if (state.sendQueued) {
			return;
		}
		state.sendQueued = true;
		requestAnimationFrame(() => {
			state.sendQueued = false;
			sendCurrent();
		});
	}

	function sendCurrent() {
		const s = state.current;
		if (s) {
			api.send('draw:update', {
				id: s.id,
				tool: s.tool,
				color: s.color,
				width: s.width,
				points: s.points
			});
		}
	}

	function onDrawStart(e) {
		if (!state.drawing || e.button !== 0) {
			return;
		}
		e.preventDefault();
		const p = pointer(e);
		state.current = {
			id: strokeId(),
			tool: state.tool,
			color: state.color,
			width: KASBO_WIDTHS[state.widthIndex],
			points: [p]
		};
		state.strokes.push(state.current);
		canvas.setPointerCapture(e.pointerId);
		renderStrokes();
		queueSend();
	}

	function onDrawMove(e) {
		const s = state.current;
		if (!s) {
			return;
		}
		const p = pointer(e);
		if (s.tool === 'pen') {
			const last = s.points[s.points.length - 1];
			if (Math.hypot(p.x - last.x, p.y - last.y) < 2 || s.points.length >= 4000) {
				return;
			}
			s.points.push(p);
		} else {
			s.points = [s.points[0], p];
		}
		renderStrokes();
		queueSend();
	}

	function onDrawEnd(e) {
		if (!state.current) {
			return;
		}
		sendCurrent();
		state.current = null;
		if (canvas.hasPointerCapture(e.pointerId)) {
			canvas.releasePointerCapture(e.pointerId);
		}
	}

	function setTool(tool) {
		state.tool = tool;
		drawBar.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('is-active', b.dataset.tool === tool));
	}

	function setColor(color) {
		state.color = color;
		drawBar.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('is-active', b.dataset.color === color));
	}

	function cycleWidth() {
		state.widthIndex = (state.widthIndex + 1) % KASBO_WIDTHS.length;
		setWidthDot();
	}

	function undo() {
		const s = state.strokes.pop();
		if (s) {
			api.send('draw:remove', s.id);
			renderStrokes();
		}
	}

	function clearAll() {
		state.strokes = [];
		state.current = null;
		renderStrokes();
	}

	function setWidthDot() {
		widthDot.style.setProperty('--kasbo-dot-size', `${4 + state.widthIndex * 4}px`);
	}

	function setDrawing(on) {
		state.drawing = !!on;
		body.classList.toggle('is-drawing', state.drawing);
		if (!state.drawing) {
			state.current = null;
		}
	}

	/* ------------------------------------------------------------------ events */

	frame.addEventListener('pointerdown', (e) => {
		const handle = e.target.dataset.handle;
		startDrag(e, handle ? 'resize' : 'move', handle);
	});

	body.addEventListener('pointerdown', (e) => {
		const onUi = frame.contains(e.target) || selectBar.contains(e.target);
		if (state.phase === 'select' && state.cfg && !state.cfg.aspect && !onUi) {
			startDrag(e, 'new');
		}
	});
	body.addEventListener('pointermove', onPointerMove);
	body.addEventListener('pointerup', onPointerUp);
	body.addEventListener('dblclick', (e) => {
		if (frame.contains(e.target)) {
			confirmRegion();
		}
	});

	canvas.addEventListener('pointerdown', onDrawStart);
	canvas.addEventListener('pointermove', onDrawMove);
	canvas.addEventListener('pointerup', onDrawEnd);
	canvas.addEventListener('pointercancel', onDrawEnd);

	selectBar.addEventListener('click', (e) => {
		const action = e.target.closest('[data-action]');
		if (!action) {
			return;
		}
		if (action.dataset.action === 'confirm') {
			confirmRegion();
		} else {
			api.send('overlay:cancel');
		}
	});

	drawBar.querySelectorAll('[data-color]').forEach((b) => {
		b.style.setProperty('--kasbo-swatch', b.dataset.color);
	});

	drawBar.addEventListener('click', (e) => {
		const btn = e.target.closest('button');
		if (!btn) {
			return;
		}
		if (btn.dataset.tool) {
			setTool(btn.dataset.tool);
		} else if (btn.dataset.color) {
			setColor(btn.dataset.color);
		} else if (btn.dataset.action === 'width') {
			cycleWidth();
		} else if (btn.dataset.action === 'undo') {
			undo();
		} else if (btn.dataset.action === 'clear') {
			clearAll();
			api.send('draw:clear');
		} else if (btn.dataset.action === 'done') {
			api.send('overlay:exit-draw');
		}
	});

	window.addEventListener('keydown', (e) => {
		if (state.phase === 'select') {
			if (e.key === 'Enter') {
				confirmRegion();
			} else if (e.key === 'Escape') {
				api.send('overlay:cancel');
			}
			return;
		}
		if (!state.drawing) {
			return;
		}
		if (e.key === 'Escape') {
			api.send('overlay:exit-draw');
		} else if (e.key === '1') {
			setTool('pen');
		} else if (e.key === '2') {
			setTool('arrow');
		} else if (e.key === '3') {
			setTool('rect');
		} else if (e.ctrlKey && e.key.toLowerCase() === 'z') {
			undo();
		}
	});

	window.addEventListener('resize', () => {
		resizeCanvas();
		layout();
	});

	api.on('overlay:phase', (payload) => {
		if (!payload) {
			return;
		}
		if (payload.region) {
			state.region = payload.region;
		}
		body.classList.toggle('no-frame', payload.showFrame === false);
		setPhase(payload.phase);
		layout();
		if (payload.phase === 'record') {
			runCountdown(payload.countdown || 0);
		}
	});

	// The capture frame glides after the cursor; keep the outline on it.
	api.on('overlay:region', (pos) => {
		state.region.x = pos.x;
		state.region.y = pos.y;
		frame.style.left = `${pos.x}px`;
		frame.style.top = `${pos.y}px`;
	});

	api.on('overlay:draw', (on) => setDrawing(on));
	api.on('overlay:clear', () => clearAll());

	/* ------------------------------------------------------------------ boot */

	(async () => {
		resizeCanvas();
		setWidthDot();
		const cfg = await api.invoke('overlay:get-config');
		if (!cfg) {
			return;
		}
		state.cfg = cfg;
		state.region = cfg.region;
		modeLabel.textContent = KASBO_MODE_LABELS[cfg.mode] || '';
		body.classList.toggle('is-free', !cfg.aspect);
		body.classList.toggle('no-frame', cfg.mode === 'fullscreen');
		setPhase(cfg.phase);
		layout();
		// Bar size is only known after it is displayed.
		requestAnimationFrame(layout);
	})();
})();

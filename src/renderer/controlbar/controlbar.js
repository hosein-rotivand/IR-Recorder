'use strict';

(() => {
	const api = window.kasbo;
	const bar = document.getElementById('kasbo-cbar');
	const timeEl = document.getElementById('kasbo-time');
	const buttons = {
		mic: bar.querySelector('[data-action="mic"]'),
		zoom: bar.querySelector('[data-action="zoom"]'),
		follow: bar.querySelector('[data-action="follow"]'),
		draw: bar.querySelector('[data-action="draw"]')
	};

	let state = { state: 'idle' };
	let clockOffset = 0;

	function format(ms) {
		const total = Math.max(0, Math.floor(ms / 1000));
		const h = Math.floor(total / 3600);
		const m = Math.floor((total % 3600) / 60);
		const s = total % 60;
		const pad = (n) => String(n).padStart(2, '0');
		return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
	}

	function elapsed() {
		if (!state.startedAt) {
			return 0;
		}
		const now = state.pausedAt || (Date.now() + clockOffset);
		return now - state.startedAt - state.pausedTotal;
	}

	function apply(next) {
		if (!next) {
			return;
		}
		state = next;
		if (typeof next.now === 'number') {
			clockOffset = next.now - Date.now();
		}
		bar.classList.toggle('is-paused', next.state === 'paused');
		bar.classList.toggle('is-muted', !!next.micMuted);
		buttons.mic.classList.toggle('is-hidden', !next.micEnabled);
		buttons.zoom.classList.toggle('is-on', !!next.zoom);
		buttons.follow.classList.toggle('is-on', !!next.follow);
		buttons.follow.classList.toggle('is-hidden', !next.followAvailable);
		buttons.draw.classList.toggle('is-on', !!next.drawing);
		timeEl.textContent = format(elapsed());
	}

	bar.addEventListener('click', (e) => {
		const btn = e.target.closest('[data-action]');
		if (btn) {
			api.send('ctrl:action', btn.dataset.action);
		}
	});

	api.on('ctrl:state', apply);
	api.invoke('ctrl:get-state').then(apply);

	setInterval(() => {
		timeEl.textContent = format(elapsed());
	}, 250);
})();

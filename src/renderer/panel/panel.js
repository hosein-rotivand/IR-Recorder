'use strict';

(() => {
	const api = window.kasbo;
	const $ = (selector) => document.querySelector(selector);

	const KASBO_RECORD_LABELS = {
		reels: 'انتخاب کادر ریلز و ضبط',
		youtube: 'انتخاب کادر یوتیوب و ضبط',
		custom: 'انتخاب کادر تب و ضبط',
		fullscreen: 'ضبط تمام صفحه'
	};

	const els = {
		notices: $('#kasbo-notices'),
		displayRow: $('#kasbo-display-row'),
		display: $('#kasbo-display'),
		mic: $('#kasbo-mic'),
		cam: $('#kasbo-cam'),
		camPreview: $('#kasbo-cam-preview'),
		meterBar: $('#kasbo-meter-bar'),
		zoomValue: $('#kasbo-zoom-value'),
		outputDir: $('#kasbo-output-dir'),
		record: $('#kasbo-record'),
		recordLabel: $('#kasbo-record-label'),
		progress: $('#kasbo-progress'),
		progressLabel: $('#kasbo-progress-label'),
		progressValue: $('#kasbo-progress-value'),
		progressBar: $('#kasbo-progress-bar'),
		result: $('#kasbo-result'),
		resultFile: $('#kasbo-result-file'),
		toast: $('#kasbo-toast')
	};

	let settings = null;
	let busy = false;
	let lastFile = null;
	let syncing = Promise.resolve();
	const preview = {
		camKey: '',
		camStream: null,
		micKey: '',
		micStream: null,
		audioCtx: null,
		raf: 0
	};

	/* ------------------------------------------------------------------ settings */

	async function update(patch) {
		settings = await api.invoke('settings:update', patch);
		render();
	}

	function render() {
		if (!settings) {
			return;
		}
		document.querySelectorAll('input[type="checkbox"][data-setting]').forEach((el) => {
			el.checked = !!settings[el.dataset.setting];
		});
		document.querySelectorAll('input[type="range"][data-setting]').forEach((el) => {
			el.value = String(settings[el.dataset.setting]);
		});
		document.querySelectorAll('[data-type="choice"]').forEach((group) => {
			const value = settings[group.dataset.setting];
			group.querySelectorAll('[data-value]').forEach((btn) => {
				const active = btn.dataset.value === value;
				btn.classList.toggle('is-active', active);
				btn.setAttribute('aria-pressed', String(active));
			});
		});
		document.querySelectorAll('[data-show-if], [data-hide-if-mode]').forEach((el) => {
			const shown = !el.dataset.showIf || !!settings[el.dataset.showIf];
			el.hidden = !shown || el.dataset.hideIfMode === settings.mode;
		});

		setSelectValue(els.mic, settings.micDeviceId);
		setSelectValue(els.cam, settings.webcamDeviceId);
		if (settings.displayId !== null) {
			setSelectValue(els.display, String(settings.displayId));
		}

		els.zoomValue.textContent = `${Number(settings.zoomLevel).toFixed(1)}×`;
		els.recordLabel.textContent = KASBO_RECORD_LABELS[settings.mode];
		queuePreviewSync();
	}

	function setSelectValue(select, value) {
		if ([...select.options].some((o) => o.value === value)) {
			select.value = value;
		}
	}

	/* ------------------------------------------------------------------ devices */

	async function loadDevices(unlockKind) {
		let list = await navigator.mediaDevices.enumerateDevices();
		const kind = unlockKind === 'audio' ? 'audioinput' : 'videoinput';
		if (unlockKind && list.some((d) => d.kind === kind && !d.label)) {
			// Labels stay hidden until the device has been opened once.
			try {
				const s = await navigator.mediaDevices.getUserMedia(unlockKind === 'audio' ? { audio: true } : { video: true });
				s.getTracks().forEach((t) => t.stop());
				list = await navigator.mediaDevices.enumerateDevices();
			} catch (err) {
				console.warn('[kasbo] Device access denied:', err);
			}
		}

		const mics = list.filter((d) => d.kind === 'audioinput');
		const cams = list.filter((d) => d.kind === 'videoinput');

		fillSelect(els.mic, mics, 'میکروفون', mics.some((d) => d.deviceId === 'default') ? null : { value: 'default', label: 'پیش‌فرض سیستم' });
		fillSelect(els.cam, cams, 'وبکم', cams.length ? null : { value: '', label: 'وبکمی پیدا نشد' });

		if (settings && settings.webcam && cams.length && !cams.some((c) => c.deviceId === settings.webcamDeviceId)) {
			await update({ webcamDeviceId: cams[0].deviceId });
		}
	}

	function fillSelect(select, devices, fallbackName, extra) {
		select.replaceChildren();
		if (extra) {
			select.append(new Option(extra.label, extra.value));
		}
		devices.forEach((d, i) => {
			select.append(new Option(d.label || `${fallbackName} ${i + 1}`, d.deviceId));
		});
	}

	/* ------------------------------------------------------------------ previews */

	function stopStream(stream) {
		if (stream) {
			stream.getTracks().forEach((t) => t.stop());
		}
	}

	function queuePreviewSync() {
		syncing = syncing.then(syncPreviews).catch((err) => console.warn('[kasbo] Preview failed:', err));
	}

	async function syncPreviews() {
		const visible = !busy && !document.hidden;

		const camKey = visible && settings.webcam ? `cam:${settings.webcamDeviceId}` : '';
		if (camKey !== preview.camKey) {
			preview.camKey = camKey;
			stopStream(preview.camStream);
			preview.camStream = null;
			els.camPreview.srcObject = null;
			if (camKey) {
				try {
					preview.camStream = await navigator.mediaDevices.getUserMedia({
						video: {
							deviceId: settings.webcamDeviceId ? { exact: settings.webcamDeviceId } : undefined,
							width: { ideal: 320 },
							height: { ideal: 320 }
						},
						audio: false
					});
					els.camPreview.srcObject = preview.camStream;
					await els.camPreview.play();
				} catch (err) {
					console.warn('[kasbo] Webcam preview failed:', err);
				}
			}
		}

		const micKey = visible && settings.mic ? `mic:${settings.micDeviceId}` : '';
		if (micKey !== preview.micKey) {
			preview.micKey = micKey;
			stopMeter();
			if (micKey) {
				await startMeter();
			}
		}
	}

	async function startMeter() {
		try {
			const id = settings.micDeviceId;
			preview.micStream = await navigator.mediaDevices.getUserMedia({
				audio: { deviceId: id && id !== 'default' ? { exact: id } : undefined },
				video: false
			});
			preview.audioCtx = new AudioContext();
			const analyser = preview.audioCtx.createAnalyser();
			analyser.fftSize = 512;
			preview.audioCtx.createMediaStreamSource(preview.micStream).connect(analyser);
			const data = new Float32Array(analyser.fftSize);

			const loop = () => {
				analyser.getFloatTimeDomainData(data);
				let sum = 0;
				for (let i = 0; i < data.length; i++) {
					sum += data[i] * data[i];
				}
				const rms = Math.sqrt(sum / data.length);
				els.meterBar.style.width = `${Math.min(100, rms * 400)}%`;
				preview.raf = requestAnimationFrame(loop);
			};
			loop();
		} catch (err) {
			console.warn('[kasbo] Mic preview failed:', err);
		}
	}

	function stopMeter() {
		cancelAnimationFrame(preview.raf);
		stopStream(preview.micStream);
		preview.micStream = null;
		if (preview.audioCtx) {
			preview.audioCtx.close().catch(() => {});
			preview.audioCtx = null;
		}
		els.meterBar.style.width = '0';
	}

	/* ------------------------------------------------------------------ status */

	function formatDuration(sec) {
		const total = Math.round(sec || 0);
		const m = Math.floor(total / 60);
		const s = total % 60;
		return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
	}

	function fileName(file) {
		return file.split(/[\\/]/).pop();
	}

	function showResult(done) {
		lastFile = done.file;
		els.resultFile.textContent = `${formatDuration(done.duration)} · ${fileName(done.file)}`;
		els.result.hidden = false;
	}

	function showToast(message) {
		els.toast.textContent = message;
		els.toast.hidden = false;
		clearTimeout(showToast.timer);
		showToast.timer = setTimeout(() => {
			els.toast.hidden = true;
		}, 9000);
	}

	function onStatus(status) {
		busy = status.state !== 'idle';
		els.record.disabled = busy;

		const encoding = status.state === 'encoding';
		els.progress.hidden = !encoding;
		els.record.hidden = encoding;
		if (encoding) {
			els.progressLabel.textContent = status.strategy === 'full' ? 'در حال ساخت MP4…' : 'در حال ذخیره…';
			const pct = Math.round((status.progress || 0) * 100);
			els.progressValue.textContent = `${pct}%`;
			els.progressBar.style.width = `${pct}%`;
		}

		if (status.state === 'selecting') {
			els.result.hidden = true;
			els.toast.hidden = true;
		}
		if (status.state === 'idle') {
			if (status.done) {
				showResult(status.done);
			}
			if (status.error) {
				showToast(status.error);
			}
		}
		queuePreviewSync();
	}

	/* ------------------------------------------------------------------ notices */

	function renderNotices(info) {
		const notices = [];
		if (info.platform !== 'win32') {
			notices.push('ضبط صدای سیستم فقط روی ویندوز فعال است.');
		}
		if (!info.ffmpeg) {
			notices.push('FFmpeg پیدا نشد؛ ویدیوها به صورت WebM ذخیره می‌شوند.');
		}
		if (!info.inputHook) {
			notices.push('ماژول ورودی بارگذاری نشد؛ هایلایت کلیک، نمایش کلیدها و زوم با کلیک کار نمی‌کنند.');
		}
		if (info.failedHotkeys.length) {
			notices.push(`این میانبرها را برنامه‌ی دیگری گرفته است: ${info.failedHotkeys.join('، ')}`);
		}
		els.notices.replaceChildren(...notices.map((text) => {
			const div = document.createElement('div');
			div.className = 'kasbo-notice';
			div.textContent = text;
			return div;
		}));
	}

	function renderDisplays(displays) {
		els.display.replaceChildren(...displays.map((d) => {
			const label = `مانیتور ${d.index} · ${d.width}×${d.height}${d.primary ? ' (اصلی)' : ''}`;
			return new Option(label, String(d.id));
		}));
		els.displayRow.hidden = displays.length < 2;
		const primary = displays.find((d) => d.primary);
		if (settings.displayId === null && primary) {
			els.display.value = String(primary.id);
		}
	}

	/* ------------------------------------------------------------------ actions */

	async function handleAction(action) {
		switch (action) {
			case 'record':
				if (!busy) {
					await api.invoke('session:start');
				}
				break;
			case 'choose-folder': {
				const dir = await api.invoke('app:choose-folder');
				if (dir) {
					els.outputDir.textContent = dir;
				}
				break;
			}
			case 'open-folder':
				await api.invoke('app:open-output-dir');
				break;
			case 'open-file':
				if (lastFile) {
					await api.invoke('app:open-file', lastFile);
				}
				break;
			case 'reveal-file':
				if (lastFile) {
					await api.invoke('app:reveal-file', lastFile);
				}
				break;
			case 'dismiss':
				els.result.hidden = true;
				break;
			default:
				break;
		}
	}

	document.addEventListener('click', (e) => {
		const choice = e.target.closest('[data-type="choice"] [data-value]');
		if (choice) {
			const group = choice.closest('[data-type="choice"]');
			update({ [group.dataset.setting]: choice.dataset.value });
			return;
		}
		const action = e.target.closest('[data-action]');
		if (action) {
			handleAction(action.dataset.action);
		}
	});

	document.addEventListener('change', async (e) => {
		const el = e.target;
		if (el === els.display) {
			update({ displayId: Number(el.value) });
			return;
		}
		if (!el.dataset || !el.dataset.setting) {
			return;
		}
		const key = el.dataset.setting;
		let value = el.value;
		if (el.type === 'checkbox') {
			value = el.checked;
		} else if (el.dataset.type === 'number') {
			value = parseFloat(el.value);
		}
		if (key === 'mic' && value) {
			await loadDevices('audio');
		}
		if (key === 'webcam' && value) {
			await loadDevices('video');
		}
		update({ [key]: value });
	});

	document.addEventListener('input', (e) => {
		if (e.target.dataset && e.target.dataset.setting === 'zoomLevel') {
			els.zoomValue.textContent = `${parseFloat(e.target.value).toFixed(1)}×`;
		}
	});

	document.addEventListener('visibilitychange', queuePreviewSync);
	navigator.mediaDevices.addEventListener('devicechange', () => loadDevices().then(render));

	api.on('panel:status', onStatus);

	/* ------------------------------------------------------------------ boot */

	(async () => {
		const [info, loaded, displays] = await Promise.all([
			api.invoke('app:get-info'),
			api.invoke('settings:get'),
			api.invoke('displays:list')
		]);
		settings = loaded;
		renderNotices(info);
		renderDisplays(displays);
		els.outputDir.textContent = info.outputDir;
		els.outputDir.title = info.outputDir;

		await loadDevices(settings.mic ? 'audio' : null);
		if (settings.webcam) {
			await loadDevices('video');
		}
		render();
	})();
})();

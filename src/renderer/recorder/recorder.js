'use strict';

(() => {
	const api = window.kasbo;

	// MP4/H.264 first: hardware encoded and saved without re-encoding.
	const KASBO_MIME_TYPES = [
		'video/mp4;codecs=avc1.640033,mp4a.40.2',
		'video/mp4;codecs=avc1,mp4a.40.2',
		'video/webm;codecs=h264,opus',
		'video/webm;codecs=vp9,opus',
		'video/webm;codecs=vp8,opus',
		'video/webm'
	];

	function kasboWaitForFrame(video, timeoutMs) {
		return new Promise((resolve, reject) => {
			if (video.readyState >= 2) {
				resolve();
				return;
			}
			const timer = setTimeout(() => reject(new Error('Video source did not start.')), timeoutMs);
			video.addEventListener('loadeddata', () => {
				clearTimeout(timer);
				resolve();
			}, { once: true });
		});
	}

	async function kasboCreateVideo(stream) {
		const video = document.createElement('video');
		video.muted = true;
		video.playsInline = true;
		video.srcObject = stream;
		document.body.appendChild(video);
		await video.play();
		await kasboWaitForFrame(video, 8000);
		return video;
	}

	class KasboRecorder {
		constructor() {
			this.cfg = null;
			this.screenStream = null;
			this.micStream = null;
			this.camStream = null;
			this.screenVideo = null;
			this.camVideo = null;
			this.audioCtx = null;
			this.micGainNode = null;
			this.micGainValue = 1;
			this.canvas = null;
			this.camera = null;
			this.follow = null;
			this.compositor = null;
			this.outStream = null;
			this.videoTrack = null;
			this.mediaRecorder = null;
			this.mimeType = '';
			this.chunkChain = Promise.resolve();
			this.running = false;
			this.paused = false;
			this.timer = null;
			this.lastTick = 0;
			this.nextTick = 0;
			this.warnings = [];
		}

		async prepare() {
			const cfg = await api.invoke('recorder:get-config');
			if (!cfg) {
				throw new Error('Recorder config unavailable.');
			}
			this.cfg = cfg;

			await this.openScreen();
			await this.openMic();
			await this.openWebcam();
			this.setupAudio();
			this.setupCanvas();

			return {
				ok: true,
				hasSystemAudio: this.screenStream.getAudioTracks().length > 0,
				hasMic: !!this.micStream,
				hasWebcam: !!this.camVideo,
				mimeType: this.mimeType,
				container: this.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm',
				h264: /avc1|h264/.test(this.mimeType),
				warnings: this.warnings
			};
		}

		async openScreen() {
			const { display, fps, audio } = this.cfg;
			const video = {
				frameRate: { ideal: fps, max: fps },
				width: { ideal: Math.round(display.bounds.width * display.scaleFactor) },
				height: { ideal: Math.round(display.bounds.height * display.scaleFactor) }
			};
			try {
				this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video, audio: audio.system });
			} catch (err) {
				if (!audio.system) {
					throw err;
				}
				this.warnings.push('system-audio');
				this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video, audio: false });
			}

			const track = this.screenStream.getVideoTracks()[0];
			track.addEventListener('ended', () => {
				if (this.running) {
					api.send('recorder:fatal', 'Screen capture ended.');
				}
			});
			this.screenVideo = await kasboCreateVideo(new MediaStream([track]));
		}

		async openMic() {
			const { audio } = this.cfg;
			if (!audio.mic) {
				return;
			}
			const deviceId = audio.micDeviceId && audio.micDeviceId !== 'default'
				? { exact: audio.micDeviceId }
				: undefined;
			try {
				this.micStream = await navigator.mediaDevices.getUserMedia({
					audio: {
						deviceId,
						echoCancellation: true,
						noiseSuppression: true,
						autoGainControl: true
					},
					video: false
				});
			} catch (err) {
				console.error('[kasbo] Microphone unavailable:', err);
				this.warnings.push('mic');
			}
		}

		async openWebcam() {
			const { webcam } = this.cfg;
			if (!webcam.enabled) {
				return;
			}
			try {
				this.camStream = await navigator.mediaDevices.getUserMedia({
					video: {
						deviceId: webcam.deviceId ? { exact: webcam.deviceId } : undefined,
						width: { ideal: 1280 },
						height: { ideal: 720 },
						frameRate: { ideal: 30 }
					},
					audio: false
				});
				this.camVideo = await kasboCreateVideo(this.camStream);
			} catch (err) {
				console.error('[kasbo] Webcam unavailable:', err);
				this.warnings.push('webcam');
			}
		}

		setupAudio() {
			const systemTracks = this.screenStream.getAudioTracks();
			if (!systemTracks.length && !this.micStream) {
				return;
			}
			const ctx = new AudioContext({ sampleRate: 48000 });
			const dest = ctx.createMediaStreamDestination();

			if (systemTracks.length) {
				const src = ctx.createMediaStreamSource(new MediaStream(systemTracks));
				const gain = ctx.createGain();
				gain.gain.value = this.cfg.audio.systemGain;
				src.connect(gain).connect(dest);
			}
			if (this.micStream) {
				const src = ctx.createMediaStreamSource(this.micStream);
				const gain = ctx.createGain();
				this.micGainValue = this.cfg.audio.micGain;
				gain.gain.value = this.micGainValue;
				src.connect(gain).connect(dest);
				this.micGainNode = gain;
			}
			this.audioCtx = ctx;
			this.audioDest = dest;
			ctx.resume();
		}

		setupCanvas() {
			const { output, features } = this.cfg;
			this.canvas = document.createElement('canvas');
			this.canvas.width = output.width;
			this.canvas.height = output.height;
			document.body.appendChild(this.canvas);

			this.follow = new window.KasboFollow({
				region: this.cfg.region,
				bounds: this.cfg.display.bounds,
				enabled: features.follow,
				speed: features.followSpeed
			});
			this.camera = new window.KasboCamera({
				enabled: features.autoZoom,
				zoomLevel: features.zoomLevel
			});
			this.compositor = new window.KasboCompositor({
				canvas: this.canvas,
				screenVideo: this.screenVideo,
				webcamVideo: this.camVideo,
				camera: this.camera,
				config: this.cfg
			});
			// The compositor reads the live, moving frame.
			this.compositor.region = this.follow.region;
			this.compositor.render(performance.now(), 0);

			this.outStream = this.canvas.captureStream(0);
			this.videoTrack = this.outStream.getVideoTracks()[0];
			if (this.audioDest) {
				this.outStream.addTrack(this.audioDest.stream.getAudioTracks()[0]);
			}
			this.mimeType = KASBO_MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
		}

		/* -------------------------------------------------------------- lifecycle */

		start() {
			if (this.running) {
				return;
			}
			const { output, fps } = this.cfg;
			// Final quality comes straight from this encoder, so keep it generous.
			const bitrate = Math.min(45e6, Math.round(output.width * output.height * fps * 0.14));
			this.mediaRecorder = new MediaRecorder(this.outStream, {
				mimeType: this.mimeType || undefined,
				videoBitsPerSecond: bitrate,
				audioBitsPerSecond: 192000
			});
			this.mediaRecorder.ondataavailable = (e) => {
				if (e.data && e.data.size > 0) {
					this.queueChunk(e.data);
				}
			};
			this.mediaRecorder.onstop = () => this.finish();
			this.mediaRecorder.onerror = (e) => {
				api.send('recorder:fatal', String((e.error && e.error.message) || 'MediaRecorder error'));
			};

			this.running = true;
			this.mediaRecorder.start(1000);
			this.startLoop();
		}

		pause() {
			if (!this.running || this.paused) {
				return;
			}
			this.paused = true;
			this.stopLoop();
			this.mediaRecorder.pause();
		}

		resume() {
			if (!this.running || !this.paused) {
				return;
			}
			this.paused = false;
			this.mediaRecorder.resume();
			this.startLoop();
		}

		stop() {
			if (!this.running) {
				api.send('recorder:finished');
				return;
			}
			this.running = false;
			this.stopLoop();
			if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
				this.mediaRecorder.stop();
			} else {
				this.finish();
			}
		}

		queueChunk(blob) {
			// Chunks must reach the file in order.
			this.chunkChain = this.chunkChain
				.then(() => blob.arrayBuffer())
				.then((buffer) => api.send('recorder:chunk', new Uint8Array(buffer)))
				.catch((err) => console.error('[kasbo] Chunk failed:', err));
		}

		async finish() {
			await this.chunkChain;
			for (const stream of [this.screenStream, this.micStream, this.camStream]) {
				if (stream) {
					stream.getTracks().forEach((t) => t.stop());
				}
			}
			if (this.audioCtx) {
				this.audioCtx.close().catch(() => {});
			}
			api.send('recorder:finished');
		}

		/* -------------------------------------------------------------- frame loop */

		startLoop() {
			this.lastTick = performance.now();
			this.nextTick = this.lastTick;
			this.tick();
		}

		stopLoop() {
			clearTimeout(this.timer);
			this.timer = null;
		}

		tick() {
			if (!this.running || this.paused) {
				return;
			}
			const now = performance.now();
			const dt = Math.min(0.1, (now - this.lastTick) / 1000);
			this.lastTick = now;

			const moved = this.follow.update(dt);
			this.camera.update(dt, now);
			this.compositor.render(now, dt);
			this.videoTrack.requestFrame();
			if (moved) {
				api.send('recorder:region', { x: this.follow.region.x, y: this.follow.region.y });
			}

			// Self-correcting timer: hidden windows have no requestAnimationFrame.
			const frameMs = 1000 / this.cfg.fps;
			this.nextTick += frameMs;
			if (this.nextTick < now - frameMs * 3) {
				this.nextTick = now + frameMs;
			}
			this.timer = setTimeout(() => this.tick(), Math.max(0, this.nextTick - performance.now()));
		}

		/* -------------------------------------------------------------- inputs */

		onCursor(p) {
			if (!this.compositor) {
				return;
			}
			this.follow.onCursor(p.x, p.y);
			const { nx, ny } = this.compositor.normalize(p.x, p.y);
			this.camera.onCursor(nx, ny);
		}

		onClick(p) {
			if (!this.compositor || this.paused) {
				return;
			}
			const now = performance.now();
			const { nx, ny } = this.compositor.normalize(p.x, p.y);
			if (!window.KasboCamera.inside(nx, ny)) {
				return;
			}
			if (this.cfg.features.clickHighlight) {
				this.compositor.addRipple(p.x, p.y, p.button, now);
			}
			if (p.button === 1) {
				this.camera.onClick(nx, ny, now);
			}
		}

		onKey(k) {
			if (!this.compositor || this.paused) {
				return;
			}
			const now = performance.now();
			if (this.cfg.features.keystrokes) {
				this.compositor.showKey(k, this.cfg.features.keystrokeMode, now);
			}
			this.camera.onKeepAlive(now);
		}

		setMicMuted(muted) {
			if (this.micGainNode && this.audioCtx) {
				this.micGainNode.gain.setTargetAtTime(muted ? 0 : this.micGainValue, this.audioCtx.currentTime, 0.02);
			}
		}
	}

	const recorder = new KasboRecorder();

	// Called by the main process with a user gesture (required by getDisplayMedia).
	window.kasboRecorderPrepare = async () => {
		try {
			return await recorder.prepare();
		} catch (err) {
			console.error('[kasbo] Prepare failed:', err);
			return { ok: false, error: String((err && err.message) || err) };
		}
	};

	api.on('rec:start', () => recorder.start());
	api.on('rec:pause', () => recorder.pause());
	api.on('rec:resume', () => recorder.resume());
	api.on('rec:stop', () => recorder.stop());
	api.on('rec:zoom', (enabled) => recorder.camera && recorder.camera.setEnabled(enabled));
	api.on('rec:follow', (enabled) => recorder.follow && recorder.follow.setEnabled(enabled));
	api.on('rec:mic-mute', (muted) => recorder.setMicMuted(!!muted));
	api.on('rec:webcam-corner', (corner) => recorder.compositor && recorder.compositor.setWebcamCorner(corner));
	api.on('input:cursor', (p) => recorder.onCursor(p));
	api.on('input:click', (p) => recorder.onClick(p));
	api.on('input:key', (k) => recorder.onKey(k));
	api.on('draw:update', (stroke) => recorder.compositor && recorder.compositor.setStroke(stroke));
	api.on('draw:remove', (id) => recorder.compositor && recorder.compositor.removeStroke(id));
	api.on('draw:clear', () => recorder.compositor && recorder.compositor.clearStrokes());
})();

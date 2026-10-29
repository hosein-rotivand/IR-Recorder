'use strict';

const fs = require('fs');
const { spawn } = require('child_process');

let kasboFfmpegPath = null;
try {
	kasboFfmpegPath = require('ffmpeg-static');
	if (kasboFfmpegPath) {
		// Binaries cannot run from inside the asar archive.
		kasboFfmpegPath = kasboFfmpegPath.replace('app.asar', 'app.asar.unpacked');
	}
} catch (err) {
	kasboFfmpegPath = null;
}

class KasboEncoder {
	constructor() {
		this.process = null;
	}

	get isAvailable() {
		return !!kasboFfmpegPath && fs.existsSync(kasboFfmpegPath);
	}

	/**
	 * Builds the final MP4.
	 * - copy:       H.264/AAC capture, only remuxed (near instant)
	 * - video-copy: H.264 video kept, Opus audio converted to AAC (fast)
	 * - full:       re-encode to constant 60fps H.264 (slow fallback)
	 */
	static buildArgs(strategy, input, output, fps) {
		const head = ['-hide_banner', '-y', '-i', input];
		const tail = ['-movflags', '+faststart', output];
		if (strategy === 'copy') {
			return [...head, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', ...tail];
		}
		const audio = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'];
		if (strategy === 'video-copy') {
			return [...head, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'copy', ...audio, ...tail];
		}
		return [
			...head,
			'-c:v', 'libx264',
			'-preset', 'veryfast',
			'-crf', '18',
			'-pix_fmt', 'yuv420p',
			'-r', String(fps),
			'-fps_mode', 'cfr',
			...audio,
			...tail
		];
	}

	encode({ input, output, durationSec, fps, strategy = 'full', onProgress }) {
		return new Promise((resolve, reject) => {
			if (!this.isAvailable) {
				reject(new Error('FFmpeg binary not found.'));
				return;
			}

			const args = KasboEncoder.buildArgs(strategy, input, output, fps);

			const proc = spawn(kasboFfmpegPath, args, { windowsHide: true });
			this.process = proc;

			let tail = '';
			proc.stderr.on('data', (chunk) => {
				const text = chunk.toString();
				tail = (tail + text).slice(-4000);
				const match = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
				if (match && durationSec > 0 && onProgress) {
					const seconds = (+match[1]) * 3600 + (+match[2]) * 60 + parseFloat(match[3]);
					onProgress(Math.min(1, seconds / durationSec));
				}
			});

			proc.on('error', (err) => {
				this.process = null;
				reject(err);
			});

			proc.on('close', (code) => {
				this.process = null;
				if (code === 0) {
					resolve(output);
				} else {
					reject(new Error(`FFmpeg exited with code ${code}\n${tail}`));
				}
			});
		});
	}

	cancel() {
		if (this.process) {
			this.process.kill();
			this.process = null;
		}
	}
}

module.exports = { KasboEncoder };

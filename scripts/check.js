'use strict';

// Syntax check for every JS file in src (no dependencies needed).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = [];
(function walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walk(full);
		} else if (entry.name.endsWith('.js')) {
			files.push(full);
		}
	}
})(path.join(__dirname, '..', 'src'));

let failed = 0;
for (const file of files) {
	try {
		execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
	} catch (err) {
		failed++;
		console.error(`✗ ${file}\n${err.stderr}`);
	}
}
console.log(`${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);

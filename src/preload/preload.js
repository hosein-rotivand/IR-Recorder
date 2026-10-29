'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Every channel a page may use is listed here; anything else is dropped.
const KASBO_INVOKE = [
	'app:get-info',
	'settings:get',
	'settings:update',
	'displays:list',
	'session:start',
	'app:choose-folder',
	'app:open-output-dir',
	'app:open-file',
	'app:reveal-file',
	'overlay:get-config',
	'recorder:get-config',
	'ctrl:get-state'
];

const KASBO_SEND = [
	'overlay:confirm',
	'overlay:cancel',
	'overlay:countdown-done',
	'overlay:exit-draw',
	'draw:update',
	'draw:remove',
	'draw:clear',
	'recorder:chunk',
	'recorder:finished',
	'recorder:region',
	'recorder:fatal',
	'ctrl:action'
];

const KASBO_RECEIVE = [
	'panel:status',
	'overlay:phase',
	'overlay:draw',
	'overlay:clear',
	'overlay:region',
	'rec:start',
	'rec:pause',
	'rec:resume',
	'rec:stop',
	'rec:zoom',
	'rec:follow',
	'rec:mic-mute',
	'rec:webcam-corner',
	'input:cursor',
	'input:click',
	'input:key',
	'draw:update',
	'draw:remove',
	'draw:clear',
	'ctrl:state'
];

contextBridge.exposeInMainWorld('kasbo', {
	invoke(channel, ...args) {
		if (!KASBO_INVOKE.includes(channel)) {
			return Promise.reject(new Error(`Blocked channel: ${channel}`));
		}
		return ipcRenderer.invoke(channel, ...args);
	},
	send(channel, ...args) {
		if (KASBO_SEND.includes(channel)) {
			ipcRenderer.send(channel, ...args);
		}
	},
	on(channel, callback) {
		if (!KASBO_RECEIVE.includes(channel) || typeof callback !== 'function') {
			return () => {};
		}
		const listener = (_event, ...args) => callback(...args);
		ipcRenderer.on(channel, listener);
		return () => ipcRenderer.removeListener(channel, listener);
	}
});

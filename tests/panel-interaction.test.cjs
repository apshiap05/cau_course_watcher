'use strict';

const assert = require('node:assert/strict');
const html = require('node:fs').readFileSync(0, 'utf8');
assert.match(html, /data-saved-interval="12000"/, '鼠标离开面板后未保存最新配置');
assert.match(html, /data-auto-save-toast="配置已自动保存"/, '自动保存后未显示可见提示');
assert.match(html, /data-authorization-saved="false"/, '本次授权不得写入持久配置');
process.stdout.write('browser panel autosave interaction: ok\n');

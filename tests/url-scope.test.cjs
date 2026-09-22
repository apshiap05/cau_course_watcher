'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const backgroundPath = path.join(root, 'chrome-extension', 'background.js');
const backgroundSource = `${fs.readFileSync(backgroundPath, 'utf8')}\nglobalThis.__isTargetUrl = isTargetUrl;`;
const context = vm.createContext({
  URL,
  console,
  setTimeout,
  clearTimeout,
  chrome: { runtime: { id: 'test', onMessage: { addListener() {} } } },
});
vm.runInContext(backgroundSource, context, { filename: backgroundPath });

const accepted = [
  'https://newjw.cau.edu.cn/jsxsd/xsxk',
  'https://newjw.cau.edu.cn/jsxsd/xsxk/',
  'https://newjw.cau.edu.cn/jsxsd/xsxk/xsxk_index?jx0502zbid=new-value',
  'https://newjw.cau.edu.cn/jsxsd/xsxk/任意/多层路径?x=1#y',
];
const rejected = [
  'http://newjw.cau.edu.cn/jsxsd/xsxk/',
  'https://newjw.cau.edu.cn/jsxsd/xsxkabc',
  'https://newjw.cau.edu.cn/jsxsd/xsxkkc/comeInFawxk',
  'https://evil.example/jsxsd/xsxk/',
  'not a url',
];
accepted.forEach((url) => assert.equal(context.__isTargetUrl(url), true, `应接受：${url}`));
rejected.forEach((url) => assert.equal(context.__isTargetUrl(url), false, `应拒绝：${url}`));

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'chrome-extension', 'manifest.json'), 'utf8'));
assert.deepEqual(manifest.content_scripts[0].matches, [
  'https://newjw.cau.edu.cn/jsxsd/xsxk',
  'https://newjw.cau.edu.cn/jsxsd/xsxk/*',
]);
assert.deepEqual(manifest.host_permissions, manifest.content_scripts[0].matches, '扩展权限不得超出选课路径范围');
const userscript = fs.readFileSync(path.join(root, 'userscript', 'cau-course-watcher.user.js'), 'utf8');
assert.match(userscript, /^\/\/ @match\s+https:\/\/newjw\.cau\.edu\.cn\/jsxsd\/xsxk$/m);
assert.match(userscript, /^\/\/ @match\s+https:\/\/newjw\.cau\.edu\.cn\/jsxsd\/xsxk\/\*$/m);
const popup = fs.readFileSync(path.join(root, 'chrome-extension', 'popup.js'), 'utf8');
assert.doesNotMatch(popup, /jx0502zbid|xsxk_index/);
assert.match(popup, /chrome\.tabs\.query/);

process.stdout.write('URL scope and stable entry tests: ok\n');

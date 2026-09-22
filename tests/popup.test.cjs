'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', 'chrome-extension', 'popup.js');
const source = fs.readFileSync(sourcePath, 'utf8');

async function runScenario(existingTabs) {
  let clickHandler;
  const calls = [];
  const context = vm.createContext({
    document: {
      getElementById() {
        return { addEventListener(_name, handler) { clickHandler = handler; } };
      },
    },
    window: { close() { calls.push(['close']); } },
    chrome: {
      tabs: {
        query: async (query) => { calls.push(['query', query]); return existingTabs; },
        update: async (id, options) => { calls.push(['update', id, options]); },
        create: async (options) => { calls.push(['create', options]); },
      },
      windows: { update: async (id, options) => { calls.push(['window', id, options]); } },
    },
  });
  vm.runInContext(source, context, { filename: sourcePath });
  await clickHandler();
  return calls;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

(async () => {
  const reuse = await runScenario([{ id: 17, windowId: 3 }]);
  assert.equal(reuse.some(([name]) => name === 'create'), false, '已有选课页时不应重复创建标签页');
  assert.deepEqual(plain(reuse.find(([name]) => name === 'update').slice(1)), [17, { active: true }]);
  assert.deepEqual(plain(reuse.find(([name]) => name === 'window').slice(1)), [3, { focused: true }]);

  const create = await runScenario([]);
  assert.deepEqual(plain(create.find(([name]) => name === 'create')[1]), { url: 'https://newjw.cau.edu.cn/jsxsd/xsxk/' });
  process.stdout.write('Chrome popup reuse-or-open behavior: ok\n');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

'use strict';

const TARGET_URL = 'https://newjw.cau.edu.cn/jsxsd/xsxk/';
const TARGET_PATTERNS = [
  'https://newjw.cau.edu.cn/jsxsd/xsxk',
  'https://newjw.cau.edu.cn/jsxsd/xsxk/*',
];

document.getElementById('open-page').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: TARGET_PATTERNS });
  const existing = tabs.find((tab) => Number.isInteger(tab.id));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    if (Number.isInteger(existing.windowId)) await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: TARGET_URL });
  }
  window.close();
});

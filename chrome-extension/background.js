'use strict';

const TARGET_ORIGIN = 'https://newjw.cau.edu.cn';
const TARGET_PATH = '/jsxsd/xsxk';
const activeSelections = new Set();
const NOTIFICATION_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function isTargetUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.origin === TARGET_ORIGIN &&
      (url.pathname === TARGET_PATH || url.pathname.startsWith(`${TARGET_PATH}/`));
  } catch (_) {
    return false;
  }
}

function validateSelectionMessage(message) {
  const required = /^[A-Za-z0-9_-]{1,128}$/;
  const optional = /^[A-Za-z0-9_-]{0,128}$/;
  const args = message?.args;
  if (!args || typeof args !== 'object') throw new Error('缺少选课参数。');
  if (!required.test(args.jx0404id || '')) throw new Error('通知单号未通过安全校验。');
  if (!required.test(args.kcid || '')) throw new Error('课程 ID 未通过安全校验。');
  if (!optional.test(args.cfbs || '')) throw new Error('重修标识未通过安全校验。');
  if (typeof message.autoConfirmAll !== 'boolean') throw new Error('弹窗确认设置无效。');
  return {
    jx0404id: args.jx0404id,
    kcid: args.kcid,
    cfbs: args.cfbs,
    autoConfirmAll: message.autoConfirmAll,
  };
}

async function runSelectionInPage(payload) {
  const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const required = /^[A-Za-z0-9_-]{1,128}$/;
  const optional = /^[A-Za-z0-9_-]{0,128}$/;
  const callPattern =
    /xsxkFun\s*\(\s*['"]([A-Za-z0-9_-]+)['"]\s*,\s*['"]([A-Za-z0-9_-]+)['"]\s*,\s*['"]([A-Za-z0-9_-]*)['"]\s*\)/;

  if (
    !payload ||
    !required.test(payload.jx0404id || '') ||
    !required.test(payload.kcid || '') ||
    !optional.test(payload.cfbs || '')
  ) {
    throw new Error('选课参数未通过页面环境安全校验。');
  }
  if (
    location.origin !== 'https://newjw.cau.edu.cn' ||
    (location.pathname !== '/jsxsd/xsxk' && !location.pathname.startsWith('/jsxsd/xsxk/'))
  ) {
    throw new Error('当前标签页不是指定的中国农业大学选课页面。');
  }

  const frameElement = document.getElementById('mainFrame');
  const frameWindow = frameElement?.contentWindow;
  const frameDocument = frameElement?.contentDocument;
  if (!frameWindow || !frameDocument?.documentElement) {
    throw new Error('自由选课页面尚未载入，请稍后重试。');
  }

  const matchingLink = Array.from(frameDocument.querySelectorAll('a[href], a[onclick]')).find((link) => {
    const source = `${link.getAttribute('href') || ''} ${link.getAttribute('onclick') || ''}`;
    const match = source.match(callPattern);
    return Boolean(
      match &&
      match[1] === payload.jx0404id &&
      match[2] === payload.kcid &&
      match[3] === payload.cfbs,
    );
  });
  if (!matchingLink) throw new Error('课程表中找不到与选课参数一致的“选课”按钮，已停止提交。');

  const row = matchingLink.closest('tr');
  const firstCell = row?.querySelector('td');
  if (!row || normalize(firstCell?.textContent) !== payload.jx0404id) {
    throw new Error('当前课程行与通知单号不一致，已停止提交。');
  }
  if (typeof frameWindow.xsxkFun !== 'function') {
    throw new Error('教务页面原生 xsxkFun 函数不存在。');
  }

  const messages = [];
  const confirmations = [];
  const originalAlert = frameWindow.alert;
  const originalConfirm = frameWindow.confirm;
  let lastDialogAt = Date.now();

  try {
    frameWindow.alert = (message) => {
      messages.push(normalize(message));
      lastDialogAt = Date.now();
    };
    if (payload.autoConfirmAll) {
      frameWindow.confirm = (message) => {
        confirmations.push(normalize(message));
        lastDialogAt = Date.now();
        return true;
      };
    }

    frameWindow.xsxkFun(payload.jx0404id, payload.kcid, payload.cfbs);
    lastDialogAt = Date.now();

    // 同一次选课流程可能在网络回调里继续弹窗。短暂等待到弹窗安静后再恢复原函数，
    // 同时设置硬上限，避免扩展永久影响页面的 alert/confirm。
    const startedAt = Date.now();
    while (Date.now() - startedAt < 15000 && Date.now() - lastDialogAt < 2500) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    frameWindow.alert = originalAlert;
    frameWindow.confirm = originalConfirm;
  }

  return { messages, confirmations };
}

function inspectPageHealthInMainWorld() {
  const frameElement = document.getElementById('mainFrame');
  const frameWindow = frameElement?.contentWindow;
  const frameDocument = frameElement?.contentDocument;
  let framePath = '';
  try { framePath = frameDocument?.location?.pathname || ''; } catch (_) { framePath = ''; }
  const hasCourseInput = Boolean(frameDocument?.querySelector?.('#kcxx'));
  const hasQueryButton = Boolean(frameDocument && [...frameDocument.querySelectorAll('input[type="button"], button')]
    .some((element) => String(element.value || element.textContent || '').replace(/\s+/g, '') === '查询'));
  return {
    frameReady: Boolean(frameWindow && frameDocument?.documentElement),
    framePath,
    entryReady: Boolean(hasCourseInput && hasQueryButton),
    tableReady: Boolean(frameDocument?.querySelector?.('#dataView')),
    nativeReady: typeof frameWindow?.xsxkFun === 'function',
    bridgeReady: true,
  };
}

function handleHealthCheck(message, sender, sendResponse) {
  (async () => {
    if (sender.id !== chrome.runtime.id || !sender.tab?.id || !isTargetUrl(sender.url)) {
      throw new Error('拒绝来自非目标选课页面的健康检查请求。');
    }
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: inspectPageHealthInMainWorld,
    });
    sendResponse({ ok: true, result: injectionResults?.[0]?.result || null });
  })().catch((error) => sendResponse({ ok: false, error: String(error?.message || error || '未知错误') }));
}

function handleSelection(message, sender, sendResponse) {
  (async () => {
    if (sender.id !== chrome.runtime.id || !sender.tab?.id || !isTargetUrl(sender.url)) {
      throw new Error('拒绝来自非目标选课页面的请求。');
    }
    const tabId = sender.tab.id;
    if (activeSelections.has(tabId)) throw new Error('该标签页已有选课流程正在执行。');
    const payload = validateSelectionMessage(message);
    activeSelections.add(tabId);
    try {
      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: runSelectionInPage,
        args: [payload],
      });
      const first = injectionResults?.[0];
      if (!first || !Object.prototype.hasOwnProperty.call(first, 'result')) {
        throw new Error('页面主环境未返回选课结果。');
      }
      sendResponse({ ok: true, result: first.result });
    } finally {
      activeSelections.delete(tabId);
    }
  })().catch((error) => {
    sendResponse({ ok: false, error: String(error?.message || error || '未知错误') });
  });
}

function handleNotification(message, sender, sendResponse) {
  (async () => {
    if (sender.id !== chrome.runtime.id || !isTargetUrl(sender.url)) {
      throw new Error('拒绝来自非目标选课页面的通知请求。');
    }
    const title = String(message.title || '选课余量监控助手').slice(0, 120);
    const body = String(message.message || '').slice(0, 1000);
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: NOTIFICATION_ICON,
      title,
      message: body || '选课页面有新的状态变化。',
      priority: 2,
    });
    sendResponse({ ok: true });
  })().catch((error) => {
    sendResponse({ ok: false, error: String(error?.message || error || '未知错误') });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'CAU_SELECT_COURSE') {
    handleSelection(message, sender, sendResponse);
    return true;
  }
  if (message?.type === 'CAU_NOTIFY') {
    handleNotification(message, sender, sendResponse);
    return true;
  }
  if (message?.type === 'CAU_HEALTH_CHECK') {
    handleHealthCheck(message, sender, sendResponse);
    return true;
  }
  return false;
});

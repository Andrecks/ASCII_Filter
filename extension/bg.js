// ASCII Shader — MV3 service worker.
// The action icon is a per-tab toggle. Enabled tabs auto-restart the filter after
// every navigation, and tabs opened FROM an enabled tab inherit the filter.
// The enabled set lives in storage.session (workers sleep and lose memory).

async function getEnabled() {
  const { en = [] } = await chrome.storage.session.get('en');
  return new Set(en);
}
async function setEnabled(s) {
  await chrome.storage.session.set({ en: [...s] });
}

async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return true;
  } catch (e) {
    console.warn('[ascii-shader] inject failed:', e.message);
    return false;
  }
}

function send(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

async function markBadge(tabId, on) {
  try {
    await chrome.action.setBadgeText({ tabId, text: on ? 'ON' : '' });
    if (on) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#2f5c39' });
  } catch { /* tab gone */ }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  const en = await getEnabled();
  if (en.has(tab.id)) {
    en.delete(tab.id);
    await setEnabled(en);
    await markBadge(tab.id, false);
    send(tab.id, { cmd: 'stopcmd' });
  } else {
    en.add(tab.id);
    await setEnabled(en);
    await markBadge(tab.id, true);
    if (await inject(tab.id)) send(tab.id, { cmd: 'autostart', invoked: true });
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete') return;
  const en = await getEnabled();
  if (!en.has(tabId)) return;
  if (!/^(https?|file):/.test(tab.url || '')) return;
  await markBadge(tabId, true);
  if (await inject(tabId)) send(tabId, { cmd: 'autostart', invoked: false });
});

// tabs opened from an enabled tab (target=_blank, ctrl+click) inherit the filter
chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.id == null || tab.openerTabId == null) return;
  const en = await getEnabled();
  if (en.has(tab.openerTabId) && !en.has(tab.id)) {
    en.add(tab.id);
    await setEnabled(en);
    await markBadge(tab.id, true);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const en = await getEnabled();
  if (en.delete(tabId)) await setEnabled(en);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !sender.tab || sender.tab.id == null) return;
  if (msg.cmd === 'streamId') {
    chrome.tabCapture.getMediaStreamId({ targetTabId: sender.tab.id }, (id) => {
      sendResponse({ id, err: chrome.runtime.lastError ? chrome.runtime.lastError.message : null });
    });
    return true; // async sendResponse
  }
  if (msg.cmd === 'disable') {
    getEnabled().then(async (en) => {
      if (en.delete(sender.tab.id)) await setEnabled(en);
      await markBadge(sender.tab.id, false);
    });
  }
});

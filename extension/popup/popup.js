const $ = (id) => document.getElementById(id);

const DEFAULT_SERVER = 'ws://localhost:8787';

function randomRoom() {
  return Math.random().toString(36).slice(2, 8);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function askContent(msg) {
  const tab = await activeTab();
  if (!tab || !tab.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    return null; // content script not present (chrome:// pages, web store, etc.)
  }
}

function showInParty(room) {
  $('start').classList.add('hidden');
  $('leave').classList.remove('hidden');
  $('status').textContent = `In party: room ${room}. Invite link is in the sidebar.`;
}

function showIdle(text) {
  $('start').classList.remove('hidden');
  $('leave').classList.add('hidden');
  $('status').textContent = text || '';
}

async function init() {
  const stored = await chrome.storage.local.get({ name: '', server: DEFAULT_SERVER });
  $('name').value = stored.name;
  $('server').value = stored.server;

  const status = await askContent({ cmd: 'status' });
  if (!status) {
    showIdle('Open a video page first (this page cannot host a party).');
    $('start').disabled = true;
    return;
  }
  if (status.inParty) {
    showInParty(status.room);
  } else if (!status.hasVideo) {
    showIdle('No video found on this page yet. You can still start; the player will be picked up once it loads.');
  }
}

$('start').addEventListener('click', async () => {
  const name = $('name').value.trim() || 'Guest';
  const server = $('server').value.trim() || DEFAULT_SERVER;
  await chrome.storage.local.set({ name, server });

  const res = await askContent({
    cmd: 'start',
    room: randomRoom(),
    server,
    name
  });
  if (res && res.ok) {
    const status = await askContent({ cmd: 'status' });
    showInParty(status ? status.room : '');
  } else {
    $('status').textContent = 'Could not start a party on this page.';
  }
});

$('leave').addEventListener('click', async () => {
  await askContent({ cmd: 'leave' });
  showIdle('Left the party.');
});

init();

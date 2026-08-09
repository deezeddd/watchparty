// WatchParty content script.
// Controls the page's <video> element and bridges it to the sidebar
// iframe (which owns the WebSocket connection, chat, and the call).

(() => {
  if (window.__watchPartyLoaded) return;
  window.__watchPartyLoaded = true;

  const IS_NETFLIX = location.hostname.endsWith('netflix.com');
  const SUPPRESS_MS = 1200;

  let sidebarFrame = null;
  let sidebarWrap = null;
  let video = null;
  let party = null; // { room, server, name }

  // Timestamps of remotely-applied actions, so we don't echo them back.
  const suppressed = { play: 0, pause: 0, seek: 0 };

  // ---------- video discovery ----------

  function findVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = v; bestArea = area; }
    }
    return best;
  }

  function attachVideo(v) {
    if (!v || v === video) return;
    if (video) detachVideo(video);
    video = v;
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeked', onSeeked);
  }

  function detachVideo(v) {
    v.removeEventListener('play', onPlay);
    v.removeEventListener('pause', onPause);
    v.removeEventListener('seeked', onSeeked);
  }

  // SPA sites swap the player element; re-evaluate periodically while in a party.
  setInterval(() => {
    if (!party) return;
    const v = findVideo();
    if (v && v !== video) attachVideo(v);
  }, 2000);

  // ---------- local event -> sidebar ----------

  function fresh(action) {
    return Date.now() - suppressed[action] < SUPPRESS_MS;
  }

  function onPlay() {
    if (fresh('play')) return;
    toSidebar({ type: 'video-event', action: 'play', time: video.currentTime });
  }

  function onPause() {
    if (fresh('pause')) return;
    // A remote seek on some players fires pause+play around the jump; ignore those too.
    if (fresh('seek')) return;
    toSidebar({ type: 'video-event', action: 'pause', time: video.currentTime });
  }

  let seekTimer = null;
  function onSeeked() {
    if (fresh('seek')) return;
    // Debounce scrubbing: only report where the user lands.
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => {
      if (video) toSidebar({ type: 'video-event', action: 'seek', time: video.currentTime });
    }, 300);
  }

  // ---------- remote control -> video ----------

  function netflixCommand(action, timeMs) {
    window.dispatchEvent(new CustomEvent('WP_NETFLIX_CMD', {
      detail: JSON.stringify({ action, timeMs })
    }));
  }

  function applyControl(action, time) {
    if (!video) attachVideo(findVideo());
    if (!video) return;
    suppressed[action] = Date.now();
    if (IS_NETFLIX) {
      if (action === 'seek') {
        netflixCommand('seek', Math.round(time * 1000));
      } else {
        netflixCommand(action);
      }
      return;
    }
    if (action === 'play') {
      if (Math.abs(video.currentTime - time) > 1.5) {
        suppressed.seek = Date.now();
        video.currentTime = time;
      }
      video.play().catch(() => {});
    } else if (action === 'pause') {
      video.pause();
      if (Math.abs(video.currentTime - time) > 1.5) {
        suppressed.seek = Date.now();
        video.currentTime = time;
      }
    } else if (action === 'seek') {
      video.currentTime = time;
    }
  }

  // ---------- sidebar iframe ----------

  function buildInviteLink() {
    const url = new URL(location.href);
    url.hash = '';
    return `${url.href}#wp=${encodeURIComponent(party.room)}&wps=${encodeURIComponent(party.server)}`;
  }

  function openSidebar() {
    if (sidebarWrap) return;
    sidebarWrap = document.createElement('div');
    sidebarWrap.id = '__watchparty_sidebar';
    sidebarWrap.style.cssText = [
      'position:fixed', 'top:0', 'right:0', 'width:330px', 'height:100vh',
      'z-index:2147483647', 'box-shadow:-2px 0 12px rgba(0,0,0,.5)',
      'transition:transform .2s ease'
    ].join(';');

    sidebarFrame = document.createElement('iframe');
    const params = new URLSearchParams({
      room: party.room,
      server: party.server,
      name: party.name
    });
    sidebarFrame.src = chrome.runtime.getURL('sidebar/sidebar.html') + '?' + params;
    sidebarFrame.allow = 'camera; microphone; autoplay';
    sidebarFrame.style.cssText = 'width:100%;height:100%;border:0;background:#141414';
    sidebarWrap.appendChild(sidebarFrame);

    const toggle = document.createElement('button');
    toggle.textContent = '▶';
    toggle.title = 'Hide/show WatchParty';
    toggle.style.cssText = [
      'position:absolute', 'left:-28px', 'top:50%', 'width:28px', 'height:56px',
      'border:0', 'border-radius:6px 0 0 6px', 'background:#e50914', 'color:#fff',
      'cursor:pointer', 'font-size:12px'
    ].join(';');
    let hidden = false;
    toggle.addEventListener('click', () => {
      hidden = !hidden;
      sidebarWrap.style.transform = hidden ? 'translateX(330px)' : '';
      toggle.style.left = '-28px';
      toggle.textContent = hidden ? '◀' : '▶';
    });
    sidebarWrap.appendChild(toggle);

    document.documentElement.appendChild(sidebarWrap);
    attachVideo(findVideo());
  }

  function closeSidebar() {
    if (sidebarWrap) sidebarWrap.remove();
    sidebarWrap = null;
    sidebarFrame = null;
    party = null;
    if (video) { detachVideo(video); video = null; }
  }

  function toSidebar(obj) {
    if (sidebarFrame && sidebarFrame.contentWindow) {
      sidebarFrame.contentWindow.postMessage({ __wp: 1, ...obj }, '*');
    }
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || msg.__wp !== 1) return;
    if (sidebarFrame && e.source !== sidebarFrame.contentWindow) return;
    switch (msg.type) {
      case 'ready':
        toSidebar({ type: 'init', inviteLink: buildInviteLink() });
        break;
      case 'control':
        applyControl(msg.action, msg.time);
        break;
      case 'get-state':
        toSidebar({
          type: 'state-reply',
          to: msg.to,
          paused: video ? video.paused : true,
          time: video ? video.currentTime : 0
        });
        break;
      case 'leave':
        closeSidebar();
        break;
    }
  });

  // ---------- popup commands ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.cmd === 'status') {
      sendResponse({ inParty: !!party, room: party ? party.room : null, hasVideo: !!findVideo() });
    } else if (msg.cmd === 'start') {
      party = { room: msg.room, server: msg.server, name: msg.name };
      openSidebar();
      sendResponse({ ok: true, inviteLink: buildInviteLink() });
    } else if (msg.cmd === 'leave') {
      closeSidebar();
      sendResponse({ ok: true });
    }
    return false;
  });

  // ---------- invite-link auto-join ----------

  const m = location.hash.match(/wp=([^&]+)&wps=([^&]+)/);
  if (m) {
    chrome.storage.local.get({ name: 'Guest' }).then(({ name }) => {
      party = {
        room: decodeURIComponent(m[1]),
        server: decodeURIComponent(m[2]),
        name
      };
      openSidebar();
    });
  }
})();

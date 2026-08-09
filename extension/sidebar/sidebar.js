// WatchParty sidebar app.
// Owns the WebSocket connection to the signaling server, the chat,
// and the WebRTC mesh call. Runs in two modes:
//   embedded   – inside the iframe injected by content.js; bridges
//                playback sync to the page via postMessage.
//   standalone – opened as its own window ("pop out" fallback when the
//                host page blocks camera access in embedded iframes).

(() => {
  const params = new URLSearchParams(location.search);
  const ROOM = params.get('room');
  const SERVER = params.get('server');
  const NAME = params.get('name') || 'Guest';
  const STANDALONE = params.get('mode') === 'window';

  const RTC_CONFIG = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  };

  const $ = (id) => document.getElementById(id);

  let ws = null;
  let selfId = null;
  const peers = new Map(); // id -> { name }
  let gotInitialState = false;

  // ---------- page bridge (embedded mode only) ----------

  function toPage(obj) {
    if (!STANDALONE && window.parent !== window) {
      window.parent.postMessage({ __wp: 1, ...obj }, '*');
    }
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || msg.__wp !== 1) return;
    switch (msg.type) {
      case 'init':
        $('inviteLink').value = msg.inviteLink;
        $('inviteRow').classList.remove('hidden');
        break;
      case 'video-event':
        send({ type: 'sync', action: msg.action, time: msg.time });
        break;
      case 'state-reply':
        send({ type: 'state', to: msg.to, paused: msg.paused, time: msg.time });
        break;
    }
  });

  // ---------- websocket ----------

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function connect() {
    let url;
    try {
      url = new URL(SERVER);
    } catch {
      setStatus('bad server URL');
      return;
    }
    ws = new WebSocket(url.href);

    ws.onopen = () => {
      send({ type: 'join', room: ROOM, name: STANDALONE ? `${NAME} (call)` : NAME });
    };

    ws.onclose = () => {
      setStatus('disconnected — retrying…');
      setTimeout(connect, 3000);
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handle(msg);
    };
  }

  function setStatus(text) {
    $('status').textContent = text;
  }

  function refreshRoster() {
    const names = [NAME + ' (you)', ...[...peers.values()].map(p => p.name)];
    $('roster').textContent = `In party: ${names.join(', ')}`;
    setStatus(`room ${ROOM} · ${peers.size + 1} watching`);
  }

  function handle(msg) {
    switch (msg.type) {
      case 'joined':
        selfId = msg.selfId;
        peers.clear();
        for (const p of msg.peers) peers.set(p.id, { name: p.name });
        refreshRoster();
        systemMsg(`You joined room ${ROOM}`);
        // Ask the room where the video is; first reply wins.
        if (!STANDALONE && peers.size > 0 && !gotInitialState) {
          send({ type: 'state-request' });
        }
        break;

      case 'peer-joined':
        peers.set(msg.id, { name: msg.name });
        refreshRoster();
        systemMsg(`${msg.name} joined`);
        // If we're in the call, ring the newcomer when they join it too
        // (handled by their call/join broadcast).
        break;

      case 'peer-left':
        if (peers.has(msg.id)) {
          systemMsg(`${peers.get(msg.id).name} left`);
          peers.delete(msg.id);
          refreshRoster();
        }
        dropPeerConnection(msg.id);
        break;

      case 'sync':
        if (STANDALONE) break;
        gotInitialState = true;
        toPage({ type: 'control', action: msg.action, time: msg.time });
        break;

      case 'state-request':
        // Only embedded clients have a video to report.
        if (!STANDALONE) toPage({ type: 'get-state', to: msg.from });
        break;

      case 'state':
        if (STANDALONE || gotInitialState) break;
        gotInitialState = true;
        toPage({ type: 'control', action: 'seek', time: msg.time });
        toPage({ type: 'control', action: msg.paused ? 'pause' : 'play', time: msg.time });
        break;

      case 'chat':
        chatMsg(msg.name, msg.text, false);
        break;

      case 'call':
        handleCallMembership(msg);
        break;

      case 'signal':
        handleSignal(msg);
        break;
    }
  }

  // ---------- chat ----------

  function systemMsg(text) {
    const div = document.createElement('div');
    div.className = 'msg system';
    div.textContent = text;
    appendMsg(div);
  }

  function chatMsg(who, text, me) {
    const div = document.createElement('div');
    div.className = 'msg' + (me ? ' me' : '');
    const whoSpan = document.createElement('span');
    whoSpan.className = 'who';
    whoSpan.textContent = who;
    div.appendChild(whoSpan);
    div.appendChild(document.createTextNode(text));
    appendMsg(div);
  }

  function appendMsg(el) {
    const box = $('messages');
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
  }

  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text) return;
    send({ type: 'chat', text });
    chatMsg(NAME, text, true);
    input.value = '';
  });

  // ---------- call (WebRTC mesh) ----------

  let localStream = null;
  let inCall = false;
  const pcs = new Map(); // peerId -> RTCPeerConnection

  async function joinCall() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 } },
        audio: true
      });
    } catch (err) {
      $('callError').classList.remove('hidden');
      return;
    }
    inCall = true;
    addTile('self', localStream, `${NAME} (you)`, true);
    $('joinCall').classList.add('hidden');
    $('leaveCall').classList.remove('hidden');
    $('muteMic').classList.remove('hidden');
    $('muteCam').classList.remove('hidden');
    $('callError').classList.add('hidden');
    // Everyone already in the call will send us an offer.
    send({ type: 'call', sub: 'join' });
  }

  function leaveCall(broadcast = true) {
    inCall = false;
    if (broadcast) send({ type: 'call', sub: 'leave' });
    for (const id of [...pcs.keys()]) dropPeerConnection(id);
    if (localStream) {
      for (const t of localStream.getTracks()) t.stop();
      localStream = null;
    }
    removeTile('self');
    $('joinCall').classList.remove('hidden');
    $('leaveCall').classList.add('hidden');
    $('muteMic').classList.add('hidden');
    $('muteCam').classList.add('hidden');
  }

  function handleCallMembership(msg) {
    if (msg.sub === 'join' && inCall && msg.from !== selfId) {
      // We're already in the call: offer to the newcomer.
      makeOffer(msg.from);
    } else if (msg.sub === 'leave') {
      dropPeerConnection(msg.from);
    }
  }

  function newPC(peerId) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pcs.set(peerId, pc);

    if (localStream) {
      for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) send({ type: 'signal', to: peerId, data: { candidate: e.candidate } });
    };

    pc.ontrack = (e) => {
      const name = peers.get(peerId) ? peers.get(peerId).name : 'Peer';
      addTile(peerId, e.streams[0], name, false);
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        dropPeerConnection(peerId);
      }
    };

    return pc;
  }

  async function makeOffer(peerId) {
    dropPeerConnection(peerId);
    const pc = newPC(peerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'signal', to: peerId, data: { sdp: pc.localDescription } });
  }

  async function handleSignal(msg) {
    const peerId = msg.from;
    const data = msg.data || {};

    if (data.sdp) {
      if (data.sdp.type === 'offer') {
        if (!inCall) return; // not in the call; ignore rings
        let pc = pcs.get(peerId) || newPC(peerId);
        await pc.setRemoteDescription(data.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({ type: 'signal', to: peerId, data: { sdp: pc.localDescription } });
      } else if (data.sdp.type === 'answer') {
        const pc = pcs.get(peerId);
        if (pc) await pc.setRemoteDescription(data.sdp);
      }
    } else if (data.candidate) {
      const pc = pcs.get(peerId);
      if (pc) {
        try { await pc.addIceCandidate(data.candidate); } catch {}
      }
    }
  }

  function dropPeerConnection(peerId) {
    const pc = pcs.get(peerId);
    if (pc) {
      pc.close();
      pcs.delete(peerId);
    }
    removeTile(peerId);
  }

  // ---------- video tiles ----------

  function addTile(id, stream, label, muted) {
    removeTile(id);
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.peer = id;
    const v = document.createElement('video');
    v.autoplay = true;
    v.playsInline = true;
    v.muted = muted;
    v.srcObject = stream;
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = label;
    tile.appendChild(v);
    tile.appendChild(tag);
    $('videoGrid').appendChild(tile);
  }

  function removeTile(id) {
    const el = $('videoGrid').querySelector(`[data-peer="${CSS.escape(id)}"]`);
    if (el) el.remove();
  }

  // ---------- controls ----------

  $('joinCall').addEventListener('click', joinCall);
  $('leaveCall').addEventListener('click', () => leaveCall(true));

  $('muteMic').addEventListener('click', (e) => {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    e.target.textContent = track.enabled ? 'Mute' : 'Unmute';
  });

  $('muteCam').addEventListener('click', (e) => {
    if (!localStream) return;
    const track = localStream.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    e.target.textContent = track.enabled ? 'Cam off' : 'Cam on';
  });

  $('popOut').addEventListener('click', () => {
    const url = location.pathname + '?' + new URLSearchParams({
      room: ROOM, server: SERVER, name: NAME, mode: 'window'
    });
    window.open(chrome.runtime.getURL(url.replace(/^\//, '')), 'wp-call',
      'width=380,height=560,popup=yes');
  });

  $('copyInvite').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('inviteLink').value);
      $('copyInvite').textContent = 'Copied!';
      setTimeout(() => { $('copyInvite').textContent = 'Copy'; }, 1500);
    } catch {
      $('inviteLink').select();
    }
  });

  $('leaveParty').addEventListener('click', () => {
    leaveCall(true);
    if (ws) { ws.onclose = null; ws.close(); }
    if (STANDALONE) window.close();
    else toPage({ type: 'leave' });
  });

  // ---------- boot ----------

  if (STANDALONE) {
    $('inviteRow').classList.add('hidden');
    document.title = 'WatchParty call';
  }

  if (!ROOM || !SERVER) {
    setStatus('missing room/server');
  } else {
    connect();
    toPage({ type: 'ready' });
  }
})();

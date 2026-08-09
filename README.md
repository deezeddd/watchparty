# WatchParty

A FlickCall-style watch party: a Chrome extension that synchronizes video
playback across friends and overlays a chat + WebRTC video call on the
player. Works on YouTube, Netflix, Hotstar, JioCinema, and any site with
a plain `<video>` element.

Media is peer-to-peer (WebRTC); the server only relays room events and
call signaling. It never sees your streams or chats beyond the text chat
relay.

## Layout

```
server/      Node WebSocket signaling + sync relay (rooms behind invite links)
extension/   Chrome MV3 extension
  content/   page-side: video adapter, suppression logic, sidebar injection
  sidebar/   the party UI: WebSocket client, chat, WebRTC mesh call
  popup/     start/leave a party, set name + server
```

## Run it

1. Start the server:

   ```sh
   cd server && npm install && npm start   # listens on :8787
   ```

2. Load the extension: `chrome://extensions` → enable Developer mode →
   "Load unpacked" → select the `extension/` folder.

3. Open a video (start with YouTube), click the WatchParty icon, set your
   name, and hit **Start party on this tab**. The sidebar appears with an
   invite link.

4. A friend opens the invite link (same video URL with a `#wp=...` hash)
   with the extension installed — they auto-join, playback syncs, and
   either of you can pause/play/seek for everyone.

5. **Join call** in the sidebar starts the camera/mic and connects
   peer-to-peer with everyone else who joined the call.

## How sync works

The content script hooks the page's largest `<video>` and reports genuine
user actions (play/pause/seek) to the sidebar, which broadcasts them to
the room. Incoming remote actions are applied with a 1.2 s suppression
window so they don't echo back. New joiners request state and jump to the
room's current position.

Netflix ignores `video.currentTime` writes, so on netflix.com a
MAIN-world script drives Netflix's internal player API instead
(`content/netflix-main.js`). That API is unofficial and may break when
Netflix ships a new player.

## Known limitations (v0.1)

- **Remote friends need a public server.** `ws://localhost:8787` works
  only for testing with yourself. To watch with others, deploy `server/`
  anywhere that supports WebSockets (Fly.io, Railway, a VPS) and use
  `wss://your-host` in the popup. The invite link embeds the server URL.
- **NAT traversal is STUN-only.** Some peer pairs (common on Indian
  mobile networks with CGNAT) will fail to connect the video call until
  a TURN server is added to `RTC_CONFIG` in `sidebar/sidebar.js`.
  coturn or a hosted TURN (Twilio, Metered) drops in with one config line.
- **Camera inside the sidebar can be blocked** by some sites'
  Permissions-Policy. The sidebar detects this and offers
  "Open call in a window", which runs the same call UI in a separate
  extension window connected to the same room.
- Everyone must have their own access to the streaming service; the
  extension syncs playback, it does not share the stream itself.
- Both sides should be on the same video URL (the invite link handles
  this). Episode auto-advance is not synced yet.

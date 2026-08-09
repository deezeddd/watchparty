// Runs in the page's MAIN world on netflix.com only.
// Netflix ignores writes to video.currentTime, so seek/play/pause go
// through its internal player API. Unofficial API: expect breakage
// when Netflix ships a new player build.

(() => {
  function getPlayer() {
    const api = window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
    if (!api) return null;
    const ids = api.getAllPlayerSessionIds();
    if (!ids || !ids.length) return null;
    return api.getVideoPlayerBySessionId(ids[0]);
  }

  window.addEventListener('WP_NETFLIX_CMD', (e) => {
    let cmd;
    try {
      cmd = JSON.parse(e.detail);
    } catch {
      return;
    }
    const player = getPlayer();
    if (!player) return;
    try {
      if (cmd.action === 'seek') player.seek(cmd.timeMs);
      else if (cmd.action === 'play') player.play();
      else if (cmd.action === 'pause') player.pause();
    } catch (err) {
      // Player API changed; the generic adapter will still handle play/pause events.
    }
  });
})();

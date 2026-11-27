// services/assistant/stream/ndjson.js
//
// The stream a turn is answered on: one JSON object per line, each with a
// `t` (start, context, text, tool, card, choices, usage, error, ping, done). The web
// app and the mobile app read it the same way, line by line.
//
// A ping goes out every 15 seconds while a turn is quiet: the host closes a
// connection that carries nothing for five minutes, and a proxy in between
// may do it sooner.

const PING_MS = 15_000;

function openStream(res) {
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let open = true;
  const write = (event) => {
    if (!open || res.writableEnded || res.destroyed) return false;
    res.write(`${JSON.stringify(event)}\n`);
    return true;
  };
  const timer = setInterval(() => write({ t: 'ping' }), PING_MS);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    send: write,
    end() {
      if (!open) return;
      open = false;
      clearInterval(timer);
      if (!res.writableEnded) res.end();
    },
    get open() {
      return open && !res.writableEnded && !res.destroyed;
    },
  };
}

module.exports = { openStream, PING_MS };

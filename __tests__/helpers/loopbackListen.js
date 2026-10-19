// Test servers listen on 127.0.0.1 only (final review M8, flaky suites).
//
// supertest starts each test's server with listen(0), which binds every
// interface, and then connects to 127.0.0.1:<port>. When another program on
// the machine already listens on 127.0.0.1 at that same port number (local
// helpers bind loopback-only ephemeral ports), the wildcard bind still
// succeeds (SO_REUSEADDR) and the request reaches the other program: a random
// 401 or 404 with a foreign body, or "socket hang up", in a test that passes
// alone. Binding the test server itself to 127.0.0.1 lets the kernel pick a
// port that is free there.
//
// supertest reads server.address() right after listen(0), so the bind must
// stay synchronous: listen(0, host) resolves the host first (async). This
// uses the same synchronous step Node's own listen() takes for a primary
// process (server._listen2 = setupListenHandle). Only listen(0[, callback])
// changes; an explicit port or host goes through untouched, and without
// _listen2 everything falls back to the plain listen.
const http = require('http');

const FLAG = Symbol.for('schoolmule.loopbackListen');

if (!http.Server.prototype[FLAG]) {
  const listen = http.Server.prototype.listen;
  http.Server.prototype.listen = function loopbackListen(...args) {
    const plainZero = args[0] === 0 && (args.length === 1 || (args.length === 2 && typeof args[1] === 'function'));
    if (!plainZero || typeof this._listen2 !== 'function' || this._handle) return listen.apply(this, args);
    if (typeof args[1] === 'function') this.once('listening', args[1]);
    this._listen2('127.0.0.1', 0, 4, 511);
    return this;
  };
  http.Server.prototype[FLAG] = true;
}

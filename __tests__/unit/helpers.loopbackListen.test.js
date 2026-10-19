// The test helper that keeps supertest's servers on 127.0.0.1 (M8).
const http = require('http');
const express = require('express');
const request = require('supertest');

describe('loopbackListen (unit setup)', () => {
  it('a test server started with listen(0) is bound to 127.0.0.1 only', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      expect(server.address().address).toBe('127.0.0.1');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('an explicit host is left alone, and supertest still reaches the app', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
    try {
      expect(server.address().address).toBe('0.0.0.0');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    const app = express();
    app.get('/ping', (_req, res) => res.json({ ok: true }));
    expect((await request(app).get('/ping')).body).toEqual({ ok: true });
  });
});

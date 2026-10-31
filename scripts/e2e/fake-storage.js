#!/usr/bin/env node
/**
 * A stand-in for the Supabase Storage REST API, for local end-to-end runs.
 * Stores objects under ROOT/<bucket>/<path>. Handles what supabase-js uses:
 *   POST|PUT /storage/v1/object/<bucket>/<path>        upload (upsert)
 *   POST     /storage/v1/object/sign/<bucket>/<path>   signed URL
 *   GET      /storage/v1/object/sign/<bucket>/<path>   fetch via signed URL
 *   GET      /storage/v1/object/(authenticated|public)/<bucket>/<path>, and /<bucket>/<path>
 *   DELETE   /storage/v1/object/<bucket>                remove { prefixes }
 * Usage: node fake-storage.js <port> <root>
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.argv[2] || 54329);
const root = process.argv[3] || path.join(require('os').tmpdir(), 'schoolmule-e2e-storage');
fs.mkdirSync(root, { recursive: true });

const safe = (p) => path.join(root, path.normalize(decodeURIComponent(p)).replace(/^(\.\.[/\\])+/, ''));
const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
};
const read = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
const mime = (f) => ({ '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' })[path.extname(f).toLowerCase()] || 'application/octet-stream';

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/^\/storage\/v1\/object\//, '');
    if (req.method === 'OPTIONS') return json(res, 200, {});
    try {
      if (p.startsWith('sign/') && req.method === 'POST') {
        const key = p.slice(5);
        const body = JSON.parse((await read(req)).toString() || '{}');
        if (Array.isArray(body.paths)) {
          return json(res, 200, body.paths.map((k) => ({ path: k, signedURL: `/object/sign/${url.pathname.split('/sign/')[1].split('/')[0]}/${k}?token=fake`, error: null })));
        }
        return json(res, 200, { signedURL: `/object/sign/${key}?token=fake` });
      }
      if (req.method === 'GET') {
        const key = p.replace(/^(sign|authenticated|public)\//, '');
        const file = safe(key);
        if (!fs.existsSync(file)) return json(res, 404, { statusCode: '404', error: 'not_found', message: 'Object not found' });
        res.writeHead(200, { 'Content-Type': mime(file), 'Access-Control-Allow-Origin': '*' });
        return fs.createReadStream(file).pipe(res);
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        const file = safe(p);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, await read(req));
        console.log(`stored ${p}`);
        return json(res, 200, { Id: p, Key: p });
      }
      if (req.method === 'DELETE') {
        const bucket = p.split('/')[0];
        const body = JSON.parse((await read(req)).toString() || '{}');
        for (const k of body.prefixes || []) fs.rmSync(safe(`${bucket}/${k}`), { force: true });
        return json(res, 200, (body.prefixes || []).map((k) => ({ name: k })));
      }
      json(res, 404, { message: 'unsupported' });
    } catch (e) {
      json(res, 500, { message: e.message });
    }
  })
  .listen(port, () => console.log(`fake storage on ${port} → ${root}`));

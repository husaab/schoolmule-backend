# vendor/reportkit — generated, do not edit

The report engine that prints every report card and progress report
(services/reportEngine/render.js). It is the same code the web designer runs,
so a PDF lays out exactly like the admin's preview.

- Source: schoolmule/src/reportkit (TypeScript, web repo).
- Rebuild with `npm run sync:reportkit` in the web repo (from a worktree:
  `REPORTKIT_BACKEND_DIR=<this repo> npm run sync:reportkit`), then commit BOTH repos.
- `npm run check:reportkit` (web) and __tests__/unit/services/reportEngine/vendorBundle.test.js
  (here) fail when this copy is stale or hand-edited.
- manifest.json: engineVersion (stamped on generated reports), sourceHash, bundleSha256.

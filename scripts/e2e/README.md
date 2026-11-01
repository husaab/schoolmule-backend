# End-to-end test stack

Runs the web app and API against an **isolated** database so browser tests
can create, publish and generate freely. Nothing here reads `.env`'s database
or storage (the local `.env` points at production).

| Piece | Where |
|---|---|
| Database | `schoolmule_e2e` on the docker test Postgres (`npm run docker:test:up`, host port 5433) with the synthetic PLAYGROUND school |
| Storage | `fake-storage.js` — a tiny stand-in for the Supabase Storage API, files under `$TMPDIR/schoolmule-e2e-storage` |
| API | `start-backend.sh` → http://localhost:4310 (`REPORT_ENGINE=new`) |
| Web | `npx next dev -p 3310` in the web repo with `NEXT_PUBLIC_BASE_URL="http://localhost:4310/api"` in `.env.local` |
| Tests | `npm run test:e2e` in the web repo (Playwright, `e2e/`) |

```bash
bash scripts/e2e/setup-db.sh                 # once (re-run to rebuild)
node scripts/e2e/fake-storage.js 54329 &     # storage
bash scripts/e2e/start-backend.sh &          # API
# web repo: npx next dev -p 3310, then npm run test:e2e
bash scripts/e2e/reset-db.sh                 # between full runs (stop the API first)
```

Sign-ins: `admin@playground.test` / `teacher@playground.test`, password `Playground2026!`.

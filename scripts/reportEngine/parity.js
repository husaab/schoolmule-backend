#!/usr/bin/env node
/**
 * Legacy ↔ engine parity check for the built-in report templates.
 *
 *   node scripts/reportEngine/parity.js [outDir] [--only <key>[,<key>]] [--case <id>]
 *
 * For every case: synthetic ReportData from reportKit().sampleReportData(),
 * adapted into the legacy template's input (the shapes the controllers pass),
 * printed the way production prints it (utils/pdfGenerator.createPDFBuffer:
 * A4, 40px margins) and rasterised with poppler's pdftoppm; the engine
 * version is rendered with renderReportPngs / renderReportText. Writes
 * <outDir>/index.html (legacy | engine, page by page) and prints a text
 * report: every non-empty legacy text line (normalised) must appear in the
 * engine output at least as often, except for strings a default fixes on
 * purpose (KNOWN_FIXES). Exit code 1 when a parity target has misses.
 *
 * Needs `pdftoppm` (brew install poppler) for the legacy page images; without
 * it the page count still comes from the PDF and only images are skipped.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PDFDocument } = require('pdf-lib');
const { reportKit, renderReportPngs, renderReportText, launchReportBrowser } = require('../../services/reportEngine/render');
const { createPDFBuffer } = require('../../utils/pdfGenerator');
const { LEARNING_SKILL_DESCRIPTORS } = require('../../services/reportEngine/data/learningSkills');
const { getProgressReportHTML } = require('../../templates/progressReportTemplate');
const { getReportCardHTML } = require('../../templates/reportCardTemplate');
const { getAlHaadiT2ReportCardHTML } = require('../../templates/alHaadiT2ReportCardTemplate');
const { getAlHaadiReportCardJKHTML } = require('../../templates/alHaadiReportCardJKTemplate');
const { getAlHaadiReportCardSKHTML } = require('../../templates/alHaadiReportCardSKTemplate');
const { getAlHaadiProgressReportJKHTML } = require('../../templates/alHaadiProgressReportJKTemplate');
const { getAlHaadiProgressReportSKHTML } = require('../../templates/alHaadiProgressReportSKTemplate');

const SCALE = 1.5; // engine PNGs; legacy is rasterised at 96 * SCALE dpi to match

// ─────────────────────────────────────────────── synthetic images ──

const svg = (w, h, body) =>
  `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`).toString('base64')}`;

const ASSETS = {
  // Portrait, like real school crests (e.g. 155 × 190).
  logo: svg(
    155,
    190,
    '<path d="M8 8 H147 V110 C147 150 110 175 77.5 184 C45 175 8 150 8 110 Z" fill="#eef3fb" stroke="#2c5aa0" stroke-width="6"/><circle cx="77.5" cy="70" r="34" fill="#2c5aa0"/><text x="77.5" y="80" font-family="Arial" font-size="26" font-weight="700" fill="#fff" text-anchor="middle">PA</text><text x="77.5" y="138" font-family="Arial" font-size="20" font-weight="700" fill="#2c5aa0" text-anchor="middle">LOGO</text>',
  ),
  principalSignature: svg(
    240,
    80,
    '<path d="M10 60 C 40 5, 60 75, 90 35 S 140 10, 150 50 S 200 70, 230 20" fill="none" stroke="#1d3a8a" stroke-width="4" stroke-linecap="round"/><text x="120" y="76" font-family="Arial" font-size="12" fill="#1d3a8a" text-anchor="middle">principal (synthetic)</text>',
  ),
  teacherSignature: svg(
    240,
    80,
    '<path d="M10 50 C 30 10, 50 70, 80 30 S 120 70, 150 30 S 200 10, 230 55" fill="none" stroke="#7a1d1d" stroke-width="4" stroke-linecap="round"/><text x="120" y="76" font-family="Arial" font-size="12" fill="#7a1d1d" text-anchor="middle">teacher (synthetic)</text>',
  ),
  stamp: svg(
    120,
    120,
    '<circle cx="60" cy="60" r="54" fill="none" stroke="#a11" stroke-width="5"/><circle cx="60" cy="60" r="40" fill="none" stroke="#a11" stroke-width="2"/><text x="60" y="66" font-family="Arial" font-size="18" font-weight="700" fill="#a11" text-anchor="middle">STAMP</text>',
  ),
};

// ───────────────────────────────────────────── sample variants ──

const LONG = (first) =>
  `${first} has grown in confidence this term, contributes ideas to group discussions and helps classmates when they need support. To continue improving, ${first} is encouraged to read every evening, review new vocabulary, and share what was learned with family members. **Next step:** practise explaining thinking out loud, step by step, to build fluency and independence. We are proud of the effort shown and look forward to even more growth next term.`;

/** Grades 1-8 worst case: the longest name, long comments, every subject. */
function worstGrades(kit, docType) {
  const d = kit.sampleReportData('8', docType);
  d.student = { ...d.student, name: 'Muhammad-Abdulrahman Al-Khatib Abou-Haidar', firstName: 'Muhammad-Abdulrahman', lastName: 'Al-Khatib Abou-Haidar', daysAbsent: 27 };
  d.subjects = d.subjects.map((s, i) => {
    const comment = `${s.comment} ${LONG('Muhammad-Abdulrahman')}`;
    return {
      ...s,
      name: i === 0 ? 'English — Reading, Writing, Oral Communication and Media Literacy' : s.name,
      comment,
      coreStandards: `${s.coreStandards}; working towards the grade-level standard in every strand`,
      terms: { ...s.terms, t2: { ...s.terms.t2, comment } },
    };
  });
  return d;
}

/** Blanks: no ratings, no comments, no core standards on some subjects. */
function sparse(kit, key, docType) {
  const d = kit.sampleReportData(key, docType);
  d.student = { ...d.student, oen: '' };
  d.subjects = d.subjects.map((s, i) => {
    if (i % 3 !== 1) return s;
    const empty = { mark: s.mark, workHabits: '', behaviour: '', comment: '' };
    return { ...s, workHabits: '', behaviour: '', comment: '', coreStandards: '', terms: { t1: { ...empty, mark: null }, t2: empty, final: { ...s.terms.final, mark: null } } };
  });
  return d;
}

// ─────────────────────────────────────── ReportData → legacy input ──

const school = (d) => ({ name: d.school.name, address: d.school.address, phone: d.school.phone, email: d.school.email });
const assets = (d) => ({ logoUrl: d.assets.logo, principalSignatureUrl: d.assets.principalSignature, schoolStampUrl: d.assets.stamp });
// progressReports.controller.js passes new Date().toLocaleDateString() (server locale, en-US here).
const usDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US');
const ratingMap = (d, key) => Object.fromEntries(d.skills.flatMap((g) => g.items.map((i) => [i.id, i[key]])));
const commentMap = (d) => Object.fromEntries(d.skills.map((g) => [g.id, g.comment]));
const kinderStudent = (d) => ({
  name: d.student.name,
  grade: d.student.grade,
  oen: d.student.oen,
  homeroomTeacher: d.student.homeroomTeacher,
  teacherAssistant: d.student.teacherAssistant || null,
  daysOfAbsence: d.student.daysAbsent,
});
const cardStudent = (d) => ({
  name: d.student.name,
  grade: d.student.grade,
  oen: d.student.oen,
  homeroomTeacher: d.student.homeroomTeacher,
  daysOfAbsence: d.student.daysAbsent,
  school: d.school.code,
});

const LEGACY = {
  'progress-standard': (d) =>
    getProgressReportHTML({
      schoolInfo: school(d),
      student: { name: d.student.name, grade: d.student.grade, oen: d.student.oen, homeroomTeacher: d.student.homeroomTeacher },
      term: d.meta.term,
      progressData: d.subjects.map((s) => ({
        subject: s.name,
        teacherName: s.teacher,
        coreStandards: s.coreStandards || null,
        workHabit: s.workHabits || null,
        behavior: s.behaviour || null,
        comment: s.comment || null,
      })),
      generatedDate: usDate(d.meta.generatedDate),
      schoolAssets: assets(d),
    }),
  'report-card-standard': (d) =>
    getReportCardHTML({
      schoolInfo: school(d),
      schoolAssets: assets(d),
      student: cardStudent(d),
      term: d.meta.term,
      subjects: d.subjects.map((s) => ({ subject: s.name, grade: s.mark === 'I' ? null : s.mark })),
      feedbacks: d.subjects.map((s) => ({ subject: s.name, work_habits: s.workHabits || null, behavior: s.behaviour || null, comment: s.comment || null })),
      generatedDate: d.meta.generatedDate,
    }),
  'report-card-t1t2final': (d) => {
    const fb = (t) => d.subjects.map((s) => ({ subject: s.name, work_habits: s.terms[t]?.workHabits || null, behavior: s.terms[t]?.behaviour || null, comment: s.terms[t]?.comment || null }));
    return getAlHaadiT2ReportCardHTML({
      schoolInfo: school(d),
      schoolAssets: assets(d),
      student: cardStudent(d),
      term: 'Term 2',
      subjects: d.subjects.map((s) => ({ subject: s.name, t1: s.terms.t1?.mark ?? null, t2: s.terms.t2?.mark ?? null, final: s.terms.final?.mark ?? null })),
      feedbacksT1: fb('t1'),
      feedbacksT2: fb('t2'),
      generatedDate: d.meta.generatedDate,
    });
  },
  'report-card-jk': (d) =>
    getAlHaadiReportCardJKHTML({
      schoolInfo: school(d),
      schoolAssets: assets(d),
      student: kinderStudent(d),
      term: d.meta.term,
      domains: d.skills.map((g) => ({ domainId: g.id, name: g.name, skills: g.items.map((i) => ({ skillId: i.id, name: i.name, description: i.description })) })),
      ratingMapTerm1: ratingMap(d, 't1'),
      ratingMapTerm2: ratingMap(d, 't2'),
      commentMap: commentMap(d),
      learningSkills: Object.fromEntries(d.learningSkills.map((s) => [s.name, s.rating])),
      generatedDate: d.meta.generatedDate,
    }),
  'report-card-sk': (d) =>
    getAlHaadiReportCardSKHTML({
      schoolInfo: school(d),
      schoolAssets: assets(d),
      student: kinderStudent(d),
      term: d.meta.term,
      subjects: d.skills.map((g) => ({ subjectId: g.id, name: g.name, standards: g.items.map((i) => ({ standardId: i.id, name: i.name })) })),
      ratingMapTerm1: ratingMap(d, 't1'),
      ratingMapTerm2: ratingMap(d, 't2'),
      commentMap: commentMap(d),
      generatedDate: d.meta.generatedDate,
    }),
  'progress-jk': (d) =>
    getAlHaadiProgressReportJKHTML({
      schoolInfo: school(d),
      schoolAssets: assets(d),
      student: kinderStudent(d),
      domains: d.skills.map((g) => ({ domainId: g.id, name: g.name, skills: g.items.map((i) => ({ skillId: i.id, name: i.name })) })),
      ratingMap: ratingMap(d, 'rating'),
      generatedDate: d.meta.generatedDate,
    }),
  'progress-sk': (d) =>
    getAlHaadiProgressReportSKHTML({
      schoolInfo: school(d),
      schoolAssets: assets(d),
      student: kinderStudent(d),
      subjects: d.skills.map((g) => ({ subjectId: g.id, name: g.name, standards: g.items.map((i) => ({ standardId: i.id, name: i.name })) })),
      ratingMap: ratingMap(d, 'rating'),
      commentMap: commentMap(d),
      generatedDate: d.meta.generatedDate,
    }),
};

// ──────────────────────────────────────────────────────── cases ──

/**
 * Strings the engine defaults print differently ON PURPOSE (legacy bugs), per
 * design. A legacy line matching one is reported as "fixed", not "missing".
 */
const KNOWN_FIXES = {
  'progress-standard': [
    [/^created on \d+\/\d+\/\d{4}$/, 'date printed in the server locale (M/D/YYYY) → long date'],
  ],
  'report-card-jk': [
    [/^principal: sr\. majida/, 'hard-coded principal → {{school.principal}}'],
    [/^website: www\.alhaadiacademy\.ca$/, 'hard-coded website → {{school.website}}'],
    [/^board: private$/, 'hard-coded board → {{school.board}}'],
    [/^\d+ \| page$/, 'fake "N | Page" counter → real "Page X of Y" footer'],
  ],
  'report-card-sk': [
    [/^principal: sr\. majida/, 'hard-coded principal → {{school.principal}}'],
    [/^website: www\.alhaadiacademy\.ca$/, 'hard-coded website → {{school.website}}'],
    [/^board: private$/, 'hard-coded board → {{school.board}}'],
    [/^\d+ \| page$/, 'fake "N | Page" counter → real "Page X of Y" footer'],
  ],
};

const CASES = [
  ...['1', '4', '8'].map((s) => ({ key: 'progress-standard', sample: s, docType: 'progress_report', assets: s !== '8' })),
  { key: 'progress-standard', sample: 'worst-8', docType: 'progress_report', assets: true },
  { key: 'progress-standard', sample: 'sparse-4', docType: 'progress_report', assets: false },
  ...['1', '4', '8'].map((s) => ({ key: 'report-card-standard', sample: s, docType: 'report_card', assets: s !== '8' })),
  { key: 'report-card-standard', sample: 'worst-8', docType: 'report_card', assets: true },
  { key: 'report-card-standard', sample: 'sparse-4', docType: 'report_card', assets: false },
  ...['1', '4', '8'].map((s) => ({ key: 'report-card-t1t2final', sample: s, docType: 'report_card', assets: s !== '8' })),
  { key: 'report-card-t1t2final', sample: 'worst-8', docType: 'report_card', assets: true },
  { key: 'report-card-t1t2final', sample: 'sparse-4', docType: 'report_card', assets: false },
  { key: 'report-card-jk', sample: 'JK', docType: 'report_card', assets: true },
  { key: 'report-card-jk', sample: 'JK', docType: 'report_card', assets: false, id: 'report-card-jk/JK-noassets' },
  { key: 'report-card-sk', sample: 'SK', docType: 'report_card', assets: true },
  { key: 'report-card-sk', sample: 'worst', docType: 'report_card', assets: true },
  { key: 'progress-jk', sample: 'JK', docType: 'progress_report', assets: true, notTarget: true },
  { key: 'progress-sk', sample: 'SK', docType: 'progress_report', assets: true, notTarget: true },
  { key: 'progress-sk', sample: 'worst', docType: 'progress_report', assets: true, notTarget: true },
].map((c) => ({ id: `${c.key}/${c.sample}${c.assets ? '' : '-noassets'}`, ...c }));

function caseData(kit, c) {
  let d;
  if (c.sample === 'worst-8') d = worstGrades(kit, c.docType);
  else if (c.sample.startsWith('sparse-')) d = sparse(kit, c.sample.slice(7), c.docType);
  else d = kit.sampleReportData(c.sample, c.docType);
  d.assets = c.assets ? { ...ASSETS } : { logo: null, principalSignature: null, stamp: null, teacherSignature: null };
  // The backend fills the JK card's learning skills with the legacy descriptors.
  if (d.student.grade === 'JK' && c.docType === 'report_card') {
    d.learningSkills = d.learningSkills.map((s) => ({ ...s, descriptors: [...(LEARNING_SKILL_DESCRIPTORS[s.name] || s.descriptors)] }));
  }
  return d;
}

// ───────────────────────────────────────────────────── text check ──

/** Lower-case, one space, one kind of dash, no markdown/nbsp, "a - b" → "a-b". */
function norm(s) {
  return String(s)
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*/g, '-')
    .trim()
    .toLowerCase();
}

/** Legacy text → normalised fragments (one per line / table cell). */
function fragments(text) {
  return String(text)
    .split(/[\n\t]+/)
    .map(norm)
    .filter((s) => s && !/^[|]$/.test(s));
}

function countIn(hay, needle) {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

function textParity(key, legacyText, enginePages) {
  const engine = norm(enginePages.join(' \n '));
  const want = new Map();
  for (const f of fragments(legacyText)) want.set(f, (want.get(f) || 0) + 1);
  const missing = [];
  const fixed = [];
  for (const [f, n] of want) {
    const fix = (KNOWN_FIXES[key] || []).find(([re]) => re.test(f));
    if (fix) {
      fixed.push({ text: f, why: fix[1] });
      continue;
    }
    const have = countIn(engine, f);
    if (have < n) missing.push({ text: f, legacy: n, engine: have });
  }
  return { missing, fixed };
}

// ───────────────────────────────────────────────────────── render ──

async function legacyRender(browser, html, outDir, stem) {
  const pdf = await createPDFBuffer(html, { browser });
  const pdfPath = path.join(outDir, `${stem}-legacy.pdf`);
  fs.writeFileSync(pdfPath, pdf);
  const pageCount = (await PDFDocument.load(pdf)).getPageCount();
  let images = [];
  try {
    execFileSync('pdftoppm', ['-r', String(96 * SCALE), '-png', pdfPath, path.join(outDir, `${stem}-legacy`)]);
    images = fs
      .readdirSync(outDir)
      .filter((f) => f.startsWith(`${stem}-legacy-`) && f.endsWith('.png'))
      .sort((a, b) => parseInt(a.match(/-(\d+)\.png$/)[1], 10) - parseInt(b.match(/-(\d+)\.png$/)[1], 10));
  } catch (err) {
    console.warn(`pdftoppm unavailable (${err.message}); legacy images skipped`);
  }
  // Text as laid out for print at the PDF's content width.
  const page = await browser.newPage();
  try {
    await page.emulateMediaType('print');
    await page.setViewport({ width: 714, height: 1043 });
    await page.setContent(html, { waitUntil: 'load' });
    const text = await page.evaluate(() => document.body.innerText);
    return { pageCount, images, text };
  } finally {
    await page.close();
  }
}

async function engineRender(browser, template, data, outDir, stem) {
  const { pngs, pageCount, warnings } = await renderReportPngs({ template, data, browser, scale: SCALE });
  const images = pngs.map((png, i) => {
    const f = `${stem}-engine-${i + 1}.png`;
    fs.writeFileSync(path.join(outDir, f), png);
    return f;
  });
  const { pages } = await renderReportText({ template, data, browser });
  return { pageCount, images, pages, warnings };
}

// ─────────────────────────────────────────────────────── report ──

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function reviewHtml(results) {
  const rows = results
    .map((r) => {
      const n = Math.max(r.legacy.images.length, r.engine.images.length);
      const pages = Array.from({ length: n }, (_, i) => {
        const l = r.legacy.images[i];
        const e = r.engine.images[i];
        return `<div class="pair"><figure>${l ? `<img loading="lazy" src="${esc(l)}">` : '<div class="none">no page</div>'}<figcaption>legacy p${i + 1}</figcaption></figure><figure>${
          e ? `<img loading="lazy" src="${esc(e)}">` : '<div class="none">no page</div>'
        }<figcaption>engine p${i + 1}</figcaption></figure></div>`;
      }).join('');
      const miss = r.parity.missing.length
        ? `<details open><summary>${r.parity.missing.length} legacy string(s) missing from the engine</summary><ul>${r.parity.missing
            .map((m) => `<li><code>${esc(m.text)}</code> legacy ×${m.legacy}, engine ×${m.engine}</li>`)
            .join('')}</ul></details>`
        : '<p class="ok">Text parity clean.</p>';
      const fixed = r.parity.fixed.length
        ? `<details><summary>${r.parity.fixed.length} intentional fix(es)</summary><ul>${r.parity.fixed.map((m) => `<li><code>${esc(m.text)}</code> — ${esc(m.why)}</li>`).join('')}</ul></details>`
        : '';
      const warn = r.engine.warnings.length ? `<details><summary>${r.engine.warnings.length} engine warning(s)</summary><ul>${r.engine.warnings.map((w) => `<li>${esc(w.code)}: ${esc(w.message)}</li>`).join('')}</ul></details>` : '';
      return `<section id="${esc(r.id)}"><h2>${esc(r.id)}${r.notTarget ? ' <span class="nt">not a parity target</span>' : ''}</h2>
<p>Pages: legacy <b>${r.legacy.pageCount}</b> · engine <b>${r.engine.pageCount}</b>${r.assets ? ' · with synthetic logo/signature/stamp' : ' · no images'}</p>${miss}${fixed}${warn}${pages}</section>`;
    })
    .join('');
  const toc = results
    .map((r) => `<li><a href="#${esc(r.id)}">${esc(r.id)}</a> — ${r.legacy.pageCount}/${r.engine.pageCount} pages, ${r.notTarget ? 'not a target' : `${r.parity.missing.length} missing`}</li>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Report parity</title><style>
body{font:14px/1.45 -apple-system,system-ui,sans-serif;margin:0;padding:24px;background:#f1f5f9;color:#0f172a}
h1{margin:0 0 8px}section{background:#fff;border-radius:10px;padding:16px 20px;margin:20px 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:14px 0}figure{margin:0}figure img{width:100%;border:1px solid #cbd5e1;background:#fff}
figcaption{font-size:12px;color:#64748b;text-align:center}.none{aspect-ratio:794/1123;border:1px dashed #94a3b8;display:flex;align-items:center;justify-content:center;color:#94a3b8}
.ok{color:#15803d}.nt{font-size:12px;background:#fde68a;border-radius:4px;padding:2px 6px;vertical-align:middle}code{background:#f1f5f9;padding:1px 4px;border-radius:3px}
</style></head><body><h1>Legacy vs engine</h1><p>Left: the legacy template printed by createPDFBuffer (A4, 40px margins). Right: the engine default. Synthetic data only.</p><ul>${toc}</ul>${rows}</body></html>`;
}

// ─────────────────────────────────────────────────────────── main ──

(async () => {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args.splice(i, 2)[1] : null;
  };
  const only = (flag('--only') || '').split(',').filter(Boolean);
  const onlyCase = flag('--case');
  const outDir = path.resolve(args[0] || './tmp-parity');
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) if (/\.(png|pdf)$/.test(f)) fs.unlinkSync(path.join(outDir, f));

  const kit = reportKit();
  const cases = CASES.filter((c) => (only.length === 0 || only.includes(c.key)) && (!onlyCase || c.id === onlyCase));
  const browser = await launchReportBrowser();
  const results = [];
  try {
    for (const c of cases) {
      const def = kit.DEFAULT_TEMPLATES.find((d) => d.key === c.key);
      const data = caseData(kit, c);
      const stem = c.id.replace(/[^a-z0-9]+/gi, '_');
      const legacy = await legacyRender(browser, LEGACY[c.key](data), outDir, stem);
      if (!def) console.warn(`${c.id}: no default "${c.key}" yet — legacy only`);
      const engine = def ? await engineRender(browser, def.build(), data, outDir, stem) : { pageCount: 0, images: [], pages: [], warnings: [] };
      const parity = textParity(c.key, legacy.text, engine.pages);
      results.push({ ...c, legacy, engine, parity });
      const tag = c.notTarget ? ' (not a parity target)' : '';
      console.log(`\n${c.id}${tag}: pages legacy ${legacy.pageCount} / engine ${engine.pageCount}; missing ${parity.missing.length}; fixed ${parity.fixed.length}; warnings ${engine.warnings.length}`);
      if (!c.notTarget) for (const m of parity.missing) console.log(`  missing: "${m.text}" (legacy ×${m.legacy}, engine ×${m.engine})`);
      for (const w of engine.warnings) console.log(`  warning: ${w.code} ${w.message}`);
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(outDir, 'index.html'), reviewHtml(results));
  console.log(`\nReview page: ${path.join(outDir, 'index.html')}`);
  const bad = results.filter((r) => !r.notTarget && r.parity.missing.length > 0);
  process.exit(bad.length > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

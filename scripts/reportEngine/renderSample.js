#!/usr/bin/env node
/**
 * Render a built-in template with synthetic data to PNG pages + a PDF, for
 * eyeballing the engine without a database.
 *   node scripts/reportEngine/renderSample.js <defaultKey> <sampleKey> <outDir> [docType]
 * e.g. node scripts/reportEngine/renderSample.js progress-sk SK /tmp/rk
 */
const fs = require('fs');
const path = require('path');
const { reportKit, renderReportPngs, renderReportPdf, launchReportBrowser } = require('../../services/reportEngine/render');

(async () => {
  const [key = 'progress-sk', sample = 'SK', outDir = './tmp-report', docType] = process.argv.slice(2);
  const kit = reportKit();
  const def = kit.DEFAULT_TEMPLATES.find((d) => d.key === key);
  if (!def) throw new Error(`No default "${key}". Have: ${kit.DEFAULT_TEMPLATES.map((d) => d.key).join(', ')}`);
  const template = def.build();
  const data = kit.sampleReportData(sample, docType || def.docType);
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launchReportBrowser();
  try {
    const t0 = Date.now();
    const { pngs, pageCount, warnings } = await renderReportPngs({ template, data, browser, scale: 1.5 });
    pngs.forEach((png, i) => fs.writeFileSync(path.join(outDir, `${key}-${sample}-p${i + 1}.png`), png));
    const { pdf } = await renderReportPdf({ template, data, browser });
    fs.writeFileSync(path.join(outDir, `${key}-${sample}.pdf`), pdf);
    console.log(JSON.stringify({ key, sample, pageCount, ms: Date.now() - t0, warnings }, null, 2));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

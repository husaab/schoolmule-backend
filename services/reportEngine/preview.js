// services/reportEngine/preview.js
//
// ReportData for the designer's previews: a real student's report (with the
// extra field values filled in so far), or one of the engine's sample
// students shown under the caller's own school name, address and images.

const db = require('../../config/database');
const { assembleReportData } = require('./data');
const { ReportSkip } = require('./data/errors');
const { loadSchool, loadAssets } = require('./data/common');
const { reportKit } = require('./render');
const { loadFieldValues, mergeExtras } = require('./fields');

/** The sample keys this engine bundle offers (SAMPLE_OPTIONS). */
function sampleKeys() {
  return (reportKit().SAMPLE_OPTIONS || []).map((o) => o.key);
}

/**
 * A sample student's ReportData with the school block and images replaced by
 * the caller's school's (the same loaders assembleReportData uses). Images
 * stay signed URLs; inline them before printing.
 * @throws {ReportSkip} 400 for an unknown sample key
 */
async function sampleWithSchool({ sampleKey, docType, school, client = db }) {
  if (!sampleKeys().includes(sampleKey)) throw new ReportSkip(`Unknown sample "${sampleKey}"`, 400);
  const data = reportKit().sampleReportData(sampleKey, docType);
  const s = await loadSchool(client, school);
  const assets = await loadAssets(client, s);
  return { ...data, school: s.info, assets };
}

/**
 * A real student's ReportData with their stored extra field values in
 * `extra` (over the `fields`' defaults, when a template is given).
 * @throws {ReportSkip} from the assembler
 */
async function studentPreviewData({ studentId, docType, term, fields = [], client = db }) {
  const data = await assembleReportData({ studentId, docType, term, client });
  const stored = await loadFieldValues({ studentId, docType, term, client });
  data.extra = { ...(data.extra || {}), ...mergeExtras(fields, stored) };
  return data;
}

module.exports = { sampleKeys, sampleWithSchool, studentPreviewData };

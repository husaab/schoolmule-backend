// utils/defaultTerm.js
//
// The term a page should open on when the user hasn't picked one: the active
// term, else the term containing today, else the most recently ended, else
// the first. Same order the parent portal's resolveTerm uses. `terms` must be
// sorted by start date; dates may be Date objects or 'YYYY-MM-DD' strings.

const dayOf = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

function pickDefaultTerm(terms, today = new Date().toISOString().slice(0, 10)) {
  if (!terms || terms.length === 0) return null;
  return (
    terms.find((t) => t.is_active) ||
    terms.find((t) => dayOf(t.start_date) <= today && today <= dayOf(t.end_date)) ||
    terms.filter((t) => dayOf(t.end_date) < today).pop() ||
    terms[0]
  );
}

module.exports = { pickDefaultTerm };

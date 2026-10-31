// services/reportEngine/data/errors.js
//
// A report that can't be made from the data as it stands (no such student,
// no such term, no classes in the term). Same name, message and status as
// the legacy ReportSkip in controllers/progressReports.controller.js:317,
// which isn't exported; when the controllers move onto this assembler they
// should import this one instead of declaring their own.

class ReportSkip extends Error {
  constructor(message, status = 422) {
    super(message);
    this.name = 'ReportSkip';
    this.status = status;
  }
}

module.exports = { ReportSkip };

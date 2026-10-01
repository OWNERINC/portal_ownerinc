class AcademyError extends Error {
  constructor(status, reason) {
    super(reason);
    this.name = 'AcademyError';
    this.status = status;
    this.reason = reason;
  }
}

module.exports = { AcademyError };

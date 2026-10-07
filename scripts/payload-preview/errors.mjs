export class PreviewPreparationError extends Error {
  constructor(code) {
    super(code)
    this.name = 'PreviewPreparationError'
    this.code = code
  }
}

export function fail(code) {
  throw new PreviewPreparationError(code)
}

export function errorCode(error) {
  return error instanceof PreviewPreparationError ? error.code : 'prepare_failed'
}

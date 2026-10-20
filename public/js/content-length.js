export function parseContentLength(value, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('O limite de bytes precisa ser um inteiro seguro não negativo.');
  }
  if (value === null || value === undefined) return { kind: 'absent' };
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return { kind: 'invalid' };
  const length = Number(value);
  if (!Number.isSafeInteger(length)) return { kind: 'invalid' };
  if (length > maxBytes) return { kind: 'too-large', length };
  return { kind: 'valid', length };
}

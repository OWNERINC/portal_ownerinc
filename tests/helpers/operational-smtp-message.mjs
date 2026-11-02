const invalid = () => { throw new Error('invalid_operational_message_id'); };

// Parse the SMTP DATA header block only. A body canary is never an identifier.
export function readOperationalMessageId(message) {
  if (typeof message !== 'string') invalid();
  const boundary = message.indexOf('\r\n\r\n');
  if (boundary < 0) invalid();
  const headers = message.slice(0, boundary);
  if (/[\r\n]/u.test(headers.replace(/\r\n/gu, ''))) invalid();
  // RFC folding removes CRLF only when followed by SP/HTAB; retain that WSP.
  const lines = headers.replace(/\r\n(?=[ \t])/gu, '').split('\r\n');
  const values = [];
  for (const line of lines) {
    const field = /^([\x21-\x39\x3b-\x7e]+):(.*)$/u.exec(line);
    if (!field) invalid();
    if (field[1].toLowerCase() === 'message-id') values.push(field[2].replace(/^[ \t]+|[ \t]+$/gu, ''));
  }
  if (values.length !== 1 || !/^<own34-[a-f0-9]{32}@monitor\.ownerinc\.invalid>$/u.test(values[0])) invalid();
  return values[0];
}

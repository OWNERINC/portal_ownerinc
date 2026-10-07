export function task9ProxyHeaders(incomingHeaders, externalOrigin) {
  const headers = { ...incomingHeaders }
  const externalAuthority = new URL(externalOrigin).host

  headers.host = externalAuthority
  headers['x-forwarded-host'] = externalAuthority
  delete headers['x-forwarded-port']
  delete headers.connection

  return headers
}

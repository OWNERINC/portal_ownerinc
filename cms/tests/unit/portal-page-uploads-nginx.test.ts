import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('private page chunk ingress is isolated from generic editorial proxying and bounded to chunks', async () => {
  const config = await readFile(new URL('../../../nginx/nginx.conf', import.meta.url), 'utf8')
  const route = 'location ^~ /editorial/api/portal-page-uploads/ {'
  const routeIndex = config.indexOf(route)
  const genericIndex = config.indexOf('location ^~ /editorial/ {')
  assert.ok(routeIndex >= 0 && routeIndex < genericIndex, 'upload prefix precedes generic editorial location')
  assert.equal(config.split(route).length - 1, 1, 'only the exact private ingress prefix is special-cased')
  const end = config.indexOf('\n    }', routeIndex)
  const block = config.slice(routeIndex, end)
  for (const invariant of [
    'if ($cross_site_request) { return 403; }',
    'client_max_body_size 6m;',
    'client_body_buffer_size 64k;',
    'proxy_request_buffering off;',
    'limit_req zone=editorial_uploads burst=2 nodelay;',
    'proxy_set_header X-Portal-Service-Key "";',
  ]) assert.ok(block.includes(invariant), invariant)
  assert.doesNotMatch(block, /501m|51m/u)

  const newsRoutes = config.slice(config.indexOf('location = /editorial/api/news-media {'), routeIndex)
  assert.match(newsRoutes, /client_max_body_size 51m;/u)
  assert.match(newsRoutes, /proxy_request_buffering off;/u)
  assert.doesNotMatch(newsRoutes, /portal-page-uploads/u)
})

test('the 8 MiB page-create JSON endpoint gets an isolated 9 MiB editorial ingress', async () => {
  const config = await readFile(new URL('../../../nginx/nginx.conf', import.meta.url), 'utf8')
  const declaration = 'location = /editorial/api/portal-page-editorial/save {'
  const saveIndex = config.indexOf(declaration)
  const uploadsIndex = config.indexOf('location ^~ /editorial/api/portal-page-uploads/ {')
  const genericIndex = config.indexOf('location ^~ /editorial/ {')
  assert.ok(saveIndex >= 0 && saveIndex < genericIndex, 'exact save route precedes the generic editorial proxy')
  assert.ok(saveIndex < uploadsIndex, 'the save exception is separate from upload ingress')
  assert.equal(config.split(declaration).length - 1, 1)
  const block = config.slice(saveIndex, config.indexOf('\n    }', saveIndex))
  for (const invariant of [
    'if ($cross_site_request) { return 403; }',
    'client_max_body_size 9m;',
    'client_body_buffer_size 64k;',
    'proxy_request_buffering off;',
    'limit_req zone=editorial burst=40 nodelay;',
    'proxy_pass $cms_upstream;',
    'proxy_set_header Host $http_host;',
    'proxy_set_header X-Real-IP $remote_addr;',
    'proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    'proxy_set_header X-Forwarded-Host $http_host;',
    'proxy_set_header X-Forwarded-Proto $forwarded_proto;',
    'proxy_set_header X-Forwarded-Port "";',
    'proxy_set_header X-Portal-Service-Key "";',
  ]) assert.ok(block.includes(invariant), invariant)

  const uploadBlock = config.slice(uploadsIndex, config.indexOf('\n    }', uploadsIndex))
  const genericBlock = config.slice(genericIndex, config.indexOf('\n    }', genericIndex))
  assert.match(uploadBlock, /client_max_body_size 6m;/u)
  assert.match(genericBlock, /client_max_body_size 6m;/u)
  assert.doesNotMatch(uploadBlock, /client_max_body_size 9m/u)
  assert.doesNotMatch(genericBlock, /client_max_body_size 9m/u)
})

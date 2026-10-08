import { createServer } from 'node:http';

const server = createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/editorial/ready') {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end('{"status":"ready"}');
});

server.listen(3100, '0.0.0.0');

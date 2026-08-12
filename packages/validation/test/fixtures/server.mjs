import { createServer } from 'node:http';

const port = Number(process.argv[2]);
const server = createServer((_request, response) => response.end('ok'));
server.listen(port, '127.0.0.1');
const close = () => server.close(() => process.exit(0));
process.once('SIGINT', close);
process.once('SIGTERM', close);

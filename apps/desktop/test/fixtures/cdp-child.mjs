import { app, BrowserWindow, WebContentsView } from 'electron';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

const directory = process.argv[2];
const statusPath = join(directory, 'status.json');
const commandPath = join(directory, 'command.json');
const responsePath = join(directory, 'response.json');
app.setPath('userData', directory);
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
app.commandLine.appendSwitch('remote-debugging-port', '0');
void app.whenReady().then(async () => {
  const upgradedSockets = new Set();
  const localServer = createServer((_request, response) => {
    const address = localServer.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server has no port.');
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><title>embedded</title><style>body { min-height: 900px }</style><input id="shared-input">
      <script>
        window.wsState = 'connecting';
        const socket = new WebSocket('ws://127.0.0.1:${address.port}/socket');
        socket.addEventListener('open', () => { window.wsState = 'open'; });
        socket.addEventListener('message', (event) => { window.wsState = event.data; });
        socket.addEventListener('error', () => { window.wsState = 'error'; });
      </script>`);
  });
  localServer.on('upgrade', (request, socket) => {
    if (request.url !== '/socket' || typeof request.headers['sec-websocket-key'] !== 'string') {
      socket.destroy();
      return;
    }
    upgradedSockets.add(socket);
    socket.on('close', () => upgradedSockets.delete(socket));
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const message = Buffer.from('connected');
    socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]));
  });
  await new Promise((resolveListen) => localServer.listen(0, '127.0.0.1', resolveListen));
  const address = localServer.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not start.');
  // Keep the native window alive and paintable like the real desktop app, but off-screen.
  const window = new BrowserWindow({
    show: false,
    x: -10_000,
    y: -10_000,
    width: 820,
    height: 640,
  });
  await window.loadURL('data:text/html,<title>Personal Agent Main</title><main>main</main>');
  const markerUrl = `http://127.0.0.1:${address.port}/first#embedded-${Date.now()}`;
  const view = new WebContentsView({
    webPreferences: {
      partition: `pa-cdp-smoke-${Date.now()}`,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  view.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    const localProtocol = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol);
    callback({
      cancel:
        !['about:', 'data:', 'blob:'].includes(url.protocol) &&
        !(localProtocol && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)),
    });
  });
  window.contentView.addChildView(view);
  // A background task stays paintable off-screen instead of using setVisible(false).
  view.setBounds({ x: 900, y: 0, width: 400, height: 300 });
  await view.webContents.loadURL(markerUrl);
  const isolatedMarkerUrl = `http://127.0.0.1:${address.port}/second#isolated-${Date.now()}`;
  const isolatedView = new WebContentsView({
    webPreferences: {
      partition: `pa-cdp-isolated-${Date.now()}`,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.contentView.addChildView(isolatedView);
  isolatedView.setBounds({ x: 400, y: 0, width: 400, height: 300 });
  await isolatedView.webContents.loadURL(isolatedMarkerUrl);
  window.showInactive();
  await writeFile(statusPath, JSON.stringify({ ready: true, markerUrl, isolatedMarkerUrl }));

  let lastId = 0;
  const timer = setInterval(async () => {
    try {
      const command = JSON.parse(await readFile(commandPath, 'utf8'));
      if (!command.id || command.id === lastId) return;
      lastId = command.id;
      if (command.action === 'user-input') {
        await view.webContents.executeJavaScript(
          "localStorage.setItem('partition-key', 'user-value'); document.querySelector('#shared-input').focus()",
        );
        view.webContents.focus();
        view.webContents.insertText('user-value');
        await writeFile(responsePath, JSON.stringify({ id: command.id, ok: true }));
      } else if (command.action === 'inspect') {
        const value = await view.webContents.executeJavaScript(
          "document.querySelector('#shared-input').value",
        );
        await writeFile(responsePath, JSON.stringify({ id: command.id, value }));
      } else if (command.action === 'resize') {
        view.setBounds(command.bounds);
        const viewport = await view.webContents.executeJavaScript(
          '({ width: window.innerWidth, height: window.innerHeight })',
        );
        await writeFile(
          responsePath,
          JSON.stringify({ id: command.id, bounds: view.getBounds(), viewport }),
        );
      } else if (command.action === 'screenshot') {
        try {
          const debug = view.webContents.debugger;
          const attachedHere = !debug.isAttached();
          if (attachedHere) debug.attach('1.3');
          const metrics = await debug.sendCommand('Page.getLayoutMetrics');
          const size = metrics.cssContentSize ?? metrics.contentSize;
          const image = await debug.sendCommand('Page.captureScreenshot', {
            format: 'png',
            fromSurface: true,
            captureBeyondViewport: true,
            clip: {
              x: 0,
              y: 0,
              width: Math.ceil(size.width),
              height: Math.ceil(size.height),
              scale: 1,
            },
          });
          if (attachedHere) debug.detach();
          await writeFile(command.path, Buffer.from(image.data, 'base64'));
          await writeFile(
            responsePath,
            JSON.stringify({ id: command.id, empty: image.data.length === 0 }),
          );
        } catch (error) {
          await writeFile(
            responsePath,
            JSON.stringify({
              id: command.id,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      } else if (command.action === 'exit') {
        await writeFile(responsePath, JSON.stringify({ id: command.id, ok: true }));
        clearInterval(timer);
        for (const socket of upgradedSockets) socket.destroy();
        localServer.close(() => setTimeout(() => app.quit(), 20));
      }
    } catch {
      // The command file is produced asynchronously by the parent test.
    }
  }, 25);
});

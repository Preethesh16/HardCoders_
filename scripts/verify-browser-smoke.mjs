import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const chrome = process.argv[2];
if (!chrome) throw new Error('usage: node scripts/verify-browser-smoke.mjs <chrome-binary>');

const origin = new URL(process.env.OPTIWORK_WEB_URL ?? 'http://127.0.0.1:3000');
const productOrigin = new URL(process.env.ANCHOR_PRODUCT_URL ?? 'http://127.0.0.1:4175');
const profile = await mkdtemp(join(tmpdir(), 'anchor-browser-smoke-'));
const processHandle = spawn(chrome, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-sync',
  '--metrics-recording-only',
  '--no-first-run',
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function debuggingPort() {
  const path = join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processHandle.exitCode !== null) throw new Error(`Chrome exited with ${processHandle.exitCode}.`);
    try {
      const [port] = (await readFile(path, 'utf8')).trim().split('\n');
      if (/^[1-9][0-9]*$/u.test(port ?? '')) return Number(port);
    } catch {
      // Chrome creates the file only after its DevTools endpoint is ready.
    }
    await sleep(50);
  }
  throw new Error('Chrome did not expose a DevTools endpoint.');
}

let socket;
try {
  const port = await debuggingPort();
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const target = targets.find((candidate) => candidate.type === 'page');
  if (typeof target?.webSocketDebuggerUrl !== 'string') throw new Error('Chrome exposed no page target.');

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Chrome DevTools connection failed.')), { once: true });
  });

  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    sequence += 1;
    pending.set(sequence, { resolve, reject });
    socket.send(JSON.stringify({ id: sequence, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`Browser evaluation failed: ${result.exceptionDetails.text}`);
    return result.result?.value;
  };
  const waitFor = async (expression, message, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    throw new Error(message);
  };
  const navigate = async (path, expectedRole) => {
    const url = new URL(path, origin).href;
    const result = await command('Page.navigate', { url });
    if (result.errorText) throw new Error(`Navigation to ${path} failed: ${result.errorText}`);
    await waitFor(
      `location.origin === ${JSON.stringify(productOrigin.origin)} && document.readyState === 'complete'`,
      `Navigation to ${path} did not complete.`,
    );
    if (expectedRole) {
      await waitFor(
        `document.querySelector('#loginWorld')?.classList.contains('open') && document.querySelector('#selectedRoleName')?.textContent === ${JSON.stringify(expectedRole)}`,
        `${path} did not open the ${expectedRole.toLowerCase()} pixel portal.`,
      );
    }
    const page = await evaluate('({ title: document.title, text: document.body?.innerText ?? "", url: location.href })');
    if (typeof page?.title !== 'string' || typeof page?.text !== 'string' || page.text.length < 80) {
      throw new Error(`Navigation to ${path} rendered no meaningful page.`);
    }
    if (/API is not reachable|internal server error/iu.test(page.text)) {
      throw new Error(`Navigation to ${path} rendered an application error.`);
    }
    return page;
  };

  await command('Page.enable');
  await command('Runtime.enable');
  const landing = await navigate('/');
  if (!/Anchor|WORK WITHOUT BORDERS/u.test(landing.text)) throw new Error('The canonical Anchor experience did not render.');
  const company = await navigate('/company', 'COMPANY');
  if (!/WELCOME[\s\S]*COMPANY/u.test(company.text)) throw new Error('The company login did not render.');
  const freelancer = await navigate('/freelancer', 'FREELANCER');
  if (!/WELCOME[\s\S]*FREELANCER/u.test(freelancer.text)) throw new Error('The freelancer login did not render.');

  process.stdout.write(`${JSON.stringify({
    status: 'passed',
    canonicalExperience: productOrigin.href,
    compatibilityRoutes: ['/', '/company', '/freelancer'],
  }, null, 2)}\n`);
} finally {
  socket?.close();
  processHandle.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => processHandle.once('exit', resolve)),
    sleep(2_000),
  ]);
  await rm(profile, { recursive: true, force: true });
}

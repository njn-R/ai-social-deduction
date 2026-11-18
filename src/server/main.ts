/**
 * The game server: serves the browser client and runs live games over a WebSocket.
 *
 *   npm run play                  # build the client, start on http://localhost:8787
 *   npm run play -- --fake        # no model: canned AI lines (for trying the UI)
 *   npm run play -- --model <id>  # a specific LM Studio model (or set it in ai.local.json)
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { WebSocketServer, type WebSocket } from 'ws';
import { FakeProvider } from '../ai/llm/fake';
import { LmStudioProvider } from '../ai/llm/lmstudio';
import type { LlmProvider } from '../ai/llm/types';
import { loadLocalConfig } from '../ai/localConfig';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import { GameSession } from './session';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8787' },
    fake: { type: 'boolean', default: false },
    model: { type: 'string' },
    url: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    // End games after this many minutes (default: the rules' 20-minute limit). Handy for testing.
    'max-minutes': { type: 'string' },
  },
});
const maxGameSec = values['max-minutes'] ? Number(values['max-minutes']) * 60 : undefined;

const local = loadLocalConfig();
let provider: LlmProvider;
let model: string;
if (values.fake) {
  provider = new FakeProvider({ seed: Date.now() % 100000, latencyMs: 1500, realDelay: true });
  model = 'fake';
} else {
  const lm = new LmStudioProvider({ model: values.model ?? local.model, baseUrl: values.url ?? local.url });
  try {
    model = await lm.resolveModel();
  } catch (e) {
    console.error(`\n${(e as Error).message}\nOr try the UI without a model: npm run play -- --fake\n`);
    process.exit(1);
  }
  provider = lm;
}

// ── Static files ───────────────────────────────────────────────────────────
const ROOT = resolve('dist/client');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const http = createServer((req, res) => {
  // Cross-origin isolation lets the in-browser voice engine run WebAssembly on several threads
  // (several times faster than one). "credentialless" keeps cross-origin model downloads working.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const file = normalize(join(ROOT, path === '/' ? 'index.html' : path));
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    if (!existsSync(join(ROOT, 'index.html'))) {
      res.writeHead(503, { 'content-type': 'text/plain' }).end('Client not built yet. Run: npm run play (it builds first).');
      return;
    }
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});

// ── Live games ─────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: http, path: '/ws' });
// One game at a time, controlled by the tab that started it.
let session: GameSession | null = null;
let owner: WebSocket | null = null;

wss.on('connection', (ws: WebSocket) => {
  const send = (m: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  send({ type: 'hello', model, fake: !!values.fake });

  ws.on('message', (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(data)) as ClientMessage;
    } catch {
      return;
    }
    if (msg.type === 'start') {
      session?.stop();
      session = new GameSession({
        provider,
        model,
        humanName: String(msg.name ?? ''),
        role: msg.role === 'crew' || msg.role === 'saboteur' ? msg.role : 'random',
        seed: Math.floor(Math.random() * 1_000_000),
        concurrency: Number(values.concurrency),
        ...(maxGameSec ? { config: { maxGameSec } } : {}),
        send,
      });
      owner = ws;
      send(session.welcome());
      session.run();
      console.log(`New game started (seed ${session.game.seed}).`);
      return;
    }
    if (owner === ws) session?.handle(msg);
  });

  ws.on('close', () => {
    if (owner !== ws) return;
    session?.stop();
    session = null;
    owner = null;
  });
});

http.listen(Number(values.port), () => {
  console.log(`\nGame server ready. AI model: ${model}`);
  console.log(`Open http://localhost:${values.port} in your browser.\n`);
});

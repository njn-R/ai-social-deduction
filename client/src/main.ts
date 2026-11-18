import type { Vec2 } from '../../src/engine';
import type { ClientMessage, RoleChoice, ServerMessage } from '../../src/shared/protocol';
import { available, type ActionKey } from './actions';
import { Hud } from './hud';
import { MeetingView } from './meeting';
import { Renderer } from './render';
import { el } from './dom';
import { GameOver, Intro, Lobby, Toasts } from './screens';
import { newState, setMap } from './state';
import { describeVoices, Voices } from './voice';
import './style.css';

const s = newState();
const app = document.getElementById('app')!;
const canvas = document.getElementById('view') as HTMLCanvasElement;

// ── Connection ─────────────────────────────────────────────────────────────
const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
const send = (m: ClientMessage) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
};

// ── Voices ─────────────────────────────────────────────────────────────────
const voicePref = (() => {
  try {
    return localStorage.getItem('deep-station:voices') !== 'off';
  } catch {
    return true;
  }
})();
const ENGINE_KEY = 'deep-station:voice-engine';
const cpuPref = (() => {
  try {
    return localStorage.getItem(ENGINE_KEY) === 'cpu';
  } catch {
    return false;
  }
})();
const voices = new Voices(voicePref, cpuPref);
function setCpuOnly(cpu: boolean): void {
  voices.setPreferCpu(cpu);
  try {
    localStorage.setItem(ENGINE_KEY, cpu ? 'cpu' : 'auto');
  } catch {
    // not remembered; fine
  }
}
const muteButton = el('button', { class: 'mute', type: 'button', onclick: () => toggleVoices(!voices.enabled) });
function toggleVoices(on: boolean): void {
  voices.setEnabled(on);
  try {
    localStorage.setItem('deep-station:voices', on ? 'on' : 'off');
  } catch {
    // not remembered; fine
  }
}
const RATE_KEY = 'deep-station:voice-rate';
voices.rate = (() => {
  try {
    return Number(localStorage.getItem(RATE_KEY)) || 1.15;
  } catch {
    return 1.15;
  }
})();
function setRate(rate: number): void {
  voices.rate = rate;
  try {
    localStorage.setItem(RATE_KEY, String(rate));
  } catch {
    // not remembered; fine
  }
}
voices.onBusy = (busy) => send({ type: 'speaking', on: busy });
voices.onStatus = () => {
  lobby.setVoiceStatus(describeVoices(voices));
  muteButton.textContent = voices.enabled ? 'Mute voices' : 'Unmute voices';
  send({ type: 'voice', on: voices.ready });
};

let lastStart: { name: string; role: RoleChoice } | null = null;
const start = (name: string, role: RoleChoice) => {
  voices.unlock(); // we're inside a click, so the browser will allow sound
  lastStart = { name, role };
  send({ type: 'start', name, role });
};

const lobby = new Lobby(start, {
  on: voicePref,
  onToggle: toggleVoices,
  rate: voices.rate,
  onRate: setRate,
  cpu: cpuPref,
  onCpu: setCpuOnly,
  onTest: () => voices.test({ kokoro: 'af_heart', speed: 1 }),
});
const hud = new Hud(s, (action) => send({ type: 'act', action }));
const meeting = new MeetingView(s, send, (key) => voices.owns(key));
meeting.setControls(muteButton);
voices.onSpoken = (sp) => meeting.addSpoken(sp);
voices.onLineDone = (key, spoke) => meeting.lineDone(key, spoke);
voices.onStatus();
const intro = new Intro(() => send({ type: 'ready' }));
const toasts = new Toasts();
const gameOver = new GameOver(() => lastStart && start(lastStart.name, lastStart.role));
app.append(hud.root, meeting.root, toasts.root, gameOver.root, intro.root, lobby.root);
const renderer = new Renderer(canvas, s);

let lastPhase = '';
// Meeting lines already handed to the voice player.
let spokenMeeting = -1;
let spokenLines = 0;

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(String(ev.data)) as ServerMessage;
  switch (msg.type) {
    case 'hello':
      s.model = msg.model;
      s.fake = msg.fake;
      lobby.ready(msg.model, msg.fake);
      break;
    case 'welcome':
      setMap(s, msg.map, msg.config, msg.you, msg.voices);
      voices.stop();
      send({ type: 'voice', on: voices.ready });
      spokenMeeting = -1;
      spokenLines = 0;
      lobby.setVisible(false);
      gameOver.close();
      break;
    case 'obs':
      s.obs = msg.obs;
      s.obsAt = performance.now();
      if (msg.obs.tick > 0 && intro.open) intro.close(); // the game has started
      if (msg.obs.phase !== lastPhase) {
        if (msg.obs.phase === 'meeting') releaseKeys();
        if (lastPhase === 'meeting') voices.stop();
        lastPhase = msg.obs.phase;
      }
      speakNewLines();
      hud.update();
      meeting.update();
      break;
    case 'intro':
      intro.show(s, msg.seconds);
      break;
    case 'typing':
      if (msg.on) s.typing.set(msg.playerId, performance.now() + 30_000);
      else s.typing.delete(msg.playerId);
      break;
    case 'notice':
      toasts.push(msg.text);
      break;
    case 'game_over':
      s.over = { result: msg.result, roles: msg.roles, reveal: msg.reveal };
      releaseKeys();
      gameOver.open(s);
      break;
    case 'error':
      toasts.push(`Server error: ${msg.message}`);
      break;
    case 'taken':
      // A game was started from another tab or window; this one goes quiet.
      voices.stop();
      releaseKeys();
      s.obs = null;
      gameOver.close();
      lobby.setVisible(true);
      toasts.push('This game moved to another tab or window.');
      break;
  }
});
/** Hand any new AI meeting lines to the voice player (your own lines aren't read back). */
function speakNewLines(): void {
  const m = s.obs?.meeting;
  if (!m) return;
  if (m.index !== spokenMeeting) {
    spokenMeeting = m.index;
    spokenLines = 0;
  }
  m.chat.slice(spokenLines).forEach((c, i) => {
    if (c.playerId !== s.you) voices.say(`${m.index}:${spokenLines + i}`, c.text, s.voices[c.playerId]);
  });
  spokenLines = m.chat.length;
}

ws.addEventListener('close', () => {
  lobby.disconnected();
  lobby.setVisible(true);
});

// ── Keyboard ───────────────────────────────────────────────────────────────
const held = new Set<string>();
let lastDir: Vec2 | null = null;
const DIRS: Record<string, Vec2> = {
  w: { x: 0, y: -1 }, arrowup: { x: 0, y: -1 },
  s: { x: 0, y: 1 }, arrowdown: { x: 0, y: 1 },
  a: { x: -1, y: 0 }, arrowleft: { x: -1, y: 0 },
  d: { x: 1, y: 0 }, arrowright: { x: 1, y: 0 },
};

function pushMove(): void {
  let x = 0;
  let y = 0;
  for (const k of held) {
    x += DIRS[k]?.x ?? 0;
    y += DIRS[k]?.y ?? 0;
  }
  const len = Math.hypot(x, y);
  const dir = len === 0 ? null : { x: x / len, y: y / len };
  if (dir?.x === lastDir?.x && dir?.y === lastDir?.y) return;
  lastDir = dir;
  send({ type: 'move', dir });
}

function releaseKeys(): void {
  held.clear();
  pushMove();
}

const typingInField = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;

window.addEventListener('keydown', (e) => {
  if (typingInField(e) || e.repeat) return;
  const k = e.key.toLowerCase();
  if (k in DIRS) {
    held.add(k);
    pushMove();
    e.preventDefault();
    return;
  }
  const key = k.toUpperCase() as ActionKey;
  const hit = available(s).actions.find((a) => a.key === key);
  if (hit) send({ type: 'act', action: hit.action });
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (held.delete(k)) pushMove();
});
window.addEventListener('blur', releaseKeys);

// ── Frame loop ─────────────────────────────────────────────────────────────
function frame(now: number): void {
  renderer.draw(now);
  meeting.tick(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

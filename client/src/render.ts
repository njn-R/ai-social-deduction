import type { NavGrid, PlayerId, Vec2 } from '../../src/engine';
import { hex } from './colors';
import { colorOf, nameOf, type ClientState } from './state';

const C = {
  void: '#040b13',
  room: '#16374a',
  roomEdge: '#2b6480',
  hall: '#112b3b',
  label: 'rgba(170, 215, 235, 0.35)',
  station: '#24576c',
  stationDone: '#3ccf6e',
  mine: '#ffd166',
  button: '#ff5d5d',
  fog: 'rgba(2, 7, 12, 0.86)',
};

/** Draws the world from the player's point of view, with fog of war. */
export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly fog = document.createElement('canvas');
  private readonly fctx = this.fog.getContext('2d')!;
  private readonly shown = new Map<PlayerId, Vec2>();
  private lastFrame = performance.now();
  private tile = 30;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly s: ClientState,
  ) {
    this.ctx = canvas.getContext('2d')!;
  }

  draw(now: number): void {
    const { canvas, ctx, s } = this;
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      this.fog.width = canvas.width;
      this.fog.height = canvas.height;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.void;
    ctx.fillRect(0, 0, w, h);
    const obs = s.obs;
    const nav = s.nav;
    if (!obs || !nav || !s.you) return;

    this.tile = Math.max(22, Math.min(40, Math.min(w, h) / 19));
    const T = this.tile;
    const me = this.smooth(s.you, obs.self.pos, dt);
    const cam = { x: w / 2 - me.x * T, y: h / 2 - me.y * T };
    const at = (p: Vec2) => ({ x: cam.x + p.x * T, y: cam.y + p.y * T });

    this.drawMap(nav, at, T);
    const meeting = obs.phase === 'meeting';

    // Bodies.
    for (const b of obs.visibleBodies) {
      const p = at(b.pos);
      ctx.fillStyle = hex(colorOf(s, b.victimId));
      ctx.beginPath();
      ctx.ellipse(p.x, p.y + T * 0.12, T * 0.42, T * 0.24, 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#0b0f14';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(p.x - T * 0.15, p.y - T * 0.05);
      ctx.lineTo(p.x + T * 0.15, p.y + T * 0.25);
      ctx.moveTo(p.x + T * 0.15, p.y - T * 0.05);
      ctx.lineTo(p.x - T * 0.15, p.y + T * 0.25);
      ctx.stroke();
    }

    // Other players, then yourself on top.
    const seen = new Set<PlayerId>();
    if (!meeting) {
      for (const v of obs.visiblePlayers) {
        seen.add(v.id);
        const pos = this.smooth(v.id, v.pos, dt);
        this.drawPlayer(at(pos), v.id, { ghost: !v.alive, working: !!v.workingAt });
      }
    }
    for (const id of [...this.shown.keys()]) if (id !== s.you && !seen.has(id)) this.shown.delete(id);
    this.drawPlayer(at(me), s.you, { ghost: !obs.self.alive, working: !!obs.self.busy, self: true });

    if (obs.self.busy && s.config) {
      const st = nav.station(obs.self.busy.stationId);
      const total = st.kind === 'long' ? s.config.longTaskSec : s.config.shortTaskSec;
      const done = 1 - obs.self.busy.secLeft / total;
      const p = at(me);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(p.x - T * 0.7, p.y - T * 1.25, T * 1.4, 6);
      ctx.fillStyle = C.mine;
      ctx.fillRect(p.x - T * 0.7, p.y - T * 1.25, T * 1.4 * Math.max(0, Math.min(1, done)), 6);
    }

    if (!meeting) this.drawFog(nav, me, at, w, h, dpr);
  }

  /** Ease displayed positions toward the latest ones, so 20 updates a second look smooth. */
  private smooth(id: PlayerId, target: Vec2, dt: number): Vec2 {
    const cur = this.shown.get(id);
    if (!cur || Math.hypot(cur.x - target.x, cur.y - target.y) > 3) {
      const p = { ...target };
      this.shown.set(id, p);
      return p;
    }
    const k = 1 - Math.exp(-dt * 18);
    cur.x += (target.x - cur.x) * k;
    cur.y += (target.y - cur.y) * k;
    return cur;
  }

  private drawMap(nav: NavGrid, at: (p: Vec2) => Vec2, T: number): void {
    const { ctx, s } = this;
    const map = nav.map;
    for (const a of map.areas) {
      const p = at({ x: a.rect.x, y: a.rect.y });
      ctx.fillStyle = a.kind === 'room' ? C.room : C.hall;
      ctx.fillRect(p.x, p.y, a.rect.w * T, a.rect.h * T);
    }
    for (const a of map.areas.filter((x) => x.kind === 'room')) {
      const p = at({ x: a.rect.x, y: a.rect.y });
      ctx.strokeStyle = C.roomEdge;
      ctx.lineWidth = 2;
      ctx.strokeRect(p.x + 1, p.y + 1, a.rect.w * T - 2, a.rect.h * T - 2);
      ctx.fillStyle = C.label;
      ctx.font = `600 ${Math.round(T * 0.5)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(a.name.toUpperCase(), p.x + (a.rect.w * T) / 2, p.y + T * 0.85);
    }
    // Repaint hall floor over room outlines where they join, so doorways look open.
    for (const a of map.areas.filter((x) => x.kind === 'hall')) {
      const p = at({ x: a.rect.x, y: a.rect.y });
      ctx.fillStyle = C.hall;
      ctx.fillRect(p.x, p.y, a.rect.w * T, a.rect.h * T);
    }

    const mine = new Map((s.obs?.self.tasks ?? []).map((t) => [t.stationId, t.done]));
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 250);
    for (const st of map.stations) {
      const p = at(st.pos);
      const isMine = mine.has(st.id);
      const done = mine.get(st.id) === true;
      ctx.fillStyle = done ? C.stationDone : C.station;
      ctx.fillRect(p.x - T * 0.28, p.y - T * 0.28, T * 0.56, T * 0.56);
      if (isMine && !done) {
        ctx.strokeStyle = C.mine;
        ctx.globalAlpha = 0.5 + 0.5 * pulse;
        ctx.lineWidth = 3;
        ctx.strokeRect(p.x - T * 0.4, p.y - T * 0.4, T * 0.8, T * 0.8);
        ctx.globalAlpha = 1;
      }
    }

    const b = at(map.button.pos);
    ctx.fillStyle = '#5a1d1d';
    ctx.beginPath();
    ctx.arc(b.x, b.y, T * 0.75, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = C.button;
    ctx.beginPath();
    ctx.arc(b.x, b.y, T * 0.45, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawPlayer(p: Vec2, id: PlayerId, o: { ghost?: boolean; working?: boolean; self?: boolean }): void {
    const { ctx, s } = this;
    const T = this.tile;
    const r = T * 0.36;
    ctx.globalAlpha = o.ghost ? 0.45 : 1;
    ctx.fillStyle = hex(colorOf(s, id));
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = o.self ? 3 : 2;
    ctx.strokeStyle = o.self ? '#ffffff' : 'rgba(0,0,0,0.55)';
    ctx.stroke();
    const name = nameOf(s, id);
    ctx.fillStyle = '#04101a';
    ctx.font = `700 ${Math.round(r)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name.charAt(0).toUpperCase(), p.x, p.y + 1);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#e8f4fa';
    ctx.font = `600 ${Math.round(T * 0.38)}px system-ui, sans-serif`;
    ctx.fillText(o.self ? `${name} (you)` : name, p.x, p.y - r - 6);
    if (o.working && !o.self) {
      ctx.fillStyle = C.mine;
      ctx.fillText('working', p.x, p.y + r + T * 0.42);
    }
    ctx.globalAlpha = 1;
  }

  /** Darken everything outside the player's sight, with walls casting shadows. */
  private drawFog(nav: NavGrid, me: Vec2, at: (p: Vec2) => Vec2, w: number, h: number, dpr: number): void {
    const { s, fctx } = this;
    const radius = s.obs!.self.role === 'saboteur' ? s.config!.saboteurVision : s.config!.crewVision;
    const poly = visionPolygon(nav, me, radius);
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fctx.globalCompositeOperation = 'source-over';
    fctx.clearRect(0, 0, w, h);
    fctx.fillStyle = C.fog;
    fctx.fillRect(0, 0, w, h);
    fctx.globalCompositeOperation = 'destination-out';
    const c = at(me);
    const R = radius * this.tile;
    const grad = fctx.createRadialGradient(c.x, c.y, R * 0.6, c.x, c.y, R);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    fctx.fillStyle = grad;
    fctx.beginPath();
    poly.forEach((pt, i) => {
      const q = at(pt);
      if (i === 0) fctx.moveTo(q.x, q.y);
      else fctx.lineTo(q.x, q.y);
    });
    fctx.closePath();
    fctx.fill();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.drawImage(this.fog, 0, 0);
  }
}

/** Cast rays from `from` until they hit a wall or reach `radius`. */
export function visionPolygon(nav: NavGrid, from: Vec2, radius: number, rays = 220): Vec2[] {
  const pts: Vec2[] = [];
  const step = 0.08;
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let d = 0;
    while (d < radius) {
      const next = d + step;
      if (!nav.isWalkable({ x: from.x + dx * next, y: from.y + dy * next })) break;
      d = next;
    }
    // Let the light reach a little into the wall so edges aren't jagged.
    const reach = d < radius ? d + 0.25 : radius;
    pts.push({ x: from.x + dx * reach, y: from.y + dy * reach });
  }
  return pts;
}

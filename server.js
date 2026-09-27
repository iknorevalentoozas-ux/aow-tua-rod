'use strict';
// Wild Town — multiplayer survival tycoon. Zero-dependency Node server (HTTP + WebSocket + game loop).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const S = require('./public/shared.js');

const PORT = +process.env.PORT || 8765;
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

// ---------------------------------------------------------------- HTTP
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400); return res.end(); } // malformed URI must not crash the server
  if (p === '/') p = '/index.html';
  const fp = path.normalize(path.join(PUB, p));
  if (!fp.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------------------------------------------------------------- Minimal WebSocket (RFC 6455)
class WSConn {
  constructor(socket) {
    this.s = socket; this.buf = Buffer.alloc(0); this.frag = []; this.open = true; this.seen = Date.now();
    socket.on('data', d => this.onData(d));
    socket.on('close', () => this.close());
    socket.on('error', () => this.close());
  }
  onData(d) {
    this.seen = Date.now();
    this.buf = Buffer.concat([this.buf, d]);
    while (this.open) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1], op = b0 & 15, fin = b0 & 128;
      let len = b1 & 127, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > (1 << 20)) return this.close();
      const masked = b1 & 128, mo = off;
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      let payload = Buffer.from(this.buf.subarray(off, off + len));
      if (masked) { const m = this.buf.subarray(mo, mo + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
      this.buf = this.buf.subarray(off + len);
      if (op === 8) return this.close();
      if (op === 9) { this.frame(10, payload); continue; }
      if (op === 10) continue;
      this.frag.push(payload);
      if (fin) {
        const msg = Buffer.concat(this.frag).toString('utf8'); this.frag = [];
        if (this.onmessage) this.onmessage(msg);
      }
    }
  }
  frame(op, data) {
    if (!this.open) return;
    const len = data.length; let h;
    if (len < 126) { h = Buffer.alloc(2); h[1] = len; }
    else if (len < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
    h[0] = 0x80 | op;
    this.s.write(Buffer.concat([h, data]));
  }
  send(str) {
    if (this.s.writableLength > 2e6) return; // slow client — skip frame
    this.frame(1, Buffer.from(str));
  }
  close() {
    if (!this.open) return;
    if (this.s.writable) this.frame(8, Buffer.alloc(0));
    this.open = false;
    // end() lets queued frames (e.g. 'kicked') flush; destroy later in case the peer never answers
    try { this.s.end(); } catch (e) { /* ignore */ }
    setTimeout(() => this.s.destroy(), 1000).unref();
    if (this.onclose) this.onclose();
  }
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  onConnect(new WSConn(socket));
});

// ---------------------------------------------------------------- Game
const TICK = 20, DT = 1 / TICK;
const SPEED = Math.max(1, Math.floor(+process.env.SPEED || 1)); // dev: fast-forward the simulation
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#ff6fb5', '#ecf0f1', '#8e5cff', '#a3e048', '#00d2ff'];
const SHOPS = {
  meat: { plot: 'meat', stock: 'meat', cash: 'cashM', item: 'S', x: 7 },
  wood: { plot: 'wood', stock: 'wood', cash: 'cashW', item: 'P', x: -7 },
};
const STOCK_MAX = 99;
const EMOTES = ['👋', '❤️', '🆘', '😂']; // client renders emotes as HTML, so only accept known ones
const GRACE = 60; // seconds a disconnected player's slot (position, bag, stats) is kept for them to reconnect

const players = new Map();
let nextPid = 1, G = null, segs = [], tickN = 0;

const rnd = (a, b) => a + Math.random() * (b - a);
const rint = (a, b) => Math.floor(rnd(a, b + 1));
const d2 = (ax, az, bx, bz) => { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; };
const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;
const pos = e => [r1(e.x), r1(e.z)];

function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l = dx * dx + dz * dz;
  let t = ((px - ax) * dx + (pz - az) * dz) / l; t = Math.max(0, Math.min(1, t));
  return Math.sqrt(d2(px, pz, ax + dx * t, az + dz * t));
}

const ev = e => G.ev.push(e);
const msg = s => ev({ k: 'm', s });
const levels = () => G.plots.map(p => p.level);
const built = id => G.plots[S.PI[id]].level > 0;
const curSeg = () => segs[G.segIdx] || { day: 1, night: false, start: 0, end: 0 };
// players who are connected right now (disconnected ones wait out GRACE and take no part in the game)
const online = () => [...players.values()].filter(p => p.conn);
const playerFactor = () => Math.min(4, 1 + 0.5 * (Math.max(1, online().length) - 1));

const blockedSpot = (x, z) => (Math.abs(x) < 5 && z > 0) || S.PONDS.some(p => d2(p.x, p.z, x, z) < (p.r + 2.5) ** 2);

function genTrees() {
  const trees = []; let tries = 0;
  while (trees.length < 130 && tries < 8000) {
    tries++;
    const a = Math.random() * Math.PI * 2, r = rnd(32, 71);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (blockedSpot(x, z)) continue; // keep the road and ponds clear
    if (trees.some(t => d2(t.x, t.z, x, z) < 3.3 * 3.3)) continue;
    trees.push({ x: r1(x), z: r1(z), s: r2(rnd(0.8, 1.3)), wood: 4, max: 4, re: 0 });
  }
  return trees;
}

function genRocks(trees) {
  const rocks = []; let tries = 0;
  while (rocks.length < 30 && tries < 8000) {
    tries++;
    const a = Math.random() * Math.PI * 2, r = rnd(33, 70);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (blockedSpot(x, z)) continue;
    if (trees.some(t => d2(t.x, t.z, x, z) < 3 * 3) || rocks.some(t => d2(t.x, t.z, x, z) < 6 * 6)) continue;
    rocks.push({ x: r1(x), z: r1(z), s: r2(rnd(0.9, 1.4)), stone: 6, max: 6, re: 0 });
  }
  return rocks;
}

function resetWorld() {
  const trees = genTrees();
  G = {
    phase: 'lobby', t: 0, days: 5, total: 0, money: 0, earned: 0, coreHp: S.CORE.hp,
    trees, rocks: genRocks(trees), boars: [], mons: [], vils: [], workers: [], portals: [], pending: [],
    plots: S.PLOTS.map((p, i) => ({ level: p.start || 0, pc: 0, pp: 0, pr: 0, hp: S.hpOf(i, p.start || 0), cd: 0 })),
    st: { sawIn: 0, sawOut: 0, grillIn: 0, grillOut: 0, meat: 0, wood: 0, cashM: 0, cashW: 0 },
    tm: { saw: 0, grill: 0, vmeat: 3, vwood: 3, boar: 0, core: 0 },
    q: { meat: [], wood: [] }, segIdx: 0, spawnList: [], kills: 0, result: null, ev: [], id: 1,
  };
  segs = S.segments(G.days);
  for (let i = 0; i < 14; i++) spawnBoar(true);
  for (const p of players.values()) resetPlayer(p);
  broadcast(worldMsg());
}

function worldMsg() {
  return JSON.stringify({ t: 'world', trees: G.trees.map(t => [t.x, t.z, t.s]), rocks: G.rocks.map(t => [t.x, t.z, t.s]) });
}

function resetPlayer(p) {
  p.x = S.SPAWN.x + rnd(-2, 2); p.z = S.SPAWN.z + rnd(0, 2); p.r = Math.PI;
  p.hp = 100; p.dead = false; p.respawn = 0; p.carry = [];
  p.chopT = 0; p.shootT = 0; p.xferT = 0; p.lastHit = -99; p.tp = (p.tp || 0) + 1; p.skillT = 0;
  p.stats = { wood: 0, stone: 0, boar: 0, kills: 0, cash: 0, build: 0 };
}

function startGame(days) {
  if (G.phase !== 'lobby') return;
  G.days = [3, 5, 7].includes(days) ? days : 5;
  segs = S.segments(G.days);
  G.total = segs[segs.length - 1].end;
  G.phase = 'play'; G.t = 0; G.segIdx = 0;
  msg('☀️ วันที่ 1 — ล่าหมูป่า ย่างเนื้อขาย เก็บเงินสร้างเมืองก่อนค่ำ!');
}

function endGame(win) {
  G.phase = 'end';
  G.result = {
    win, day: curSeg().day, days: G.days, earned: G.earned, kills: G.kills,
    built: G.plots.reduce((a, p, i) => a + (S.PLOTS[i].start ? 0 : p.level), 0),
    players: [...players.values()].map(p => ({ name: p.name, color: p.color, ...p.stats })),
  };
  msg(win ? '🏆 เมืองรอดแล้ว! ชนะ!' : '💀 ศาลากลางถูกทำลาย...');
}

// ---------------------------------------------------------------- Spawning
function spawnBoar(initial) {
  for (let tries = 0; tries < 20; tries++) {
    const a = Math.random() * Math.PI * 2, r = initial ? rnd(34, 55) : rnd(36, 70);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (!initial && online().some(p => d2(p.x, p.z, x, z) < 14 * 14)) continue;
    G.boars.push({ id: G.id++, x, z, r: rnd(0, 6), hp: 30, max: 30, tx: x, tz: z, wt: 0, ag: 0, agT: 0, atkT: 0 });
    return;
  }
}

function startNight(n) {
  const pf = playerFactor(), list = [], span = S.NIGHT * 0.55;
  const add = (type, count) => { for (let i = 0; i < count; i++) list.push({ type, at: G.t + rnd(1, span) }); };
  add('goblin', Math.round((3 + 3.5 * n) * pf));
  if (n >= 2) add('wolf', Math.round((1 + 1.5 * n) * pf));
  if (n >= 3) add('ogre', Math.max(1, Math.round((n - 2) * pf * 0.7)));
  if (n === G.days) { list.push({ type: 'boss', at: G.t + 6 }); msg('👹 ราชาปีศาจปรากฏตัว! ปกป้องศาลากลาง!'); }
  G.spawnList = list;
  // portals: monsters pour out of a few rifts at the forest edge
  const count = Math.min(4, 1 + Math.ceil(n / 2)), base = Math.random() * Math.PI * 2;
  G.portals = [];
  for (let i = 0; i < count; i++) {
    const a = base + i * Math.PI * 2 / count + rnd(-0.4, 0.4);
    G.portals.push([r1(Math.cos(a) * 66), r1(Math.sin(a) * 66)]);
  }
  msg(`🌙 คืนที่ ${n} — ประตูมิติเปิด ${G.portals.length} จุด (ทิศ${G.portals.map(p => S.dirName(p[0], p[1])).join(', ')})! กลับไปป้องกันเมือง`);
}

function spawnMonster(type) {
  const def = S.MONSTERS[type], n = curSeg().day;
  const pt = G.portals.length ? G.portals[rint(0, G.portals.length - 1)] : [72, 0];
  let hp = def.hp * (1 + 0.2 * (n - 1));
  if (type === 'boss') hp = def.hp * playerFactor() * (0.5 + 0.1 * G.days);
  G.mons.push({ id: G.id++, type, x: pt[0] + rnd(-2, 2), z: pt[1] + rnd(-2, 2), r: 0, hp, max: hp,
    spd: def.spd, dmg: def.dmg, rad: def.r, atkT: 0, rt: 0, tgt: null });
}

function dawn(d) {
  for (const m of G.mons) ev({ k: 'd', x: r1(m.x), z: r1(m.z), t: m.type });
  G.mons = []; G.spawnList = []; G.portals = []; G.pending = [];
  G.plots.forEach((p, i) => { if (p.level > 0 && S.PLOTS[i].hp) p.hp = S.hpOf(i, p.level); });
  msg(`☀️ วันที่ ${d} — รุ่งเช้าแล้ว มอนสเตอร์ถูกแสงแดดเผา! สิ่งก่อสร้างซ่อมเสร็จ`);
}

function spawnWorker(type, plotIdx) {
  const pl = S.PLOTS[plotIdx];
  G.workers.push({ id: G.id++, type, x: pl.x, z: pl.z, r: 0, carry: [], st: 'seek', tgt: null, t: 0 });
}

// ---------------------------------------------------------------- Helpers
function capacity() { return S.STATS.cap(levels()); }

function takeItem(e, kind) {
  const i = e.carry.lastIndexOf(kind);
  if (i < 0) return false;
  e.carry.splice(i, 1); return true;
}

function moveTo(e, x, z, stop, dt, spd) {
  const dx = x - e.x, dz = z - e.z, d = Math.hypot(dx, dz);
  if (d <= stop) return true;
  const step = Math.min(d - stop, spd * dt);
  e.x += dx / d * step; e.z += dz / d * step; e.r = Math.atan2(dx, dz);
  return d - step <= stop + 1e-3;
}

function nearest(list, x, z, maxD, filter) {
  let best = null, bd = maxD * maxD;
  for (const o of list) {
    if (filter && !filter(o)) continue;
    const d = d2(o.x, o.z, x, z);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

function hurtPlayer(p, dmg) {
  if (p.dead) return;
  p.hp -= dmg; p.lastHit = G.t;
  ev({ k: 'ph', p: p.id, d: dmg });
  if (p.hp <= 0) {
    p.dead = true; p.respawn = 6; p.carry = []; p.hp = 0;
    ev({ k: 'd', x: r1(p.x), z: r1(p.z), t: 'player' });
    msg(`💀 ${p.name} ล้มลง! จะฟื้นใน 6 วินาที`);
  }
}

function hurtBoar(b, dmg, src) {
  if (b.dead) return;
  b.hp -= dmg;
  ev({ k: 'h', x: r1(b.x), z: r1(b.z), d: dmg, p: src.pid || 0 });
  if (src.pid) { b.ag = src.pid; b.agT = 6; }
  if (b.hp <= 0) {
    b.dead = true;
    ev({ k: 'd', x: r1(b.x), z: r1(b.z), t: 'boar' });
    const cap = src.pid ? capacity() : 8;
    for (let i = 0; i < 3; i++) {
      if (src.carry.length < cap) { src.carry.push('M'); ev({ k: 'f', i: 'M', a: pos(b), b: src.pid || pos(src) }); }
    }
    if (src.pid) src.stats.boar++;
  }
}

function hurtMonster(m, dmg, pid) {
  if (m.dead) return;
  m.hp -= dmg;
  ev({ k: 'h', x: r1(m.x), z: r1(m.z), d: dmg, p: pid || 0 });
  if (m.hp <= 0) {
    m.dead = true;
    const rw = S.MONSTERS[m.type].reward;
    G.money += rw; G.earned += rw; G.kills++;
    ev({ k: 'd', x: r1(m.x), z: r1(m.z), t: m.type });
    ev({ k: '$', x: r1(m.x), z: r1(m.z), a: rw });
    const p = players.get(pid);
    if (p) p.stats.kills++;
    if (m.type === 'boss') msg('🎉 ราชาปีศาจพ่ายแพ้แล้ว!');
  }
}

// Ground slam: area damage + knockback, shared cooldown per player
function useSkill(p) {
  if (G.phase !== 'play' || p.dead || G.t < p.skillT) return;
  p.skillT = G.t + S.SKILL_CD;
  const dmg = S.STATS.skill(levels()), R = S.SKILL_R;
  ev({ k: 'sk', p: p.id, x: r1(p.x), z: r1(p.z) });
  for (const m of G.mons) {
    if (m.dead) continue;
    const dx = m.x - p.x, dz = m.z - p.z, d = Math.hypot(dx, dz);
    if (d > R + m.rad) continue;
    hurtMonster(m, dmg, p.id);
    const kb = m.type === 'boss' ? 0.4 : m.type === 'ogre' ? 1.2 : 3;
    if (d > 0.01) { m.x += dx / d * kb; m.z += dz / d * kb; }
    m.atkT = Math.max(m.atkT, 0.8); // stagger
  }
  for (const b of G.boars) {
    if (!b.dead && d2(b.x, b.z, p.x, p.z) < R * R) hurtBoar(b, dmg, { pid: p.id, carry: p.carry, stats: p.stats });
  }
}

function arrow(fx, fy, fz, t) { ev({ k: 'a', f: [r1(fx), fy, r1(fz)], t: pos(t) }); }

function completePlot(i, p) {
  const pl = G.plots[i], def = S.PLOTS[i];
  pl.level++; pl.pc = 0; pl.pp = 0; pl.pr = 0; pl.hp = S.hpOf(i, pl.level);
  if (def.kind === 'hire') spawnWorker(def.worker, i);
  ev({ k: 'b', i });
  const lv = (def.max || 1) > 1 ? ` (เลเวล ${pl.level})` : '';
  msg(`🔨 ${p ? p.name + ' ' : ''}สร้าง "${def.name}"${lv} สำเร็จ!`);
}

// ---------------------------------------------------------------- Pad interactions
function padAction(p, pad) {
  const st = G.st, cap = capacity();
  const fly = (i, a, b) => ev({ k: 'f', i, a, b });
  const pp = [pad.x, pad.z];
  const drop = (kind, key) => {
    if (st[key] < STOCK_MAX && takeItem(p, kind)) { st[key]++; fly(kind, p.id, pp); return true; }
    return false;
  };
  const pick = (kind, key) => {
    if (st[key] > 0 && p.carry.length < cap) { st[key]--; p.carry.push(kind); fly(kind, pp, p.id); return true; }
    return false;
  };
  const cash = key => {
    if (st[key] <= 0) return false;
    const a = Math.max(1, Math.ceil(st[key] / 8));
    st[key] -= a; G.money += a; p.stats.cash += a;
    ev({ k: '$', x: pad.x, z: pad.z, a, p: p.id });
    return true;
  };
  switch (pad.k) {
    case 'sawIn': return drop('L', 'sawIn');
    case 'sawOut': return pick('P', 'sawOut');
    case 'grillIn': return drop('M', 'grillIn');
    case 'grillOut': return pick('S', 'grillOut');
    case 'meatShop': return drop('S', 'meat');
    case 'woodShop': return drop('P', 'wood');
    case 'cashM': return cash('cashM');
    case 'cashW': return cash('cashW');
    case 'repair':
      if (G.coreHp < S.CORE.hp && takeItem(p, 'P')) {
        G.coreHp = Math.min(S.CORE.hp, G.coreHp + 40); fly('P', p.id, [S.CORE.x, S.CORE.z]); return true;
      }
      return false;
    case 'trash':
      if (!p.carry.length) return false;
      fly(p.carry.pop(), p.id, pp);
      return true;
    case 'plot': {
      const i = pad.plot, pl = G.plots[i], cost = S.costOf(i, pl.level);
      let did = false;
      if (pl.pp < cost.p && takeItem(p, 'P')) { pl.pp++; p.stats.build++; fly('P', p.id, pp); did = true; }
      else if (pl.pr < cost.r && takeItem(p, 'R')) { pl.pr++; p.stats.build++; fly('R', p.id, pp); did = true; }
      else if (pl.pc < cost.c && G.money > 0) {
        const a = Math.min(G.money, cost.c - pl.pc, Math.max(1, Math.ceil(cost.c / 25)));
        G.money -= a; pl.pc += a; p.stats.build += a; fly('$', p.id, pp); did = true;
      }
      if (pl.pp >= cost.p && pl.pr >= cost.r && pl.pc >= cost.c) completePlot(i, p);
      return did;
    }
  }
  return false;
}

// ---------------------------------------------------------------- Update systems
function updatePlayers(dt, pads) {
  const L = levels(), cap = S.STATS.cap(L), range = 10;
  for (const p of players.values()) {
    if (!p.conn) continue;
    if (p.dead) {
      p.respawn -= dt;
      if (p.respawn <= 0) { p.dead = false; p.hp = 100; p.x = S.SPAWN.x; p.z = S.SPAWN.z; p.tp++; }
      continue;
    }
    if (G.t - p.lastHit > 4) p.hp = Math.min(100, p.hp + 6 * dt);
    const still = (Date.now() - (p.movedAt || 0)) / 1000;

    // auto chop / mine (only after standing still a moment)
    p.chopT -= dt;
    if (p.chopT <= 0 && p.carry.length < cap && still >= S.STILL) {
      const ti = G.trees.findIndex(t => t.wood > 0 && d2(t.x, t.z, p.x, p.z) < 2.6 * 2.6);
      if (ti >= 0) {
        const t = G.trees[ti];
        t.wood--; if (t.wood <= 0) t.re = 45;
        p.carry.push('L'); p.stats.wood++;
        ev({ k: 'c', i: ti, p: p.id });
        p.chopT = S.STATS.chop(L);
      } else {
        const ri = G.rocks.findIndex(t => t.stone > 0 && d2(t.x, t.z, p.x, p.z) < (2.2 + t.s) ** 2);
        if (ri >= 0) {
          const t = G.rocks[ri];
          t.stone--; if (t.stone <= 0) t.re = 60;
          p.carry.push('R'); p.stats.stone++;
          ev({ k: 'r', i: ri, p: p.id });
          p.chopT = S.STATS.chop(L) * 1.3;
        }
      }
    }

    // auto shoot (monsters first)
    p.shootT -= dt;
    if (p.shootT <= 0) {
      const m = nearest(G.mons, p.x, p.z, range, o => !o.dead);
      const b = m ? null : nearest(G.boars, p.x, p.z, range - 1, o => !o.dead);
      const tg = m || b;
      if (tg) {
        p.r = Math.atan2(tg.x - p.x, tg.z - p.z);
        arrow(p.x, 1.4, p.z, tg);
        const dmg = S.STATS.bow(L);
        if (m) hurtMonster(m, dmg, p.id); else hurtBoar(b, dmg, { pid: p.id, carry: p.carry, stats: p.stats });
        p.shootT = 0.7;
      }
    }

    // pads
    p.xferT -= dt;
    if (p.xferT <= 0) {
      p.xferT = 0;
      let pad = null, bd = S.PAD_R * S.PAD_R;
      for (const pd of pads) { const d = d2(pd.x, pd.z, p.x, p.z); if (d < bd) { bd = d; pad = pd; } }
      if (pad && still >= S.stillNeeded(pad.k) && padAction(p, pad)) p.xferT = pad.k === 'plot' ? 0.07 : 0.1;
    }
  }
}

function updateStations(dt) {
  const st = G.st, L = levels();
  const proc = (key, from, to, interval) => {
    if (st[from] > 0 && st[to] < STOCK_MAX) {
      G.tm[key] += dt;
      if (G.tm[key] >= interval) { G.tm[key] -= interval; st[from]--; st[to]++; }
    } else G.tm[key] = 0;
  };
  if (built('saw')) proc('saw', 'sawIn', 'sawOut', S.STATS.saw(L));
  if (built('grill')) proc('grill', 'grillIn', 'grillOut', S.STATS.grill(L));
}

function updateVillagers(dt) {
  const night = curSeg().night, nb = G.plots.filter(p => p.level > 0).length;
  for (const key of ['meat', 'wood']) {
    const sh = SHOPS[key];
    if (!built(sh.plot)) continue;
    const tk = 'v' + key;
    G.tm[tk] -= dt;
    if (!night && G.tm[tk] <= 0 && G.q[key].length < 8) {
      G.tm[tk] = Math.max(1.6, 5.5 - 0.15 * nb) / Math.min(2.5, 1 + 0.3 * (online().length - 1)) * rnd(0.7, 1.3);
      const day = curSeg().day;
      const v = { id: G.id++, shop: key, x: key === 'meat' ? 2 : -2, z: 78, r: Math.PI, st: 'q', bt: 0.3, got: 0,
        want: key === 'meat' ? rint(1, 2 + Math.min(3, day)) : rint(2, 3 + day), col: rint(0, 7), ex: key === 'meat' ? 3 : -3,
        vip: Math.random() < 0.15 };
      G.vils.push(v); G.q[key].push(v);
    }
  }
  for (const v of G.vils) {
    const sh = SHOPS[v.shop];
    if (v.st === 'q') {
      const i = G.q[v.shop].indexOf(v), tx = sh.x, tz = 10.8 + i * 1.3;
      const at = moveTo(v, tx, tz, 0.05, dt, 3.4);
      if (i === 0 && at) {
        v.r = Math.PI;
        v.bt -= dt;
        if (v.bt <= 0 && G.st[sh.stock] > 0) {
          const price = S.PRICE[sh.item] * (v.vip ? 2 : 1);
          G.st[sh.stock]--; v.got++; G.st[sh.cash] += price; G.earned += price; v.bt = 0.3;
          ev({ k: 'f', i: sh.item, a: [sh.x, 8.6], b: pos(v) });
          if (v.got >= v.want) { v.st = 'l'; G.q[v.shop].shift(); ev({ k: 'e', x: r1(v.x), z: r1(v.z), s: v.vip ? '🤑' : '😊' }); }
        }
      }
    } else {
      moveTo(v, v.ex, 79, 0.5, dt, 3.4);
      if (v.z > 77) v.dead = true;
    }
  }
}

function updateWorkers(dt) {
  const st = G.st;
  for (const w of G.workers) {
    if (w.type === 'lumber') {
      if (w.st === 'seek') {
        if (!w.tgt || w.tgt.wood <= 0) w.tgt = nearest(G.trees, w.x, w.z, 999, t => t.wood > 0);
        const t = w.tgt;
        if (t && moveTo(w, t.x, t.z, 1.6, dt, 4)) {
          w.t -= dt;
          if (w.t <= 0) {
            w.t = 0.8; t.wood--; w.carry.push('L');
            ev({ k: 'c', i: G.trees.indexOf(t), p: 0 });
            if (t.wood <= 0) { t.re = 45; w.tgt = null; }
            if (w.carry.length >= 8) w.st = 'deliver';
          }
        }
      } else if (moveTo(w, -12, -1.5, 0.6, dt, 4)) {
        w.t -= dt;
        if (w.t <= 0) {
          w.t = 0.1;
          if (w.carry.length && st.sawIn < STOCK_MAX) { w.carry.pop(); st.sawIn++; ev({ k: 'f', i: 'L', a: pos(w), b: [-12, -1.5] }); }
          else if (!w.carry.length) w.st = 'seek';
        }
      }
    } else if (w.type === 'hunter') {
      if (w.st === 'seek') {
        if (!w.tgt || w.tgt.dead) w.tgt = nearest(G.boars, w.x, w.z, 999, b => !b.dead);
        const b = w.tgt;
        if (b && moveTo(w, b.x, b.z, 7, dt, 4.2)) {
          w.t -= dt;
          if (w.t <= 0) {
            w.t = 1.1; w.r = Math.atan2(b.x - w.x, b.z - w.z);
            arrow(w.x, 1.4, w.z, b);
            hurtBoar(b, 15, w);
            if (w.carry.length >= 6) w.st = 'deliver';
          }
        }
      } else if (moveTo(w, 8, -1.5, 0.6, dt, 4.2)) {
        w.t -= dt;
        if (w.t <= 0) {
          w.t = 0.1;
          if (w.carry.length && st.grillIn < STOCK_MAX) { w.carry.pop(); st.grillIn++; ev({ k: 'f', i: 'M', a: pos(w), b: [8, -1.5] }); }
          else if (!w.carry.length) w.st = 'seek';
        }
      }
    } else if (w.type === 'runner') {
      if (w.st !== 'deliver') {
        // choose a job (planks keep a reserve of 10 for building)
        if (!w.tgt) {
          if (st.grillOut > 0) w.tgt = { x: 12, z: -1.5, key: 'grillOut', item: 'S', reserve: 0 };
          else if (built('wood') && st.sawOut > 10) w.tgt = { x: -8, z: -1.5, key: 'sawOut', item: 'P', reserve: 10 };
        }
        const job = w.tgt;
        if (!job) { moveTo(w, 0, 6.5, 0.3, dt, 4.5); continue; }
        if (moveTo(w, job.x, job.z, 0.6, dt, 4.5)) {
          w.t -= dt;
          if (w.t <= 0) {
            w.t = 0.1;
            if (st[job.key] > job.reserve && w.carry.length < 8) { st[job.key]--; w.carry.push(job.item); ev({ k: 'f', i: job.item, a: [job.x, job.z], b: pos(w) }); }
            else { w.tgt = null; if (w.carry.length) w.st = 'deliver'; }
          }
        }
      } else if (!w.carry.length) {
        w.st = 'seek';
      } else {
        const meat = w.carry[0] === 'S';
        const tx = meat ? 7 : -7, tz = 6.2, key = meat ? 'meat' : 'wood';
        if (moveTo(w, tx, tz, 0.6, dt, 4.5)) {
          w.t -= dt;
          if (w.t <= 0) {
            w.t = 0.1;
            if (st[key] < STOCK_MAX) { const it = w.carry.pop(); st[key]++; ev({ k: 'f', i: it, a: pos(w), b: [tx, tz] }); }
          }
        }
      }
    } else if (w.type === 'cashier') {
      if (moveTo(w, 0, 7.4, 0.2, dt, 4)) {
        w.r = Math.PI;
        w.t -= dt;
        if (w.t <= 0) {
          w.t = 0.15;
          for (const [key, x] of [['cashM', 10.4], ['cashW', -10.4]]) {
            if (st[key] > 0) {
              const a = Math.max(1, Math.ceil(st[key] / 6));
              st[key] -= a; G.money += a;
              ev({ k: '$', x, z: 7.4, a });
            }
          }
        }
      }
    }
  }
}

function updateBoars(dt) {
  const want = Math.min(26, 10 + 2 * curSeg().day + online().length);
  G.tm.boar -= dt;
  if (G.tm.boar <= 0) { G.tm.boar = 2.5; if (G.boars.length < want) spawnBoar(false); }
  for (const b of G.boars) {
    if (b.ag) {
      const p = players.get(b.ag);
      b.agT -= dt;
      if (!p || !p.conn || p.dead || b.agT <= 0) b.ag = 0;
      else {
        if (moveTo(b, p.x, p.z, 1.2, dt, 4.3)) {
          b.atkT -= dt;
          if (b.atkT <= 0) { b.atkT = 1.2; hurtPlayer(p, 6); }
        }
        continue;
      }
    }
    b.wt -= dt;
    if (b.wt <= 0) {
      b.wt = rnd(3, 8);
      const a = Math.random() * Math.PI * 2, r = rnd(33, 70);
      b.tx = Math.cos(a) * r; b.tz = Math.sin(a) * r;
      if (d2(b.tx, b.tz, b.x, b.z) > 20 * 20) { b.tx = b.x + rnd(-10, 10); b.tz = b.z + rnd(-10, 10); }
    }
    moveTo(b, b.tx, b.tz, 0.3, dt, 1.4);
    const rr = Math.hypot(b.x, b.z);
    if (rr < 31) { b.x *= 31 / rr; b.z *= 31 / rr; b.wt = 0; }
  }
}

function updateMonsters(dt) {
  // spawn schedule
  if (G.spawnList.length) {
    G.spawnList = G.spawnList.filter(s => { if (G.t >= s.at) { spawnMonster(s.type); return false; } return true; });
  }
  const walls = [], towers = [];
  G.plots.forEach((pl, i) => {
    if (pl.level <= 0) return;
    const def = S.PLOTS[i];
    if (def.kind === 'wall') walls.push({ i, def, pl });
    else if (def.kind === 'tower' || def.kind === 'cannon') towers.push({ i, def, pl });
  });
  const inner = S.WALL_R * Math.cos(Math.PI / 8);
  const cx = S.CORE.x, cz = S.CORE.z, live = online();

  for (const m of G.mons) {
    if (m.dead) continue;
    m.atkT -= dt;
    const attack = fn => { if (m.atkT <= 0) { m.atkT = 1; fn(); } };
    const hitStruct = s => attack(() => {
      s.pl.hp -= m.dmg;
      if (s.pl.hp <= 0) {
        // a stone wall/tower crumbles back to wood (at low hp); a wooden one is gone
        s.pl.level--; s.pl.pc = 0; s.pl.pp = 0; s.pl.pr = 0;
        s.pl.hp = s.pl.level > 0 ? S.hpOf(s.i, s.pl.level) * 0.3 : 0;
        ev({ k: 'd', x: r1(s.def.x), z: r1(s.def.z), t: 'struct' });
        msg(`💥 ${s.def.name} ถูกทำลาย!`);
      }
    });

    // walls block monsters that are outside the ring
    let blocked = null;
    for (const w of walls) {
      const a = w.def.seg;
      if (segDist(m.x, m.z, a[0], a[1], a[2], a[3]) < m.rad + 1.1) {
        const ang = Math.atan2(w.def.z, w.def.x);
        if (m.x * Math.cos(ang) + m.z * Math.sin(ang) > inner - 1.5) { blocked = w; break; }
      }
    }
    if (!blocked) for (const t of towers) if (d2(m.x, m.z, t.def.x, t.def.z) < (m.rad + 1.7) ** 2) { blocked = t; break; }
    if (blocked) {
      m.r = Math.atan2(blocked.def.x - m.x, blocked.def.z - m.z);
      hitStruct(blocked);
      continue;
    }

    m.rt -= dt;
    if (m.rt <= 0) {
      m.rt = 0.4;
      const p = nearest(live, m.x, m.z, m.type === 'boss' ? 11 : 8, o => !o.dead);
      m.tgt = p ? p.id : 0;
    }
    const p = m.tgt && players.get(m.tgt);
    if (p && p.conn && !p.dead) {
      if (moveTo(m, p.x, p.z, m.rad + 0.7, dt, m.spd)) attack(() => hurtPlayer(p, m.dmg));
    } else if (moveTo(m, cx, cz, S.CORE.r + m.rad + 0.3, dt, m.spd)) {
      attack(() => { G.coreHp -= m.dmg; ev({ k: 'ch', d: m.dmg }); });
    }
  }

  // separation
  const ms = G.mons;
  for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) {
    const a = ms[i], b = ms[j], min = (a.rad + b.rad) * 0.9;
    const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
    if (d > 0.001 && d < min) {
      const push = (min - d) / 2, nx = dx / d, nz = dz / d;
      a.x -= nx * push; a.z -= nz * push; b.x += nx * push; b.z += nz * push;
    }
  }
}

function updateDefenses(dt) {
  const day = curSeg().day;
  G.plots.forEach((pl, i) => {
    const def = S.PLOTS[i];
    if ((def.kind !== 'tower' && def.kind !== 'cannon') || pl.level <= 0) return;
    pl.cd -= dt;
    if (pl.cd > 0) return;
    if (def.kind === 'tower') {
      const m = nearest(G.mons, def.x, def.z, pl.level > 1 ? 19 : 16, o => !o.dead);
      if (m) {
        pl.cd = pl.level > 1 ? 0.55 : 0.8;
        arrow(def.x, 5, def.z, m);
        hurtMonster(m, (20 + 4 * day) * (pl.level > 1 ? 1.6 : 1), 0);
      }
    } else {
      const m = nearest(G.mons, def.x, def.z, 20, o => !o.dead && d2(o.x, o.z, def.x, def.z) > 9);
      if (m) {
        pl.cd = 2.2;
        const flight = 0.6;
        // lead the target a little
        const tx = m.x + Math.sin(m.r) * m.spd * flight * 0.7, tz = m.z + Math.cos(m.r) * m.spd * flight * 0.7;
        ev({ k: 'k', f: [r1(def.x), 3, r1(def.z)], t: [r1(tx), r1(tz)], d: flight });
        G.pending.push({ at: G.t + flight, x: tx, z: tz, r: 3.4, dmg: 50 + 6 * day });
      }
    }
  });
  // cannon impacts
  if (G.pending.length) {
    G.pending = G.pending.filter(h => {
      if (G.t < h.at) return true;
      ev({ k: 'x', x: r1(h.x), z: r1(h.z) });
      for (const m of G.mons) if (!m.dead && d2(m.x, m.z, h.x, h.z) < (h.r + m.rad) ** 2) hurtMonster(m, h.dmg, 0);
      return false;
    });
  }
  // town hall shoots too
  G.tm.core -= dt;
  if (G.tm.core <= 0) {
    const m = nearest(G.mons, S.CORE.x, S.CORE.z, 13, o => !o.dead);
    if (m) { G.tm.core = 0.9; arrow(S.CORE.x, 6, S.CORE.z, m); hurtMonster(m, 20 + 3 * day, 0); }
  }
}

function updateTrees(dt) {
  for (const t of G.trees) {
    if (t.wood > 0) continue;
    t.re -= dt;
    if (t.re <= 0 && ![...players.values()].some(p => d2(p.x, p.z, t.x, t.z) < 9)) t.wood = t.max;
  }
  for (const t of G.rocks) {
    if (t.stone > 0) continue;
    t.re -= dt;
    if (t.re <= 0 && ![...players.values()].some(p => d2(p.x, p.z, t.x, t.z) < 12)) t.stone = t.max;
  }
}

function expireOffline() {
  const now = Date.now();
  let removed = false;
  for (const p of players.values()) {
    if (p.conn || now - p.leftAt < GRACE * 1000) continue;
    players.delete(p.id); removed = true;
    msg(`🚪 ${p.name} ออกจากเกม`);
  }
  if (removed && players.size === 0) resetWorld();
}

function tick() {
  tickN++;
  if (tickN % TICK === 0) expireOffline();
  if (!online().length) return; // nobody connected: pause so a lone player who refreshes loses nothing
  for (let k = 0; k < SPEED && G.phase === 'play'; k++) {
    G.t += DT;
    while (G.segIdx < segs.length - 1 && G.t >= segs[G.segIdx].end) {
      G.segIdx++;
      const s = segs[G.segIdx];
      if (s.night) startNight(s.day); else dawn(s.day);
    }
    const pads = S.getPads(levels());
    updatePlayers(DT, pads);
    updateStations(DT);
    updateVillagers(DT);
    updateWorkers(DT);
    updateBoars(DT);
    updateMonsters(DT);
    updateDefenses(DT);
    updateTrees(DT);
    G.boars = G.boars.filter(b => !b.dead);
    G.mons = G.mons.filter(m => !m.dead);
    G.vils = G.vils.filter(v => !v.dead);
    if (G.coreHp <= 0) { G.coreHp = 0; endGame(false); }
    else if (G.t >= G.total) endGame(true);
  }
  if (tickN % 2 === 0) broadcast(snapshot());
}

function snapshot() {
  const s = curSeg(), st = G.st;
  const out = JSON.stringify({
    t: 's', ph: G.phase, tm: r1(G.t), tt: G.total, days: G.days,
    day: s.day, n: s.night ? 1 : 0, se: s.end, $: G.money, er: G.earned, ch: Math.round(G.coreHp),
    P: online().map(p => [p.id, p.name, p.color, r1(p.x), r1(p.z), r2(p.r), Math.round(p.hp), p.dead ? Math.ceil(p.respawn) : 0, p.carry.join(''), p.tp, r1(Math.max(0, p.skillT - G.t))]),
    T: G.trees.map(t => t.wood),
    R: G.rocks.map(t => t.stone),
    po: G.portals,
    A: G.boars.map(b => [b.id, r1(b.x), r1(b.z), r2(b.r), Math.round(b.hp / b.max * 100)]),
    M: G.mons.map(m => [m.id, m.type, r1(m.x), r1(m.z), r2(m.r), Math.round(m.hp / m.max * 100)]),
    V: G.vils.map(v => [v.id, r1(v.x), r1(v.z), r2(v.r), v.want, v.got, v.col, v.shop === 'meat' ? 0 : 1, v.st === 'q' ? G.q[v.shop].indexOf(v) : -1, v.vip ? 1 : 0]),
    W: G.workers.map(w => [w.id, w.type, r1(w.x), r1(w.z), r2(w.r), w.carry.join('')]),
    S: [st.sawIn, st.sawOut, st.grillIn, st.grillOut, st.meat, st.wood, st.cashM, st.cashW],
    B: G.plots.map(p => [p.level, p.pc, p.pp, Math.round(p.hp), p.pr]),
    ev: G.ev, res: G.result,
  });
  G.ev = [];
  return out;
}

function broadcast(str) { for (const p of players.values()) if (p.conn) p.conn.send(str); }

// ---------------------------------------------------------------- Connections
function onConnect(conn) {
  let me = null;
  conn.onmessage = raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'join' && !me) {
      const name = String(m.name || 'ผู้เล่น').slice(0, 14) || 'ผู้เล่น';
      const old = typeof m.token === 'string' && [...players.values()].find(p => p.token === m.token);
      if (old) {
        // reconnect: take back the same player (position, bag and stats kept)
        if (old.conn) { // still open elsewhere (another tab/device) — the newest connection wins
          const oc = old.conn; oc.onclose = null;
          oc.send(JSON.stringify({ t: 'kicked' })); oc.close();
        }
        me = old; me.conn = conn; me.name = name; me.leftAt = 0; me.tp++; me.movedAt = 0;
        msg(`🔄 ${me.name} กลับเข้าเกม`);
      } else {
        const id = nextPid++;
        const used = new Set([...players.values()].map(p => p.color));
        me = { id, conn, name, token: crypto.randomBytes(16).toString('hex'), color: COLORS.find(c => !used.has(c)) || COLORS[id % COLORS.length] };
        resetPlayer(me);
        players.set(id, me);
        msg(`👋 ${me.name} เข้าร่วมเกม`);
      }
      conn.send(JSON.stringify({ t: 'welcome', id: me.id, token: me.token }));
      conn.send(worldMsg());
      return;
    }
    if (!me || me.conn !== conn) return;
    if (m.t === 'p' && Array.isArray(m.d)) {
      const [x, z, r, tp] = m.d;
      if (me.dead || tp !== me.tp || !isFinite(x) || !isFinite(z)) return;
      const nx = Math.max(-S.MAP, Math.min(S.MAP, x)), nz = Math.max(-S.MAP, Math.min(S.MAP, z));
      if (d2(nx, nz, me.x, me.z) > 0.02 * 0.02) me.movedAt = Date.now();
      me.x = nx; me.z = nz;
      if (isFinite(r)) me.r = r;
    } else if (m.t === 'start') startGame(+m.days);
    else if (m.t === 'restart' && G.phase === 'end') resetWorld();
    else if (m.t === 'skill') useSkill(me);
    else if (m.t === 'emote' && EMOTES.includes(m.s)) ev({ k: 'e', x: r1(me.x), z: r1(me.z), s: m.s.slice(0, 4), p: me.id });
  };
  conn.onclose = () => {
    if (!me || me.conn !== conn) return;
    me.conn = null; me.leftAt = Date.now();
    msg(`📡 ${me.name} หลุดการเชื่อมต่อ — รอกลับเข้าเกม ${GRACE} วินาที`);
  };
}

// heartbeat: browsers answer pings automatically; a silent socket (phone asleep, Wi-Fi gone) is closed
// so the player is treated as disconnected instead of standing AFK in the game
setInterval(() => {
  for (const p of players.values()) {
    if (!p.conn) continue;
    if (Date.now() - p.conn.seen > 15000) p.conn.close();
    else p.conn.frame(9, Buffer.alloc(0));
  }
}, 5000);

resetWorld();
setInterval(tick, 1000 / TICK);

server.listen(PORT, () => {
  console.log(`\n🏕️  Wild Town server running!`);
  console.log(`   เครื่องนี้:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`   เพื่อนในวง LAN: http://${a.address}:${PORT}`);
  }
  console.log('');
});

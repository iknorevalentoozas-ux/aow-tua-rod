// Shared config between server (Node) and client (browser)
(function (root) {
  const WALL_R = 28;
  const WALL_NAMES = ['กำแพงตะวันออก', 'กำแพงตะวันออกเฉียงใต้', 'ประตูใต้', 'กำแพงตะวันตกเฉียงใต้',
    'กำแพงตะวันตก', 'กำแพงตะวันตกเฉียงเหนือ', 'กำแพงเหนือ', 'กำแพงตะวันออกเฉียงเหนือ'];

  const PLOTS = [
    { id: 'grill', kind: 'build', name: 'เตาย่าง', x: 10, z: -5, start: 1,
      pads: [{ k: 'grillIn', x: 8, z: -1.5 }, { k: 'grillOut', x: 12, z: -1.5 }] },
    { id: 'meat', kind: 'build', name: 'ร้านสเต็ก', x: 7, z: 8.6, start: 1,
      pads: [{ k: 'meatShop', x: 7, z: 6.2 }, { k: 'cashM', x: 10.4, z: 7.4 }] },
    { id: 'saw', kind: 'build', name: 'โรงเลื่อย', x: -10, z: -5, start: 1,
      pads: [{ k: 'sawIn', x: -12, z: -1.5 }, { k: 'sawOut', x: -8, z: -1.5 }] },
    { id: 'wood', kind: 'build', name: 'ร้านขายไม้', x: -7, z: 8.6, c: 40, p: 8,
      pads: [{ k: 'woodShop', x: -7, z: 6.2 }, { k: 'cashW', x: -10.4, z: 7.4 }] },
  ];

  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4, a0 = a - Math.PI / 8, a1 = a + Math.PI / 8;
    PLOTS.push({ id: 'w' + i, kind: 'wall', name: WALL_NAMES[i], max: 2,
      costs: [{ c: 20, p: 15 }, { c: 40, r: 12 }], hp: [600, 1600],
      x: Math.cos(a) * 25, z: Math.sin(a) * 25,
      seg: [Math.cos(a0) * WALL_R, Math.sin(a0) * WALL_R, Math.cos(a1) * WALL_R, Math.sin(a1) * WALL_R] });
  }
  [22.5, 157.5, 202.5, 337.5].forEach((deg, i) => {
    const a = deg * Math.PI / 180;
    PLOTS.push({ id: 't' + i, kind: 'tower', name: 'หอธนู', max: 2,
      costs: [{ c: 80, p: 25 }, { c: 120, r: 20 }], hp: [400, 900],
      x: Math.cos(a) * 21, z: Math.sin(a) * 21 });
  });
  [[-8, -19.4], [8, -19.4], [-13, 21], [13, 21]].forEach(([x, z], i) => {
    PLOTS.push({ id: 'k' + i, kind: 'cannon', name: 'ปืนใหญ่', costs: [{ c: 150, r: 25 }], hp: 700, x, z });
  });

  PLOTS.push(
    { id: 'h_lumber', kind: 'hire', worker: 'lumber', name: 'จ้างคนตัดไม้', x: -15, z: 1, c: 80, max: 3, grow: 1.8 },
    { id: 'h_hunter', kind: 'hire', worker: 'hunter', name: 'จ้างนายพราน', x: 15, z: 1, c: 100, max: 3, grow: 1.8 },
    { id: 'h_runner', kind: 'hire', worker: 'runner', name: 'จ้างคนส่งของ', x: -14, z: -12, c: 120, max: 2, grow: 2 },
    { id: 'h_cash', kind: 'hire', worker: 'cashier', name: 'จ้างแคชเชียร์', x: 14, z: -12, c: 60, max: 1 },
    { id: 'up_bag', kind: 'up', key: 'bag', name: 'กระเป๋าใหญ่ขึ้น', x: -3.6, z: -12, c: 25, max: 5, grow: 1.7 },
    { id: 'up_speed', kind: 'up', key: 'speed', name: 'รองเท้าวิ่งไว', x: 0, z: -12, c: 30, max: 5, grow: 1.7 },
    { id: 'up_bow', kind: 'up', key: 'bow', name: 'ธนูแรงขึ้น', x: 3.6, z: -12, c: 40, max: 5, grow: 1.75 },
    { id: 'up_axe', kind: 'up', key: 'axe', name: 'ขวาน/อีเต้อคม', x: -3.6, z: -15.6, c: 30, max: 5, grow: 1.7 },
    { id: 'up_grill', kind: 'up', key: 'grill', name: 'เตาไฟแรง', x: 0, z: -15.6, c: 50, max: 4, grow: 1.8 },
    { id: 'up_saw', kind: 'up', key: 'saw', name: 'ใบเลื่อยคม', x: 3.6, z: -15.6, c: 50, max: 4, grow: 1.8 },
  );

  const PI = {};
  PLOTS.forEach((p, i) => { PI[p.id] = i; });

  function costOf(i, level) {
    const p = PLOTS[i];
    if (p.costs) {
      const c = p.costs[Math.min(level, p.costs.length - 1)];
      return { c: c.c || 0, p: c.p || 0, r: c.r || 0 };
    }
    const g = Math.pow(p.grow || 1, level);
    return { c: Math.round((p.c || 0) * g), p: Math.round((p.p || 0) * g), r: Math.round((p.r || 0) * g) };
  }
  function hpOf(i, level) {
    const h = PLOTS[i].hp;
    if (!h) return 0;
    return Array.isArray(h) ? h[Math.max(0, Math.min(level, h.length) - 1)] : h;
  }

  function lvl(levels, key) { const i = PI['up_' + key]; return i == null ? 0 : levels[i] || 0; }

  const STATS = {
    cap: L => 10 + 5 * lvl(L, 'bag'),
    speed: L => 6 + 0.6 * lvl(L, 'speed'),
    chop: L => 0.5 * Math.pow(0.8, lvl(L, 'axe')),
    bow: L => 12 + 7 * lvl(L, 'bow'),
    skill: L => 40 + 10 * lvl(L, 'bow'),
    grill: L => 1.2 * Math.pow(0.72, lvl(L, 'grill')),
    saw: L => 0.8 * Math.pow(0.72, lvl(L, 'saw')),
  };
  const SKILL_CD = 8, SKILL_R = 5.5;
  // seconds a player must stand still before auto-actions kick in (walking past does nothing)
  const STILL = 0.35, STILL_BUILD = 0.7;

  // All active pads given current plot levels
  function getPads(levels) {
    const out = [{ k: 'repair', x: 0, z: 2.8 }, { k: 'trash', x: -3.8, z: 2.8 }];
    PLOTS.forEach((pl, i) => {
      const L = levels[i] || 0, max = pl.max || 1;
      const reqOk = !pl.req || (levels[PI[pl.req]] || 0) > 0;
      if (L > 0 && pl.pads) pl.pads.forEach(pd => out.push({ k: pd.k, x: pd.x, z: pd.z, plot: i }));
      if (L < max && reqOk) out.push({ k: 'plot', x: pl.x, z: pl.z, plot: i });
    });
    return out;
  }

  const MONSTERS = {
    goblin: { name: 'ก็อบลิน', hp: 45, spd: 3.2, dmg: 10, r: 0.6, reward: 3 },
    wolf: { name: 'หมาป่าเงา', hp: 35, spd: 5.2, dmg: 7, r: 0.6, reward: 3 },
    ogre: { name: 'ยักษ์', hp: 260, spd: 2.0, dmg: 35, r: 1.1, reward: 15 },
    boss: { name: 'ราชาปีศาจ', hp: 2400, spd: 1.6, dmg: 70, r: 2.0, reward: 200 },
  };

  const SHARED = {
    MAP: 74, WALL_R, PAD_R: 1.7,
    CORE: { x: 0, z: -2, r: 3, hp: 1500 },
    SPAWN: { x: 0, z: 5 },
    PRICE: { S: 8, P: 4 },
    DAY: 90, FIRST_DAY: 120, NIGHT: 60,
    PONDS: [{ x: -46, z: 38, r: 7 }, { x: 50, z: -40, r: 6 }],
    PLOTS, PI, costOf, hpOf, getPads, STATS, MONSTERS, SKILL_CD, SKILL_R, STILL, STILL_BUILD,
    stillNeeded: k => (k === 'plot' || k === 'trash') ? STILL_BUILD : STILL,
    ITEMS: {
      L: { name: 'ไม้ซุง', icon: '🪵', color: 0x8b5a2b },
      M: { name: 'เนื้อดิบ', icon: '🥩', color: 0xe05a5a },
      P: { name: 'ไม้แผ่น', icon: '🪚', color: 0xe8c07a },
      S: { name: 'สเต็ก', icon: '🍖', color: 0x8a4a1c },
      R: { name: 'หิน', icon: '🪨', color: 0x9aa0a6 },
    },
    dirName(x, z) {
      const d = (Math.atan2(z, x) * 180 / Math.PI + 360) % 360;
      return ['ตะวันออก', 'ตะวันออกเฉียงใต้', 'ใต้', 'ตะวันตกเฉียงใต้', 'ตะวันตก', 'ตะวันตกเฉียงเหนือ', 'เหนือ', 'ตะวันออกเฉียงเหนือ'][Math.round(d / 45) % 8];
    },
    // Day/night segments for a game of N days
    segments(days) {
      const segs = []; let t = 0;
      for (let d = 1; d <= days; d++) {
        const dl = d === 1 ? SHARED.FIRST_DAY : SHARED.DAY;
        segs.push({ day: d, night: false, start: t, end: t + dl }); t += dl;
        segs.push({ day: d, night: true, start: t, end: t + SHARED.NIGHT }); t += SHARED.NIGHT;
      }
      return segs;
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SHARED;
  else root.SHARED = SHARED;
})(this);

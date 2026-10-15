// =====================================================================
//  Simulateur d'équilibrage : fait tourner la vraie logique de server.js, sans réseau, en accéléré
//  (une partie de 15 minutes se joue en quelques secondes).
//    node tools/sim.js games [niveau] [nombre]    parties IA contre IA
//    node tools/sim.js duels                      combats à or égal entre troupes, en plein champ
//    node tools/sim.js siege                      temps pour briser un château selon l'engin et les défenses
//  Les règles viennent de server.js : modifier l'équilibrage là-bas, puis relancer les mesures ici.
// =====================================================================
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');

// charge server.js dans un bac à sable : faux serveur HTTP/WebSocket, pas de minuteries, journal muet
function load({ env = {}, patch = s => s } = {}) {
    let src = patch(fs.readFileSync(SERVER, 'utf8'));
    src += `\n;globalThis.__sim = { get game() { return game; }, get players() { return players; },
        UNITS, COUNTERS, DEFENSES, MAGES, LEVELS, TICK, CASTLE_HP, KING_HP, PATH, TYPES, TEAMS,
        step, newGame, startGame, createRoom, withRoom, enqueue, buyDefense, buildMage, castSpell, setOrder,
        spawnUnit, toWorld, damageCastle, enemyOf };`;
    const fakeHttp = { createServer: () => ({ listen() {}, close() {} }) };
    class FakeWSS { on() {} get clients() { return []; } }
    const ctx = {
        require: m => (m === 'http' ? fakeHttp : m === 'ws' ? { WebSocketServer: FakeWSS } : require(m)),
        console: { log() {}, error: (...a) => console.error(...a) },
        process: { env, on() {}, exit() {} },
        setInterval() {}, setTimeout() {}, clearTimeout() {},
        __dirname: path.dirname(SERVER), Buffer, URLSearchParams,
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx, { filename: 'server.js' });
    const S = ctx.__sim;
    S.ctx = ctx;
    return S;
}

// une partie IA contre IA ; renvoie le déroulé
function playGame(S, { level = 'normal', levels = null, maxTime = 40 * 60, sample = 30 } = {}) {
    const room = S.createRoom({ name: 'sim', solo: true });
    const out = { timeline: [], spent: { red: {}, blue: {} } };
    S.withRoom(room, () => {
        S.newGame('waiting');
        S.game.ai = { red: true, blue: true };
        S.game.level = level;
        S.startGame();
        if (levels) S.game.levels = levels;
    });
    let t = 0, next = 0;
    S.withRoom(room, () => {
        const g = () => S.game;
        while (g().phase === 'playing' && t < maxTime) {
            S.step(S.TICK);
            t += S.TICK;
            if (t >= next) {
                next += sample;
                const units = { red: {}, blue: {} };
                for (const u of g().units) units[u.team][u.type] = (units[u.team][u.type] || 0) + 1;
                out.timeline.push({ t: Math.round(t), hp: { ...g().hp }, gold: { red: Math.round(g().gold.red), blue: Math.round(g().gold.blue) }, units, broken: { ...g().broken } });
            }
        }
        out.winner = g().winner;
        out.time = t;
        out.stats = JSON.parse(JSON.stringify(g().stats));
        out.def = JSON.parse(JSON.stringify(g().def));
        out.mage = JSON.parse(JSON.stringify(g().mage));
        out.hp = { ...g().hp };
        out.broken = { ...g().broken };
        out.brokenAt = out.timeline.find(s => s.broken.red || s.broken.blue)?.t ?? null;
    });
    S.rooms?.delete?.(room.id);
    return out;
}

// suivi des dépenses : on enveloppe les fonctions d'achat (les appels internes passent par l'objet global du bac à sable)
function trackSpending(S, sink) {
    const c = S.ctx;
    const wrap = (name, cost) => {
        const f = c[name];
        c[name] = function (...a) {
            const ok = f.apply(this, a);
            if (ok) { const [team, k] = name === 'castSpell' ? [a[0].team, a[1]] : a; sink(team, name, k, cost(k, team)); }
            return ok;
        };
    };
    wrap('enqueue', k => S.UNITS[k].cost);
    wrap('buyDefense', (k, team) => S.DEFENSES[k].levels[S.game.def[team][k]].cost);
    wrap('buildMage', k => S.MAGES[k].build);
    wrap('castSpell', k => S.MAGES[k].cost);
}

const pct = (a, b) => (b ? Math.round(a / b * 100) : 0) + ' %';
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

// ---------------------------------------------------------------- parties IA contre IA
function games(level = 'normal', n = 30, opts = {}) {
    const S = load(opts);
    const spend = { unit: {}, def: {}, mage: {}, spell: {} };
    let total = 0;
    trackSpending(S, (team, kind, k, cost) => {
        const cat = { enqueue: 'unit', buyDefense: 'def', buildMage: 'mage', castSpell: 'spell' }[kind];
        spend[cat][k] = (spend[cat][k] || 0) + cost;
        total += cost;
    });
    const res = [];
    for (let i = 0; i < n; i++) res.push(playGame(S, { level, ...opts.play }));
    const wins = { red: 0, blue: 0, none: 0 };
    for (const r of res) wins[r.winner || 'none']++;
    const times = res.filter(r => r.winner).map(r => r.time);
    const broken = res.map(r => r.brokenAt).filter(x => x != null);
    console.log(`\n=== ${n} parties IA ${level} contre IA ${level} ===`);
    console.log(`victoires : Crâne ${wins.red}, Lion ${wins.blue}, sans vainqueur (40 min) ${wins.none}`);
    console.log(`durée médiane ${mmss(median(times))} (min ${mmss(Math.min(...times))}, max ${mmss(Math.max(...times))}) ; premier pont-levis brisé vers ${mmss(median(broken))}`);
    const tl = res[0].timeline;
    const avgAt = (t, f) => { const v = res.map(r => r.timeline.find(s => s.t >= t)).filter(Boolean).map(f); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : '-'; };
    console.log('t      or Crâne  or Lion  troupes C/L   PV C/L');
    for (const t of [60, 120, 180, 300, 420, 600, 900, 1200]) {
        console.log(`${mmss(t).padEnd(6)} ${String(avgAt(t, s => s.gold.red)).padStart(8)} ${String(avgAt(t, s => s.gold.blue)).padStart(8)}   ${avgAt(t, s => Object.values(s.units.red).reduce((a, b) => a + b, 0))}/${avgAt(t, s => Object.values(s.units.blue).reduce((a, b) => a + b, 0))}`.padEnd(42) + `${avgAt(t, s => s.hp.red)}/${avgAt(t, s => s.hp.blue)}`);
    }
    const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
    console.log(`dépenses : troupes ${pct(sum(spend.unit), total)}, défenses ${pct(sum(spend.def), total)}, tours de mage ${pct(sum(spend.mage), total)}, sorts ${pct(sum(spend.spell), total)}`);
    console.log('  troupes : ' + Object.entries(spend.unit).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v, sum(spend.unit))}`).join(', '));
    const st = k => Math.round(res.reduce((a, r) => a + r.stats.red[k] + r.stats.blue[k], 0) / res.length / 2);
    console.log(`par camp et par partie : ${st('trained')} troupes formées, ${st('killed')} abattues, ${st('kingsFallen')} rois tombés, ${st('spells')} sorts, ${st('built')} constructions, ${st('earned')} or gagné`);
    return res;
}

// ---------------------------------------------------------------- combats à or égal (loin des châteaux)
function duels(budget = 600, reps = 12, opts = {}) {
    const S = load(opts);
    const types = S.TYPES.filter(t => S.UNITS[t].targetsUnits);
    console.log(`\n=== combats en plein champ, ${budget} pièces d'or de chaque côté (${reps} essais) : % de victoires de la ligne ===`);
    console.log(''.padEnd(10) + types.map(t => t.padStart(10)).join(''));
    const table = {};
    for (const a of types) {
        let line = a.padEnd(10);
        table[a] = {};
        for (const b of types) {
            let win = 0, left = 0;
            for (let r = 0; r < reps; r++) {
                const res = fight(S, a, b, budget);
                if (res.winner === 'red') { win++; left += res.leftValue; }
                else if (!res.winner) win += 0.5;
            }
            table[a][b] = win / reps;
            line += (Math.round(win / reps * 100) + ' %').padStart(10);
        }
        console.log(line);
    }
    return table;
}

// deux groupes face à face au milieu du terrain ; les tours sont loin
function fight(S, a, b, budget, mixB = null) {
    const room = S.createRoom({ name: 'duel', solo: true });
    let result;
    S.withRoom(room, () => {
        S.newGame('playing');
        S.game.ai = { red: false, blue: false };
        const g = S.game;
        // spec : un type ('archer') ou un mélange { infantry: 0.5, archer: 0.5 } (parts du budget) ; les tireurs se placent derrière
        const place = (team, spec) => {
            const mix = typeof spec === 'string' ? { [spec]: 1 } : spec;
            const list = [];
            let left = budget;
            for (const [type, share] of Object.entries(mix)) for (let k = 0; k < Math.floor(budget * share / S.UNITS[type].cost); k++) { list.push(type); left -= S.UNITS[type].cost; }
            // le reste de l'or (arrondis) est dépensé aussi, pour que tous les camps aient bien le même budget
            for (let added = true; added;) {
                added = false;
                for (const type of Object.keys(mix).sort((x, y) => S.UNITS[y].cost - S.UNITS[x].cost)) {
                    if (S.UNITS[type].cost <= left) { list.push(type); left -= S.UNITS[type].cost; added = true; break; }
                }
            }
            list.sort((x, y) => (S.UNITS[x].ranged ? 1 : 0) - (S.UNITS[y].ranged ? 1 : 0));
            for (let i = 0; i < list.length; i++) {
                const type = list[i], s = S.UNITS[type];
                const z = (team === 'red' ? -4 : 4) - (team === 'red' ? 1 : -1) * Math.floor(i / 6) * 1.2;
                g.units.push({ id: g.nextUnitId++, type, team, x: -3 + (i % 6) * 1.2, z, hp: s.hp, wp: 2, inside: 0, mz: 0, cd: Math.random() * 0.5,
                    state: 0, rot: 0, lane: -3 + (i % 6) * 1.2, nx: 0, lastHitBy: null });
            }
        };
        place('red', a); place('blue', b);
        // ordre de traitement mélangé (comme en partie, où les troupes des deux camps s'entremêlent dans la liste)
        for (let i = g.units.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [g.units[i], g.units[j]] = [g.units[j], g.units[i]]; }
        let t = 0;
        while (t < 120) {
            S.step(S.TICK); t += S.TICK;
            const red = g.units.filter(u => u.team === 'red'), blue = g.units.filter(u => u.team === 'blue');
            if (!red.length || !blue.length || red.every(u => Math.abs(u.z) > 15) && blue.every(u => Math.abs(u.z) > 15)) {
                const val = list => list.reduce((s, u) => s + S.UNITS[u.type].cost * u.hp / S.UNITS[u.type].hp, 0);
                result = { winner: !blue.length && red.length ? 'red' : !red.length && blue.length ? 'blue' : null, leftValue: val(red) - val(blue), t };
                break;
            }
        }
        if (!result) {
            const val = list => list.reduce((s, u) => s + S.UNITS[u.type].cost * u.hp / S.UNITS[u.type].hp, 0);
            const r = val(g.units.filter(u => u.team === 'red')), bl = val(g.units.filter(u => u.team === 'blue'));
            result = { winner: r > bl * 1.1 ? 'red' : bl > r * 1.1 ? 'blue' : null, leftValue: r - bl, t };
        }
    });
    return result;
}

// ---------------------------------------------------------------- sièges
// des engins (et leur escorte éventuelle) contre un château défendu, sans troupes adverses
function siege(opts = {}) {
    const S = load(opts);
    const setups = [
        ['aucune défense', {}],
        ['tours niv. 2', { towers: 1 }],
        ['tours 3 + huile 2', { towers: 2, oil: 2 }],
        ['tout au max', { towers: 2, oil: 2, barricade: 2 }],
    ];
    const attackers = [
        ['3 catapultes', [['catapult', 3]]],
        ['4 canons', [['cannon', 4]]],
        ['4 béliers', [['ram', 4]]],
        ['8 chevaliers', [['knight', 8]]],
        ['20 soldats', [['infantry', 20]]],
        ['12 archers', [['archer', 12]]],
    ];
    console.log(`\n=== siège : temps pour briser un château de ${S.CASTLE_HP} PV (porte baissée, sans défenseurs), pertes de l'assaillant ===`);
    console.log(''.padEnd(16) + setups.map(([n]) => n.padStart(22)).join(''));
    for (const [name, list] of attackers) {
        let line = name.padEnd(16);
        for (const [, def] of setups) {
            const room = S.createRoom({ name: 'siege', solo: true });
            let cell;
            S.withRoom(room, () => {
                S.newGame('playing');
                S.game.ai = { red: false, blue: false };
                const g = S.game;
                Object.assign(g.def.blue, def);
                if (def.barricade) g.defHp.blue.barricade = S.DEFENSES.barricade.levels[def.barricade].hp;
                for (const [type, n] of list) for (let i = 0; i < n; i++) {
                    S.spawnUnit('red', type, 'tent');
                    const u = g.units[g.units.length - 1];
                    u.z = -14 - i * 0.8; u.x = -4 + (i % 8); u.wp = 1;
                }
                const start = g.units.length;
                let t = 0;
                while (t < 600 && !g.broken.blue && g.units.length) { S.step(S.TICK); t += S.TICK; }
                cell = g.broken.blue ? `${mmss(t)} (-${start - g.units.length})` : `échec (${Math.round(g.hp.blue)} PV)`;
            });
            line += cell.padStart(22);
        }
        console.log(line);
    }
}

module.exports = { load, playGame, games, duels, fight, siege, trackSpending };

if (require.main === module) {
    const [cmd = 'games', ...args] = process.argv.slice(2);
    if (cmd === 'games') games(args[0] || 'normal', +(args[1] || 30));
    else if (cmd === 'duels') duels(+(args[0] || 600), +(args[1] || 12));
    else if (cmd === 'siege') siege();
}

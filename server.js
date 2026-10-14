// =====================================================================
//  Serveur du château fort multijoueur
//  - sert les fichiers du dossier public/
//  - WebSocket : synchronise les joueurs et simule la bataille
//    (le serveur fait autorité sur les unités, l'or, les PV des châteaux et des rois)
// =====================================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('404'); }
        // no-cache : le navigateur revérifie les fichiers à chaque chargement (pratique quand on modifie le code)
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(data);
    });
});


// ---------------------------------------------------------------- règles du jeu
// troupes de la planche : soldats, archers, chevaliers, canon, engin de siège
// prime = 50 % du coût : abattre l'ennemi aide, mais ne suffit pas à s'enrichir ; chaque troupe
// se forme dans un bâtiment (une file de 5 maximum par bâtiment), ce qui limite le rythme
const UNITS = {
    infantry: { name: 'Soldats',        icon: '🔱', cost: 25,  bounty: 13,  train: 3,  building: 'barracks', hp: 90,  speed: 2.3, dmg: 10, castleDmg: 6,  range: 1.8, cd: 0.9, aggro: 6, targetsUnits: true,  radius: 0.4 },
    archer:   { name: 'Archers',        icon: '🏹', cost: 45,  bounty: 23,  train: 5,  building: 'barracks', hp: 60,  speed: 2.0, dmg: 9,  castleDmg: 5,  range: 9,   cd: 1.4, aggro: 9, targetsUnits: true,  radius: 0.4, ranged: 'arrow' },
    knight:   { name: 'Chevalier',      icon: '🛡️', cost: 70,  bounty: 35,  train: 6,  building: 'barracks', hp: 220, speed: 2.0, dmg: 20, castleDmg: 10, range: 1.4, cd: 1.1, aggro: 7, targetsUnits: true,  radius: 0.45 },
    cannon:   { name: 'Canon',          icon: '💣', cost: 150, bounty: 75,  train: 9,  building: 'workshop', hp: 240, speed: 1.2, dmg: 0,  castleDmg: 55, range: 14,  cd: 3.5, aggro: 0, targetsUnits: false, radius: 1.0, ranged: 'ball' },
    catapult: { name: 'Engin de siège', icon: '🪨', cost: 200, bounty: 100, train: 10, building: 'workshop', hp: 180, speed: 1.1, dmg: 0,  castleDmg: 70, range: 30,  cd: 5.0, aggro: 0, targetsUnits: false, radius: 1.1, ranged: 'stone' },
};
const TYPES = Object.keys(UNITS);
const TEAMS = ['red', 'blue'];
const BUILDING_NAMES = ['barracks', 'workshop', 'tent'];
const CASTLE_HP = Number(process.env.CASTLE_HP) || 2500;   // CASTLE_HP=200 npm start : parties de test rapides
const START_GOLD = Number(process.env.START_GOLD) || 300;   // START_GOLD=3000 npm start : tester les achats
const INCOME = 10;           // or par seconde
const MAX_UNITS = 40;        // par équipe (troupes en vie + en formation)
const QUEUE_MAX = 5;         // par bâtiment
const TICK = 0.05;           // 20 Hz
// défenses achetées avec l'or (touches 6 à 9). Niveau 0 = pas encore construite (les tours, elles, existent déjà au niveau 0)
const DEFENSES = {
    towers: { name: 'Tours de garde', icon: '🏹', levels: [
        { dmg: 12, cd: 0.9, range: 16, volley: 1 },
        { cost: 150, dmg: 18, cd: 0.7, range: 19, volley: 1 },
        { cost: 300, dmg: 24, cd: 0.55, range: 22, volley: 2 },          // les deux tours tirent ensemble
    ] },
    oil: { name: 'Huile bouillante', icon: '🔥', levels: [null,
        { cost: 200, dmg: 35, cd: 4, radius: 4.5 },
        { cost: 350, dmg: 55, cd: 3, radius: 5.5 },
    ] },
    barricade: { name: 'Barricades', icon: '🪵', levels: [null,
        { cost: 120, hp: 450, thorns: 0 },
        { cost: 220, hp: 900, thorns: 5 },                               // chevaux de frise : piquent ceux qui frappent
    ] },
    tent: { name: 'Chapiteau', icon: '🎪', levels: [null, { cost: 200, hp: 500 }] },
};
const DEF_KEYS = Object.keys(DEFENSES);
const STRUCTURE_BOUNTY = { barricade: 60, tent: 100 };
// le chapiteau (caserne hors les murs) et la ligne de barricades, dans le repère local du château
const TENT = { pos: [-7.5, 17.5], door: [-4.9, 17.5], r: 2.4 };
const BARRICADE = { z: 14.2, half: 4.6 };
const GATE_FRONT_Z = 7.8;      // au-delà, on est dehors, devant la façade

// tours de mage : bâties derrière le château, indestructibles, ignorées par les troupes ;
// chacune débloque un sort qui coûte de l'or à chaque lancer et a son temps de recharge
const MAGES = {
    potion:   { tower: "Tour de l'Alchimiste", spell: 'Potion de vie', icon: '🧪', key: 'R', build: 250, cost: 60,  cd: 30,  heal: 150, pos: [-6, -15.5] },
    fireball: { tower: 'Tour du Pyromancien',  spell: 'Boule de feu',  icon: '☄️', key: 'T', build: 350, cost: 90,  cd: 14,  radius: 3.5, dmg: 90, structDmg: 150, pos: [6, -15.5] },
    dragon:   { tower: "Tour de l'Invocateur", spell: 'Dragon',        icon: '🐉', key: 'Y', build: 800, cost: 300, cd: 100, duration: 18, radius: 3.6, speed: 8, pos: [0, -17.5] },
};
const MAGE_KEYS = Object.keys(MAGES);
const MAGE_TOP = 11.5;         // hauteur d'où partent les sorts (balcon des tours de mage)
const DRAGON_Y = 8;
const PLAYER_DMG = 30, PLAYER_CD = 0.45;
const KING_HP = 300, KING_BOUNTY = 100, RESPAWN = 5, BOT_SPEED = 4;
// niveaux de l'IA (mode solo) : rythme de décision, bonus de revenu, réflexe de lever le pont-levis
const LEVELS = {
    easy:   { think: 2.4, income: 0.75, door: false },
    normal: { think: 1.2, income: 1,    door: true },
    hard:   { think: 0.6, income: 1.3,  door: true },
};

// Chaque château est construit dans son repère local : façade vers +z local.
// Rouge : centré en z = -40 (façade vers +z monde) ; Bleu : z = +40, tourné de 180°.
const dirOf = team => (team === 'red' ? 1 : -1);
const enemyOf = team => (team === 'red' ? 'blue' : 'red');
function toWorld(team, lx, ly, lz) {
    return team === 'red' ? [lx, ly, -40 + lz] : [-lx, ly, 40 - lz];
}
function toLocal(team, x, z) {
    return team === 'red' ? [x, z + 40] : [-x, 40 - z];
}
// dans la cour (entre les murs) d'un château ?
function isInCastle(team, x, z) {
    const [lx, lz] = toLocal(team, x, z);
    return Math.abs(lx) < 6.4 && lz > -6.4 && lz < 7.2;
}
// sur le socle d'un château (pour la hauteur approximative du roi de l'IA)
function onCastleBase(x, z) {
    return TEAMS.some(t => { const [lx, lz] = toLocal(t, x, z); return Math.abs(lx) < 11.6 && Math.abs(lz) < 11.1; });
}

// lieux dans le repère local d'un château (voir courtyardBuildings dans world.js)
const BUILDINGS = { barracks: [0, -3.4], workshop: [-2.4, 0] };   // portes de la caserne et de l'atelier
const MUSTER_Z = 4.6;          // les troupes attendent ici que le pont-levis soit baissé
const OUT_Z = 9.6;             // devant la porte, côté extérieur
const THRONE = [0, 1, 0.5];    // tapis du couronnement
const VAULT = [7, -7], VAULT_R = 2.1;

// chemin des unités, en coordonnée "f" (avance vers l'ennemi) : z monde = f * dir
const PATH = [
    { f: -21, mode: 'narrow' },   // bas de sa propre rampe
    { f: -14, mode: 'lane' },     // on se déploie
    { f: 14, mode: 'lane' },
    { f: 21, mode: 'narrow' },    // bas de la rampe ennemie
    { f: 30, mode: 'narrow' },    // devant la porte ennemie
];
// sommets des deux tours avant de chaque château (d'où partent les flèches de défense)
// rouge = château gris aux blasons, bleu = château sable à tête de lion
const TOWERS = {
    red: [[-7, 11.3, 7], [7, 15.3, 7]],
    blue: [[-7, 11.3, 7], [7, 12.3, 7]],
};

// ---------------------------------------------------------------- état (celui du salon en cours de traitement, voir withRoom)
// players : id -> { id, ws, team, x, y, z, ry, anim, atkCd, hp, dead, respawn, bot }
// (le roi de l'IA est un "joueur" sans connexion, avec bot = true)
let players = new Map();
let nextPlayerId = 1;
let game;

function newGame(phase = 'waiting') {
    game = {
        phase,                                   // waiting | playing | over
        winner: null,
        gold: { red: START_GOLD, blue: START_GOLD },
        hp: { red: CASTLE_HP, blue: CASTLE_HP },
        door: { red: true, blue: true },         // true = pont-levis baissé
        broken: { red: false, blue: false },     // château à 0 PV : pont-levis bloqué baissé
        queue: { red: { barracks: [], workshop: [], tent: [] }, blue: { barracks: [], workshop: [], tent: [] } },
        ai: { red: false, blue: false },
        level: 'normal',
        aiPlan: { red: null, blue: null },
        aiTimer: { red: 0, blue: 0 },
        towerCd: { red: 0, blue: 0 },
        towerSide: { red: 1, blue: 1 },
        def: { red: { towers: 0, oil: 0, barricade: 0, tent: 0 }, blue: { towers: 0, oil: 0, barricade: 0, tent: 0 } },
        defHp: { red: { barricade: 0, tent: 0 }, blue: { barricade: 0, tent: 0 } },
        oilCd: { red: 0, blue: 0 },
        mage: { red: { potion: false, fireball: false, dragon: false }, blue: { potion: false, fireball: false, dragon: false } },
        spellCd: { red: { potion: 0, fireball: 0, dragon: 0 }, blue: { potion: 0, fireball: 0, dragon: 0 } },
        dragons: [],
        units: [],
        pending: [],                             // projectiles en vol
        nextUnitId: 1,
    };
}
let fx = [];

const rnd = (a, b) => a + Math.random() * (b - a);
const r2 = v => Math.round(v * 100) / 100;

function humans(team) {
    let n = 0;
    for (const p of players.values()) if (p.team === team && !p.bot) n++;
    return n;
}

function startGame() {
    const { ai, level } = game;
    newGame('playing');
    game.ai = { red: ai.red && !humans('red'), blue: ai.blue && !humans('blue') };
    game.level = level;
    for (const p of players.values()) crown(p, false);
    broadcast({ t: 'start' });
}

// ---------------------------------------------------------------- formation des troupes
function enqueue(team, type) {
    const s = UNITS[type];
    if (!s || game.phase !== 'playing') return false;
    const queues = game.queue[team];
    // soldats, archers et chevaliers vont à la file la plus courte entre la caserne et le chapiteau
    let q = queues[s.building];
    if (s.building === 'barracks' && game.def[team].tent && queues.tent.length <= queues.barracks.length) q = queues.tent;
    if (q.length >= QUEUE_MAX || game.gold[team] < s.cost) return false;
    const training = queues.barracks.length + queues.workshop.length + queues.tent.length;
    if (game.units.filter(u => u.team === team).length + training >= MAX_UNITS) return false;
    game.gold[team] -= s.cost;
    q.push({ type, left: s.train });
    return true;
}

function trainUnits(dt) {
    for (const t of TEAMS) {
        for (const b of BUILDING_NAMES) {
            const q = game.queue[t][b];
            if (!q.length) continue;
            q[0].left -= dt;
            if (q[0].left <= 0) spawnUnit(t, q.shift().type, b);
        }
    }
}

// la troupe sort de son bâtiment : dans la cour, elle attend que le pont-levis soit baissé ;
// au chapiteau, elle est déjà dehors et part directement au combat
function spawnUnit(team, type, building) {
    const out = building === 'tent';
    const [bx, bz] = out ? TENT.door : BUILDINGS[building];
    const [x, , z] = toWorld(team, bx + rnd(-0.4, 0.4), 0, bz + rnd(-0.2, 0.2));
    const s = UNITS[type];
    game.units.push({
        id: game.nextUnitId++, type, team, x, z,
        hp: s.hp, wp: 0, inside: out ? 0 : 2, mz: rnd(-1.4, 0.4), cd: rnd(0, 0.5), state: 0, rot: dirOf(team) > 0 ? 0 : Math.PI,
        lane: rnd(-9, 9), nx: rnd(-1.1, 1.1), lastHitBy: null,
    });
}

// point d'impact aléatoire sur le château d'une équipe
function castlePoint(team, spread) {
    if (spread === 'gate') return toWorld(team, rnd(-3, 3), rnd(2, 5), 7.8);
    return toWorld(team, rnd(-8, 8), rnd(3, 8), rnd(-6, 7.5));
}

function shoot(kind, from, to, dmg, target, attacker) {
    const dist = Math.hypot(to[0] - from[0], to[2] - from[2]);
    const dur = kind === 'stone' ? 1.0 + dist * 0.04 : kind === 'ball' ? 0.3 + dist * 0.025 : 0.25 + dist * 0.035;
    game.pending.push({ time: dur, dmg, target, attacker });
    fx.push({ k: kind, a: from.map(r2), b: to.map(r2), d: r2(dur) });
}

function damageUnit(u, dmg, byTeam) {
    u.hp -= dmg;
    u.lastHitBy = byTeam;
}

// à 0 PV, le château ne tombe pas : son pont-levis lâche et reste baissé pour de bon
function damageCastle(team, dmg) {
    if (game.phase !== 'playing' || game.broken[team]) return;
    game.hp[team] = Math.max(0, game.hp[team] - dmg);
    if (game.hp[team] <= 0) {
        game.broken[team] = true;
        game.door[team] = true;
        broadcast({ t: 'msg', text: `💥 Crac ! Les chaînes du pont-levis ${team === 'red' ? 'du Crâne' : 'du Lion'} ont cassé : il ne pourra plus jamais se relever !` });
    }
}

// ---------------------------------------------------------------- défenses
const DEF_MSG = {
    towers: (who, lv) => `🏹 Les tours ${who} sont renforcées (niveau ${lv + 1}) !`,
    oil: (who, lv) => lv === 1 ? `🔥 Un chaudron d'huile bouillante chauffe au-dessus de la porte ${who} !`
        : `🔥 Le chaudron ${who} déborde : l'huile est encore plus brûlante !`,
    barricade: (who, lv) => lv === 1 ? `🪵 Des barricades se dressent devant le pont-levis ${who} !`
        : `🪵 Les barricades ${who} se hérissent de pieux !`,
    tent: who => `🎪 Un chapiteau se dresse devant le château ${who} : des troupes s'y entraînent hors les murs !`,
};
const whoOf = team => (team === 'red' ? 'du Crâne' : 'du Lion');

function buyDefense(team, key) {
    const d = DEFENSES[key];
    if (!d || game.phase !== 'playing') return false;
    const next = d.levels[game.def[team][key] + 1];
    if (!next || game.gold[team] < next.cost) return false;
    game.gold[team] -= next.cost;
    game.def[team][key]++;
    if (next.hp) game.defHp[team][key] = next.hp;          // construit ou renforcé : remis à neuf
    broadcast({ t: 'msg', text: DEF_MSG[key](whoOf(team), game.def[team][key]) });
    return true;
}

// le chapiteau et les barricades ont des PV ; détruits, ils reviennent au niveau 0 (on peut les reconstruire)
function damageDefense(team, key, dmg, byTeam) {
    if (!game.def[team][key] || game.phase !== 'playing') return;
    game.defHp[team][key] -= dmg;
    if (game.defHp[team][key] > 0) return;
    game.def[team][key] = 0;
    game.defHp[team][key] = 0;
    game.gold[byTeam] += STRUCTURE_BOUNTY[key];
    if (key === 'tent') {                                   // les recrues du chapiteau rentrent à la caserne
        game.queue[team].barracks.push(...game.queue[team].tent);
        game.queue[team].barracks.splice(QUEUE_MAX + 2);
        game.queue[team].tent = [];
    }
    fx.push({ k: 'defDown', key, team });
    broadcast({ t: 'msg', text: key === 'tent' ? `🎪 Le chapiteau ${whoOf(team)} s'effondre !` : `🪵 Les barricades ${whoOf(team)} volent en éclats !` });
}

// position d'un point par rapport à la ligne de barricades d'un château
function nearBarricade(team, x, z, margin = 1.0) {
    const [lx, lz] = toLocal(team, x, z);
    return Math.abs(lx) < BARRICADE.half + 1 && lz > BARRICADE.z - 0.8 && lz < BARRICADE.z + margin;
}

// ---------------------------------------------------------------- tours de mage et sorts
function buildMage(team, key) {
    const m = MAGES[key];
    if (!m || game.phase !== 'playing' || game.mage[team][key] || game.gold[team] < m.build) return false;
    game.gold[team] -= m.build;
    game.mage[team][key] = true;
    broadcast({ t: 'msg', text: `🔮 La ${m.tower} s'élève derrière le château ${whoOf(team)} : ${m.icon} ${m.spell} !` });
    return true;
}

// sort lancé par un roi (x, z : point visé pour la boule de feu)
function castSpell(p, key, x, z) {
    const team = p.team, m = MAGES[key];
    if (!m || p.dead || game.phase !== 'playing' || !game.mage[team][key]) return false;
    if (game.spellCd[team][key] > 0 || game.gold[team] < m.cost) return false;
    if (key === 'potion') {
        if (p.hp >= KING_HP) return false;                       // inutile de gâcher une potion
        p.hp = Math.min(KING_HP, p.hp + m.heal);
        fx.push({ k: 'heal', pid: p.id, p: [r2(p.x), r2(p.y), r2(p.z)] });
    } else if (key === 'fireball') {
        if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z)) return false;
        x = Math.max(-40, Math.min(40, x)); z = Math.max(-62, Math.min(62, z));
        const from = toWorld(team, m.pos[0], MAGE_TOP, m.pos[1]);
        const dur = 0.35 + Math.hypot(x - from[0], z - from[2]) * 0.009;     // rapide : ~1 s pour traverser le terrain
        game.pending.push({ time: dur, target: { aoe: { x, z, team } }, attacker: team });
        fx.push({ k: 'fireball', a: from.map(r2), b: [r2(x), 0, r2(z)], d: r2(dur), r: m.radius });
    } else if (key === 'dragon') {
        const [dx, , dz] = toWorld(team, m.pos[0], 0, m.pos[1]);
        game.dragons.push({ id: game.nextUnitId++, team, x: dx, z: dz, ry: dirOf(team) > 0 ? 0 : Math.PI, t: m.duration, cd: 0, breath: false, orbit: 0 });
        broadcast({ t: 'msg', text: team === 'red' ? '🐉 Le Dragon des Ombres déploie ses ailes !' : '🐉 Le Dragon Royal prend son envol !' });
    }
    game.gold[team] -= m.cost;
    game.spellCd[team][key] = m.cd;
    return true;
}

// boule de feu qui touche le sol : brûle les troupes et les obstacles ennemis
function fireballHit({ x, z, team }) {
    const m = MAGES.fireball, enemy = enemyOf(team);
    for (const u of game.units) if (u.team === enemy && Math.hypot(u.x - x, u.z - z) < m.radius + UNITS[u.type].radius) damageUnit(u, m.dmg, team);
    burnStructures(enemy, x, z, m.radius, m.structDmg, team);
}
function burnStructures(enemy, x, z, radius, dmg, team) {
    if (game.def[enemy].tent) {
        const [tx, , tz] = toWorld(enemy, TENT.pos[0], 0, TENT.pos[1]);
        if (Math.hypot(tx - x, tz - z) < radius + TENT.r) damageDefense(enemy, 'tent', dmg, team);
    }
    if (game.def[enemy].barricade) {
        const [lx, lz] = toLocal(enemy, x, z);
        if (Math.abs(lx) < BARRICADE.half + radius && Math.abs(lz - BARRICADE.z) < radius + 0.5) damageDefense(enemy, 'barricade', dmg, team);
    }
}

// le dragon chasse les troupes ennemies une à une et les dévore dans les flammes ;
// il ne touche à aucune construction, et ses proies ne rapportent pas d'or
function updateDragons(dt) {
    for (const dg of game.dragons) {
        const m = MAGES.dragon, enemy = enemyOf(dg.team);
        dg.t -= dt;
        let goal;
        if (dg.t > 0) {
            // la troupe ennemie la plus proche, où qu'elle soit (même dans sa cour) ; sinon il tournoie au milieu du terrain
            let best = Infinity;
            for (const u of game.units) {
                if (u.team !== enemy || u.hp <= 0) continue;
                const d = Math.hypot(u.x - dg.x, u.z - dg.z);
                if (d < best) { best = d; goal = [u.x, u.z]; }
            }
            if (!goal) goal = [0, 0];
        } else {
            const home = toWorld(dg.team, 0, 0, -30);                // il rentre au nid, derrière son château
            goal = [home[0], home[2]];
        }
        const dx = goal[0] - dg.x, dz = goal[1] - dg.z, l = Math.hypot(dx, dz);
        if (l > 1.5) {
            const step = Math.min(l, m.speed * dt);
            dg.x += dx / l * step; dg.z += dz / l * step;
            dg.ry = Math.atan2(dx, dz);
        } else {
            dg.orbit += dt * 1.6;                                      // il tournoie au-dessus de sa proie
            dg.x = goal[0] + Math.cos(dg.orbit) * 1.4; dg.z = goal[1] + Math.sin(dg.orbit) * 1.4;
            dg.ry = dg.orbit + Math.PI;
        }
        // souffle de feu : toute troupe ennemie sous le dragon est anéantie (sans prime : lastHitBy effacé)
        dg.cd -= dt;
        if (dg.cd <= 0) dg.breath = false;
        if (dg.t > 0 && dg.cd <= 0) {
            dg.cd = 0.4;
            const hits = game.units.filter(u => u.team === enemy && u.hp > 0 && Math.hypot(u.x - dg.x, u.z - dg.z) < m.radius + UNITS[u.type].radius);
            for (const u of hits) { u.hp = 0; u.lastHitBy = null; }
            if (hits.length) { dg.breath = true; dg.cd = 0.8; }          // le souffle reste visible un instant
        }
    }
    game.dragons = game.dragons.filter(dg => dg.t > -6);
}

// l'IA bâtit ses tours de mage quand elle est riche, et lance ses sorts quand ça vaut le coup
function aiMagic(team) {
    const order = game.level === 'hard' ? ['potion', 'fireball', 'dragon'] : ['potion', 'fireball'];
    for (const key of order) {
        if (!game.mage[team][key]) {
            if (game.gold[team] >= MAGES[key].build + 150 && Math.random() < 0.25) return buildMage(team, key);
            break;
        }
    }
    const bot = [...players.values()].find(p => p.bot && p.team === team && !p.dead);
    if (!bot) return false;
    const enemyUnits = game.units.filter(u => u.team !== team && !u.inside);
    if (bot.hp < KING_HP * 0.5 && castSpell(bot, 'potion')) return true;
    if (game.mage[team].dragon && enemyUnits.length >= 6 && game.gold[team] >= MAGES.dragon.cost + 100 && castSpell(bot, 'dragon')) return true;
    if (game.mage[team].fireball && enemyUnits.length && game.gold[team] >= MAGES.fireball.cost + 60) {
        // vise l'ennemi qui a le plus de voisins
        let best = null, n = 1;
        for (const u of enemyUnits) {
            const k = enemyUnits.filter(o => Math.hypot(o.x - u.x, o.z - u.z) < MAGES.fireball.radius).length;
            if (k > n) { n = k; best = u; }
        }
        if (best && n >= 3) return castSpell(bot, 'fireball', best.x, best.z);
    }
    return false;
}

// ---------------------------------------------------------------- les rois
function crown(p, withFx = true) {
    const [x, y, z] = toWorld(p.team, ...THRONE);
    Object.assign(p, { x, y, z, ry: dirOf(p.team) > 0 ? 0 : Math.PI, hp: KING_HP, dead: false, respawn: 0, lock: 0.4, route: null });
    if (withFx) fx.push({ k: 'crown', pid: p.id, p: [r2(x), r2(y), r2(z)] });
    send(p.ws, { t: 'respawn', x, y, z });
}

function damagePlayer(p, dmg, byTeam) {
    if (p.dead || game.phase !== 'playing') return;
    p.hp -= dmg;
    send(p.ws, { t: 'hurt' });
    if (p.hp > 0) return;
    p.hp = 0;
    p.dead = true;
    p.respawn = RESPAWN;
    game.gold[byTeam] += KING_BOUNTY;
    fx.push({ k: 'kingDie', pid: p.id, p: [r2(p.x), r2(p.y), r2(p.z)] });
    send(p.ws, { t: 'dead', time: RESPAWN });
    broadcast({ t: 'msg', text: `${p.team === 'red' ? '💀 Le seigneur du Crâne' : '🦁 Le roi du Lion'} est tombé ! Un nouveau roi sera couronné dans ${RESPAWN} s…` });
}

// coup d'épée / de sceptre / de masse d'un roi
function kingAttack(p) {
    if (p.dead || p.atkCd > 0) return;
    p.atkCd = PLAYER_CD;
    fx.push({ k: 'swing', pid: p.id });
    const fwdX = Math.sin(p.ry), fwdZ = Math.cos(p.ry);
    const inFront = (dx, dz, dd) => dd < 0.5 || (dx * fwdX + dz * fwdZ) / dd > 0.2;
    for (const u of game.units) {
        if (u.team === p.team) continue;
        const dx = u.x - p.x, dz = u.z - p.z, dd = Math.hypot(dx, dz);
        if (dd < 1.6 + UNITS[u.type].radius && inFront(dx, dz, dd) && Math.abs(p.y - 1) < 3) damageUnit(u, PLAYER_DMG, p.team);
    }
    for (const o of players.values()) {
        if (o === p || o.team === p.team || o.dead) continue;
        const dx = o.x - p.x, dz = o.z - p.z, dd = Math.hypot(dx, dz);
        if (dd > 1.9 || Math.abs(o.y - p.y) > 1.5 || !inFront(dx, dz, dd)) continue;
        damagePlayer(o, PLAYER_DMG, p.team);
        if (dd > 0.01) {
            if (o.ws) send(o.ws, { t: 'knock', dx: dx / dd, dz: dz / dd });
            else { o.x += dx / dd * 0.8; o.z += dz / dd * 0.8; }
        }
    }
    const enemy = enemyOf(p.team);
    if (game.def[enemy].tent) {
        const [tx, , tz] = toWorld(enemy, TENT.pos[0], 0, TENT.pos[1]);
        const dx = tx - p.x, dz = tz - p.z, dd = Math.hypot(dx, dz);
        if (dd < 1.6 + TENT.r && inFront(dx, dz, dd)) damageDefense(enemy, 'tent', PLAYER_DMG, p.team);
    }
    if (game.def[enemy].barricade && nearBarricade(enemy, p.x, p.z, 2.2)) damageDefense(enemy, 'barricade', PLAYER_DMG, p.team);
}

// victoire : un roi entre dans la salle au trésor adverse
function checkVault() {
    if (game.phase !== 'playing') return;
    for (const p of players.values()) {
        if (p.dead) continue;
        const [vx, , vz] = toWorld(enemyOf(p.team), VAULT[0], 0, VAULT[1]);
        if (Math.hypot(p.x - vx, p.z - vz) < VAULT_R && p.y < 3.5) {
            game.phase = 'over';
            game.winner = p.team;
            broadcast({ t: 'over', winner: p.team });
            return;
        }
    }
}

// ---------------------------------------------------------------- IA
function updateAI(team, dt) {
    game.aiTimer[team] -= dt;
    if (game.aiTimer[team] > 0) return;
    game.aiTimer[team] = LEVELS[game.level].think;
    if (game.level !== 'easy' && (aiDefense(team) || aiMagic(team))) return;
    const enemyUnits = game.units.filter(u => u.team !== team);
    const mine = game.units.filter(u => u.team === team);
    if (!game.aiPlan[team]) {
        const threat = enemyUnits.filter(u => u.type === 'catapult' || u.type === 'cannon').length;
        const melee = mine.filter(u => u.type === 'infantry' || u.type === 'knight').length;
        if (threat > 0 && melee < threat * 3) game.aiPlan[team] = Math.random() < 0.5 ? 'knight' : 'infantry';
        else {
            const r = Math.random();
            game.aiPlan[team] = r < 0.3 ? 'infantry' : r < 0.52 ? 'archer' : r < 0.74 ? 'knight' : r < 0.88 ? 'cannon' : 'catapult';
        }
    }
    if (enqueue(team, game.aiPlan[team])) game.aiPlan[team] = null;
}

// sous la menace (ennemis près de la porte) l'IA renforce sa défense ; sinon elle investit de temps en temps
function aiDefense(team) {
    const gate = toWorld(team, 0, 0, 9);
    const near = game.units.filter(u => u.team !== team && Math.hypot(u.x - gate[0], u.z - gate[2]) < 20).length;
    const wish = near >= 3 ? ['barricade', 'oil', 'towers'] : Math.random() < 0.12 ? ['tent', 'towers', 'barricade', 'oil'] : [];
    for (const key of wish) {
        const next = DEFENSES[key].levels[game.def[team][key] + 1];
        if (next && game.gold[team] >= next.cost + 60) return buyDefense(team, key);
    }
    return false;
}

// l'IA a aussi son roi : il garde la cour, chasse le roi ennemi qui y entre,
// et part piller le trésor adverse dès que le pont-levis d'en face a cédé
function syncBots() {
    for (const t of TEAMS) {
        const bot = [...players.values()].find(p => p.bot && p.team === t);
        const want = game.ai[t] && game.phase !== 'waiting';
        if (want && !bot) {
            const b = { id: nextPlayerId++, ws: null, bot: true, team: t, anim: 0, atkCd: 0 };
            players.set(b.id, b);
            crown(b, false);
        } else if (!want && bot) players.delete(bot.id);
    }
}

function lootRoute(b) {
    const team = b.team, enemy = enemyOf(team), d = dirOf(team);
    const pts = [
        toWorld(team, 0, 0, 4.2), toWorld(team, 0, 0, OUT_Z), [0, 0, -21 * d], [0, 0, 21 * d],
        toWorld(enemy, 0, 0, 12), toWorld(enemy, 0, 0, OUT_Z), toWorld(enemy, 0, 0, 4.2),
        toWorld(enemy, 3.4, 0, -3.4), toWorld(enemy, VAULT[0], 0, VAULT[1]),
    ].map(p => [p[0], p[2]]);
    const f = b.z * d;                                           // on saute les étapes déjà dépassées
    while (pts.length > 1 && pts[0][1] * d < f - 0.5) pts.shift();
    return pts;
}

function updateBot(b, dt) {
    b.anim = 0;
    if (b.dead || game.phase !== 'playing') return;
    const team = b.team, enemy = enemyOf(team);
    const dist = o => Math.hypot(o.x - b.x, o.z - b.z);
    const foe = [...players.values()].filter(p => p.team === enemy && !p.dead).sort((a, c) => dist(a) - dist(c))[0];
    const gate = toWorld(team, 0, 0, 9);
    // pont-levis levé quand le roi ennemi approche (tant qu'il n'a pas cédé)
    if (!game.broken[team] && LEVELS[game.level].door) game.door[team] = !(foe && Math.hypot(foe.x - gate[0], foe.z - gate[2]) < 12);

    let goal = null, chasing = false;
    if (foe && isInCastle(team, foe.x, foe.z)) { goal = [foe.x, foe.z]; chasing = true; b.route = null; }
    else if (game.broken[enemy]) {
        if (!b.route) b.route = lootRoute(b);
        while (b.route.length && Math.hypot(b.route[0][0] - b.x, b.route[0][1] - b.z) < 0.4) b.route.shift();
        if (b.route.length) goal = b.route[0];
    } else {
        b.route = null;
        const post = toWorld(team, 2, 0, 4.2);
        goal = [post[0], post[2]];
    }
    // des barricades ennemies barrent le chemin du pillage : on les abat d'abord
    if (goal && !chasing && game.def[enemy].barricade && nearBarricade(enemy, b.x, b.z, 1.4)) {
        goal = null;
        const g = toWorld(enemy, 0, 0, 9);
        b.ry = Math.atan2(g[0] - b.x, g[2] - b.z);
        if (b.atkCd <= 0) kingAttack(b);
    }
    if (goal) {
        const dx = goal[0] - b.x, dz = goal[1] - b.z, l = Math.hypot(dx, dz);
        const stop = chasing ? 1.2 : 0.05;
        if (l > stop) {
            const m = Math.min(l - stop, BOT_SPEED * dt);
            b.x += dx / l * m; b.z += dz / l * m;
            b.ry = Math.atan2(dx, dz);
            b.anim = 1;
        }
    }
    b.y = onCastleBase(b.x, b.z) ? 1 : 0.02;
    // frappe ce qui passe à portée
    let hit = foe && dist(foe) < 1.7 ? foe : null;
    if (!hit) hit = game.units.find(u => u.team !== team && dist(u) < 1.3 + UNITS[u.type].radius);
    if (hit && b.atkCd <= 0) {
        b.ry = Math.atan2(hit.x - b.x, hit.z - b.z);
        kingAttack(b);
    }
}

// ---------------------------------------------------------------- simulation
function step(dt) {
    syncBots();
    if (game.phase === 'playing') {
        for (const t of TEAMS) {
            game.gold[t] += INCOME * dt * (game.ai[t] ? LEVELS[game.level].income : 1);
            if (game.ai[t]) updateAI(t, dt);
        }
        trainUnits(dt);
    }

    const units = game.units;
    const byId = new Map(units.map(u => [u.id, u]));
    const kings = [...players.values()].filter(p => !p.dead && p.y < 4.5);

    for (const u of units) {
        const s = UNITS[u.type];
        const d = dirOf(u.team);
        const enemy = enemyOf(u.team);
        u.cd -= dt;

        // 1. un ennemi à portée d'aggro ? Dans la cour, seul un roi ennemi entré dans le château compte ;
        //    dehors, on ne poursuit pas un roi à l'abri derrière des murs.
        let target = null, isKing = false, isTent = false, best = Infinity;
        if (s.targetsUnits) {
            if (!u.inside) {
                for (const o of units) {
                    if (o.team === u.team || o.hp <= 0 || o.inside) continue;
                    const dd = Math.hypot(o.x - u.x, o.z - u.z);
                    if (dd < s.aggro && dd < best) { best = dd; target = o; }
                }
            }
            for (const p of kings) {
                if (p.team === u.team) continue;
                const inside = isInCastle(u.team, p.x, p.z) || isInCastle(enemy, p.x, p.z);
                if (u.inside ? !isInCastle(u.team, p.x, p.z) : inside) continue;
                const dd = Math.hypot(p.x - u.x, p.z - u.z);
                if (dd < s.aggro && dd < best) { best = dd; target = p; isKing = true; }
            }
            // le chapiteau ennemi, au bord de la route, attire les troupes qui passent
            if (!u.inside && game.def[enemy].tent) {
                const [tx, , tz] = toWorld(enemy, TENT.pos[0], 0, TENT.pos[1]);
                const dd = Math.hypot(tx - u.x, tz - u.z) - TENT.r;
                if (dd < s.aggro && dd < best) { best = dd; target = { x: tx, z: tz }; isKing = false; isTent = true; }
            }
        }

        let goal = null;
        if (target) {
            const reach = s.range + (isKing ? 0.3 : isTent ? 0.2 : UNITS[target.type].radius * 0.6);
            if (best > reach) goal = [target.x, target.z];
            else {
                u.state = 1;
                u.rot = Math.atan2(target.x - u.x, target.z - u.z);
                if (u.cd <= 0) {
                    u.cd = s.cd;
                    if (s.ranged) {
                        const to = [target.x, isKing ? target.y + 0.9 : isTent ? 2.2 : 0.9, target.z];
                        const hit = isKing ? { player: target.id } : isTent ? { def: 'tent', team: enemy } : { unit: target.id };
                        shoot(s.ranged, [u.x, 1.3, u.z], to, s.dmg, hit, u.team);
                    } else {
                        if (isKing) damagePlayer(target, s.dmg, u.team);
                        else if (isTent) damageDefense(enemy, 'tent', s.dmg, u.team);
                        else damageUnit(target, s.dmg, u.team);
                        fx.push({ k: 'melee', id: u.id });
                    }
                }
            }
        } else if (u.inside) {
            // 2. sortie du château : rassemblement derrière la porte, puis passage du pont-levis s'il est baissé
            const lz = toLocal(u.team, u.x, u.z)[1];
            if (u.inside === 1 && !game.door[u.team] && lz < 7.2) u.inside = 2;
            const [gx, , gz] = toWorld(u.team, u.nx, 0, u.inside === 2 ? MUSTER_Z + u.mz : OUT_Z);
            if (Math.hypot(gx - u.x, gz - u.z) < 0.3) {
                if (u.inside === 1) u.inside = 0;
                else if (game.door[u.team]) u.inside = 1;
            } else goal = [gx, gz];
        } else if (!s.ranged && game.def[enemy].barricade && nearBarricade(enemy, u.x, u.z)) {
            // 3. des barricades barrent l'approche du pont-levis : il faut les abattre pour passer
            u.state = 2;
            const g = toWorld(enemy, 0, 0, 9);
            u.rot = Math.atan2(g[0] - u.x, g[2] - u.z);
            if (u.cd <= 0 && game.phase === 'playing') {
                u.cd = s.cd;
                damageDefense(enemy, 'barricade', s.dmg, u.team);
                const thorns = DEFENSES.barricade.levels[game.def[enemy].barricade]?.thorns;
                if (thorns) damageUnit(u, thorns, enemy);
                fx.push({ k: 'melee', id: u.id, p: [r2(u.x), 0.6, r2(u.z + (enemy === 'red' ? -0.7 : 0.7))] });
            }
        } else {
            // 4. assez près du château ennemi pour l'attaquer ?
            const gate = toWorld(enemy, 0, 0, 9);
            const distGate = Math.hypot(gate[0] - u.x, gate[2] - u.z);
            const atWall = s.ranged ? distGate <= s.range : u.wp >= PATH.length;
            if (atWall) {
                u.state = 2;
                u.rot = Math.atan2(gate[0] - u.x, gate[2] - u.z);
                if (u.cd <= 0 && game.phase === 'playing' && !game.broken[enemy]) {
                    u.cd = s.cd;
                    if (s.ranged) {
                        const from = s.ranged === 'stone' ? [u.x, 2.4, u.z] : s.ranged === 'ball' ? [u.x + Math.sin(u.rot) * 1.1, 1.0, u.z + Math.cos(u.rot) * 1.1] : [u.x, 1.3, u.z];
                        shoot(s.ranged, from, castlePoint(enemy, s.ranged === 'stone' ? 'all' : 'gate'), s.castleDmg, { castle: enemy }, u.team);
                        if (s.ranged !== 'arrow') fx.push({ k: 'fire', id: u.id });
                    } else {
                        // porte fermée : les soldats et chevaliers font moins de dégâts
                        const mult = !game.door[enemy] ? 0.4 : 1;
                        damageCastle(enemy, s.castleDmg * mult);
                        fx.push({ k: 'melee', id: u.id, p: [r2(u.x), r2(rnd(1.5, 3)), r2(u.z + d * 0.8)] });
                    }
                }
            } else if (u.wp < PATH.length) {
                const w = PATH[u.wp];
                goal = [w.mode === 'lane' ? u.lane : u.nx, w.f * d];
            }
        }

        if (goal) {
            u.state = 0;
            const dx = goal[0] - u.x, dz = goal[1] - u.z, l = Math.hypot(dx, dz);
            if (l < 0.3 && !target && !u.inside) u.wp++;
            else if (l > 0) {
                const m = Math.min(l, s.speed * dt);
                u.x += dx / l * m; u.z += dz / l * m;
                u.rot = Math.atan2(dx, dz);
            }
        }
    }

    // séparation légère pour que les unités ne s'empilent pas
    for (let i = 0; i < units.length; i++) {
        for (let j = i + 1; j < units.length; j++) {
            const a = units[i], b = units[j];
            const min = (UNITS[a.type].radius + UNITS[b.type].radius) * 0.8;
            const dx = b.x - a.x, dz = b.z - a.z, dd = Math.hypot(dx, dz);
            if (dd > 0.001 && dd < min) {
                const push = (min - dd) * 0.5, nx = dx / dd, nz = dz / dd;
                a.x -= nx * push; a.z -= nz * push;
                b.x += nx * push; b.z += nz * push;
            }
        }
    }

    for (const t of TEAMS) {
        if (!game.def[t].barricade) continue;
        for (const u of units) {
            if (u.team === t || u.inside) continue;
            const [lx, lz] = toLocal(t, u.x, u.z);
            if (Math.abs(lx) < BARRICADE.half + 1 && lz < BARRICADE.z + 0.6 && lz > BARRICADE.z - 1.5) {
                u.z = t === 'red' ? BARRICADE.z + 0.6 - 40 : 40 - (BARRICADE.z + 0.6);
            }
        }
    }

    if (game.phase === 'playing') {
        for (const t of TEAMS) {
            // défense des tours : flèches sur les troupes ennemies proches de la porte, sinon sur le roi ennemi
            const tw = DEFENSES.towers.levels[game.def[t].towers];
            game.towerCd[t] -= dt;
            if (game.towerCd[t] <= 0) {
                const gate = toWorld(t, 0, 0, 9);
                const dist = o => Math.hypot(o.x - gate[0], o.z - gate[2]);
                let targets = units.filter(u => u.team !== t && u.hp > 0 && dist(u) < tw.range).sort((a, b) => dist(a) - dist(b));
                let isKing = false;
                if (!targets.length) { targets = kings.filter(p => p.team !== t && dist(p) < tw.range).sort((a, b) => dist(a) - dist(b)); isKing = true; }
                if (targets.length) {
                    game.towerCd[t] = tw.cd;
                    for (let i = 0; i < tw.volley; i++) {
                        const target = targets[i % targets.length];
                        game.towerSide[t] *= -1;
                        const [tx, ty, tz] = TOWERS[t][game.towerSide[t] > 0 ? 1 : 0];
                        shoot('arrow', toWorld(t, tx, ty, tz), [target.x, isKing ? target.y + 0.9 : 0.9, target.z], tw.dmg,
                            isKing ? { player: target.id } : { unit: target.id }, t);
                    }
                }
            }
            // huile bouillante : versée du haut de la porte sur tout ce qui se presse devant
            const oil = DEFENSES.oil.levels[game.def[t].oil];
            if (oil) {
                game.oilCd[t] -= dt;
                if (game.oilCd[t] <= 0) {
                    const c = toWorld(t, 0, 0, 10.8);
                    const outside = o => toLocal(t, o.x, o.z)[1] > GATE_FRONT_Z;
                    const inRange = o => Math.hypot(o.x - c[0], o.z - c[2]) < oil.radius && outside(o);
                    const victims = units.filter(u => u.team !== t && u.hp > 0 && inRange(u));
                    const kingVictims = kings.filter(p => p.team !== t && inRange(p));
                    if (victims.length + kingVictims.length) {
                        for (const u of victims) damageUnit(u, oil.dmg, t);
                        for (const p of kingVictims) damagePlayer(p, oil.dmg, t);
                        fx.push({ k: 'oil', team: t, p: [r2(c[0]), 0, r2(c[2])], r: oil.radius });
                        game.oilCd[t] = oil.cd;
                    } else game.oilCd[t] = 0.3;
                }
            }
        }
    }

    // projectiles qui arrivent
    for (const p of game.pending) {
        p.time -= dt;
        if (p.time > 0) continue;
        if (p.target.unit) {
            const tu = byId.get(p.target.unit);
            if (tu) damageUnit(tu, p.dmg, p.attacker);
        } else if (p.target.player) {
            const pl = players.get(p.target.player);
            if (pl) damagePlayer(pl, p.dmg, p.attacker);
        } else if (p.target.aoe) fireballHit(p.target.aoe);
        else if (p.target.def) damageDefense(p.target.team, p.target.def, p.dmg, p.attacker);
        else if (p.target.castle) damageCastle(p.target.castle, p.dmg);
    }
    game.pending = game.pending.filter(p => p.time > 0);

    // morts + primes
    for (const u of units) {
        if (u.hp > 0) continue;
        if (u.lastHitBy) game.gold[u.lastHitBy] += UNITS[u.type].bounty;
        fx.push({ k: 'die', id: u.id, p: [r2(u.x), 0, r2(u.z)] });
    }
    game.units = units.filter(u => u.hp > 0);

    // sorts : recharges et dragons
    for (const t of TEAMS) for (const k of MAGE_KEYS) game.spellCd[t][k] = Math.max(0, game.spellCd[t][k] - dt);
    if (game.phase === 'playing') updateDragons(dt);

    // rois : recharge, couronnement après la mort, IA
    for (const p of players.values()) {
        p.atkCd -= dt;
        p.lock = Math.max(0, (p.lock || 0) - dt);
        if (p.dead && game.phase === 'playing') {
            p.respawn -= dt;
            if (p.respawn <= 0) crown(p);
        }
        if (p.bot) updateBot(p, dt);
    }
    checkVault();
}

// ---------------------------------------------------------------- réseau
function send(ws, msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const p of players.values()) if (p.ws && p.ws.readyState === 1) p.ws.send(s);
}

function snapshot() {
    return {
        t: 's',
        ph: game.phase,
        w: game.winner,
        g: [Math.floor(game.gold.red), Math.floor(game.gold.blue)],
        hp: [Math.ceil(game.hp.red), Math.ceil(game.hp.blue)],
        door: [game.door.red ? 1 : 0, game.door.blue ? 1 : 0],
        br: [game.broken.red ? 1 : 0, game.broken.blue ? 1 : 0],
        // défenses : niveaux par équipe (ordre de DEF_KEYS), et PV en % des barricades et du chapiteau
        d: TEAMS.map(t => DEF_KEYS.map(k => game.def[t][k])),
        // tours de mage bâties, recharges des sorts (s), dragons en vol [id, équipe, x, z, cap, souffle, repart]
        mg: TEAMS.map(t => MAGE_KEYS.map(k => (game.mage[t][k] ? 1 : 0))),
        sc: TEAMS.map(t => MAGE_KEYS.map(k => Math.ceil(game.spellCd[t][k]))),
        dr: game.dragons.map(dg => [dg.id, dg.team === 'red' ? 0 : 1, r2(dg.x), r2(dg.z), r2(dg.ry), dg.breath ? 1 : 0, dg.t <= 0 ? 1 : 0]),
        dh: TEAMS.map(t => ['barricade', 'tent'].map(k => {
            const lv = DEFENSES[k].levels[game.def[t][k]];
            return lv ? Math.max(0, Math.round(game.defHp[t][k] / lv.hp * 100)) : 0;
        })),
        // files de formation : par équipe, [caserne, atelier, chapiteau] = [[types…], avancement du premier]
        q: TEAMS.map(t => BUILDING_NAMES.map(b => {
            const q = game.queue[t][b];
            return [q.map(i => TYPES.indexOf(i.type)), q.length ? r2(1 - q[0].left / UNITS[q[0].type].train) : 0];
        })),
        ai: [game.ai.red ? 1 : 0, game.ai.blue ? 1 : 0],
        n: [humans('red'), humans('blue')],
        u: game.units.map(u => [u.id, TYPES.indexOf(u.type), u.team === 'red' ? 0 : 1, r2(u.x), r2(u.z),
            Math.round(u.hp / UNITS[u.type].hp * 100), u.state, r2(u.rot)]),
        p: [...players.values()].map(p => [p.id, p.team === 'red' ? 0 : 1, r2(p.x), r2(p.y), r2(p.z), r2(p.ry), p.anim,
            Math.round(p.hp / KING_HP * 100), p.dead ? 1 : 0, p.bot ? 1 : 0]),
        fx,
    };
}

// adresses à donner à l'adversaire : l'adresse publique une fois hébergé (Render la fournit),
// sinon les adresses de cet ordinateur sur le réseau local
function lanAddresses() {
    if (process.env.RENDER_EXTERNAL_URL) return [process.env.RENDER_EXTERNAL_URL];
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${PORT}`);
    }
    return out;
}

const num = (v, def = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : def);

// ---------------------------------------------------------------- salons
// Chaque salon a sa propre partie. Les fonctions de simulation travaillent sur les variables
// game / players / fx : withRoom() les fait pointer sur le salon voulu le temps d'un traitement
// (tout est synchrone, donc deux salons ne peuvent pas se mélanger).
const rooms = new Map();       // code -> { id, name, pass, solo, game, players, fx }
const visitors = new Set();    // connexions encore dans le menu de démarrage
const MAX_PER_ROOM = 4;        // humains par salon (deux par château)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const hashPass = s => crypto.createHash('sha256').update('les-deux-couronnes:' + s).digest('hex');
const cleanText = (v, max) => (typeof v === 'string' ? v.replace(/[<>]/g, '').trim().slice(0, max) : '');

function withRoom(room, fn) {
    game = room.game; players = room.players; fx = room.fx;
    try { return fn(); } finally { room.game = game; room.fx = fx; }
}

function createRoom({ name, password = '', solo = false }) {
    let id;
    do id = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
    while (rooms.has(id));
    const room = { id, name, pass: password ? hashPass(password) : null, solo, game: null, players: new Map(), fx: [] };
    withRoom(room, () => newGame());
    rooms.set(id, room);
    console.log(`Salon ${id} créé : « ${name} »${room.pass ? ' (mot de passe)' : ''}${solo ? ' (solo)' : ''}`);
    return room;
}

// salons visibles dans le menu (les parties solo restent privées)
function roomList() {
    return [...rooms.values()].filter(r => !r.solo).map(r => withRoom(r, () => ({
        id: r.id, name: r.name, locked: !!r.pass, n: [humans('red'), humans('blue')],
        phase: game.phase, ai: game.ai.red || game.ai.blue,
    })));
}

// un visiteur entre dans un salon (à appeler dans withRoom)
function enterRoom(ws, room, m) {
    const pref = m.team === 'blue' ? 'blue' : 'red';
    const team = !room.solo && humans(pref) > humans(enemyOf(pref)) ? enemyOf(pref) : pref;
    const id = nextPlayerId++;
    const player = { id, ws, team, anim: 0, atkCd: 0 };
    crown(player, false);
    players.set(id, player);
    visitors.delete(ws);
    send(ws, {
        t: 'welcome', id, team, mode: room.solo ? 'solo' : 'multi', room: { id: room.id, name: room.name, locked: !!room.pass },
        units: UNITS, types: TYPES, defenses: DEFENSES, defKeys: DEF_KEYS, mages: MAGES, mageKeys: MAGE_KEYS, dragonY: DRAGON_Y, castleHp: CASTLE_HP, kingHp: KING_HP, queueMax: QUEUE_MAX, lan: lanAddresses(),
    });
    console.log(`Joueur ${id} → salon ${room.id} (équipe ${team})`);

    if (room.solo) {
        newGame('waiting');
        game.ai = { red: team !== 'red', blue: team !== 'blue' };
        game.level = LEVELS[m.level] ? m.level : 'normal';
        startGame();
        return;
    }
    // un humain remplace l'IA de son équipe (et son roi)
    if (game.ai[team]) game.ai[team] = false;
    if (game.phase === 'waiting' && humans('red') && humans('blue')) startGame();
    else if (game.phase === 'playing') broadcast({ t: 'msg', text: `🎺 Un nouveau roi rejoint le royaume ${team === 'red' ? 'du Crâne' : 'du Lion'} !` });
}

// messages du menu : partie solo, création d'un salon, entrée dans un salon
function lobbyMessage(ws, m) {
    const refuse = text => { send(ws, { t: 'refused', text }); return null; };
    if (m.t === 'solo') {
        const room = createRoom({ name: 'Partie solo', solo: true });
        withRoom(room, () => enterRoom(ws, room, m));
        return room;
    }
    if (m.t === 'create') {
        const name = cleanText(m.name, 24) || 'Salon des chevaliers';
        const room = createRoom({ name, password: cleanText(m.password, 32) });
        withRoom(room, () => enterRoom(ws, room, m));
        return room;
    }
    if (m.t === 'join') {
        const room = rooms.get(cleanText(m.room, 4).toUpperCase());
        if (!room || room.solo) return refuse("Ce salon a fermé ses portes.");
        if (room.pass && hashPass(cleanText(m.password, 32)) !== room.pass) return refuse("Halte ! Ce n'est pas le bon mot de passe 🔒");
        const full = withRoom(room, () => humans('red') + humans('blue') >= MAX_PER_ROOM);
        if (full) return refuse("Ce salon est complet : tous les trônes sont pris.");
        withRoom(room, () => enterRoom(ws, room, m));
        return room;
    }
    return null;
}

// messages de jeu (à appeler dans withRoom)
function gameMessage(p, m) {
    switch (m.t) {
        case 'pos':
            if (p.dead || p.lock > 0) break;
            p.x = num(m.x, p.x); p.y = num(m.y, p.y); p.z = num(m.z, p.z);
            p.ry = num(m.ry, p.ry); p.anim = num(m.a, 0);
            break;
        case 'spawn':
            if (typeof m.unit === 'string' && UNITS[m.unit]) enqueue(p.team, m.unit);
            break;
        case 'door': {
            if (game.broken[p.team] || p.dead) break;
            const gate = toWorld(p.team, 0, 0, 9);
            if (Math.hypot(p.x - gate[0], p.z - gate[2]) < 6) game.door[p.team] = !game.door[p.team];
            break;
        }
        case 'attack':
            kingAttack(p);
            break;
        case 'mage':
            if (typeof m.key === 'string' && MAGES[m.key]) buildMage(p.team, m.key);
            break;
        case 'spell':
            if (typeof m.key === 'string' && MAGES[m.key]) castSpell(p, m.key, m.x, m.z);
            break;
        case 'defense':
            if (typeof m.key === 'string' && DEFENSES[m.key]) buyDefense(p.team, m.key);
            break;
        case 'restart':
            if (game.phase === 'over') {
                const { ai, level } = game;
                newGame('waiting');
                game.ai = ai;
                game.level = level;
                if ((humans('red') || ai.red) && (humans('blue') || ai.blue)) startGame();
            }
            break;
    }
}

function leaveRoom(room, id) {
    withRoom(room, () => {
        const team = players.get(id)?.team;
        players.delete(id);
        console.log(`Joueur ${id} a quitté le salon ${room.id}`);
        if (humans('red') + humans('blue') === 0) return;
        if (game.phase === 'playing' && humans(team) === 0) {
            game.ai[team] = true;
            broadcast({ t: 'msg', text: `Le royaume ${team === 'red' ? 'du Crâne' : 'du Lion'} n'a plus de roi : la magie de l'ordinateur reprend la couronne !` });
        }
    });
    // plus aucun humain : le salon disparaît
    if (withRoom(room, () => humans('red') + humans('blue')) === 0) {
        rooms.delete(room.id);
        console.log(`Salon ${room.id} fermé`);
    }
}

const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
    let room = null, id = null;
    visitors.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    send(ws, { t: 'hello', rooms: roomList(), lan: lanAddresses() });

    ws.on('message', raw => {
        let m;
        try { m = JSON.parse(raw); } catch { return; }
        if (!m || typeof m !== 'object') return;
        if (!room) {
            room = lobbyMessage(ws, m);
            if (room) id = [...room.players.values()].find(p => p.ws === ws)?.id ?? null;
            return;
        }
        if (!rooms.has(room.id)) return;
        withRoom(room, () => {
            const p = players.get(id);
            if (p) gameMessage(p, m);
        });
    });

    ws.on('close', () => {
        visitors.delete(ws);
        if (room && id !== null && rooms.has(room.id)) leaveRoom(room, id);
    });
});

setInterval(() => {
    for (const room of rooms.values()) {
        withRoom(room, () => {
            step(TICK);
            if (humans('red') + humans('blue')) broadcast(snapshot());
            fx = [];
        });
    }
}, TICK * 1000);
// les visiteurs du menu voient la liste des salons se mettre à jour
setInterval(() => {
    if (!visitors.size) return;
    const msg = { t: 'rooms', rooms: roomList(), lan: lanAddresses() };
    for (const ws of visitors) send(ws, msg);
}, 1000);

// battement de cœur : on ping chaque connexion et on ferme celles qui ne répondent plus
// (un onglet fermé brutalement ne bloque pas un trône dans un salon)
setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.isAlive) { ws.terminate(); continue; }
        ws.isAlive = false;
        ws.ping();
    }
}, 30000);

// arrêt demandé par l'hébergeur (redéploiement, maintenance) : on prévient les joueurs puis on ferme
process.on('SIGTERM', () => {
    const msg = JSON.stringify({ t: 'msg', text: '🔧 Le château ferme ses portes quelques instants pour une mise à jour…' });
    for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
    setTimeout(() => {
        for (const ws of wss.clients) ws.close(1012, 'redémarrage');
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000);
    }, 500);
});

server.listen(PORT, () => {
    console.log(`\n👑  Les Deux Couronnes : serveur prêt !`);
    if (process.env.RENDER_EXTERNAL_URL) console.log(`   En ligne : ${process.env.RENDER_EXTERNAL_URL}`);
    else {
        console.log(`   Sur cet ordinateur : http://localhost:${PORT}`);
        for (const a of lanAddresses()) console.log(`   Sur le réseau local : ${a}`);
    }
    console.log('');
});

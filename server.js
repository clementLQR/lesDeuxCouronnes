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
const zlib = require('zlib');
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

// Fichiers du jeu : gardés en mémoire, déjà compressés (brotli / gzip : 4 à 5 fois plus légers à télécharger),
// avec une empreinte (ETag). Le navigateur revérifie à chaque chargement (no-cache, pratique quand on modifie le code),
// mais si rien n'a changé le serveur répond « 304 : rien de neuf » sans rien renvoyer.
const files = new Map();       // chemin -> { mtimeMs, etag, raw, br, gz, type }
const COMPRESS = new Set(['.html', '.js', '.css']);

function loadFile(file, st) {
    let f = files.get(file);
    if (f && f.mtimeMs === st.mtimeMs && f.size === st.size) return f;
    const raw = fs.readFileSync(file);
    const ext = path.extname(file);
    f = { mtimeMs: st.mtimeMs, size: st.size, raw, type: MIME[ext] || 'application/octet-stream',
        etag: '"' + crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 20) + '"' };
    if (COMPRESS.has(ext)) {
        f.br = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 10 } });
        f.gz = zlib.gzipSync(raw, { level: 9 });
    }
    files.set(file, f);
    return f;
}

const server = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end(); }
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
    fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); return res.end('404'); }
        let f;
        try { f = loadFile(file, st); } catch { res.writeHead(500); return res.end(); }
        const headers = { 'Content-Type': f.type, 'Cache-Control': 'no-cache', ETag: f.etag, Vary: 'Accept-Encoding' };
        if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, headers); return res.end(); }
        const accept = req.headers['accept-encoding'] || '';
        let body = f.raw;
        if (f.br && /\bbr\b/.test(accept)) { body = f.br; headers['Content-Encoding'] = 'br'; }
        else if (f.gz && /\bgzip\b/.test(accept)) { body = f.gz; headers['Content-Encoding'] = 'gzip'; }
        headers['Content-Length'] = body.length;
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : body);
    });
});


// ---------------------------------------------------------------- règles du jeu
// troupes de la planche : soldats, archers, chevaliers, canon, engin de siège
// prime = 50 % du coût : abattre l'ennemi aide, mais ne suffit pas à s'enrichir ; chaque troupe
// se forme dans un bâtiment (une file de 5 maximum par bâtiment), ce qui limite le rythme.
// Équilibrage mesuré avec tools/sim.js (combats à or égal, sièges, parties IA contre IA) :
// à prix égal, chaque troupe bat celle qu'elle contre, et une armée variée bat les armées d'un seul type.
const UNITS = {
    infantry: { name: 'Soldats',        icon: '🔱', cost: 25,  bounty: 13,  train: 3,  building: 'barracks', hp: 72,  speed: 2.3, dmg: 8,  castleDmg: 4,  range: 1.8, cd: 0.9, aggro: 6, targetsUnits: true,  radius: 0.4 },
    archer:   { name: 'Archers',        icon: '🏹', cost: 35,  bounty: 18,  train: 4,  building: 'barracks', hp: 75,  speed: 2.0, dmg: 12, castleDmg: 3,  range: 10,  cd: 1.2, aggro: 10, targetsUnits: true, radius: 0.4, ranged: 'arrow' },
    knight:   { name: 'Chevalier',      icon: '🛡️', cost: 65,  bounty: 33,  train: 6,  building: 'barracks', hp: 230, speed: 2.0, dmg: 20, castleDmg: 7,  range: 1.4, cd: 1.1, aggro: 7, targetsUnits: true,  radius: 0.45 },
    // le canon tire ses boulets sur les paquets de troupes ennemies (dégâts de zone), sinon sur le château
    cannon:   { name: 'Canon',          icon: '💣', cost: 150, bounty: 75,  train: 9,  building: 'workshop', hp: 220, speed: 1.2, dmg: 0,  castleDmg: 45, range: 14,  cd: 3.5, aggro: 0, targetsUnits: false, radius: 1.0, ranged: 'ball',
        splash: { range: 13, r: 2.0, dmg: 22 } },
    // l'engin de siège tire de plus loin que les tours : on le contre en sortant des troupes, ou par la magie
    catapult: { name: 'Engin de siège', icon: '🪨', cost: 200, bounty: 100, train: 10, building: 'workshop', hp: 180, speed: 1.1, dmg: 0,  castleDmg: 70, range: 23,  cd: 5.0, aggro: 0, targetsUnits: false, radius: 1.1, ranged: 'stone' },
    // le bélier fonce sur le pont-levis et frappe fort, même pont levé ; il ne se défend pas et craint les lances
    ram:      { name: 'Bélier',         icon: '🐏', cost: 160, bounty: 80,  train: 8,  building: 'workshop', hp: 300, speed: 1.5, dmg: 0,  castleDmg: 65, range: 1.6, cd: 2.8, aggro: 0, targetsUnits: false, radius: 1.0 },
};
// forces et faiblesses (multiplicateur des dégâts infligés) : les lances battent les chevaliers (et le bélier),
// les chevaliers battent les archers, les archers battent les soldats. Assez marqué pour compter, pas au point
// de tout décider : une armée variée l'emporte sur une armée d'un seul type.
const COUNTERS = {
    infantry: { knight: 1.7, ram: 3 },
    knight:   { archer: 1.7, infantry: 0.8 },
    archer:   { infantry: 1.7, knight: 0.75 },
};
const counter = (att, def) => COUNTERS[att]?.[def] ?? 1;
const TYPES = Object.keys(UNITS);
const TEAMS = ['red', 'blue'];
const BUILDING_NAMES = ['barracks', 'workshop', 'tent'];
const CASTLE_HP = Number(process.env.CASTLE_HP) || 2500;   // CASTLE_HP=200 npm start : parties de test rapides
const START_GOLD = Number(process.env.START_GOLD) || 300;   // START_GOLD=3000 npm start : tester les achats
const INCOME = 10;           // or par seconde
// une partie qui s'éternise s'emballe : passé 12 minutes, les revenus grimpent par paliers (les armées finissent par l'emporter sur les murs)
const RICHES = [[12 * 60, 1.2, '🪙 Les coffres des royaumes se remplissent : les revenus augmentent !'],
    [17 * 60, 1.4, "🪙🪙 La guerre s'éternise : les revenus augmentent encore !"], [22 * 60, 1.6, '🪙🪙🪙 Trésors de guerre : les revenus sont au plus haut !']];
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
    tent: { name: 'Chapiteau', icon: '🎪', levels: [null, { cost: 200, hp: 300 }] },
};
const DEF_KEYS = Object.keys(DEFENSES);
const STRUCTURE_BOUNTY = { barricade: 60, tent: 100 };
// une construction abattue ne peut pas être relevée tout de suite (secondes)
const REBUILD_CD = { barricade: 20, tent: 40 };
// le chapiteau (caserne hors les murs) et la ligne de barricades, dans le repère local du château
const TENT = { pos: [-7.5, 17.5], door: [-4.9, 17.5], r: 2.4 };
const BARRICADE = { z: 14.2, half: 4.6 };
const GATE_FRONT_Z = 7.8;      // au-delà, on est dehors, devant la façade

// tours de mage : bâties derrière le château, indestructibles, ignorées par les troupes ;
// chacune débloque un sort qui coûte de l'or à chaque lancer et a son temps de recharge
const MAGES = {
    potion:   { tower: "Tour de l'Alchimiste", spell: 'Potion de vie', icon: '🧪', key: 'R', build: 250, cost: 60,  cd: 30,  heal: 150, pos: [-6, -15.5] },
    fireball: { tower: 'Tour du Pyromancien',  spell: 'Boule de feu',  icon: '☄️', key: 'T', build: 350, cost: 90,  cd: 16,  radius: 3, dmg: 55, structDmg: 150, pos: [6, -15.5] },
    dragon:   { tower: "Tour de l'Invocateur", spell: 'Dragon',        icon: '🐉', key: 'Y', build: 1200, cost: 500, cd: 300, duration: 18, radius: 3.6, speed: 8, pos: [0, -17.5] },
};
const MAGE_KEYS = Object.keys(MAGES);
const MAGE_TOP = 11.5;         // hauteur d'où partent les sorts (balcon des tours de mage)
const DRAGON_Y = 8;
const PLAYER_DMG = 30, PLAYER_CD = 0.45;
// dernier rempart : sous 40 % de ses PV, un château se défend avec l'énergie du désespoir
// (tours qui tirent plus vite) : la fin d'un siège demande un vrai assaut, et le royaume en difficulté peut se reprendre
const LAST_STAND = { below: 0.4, cd: 0.75, range: 0 };
const KING_HP = 300, KING_BOUNTY = 100, RESPAWN = 5, BOT_SPEED = 4;
// le roi porte une armure royale : flèches des tours et huile bouillante ne lui font qu'une partie de leurs dégâts
const KING_ARMOR = 0.35;
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

function newStats() {
    return { trained: 0, killed: 0, lost: 0, earned: 0, castleDmg: 0, spells: 0, built: 0, kingsFallen: 0 };
}
// tout l'or gagné passe par ici (revenu, primes) pour être compté
function earn(team, amount) {
    game.gold[team] += amount;
    game.stats[team].earned += amount;
}

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
        lastStand: { red: false, blue: false },
        def: { red: { towers: 0, oil: 0, barricade: 0, tent: 0 }, blue: { towers: 0, oil: 0, barricade: 0, tent: 0 } },
        defHp: { red: { barricade: 0, tent: 0 }, blue: { barricade: 0, tent: 0 } },
        defCd: { red: { barricade: 0, tent: 0 }, blue: { barricade: 0, tent: 0 } },   // délai avant reconstruction
        oilCd: { red: 0, blue: 0 },
        orders: { red: { mode: 'attack', king: null }, blue: { mode: 'attack', king: null } },
        mage: { red: { potion: false, fireball: false, dragon: false }, blue: { potion: false, fireball: false, dragon: false } },
        spellCd: { red: { potion: 0, fireball: 0, dragon: 0 }, blue: { potion: 0, fireball: 0, dragon: 0 } },
        dragons: [],
        units: [],
        pending: [],                             // projectiles en vol
        nextUnitId: 1,
        startedAt: Date.now(),
        clock: 0,                                // secondes de jeu écoulées
        riches: 0,                               // paliers de revenus atteints (RICHES)
        aiSave: { red: null, blue: null },       // tour de mage pour laquelle l'IA met de l'or de côté
        aiDefSave: { red: null, blue: null },    // prix de la défense pour laquelle l'IA assiégée économise
        aiRelease: { red: false, blue: false },  // l'IA vient de baisser son pont-levis pour lâcher une vague
        peace: false,                            // partie guidée : l'IA attend la fin de la leçon
        // statistiques affichées à la fin : par royaume
        stats: { red: newStats(), blue: newStats() },
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
    game.stats[team].trained++;
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
    game.stats[enemyOf(team)].castleDmg += Math.min(dmg, game.hp[team]);
    game.hp[team] = Math.max(0, game.hp[team] - dmg);
    if (game.hp[team] <= 0) {
        game.broken[team] = true;
        game.door[team] = true;
        broadcast({ t: 'msg', text: `💥 Crac ! Les chaînes du pont-levis ${team === 'red' ? 'du Crâne' : 'du Lion'} ont cassé : il ne pourra plus jamais se relever !` });
    }
}

// cible d'un canon : un ennemi à portée hors de sa cour ; pour tirer (best), celui qui a le plus de voisins
// dans le rayon de l'explosion
function artilleryTarget(u, s, best) {
    const sp = s.splash, enemy = enemyOf(u.team);
    let pick = null, score = -1;
    for (const o of game.units) {
        if (o.team === u.team || o.hp <= 0 || o.inside || isInCastle(enemy, o.x, o.z)) continue;
        if (Math.hypot(o.x - u.x, o.z - u.z) > sp.range) continue;
        if (!best) return o;
        let n = 0;
        for (const q of game.units) if (q.team === o.team && q.hp > 0 && Math.hypot(q.x - o.x, q.z - o.z) < sp.r) n++;
        if (n > score) { score = n; pick = o; }
    }
    return pick;
}
// boulet qui touche le sol : toutes les troupes ennemies (et le roi) dans le rayon ; les engins encaissent mieux
function splashHit({ x, z, team, r }, dmg, byTeam) {
    for (const u of game.units) {
        if (u.team !== team || u.hp <= 0 || u.inside) continue;
        if (Math.hypot(u.x - x, u.z - z) < r + UNITS[u.type].radius * 0.5) damageUnit(u, UNITS[u.type].targetsUnits ? dmg : dmg * 0.5, byTeam);
    }
    for (const p of players.values()) {
        if (p.team === team && !p.dead && p.y < 3 && Math.hypot(p.x - x, p.z - z) < r) damagePlayer(p, dmg, byTeam);
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
    if (!next || game.gold[team] < next.cost || game.defCd[team][key] > 0) return false;
    game.gold[team] -= next.cost;
    game.def[team][key]++;
    game.stats[team].built++;
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
    game.defCd[team][key] = REBUILD_CD[key];
    earn(byTeam, STRUCTURE_BOUNTY[key]);
    if (key === 'tent') {                                   // les recrues du chapiteau rentrent à la caserne
        game.queue[team].barracks.push(...game.queue[team].tent);
        game.queue[team].barracks.splice(QUEUE_MAX + 2);
        game.queue[team].tent = [];
    }
    fx.push({ k: 'defDown', key, team });
    broadcast({ t: 'msg', text: key === 'tent' ? `🎪 Le chapiteau ${whoOf(team)} s'effondre !` : `🪵 Les barricades ${whoOf(team)} volent en éclats !` });
}

// obstacle ennemi à portée d'un engin de siège : { key, x, y, z } du point visé, ou null
function siegeTarget(u, enemy, range) {
    if (game.def[enemy].tent) {
        const [x, , z] = toWorld(enemy, TENT.pos[0], 0, TENT.pos[1]);
        if (Math.hypot(x - u.x, z - u.z) - TENT.r <= range) return { key: 'tent', x, y: 2.2, z };
    }
    if (game.def[enemy].barricade) {
        const [lx] = toLocal(enemy, u.x, u.z);
        const [x, , z] = toWorld(enemy, Math.max(-BARRICADE.half, Math.min(BARRICADE.half, lx)), 0, BARRICADE.z);
        if (Math.hypot(x - u.x, z - u.z) <= range) return { key: 'barricade', x, y: 0.8, z };
    }
    return null;
}

// position d'un point par rapport à la ligne de barricades d'un château
function nearBarricade(team, x, z, margin = 1.0) {
    const [lx, lz] = toLocal(team, x, z);
    return Math.abs(lx) < BARRICADE.half + 1 && lz > BARRICADE.z - 0.8 && lz < BARRICADE.z + margin;
}

// ---------------------------------------------------------------- cris rapides
// les textes sont côté client (index du cri) ; une bulle s'affiche au-dessus du roi qui crie
const SHOUT_COUNT = 6;
function shout(p, i) {
    if (!Number.isInteger(i) || i < 0 || i >= SHOUT_COUNT || p.dead) return;
    const now = Date.now();
    if (now - (p.lastShout || 0) < 1500) return;              // pas de concert de trompettes
    p.lastShout = now;
    broadcast({ t: 'shout', pid: p.id, i });
}

// ---------------------------------------------------------------- ordres aux troupes
// attack : marcher sur le château ennemi (comportement de base) ; defend : se poster devant son pont-levis ;
// follow : escorter un roi (en passant par les portes des châteaux, jamais à travers les murs)
const ORDERS = ['attack', 'defend', 'follow'];
const DEFEND_Z = 18, LEASH = { defend: 13, follow: 11 };
const ORDER_TEXT = {
    attack: '⚔️ À l\'attaque ! Les troupes marchent sur le château ennemi.',
    defend: '🛡️ Défendez le château ! Les troupes se postent devant le pont-levis.',
    follow: '👑 Suivez le roi ! Les troupes escortent leur souverain.',
};

function setOrder(team, mode, kingId) {
    if (!ORDERS.includes(mode)) return;
    const o = game.orders[team];
    if (o.mode === mode && o.king === kingId) return;
    game.orders[team] = { mode, king: mode === 'follow' ? kingId : null };
    if (mode === 'attack') for (const u of game.units) if (u.team === team) resumePath(u);
    for (const p of players.values()) if (p.team === team) send(p.ws, { t: 'order', mode, text: ORDER_TEXT[mode] });
}

// après « défendre » ou « suivre le roi », une troupe repart à l'attaque depuis là où elle est :
// on saute les étapes du chemin déjà dépassées au lieu de la renvoyer au pied de sa propre rampe
function resumePath(u) {
    if (u.inside) return;
    if (isInCastle(u.team, u.x, u.z)) { u.inside = 2; u.wp = 0; return; }   // dans sa cour : on ressort par la porte
    const f = u.z * dirOf(u.team);
    u.wp = 0;
    while (u.wp < PATH.length && PATH[u.wp].f < f + 1) u.wp++;
    // déjà au pied du château ennemi : dernière étape, devant la porte
    if (u.wp >= PATH.length) u.wp = PATH.length - 1;
}

// le roi suivi (ou null s'il est tombé : les troupes défendent alors en attendant le couronnement)
function orderKing(team) {
    const o = game.orders[team];
    if (o.mode !== 'follow') return null;
    const k = players.get(o.king);
    return k && !k.dead && k.team === team ? k : null;
}

// point où une troupe doit se rendre selon l'ordre de son camp (null : elle y est déjà)
function orderGoal(u, s) {
    const team = u.team, king = orderKing(team);
    let gx, gz;
    if (!king) {
        // défense : une ligne devant son pont-levis (derrière ses barricades), archers et engins un peu en retrait
        const lx = Math.max(-6.5, Math.min(6.5, u.lane * 0.7));
        [gx, , gz] = toWorld(team, lx, 0, (s.ranged ? DEFEND_Z - 2 : DEFEND_Z) + u.nx * 0.8);
    } else {
        // escorte : chacun sa place autour du roi
        const a = u.id * 2.39996, r = 1.7 + (u.id % 4) * 0.75;
        gx = king.x + Math.sin(a) * r; gz = king.z + Math.cos(a) * r;
        for (const t of TEAMS) {
            const passable = t === team ? game.door[t] : game.door[t] || game.broken[t];
            const [lx, lz] = toLocal(t, u.x, u.z);
            const unitIn = isInCastle(t, u.x, u.z), kingIn = isInCastle(t, king.x, king.z);
            if (unitIn && !kingIn) {
                // sortir d'abord par la porte
                [gx, , gz] = toWorld(t, u.nx, 0, Math.abs(lx) > 1.6 || lz < 4 ? 4.5 : 10.5);
                break;
            }
            if (!unitIn && kingIn) {
                // entrer par la porte (si elle est ouverte), sinon attendre devant
                const atGate = Math.abs(lx) < 1.6 && lz > 7 && lz < 11;
                [gx, , gz] = toWorld(t, u.nx, 0, passable && atGate ? 4.5 : passable ? 10 : 11.5);
                break;
            }
        }
    }
    return Math.hypot(gx - u.x, gz - u.z) < 0.6 ? null : [gx, gz];
}

// l'IA donne aussi ses ordres : défendre sous la menace, escorter son roi quand il part piller
function aiOrders(team) {
    const enemy = enemyOf(team);
    const bot = [...players.values()].find(p => p.bot && p.team === team && !p.dead);
    const gate = toWorld(team, 0, 0, 12);
    const threat = game.units.filter(u => u.team === enemy && Math.hypot(u.x - gate[0], u.z - gate[2]) < 18).length;
    const mine = game.units.filter(u => u.team === team && !u.inside).length;
    if (game.broken[enemy] && bot) setOrder(team, 'follow', bot.id);
    else if (threat >= 3 && threat > mine * 0.8) setOrder(team, 'defend', null);
    else setOrder(team, 'attack', null);
}

// ---------------------------------------------------------------- tours de mage et sorts
function buildMage(team, key) {
    const m = MAGES[key];
    if (!m || game.phase !== 'playing' || game.mage[team][key] || game.gold[team] < m.build) return false;
    game.gold[team] -= m.build;
    game.mage[team][key] = true;
    game.stats[team].built++;
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
    game.stats[team].spells++;
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
            // la troupe ennemie la plus proche hors de son château (la cour est à l'abri) ; sinon il tournoie au milieu du terrain
            let best = Infinity;
            for (const u of game.units) {
                if (u.team !== enemy || u.hp <= 0 || u.inside || isInCastle(enemy, u.x, u.z)) continue;
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
            const hits = game.units.filter(u => u.team === enemy && u.hp > 0 && !u.inside && !isInCastle(enemy, u.x, u.z)
                && Math.hypot(u.x - dg.x, u.z - dg.z) < m.radius + UNITS[u.type].radius);
            for (const u of hits) { u.hp = 0; u.lastHitBy = null; u.killedBy = dg.team; }   // compté dans les stats, sans prime
            if (hits.length) { dg.breath = true; dg.cd = 0.8; }          // le souffle reste visible un instant
        }
    }
    game.dragons = game.dragons.filter(dg => dg.t > -6);
}

// l'IA bâtit ses tours de mage quand elle est riche, et lance ses sorts quand ça vaut le coup
function aiMagic(team) {
    const order = game.level === 'hard' ? ['fireball', 'potion', 'dragon'] : ['fireball', 'potion'];
    // après les premières minutes, l'IA met de l'or de côté pour sa prochaine tour de mage (sauf si on l'assiège)
    game.aiSave[team] = null;
    const key = order.find(k => !game.mage[team][k]);
    const firstAt = game.level === 'hard' ? 100 : 160;
    if (key && game.clock > firstAt + order.indexOf(key) * 120 && !underThreat(team)) {
        if (game.gold[team] >= MAGES[key].build) return buildMage(team, key);
        game.aiSave[team] = key;
    }
    const bot = [...players.values()].find(p => p.bot && p.team === team && !p.dead);
    if (!bot) return false;
    const enemyUnits = game.units.filter(u => u.team !== team && !u.inside);
    if (bot.hp < KING_HP * 0.5 && castSpell(bot, 'potion')) return true;
    if (game.mage[team].dragon && enemyUnits.length >= 6 && game.gold[team] >= MAGES.dragon.cost + 100 && castSpell(bot, 'dragon')) return true;
    if (game.mage[team].fireball && enemyUnits.length && game.gold[team] >= MAGES.fireball.cost + 30) {
        // un engin de siège qui pilonne le château : cible prioritaire
        const gate = toWorld(team, 0, 0, 9);
        const engine = enemyUnits.find(u => (u.type === 'catapult' || u.type === 'cannon') && Math.hypot(u.x - gate[0], u.z - gate[2]) < 28);
        if (engine) return castSpell(bot, 'fireball', engine.x, engine.z);
        // sinon, l'ennemi qui a le plus de voisins
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
    earn(byTeam, KING_BOUNTY);
    game.stats[p.team].kingsFallen++;
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
            broadcast({ t: 'over', winner: p.team, stats: game.stats, duration: Math.round((Date.now() - game.startedAt) / 1000) });
            return;
        }
    }
}

// ---------------------------------------------------------------- IA
function updateAI(team, dt) {
    // partie guidée : trêve jusqu'à la fin de la leçon (ou 4 minutes au plus)
    if (game.peace && Date.now() - game.startedAt < 240000) return;
    game.peace = false;
    game.aiTimer[team] -= dt;
    if (game.aiTimer[team] > 0) return;
    game.aiTimer[team] = LEVELS[game.level].think;
    if (game.level !== 'easy') aiOrders(team);
    if (game.level !== 'easy' && (aiDefense(team) || aiMagic(team))) return;
    const enemyUnits = game.units.filter(u => u.team !== team);
    const mine = game.units.filter(u => u.team === team);
    if (!game.aiPlan[team]) {
        const threat = enemyUnits.filter(u => u.type === 'catapult' || u.type === 'cannon' || u.type === 'ram').length;
        const melee = mine.filter(u => u.type === 'infantry' || u.type === 'knight').length;
        // la troupe ennemie la plus nombreuse, et celle qui la bat
        const count = {};
        for (const u of enemyUnits) count[u.type] = (count[u.type] || 0) + 1;
        const main = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
        const beats = { knight: 'infantry', ram: 'infantry', archer: 'knight', infantry: 'archer', cannon: 'knight', catapult: 'knight' }[main];
        const foe = game.def[enemyOf(team)];
        const fortified = foe.towers + foe.oil + foe.barricade >= 2;
        if (threat > 0 && melee < threat * 3) game.aiPlan[team] = Math.random() < 0.5 ? 'knight' : 'infantry';
        else if ((count.infantry || 0) >= 6 && Math.random() < 0.4) game.aiPlan[team] = 'cannon';     // boulets contre la foule
        else if (beats && count[main] >= 3 && Math.random() < 0.6) game.aiPlan[team] = beats;
        else if (fortified && Math.random() < 0.3) game.aiPlan[team] = 'catapult';                  // château fortifié : on tire de loin
        else if (!game.door[enemyOf(team)] && !game.broken[enemyOf(team)] && Math.random() < 0.35) game.aiPlan[team] = 'ram';
        else {
            const r = Math.random();
            game.aiPlan[team] = r < 0.28 ? 'infantry' : r < 0.48 ? 'archer' : r < 0.68 ? 'knight' : r < 0.8 ? 'cannon' : r < 0.9 ? 'catapult' : 'ram';
        }
    }
    // on garde l'or pour la tour de mage, sauf s'il en reste largement
    if (game.aiSave[team] && game.gold[team] < MAGES[game.aiSave[team]].build + UNITS[game.aiPlan[team]].cost) return;
    if (game.aiDefSave[team] && game.gold[team] < game.aiDefSave[team] + UNITS[game.aiPlan[team]].cost) return;
    if (enqueue(team, game.aiPlan[team])) game.aiPlan[team] = null;
}

// des ennemis se pressent devant notre porte ?
function underThreat(team, n = 4) {
    const gate = toWorld(team, 0, 0, 9);
    return game.units.filter(u => u.team !== team && Math.hypot(u.x - gate[0], u.z - gate[2]) < 22).length >= n;
}

// sous la menace (ennemis près de la porte) l'IA renforce sa défense ; sinon elle investit de temps en temps
function aiDefense(team) {
    const gate = toWorld(team, 0, 0, 9);
    const near = game.units.filter(u => u.team !== team && Math.hypot(u.x - gate[0], u.z - gate[2]) < 20).length;
    // assiégée, l'IA met de l'or de côté pour l'huile bouillante (la défense qui disperse les foules devant la porte)
    game.aiDefSave[team] = null;
    const wish = near >= 3 ? ['oil', 'barricade', 'towers'] : Math.random() < 0.12 ? ['tent', 'towers', 'barricade', 'oil'] : [];
    for (const key of wish) {
        const next = DEFENSES[key].levels[game.def[team][key] + 1];
        if (!next || game.defCd[team][key]) continue;
        if (game.gold[team] >= next.cost + (near >= 3 ? 0 : 60)) return buyDefense(team, key);
        if (near >= 5) { game.aiDefSave[team] = next.cost; break; }
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
    // pont-levis levé quand le roi ennemi approche (tant qu'il n'a pas cédé) ; face à une armée massée devant la porte,
    // l'IA garde ses troupes à l'abri le temps d'en réunir assez, puis les lâche toutes ensemble
    if (!game.broken[team] && LEVELS[game.level].door) {
        const kingNear = foe && Math.hypot(foe.x - gate[0], foe.z - gate[2]) < 12;
        const near = (u, r) => Math.hypot(u.x - gate[0], u.z - gate[2]) < r;
        const foes = game.units.filter(u => u.team === enemy && near(u, 15)).length;
        const waiting = game.units.filter(u => u.team === team && u.inside).length;
        const outside = game.units.filter(u => u.team === team && !u.inside && near(u, 16)).length;
        if (game.aiRelease[team] && waiting === 0) game.aiRelease[team] = false;
        if (!game.aiRelease[team] && foes >= 4 && outside < foes * 0.6 && waiting >= Math.min(7, foes)) game.aiRelease[team] = true;
        const hold = foes >= 4 && outside < foes * 0.6 && !game.aiRelease[team];
        game.door[team] = !(kingNear || hold);
    }

    let goal = null, chasing = false;
    if (foe && isInCastle(team, foe.x, foe.z)) { goal = [foe.x, foe.z]; chasing = true; b.route = null; }
    else if (game.broken[enemy]) {
        if (!b.route) { b.route = lootRoute(b); shout(b, 1); }       // « À l'attaque ! »
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
// une étape du chemin est franchie quand on y est, quand on l'a dépassée dans le sens de la marche,
// ou quand la foule nous empêche d'en approcher (sinon les troupes poussées restaient coincées pour toujours)
function waypointReached(u, l) {
    const w = PATH[u.wp];
    if (!w) return false;
    const f = u.z * dirOf(u.team);
    const last = u.wp === PATH.length - 1;
    return l < 0.3 || (f > w.f - 0.4 && l < (w.mode === 'lane' ? 12 : 3)) || (u.blocked > 1.2 && l < (last ? 3.2 : 2.5));
}

function step(dt) {
    syncBots();
    if (game.phase === 'playing') {
        game.clock += dt;
        while (game.riches < RICHES.length && game.clock >= RICHES[game.riches][0]) broadcast({ t: 'msg', text: RICHES[game.riches++][2] });
        for (const t of TEAMS) {
            earn(t, INCOME * (game.riches ? RICHES[game.riches - 1][1] : 1) * dt * (game.ai[t] ? LEVELS[game.level].income : 1));
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
        const px = u.x, pz = u.z;

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

        const order = game.orders[u.team].mode;
        if (target && order !== 'attack' && !u.inside) {
            const king = orderKing(u.team);
            const anchor = king ? [king.x, king.z] : (([x, , z]) => [x, z])(toWorld(u.team, 0, 0, DEFEND_Z));
            if (Math.hypot(target.x - anchor[0], target.z - anchor[1]) > (king ? LEASH.follow : LEASH.defend)) target = null;
        }

        let goal = null, ordered = false, siegeAim = null, gun = null;
        if (target) {
            const reach = s.range + (isKing ? 0.3 : isTent ? 0.2 : UNITS[target.type].radius * 0.6);
            if (best > reach) goal = [target.x, target.z];
            else {
                u.state = 1;
                u.rot = Math.atan2(target.x - u.x, target.z - u.z);
                if (u.cd <= 0) {
                    u.cd = s.cd;
                    const mult = isKing || isTent ? 1 : counter(u.type, target.type);
                    if (s.ranged) {
                        const to = [target.x, isKing ? target.y + 0.9 : isTent ? 2.2 : 0.9, target.z];
                        const hit = isKing ? { player: target.id } : isTent ? { def: 'tent', team: enemy } : { unit: target.id };
                        shoot(s.ranged, [u.x, 1.3, u.z], to, s.dmg * mult, hit, u.team);
                    } else {
                        if (isKing) damagePlayer(target, s.dmg, u.team);
                        else if (isTent) damageDefense(enemy, 'tent', s.dmg, u.team);
                        else damageUnit(target, s.dmg * mult, u.team);
                        fx.push(mult >= 2 ? { k: 'melee', id: u.id, crit: 1, p: [r2(target.x), 1, r2(target.z)] } : { k: 'melee', id: u.id });
                    }
                }
            }
        } else if (s.splash && !u.inside && (gun = artilleryTarget(u, s, u.cd <= 0))) {
            // 1 bis. canon : boulet explosif sur le paquet de troupes ennemies le plus serré à portée
            u.state = 1;
            u.rot = Math.atan2(gun.x - u.x, gun.z - u.z);
            if (u.cd <= 0 && game.phase === 'playing') {
                u.cd = s.cd;
                const from = [u.x + Math.sin(u.rot) * 1.1, 1.0, u.z + Math.cos(u.rot) * 1.1];
                shoot('ball', from, [gun.x, 0.3, gun.z], s.splash.dmg, { splash: { x: gun.x, z: gun.z, team: enemy, r: s.splash.r } }, u.team);
                fx.push({ k: 'fire', id: u.id });
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
        } else if (order !== 'attack' && !(order === 'follow' && orderKing(u.team) && nearBarricade(enemy, u.x, u.z))) {
            // ordres « défendre » / « suivre le roi » (sauf barricades ennemies sur le chemin de l'escorte : on les abat)
            goal = orderGoal(u, s);
            ordered = true;
            if (!goal) u.state = 0;
        } else if (!s.ranged && game.def[enemy].barricade && nearBarricade(enemy, u.x, u.z)) {
            // 3. des barricades barrent l'approche du pont-levis : il faut les abattre pour passer
            u.state = 2;
            const g = toWorld(enemy, 0, 0, 9);
            u.rot = Math.atan2(g[0] - u.x, g[2] - u.z);
            if (u.cd <= 0 && game.phase === 'playing') {
                u.cd = s.cd;
                damageDefense(enemy, 'barricade', u.type === 'ram' ? s.castleDmg : s.dmg, u.team);
                const thorns = DEFENSES.barricade.levels[game.def[enemy].barricade]?.thorns;
                if (thorns) damageUnit(u, thorns, enemy);
                fx.push(u.type === 'ram' ? { k: 'fire', id: u.id } : { k: 'melee', id: u.id, p: [r2(u.x), 0.6, r2(u.z + (enemy === 'red' ? -0.7 : 0.7))] });
            }
        } else if (u.type === 'catapult' && (siegeAim = siegeTarget(u, enemy, s.range))) {
            // 3 bis. l'engin de siège pilonne d'abord les obstacles à portée : chapiteau, puis barricades
            u.state = 2;
            u.rot = Math.atan2(siegeAim.x - u.x, siegeAim.z - u.z);
            if (u.cd <= 0 && game.phase === 'playing') {
                u.cd = s.cd;
                shoot('stone', [u.x, 2.4, u.z], [siegeAim.x, siegeAim.y, siegeAim.z], s.castleDmg, { def: siegeAim.key, team: enemy }, u.team);
                fx.push({ k: 'fire', id: u.id });
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
                        // porte fermée : soldats et chevaliers font moins de dégâts… pas le bélier, fait pour ça
                        const mult = !game.door[enemy] && u.type !== 'ram' ? 0.4 : 1;
                        damageCastle(enemy, s.castleDmg * mult);
                        fx.push(u.type === 'ram' ? { k: 'fire', id: u.id } : { k: 'melee', id: u.id, p: [r2(u.x), r2(rnd(1.5, 3)), r2(u.z + d * 0.8)] });
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
            if (!target && !u.inside && !ordered && waypointReached(u, l)) u.wp++;
            else if (l > 0) {
                const m = Math.min(l, s.speed * dt);
                u.x += dx / l * m; u.z += dz / l * m;
                u.rot = Math.atan2(dx, dz);
            }
        }
        u.walking = !!goal;
        u.prev = [px, pz];
    }

    // séparation pour que les unités ne s'empilent pas : les petites s'écartent devant les grosses (engins de siège),
    // et une troupe en marche glisse sur le côté de celle qui la gêne au lieu de la pousser de face
    for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < units.length; i++) {
            for (let j = i + 1; j < units.length; j++) {
                const a = units[i], b = units[j];
                const ra = UNITS[a.type].radius, rb = UNITS[b.type].radius;
                const min = (ra + rb) * 0.9;
                let dx = b.x - a.x, dz = b.z - a.z, dd = Math.hypot(dx, dz);
                if (dd >= min) continue;
                if (dd < 0.001) { const ang = (a.id * 7 + b.id) % 6.28; dx = Math.cos(ang) * 0.01; dz = Math.sin(ang) * 0.01; dd = 0.01; }
                const nx = dx / dd, nz = dz / dd, over = min - dd;
                const ma = ra * ra, mb = rb * rb;
                const pa = over * mb / (ma + mb), pb = over * ma / (ma + mb);
                a.x -= nx * pa; a.z -= nz * pa;
                b.x += nx * pb; b.z += nz * pb;
                // glissement latéral (même équipe, au moins l'une en marche)
                if (a.team === b.team && (a.walking || b.walking)) {
                    const side = ((a.id + b.id) & 1) ? 1 : -1, slide = over * 0.35;
                    if (a.walking) { a.x -= nz * slide * side; a.z += nx * slide * side; }
                    if (b.walking) { b.x += nz * slide * side; b.z -= nx * slide * side; }
                }
            }
        }
    }
    // troupe qui veut avancer mais n'avance presque plus : elle est bloquée par la foule
    for (const u of units) {
        if (!u.prev) continue;
        const moved = Math.hypot(u.x - u.prev[0], u.z - u.prev[1]);
        u.blocked = u.walking && moved < UNITS[u.type].speed * dt * 0.3 ? (u.blocked || 0) + dt : 0;
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
            const tw0 = DEFENSES.towers.levels[game.def[t].towers];
            const stand = game.hp[t] < CASTLE_HP * LAST_STAND.below && !game.broken[t];
            const tw = stand ? { ...tw0, cd: tw0.cd * LAST_STAND.cd, range: tw0.range + LAST_STAND.range } : tw0;
            if (stand && !game.lastStand[t]) {
                game.lastStand[t] = true;
                broadcast({ t: 'msg', text: `🛡️ Le château ${whoOf(t)} est en danger : ses défenseurs redoublent d'ardeur, les tours tirent plus vite !` });
            }
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
                        shoot('arrow', toWorld(t, tx, ty, tz), [target.x, isKing ? target.y + 0.9 : 0.9, target.z], isKing ? tw.dmg * KING_ARMOR : tw.dmg,
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
                        for (const p of kingVictims) damagePlayer(p, oil.dmg * KING_ARMOR, t);
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
        else if (p.target.splash) splashHit(p.target.splash, p.dmg, p.attacker);
        else if (p.target.def) damageDefense(p.target.team, p.target.def, p.dmg, p.attacker);
        else if (p.target.castle) damageCastle(p.target.castle, p.dmg);
    }
    game.pending = game.pending.filter(p => p.time > 0);

    // morts + primes
    for (const u of units) {
        if (u.hp > 0) continue;
        if (u.lastHitBy) earn(u.lastHitBy, UNITS[u.type].bounty);
        const killer = u.lastHitBy || u.killedBy;
        if (killer && killer !== u.team) game.stats[killer].killed++;
        game.stats[u.team].lost++;
        fx.push({ k: 'die', id: u.id, p: [r2(u.x), 0, r2(u.z)] });
    }
    game.units = units.filter(u => u.hp > 0);

    // sorts : recharges et dragons
    for (const t of TEAMS) for (const k of MAGE_KEYS) game.spellCd[t][k] = Math.max(0, game.spellCd[t][k] - dt);
    for (const t of TEAMS) for (const k of ['barricade', 'tent']) game.defCd[t][k] = Math.max(0, game.defCd[t][k] - dt);
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
        or: TEAMS.map(t => ORDERS.indexOf(game.orders[t].mode)),
        mg: TEAMS.map(t => MAGE_KEYS.map(k => (game.mage[t][k] ? 1 : 0))),
        sc: TEAMS.map(t => MAGE_KEYS.map(k => Math.ceil(game.spellCd[t][k]))),
        dr: game.dragons.map(dg => [dg.id, dg.team === 'red' ? 0 : 1, r2(dg.x), r2(dg.z), r2(dg.ry), dg.breath ? 1 : 0, dg.t <= 0 ? 1 : 0]),
        dc: TEAMS.map(t => ['barricade', 'tent'].map(k => Math.ceil(game.defCd[t][k]))),
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
        units: UNITS, types: TYPES, counters: COUNTERS, defenses: DEFENSES, defKeys: DEF_KEYS, mages: MAGES, mageKeys: MAGE_KEYS, dragonY: DRAGON_Y, castleHp: CASTLE_HP, kingHp: KING_HP, queueMax: QUEUE_MAX, lan: lanAddresses(),
    });
    console.log(`Joueur ${id} → salon ${room.id} (équipe ${team})`);

    if (room.solo) {
        newGame('waiting');
        game.ai = { red: team !== 'red', blue: team !== 'blue' };
        game.level = m.tutorial ? 'easy' : LEVELS[m.level] ? m.level : 'normal';
        startGame();
        game.peace = !!m.tutorial;
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
        case 'shout':
            shout(p, m.i);
            break;
        case 'tutorialDone':
            game.peace = false;
            break;
        case 'order':
            if (typeof m.mode === 'string' && ORDERS.includes(m.mode)) setOrder(p.team, m.mode, p.id);
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

// compression des messages (permessage-deflate) : les instantanés envoyés 20 fois par seconde se ressemblent beaucoup
// d'un envoi à l'autre, ils se compressent très bien (moins de données pour les connexions lentes et pour l'hébergeur)
const wss = new WebSocketServer({
    server,
    perMessageDeflate: {
        zlibDeflateOptions: { level: 3, memLevel: 7 },
        threshold: 256,                    // les tout petits messages partent tels quels
        clientNoContextTakeover: true,     // les messages des joueurs sont minuscules : on épargne leur mémoire
    },
});
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
            try { if (p) gameMessage(p, m); } catch (err) { console.error(`Erreur sur un message (salon ${room.id}) :`, err); }
        });
    });

    ws.on('close', () => {
        visitors.delete(ws);
        if (room && id !== null && rooms.has(room.id)) leaveRoom(room, id);
    });
});

// un bug dans un salon ne doit jamais faire tomber tout le serveur (et les autres parties avec lui)
setInterval(() => {
    for (const room of rooms.values()) {
        withRoom(room, () => {
            try {
                step(TICK);
                if (humans('red') + humans('blue')) broadcast(snapshot());
            } catch (err) {
                console.error(`Erreur dans le salon ${room.id} :`, err);
            }
            fx = [];
        });
    }
}, TICK * 1000);
process.on('uncaughtException', err => {
    if (err.code === 'EADDRINUSE') {                    // port déjà pris : inutile de continuer sans écouter
        console.error(`Le port ${PORT} est déjà utilisé (un autre serveur tourne déjà ?)`);
        process.exit(1);
    }
    console.error('Erreur inattendue :', err);
});
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

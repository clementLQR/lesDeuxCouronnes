import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
    initWorld, buildRoom, buildToyCastle, buildLionCastle, animateFigure, makePlayerModel, makeUnitModel, makeWarDragon,
    colliders, groundColliders, flags, flames, spinners, mists, TEAM, plastic,
} from './world.js';

// =====================================================================
//  Les Deux Couronnes : deux châteaux face à face
// =====================================================================

const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#f6e7d2');
scene.fog = new THREE.FogExp2('#ece6dc', 0.0055);   // légère brume : le fond de la chambre s'estompe doucement

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.45;

const camera = new THREE.PerspectiveCamera(55, 2, 0.1, 400);

scene.add(new THREE.HemisphereLight('#fff6e8', '#b59b7c', 1.1));
// le soleil suit le joueur pour garder des ombres nettes sur un grand terrain
const sun = new THREE.DirectionalLight('#fff1dc', 2.4);
const SUN_OFFSET = new THREE.Vector3(18, 32, 22);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = -32; sc.right = 32; sc.top = 32; sc.bottom = -32; sc.near = 1; sc.far = 110;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

// ---------------------------------------------------------------- le monde
initWorld(scene);
buildRoom();
// chaque château reproduit un des deux jouets des photos
const castles = { red: buildToyCastle('red'), blue: buildLionCastle('blue') };
castles.red.group.position.set(0, 0, -40);
castles.blue.group.position.set(0, 0, 40);
castles.blue.group.rotation.y = Math.PI;
scene.updateMatrixWorld(true);

// salles des coffres (au pied de la tour arrière droite de chaque château)
const vaults = Object.values(castles).map(c => ({ castle: c, pos: c.group.localToWorld(c.vaultLocal.clone()), r: c.vaultRadius }));
let inVault = null;

// repère local d'un château -> monde (identique au serveur)
function toWorld(team, lx, ly, lz) {
    return team === 'red' ? new THREE.Vector3(lx, ly, -40 + lz) : new THREE.Vector3(-lx, ly, 40 - lz);
}

// ---------------------------------------------------------------- raycasts
const ray = new THREE.Raycaster();
const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);
const tmpO = new THREE.Vector3();

function castRay(origin, dir, far, list = colliders) {
    ray.set(origin, dir);
    ray.far = far;
    const hits = ray.intersectObjects(list, true);
    return hits.length ? hits[0] : null;
}
function groundAt(x, y, z) {
    tmpO.set(x, y, z);
    const h = castRay(tmpO, DOWN, 80);
    return h ? h.point.y : -100;
}
// sol simplifié pour les unités (socles, rampes, ponts-levis, parquet)
function unitGround(x, z) {
    tmpO.set(x, 3, z);
    const h = castRay(tmpO, DOWN, 10, groundColliders);
    return h ? h.point.y : 0;
}

// =====================================================================
//  ÉTAT RÉSEAU
// =====================================================================
let myId = null, myTeam = 'red';
let UNITS = null, TYPES = [], CASTLE_HP = 2500, KING_HP = 300, QUEUE_MAX = 5, DEFENSES = {}, DEF_KEYS = [];
let kingDead = false, deadTimer = 0;
let MAGES = {}, MAGE_KEYS = [], DRAGON_Y = 8, aiming = false;
let inMenu = true, menuTeam = 'red', menuLevel = 'normal', myRoom = null, lastAction = 'multi';
let phase = 'connecting', winner = null;
let myGold = 0;
let lastHp = [CASTLE_HP, CASTLE_HP];

const el = id => document.getElementById(id);
const ui = {
    gold: el('goldVal'), btns: el('btns'), hpRed: el('hpRed'), hpBlue: el('hpBlue'),
    hpRedTxt: el('hpRedTxt'), hpBlueTxt: el('hpBlueTxt'), lobby: el('lobby'), lobbyText: el('lobbyText'),
    lan: el('lan'), menuBtn: el('menuBtn'), over: el('over'), overTitle: el('overTitle'), overText: el('overText'),
    again: el('again'), toast: el('toast'), prompt: el('prompt'), promptText: el('promptText'),
    minimap: el('minimap'),
    kingFill: el('kingFill'), kingTxt: el('kingTxt'), crownMsg: el('crownMsg'), crownTime: el('crownTime'),
};

// Le serveur de jeu est d'abord cherché à l'adresse de la page. En local, si la page est servie par autre chose
// (Live Server de VS Code…), on essaie aussi le serveur Node sur le port 3000 (jamais une fois le site en ligne).
// Un serveur ne compte que s'il répond « hello » : Live Server accepte aussi les WebSocket, mais pour recharger la page.
// En ligne, un serveur endormi (offre gratuite de Render) met plusieurs secondes à se réveiller : on patiente,
// et tant que le château ne répond pas, on réessaie régulièrement.
// Attention : au chargement, la construction de la scène et la compilation des effets occupent le navigateur
// plusieurs secondes. Un minuteur « expiré » passerait alors avant la réponse du serveur et couperait une connexion
// qui marche : on n'en met donc un que pour démasquer Live Server (page servie par un autre port en local).
const online = location.protocol === 'https:';
const wsProto = online ? 'wss' : 'ws';
const wsHosts = [location.host || 'localhost:3000'];
const foreignPage = !online && location.port !== '' && location.port !== '3000';     // ex. Live Server (5500)
if (foreignPage) wsHosts.push(`${location.hostname || 'localhost'}:3000`);
let ws = null, retries = 0;

function connect(i = 0) {
    if (i >= wsHosts.length) {
        noServer();
        setTimeout(() => connect(0), Math.min(10000, 2000 + retries++ * 1000));
        return;
    }
    let sock, greeted = false;
    try { sock = new WebSocket(`${wsProto}://${wsHosts[i]}`); } catch { connect(i + 1); return; }
    const next = () => { clearTimeout(timer); clearTimeout(slow); sock.onclose = sock.onmessage = null; sock.close(); connect(i + 1); };
    // seule la page servie par un autre serveur local (Live Server) peut avoir une connexion ouverte qui ne répond
    // jamais « hello » : on lui laisse 4 s après l'ouverture avant d'essayer le port 3000
    let timer = null;
    if (foreignPage && i === 0) sock.onopen = () => { timer = setTimeout(() => { if (!greeted) next(); }, 4000); };
    const slow = setTimeout(() => { if (!greeted && myId === null) menuWaking(); }, 1500);
    sock.onmessage = e => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (!greeted) {
            if (m.t !== 'hello') return;
            greeted = true;
            clearTimeout(timer); clearTimeout(slow);
            ws = sock;
            retries = 0;
            menuOnline();
        }
        handlers[m.t]?.(m);
    };
    sock.onclose = () => {
        if (!greeted) { next(); return; }
        ws = null;
        if (myId === null) { noServer(); setTimeout(() => connect(0), 2000); return; }
        // en partie : le serveur a redémarré (mise à jour de l'hébergeur…) ou la connexion a coupé
        phase = 'offline';
        ui.over.classList.remove('show');
        ui.lobby.classList.add('show');
        ui.lobbyText.innerHTML = "🔌 Le lien avec le château s'est rompu…";
        ui.lan.textContent = "Le serveur a peut-être redémarré : reviens au menu pour relancer une partie.";
    };
}

function send(o) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(o));
}

function noServer() {
    phase = 'offline';
    menuOffline();
}

connect();

const handlers = {
    hello: updateMenu,
    rooms: updateMenu,
    refused(m) { menuRefused(m.text); },
    welcome(m) {
        inMenu = false;
        document.body.classList.remove('menu');
        myId = m.id; myTeam = m.team; UNITS = m.units; TYPES = m.types; CASTLE_HP = m.castleHp;
        KING_HP = m.kingHp; QUEUE_MAX = m.queueMax; myRoom = m.room; DEFENSES = m.defenses; DEF_KEYS = m.defKeys;
        MAGES = m.mages; MAGE_KEYS = m.mageKeys; DRAGON_Y = m.dragonY;
        buildSpells();
        lastHp = [CASTLE_HP, CASTLE_HP];
        setupPlayer();
        buildShop();
        document.body.dataset.team = myTeam;
        const where = (m.lan.length ? m.lan : [location.origin]).map(a => `<code>${a}</code>`).join(' ou ');
        ui.lan.innerHTML = `Ton adversaire ouvre ${where}<br>puis rejoint le salon <b>${escapeHtml(m.room.name)}</b>` +
            ` (code <b>${m.room.id}</b>)${m.room.locked ? ' avec le mot de passe 🔒' : ''}.`;
    },
    s: onSnapshot,
    start() {
        for (const c of Object.values(castles)) { restoreCastle(c); c.resetDefense(); }
        ui.over.classList.remove('show');
        toast("🎺 Sonnez trompettes ! Fais céder le pont-levis d'en face, puis file jusqu'à son trésor !", 5);
    },
    over(m) {
        winner = m.winner;
    },
    msg(m) { toast(m.text, 4); },
    knock(m) {
        knock.set(m.dx * 9, 0, m.dz * 9);
        vy = 5; onGround = false;
    },
    hurt() { flashDamage(); },
    // le roi est tombé : on attend le couronnement
    dead(m) {
        kingDead = true;
        deadTimer = m.time;
        if (player) player.root.visible = false;
        ui.crownMsg.classList.add('show');
    },
    // couronnement : on réapparaît sur le tapis royal de la cour
    respawn(m) {
        kingDead = false;
        ui.crownMsg.classList.remove('show');
        pos.set(m.x, m.y, m.z);
        if (player) {
            pos.y = groundAt(pos.x, pos.y + 2, pos.z);
            visualY = pos.y;
            player.root.visible = true;
            player.root.position.copy(pos);
        }
        vy = 0; onGround = true; knock.set(0, 0, 0);
    },
};

// =====================================================================
//  LE JOUEUR
// =====================================================================
const RADIUS = 0.35, STEP = 0.42, GRAVITY = 20, JUMP = 7.2;
let player = null;
let start = toWorld('red', 0, 1, 0.5);
const pos = start.clone();
let vy = 0, onGround = false, visualY = pos.y, facing = 0, moving = 0;
const knock = new THREE.Vector3();
const dirV = new THREE.Vector3();

function setupPlayer() {
    if (player) scene.remove(player.root);
    player = makePlayerModel(myTeam);   // le roi du Lion ou le seigneur de guerre du Crâne
    player.root.traverse(o => { if (o.isMesh) { o.castShadow = true; } });
    scene.add(player.root);
    start = toWorld(myTeam, 0, 1, 0.5);        // le tapis du couronnement
    pos.copy(start);
    pos.y = groundAt(pos.x, 6, pos.z);
    visualY = pos.y;
    vy = 0; onGround = true;
    // caméra derrière le chevalier, tournée vers le château ennemi
    yaw = myTeam === 'red' ? Math.PI : 0;
    facing = myTeam === 'red' ? 0 : Math.PI;
    player.root.rotation.y = facing;
}

function blocked(p, dir, dist) {
    const px = -dir.z, pz = dir.x;
    for (const h of [STEP + 0.05, 0.95]) {
        for (const o of [-0.8 * RADIUS, 0, 0.8 * RADIUS]) {
            tmpO.set(p.x + px * o, p.y + h, p.z + pz * o);
            if (castRay(tmpO, dir, dist + RADIUS)) return true;
        }
    }
    return false;
}
function tryMove(dx, dz) {
    const d = Math.hypot(dx, dz);
    if (d < 1e-6) return false;
    dirV.set(dx / d, 0, dz / d);
    if (blocked(pos, dirV, d)) return false;
    pos.x += dx; pos.z += dz;
    return true;
}
function move(dx, dz) {
    if (!tryMove(dx, dz)) { if (!tryMove(dx, 0)) tryMove(0, dz); }
}

function nearOwnGate() {
    const g = toWorld(myTeam, 0, 0, 9);
    return !kingDead && Math.hypot(pos.x - g.x, pos.z - g.z) < 5 && pos.y < 3;
}

const keys = {};
let jumpRequest = false;

function updatePlayer(dt) {
    if (kingDead) {
        deadTimer = Math.max(0, deadTimer - dt);
        ui.crownTime.textContent = Math.ceil(deadTimer);
        return;
    }
    let ix = 0, iz = 0;
    if (keys.KeyW || keys.ArrowUp) iz += 1;
    if (keys.KeyS || keys.ArrowDown) iz -= 1;
    if (keys.KeyA || keys.ArrowLeft) ix -= 1;
    if (keys.KeyD || keys.ArrowRight) ix += 1;
    const run = keys.ShiftLeft || keys.ShiftRight;
    const speed = run ? 7 : 4;

    if (ix || iz) {
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
        const rx = Math.cos(yaw), rz = -Math.sin(yaw);
        let mx = fx * iz + rx * ix, mz = fz * iz + rz * ix;
        const l = Math.hypot(mx, mz);
        mx = mx / l * speed * dt; mz = mz / l * speed * dt;
        move(mx, mz);
        facing = Math.atan2(mx, mz);
    }
    // recul quand un ennemi nous frappe
    if (knock.lengthSq() > 0.01) {
        move(knock.x * dt, knock.z * dt);
        knock.multiplyScalar(Math.exp(-4 * dt));
    }
    moving = THREE.MathUtils.lerp(moving, (ix || iz) ? (run ? 1.3 : 1) : 0, 1 - Math.exp(-12 * dt));

    const g = groundAt(pos.x, pos.y + 0.9, pos.z);
    if (onGround) {
        if (g >= pos.y - STEP && g <= pos.y + STEP) { pos.y = g; vy = 0; }
        else if (g < pos.y - STEP) onGround = false;
    }
    if (jumpRequest && onGround) { vy = JUMP; onGround = false; }
    jumpRequest = false;
    if (!onGround) {
        vy -= GRAVITY * dt;
        pos.y += vy * dt;
        if (vy <= 0 && pos.y <= g) { pos.y = g; vy = 0; onGround = true; }
    }
    const r = Math.hypot(pos.x, pos.z);
    if (r > 90) { pos.x *= 90 / r; pos.z *= 90 / r; }
    if (pos.y < -10) { pos.copy(start); vy = 0; visualY = pos.y; }

    visualY = onGround ? THREE.MathUtils.lerp(visualY, pos.y, 1 - Math.exp(-20 * dt)) : pos.y;
    if (!player) return;
    player.root.position.set(pos.x, visualY, pos.z);
    let diff = facing - player.root.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    player.root.rotation.y += diff * (1 - Math.exp(-12 * dt));
    player.phase += dt * (run ? 14 : 10) * Math.min(1, moving);
    animateFigure(player, onGround ? Math.min(moving, 1) : 0.3, dt);
}

function attack() {
    if (!player || player.swing > 0 || kingDead) return;
    player.swing = 0.35;
    send({ t: 'attack' });
}

// ---------------------------------------------------------------- contrôles
window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || inMenu) return;
    keys[e.code] = true;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    if (e.repeat) return;
    if (e.code === 'Space') jumpRequest = true;
    if (e.code === 'KeyF') attack();
    if (e.code === 'Escape') setAiming(false);
    const spell = MAGE_KEYS.find(k => e.code === 'Key' + MAGES[k].key);
    if (spell) useSpell(spell);
    if (e.code === 'KeyE' && nearOwnGate() && !castles[myTeam].door.broken) send({ t: 'door' });
    const n = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'].indexOf(e.code);
    const n2 = ['Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5'].indexOf(e.code);
    const idx = n >= 0 ? n : n2;
    if (idx >= 0 && TYPES[idx]) send({ t: 'spawn', unit: TYPES[idx] });
    const d = ['Digit6', 'Digit7', 'Digit8', 'Digit9'].indexOf(e.code);
    const d2 = ['Numpad6', 'Numpad7', 'Numpad8', 'Numpad9'].indexOf(e.code);
    const di = d >= 0 ? d : d2;
    if (di >= 0 && DEF_KEYS[di]) send({ t: 'defense', key: DEF_KEYS[di] });
});
window.addEventListener('keyup', e => { keys[e.code] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

let yaw = Math.PI, pitch = 0.32, camDistWanted = 9, camDist = 9;
let dragging = false, lastX = 0, lastY = 0, dragDist = 0;
canvas.addEventListener('pointerdown', e => {
    dragging = true; dragDist = 0; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
});
const mouseNdc = new THREE.Vector2();
canvas.addEventListener('pointermove', e => {
    const r = canvas.getBoundingClientRect();
    mouseNdc.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    dragDist += Math.abs(dx) + Math.abs(dy);
    yaw -= dx * 0.006;
    pitch = THREE.MathUtils.clamp(pitch + dy * 0.005, -0.1, 1.35);
    lastX = e.clientX; lastY = e.clientY;
});
canvas.addEventListener('pointerup', () => {
    if (dragging && dragDist < 6) {
        if (aiming) fireAtAim();              // en visée : le clic lance la boule de feu
        else attack();                        // sinon, simple clic = coup d'épée
    }
    dragging = false;
});
canvas.addEventListener('contextmenu', e => { e.preventDefault(); setAiming(false); });
canvas.addEventListener('wheel', e => {
    e.preventDefault();
    camDistWanted = THREE.MathUtils.clamp(camDistWanted * (e.deltaY > 0 ? 1.1 : 0.9), 3, 45);
}, { passive: false });

ui.again.addEventListener('click', () => send({ t: 'restart' }));
// revenir au menu = recharger la page (on quitte proprement la partie côté serveur)
ui.menuBtn.addEventListener('click', () => location.reload());
el('overMenu').addEventListener('click', () => location.reload());

// ---------------------------------------------------------------- menu de démarrage
// écrans : accueil, partie solo, hall des salons ; fenêtres : créer un salon, rejoindre un salon
const escapeHtml = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const menuEl = el('menu');
const mui = {
    views: menuEl.querySelectorAll('.view'),
    roomGrid: el('roomList'), roomCount: el('roomCount'), lan: el('menuLan'),
    homeNote: el('homeNote'), soloBtn: el('soloBtn'), soloNote: el('soloNote'), multiNote: el('multiNote'),
    codeInput: el('codeInput'), codeBtn: el('codeBtn'),
    createModal: el('createModal'), roomName: el('roomName'), roomLocked: el('roomLocked'), roomPass: el('roomPass'),
    createBtn: el('createBtn'), createNote: el('createNote'),
    joinModal: el('joinModal'), joinTitle: el('joinTitle'), joinSeats: el('joinSeats'), joinInfo: el('joinInfo'),
    joinPass: el('joinPass'), joinBtn: el('joinBtn'), joinNote: el('joinNote'),
};
let rooms = [], roomFilter = 'all', joinRoomId = null, roomsKey = '';

function showView(name) {
    for (const v of mui.views) v.classList.toggle('active', v.dataset.view === name);
    closeModals();
    for (const n of [mui.soloNote, mui.multiNote]) n.textContent = '';
}
function openModal(modal) {
    closeModals();
    modal.classList.add('open');
}
function closeModals() {
    for (const m of menuEl.querySelectorAll('.modal.open')) m.classList.remove('open');
    joinRoomId = null;
    renderTeamPickers();
}

// ---- choix du château : les mêmes cartes dans l'écran solo et dans les deux fenêtres
const TEAM_CARDS = {
    red: { ico: '💀', name: 'Royaume du Crâne', sub: 'Pierre grise, bannières rouge et noir' },
    blue: { ico: '🦁', name: 'Royaume du Lion', sub: 'Pierre dorée, bannières bleu et or' },
};
function renderTeamPickers() {
    const room = joinRoomId && rooms.find(r => r.id === joinRoomId);
    for (const box of menuEl.querySelectorAll('[data-team-picker]')) {
        const inJoin = !!box.closest('#joinModal');
        box.innerHTML = ['red', 'blue'].map(t => {
            const c = TEAM_CARDS[t];
            const n = inJoin && room ? room.n[t === 'red' ? 0 : 1] : null;
            const sub = n === null ? c.sub : n >= 2 ? `Complet : tu rejoindras l'autre royaume` : `${n} / 2 roi${n > 1 ? 's' : ''}`;
            return `<button class="teamCard ${t} ${menuTeam === t ? 'sel' : ''}" data-team="${t}">
                <span class="tcIco">${c.ico}</span><span class="tcName">${c.name}</span><span class="tcSub">${sub}</span></button>`;
        }).join('');
    }
}
function setTeam(t) {
    menuTeam = t;
    document.body.dataset.team = t;
    renderTeamPickers();
}

// ---- places d'un salon : deux rois par château (🤖 = l'IA tient ce château)
function seatsHtml(r, big = false) {
    const side = (t, i) => {
        let html = '';
        for (let k = 0; k < 2; k++) {
            const human = k < r.n[i], bot = !human && k === 0 && r.ai && r.n[i] === 0 && r.phase === 'playing';
            html += `<span class="seat ${t} ${human ? 'on' : bot ? 'bot' : ''}">${human ? '👑' : bot ? '🤖' : ''}</span>`;
        }
        return html;
    };
    return `<div class="seats ${big ? 'big' : ''}"><div class="side"><span class="sideIco">💀</span>${side('red', 0)}</div>` +
        `<span class="vsMini">VS</span><div class="side">${side('blue', 1)}<span class="sideIco">🦁</span></div></div>`;
}
function roomState(r) {
    if (r.n[0] + r.n[1] >= 4) return ['full', '🚫 Complet'];
    if (r.phase === 'playing') return ['playing', '⚔️ En cours'];
    if (r.phase === 'over') return ['over', '🏁 Terminée'];
    return ['waiting', '⏳ En attente'];
}

// ---- hall des salons
function renderRooms() {
    const shown = rooms.filter(r => roomFilter === 'all' || (roomFilter === 'waiting' ? r.phase === 'waiting' : !r.locked));
    const create = `<button class="roomCard create" data-create><span class="plus">+</span><b>Ouvrir un salon</b><small>ouvert à tous ou gardé par un mot de passe</small></button>`;
    const empty = !shown.length
        ? `<div class="roomCard emptyRooms"><span>🕯️</span>${rooms.length ? "Aucun salon ne correspond à ce filtre." : "La salle est vide et silencieuse…<br>Ouvre le premier salon !"}</div>`
        : '';
    mui.roomGrid.innerHTML = create + empty + shown.map(r => {
        const [cls, label] = roomState(r);
        return `<button class="roomCard" data-room="${r.id}" ${cls === 'full' ? 'disabled' : ''}>
            <div class="rcTop"><span class="rcName">${escapeHtml(r.name)}</span>${r.locked ? '<span class="rcLock" title="Mot de passe">🔒</span>' : ''}</div>
            ${seatsHtml(r)}
            <div class="rcBottom"><span class="chip ${cls}">${label}</span><span class="rcCode">#${r.id}</span></div>
        </button>`;
    }).join('');
}

function updateMenu(m) {
    if (!inMenu) return;
    mui.lan.innerHTML = (m.lan.length ? m.lan : [location.origin]).map(a => `<code>${a}</code>`).join(' · ');
    mui.roomCount.textContent = m.rooms.length ? `${m.rooms.length} salon${m.rooms.length > 1 ? 's' : ''}` : '';
    const key = JSON.stringify(m.rooms);
    if (key === roomsKey) return;
    roomsKey = key;
    rooms = m.rooms;
    renderRooms();
    if (joinRoomId) refreshJoin();
}

// ---- fenêtre « rejoindre »
function openJoin(id) {
    openModal(mui.joinModal);
    joinRoomId = id;
    mui.joinPass.value = '';
    mui.joinNote.textContent = '';
    refreshJoin();
    (mui.joinPass.hidden ? mui.joinBtn : mui.joinPass).focus();
}
function refreshJoin() {
    const r = rooms.find(o => o.id === joinRoomId);
    if (!r) {
        mui.joinNote.textContent = "Ce salon vient de fermer ses portes.";
        mui.joinBtn.disabled = true;
        return;
    }
    const [, label] = roomState(r);
    mui.joinTitle.textContent = `${r.locked ? '🔒 ' : ''}${r.name}`;
    mui.joinSeats.innerHTML = seatsHtml(r, true);
    mui.joinInfo.textContent = `${label} · code #${r.id}`;
    mui.joinPass.hidden = !r.locked;
    mui.joinBtn.disabled = r.n[0] + r.n[1] >= 4;
    renderTeamPickers();
}

// ---- messages du serveur pour le menu
function menuRefused(text) {
    (lastAction === 'solo' ? mui.soloNote : lastAction === 'create' ? mui.createNote : lastAction === 'join' ? mui.joinNote : mui.multiNote).textContent = text;
}
const MENU_BUTTONS = '#menu .tile, #soloBtn, #createBtn, #joinBtn';
function menuOffline() {
    for (const b of document.querySelectorAll(MENU_BUTTONS)) b.disabled = true;
    el('homeNote').innerHTML = `Le château ne répond pas 😢 Le jeu a besoin de son serveur, même en solo. Nouvelle tentative en cours…`;
    el('menuLan').textContent = '—';
}
// serveur en ligne qui se réveille (offre gratuite) : on prévient que ça peut prendre un moment
function menuWaking() {
    for (const b of document.querySelectorAll(MENU_BUTTONS)) b.disabled = true;
    el('homeNote').innerHTML = `⏳ Le château se réveille… (jusqu'à une minute si personne n'a joué depuis un moment)`;
}
function menuOnline() {
    for (const b of document.querySelectorAll(MENU_BUTTONS)) b.disabled = false;
    el('homeNote').textContent = '';
}

// ---- interactions (un seul écouteur pour tout le menu)
menuEl.addEventListener('click', e => {
    const t = e.target;
    const go = t.closest('[data-go]');
    if (go && !go.disabled) { showView(go.dataset.go); return; }
    const team = t.closest('.teamCard');
    if (team) { setTeam(team.dataset.team); return; }
    const level = t.closest('.levelCard');
    if (level) {
        menuLevel = level.dataset.level;
        for (const o of menuEl.querySelectorAll('.levelCard')) o.classList.toggle('sel', o === level);
        return;
    }
    const filter = t.closest('[data-filter]');
    if (filter) {
        roomFilter = filter.dataset.filter;
        for (const o of menuEl.querySelectorAll('[data-filter]')) o.classList.toggle('sel', o === filter);
        renderRooms();
        return;
    }
    if (t.closest('[data-create]')) {
        openModal(mui.createModal);
        mui.createNote.textContent = '';
        mui.roomName.focus();
        return;
    }
    const room = t.closest('[data-room]');
    if (room && !room.disabled) { openJoin(room.dataset.room); return; }
    // fermeture d'une fenêtre : bouton ✕ ou clic sur le fond
    if (t.closest('[data-close]') || t.classList.contains('modal')) closeModals();
});
window.addEventListener('keydown', e => { if (inMenu && e.key === 'Escape') closeModals(); });

mui.soloBtn.addEventListener('click', () => {
    lastAction = 'solo';
    mui.soloNote.textContent = '';
    send({ t: 'solo', team: menuTeam, level: menuLevel });
});

mui.roomLocked.addEventListener('change', () => {
    mui.roomPass.hidden = !mui.roomLocked.checked;
    if (mui.roomLocked.checked) mui.roomPass.focus();
});
mui.createBtn.addEventListener('click', () => {
    lastAction = 'create';
    const locked = mui.roomLocked.checked;
    if (locked && !mui.roomPass.value) { mui.createNote.textContent = "Choisis un mot de passe pour garder ton salon secret."; mui.roomPass.focus(); return; }
    mui.createNote.textContent = '';
    send({ t: 'create', name: mui.roomName.value, password: locked ? mui.roomPass.value : '', team: menuTeam });
});
for (const input of [mui.roomName, mui.roomPass]) input.addEventListener('keydown', e => { if (e.key === 'Enter') mui.createBtn.click(); });

mui.joinBtn.addEventListener('click', () => {
    lastAction = 'join';
    const r = rooms.find(o => o.id === joinRoomId);
    if (!r) return;
    if (r.locked && !mui.joinPass.value) { mui.joinNote.textContent = "Halte ! Ce salon demande le mot de passe secret 🔒"; mui.joinPass.focus(); return; }
    mui.joinNote.textContent = '';
    send({ t: 'join', room: r.id, password: mui.joinPass.value, team: menuTeam });
});
mui.joinPass.addEventListener('keydown', e => { if (e.key === 'Enter') mui.joinBtn.click(); });

// rejoindre directement avec le code donné par un ami
mui.codeInput.addEventListener('input', () => { mui.codeInput.value = mui.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
mui.codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') mui.codeBtn.click(); });
mui.codeBtn.addEventListener('click', () => {
    lastAction = 'multi';
    const code = mui.codeInput.value.trim();
    if (rooms.some(r => r.id === code)) { mui.multiNote.textContent = ''; openJoin(code); }
    else mui.multiNote.textContent = code ? `Aucun salon ne porte le code #${code}.` : "Entre le code à 4 lettres donné par ton ami.";
});

renderTeamPickers();
renderRooms();

// caméra qui tourne lentement autour du champ de bataille pendant le menu
function menuCamera(t) {
    const a = t * 0.06;
    camera.position.set(Math.sin(a) * 72, 34, Math.cos(a) * 72);
    camera.lookAt(0, 4, 0);
}

// ---------------------------------------------------------------- caméra
const camTarget = new THREE.Vector3();
const camOff = new THREE.Vector3();
function updateCamera(dt) {
    camTarget.set(pos.x, visualY + 1.0, pos.z);
    camOff.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    const hit = castRay(camTarget, camOff, camDistWanted);
    const d = hit ? Math.max(0.8, hit.distance - 0.3) : camDistWanted;
    camDist = d < camDist ? d : THREE.MathUtils.lerp(camDist, d, 1 - Math.exp(-4 * dt));
    camera.position.copy(camTarget).addScaledVector(camOff, camDist);
    if (camera.position.y < 0.3) camera.position.y = 0.3;
    camera.lookAt(camTarget);
}

// =====================================================================
//  UNITÉS (simulées par le serveur, interpolées ici)
// =====================================================================
const unitObjs = new Map();
const barBgGeo = new THREE.PlaneGeometry(1.0, 0.14);
const barFillGeo = new THREE.PlaneGeometry(1.0, 0.1).translate(0.5, 0, 0);
const barBgMat = new THREE.MeshBasicMaterial({ color: '#222', depthWrite: false });
const barMats = { red: new THREE.MeshBasicMaterial({ color: TEAM.red.main }), blue: new THREE.MeshBasicMaterial({ color: TEAM.blue.main }) };

function makeBar(team, y, scale) {
    const bar = new THREE.Group();
    const bg = new THREE.Mesh(barBgGeo, barBgMat);
    const fill = new THREE.Mesh(barFillGeo, barMats[team]);
    fill.position.set(-0.5, 0, 0.01);
    bar.add(bg, fill);
    bar.position.y = y;
    bar.scale.setScalar(scale);
    bar.visible = false;
    return { bar, fill };
}
function showBar(bar, fill, hp, root) {
    bar.visible = hp < 100;
    if (!bar.visible) return;
    fill.scale.x = Math.max(0.001, hp / 100);
    bar.quaternion.copy(root.quaternion).invert().multiply(camera.quaternion);
}

function createUnit(id, type, team, x, z, rot) {
    const model = makeUnitModel(type, team);
    const big = type === 'cannon' || type === 'catapult';
    model.root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const { bar, fill } = makeBar(team, type === 'catapult' ? 2.6 : big ? 1.9 : 1.95, big ? 1.4 : 0.8);
    model.root.add(bar);
    model.root.position.set(x, unitGround(x, z), z);
    model.root.rotation.y = rot;
    scene.add(model.root);
    const u = { id, type, team, model, bar, fill, x, z, tx: x, tz: z, rot, hp: 100, state: 0, big, seen: true };
    unitObjs.set(id, u);
    return u;
}

// =====================================================================
//  SORTS DES TOURS DE MAGE
// =====================================================================
function buildSpells() {
    const box = el('spellBtns');
    box.innerHTML = '';
    for (const key of MAGE_KEYS) {
        const m = MAGES[key];
        const b = document.createElement('button');
        b.className = 'spellBtn locked';
        b.dataset.spell = key;
        b.title = SPELL_HELP[key](m);
        b.innerHTML = `<span class="skey">${m.key}</span><span class="sico">${m.icon}</span><span class="scd"></span>` +
            `<span class="sname">${m.spell}</span><span class="scost"></span>`;
        b.addEventListener('click', () => { useSpell(key); b.blur(); });
        box.appendChild(b);
    }
}
const SPELL_HELP = {
    potion: m => `${m.tower} (${m.build} pour la bâtir) : ${m.spell}, rend ${m.heal} PV à ton roi. ${m.cost} pièces, recharge ${m.cd} s.`,
    fireball: m => `${m.tower} (${m.build} pour la bâtir) : ${m.spell}. Vise le champ de bataille et clique : elle brûle les troupes et obstacles ennemis. ${m.cost} pièces, recharge ${m.cd} s.`,
    dragon: m => `${m.tower} (${m.build} pour la bâtir) : invoque ton dragon pendant ${m.duration} s. Il chasse les troupes ennemies et réduit en cendres toutes celles qu'il survole, sans toucher aux constructions (elles ne rapportent pas d'or). ${m.cost} pièces, recharge ${m.cd} s.`,
};
function useSpell(key) {
    if (!lastSnap || kingDead || phase !== 'playing') return;
    const built = lastSnap.mg[myTeam === 'red' ? 0 : 1][MAGE_KEYS.indexOf(key)];
    if (!built) { send({ t: 'mage', key }); return; }               // pas encore de tour : on la bâtit
    if (key === 'fireball') { setAiming(!aiming); return; }
    send({ t: 'spell', key });
}
// visée de la boule de feu : un cercle de feu suit la souris sur le sol
const aimRing = new THREE.Mesh(new THREE.RingGeometry(3.2, 3.5, 48), new THREE.MeshBasicMaterial({
    color: '#ff7a1a', transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide,
}));
aimRing.rotation.x = -Math.PI / 2;
aimRing.visible = false;
scene.add(aimRing);
const aimPoint = new THREE.Vector3();
let aimValid = false;
const aimRay = new THREE.Raycaster();
function setAiming(on) {
    aiming = on;
    aimRing.visible = on && aimValid;
    el('aimMsg').classList.toggle('show', on);
    canvas.style.cursor = on ? 'crosshair' : '';
    for (const b of document.querySelectorAll('.spellBtn[data-spell="fireball"]')) b.classList.toggle('aiming', on);
}
function updateAim() {
    if (!aiming) return;
    aimRay.setFromCamera(mouseNdc, camera);
    const hit = aimRay.intersectObjects(groundColliders, true)[0];
    aimValid = !!hit;
    if (hit) aimPoint.copy(hit.point);
    aimRing.visible = aimValid;
    aimRing.position.copy(aimPoint).setY(aimPoint.y + 0.08);
    const s = (MAGES.fireball?.radius || 3.5) / 3.5;
    aimRing.scale.setScalar(s * (1 + Math.sin(performance.now() / 150) * 0.04));
}
function fireAtAim() {
    if (aimValid) send({ t: 'spell', key: 'fireball', x: +aimPoint.x.toFixed(2), z: +aimPoint.z.toFixed(2) });
    setAiming(false);
}

// dragons en vol (simulés par le serveur, animés ici)
const dragonObjs = new Map();
function syncDragons(list) {
    const seen = new Set();
    for (const [id, ti, x, z, ry, breath, leaving] of list) {
        seen.add(id);
        let d = dragonObjs.get(id);
        if (!d) {
            const m = makeWarDragon(ti ? 'blue' : 'red');
            m.root.position.set(x, DRAGON_Y + 5, z);
            m.root.rotation.y = ry;
            scene.add(m.root);
            puff(m.root.position.clone(), ti ? '#9cc4ff' : '#ff9a7a', 14, 2.5, 1.5);
            d = { m, team: ti ? 'blue' : 'red' };
            dragonObjs.set(id, d);
        }
        Object.assign(d, { tx: x, tz: z, ry, breath, leaving });
    }
    for (const [id, d] of dragonObjs) {
        if (seen.has(id)) continue;
        puff(d.m.root.position.clone(), '#f4f1ea', 12, 2.5, 1.5);
        scene.remove(d.m.root);
        if (d.fire) scene.remove(d.fire);
        dragonObjs.delete(id);
    }
}
const tmpMouth = new THREE.Vector3();
// cône de flammes (pointe à la gueule, axe +z), étiré jusqu'au sol à chaque image
const fireConeGeo = new THREE.ConeGeometry(1.1, 4, 20, 1, true).translate(0, -2, 0).rotateX(-Math.PI / 2);
const fireMatOuter = new THREE.MeshBasicMaterial({ color: '#ff5a12', transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide });
const fireMatInner = new THREE.MeshBasicMaterial({ color: '#ffc23a', transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide });
let breathTimer = 0;
function updateDragons(dt, t) {
    breathTimer -= dt;
    const emit = breathTimer <= 0;
    if (emit) breathTimer = 0.07;
    for (const d of dragonObjs.values()) {
        const r = d.m.root, k = 1 - Math.exp(-3 * dt);
        const ty = DRAGON_Y + (d.leaving ? 12 : d.breath ? -2.2 : 0) + Math.sin(t * 2 + d.m.phase) * 0.4;
        r.position.x += (d.tx - r.position.x) * k;
        r.position.z += (d.tz - r.position.z) * k;
        r.position.y += (ty - r.position.y) * k * 0.7;
        let diff = d.ry - r.rotation.y;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        r.rotation.y += diff * (1 - Math.exp(-4 * dt));
        d.m.model.rotation.z = THREE.MathUtils.clamp(-diff * 0.8, -0.4, 0.4);       // il penche dans les virages
        const flap = Math.sin(t * 7 + d.m.phase);
        d.m.wings[0].rotation.z = -flap * 0.6;
        d.m.wings[1].rotation.z = flap * 0.6;
        d.m.tail.forEach((seg, i) => { seg.rotation.y = Math.sin(t * 3 - i * 0.7) * 0.18; });
        d.m.head.rotation.x = d.breath ? 0.45 : Math.sin(t * 1.5) * 0.08;          // il baisse la tête pour cracher
        // souffle : cône de flammes de la gueule jusqu'au sol, devant lui
        if (!d.fire) {
            d.fire = new THREE.Group();
            d.fire.add(new THREE.Mesh(fireConeGeo, fireMatOuter), new THREE.Mesh(fireConeGeo, fireMatInner));
            d.fire.children[1].scale.set(0.5, 0.5, 0.95);
            scene.add(d.fire);
        }
        d.fire.visible = !!d.breath;
        if (d.breath) {
            d.m.mouth.getWorldPosition(tmpMouth);
            const ground = new THREE.Vector3(r.position.x + Math.sin(r.rotation.y) * 2, unitGround(r.position.x, r.position.z) + 0.1, r.position.z + Math.cos(r.rotation.y) * 2);
            d.fire.position.copy(tmpMouth);
            d.fire.lookAt(ground);
            const len = tmpMouth.distanceTo(ground), flick = 1 + Math.sin(t * 40) * 0.08 + Math.sin(t * 23) * 0.06;
            d.fire.scale.set(flick, flick, len / 4);
            if (emit) {
                for (let i = 0; i < 2; i++) {
                    const a = Math.random() * Math.PI * 2, rr = Math.random() * 2.2;
                    puff(ground.clone().add(new THREE.Vector3(Math.cos(a) * rr, 0, Math.sin(a) * rr)), ['#ffb02e', '#ff6a1a'][i], 1, 1.2, 0.8);
                }
            }
        }
    }
}

// barre de vie au-dessus de chaque chapiteau
const tentBars = {};
for (const t of ['red', 'blue']) {
    const { bar, fill } = makeBar(t, 6.0, 2.2);
    castles[t].tentGroup.add(bar);
    tentBars[t] = { bar, fill, hp: 100 };
}
const tmpQ = new THREE.Quaternion();
function updateTentBars() {
    for (const t of ['red', 'blue']) {
        const b = tentBars[t];
        b.bar.visible = castles[t].tentGroup.visible && b.hp < 100;
        if (!b.bar.visible) continue;
        b.fill.scale.x = Math.max(0.001, b.hp / 100);
        castles[t].tentGroup.getWorldQuaternion(tmpQ);
        b.bar.quaternion.copy(tmpQ).invert().multiply(camera.quaternion);
    }
}

function updateUnits(dt) {
    for (const u of unitObjs.values()) {
        const k = 1 - Math.exp(-10 * dt);
        const ox = u.x, oz = u.z;
        if (Math.hypot(u.tx - u.x, u.tz - u.z) > 6) { u.x = u.tx; u.z = u.tz; }
        u.x += (u.tx - u.x) * k;
        u.z += (u.tz - u.z) * k;
        const moved = Math.hypot(u.x - ox, u.z - oz);
        const root = u.model.root;
        const gy = unitGround(u.x, u.z);
        root.position.set(u.x, THREE.MathUtils.lerp(root.position.y, gy, 1 - Math.exp(-15 * dt)), u.z);
        let diff = u.rot - root.rotation.y;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        root.rotation.y += diff * (1 - Math.exp(-8 * dt));

        const speed = moved / Math.max(dt, 1e-4);
        if (u.big) {
            for (const w of u.model.wheels) w.rotation.x += moved / 0.36;
            if (u.model.kind === 'cannon') {
                // recul du fût après le tir
                u.model.anim = Math.max(0, u.model.anim - dt * 1.5);
                u.model.barrel.position.z = u.model.barrelZ - 0.4 * u.model.anim;
            } else {
                // le bras bascule d'un coup puis se recharge lentement
                u.model.anim = Math.max(0, u.model.anim - dt);
                const k = 1 - u.model.anim;
                u.model.arm.rotation.x = u.model.anim === 0 ? -0.35
                    : k < 0.15 ? -0.35 + (k / 0.15) * 2.55 : 2.2 - ((k - 0.15) / 0.85) * 2.55;
                u.model.stone.visible = u.model.anim === 0 || k > 0.9;
            }
        } else {
            const walking = speed > 0.3 ? 1 : 0;
            u.model.phase += dt * 9 * walking;
            animateFigure(u.model, walking, dt);
            // l'archer tend son arc quand il tire
            if (u.type === 'archer' && u.state > 0) {
                u.model.arms[0].rotation.x = -1.5;
                u.model.arms[1].rotation.x = -1.3;
            }
        }

        showBar(u.bar, u.fill, u.hp, root);
    }
}

// ---------------------------------------------------------------- autres joueurs
const remotes = new Map();
function updateRemotes(dt) {
    for (const r of remotes.values()) {
        const k = 1 - Math.exp(-12 * dt);
        const root = r.fig.root;
        root.position.x += (r.tx - root.position.x) * k;
        root.position.y += (r.ty - root.position.y) * k;
        root.position.z += (r.tz - root.position.z) * k;
        let diff = r.ry - root.rotation.y;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        root.rotation.y += diff * k;
        r.fig.phase += dt * 10 * r.anim;
        animateFigure(r.fig, r.anim, dt);
        showBar(r.bar, r.fill, r.hp, root);
    }
}

// =====================================================================
//  EFFETS : projectiles, nuages de poussière, créneaux qui tombent
// =====================================================================
const projectiles = [];
const arrowGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.7, 6).rotateX(Math.PI / 2);
const arrowTipGeo = new THREE.ConeGeometry(0.06, 0.16, 8).rotateX(Math.PI / 2).translate(0, 0, 0.42);
const stoneGeo = new THREE.IcosahedronGeometry(0.32, 1);
const ballGeo = new THREE.SphereGeometry(0.2, 14, 10);

const fireballGeo = new THREE.IcosahedronGeometry(0.55, 2);
function launch(kind, a, b, d, r = 0) {
    const A = new THREE.Vector3(...a), Bv = new THREE.Vector3(...b);
    if (A.y < 3) A.y += unitGround(A.x, A.z);
    if (Bv.y < 1.5) Bv.y += unitGround(Bv.x, Bv.z);
    let mesh;
    if (kind === 'arrow') {
        mesh = new THREE.Group();
        mesh.add(new THREE.Mesh(arrowGeo, plastic('#7a4a22')), new THREE.Mesh(arrowTipGeo, plastic('#5a5f66')));
    } else if (kind === 'ball') {
        mesh = new THREE.Mesh(ballGeo, plastic('#1f2024', 0.3));
        mesh.castShadow = true;
    } else if (kind === 'fireball') {
        mesh = new THREE.Mesh(fireballGeo, new THREE.MeshStandardMaterial({ color: '#ffb02e', emissive: '#ff6a00', emissiveIntensity: 2.5 }));
    } else {
        mesh = new THREE.Mesh(stoneGeo, plastic('#8d939a', 0.6));
        mesh.castShadow = true;
    }
    mesh.position.copy(A);
    scene.add(mesh);
    const dist = A.distanceTo(Bv);
    projectiles.push({ kind, A, B: Bv, d, t: 0, mesh, r, trail: 0,
        h: kind === 'stone' ? dist * 0.32 : kind === 'ball' ? dist * 0.06 : kind === 'fireball' ? dist * 0.22 : dist * 0.1 });
}

const tmpP = new THREE.Vector3(), tmpN = new THREE.Vector3();
function projAt(p, t, out) {
    return out.lerpVectors(p.A, p.B, t).setY(THREE.MathUtils.lerp(p.A.y, p.B.y, t) + p.h * 4 * t * (1 - t));
}
function updateProjectiles(dt) {
    for (let i = projectiles.length - 1; i >= 0; i--) {
        const p = projectiles[i];
        p.t += dt / p.d;
        if (p.t >= 1) {
            scene.remove(p.mesh);
            projectiles.splice(i, 1);
            if (p.kind === 'stone') puff(p.B, '#b8a58a', 9, 1.6);
            else if (p.kind === 'ball') puff(p.B, '#6a6560', 8, 1.3);
            else if (p.kind === 'fireball') {
                // explosion : flammes sur toute la zone, puis fumée
                p.mesh.material.dispose();
                for (let i = 0; i < 10; i++) {
                    const a = Math.random() * Math.PI * 2, rr = Math.random() * p.r;
                    puff(p.B.clone().add(new THREE.Vector3(Math.cos(a) * rr, 0.3, Math.sin(a) * rr)), ['#ffe27a', '#ffb02e', '#ff6a1a'][i % 3], 2, 1.6, 1.2);
                }
                puff(p.B.clone().setY(p.B.y + 1), '#4a4548', 8, 3, 2.5);
            }
            continue;
        }
        projAt(p, p.t, tmpP);
        projAt(p, Math.min(1, p.t + 0.02), tmpN);
        p.mesh.position.copy(tmpP);
        if (p.kind === 'arrow') p.mesh.lookAt(tmpN);
        else p.mesh.rotation.x += dt * 8;
        if (p.kind === 'fireball' && (p.trail -= dt) <= 0) { p.trail = 0.04; puff(tmpP.clone(), Math.random() < 0.5 ? '#ffb02e' : '#ff6a1a', 1, 0.8, 0.2); }
    }
}

const puffs = [];
const puffGeo = new THREE.SphereGeometry(1, 12, 8);
function puff(at, color = '#d9d2c5', n = 6, size = 1, rise = 1) {
    for (let i = 0; i < n; i++) {
        const m = new THREE.Mesh(puffGeo, new THREE.MeshStandardMaterial({ color, roughness: 1, transparent: true, opacity: 0.85, depthWrite: false }));
        m.position.copy(at).add(new THREE.Vector3((Math.random() - 0.5) * size, Math.random() * 0.4 * size, (Math.random() - 0.5) * size));
        m.scale.setScalar(0.15 * size);
        scene.add(m);
        puffs.push({ m, t: 0, life: 0.6 + Math.random() * 0.5, grow: (0.4 + Math.random() * 0.5) * size, vy: (0.5 + Math.random()) * rise });
    }
}
function updatePuffs(dt) {
    for (let i = puffs.length - 1; i >= 0; i--) {
        const p = puffs[i];
        p.t += dt;
        const k = p.t / p.life;
        if (k >= 1) { scene.remove(p.m); p.m.material.dispose(); puffs.splice(i, 1); continue; }
        p.m.scale.setScalar(0.15 + p.grow * k);
        p.m.position.y += p.vy * dt;
        p.m.material.opacity = 0.85 * (1 - k);
    }
}

// couronnement : colonne de lumière dorée, étincelles et couronne qui descend sur la tête du roi
const beams = [];
const beamGeo = new THREE.CylinderGeometry(0.9, 0.9, 8, 24, 1, true).translate(0, 4, 0);
const crownGeo = new THREE.CylinderGeometry(0.3, 0.27, 0.22, 16, 1, true);
function coronation(at) {
    const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
        color: '#ffd84a', transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    beam.position.copy(at);
    const crown = new THREE.Mesh(crownGeo, new THREE.MeshStandardMaterial({ color: '#e8b923', metalness: 0.8, roughness: 0.25, side: THREE.DoubleSide }));
    crown.position.copy(at).setY(at.y + 4);
    scene.add(beam, crown);
    beams.push({ beam, crown, t: 0, y0: at.y });
    puff(at.clone().setY(at.y + 0.3), '#ffe27a', 14, 1.6, 2.5);
}
function updateBeams(dt) {
    for (let i = beams.length - 1; i >= 0; i--) {
        const b = beams[i];
        b.t += dt;
        const k = b.t / 1.8;
        if (k >= 1) {
            scene.remove(b.beam, b.crown);
            b.beam.material.dispose(); b.crown.material.dispose();
            beams.splice(i, 1);
            continue;
        }
        b.beam.material.opacity = 0.6 * (1 - k);
        b.beam.scale.set(1 - k * 0.6, 1, 1 - k * 0.6);
        b.crown.position.y = b.y0 + 4 - Math.min(1, k * 1.6) * 2.3;   // se pose vers la tête
        b.crown.rotation.y += dt * 4;
        b.crown.visible = k < 0.7;
    }
}

// créneaux qui tombent quand le château perd des PV
const falling = [];
function crumble(castle, hp) {
    const ratio = hp / CASTLE_HP;
    const target = Math.floor((1 - ratio) * castle.merlons.length * 0.85);
    if (target < castle.fallen) { restoreCastle(castle); return; }
    while (castle.fallen < target) {
        const m = castle.merlons[castle.fallen++];
        scene.attach(m);
        const i = colliders.indexOf(m);
        if (i >= 0) colliders.splice(i, 1);
        falling.push({ m, vy: 2, vx: (Math.random() - 0.5) * 3, vz: (Math.random() - 0.5) * 3, spin: (Math.random() - 0.5) * 8, done: false });
        puff(m.position, '#c9c4bb', 4, 1.2);
    }
}
function restoreCastle(castle) {
    for (let i = 0; i < castle.fallen; i++) {
        const m = castle.merlons[i];
        const h = m.userData.home;
        h.parent.add(m);
        m.position.copy(h.pos);
        m.rotation.copy(h.rot);
        if (!colliders.includes(m)) colliders.push(m);
        const f = falling.findIndex(f => f.m === m);
        if (f >= 0) falling.splice(f, 1);
    }
    castle.fallen = 0;
}
function updateFalling(dt) {
    for (const f of falling) {
        if (f.done) continue;
        f.vy -= 20 * dt;
        f.m.position.x += f.vx * dt;
        f.m.position.z += f.vz * dt;
        f.m.position.y += f.vy * dt;
        f.m.rotation.x += f.spin * dt;
        if (f.m.position.y < 0.33) { f.m.position.y = 0.33; f.done = true; puff(f.m.position, '#c9c4bb', 3, 0.8); }
    }
}

// fumée sur un château très abîmé
let smokeTimer = 0;
function updateSmoke(dt, hps) {
    smokeTimer -= dt;
    if (smokeTimer > 0) return;
    smokeTimer = 0.25;
    ['red', 'blue'].forEach((t, i) => {
        if (hps[i] / CASTLE_HP > 0.5) return;
        const p = toWorld(t, (Math.random() - 0.5) * 16, 6 + Math.random() * 3, (Math.random() - 0.5) * 14);
        puff(p, '#55545a', 2, 1.4, 2.5);
    });
}

// =====================================================================
//  INSTANTANÉS DU SERVEUR
// =====================================================================
let lastSnap = null;
function onSnapshot(s) {
    lastSnap = s;
    phase = s.ph;
    winner = s.w;
    const myIdx = myTeam === 'red' ? 0 : 1;
    myGold = s.g[myIdx];

    // unités
    for (const u of unitObjs.values()) u.seen = false;
    for (const [id, ti, teamI, x, z, hp, st, rot] of s.u) {
        let u = unitObjs.get(id);
        if (!u) u = createUnit(id, TYPES[ti], teamI ? 'blue' : 'red', x, z, rot);
        u.tx = x; u.tz = z; u.hp = hp; u.state = st; u.rot = rot; u.seen = true;
    }
    for (const [id, u] of unitObjs) {
        if (u.seen) continue;
        puff(u.model.root.position.clone().setY(u.model.root.position.y + 0.6), '#e8e2d6', u.big ? 10 : 6, u.big ? 1.8 : 1);
        scene.remove(u.model.root);
        unitObjs.delete(id);
    }

    // autres joueurs
    const seen = new Set();
    let myKingHp = 100;
    for (const [id, teamI, x, y, z, ry, anim, hp, dead, bot] of s.p) {
        if (id === myId) { myKingHp = hp; continue; }
        seen.add(id);
        let r = remotes.get(id);
        if (!r) {
            const team = teamI ? 'blue' : 'red';
            const fig = makePlayerModel(team);
            fig.root.position.set(x, bot ? unitGround(x, z) : y, z);
            const { bar, fill } = makeBar(team, 2.15, 1.1);
            fig.root.add(bar);
            scene.add(fig.root);
            r = { fig, team, bar, fill };
            remotes.set(id, r);
        }
        // le roi de l'IA n'a pas de physique : on le pose sur le sol ici
        r.tx = x; r.ty = bot ? unitGround(x, z) : y; r.tz = z; r.ry = ry; r.anim = anim; r.hp = hp;
        if (r.fig.root.visible === !!dead) {
            r.fig.root.visible = !dead;
            if (!dead) r.fig.root.position.set(r.tx, r.ty, r.tz);      // réapparition : pas de glissade
        }
    }
    for (const [id, r] of remotes) if (!seen.has(id)) { scene.remove(r.fig.root); remotes.delete(id); }

    // effets
    for (const f of s.fx) {
        if (f.k === 'arrow' || f.k === 'stone' || f.k === 'ball' || f.k === 'fireball') launch(f.k, f.a, f.b, f.d, f.r);
        else if (f.k === 'swing' && f.pid !== myId) { const r = remotes.get(f.pid); if (r) r.fig.swing = 0.35; }
        else if (f.k === 'kingDie') puff(new THREE.Vector3(...f.p).setY(f.p[1] + 0.8), '#f6c21a', 12, 1.5, 1.5);
        else if (f.k === 'crown') coronation(new THREE.Vector3(...f.p));
        else if (f.k === 'heal') {
            const at = new THREE.Vector3(...f.p);
            puff(at.clone().setY(at.y + 0.8), '#7dff9a', 14, 1.4, 2.5);
            puff(at.clone().setY(at.y + 1.6), '#eafff0', 6, 1, 3);
            if (f.pid === myId) toast(`🧪 La potion de vie te rend des forces !`, 2);
        } else if (f.k === 'oil') {
            // l'huile tombe du chaudron et éclabousse tout le devant de la porte
            const c = new THREE.Vector3(...f.p);
            for (let i = 0; i < 6; i++) {
                const a = Math.random() * Math.PI * 2, r = Math.random() * f.r * 0.8;
                puff(c.clone().add(new THREE.Vector3(Math.cos(a) * r, 0.2, Math.sin(a) * r)), i % 2 ? '#ffb02e' : '#8a5a1e', 3, 1.2, 0.6);
            }
            puff(c.clone().setY(1.5), '#efe6d6', 6, 2.2, 2.5);
        } else if (f.k === 'defDown') {
            const castle = castles[f.team];
            const obj = f.key === 'tent' ? castle.tentGroup : castle.barricadeGroup;
            const at = obj.getWorldPosition(new THREE.Vector3());
            puff(at.setY(0.8), f.key === 'tent' ? '#e8e2d6' : '#b08a5a', 14, f.key === 'tent' ? 3 : 2.2, 1.2);
        }
        else if (f.k === 'melee') {
            const u = unitObjs.get(f.id);
            if (u && !u.big) u.model.swing = 0.35;
            if (f.p) puff(new THREE.Vector3(...f.p), '#d9d2c5', 2, 0.6);
        } else if (f.k === 'fire') {
            const u = unitObjs.get(f.id);
            if (u) {
                u.model.anim = 1;
                if (u.type === 'cannon') {
                    const r = u.model.root;
                    puff(new THREE.Vector3(r.position.x + Math.sin(r.rotation.y) * 1.1, r.position.y + 1.0, r.position.z + Math.cos(r.rotation.y) * 1.1), '#efe9df', 7, 1.0, 1.5);
                }
            }
        }
    }

    // châteaux
    castles.red.door.open = !!s.door[0];
    castles.blue.door.open = !!s.door[1];
    castles.red.setMages(Object.fromEntries(MAGE_KEYS.map((k, j) => [k, s.mg[0][j]])));
    castles.blue.setMages(Object.fromEntries(MAGE_KEYS.map((k, j) => [k, s.mg[1][j]])));
    syncDragons(s.dr);
    castles.red.setBroken(!!s.br[0]);
    castles.blue.setBroken(!!s.br[1]);
    ['red', 'blue'].forEach((t, i) => {
        const lv = Object.fromEntries(DEF_KEYS.map((k, j) => [k, s.d[i][j]]));
        castles[t].setDefense(lv, t !== myTeam);              // seules les barricades ennemies arrêtent ton roi
        const bar = tentBars[t];
        bar.hp = lv.tent ? s.dh[i][1] : 100;
    });
    castles.red.setTreasure(s.g[0]);
    castles.blue.setTreasure(s.g[1]);
    crumble(castles.red, s.hp[0]);
    crumble(castles.blue, s.hp[1]);
    if (s.hp[myIdx] < lastHp[myIdx] - 30) flashDamage();
    lastHp = s.hp;

    updateHud(s, myKingHp);
}

// =====================================================================
//  HUD
// =====================================================================
function buildShop() {
    ui.btns.innerHTML = '';
    TYPES.forEach((type, i) => {
        const u = UNITS[type];
        const b = document.createElement('button');
        b.className = 'unitBtn';
        b.dataset.type = type;
        b.title = `${u.name} : coûte ${u.cost}, rapporte ${u.bounty} à l'ennemi qui l'abat · ${u.train} s de formation ` +
            `(${u.building === 'barracks' ? 'caserne, ou chapiteau s\'il est dressé' : 'atelier de siège'})`;
        b.innerHTML = `<span class="key">${i + 1}</span><span class="queued"></span><span class="ico">${u.icon}</span><span class="nm">${u.name}</span>` +
            `<span class="cost">🪙 ${u.cost}</span><span class="prog"><i></i></span>`;
        b.addEventListener('click', () => { send({ t: 'spawn', unit: type }); b.blur(); });
        ui.btns.appendChild(b);
    });
    // défenses du château (touches 6 à 9)
    const sep = document.createElement('div');
    sep.className = 'shopSep';
    ui.btns.appendChild(sep);
    DEF_KEYS.forEach((key, i) => {
        const d = DEFENSES[key];
        const b = document.createElement('button');
        b.className = 'unitBtn defBtn';
        b.dataset.def = key;
        b.title = DEF_HELP[key];
        b.innerHTML = `<span class="key">${i + 6}</span><span class="lvl"></span><span class="ico">${d.icon}</span><span class="nm">${d.name}</span>` +
            `<span class="cost"></span><span class="prog"><i></i></span>`;
        b.addEventListener('click', () => { send({ t: 'defense', key }); b.blur(); });
        ui.btns.appendChild(b);
    });
}
const DEF_HELP = {
    towers: "Tours de garde : flèches plus fortes, plus rapides et plus lointaines. Au niveau 3, les deux tours tirent ensemble.",
    oil: "Huile bouillante : un chaudron au-dessus de la porte arrose régulièrement les ennemis massés devant le pont-levis.",
    barricade: "Barricades : elles se placent devant le pont-levis. Soldats, chevaliers et roi ennemis doivent les abattre pour passer. Niveau 2 : chevaux de frise qui piquent ceux qui les frappent.",
    tent: "Chapiteau : une caserne hors les murs. Tes soldats, archers et chevaliers peuvent y être formés et partent sans passer par le pont-levis. Mais l'ennemi peut l'abattre !",
};

function updateHud(s, kingHp) {
    ui.gold.textContent = myGold;
    // files de formation : nombre en attente par type et avancement de la troupe en cours
    // (soldats, archers et chevaliers : caserne + chapiteau)
    const myI = myTeam === 'red' ? 0 : 1;
    const [barracks, workshop, tentQ] = s.q[myI];
    const tentUp = s.d[myI][DEF_KEYS.indexOf('tent')] > 0;
    const queues = { barracks: [barracks, ...(tentUp || tentQ[0].length ? [tentQ] : [])], workshop: [workshop] };
    for (const b of ui.btns.querySelectorAll('[data-type]')) {
        const u = UNITS[b.dataset.type];
        const ti = TYPES.indexOf(b.dataset.type);
        const lists = queues[u.building];
        const n = lists.reduce((sum, [list]) => sum + list.filter(t => t === ti).length, 0);
        const progress = Math.max(0, ...lists.map(([list, p]) => (list[0] === ti ? p : 0)));
        b.querySelector('.queued').textContent = n ? `×${n}` : '';
        b.querySelector('.queued').classList.toggle('show', n > 0);
        b.querySelector('.prog i').style.width = progress * 100 + '%';
        b.disabled = phase !== 'playing' || myGold < u.cost || lists.every(([list]) => list.length >= QUEUE_MAX);
    }
    // défenses : niveau actuel, prix du prochain, PV des constructions
    for (const b of ui.btns.querySelectorAll('[data-def]')) {
        const key = b.dataset.def, d = DEFENSES[key];
        const lv = s.d[myI][DEF_KEYS.indexOf(key)];
        const next = d.levels[lv + 1];
        const max = d.levels.length - 1;
        const shown = key === 'towers' ? lv + 1 : lv;            // les tours démarrent au niveau 1
        b.querySelector('.lvl').textContent = key === 'tent' ? (lv ? 'dressé' : '') : `Nv ${shown}/${key === 'towers' ? max + 1 : max}`;
        b.querySelector('.lvl').classList.toggle('show', key !== 'tent' || lv > 0);
        b.querySelector('.cost').textContent = next ? `🪙 ${next.cost}` : (key === 'tent' ? '✔ dressé' : '✔ max');
        const hpI = ['barricade', 'tent'].indexOf(key);
        b.querySelector('.prog i').style.width = (hpI >= 0 && lv ? s.dh[myI][hpI] : 0) + '%';
        b.classList.toggle('built', !next);
        b.disabled = phase !== 'playing' || !next || myGold < next.cost;
    }
    for (const b of document.querySelectorAll('.spellBtn')) {
        const key = b.dataset.spell, m = MAGES[key], j = MAGE_KEYS.indexOf(key);
        const built = s.mg[myI][j], cd = s.sc[myI][j];
        b.classList.toggle('locked', !built);
        b.querySelector('.scost').textContent = built ? `🪙 ${m.cost}` : `🏗️ ${m.build}`;
        b.querySelector('.scd').textContent = built && cd > 0 ? cd : '';
        b.style.setProperty('--cd', built && cd > 0 ? cd / m.cd : 0);
        b.disabled = phase !== 'playing' || kingDead || (built ? cd > 0 || myGold < m.cost : myGold < m.build);
    }
    if (aiming && (kingDead || phase !== 'playing')) setAiming(false);
    ui.kingFill.style.width = (kingDead ? 0 : kingHp) + '%';
    ui.kingTxt.textContent = kingDead ? '👑 couronnement…' : `❤️ ${Math.round(kingHp / 100 * KING_HP)} / ${KING_HP}`;
    ui.hpRed.style.width = (s.hp[0] / CASTLE_HP * 100) + '%';
    ui.hpBlue.style.width = (s.hp[1] / CASTLE_HP * 100) + '%';
    ui.hpRedTxt.textContent = s.hp[0];
    ui.hpBlueTxt.textContent = s.hp[1];

    if (phase === 'waiting') {
        ui.lobby.classList.add('show');
        ui.lobbyText.innerHTML = myRoom
            ? `Salon <b>${escapeHtml(myRoom.name)}</b> ${myRoom.locked ? '🔒' : ''} : on guette l'arrivée d'un roi adverse…`
            : 'En attente d\'un adversaire…';
    } else ui.lobby.classList.remove('show');

    if (phase === 'over') {
        const won = winner === myTeam;
        ui.overTitle.textContent = won ? '👑 Victoire !' : '💥 Défaite…';
        ui.overText.textContent = won ? "Ton roi a mis la main sur le trésor d'en face ! Tout le royaume fait la fête."
            : "Le roi d'en face a filé avec ton trésor… Prends ta revanche !";
        ui.over.classList.add('show');
    }
}

let toastTimer = null;
function toast(text, sec = 3) {
    ui.toast.textContent = text;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), sec * 1000);
}

function flashDamage() {
    document.body.classList.remove('hit');
    void document.body.offsetWidth;
    document.body.classList.add('hit');
}

// mini-carte : ton château toujours en bas
const mm = ui.minimap.getContext('2d');
function drawMinimap() {
    const W = ui.minimap.width, H = ui.minimap.height;
    const red = myTeam === 'red';
    const mx = x => (red ? 1 - (x + 32) / 64 : (x + 32) / 64) * W;
    const my = z => (red ? 1 - (z + 58) / 116 : (z + 58) / 116) * H;
    mm.clearRect(0, 0, W, H);
    mm.fillStyle = '#cfe6b2';
    mm.beginPath(); mm.roundRect(0, 0, W, H, 12); mm.fill();
    mm.fillStyle = '#ead6aa';
    mm.fillRect(mx(11), my(red ? 30 : -30), mx(-11) - mx(11), my(red ? -30 : 30) - my(red ? 30 : -30));
    for (const t of ['red', 'blue']) {
        const c = toWorld(t, 0, 0, 0);
        mm.fillStyle = TEAM[t].main;
        mm.globalAlpha = 0.35;
        mm.fillRect(Math.min(mx(13.5), mx(-13.5)), Math.min(my(c.z + 12), my(c.z - 12)), Math.abs(mx(13.5) - mx(-13.5)), Math.abs(my(c.z + 12) - my(c.z - 12)));
        mm.globalAlpha = 1;
        mm.strokeStyle = TEAM[t].main;
        mm.lineWidth = 2;
        mm.strokeRect(Math.min(mx(9.5), mx(-9.5)), Math.min(my(c.z + 7.5), my(c.z - 7.5)), Math.abs(mx(9.5) - mx(-9.5)), Math.abs(my(c.z + 7.5) - my(c.z - 7.5)));
    }
    for (const u of unitObjs.values()) {
        mm.fillStyle = TEAM[u.team].main;
        const r = u.big ? 4 : 2.5;
        mm.beginPath(); mm.arc(mx(u.x), my(u.z), r, 0, 7); mm.fill();
    }
    const dot = (x, z, color, ring) => {
        mm.fillStyle = color; mm.strokeStyle = ring; mm.lineWidth = 2;
        mm.beginPath(); mm.arc(mx(x), my(z), 5, 0, 7); mm.fill(); mm.stroke();
    };
    for (const t of ['red', 'blue']) {
        const c = castles[t];
        mm.fillStyle = TEAM[t].dark;
        if (c.tentGroup.visible) {
            const p = c.tentGroup.getWorldPosition(new THREE.Vector3());
            mm.beginPath(); mm.moveTo(mx(p.x), my(p.z) - 6); mm.lineTo(mx(p.x) + 5, my(p.z) + 4); mm.lineTo(mx(p.x) - 5, my(p.z) + 4); mm.fill();
        }
        if (c.barricadeGroup.visible) {
            const p = c.barricadeGroup.getWorldPosition(new THREE.Vector3());
            mm.fillRect(Math.min(mx(p.x - 4.6), mx(p.x + 4.6)), my(p.z) - 1.5, Math.abs(mx(p.x + 4.6) - mx(p.x - 4.6)), 3);
        }
    }
    for (const d of dragonObjs.values()) {
        const p = d.m.root.position;
        mm.fillStyle = TEAM[d.team].main; mm.strokeStyle = '#f6c21a'; mm.lineWidth = 2;
        mm.beginPath(); mm.moveTo(mx(p.x), my(p.z) - 7); mm.lineTo(mx(p.x) + 6, my(p.z)); mm.lineTo(mx(p.x), my(p.z) + 7); mm.lineTo(mx(p.x) - 6, my(p.z)); mm.closePath();
        mm.fill(); mm.stroke();
    }
    for (const r of remotes.values()) dot(r.fig.root.position.x, r.fig.root.position.z, TEAM[r.team].main, '#fff');
    dot(pos.x, pos.z, '#fff', TEAM[myTeam].main);
}

// =====================================================================
//  BOUCLE
// =====================================================================
let last = performance.now(), viewW = 0, viewH = 0, sendTimer = 0;

requestAnimationFrame(render);

function render(now) {
    if (canvas.clientWidth !== viewW || canvas.clientHeight !== viewH) {
        viewW = canvas.clientWidth; viewH = canvas.clientHeight;
        renderer.setSize(viewW, viewH, false);
        camera.aspect = viewW / viewH;
        camera.updateProjectionMatrix();
    }
    const dt = THREE.MathUtils.clamp((now - last) / 1000, 0, 0.05);
    last = now;
    const t = now / 1000;

    // portes et ponts-levis
    for (const c of Object.values(castles)) c.updateDoor(dt);

    updatePlayer(dt);
    if (inMenu) menuCamera(t);
    else updateCamera(dt);
    sun.position.copy(pos).add(SUN_OFFSET);
    sun.target.position.copy(pos);

    sendTimer -= dt;
    if (sendTimer <= 0 && player) {
        sendTimer = 1 / 15;
        send({ t: 'pos', x: +pos.x.toFixed(2), y: +visualY.toFixed(2), z: +pos.z.toFixed(2), ry: +player.root.rotation.y.toFixed(2), a: moving > 0.2 ? 1 : 0 });
    }

    updateUnits(dt);
    updateRemotes(dt);
    updateProjectiles(dt);
    updatePuffs(dt);
    updateFalling(dt);
    updateBeams(dt);
    updateTentBars();
    updateDragons(dt, t);
    updateAim();
    if (lastSnap) updateSmoke(dt, lastSnap.hp);

    // entrée dans une salle des coffres
    const vault = vaults.find(v => Math.hypot(pos.x - v.pos.x, pos.z - v.pos.z) < v.r && pos.y < v.pos.y + 2);
    if (vault && vault !== inVault && lastSnap) {
        const mine = vault.castle.team === myTeam;
        const g = lastSnap.g[vault.castle.team === 'red' ? 0 : 1];
        toast(mine ? `💰 Le trésor de ton royaume : ${g} pièces d'or. Garde-le bien !` : `💰 Le trésor d'en face ! La couronne est à toi…`, 3);
    }
    inVault = vault || null;

    if (myId !== null && nearOwnGate()) {
        ui.prompt.classList.add('show');
        const door = castles[myTeam].door;
        ui.prompt.classList.toggle('broken', door.broken);
        ui.promptText.textContent = castles[myTeam].doorText(door.open);
    } else ui.prompt.classList.remove('show');

    // décor animé
    for (const c of Object.values(castles)) for (const f of c.figures) {
        f.phase += dt * 2;
        f.upper.position.y = Math.sin(f.phase) * 0.012;
    }
    for (const f of flags) {
        const p = f.geometry.attributes.position, b = f.userData.base;
        for (let i = 0; i < p.count; i++) {
            const x = b[i * 3];
            p.setZ(i, Math.sin(x * 4 - t * 5 + f.userData.phase) * 0.12 * x);
        }
        p.needsUpdate = true;
        f.geometry.computeVertexNormals();
    }
    for (const s of spinners) s.obj.rotation.y += s.speed * dt;
    // la brume dérive lentement et s'efface quand la caméra la traverse
    for (const m of mists) {
        const p = m.sprite.position;
        p.x += m.speed * dt;
        if (p.x > 44) p.x = -44;
        const edge = Math.min(1, (44 - Math.abs(p.x)) / 10);
        const near = THREE.MathUtils.smoothstep(p.distanceTo(camera.position), 4, 16);
        m.sprite.material.opacity = m.base * edge * near * (0.8 + 0.2 * Math.sin(t * 0.4 + m.phase));
    }
    flames.forEach((f, i) => f.scale.set(1, 0.85 + Math.sin(t * 17 + i * 3) * 0.15 + Math.sin(t * 7) * 0.05, 1));

    drawMinimap();
    renderer.render(scene, camera);
    requestAnimationFrame(render);
}

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
    initWorld, buildRoom, buildToyCastle, buildLionCastle, animateFigure, makePlayerModel, makeUnitModel, makeWarDragon,
    colliders, groundColliders, flags, flames, spinners, mists, TEAM, plastic,
} from './world.js';
import { unlockAudio, play, startLoop, setListener, setSfx, setMusic, setVolumes, audioPrefs, setBattle } from './audio.js';
import { mergeStatic, makeBatch, bakeModel } from './bake.js';
import { compactColliders, prepare, finishColliders } from './collision.js';
import { createQuality, wantAntialias } from './quality.js';

// le son ne peut démarrer qu'après un geste du joueur (règle des navigateurs)
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, unlockAudio, { capture: true });

// =====================================================================
//  Les Deux Couronnes : deux châteaux face à face
// =====================================================================

performance.mark('modules');            // repères de chargement (visibles dans l'onglet Performance du navigateur)
const canvas = document.getElementById('canvas');
// high-performance : sur un portable à deux cartes graphiques, on demande la plus puissante
let renderer;
try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: wantAntialias(), powerPreference: 'high-performance' });
} catch (err) {
    // pas de 3D sur cet appareil (WebGL désactivé ou carte graphique trop ancienne) : on le dit plutôt que de figer la page
    document.getElementById('noGame').hidden = false;
    document.getElementById('noGameText').textContent = "Ton navigateur n'arrive pas à afficher la 3D (WebGL). " +
        "Essaie de mettre à jour ton navigateur, ou d'activer « l'accélération matérielle » dans ses réglages.";
    throw err;
}
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

// le décor ne bouge plus : collisions regroupées dans un arbre, pièces immobiles fusionnées (voir bake.js, collision.js)
performance.mark('built');
compactColliders(colliders);
compactColliders(groundColliders);
performance.mark('colliders');
mergeStatic(scene, { chunk: 24 });
performance.mark('merged');
for (const c of Object.values(castles)) {
    // objets qui peuvent devenir des obstacles plus tard (défenses, tours de mage)
    for (const o of [c.tentGroup, c.barricadeGroup, ...Object.values(c.mageTowers).map(t => t.group)]) prepare(o);
    // créneaux : tous dessinés d'un coup tant qu'ils tiennent, et le même lot sert d'obstacle
    c.merlonBatch = makeBatch(c.merlons);
    scene.add(c.merlonBatch.mesh);
    prepare(c.merlonBatch.mesh);
    for (const m of c.merlons) colliders.splice(colliders.indexOf(m), 1);
    colliders.push(c.merlonBatch.mesh);
    c.merlons.forEach((m, i) => { m.userData.batchIndex = i; m.visible = false; });
}
performance.mark('world');
// définition de l'image et ombres adaptées à l'appareil (voir quality.js)
const quality = createQuality({ renderer, sun, scene, toast: (text, sec) => toast(text, sec) });

// salles des coffres (au pied de la tour arrière droite de chaque château)
const vaults = Object.values(castles).map(c => ({ castle: c, pos: c.group.localToWorld(c.vaultLocal.clone()), r: c.vaultRadius }));
let inVault = null;

// repère local d'un château -> monde (identique au serveur)
function toWorld(team, lx, ly, lz) {
    return team === 'red' ? new THREE.Vector3(lx, ly, -40 + lz) : new THREE.Vector3(-lx, ly, 40 - lz);
}

// ---------------------------------------------------------------- raycasts
const ray = new THREE.Raycaster();
ray.firstHitOnly = true;               // seul le premier obstacle nous intéresse (beaucoup plus rapide)
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
let COUNTERS = {};
let UNITS = null, TYPES = [], CASTLE_HP = 2500, KING_HP = 300, QUEUE_MAX = 5, DEFENSES = {}, DEF_KEYS = [];
let kingDead = false, deadTimer = 0;
let MAGES = {}, MAGE_KEYS = [], DRAGON_Y = 8, aiming = false, myKingHpPct = 100;
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
        if (tutorialMode) setTimeout(() => tutoShow(0), 2500);
        myId = m.id; myTeam = m.team; UNITS = m.units; TYPES = m.types; CASTLE_HP = m.castleHp;
        KING_HP = m.kingHp; QUEUE_MAX = m.queueMax; myRoom = m.room; DEFENSES = m.defenses; DEF_KEYS = m.defKeys; COUNTERS = m.counters || {};
        MAGES = m.mages; MAGE_KEYS = m.mageKeys; DRAGON_Y = m.dragonY;
        buildSpells();
        lastHp = [CASTLE_HP, CASTLE_HP];
        applyMode(m);
        if (m.spectator) { myId = -1; setupSpectator(m.room); } else setupPlayer();
        buildShop();
        document.body.dataset.team = myTeam;
        document.body.classList.toggle('multiRoom', !m.room.solo);
        inviteLink = m.room.solo ? '' : makeInviteLink(m.room, m.lan);
        ui.lan.innerHTML = m.spectator ? 'Tu regardes ce salon en spectateur : la bataille commencera dès que les deux royaumes auront leur roi.'
            : `Envoie le lien d'invitation à ton adversaire, ou donne-lui le code <b>${m.room.id}</b>` +
            ` du salon <b>${escapeHtml(m.room.name)}</b>${m.room.locked ? ' et le mot de passe 🔒' : ''}.`;
    },
    s: onSnapshot,
    start(m) {
        for (const c of Object.values(castles)) { restoreCastle(c); c.resetDefense(); }
        play('fanfare');
        ui.over.classList.remove('show');
        applyMode(m);
        modeStart();
    },
    over(m) {
        play(spectating || m.winner === myTeam ? 'victory' : 'defeat');
        if (m.stats) showOverStats(m.stats, m.duration || 0);
        onOver(m);
        tutoFinish();
        tutorialMode = false;
        tutoCloseTip();
        tutoArrowAt(null);
        winner = m.winner;
    },
    msg(m) { toast(m.text, 4); },
    // le salon regardé a fermé (tous les rois sont partis)
    closed() {
        phase = 'offline';
        ui.over.classList.remove('show');
        ui.lobby.classList.add('show');
        ui.lobbyText.innerHTML = '🚪 Le salon a fermé ses portes : tous les rois sont partis.';
        ui.lan.textContent = 'Reviens au menu pour regarder ou rejoindre une autre bataille.';
    },
    knock(m) {
        knock.set(m.dx * 9, 0, m.dz * 9);
        vy = 5; onGround = false;
    },
    hurt() { flashDamage(); },
    shout(m) { showShout(m.pid, m.i); },
    order(m) { toast(m.text, 3); play('horn'); },
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
    if (spectating) return spectatorMove(dt);
    if (kingDead) {
        deadTimer = Math.max(0, deadTimer - dt);
        ui.crownTime.textContent = Math.ceil(deadTimer);
        return;
    }
    // filet de sécurité : si un « blur » nous a échappé, pas de déplacement sans le focus
    if (!document.hasFocus() && Object.values(keys).some(Boolean)) releaseAll();
    let ix = 0, iz = 0;
    if (keys.KeyW || keys.ArrowUp) iz += 1;
    if (keys.KeyS || keys.ArrowDown) iz -= 1;
    if (keys.KeyA || keys.ArrowLeft) ix -= 1;
    if (keys.KeyD || keys.ArrowRight) ix += 1;
    if (touchJoy.active) { ix += touchJoy.x; iz += touchJoy.y; }
    const run = keys.ShiftLeft || keys.ShiftRight || touchRun;
    const speed = run ? 7 : 4;

    if (ix || iz) {
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
        const rx = Math.cos(yaw), rz = -Math.sin(yaw);
        let mx = fx * iz + rx * ix, mz = fz * iz + rz * ix;
        const l = Math.hypot(mx, mz);
        mx = mx / l * speed * dt; mz = mz / l * speed * dt;
        move(mx, mz);
        facing = Math.atan2(mx, mz);
        if (run) tutoFlags.ran = true;
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
    if (jumpRequest && onGround) { vy = JUMP; onGround = false; tutoFlags.jumped = true; }
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
    play('swing');
    tutoFlags.hits++;
    player.swing = 0.35;
    send({ t: 'attack' });
}

// ---------------------------------------------------------------- contrôles
window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || inMenu || settingsOpen()) return;
    keys[e.code] = true;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    if (e.repeat) return;
    if (spectating) return spectatorKey(e.code);
    if (e.code === 'Space') jumpRequest = true;
    if (e.code === 'KeyF') attack();
    if (e.code === 'Escape') setAiming(false);
    const spell = MAGE_KEYS.find(k => e.code === 'Key' + MAGES[k].key);
    if (spell) useSpell(spell, true);
    const ord = { KeyV: 'attack', KeyB: 'defend', KeyN: 'follow', KeyM: gameMode === 'hill' ? 'hill' : null }[e.code];
    if (ord) giveOrder(ord);
    if (e.code === 'KeyE' && nearOwnGate() && !castles[myTeam].door.broken) send({ t: 'door' });
    const n = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'].indexOf(e.code);
    const n2 = ['Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5', 'Numpad6'].indexOf(e.code);
    const idx = n >= 0 ? n : n2;
    if (idx >= 0 && TYPES[idx]) send({ t: 'spawn', unit: TYPES[idx] });
    const d = ['Digit7', 'Digit8', 'Digit9', 'Digit0'].indexOf(e.code);
    const d2 = ['Numpad7', 'Numpad8', 'Numpad9', 'Numpad0'].indexOf(e.code);
    const di = d >= 0 ? d : d2;
    if (di >= 0 && DEF_KEYS[di]) send({ t: 'defense', key: DEF_KEYS[di] });
});
window.addEventListener('keyup', e => { keys[e.code] = false; });
// la fenêtre perd le focus (clic ailleurs, alt-tab, onglet caché) : le relâchement des touches ne nous
// parviendra jamais, on oublie donc tout ce qui était enfoncé (sinon le roi continue d'avancer tout seul)
function releaseAll() {
    for (const k in keys) keys[k] = false;
    jumpRequest = false;
    dragging = false;
    touchPts.clear();
    touchJoy.active = false; touchJoy.x = touchJoy.y = 0;
}
window.addEventListener('blur', releaseAll);
window.addEventListener('focus', releaseAll);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
document.addEventListener('mouseleave', () => { dragging = false; });

let yaw = Math.PI, pitch = 0.32, camDistWanted = 9, camDist = 9;
let dragging = false, lastX = 0, lastY = 0, dragDist = 0;
const mouseNdc = new THREE.Vector2();
const touchPts = new Map();
let pinchDist = 0;
const ptsDist = () => { const [a, b] = [...touchPts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
function trackMouse(e) {
    const r = canvas.getBoundingClientRect();
    mouseNdc.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
}
canvas.addEventListener('pointerdown', e => {
    trackMouse(e);
    touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touchPts.size === 2) { pinchDist = ptsDist(); dragDist = 99; }      // deux doigts : zoom, pas de coup
    if (touchPts.size > 1) return;
    dragging = true; dragDist = 0; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
});
for (const ev of ['pointerup', 'pointercancel']) canvas.addEventListener(ev, e => { touchPts.delete(e.pointerId); if (touchPts.size) dragDist = 99; });
canvas.addEventListener('pointermove', e => {
    trackMouse(e);
    if (touchPts.has(e.pointerId)) touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touchPts.size >= 2) {
        const d = ptsDist();
        if (pinchDist > 0 && d > 0) camDistWanted = THREE.MathUtils.clamp(camDistWanted * pinchDist / d, 3, 45);
        pinchDist = d;
        return;
    }
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    dragDist += Math.abs(dx) + Math.abs(dy);
    yaw -= dx * 0.006 * settings.camSens;
    pitch = THREE.MathUtils.clamp(pitch + dy * 0.005 * settings.camSens * (settings.invert ? -1 : 1), -0.1, 1.35);
    lastX = e.clientX; lastY = e.clientY;
});
canvas.addEventListener('pointerup', () => {
    if (dragging && dragDist < 6) {
        if (aiming) { updateAim(); fireAtAim(); }   // en visée : le clic (ou le tapotement) lance la boule de feu
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

// ---------------------------------------------------------------- réglages du son (mémorisés)
const sfxBtn = el('sfxBtn'), musicBtn = el('musicBtn');
function refreshSoundBtns() {
    const p = audioPrefs();
    sfxBtn.textContent = p.sfx ? '🔊' : '🔇';
    sfxBtn.classList.toggle('off', !p.sfx);
    sfxBtn.title = p.sfx ? 'Couper les bruitages' : 'Remettre les bruitages';
    musicBtn.classList.toggle('off', !p.music);
    musicBtn.title = p.music ? 'Couper la musique' : 'Remettre la musique';
}
sfxBtn.addEventListener('click', () => { unlockAudio(); setSfx(!audioPrefs().sfx); refreshSoundBtns(); play('click'); sfxBtn.blur(); });
musicBtn.addEventListener('click', () => { unlockAudio(); setMusic(!audioPrefs().music); refreshSoundBtns(); play('click'); musicBtn.blur(); });
refreshSoundBtns();
// ---------------------------------------------------------------- fenêtre des réglages (bouton ⚙️, mémorisés)
// son, qualité de l'image, caméra, interface… et les mentions légales
const SETTINGS_KEY = 'deuxCouronnes.reglages';
const SETTINGS_DEFAULT = { camSens: 1, invert: false, minimap: true, fps: false, flash: true };
const settings = { ...SETTINGS_DEFAULT };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch { /* réglages par défaut */ }
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* tant pis */ } };
const settingsEl = el('settings');
const settingsOpen = () => settingsEl.classList.contains('open');
function applySettings() {
    document.body.classList.toggle('noMinimap', !settings.minimap);
    document.body.classList.toggle('noFlash', !settings.flash);
    el('fps').classList.toggle('show', settings.fps);
}
function refreshSettings() {
    const p = audioPrefs();
    el('sfxVol').value = Math.round(p.sfxVol * 100);
    el('musicVol').value = Math.round(p.musicVol * 100);
    el('sfxVolTxt').textContent = `${el('sfxVol').value} %`;
    el('musicVolTxt').textContent = `${el('musicVol').value} %`;
    el('sfxOn').checked = p.sfx;
    el('musicOn').checked = p.music;
    for (const b of el('qualityChoice').children) b.classList.toggle('sel', b.dataset.q === quality.mode);
    el('optFlash').checked = settings.flash;
    el('optMinimap').checked = settings.minimap;
    el('optFps').checked = settings.fps;
    el('optInvert').checked = settings.invert;
    el('camSens').value = Math.round(settings.camSens * 100);
    el('camSensTxt').textContent = `×${settings.camSens.toFixed(1)}`;
    el('fullscreenBtn').textContent = document.fullscreenElement ? '⛶ Quitter le plein écran' : '⛶ Plein écran';
    el('fullscreenBtn').hidden = !document.documentElement.requestFullscreen;
}
function showSettingsTab(tab) {
    for (const b of settingsEl.querySelectorAll('[data-tab]')) b.classList.toggle('sel', b.dataset.tab === tab);
    for (const p of settingsEl.querySelectorAll('[data-page]')) p.classList.toggle('show', p.dataset.page === tab);
}
function openSettings(tab = 'son') {
    releaseAll();                       // le roi ne doit pas continuer d'avancer pendant qu'on règle
    refreshSettings();
    showSettingsTab(tab);
    settingsEl.classList.add('open');
}
const closeSettings = () => settingsEl.classList.remove('open');
el('qualityBtn').addEventListener('click', () => { openSettings(); el('qualityBtn').blur(); });
for (const b of document.querySelectorAll('[data-settings]')) b.addEventListener('click', () => openSettings(b.dataset.settings));
settingsEl.addEventListener('click', e => {
    if (e.target === settingsEl || e.target.closest('[data-set-close]')) return closeSettings();
    const tab = e.target.closest('[data-tab]');
    if (tab) showSettingsTab(tab.dataset.tab);
    const q = e.target.closest('[data-q]');
    if (q) { quality.set(q.dataset.q); refreshSettings(); }
});
window.addEventListener('keydown', e => { if (e.key === 'Escape' && settingsOpen()) closeSettings(); });
const onVolume = () => { unlockAudio(); setVolumes(el('sfxVol').value / 100, el('musicVol').value / 100); refreshSettings(); };
el('sfxVol').addEventListener('input', onVolume);
el('musicVol').addEventListener('input', onVolume);
el('sfxVol').addEventListener('change', () => play('click'));
el('sfxOn').addEventListener('change', e => { unlockAudio(); setSfx(e.target.checked); refreshSoundBtns(); });
el('musicOn').addEventListener('change', e => { unlockAudio(); setMusic(e.target.checked); refreshSoundBtns(); });
for (const [id, k] of [['optFlash', 'flash'], ['optMinimap', 'minimap'], ['optFps', 'fps'], ['optInvert', 'invert']]) {
    el(id).addEventListener('change', e => { settings[k] = e.target.checked; saveSettings(); applySettings(); });
}
el('camSens').addEventListener('input', e => { settings.camSens = e.target.value / 100; saveSettings(); refreshSettings(); });
el('fullscreenBtn').addEventListener('click', () => {
    const p = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    p?.catch?.(() => toast("🖼️ Ton navigateur refuse le plein écran.", 3));
});
document.addEventListener('fullscreenchange', refreshSettings);
// revoir la partie guidée : depuis l'accueil on la lance tout de suite, en jeu on la propose au prochain passage par l'accueil
el('replayTuto').addEventListener('click', () => {
    try { localStorage.removeItem('deuxCouronnes.tutoDone'); } catch { /* tant pis */ }
    el('tutoBtn').classList.add('suggest');
    closeSettings();
    if (inMenu) el('tutoBtn').click();
    else toast("📖 La partie guidée t'attend à l'accueil (bouton du menu).", 4);
});
el('resetSettings').addEventListener('click', () => {
    Object.assign(settings, SETTINGS_DEFAULT);
    try { localStorage.removeItem(SETTINGS_KEY); } catch { /* tant pis */ }
    setVolumes(1, 1); setSfx(true); setMusic(true);
    quality.set('auto');
    refreshSoundBtns(); applySettings(); refreshSettings();
    toast('↺ Les réglages sont revenus à leur état d’origine.', 3);
});
applySettings();
// images par seconde (réglage « Afficher les images par seconde »)
let fpsFrames = 0, fpsTime = 0;
function updateFps(dtReal) {
    if (!settings.fps) return;
    fpsFrames++; fpsTime += dtReal;
    if (fpsTime < 0.5) return;
    setText(el('fps'), `${Math.round(fpsFrames / fpsTime)} images/s`);
    fpsFrames = 0; fpsTime = 0;
}
// petit « clic » sur tous les boutons de l'interface (menu, boutique, grimoire…)
document.addEventListener('click', e => {
    if (e.target.closest('button') && !e.target.closest('#soundCtl')) play('click');
});

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
        return `<button class="roomCard" data-room="${r.id}" title="${cls === 'full' ? 'Complet : tu peux encore regarder la bataille' : ''}">
            <div class="rcTop"><span class="rcName">${escapeHtml(r.name)}</span>${r.locked ? '<span class="rcLock" title="Mot de passe">🔒</span>' : ''}</div>
            ${seatsHtml(r)}
            <div class="rcBottom"><span class="chip ${cls}">${label}</span>${r.mode && r.mode !== 'classic' && MODE_CARDS[r.mode] ? `<span class="chip mode" title="${MODE_CARDS[r.mode].name}">${MODE_CARDS[r.mode].ico} ${MODE_CARDS[r.mode].name}</span>` : ''}${r.w ? `<span class="chip mode" title="Spectateurs">👁️ ${r.w}</span>` : ''}<span class="rcCode">#${r.id}</span></div>
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
    openInvite();                      // arrivée par un lien d'invitation (…/?salon=ABCD)
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
    el('watchBtn').disabled = (r.w || 0) >= 8;
    if (r.w) mui.joinInfo.textContent += ` · 👁️ ${r.w} spectateur${r.w > 1 ? 's' : ''}`;
    renderTeamPickers();
}

// ---- messages du serveur pour le menu
function menuRefused(text) {
    (lastAction === 'solo' ? mui.soloNote : lastAction === 'campaign' ? el('campNote') : lastAction === 'create' ? mui.createNote : lastAction === 'join' ? mui.joinNote : mui.multiNote).textContent = text;
}
const MENU_BUTTONS = '#menu .tile, #soloBtn, #campBtn, #createBtn, #joinBtn';
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
// tant que le serveur n'a pas répondu, les boutons attendent : un clic partirait dans le vide
if (!ws) for (const b of document.querySelectorAll(MENU_BUTTONS)) b.disabled = true;

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
    send({ t: 'solo', team: menuTeam, level: menuLevel, mode: menuMode });
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
    send({ t: 'create', name: mui.roomName.value, password: locked ? mui.roomPass.value : '', team: menuTeam, mode: createMode });
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
// mode spectateur : regarder la bataille du salon sans y jouer (même s'il est complet)
el('watchBtn').addEventListener('click', () => {
    lastAction = 'join';
    const r = rooms.find(o => o.id === joinRoomId);
    if (!r) return;
    if (r.locked && !mui.joinPass.value) { mui.joinNote.textContent = "Halte ! Même les tribunes demandent le mot de passe secret 🔒"; mui.joinPass.focus(); return; }
    mui.joinNote.textContent = '';
    send({ t: 'watch', room: r.id, password: mui.joinPass.value });
});

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
    const big = type === 'cannon' || type === 'catapult' || type === 'ram';
    model.root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const { bar, fill } = makeBar(team, type === 'catapult' || type === 'ram' ? 2.7 : big ? 1.9 : 1.95, big ? 1.4 : 0.8);
    model.root.add(bar);
    model.root.position.set(x, unitGround(x, z), z);
    model.root.rotation.y = rot;
    scene.add(model.root);
    if (model.low) model.low.root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const u = { id, type, team, model, hi: model, low: model.low || model, bar, fill, x, z, tx: x, tz: z, rot, hp: 100, state: 0, big, seen: true, gx: NaN, gz: NaN, gy: 0, gt: 0 };
    if (team === myTeam && phase === 'playing') play('horn', [x, 1, z], 0.7);
    unitObjs.set(id, u);
    return u;
}

// =====================================================================
//  SORTS DES TOURS DE MAGE
// =====================================================================
// =====================================================================
//  ÉCRAN DE FIN : STATISTIQUES
// =====================================================================
const STAT_ROWS = [
    ['⚔️ Troupes formées', 'trained', 'more'], ['💀 Ennemis abattus', 'killed', 'more'], ['🪦 Troupes perdues', 'lost', 'less'],
    ['🪙 Or gagné', 'earned', 'more'], ['🏰 Dégâts au château', 'castleDmg', 'more'], ['🔮 Sorts lancés', 'spells', 'more'],
    ['🏗️ Constructions', 'built', 'more'], ['👑 Rois tombés', 'kingsFallen', 'less'],
];
function showOverStats(stats, duration) {
    const me = stats[myTeam], foe = stats[myTeam === 'red' ? 'blue' : 'red'];
    const foeName = myTeam === 'red' ? '🦁 Lion' : '💀 Crâne', meName = spectating ? '💀 Crâne' : myTeam === 'red' ? '💀 Toi' : '🦁 Toi';
    el('overStats').innerHTML = `<tr><th></th><th class="me">${meName}</th><th>${foeName}</th></tr>` + STAT_ROWS.map(([label, k, better]) => {
        const a = Math.round(me[k]), b = Math.round(foe[k]);
        const aBest = a !== b && (better === 'more' ? a > b : a < b), bBest = a !== b && !aBest;
        return `<tr><td>${label}</td><td class="v ${aBest ? 'best' : ''}">${a}</td><td class="v ${bBest ? 'best' : ''}">${b}</td></tr>`;
    }).join('');
    el('overDuration').textContent = `⏱️ Durée de la bataille : ${Math.floor(duration / 60)} min ${String(duration % 60).padStart(2, '0')} s`;
}

// =====================================================================
//  CRIS RAPIDES (bulles au-dessus des rois)
// =====================================================================
const SHOUTS = ['📯 Oyez, oyez !', "⚔️ À l'attaque !", '🛡️ Tenez bon !', '👏 Bien joué !', '🐉 Gare au dragon !', '🏳️ Pitié !'];
const shoutMenu = el('shoutMenu');
shoutMenu.innerHTML = SHOUTS.map((t, i) => `<button data-shout="${i}">${t}</button>`).join('');
el('shoutBtn').addEventListener('click', e => { e.stopPropagation(); shoutMenu.classList.toggle('show'); el('shoutBtn').blur(); });
shoutMenu.addEventListener('click', e => {
    const b = e.target.closest('[data-shout]');
    if (!b) return;
    send({ t: 'shout', i: +b.dataset.shout });
    shoutMenu.classList.remove('show');
});
document.addEventListener('pointerdown', e => { if (!e.target.closest('#shoutMenu, #shoutBtn')) shoutMenu.classList.remove('show'); });
const bubbles = [];
function showShout(pid, i) {
    const owner = pid === myId ? (player && { root: player.root, team: myTeam }) : (() => { const r = remotes.get(pid); return r && { root: r.fig.root, team: r.team }; })();
    if (!owner || !SHOUTS[i]) return;
    // une seule bulle à la fois par roi
    for (const b of bubbles.filter(b => b.root === owner.root)) { b.el.remove(); bubbles.splice(bubbles.indexOf(b), 1); }
    const div = document.createElement('div');
    div.className = 'bubble';
    div.textContent = SHOUTS[i];
    div.style.setProperty('--bc', TEAM[owner.team].main);
    el('bubbles').appendChild(div);
    bubbles.push({ el: div, root: owner.root, until: performance.now() + 3200 });
    play('horn', owner.root.position.toArray(), 0.6);
}
const tmpB = new THREE.Vector3();
function updateBubbles() {
    const t = performance.now();
    for (let i = bubbles.length - 1; i >= 0; i--) {
        const b = bubbles[i];
        if (t > b.until || !b.root.parent) { b.el.remove(); bubbles.splice(i, 1); continue; }
        tmpB.copy(b.root.position).setY(b.root.position.y + 2.7).project(camera);
        const behind = tmpB.z > 1;
        const x = THREE.MathUtils.clamp((tmpB.x * 0.5 + 0.5) * innerWidth, 90, innerWidth - 90);
        const y = behind ? 120 : THREE.MathUtils.clamp((-tmpB.y * 0.5 + 0.5) * innerHeight, 70, innerHeight - 160);
        b.el.style.left = x + 'px';
        b.el.style.top = y + 'px';
        b.el.style.opacity = Math.min(1, (b.until - t) / 400);
    }
}

// =====================================================================
//  COMMANDES TACTILES (tablettes) : joystick, boutons, pincer pour zoomer
// =====================================================================
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
if (isTouch) document.body.classList.add('touch');
const touchJoy = { active: false, x: 0, y: 0, id: null };
let touchRun = false;
{
    const joy = el('joy'), knob = el('joyKnob'), R = 46;
    const moveKnob = e => {
        const r = joy.getBoundingClientRect();
        let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
        const l = Math.hypot(dx, dy);
        if (l > R) { dx *= R / l; dy *= R / l; }
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
        touchJoy.x = dx / R; touchJoy.y = -dy / R;
        if (Math.hypot(touchJoy.x, touchJoy.y) < 0.15) touchJoy.x = touchJoy.y = 0;   // petite zone morte
    };
    joy.addEventListener('pointerdown', e => { touchJoy.active = true; touchJoy.id = e.pointerId; joy.setPointerCapture(e.pointerId); moveKnob(e); unlockAudio(); });
    joy.addEventListener('pointermove', e => { if (touchJoy.active && e.pointerId === touchJoy.id) moveKnob(e); });
    const release = () => { touchJoy.active = false; touchJoy.x = touchJoy.y = 0; knob.style.transform = ''; };
    joy.addEventListener('pointerup', release);
    joy.addEventListener('pointercancel', release);
    for (const b of document.querySelectorAll('#touchBtns button')) {
        b.addEventListener('pointerdown', e => {
            e.preventDefault();
            unlockAudio();
            const t = b.dataset.t;
            if (t === 'attack') attack();
            else if (t === 'jump') jumpRequest = true;
            else if (t === 'run') { touchRun = !touchRun; b.classList.toggle('active', touchRun); }
            else if (t === 'door' && nearOwnGate() && !castles[myTeam].door.broken) send({ t: 'door' });
        });
    }
}

// =====================================================================
//  PARTIE GUIDÉE
// =====================================================================
// La leçon avance étape par étape : chaque étape attend une action du joueur (done) ou un simple
// « Compris ! » (info). Une fois la leçon finie, le Chambellan donne encore des conseils pendant la
// bataille, au bon moment (TUTO_TIPS), et une flèche dorée montre où aller.
let tutorialMode = false, tutoStep = -1, tutoStart = null, tutoHi = [], tutoLesson = false, tutoTipTimer = 0;
const tutoFlags = { ran: false, jumped: false, hits: 0 };
const tutoTipsSeen = new Set();
const myI = () => (myTeam === 'red' ? 0 : 1);
const enemyTeam = () => (myTeam === 'red' ? 'blue' : 'red');
// touche au clavier, ou bouton à l'écran sur tablette
const tKey = (k, touch) => `<b>${k}</b>${isTouch && touch ? ` (ou ${touch})` : ''}`;
// la troupe est-elle sortie ou en formation ?
const hasUnit = (s, type) => {
    const ti = TYPES.indexOf(type);
    return s.u.some(u => u[1] === ti && u[2] === myI()) || s.q[myI()].some(q => q[0].includes(ti));
};
// il manque de l'or : on rassure le joueur, le trésor se remplit tout seul
const waitGold = cost => (myGold < cost ? `<small class="tutoWait">⏳ Ton trésor se remplit… encore ${cost - myGold} pièces d'or.</small>` : '');
const TUTO = [
    { text: () => `👑 <b>Bienvenue, Sire !</b> Ce château de jouets est le tien. Déplace ton roi avec ${tKey('Z Q S D', 'le joystick')} et tourne la caméra en faisant glisser ${isTouch ? 'ton doigt' : 'la souris'} (la molette rapproche ou éloigne la vue).`,
      done: () => tutoStart && pos.distanceTo(tutoStart) > 4 },
    { text: () => `🏃 Un roi doit savoir se presser ! Cours en tenant ${tKey('Maj', '🏃')} et saute avec ${tKey('Espace', '⤒')}.` +
        `<br>${tutoFlags.ran ? '✅' : '⬜'} courir · ${tutoFlags.jumped ? '✅' : '⬜'} sauter`,
      done: () => tutoFlags.ran && tutoFlags.jumped },
    { text: () => `🪙 <b>Ton trésor</b>, en haut de la boutique, se remplit tout seul (${INCOME_TXT}). Chaque ennemi abattu te rapporte en plus une <b>prime</b>. Tout s'achète avec cet or : troupes, défenses et sorts.`,
      hi: '#gold', info: true },
    { text: () => `🔱 <b>Forme tes premiers Soldats</b> : clique sur leur bouton (touche <b>1</b>). Ils sortent de ta <b>caserne</b>, dans la cour, puis marchent vers l'ennemi.${waitGold(UNITS.infantry.cost)}`,
      hi: '#btns [data-type="infantry"]', done: s => hasUnit(s, 'infantry') },
    { text: () => `🏹 <b>Forme des Archers</b> (touche <b>2</b>). Ils tirent de loin, à l'abri derrière les autres.${waitGold(UNITS.archer.cost)}`,
      hi: '#btns [data-type="archer"]', done: s => hasUnit(s, 'archer') },
    { text: () => `🛡️ <b>Forme un Chevalier</b> (touche <b>3</b>) : lent à former, mais très solide.${waitGold(UNITS.knight.cost)}`,
      hi: '#btns [data-type="knight"]', done: s => hasUnit(s, 'knight') },
    { text: () => `⚖️ <b>Chaque troupe a sa force et sa faiblesse</b>, comme à pierre-feuille-ciseaux :<br>🏹 les archers battent les 🔱 soldats,<br>🛡️ les chevaliers battent les 🏹 archers,<br>🔱 les lances des soldats battent les 🛡️ chevaliers (et les béliers).<br>Sur chaque bouton, la pastille <b style="color:#2f9e44">verte</b> montre qui la troupe bat, la <b style="color:#e03131">rouge</b> qui elle craint. Une armée variée gagne !`,
      hi: '#btns [data-type="infantry"], #btns [data-type="archer"], #btns [data-type="knight"]', info: true },
    { text: () => `💣 <b>L'atelier de siège</b> forme les engins qui abattent les murailles : le <b>Canon</b> (4), l'<b>Engin de siège</b> (5, tire de très loin) et le <b>Bélier</b> (6, enfonce le pont-levis). Ils ne savent pas se défendre : escorte-les ! Forme-en un.${waitGold(UNITS.cannon.cost)}`,
      hi: '#btns [data-type="cannon"], #btns [data-type="catapult"], #btns [data-type="ram"]', done: s => hasUnit(s, 'cannon') || hasUnit(s, 'catapult') || hasUnit(s, 'ram') },
    { text: () => `⛓️ <b>Ton pont-levis</b> protège ton trésor. Suis la <b>flèche dorée</b> jusqu'à ta porte et appuie sur ${tKey('E', '⛓️')} pour le lever.`,
      at: () => toWorld(myTeam, 0, 0, 9), done: s => s.door[myI()] === 0 },
    { text: () => `👍 Bien ! Pont levé, l'ennemi doit frapper la porte… mais <b>tes troupes restent enfermées</b> ! Rabaisse-le (${tKey('E', '⛓️')}) pour les laisser sortir.`,
      at: () => toWorld(myTeam, 0, 0, 9), done: s => s.door[myI()] === 1 },
    { text: () => `🚩 <b>Donne des ordres à ton armée</b>, dans le cadre « Ordres ». Clique sur <b>Défendre</b> (touche <b>B</b>) : tes troupes tiendront la ligne devant ton pont-levis, sous ton étendard.`,
      hi: '.orderBtn[data-order="defend"]', done: s => s.or[myI()] === 1 },
    { text: () => `👑 Clique maintenant sur <b>Suivre le roi</b> (touche <b>N</b>) : tes troupes t'escortent partout, même jusque dans le château ennemi. Promène-toi, elles te suivent !`,
      hi: '.orderBtn[data-order="follow"]', done: s => s.or[myI()] === 2 },
    { text: () => `⚔️ <b>Ton roi sait se battre</b> : frappe de ton épée avec ${isTouch ? 'le bouton ⚔️' : 'un <b>clic</b> ou la touche <b>F</b>'}. Donne trois coups dans le vide pour t'entraîner (${Math.min(tutoFlags.hits, 3)} / 3).<br><small>S'il tombe, ton roi est couronné de nouveau sur le tapis royal quelques secondes plus tard.</small>`,
      done: () => tutoFlags.hits >= 3 },
    { text: () => `🪵 <b>Renforce ton château</b> : achète des <b>Barricades</b> (touche <b>9</b>). Elles se dressent là où pointe la flèche et barrent la route aux ennemis. Plus tard, pense aussi aux <b>Tours de garde</b> (7), à l'<b>Huile bouillante</b> (8) et au <b>Chapiteau</b> (0), une caserne hors les murs.${waitGold(DEFENSES.barricade.levels[1].cost)}`,
      hi: '#btns [data-def="barricade"]', at: () => toWorld(myTeam, 0, 0, 14.2), done: s => s.d[myI()][DEF_KEYS.indexOf('barricade')] >= 1 },
    { text: () => `🔮 <b>La magie !</b> Dans le grimoire, à gauche, bâtis la <b>Tour de l'Alchimiste</b> : clique sur « Bâtir » sous la potion. Elle s'élève derrière ton château.${waitGold(MAGES.potion.build)}`,
      hi: '.spellBtn[data-spell="potion"]', done: s => !!s.mg[myI()][0] },
    { text: () => `🧪 Ta tour est bâtie ! La <b>Potion de vie</b> (touche <b>R</b>) soignera ton roi quand il sera blessé. Plus tard, la <b>Boule de feu</b> (T) brûle les ennemis là où tu vises, et le <b>Dragon</b> (Y) ravage tout sur son passage. Chaque sort coûte de l'or et doit se recharger.`,
      hi: '.spellBtn', info: true },
    { text: () => `⚔️ Assez d'entraînement ! Clique sur <b>Attaquer</b> (touche <b>V</b>) : tes troupes marchent sur le château ennemi.`,
      hi: '.orderBtn[data-order="attack"]', done: s => s.or[myI()] === 0 },
    { text: () => `🏆 <b>Comment gagner</b> : fais tomber le château ennemi à <b>0 PV</b> (barre en haut de l'écran) avec tes engins et tes troupes. Son pont-levis cédera : entre alors avec ton roi dans sa <b>salle au trésor</b> ! Mais garde un œil sur le tien…<br>L'Écuyer d'en face se réveille dès que tu cliques. Je te soufflerai encore quelques conseils. Bonne chance, Sire !`,
      hi: '#bars .bar', at: () => toWorld(enemyTeam(), 0, 0, 9), last: true },
];
const INCOME_TXT = '10 pièces par seconde';
// conseils pendant la bataille (partie guidée seulement), chacun donné une fois
const TUTO_TIPS = [
    { id: 'enemy', when: s => s.u.some(u => u[2] !== myI()),
      text: () => `👀 Les troupes de l'Écuyer approchent ! Regarde leurs icônes et forme ce qui les bat (pastilles vertes de la boutique).` },
    { id: 'hurtCastle', when: s => s.hp[myI()] < CASTLE_HP - 60,
      text: () => `🏰 Ton château est touché ! À 0 PV, ton pont-levis cède. Améliore tes <b>Tours de garde</b> (7) ou installe l'<b>Huile bouillante</b> (8).`,
      hi: '#btns [data-def="towers"], #btns [data-def="oil"]' },
    { id: 'rich', when: () => myGold >= 600,
      text: () => `🪙 Ton trésor déborde (${myGold} pièces) ! Un roi avare perd la guerre : forme des troupes, des engins ou bâtis une défense.`, hi: '#gold' },
    { id: 'potion', when: s => myKingHpPct < 45 && !kingDead && !!s.mg[myI()][0],
      text: () => `🧪 Ton roi est blessé : bois une <b>Potion de vie</b> (touche <b>R</b>) !`, hi: '.spellBtn[data-spell="potion"]' },
    { id: 'dead', when: () => kingDead, urgent: true,
      text: () => `💀 Ton roi est tombé ! Pas d'inquiétude : il sera couronné de nouveau sur le tapis royal dans quelques secondes. Ton armée, elle, continue le combat.` },
    { id: 'weak', when: s => s.hp[1 - myI()] < CASTLE_HP / 2,
      text: () => `🔥 Le château ennemi chancelle (moins de la moitié de ses PV) ! Envoie des <b>Canons</b> et des <b>Béliers</b> pour l'achever, avec des soldats pour les escorter.` },
    { id: 'myBreach', when: s => !!s.br[myI()], urgent: true,
      text: () => `😱 Ton pont-levis a cédé ! Protège ta salle au trésor : ordre <b>Défendre</b> (B), et frappe les rois ennemis de ton épée.`, hi: '.orderBtn[data-order="defend"]' },
    { id: 'breach', when: s => !!s.br[1 - myI()], keep: true, urgent: true,
      text: () => `🚪 <b>Le pont-levis ennemi a cédé !</b> Fonce avec ton roi jusqu'à la salle au trésor : suis la flèche dorée ! Avec l'ordre <b>Suivre le roi</b> (N), ton armée t'escorte.`,
      at: () => vaults.find(v => v.castle.team !== myTeam).pos, hi: '.orderBtn[data-order="follow"]' },
];

// flèche dorée et colonne de lumière : « c'est ici ! »
const tutoArrow = new THREE.Group();
{
    const gold = new THREE.MeshBasicMaterial({ color: '#f6c21a' });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.1, 16).rotateX(Math.PI), gold);
    cone.position.y = 2.6;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.9, 12), gold);
    shaft.position.y = 3.6;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 30, 20, 1, true),
        new THREE.MeshBasicMaterial({ color: '#ffe066', transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }));
    beam.position.y = 15;
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.45, 32).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: '#f6c21a', transparent: true, opacity: 0.8, depthWrite: false }));
    ring.position.y = 0.06;
    tutoArrow.add(cone, shaft, beam, ring);
    tutoArrow.userData.bob = [cone, shaft];
    tutoArrow.userData.ring = ring;
    tutoArrow.visible = false;
    scene.add(tutoArrow);
}
function tutoArrowAt(p) {
    tutoArrow.visible = !!p;
    if (p) tutoArrow.position.set(p.x, groundAt(p.x, 6, p.z), p.z);
}
function updateTutoArrow(t) {
    if (!tutoArrow.visible) return;
    const b = Math.sin(t * 4) * 0.3;
    tutoArrow.userData.bob[0].position.y = 2.6 + b;
    tutoArrow.userData.bob[1].position.y = 3.6 + b;
    const r = 1 + (t * 0.8 % 1) * 0.5;
    tutoArrow.userData.ring.scale.set(r, 1, r);
    tutoArrow.userData.ring.material.opacity = 0.8 * (1.5 - r) * 2;
}

function tutoHighlight(sel) {
    for (const b of tutoHi) b.classList.remove('tutoHi');
    tutoHi = sel ? [...document.querySelectorAll(sel)] : [];
    for (const b of tutoHi) b.classList.add('tutoHi');
}
function tutoShow(i) {
    tutoStep = i;
    const step = TUTO[i];
    setText(el('tutoStep'), `📖 Partie guidée · leçon ${i + 1} / ${TUTO.length}`);
    setHTML(el('tutoText'), step.text());
    el('tutoBar').style.width = `${i / (TUTO.length - 1) * 100}%`;
    el('tutoNext').textContent = step.last ? "C'est parti !" : 'Compris !';
    el('tutoNext').style.display = step.last || step.info ? '' : 'none';
    el('tutoSkip').style.display = step.last ? 'none' : '';
    el('tuto').classList.remove('tip');
    el('tuto').classList.remove('show');
    void el('tuto').offsetWidth;                // relance l'animation d'entrée
    el('tuto').classList.add('show');
    tutoHighlight(step.hi);
    tutoArrowAt(step.at?.());
}
function tutoNextStep() {
    play('heal');
    tutoShow(tutoStep + 1);
}
// fin de la leçon (ou leçon passée) : l'IA se réveille
function tutoFinish() {
    if (tutoStep < 0) return;
    tutoStep = -1;
    tutoHighlight(null);
    tutoArrowAt(null);
    el('tuto').classList.remove('show');
    send({ t: 'tutorialDone' });
    try { localStorage.setItem('deuxCouronnes.tutoDone', '1'); } catch { /* tant pis */ }
}
function tutoTip(tip) {
    tutoTipsSeen.add(tip.id);
    play('horn');
    setText(el('tutoStep'), '💡 Conseil du Chambellan');
    setHTML(el('tutoText'), tip.text());
    el('tutoBar').style.width = '100%';
    el('tutoNext').textContent = 'Compris !';
    el('tutoNext').style.display = '';
    el('tutoSkip').style.display = 'none';
    el('tuto').classList.add('tip');
    el('tuto').classList.remove('show');
    void el('tuto').offsetWidth;
    el('tuto').classList.add('show');
    tutoHighlight(tip.hi);
    if (tip.at) tutoArrowAt(tip.at());
    tutoTipTimer = tip.keep ? Infinity : 14;
}
function tutoCloseTip() {
    el('tuto').classList.remove('show');
    tutoHighlight(null);
    tutoTipTimer = 0;
}
function tutoUpdate(s) {
    if (!tutorialMode || phase !== 'playing') return;
    if (tutoStep >= 0) {
        if (!tutoStart && player) tutoStart = pos.clone();
        const step = TUTO[tutoStep];
        setHTML(el('tutoText'), step.text());        // compteurs et or manquant à jour
        if (step.done?.(s)) tutoNextStep();
        return;
    }
    if (!tutoLesson) return;
    // conseils : un à la fois, laissé quelques secondes à l'écran ; un conseil urgent remplace le précédent
    const urgent = TUTO_TIPS.find(t => t.urgent && !tutoTipsSeen.has(t.id) && t.when(s));
    if (urgent) return tutoTip(urgent);
    if (tutoTipTimer > 0) {
        tutoTipTimer -= 0.05;
        if (tutoTipTimer <= 0) tutoCloseTip();
        return;
    }
    const tip = TUTO_TIPS.find(t => !tutoTipsSeen.has(t.id) && t.when(s));
    if (tip) tutoTip(tip);
}
el('tutoSkip').addEventListener('click', () => { tutoFinish(); tutorialMode = false; });
el('tutoNext').addEventListener('click', () => {
    el('tutoNext').blur();
    if (tutoStep < 0) return tutoCloseTip();
    const step = TUTO[tutoStep];
    if (step.last) { tutoLesson = true; tutoFinish(); }
    else if (step.info) tutoNextStep();
});
el('tutoBtn').addEventListener('click', () => {
    tutorialMode = true;
    lastAction = 'solo';
    send({ t: 'solo', team: menuTeam, level: 'easy', tutorial: true });
});
try { if (!localStorage.getItem('deuxCouronnes.tutoDone')) el('tutoBtn').classList.add('suggest'); } catch { /* tant pis */ }

// =====================================================================
//  MODES DE JEU : classique, éclair, roi de la colline, siège en vagues, campagne
// =====================================================================
const MODE_CARDS = {
    classic: { ico: '⚔️', name: 'Classique', sub: 'Brise le pont-levis, file au trésor' },
    blitz: { ico: '⚡', name: 'Éclair', sub: 'Châteaux fragiles, coffres pleins : 5 minutes' },
    hill: { ico: '🚩', name: 'Colline', sub: 'Tiens le drapeau du centre 3 minutes' },
    waves: { ico: '🌊', name: 'Vagues', sub: 'Tiens bon face aux vagues ennemies', solo: true },
    fog: { ico: '🌫️', name: 'Brouillard', sub: "Tu ne vois l'ennemi que près des tiens" },
};
const MODE_START = {
    classic: "🎺 Sonnez trompettes ! Fais céder le pont-levis d'en face, puis file jusqu'à son trésor !",
    blitz: '⚡ Bataille éclair ! Châteaux fragiles et coffres pleins : tout se joue en quelques minutes !',
    hill: '🚩 Le roi de la colline ! Tiens seul le drapeau du centre pendant 3 minutes (ordre « Colline », touche M).',
    waves: "🌊 Siège en vagues ! Le château d'en face est imprenable : repousse ses vagues aussi longtemps que possible.",
    fog: '🌫️ Brouillard de guerre ! Tu ne vois les ennemis que près de tes troupes, de ton roi et de ton château. Une boule de feu éclaire là où elle tombe.',
};
// la campagne : le récit de chaque bataille (les règles sont sur le serveur, dans CAMPAIGN)
const foeName = () => (myTeam === 'red' ? 'le Lion' : 'le Crâne');
const CAMPAIGN_STORY = [
    { ico: '🌙', title: 'La première nuit', sub: "Contre l'Écuyer, sans règle spéciale",
      text: () => `La lumière vient de s'éteindre dans la chambre. Au bout du tapis, ${foeName()} s'éveille à peine : c'est le moment de lui montrer qui règne ici !`,
      rule: '📜 Règle : aucune. Une bataille classique contre un roi encore endormi.' },
    { ico: '📕', title: 'Le grimoire égaré', sub: 'Personne ne peut bâtir de tour de mage',
      text: () => `Le chat a renversé l'étagère : tous les grimoires ont glissé sous le lit ! Ni toi ni ${foeName()} ne pourrez compter sur la magie.`,
      rule: '🚫 Règle : aucune tour de mage, aucun sort. Seuls tes soldats et tes engins comptent.' },
    { ico: '🪙', title: 'Les coffres vides', sub: "L'or se fait rare pour tout le monde",
      text: () => `Une souris a grignoté le fond des coffres du royaume. Chaque pièce compte : ${foeName()} est aussi pauvre que toi… ou presque.`,
      rule: "🪙 Règle : 150 pièces au départ et des revenus réduits de moitié environ. Ne gaspille rien !" },
    { ico: '🐉', title: "Le dragon d'en face", sub: "L'ennemi commence avec toutes ses tours de mage",
      text: () => `${foeName()[0].toUpperCase() + foeName().slice(1)} a apprivoisé un dragon ! Ses trois tours de mage sont déjà debout et son coffre est bien rempli.`,
      rule: "🔥 Règle : l'ennemi a dès le début la potion, la boule de feu et le dragon. Garde des troupes en réserve !" },
    { ico: '🏰', title: 'Le siège final', sub: "Un roi rusé derrière des murs renforcés",
      text: () => `Voici l'ultime bataille ! ${foeName()[0].toUpperCase() + foeName().slice(1)} s'est retranché derrière des tours renforcées, des barricades et un chaudron d'huile. Il est rusé et riche.`,
      rule: "🛡️ Règle : l'ennemi (difficile) commence avec ses tours niveau 3, l'huile bouillante et des barricades. Amène des engins de siège !" },
];
let gameMode = 'classic', gameStage = 0, HILL_WIN = 180, lastOver = null;
let menuMode = 'classic', createMode = 'classic', campStage = 0;
const campDone = () => { try { return Math.min(CAMPAIGN_STORY.length, +localStorage.getItem('deuxCouronnes.campagne') || 0); } catch { return 0; } };
const waveRecord = () => { try { return +localStorage.getItem('deuxCouronnes.vagues') || 0; } catch { return 0; } };

function applyMode(m) {
    gameMode = m.mode || 'classic';
    gameStage = m.stage || 0;
    HILL_WIN = m.hillWin || 180;
    if (m.castleHp) { CASTLE_HP = m.castleHp; lastHp = [CASTLE_HP, CASTLE_HP]; }
    document.body.classList.toggle('modeHill', gameMode === 'hill');
    document.body.classList.toggle('modeWaves', gameMode === 'waves');
    document.body.classList.toggle('noMagic', !!m.noMagic);
    hillFlag.visible = gameMode === 'hill';
    setFogMode(gameMode === 'fog', m.vision);
    el('modeBar').className = `panel ${gameMode === 'hill' || gameMode === 'waves' ? 'show' : ''} ${gameMode === 'hill' ? 'hill' : ''}`;
}
// début de partie : récit de la campagne, ou rappel du mode
function modeStart() {
    if (gameMode === 'campaign') {
        const st = CAMPAIGN_STORY[gameStage];
        setText(el('storyStage'), `📜 Campagne du tapis · bataille ${gameStage + 1} / ${CAMPAIGN_STORY.length}`);
        setText(el('storyTitle'), `${st.ico} ${st.title}`);
        setText(el('storyText'), st.text());
        setText(el('storyRule'), st.rule);
        el('story').classList.add('show');
        return;
    }
    if (!tutorialMode) toast(MODE_START[gameMode] || MODE_START.classic, 6);
}
el('storyGo').addEventListener('click', () => {
    el('story').classList.remove('show');
    el('storyGo').blur();
    send({ t: 'tutorialDone' });         // l'IA attendait la fin du récit
    toast("🎺 Sonnez trompettes ! Que la bataille commence !", 4);
});

// barre du mode, sous les barres de vie : drapeau de la colline ou compteur de vagues
function updateModeBar(s) {
    const bar = el('modeBar');
    if (s.hl) {
        const [r, b, owner, contested] = s.hl;
        const who = contested ? '⚔️ Colline disputée !' : owner < 0 ? '🚩 Colline libre' : owner === myI() ? '🚩 Tu tiens la colline !' : "🚩 L'ennemi tient la colline !";
        setHTML(bar, `<div>${who} <small>(${HILL_WIN} s pour gagner)</small></div>
            <div class="hillTrack"><i class="hr" style="width:${(r / HILL_WIN * 50).toFixed(1)}%"></i><span class="hgap"></span><i class="hb" style="width:${(b / HILL_WIN * 50).toFixed(1)}%"></i></div>
            <div style="display:flex;justify-content:space-between;font-size:12px"><span>💀 ${r} s</span><span>${b} s 🦁</span></div>`);
        hillCloth.material.color.set(owner < 0 || contested ? '#f3ead8' : owner === 0 ? TEAM.red.main : TEAM.blue.main);
    } else if (s.wv) {
        const [wave, held, next] = s.wv;
        setHTML(bar, `🌊 Vague ${wave} · 🛡️ ${held} repoussée${held > 1 ? 's' : ''} · prochaine dans ${next} s` + (waveRecord() ? ` · 🏆 record ${waveRecord()}` : ''));
    }
}

// le drapeau de la colline, au centre du tapis, et le cercle à tenir
const hillFlag = new THREE.Group();
const hillCloth = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.2).translate(0.9, 0, 0),
    new THREE.MeshStandardMaterial({ color: '#f3ead8', roughness: 0.6, side: THREE.DoubleSide }));
{
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 4.6, 10), plastic('#6b4423', 0.6));
    pole.position.y = 2.3;
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8), plastic('#e8b923', 0.3));
    tip.position.y = 4.7;
    hillCloth.position.y = 4;
    const ring = new THREE.Mesh(new THREE.RingGeometry(6.2, 6.5, 64).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: '#f6c21a', transparent: true, opacity: 0.7, depthWrite: false }));
    ring.position.y = 0.05;
    hillFlag.add(pole, tip, hillCloth, ring);
    hillFlag.traverse(o => { if (o.isMesh && o !== ring) o.castShadow = true; });
    hillFlag.position.set(0, groundAt(0, 6, 0), 0);
    hillFlag.visible = false;
    scene.add(hillFlag);
}

// écran de fin selon le mode
function overTexts(won) {
    const m = lastOver || {};
    if (m.how === 'waves') {
        const n = m.waves || 0, best = waveRecord();
        if (n > best) { try { localStorage.setItem('deuxCouronnes.vagues', String(n)); } catch { /* tant pis */ } }
        return ['🌊 Le château est tombé…', `Tu as repoussé ${n} vague${n > 1 ? 's' : ''} avant la chute de ton château. ` +
            (n > best ? '🏆 Nouveau record du royaume !' : `Ton record : ${best} vague${best > 1 ? 's' : ''}.`)];
    }
    if (m.how === 'hill') {
        return won ? ['🚩 Victoire !', 'Ton drapeau a flotté sur la colline assez longtemps : le tapis entier te salue !']
            : ['💥 Défaite…', "Le drapeau d'en face a flotté trop longtemps sur la colline… Prends ta revanche !"];
    }
    if (gameMode === 'campaign' && won) {
        const last = gameStage >= CAMPAIGN_STORY.length - 1;
        return [last ? '👑 La campagne est gagnée !' : `👑 Bataille ${gameStage + 1} gagnée !`,
            last ? 'Tu as remporté les cinq batailles du tapis : tu es le plus grand roi de la chambre !'
                : `Prochaine bataille : ${CAMPAIGN_STORY[gameStage + 1].ico} ${CAMPAIGN_STORY[gameStage + 1].title}.`];
    }
    return won ? ['👑 Victoire !', "Ton roi a mis la main sur le trésor d'en face ! Tout le royaume fait la fête."]
        : ['💥 Défaite…', "Le roi d'en face a filé avec ton trésor… Prends ta revanche !"];
}
function onOver(m) {
    lastOver = m;
    const won = m.winner === myTeam;
    // campagne : la bataille gagnée débloque la suivante
    const next = gameMode === 'campaign' && won && gameStage < CAMPAIGN_STORY.length - 1;
    if (gameMode === 'campaign' && won && campDone() < gameStage + 1) {
        try { localStorage.setItem('deuxCouronnes.campagne', String(gameStage + 1)); } catch { /* tant pis */ }
    }
    el('overNext').classList.toggle('show', next);
    el('story').classList.remove('show');
}
el('overNext').addEventListener('click', () => send({ t: 'restart', next: true }));

// ---- menu : choix du mode (solo et salon) et de la bataille de la campagne
function renderModePickers() {
    for (const box of document.querySelectorAll('[data-mode-picker]')) {
        const solo = box.dataset.modePicker === 'solo';
        const cur = solo ? menuMode : createMode;
        box.innerHTML = Object.entries(MODE_CARDS).filter(([, c]) => solo || !c.solo).map(([k, c]) =>
            `<button class="modeCard ${k === cur ? 'sel' : ''}" data-mode="${k}"><span class="mdIco">${c.ico}</span><b>${c.name}</b><small>${c.sub}</small></button>`).join('');
    }
    // en mode vagues, pas d'adversaire à choisir : les vagues grossissent toutes seules
    const lv = document.querySelector('[data-view="solo"] .levelCards');
    lv.style.display = menuMode === 'waves' ? 'none' : '';
    lv.previousElementSibling.style.display = menuMode === 'waves' ? 'none' : '';
}
function renderStages() {
    const done = campDone();
    if (campStage > done) campStage = Math.min(done, CAMPAIGN_STORY.length - 1);
    el('stageList').innerHTML = CAMPAIGN_STORY.map((st, i) => {
        const locked = i > done, won = i < done;
        return `<button class="stageCard ${i === campStage ? 'sel' : ''}" data-stage="${i}" ${locked ? 'disabled' : ''}>
            <span class="stNum">${locked ? '🔒' : won ? '✅' : st.ico}</span>
            <span><b>${i + 1}. ${st.title}</b><small>${locked ? 'Gagne la bataille précédente pour la débloquer' : st.sub}</small></span></button>`;
    }).join('');
}
document.addEventListener('click', e => {
    const mode = e.target.closest('[data-mode]');
    if (mode) {
        if (mode.closest('[data-mode-picker="solo"]')) menuMode = mode.dataset.mode;
        else createMode = mode.dataset.mode;
        renderModePickers();
        return;
    }
    const stage = e.target.closest('[data-stage]');
    if (stage && !stage.disabled) { campStage = +stage.dataset.stage; renderStages(); }
});
el('campBtn').addEventListener('click', () => {
    lastAction = 'campaign';
    el('campNote').textContent = '';
    send({ t: 'solo', team: menuTeam, mode: 'campaign', stage: campStage });
});
renderModePickers();
campStage = Math.min(campDone(), CAMPAIGN_STORY.length - 1);
renderStages();

// =====================================================================
//  MODE SPECTATEUR ET LIEN D'INVITATION
// =====================================================================
// spectateur : pas de roi ; « pos » devient le point que regarde la caméra libre (ZQSD, glisser, molette)
let spectating = false, followId = null, inviteLink = '';
const SPEC_VIEWS = {
    red: { x: 0, z: -22, yaw: Math.PI, pitch: 0.55, dist: 30 },
    center: { x: 0, z: 0, yaw: Math.PI / 2, pitch: 0.75, dist: 42 },
    blue: { x: 0, z: 22, yaw: 0, pitch: 0.55, dist: 30 },
};
function specView(k) {
    const v = SPEC_VIEWS[k];
    followId = null;
    pos.set(v.x, 0, v.z);
    yaw = v.yaw; pitch = v.pitch; camDistWanted = v.dist;
    refreshSpecBar();
}
function setupSpectator(room) {
    spectating = true;
    setFogMode(false, null);                                    // les tribunes voient toute la bataille
    if (player) { scene.remove(player.root); player = null; }
    document.body.classList.add('spectator');
    setText(el('specTitle'), `👁️ Spectateur · salon ${room.name}`);
    setText(el('specHint'), isTouch ? 'Glisse pour tourner, pince pour zoomer.' : 'ZQSD : déplacer · Maj : plus vite · glisser : tourner · molette : zoom · 1, 2, 3 : vues · F : suivre un roi');
    specView('center');
}
function refreshSpecBar() {
    const king = followId !== null && remotes.get(followId);
    el('specFollow').classList.toggle('active', !!king);
    setText(el('specFollow'), king ? `👑 Roi ${king.team === 'red' ? 'du Crâne' : 'du Lion'} ▸` : '👑 Suivre un roi');
}
// suivre le roi suivant (un appui de plus passe au suivant, puis revient à la caméra libre)
function followNext() {
    const ids = [...remotes.keys()];
    const i = followId === null ? -1 : ids.indexOf(followId);
    followId = i + 1 < ids.length ? ids[i + 1] : null;
    if (followId === null) toast('🎥 Caméra libre', 2);
    else camDistWanted = Math.min(camDistWanted, 14);         // on se rapproche du roi suivi
    refreshSpecBar();
}
function spectatorMove(dt) {
    let ix = 0, iz = 0;
    if (keys.KeyW || keys.ArrowUp) iz += 1;
    if (keys.KeyS || keys.ArrowDown) iz -= 1;
    if (keys.KeyA || keys.ArrowLeft) ix -= 1;
    if (keys.KeyD || keys.ArrowRight) ix += 1;
    if (touchJoy.active) { ix += touchJoy.x; iz += touchJoy.y; }
    if (ix || iz) {
        if (followId !== null) { followId = null; refreshSpecBar(); }
        const speed = (keys.ShiftLeft || keys.ShiftRight ? 30 : 14) * Math.max(0.6, camDistWanted / 25);
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
        const l = Math.hypot(ix, iz);
        pos.x += (fx * iz + rx * ix) / l * speed * dt;
        pos.z += (fz * iz + rz * ix) / l * speed * dt;
    }
    const king = followId !== null && remotes.get(followId);
    if (followId !== null && !king) { followId = null; refreshSpecBar(); }
    if (king) pos.copy(king.fig.root.position);
    pos.x = THREE.MathUtils.clamp(pos.x, -40, 40);
    pos.z = THREE.MathUtils.clamp(pos.z, -62, 62);
    const y = king ? pos.y : Math.max(0, groundAt(pos.x, 12, pos.z));
    visualY = THREE.MathUtils.lerp(visualY, y, 1 - Math.exp(-6 * dt));
}
function spectatorKey(code) {
    const view = { Digit1: 'red', Numpad1: 'red', Digit2: 'center', Numpad2: 'center', Digit3: 'blue', Numpad3: 'blue' }[code];
    if (view) specView(view);
    if (code === 'KeyF') followNext();
}
el('specBtns').addEventListener('click', e => {
    const b = e.target.closest('[data-cam]');
    if (!b) return;
    b.blur();
    if (b.dataset.cam === 'menu') location.reload();
    else if (b.dataset.cam === 'follow') followNext();
    else specView(b.dataset.cam);
});

// lien d'invitation : ouvre directement le salon chez l'ami (…/?salon=ABCD)
function makeInviteLink(room, lan) {
    const local = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
    const base = local && lan.length ? lan[0] : location.origin;
    return `${base}/?salon=${room.id}`;
}
async function copyInvite() {
    if (!inviteLink) return;
    let ok = false;
    try { await navigator.clipboard.writeText(inviteLink); ok = true; } catch { /* page non sécurisée (http en réseau local) */ }
    if (!ok) {
        const ta = document.createElement('textarea');
        ta.value = inviteLink;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        try { ok = document.execCommand('copy'); } catch { ok = false; }
        ta.remove();
    }
    toast(ok ? `📋 Lien copié ! Envoie-le à ton ami : ${inviteLink}` : `📋 Copie impossible : donne ce lien à ton ami : ${inviteLink}`, 6);
}
el('inviteBtn').addEventListener('click', () => { copyInvite(); el('inviteBtn').blur(); });
el('linkBtn').addEventListener('click', () => { copyInvite(); el('linkBtn').blur(); });

// arrivée par un lien d'invitation : on ouvre la fenêtre du salon dès que la liste des salons arrive
let inviteCode = (new URLSearchParams(location.search).get('salon') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
function openInvite() {
    if (!inviteCode) return;
    const code = inviteCode;
    inviteCode = '';
    const url = new URL(location.href);
    url.searchParams.delete('salon');
    history.replaceState(null, '', url);
    showView('multi');
    lastAction = 'multi';
    if (rooms.some(r => r.id === code)) openJoin(code);
    else mui.multiNote.textContent = `Le salon #${code} de ton invitation a fermé ses portes… Ouvre-en un nouveau !`;
}

// =====================================================================
//  ÉVÉNEMENTS DE LA CHAMBRE (ballon, chat, cube de lettres, peluche, veilleuse, tirelire)
// =====================================================================
// Le serveur décide de tout (rm dans l'instantané) : ici, on montre le compte à rebours et on anime les objets.
const ROOM_LABEL = {
    ball: '⚽ Le ballon roule !', cat: '🐈 Le chat traverse le tapis !', cube: '🔤 Un cube barre la route',
    roar: '🐉 La peluche dragon rugit !', mist: '🌫️ La brume de la veilleuse', coins: '🪙 Ramasse les pièces !',
};
let roomKind = null, shakeT = 0;
const mmss = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

// texture faite à la main sur un canevas (pas de fichier image)
function canvasTex(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}
// le ballon de plage, à quartiers de couleur
const roomBall = new THREE.Mesh(new THREE.SphereGeometry(2.2, 32, 20), new THREE.MeshStandardMaterial({
    roughness: 0.35,
    map: canvasTex(256, 128, (g, w, h) => {
        const cols = ['#e63946', '#f6c21a', '#2a7de1', '#ffffff', '#3fae49', '#ff8c1a'];
        cols.forEach((c, i) => { g.fillStyle = c; g.fillRect(i * w / 6, 0, w / 6 + 1, h); });
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, w, 10); g.fillRect(0, h - 10, w, 10);
    }),
}));
roomBall.castShadow = true;
// le cube de lettres, comme ceux qui traînent dans la chambre
const cubeMats = [];
const CUBE_LETTERS = 'ABCDEFGHIJKLMNOPRSTUVZ';
const CUBE_COLORS = ['#e63946', '#2a7de1', '#3fae49', '#f6c21a', '#ff8c1a', '#8e5bd6'];
function letterMat(letter, bg) {
    return new THREE.MeshStandardMaterial({ roughness: 0.6, map: canvasTex(128, 128, (g, w, h) => {
        g.fillStyle = bg; g.fillRect(0, 0, w, h);
        g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 10; g.strokeRect(8, 8, w - 16, h - 16);
        g.fillStyle = '#fffaf2'; g.font = 'bold 84px "Baloo 2", system-ui, sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(letter, w / 2, h / 2 + 6);
    }) });
}
const roomCube = new THREE.Mesh(new THREE.BoxGeometry(3.2, 3.2, 3.2), CUBE_COLORS.map((c, i) => letterMat('ABCDEF'[i], c)));
roomCube.castShadow = true; roomCube.receiveShadow = true;
roomCube.userData.frame = true;
prepare(roomCube);
let cubeLetter = -1, cubeSolid = false;
// le cube posé est un obstacle pour le roi du joueur (les troupes, elles, le contournent côté serveur)
function cubeCollide(on) {
    if (on === cubeSolid) return;
    cubeSolid = on;
    for (const list of [colliders, groundColliders]) {
        const i = list.indexOf(roomCube);
        if (on && i < 0) list.push(roomCube);
        if (!on && i >= 0) list.splice(i, 1);
    }
}
// le chat de la maison : un géant pour les figurines !
function makeCat() {
    const fur = new THREE.MeshStandardMaterial({ color: '#e8a253', roughness: 0.9 });
    const white = new THREE.MeshStandardMaterial({ color: '#fbf3e6', roughness: 0.9 });
    const dark = new THREE.MeshStandardMaterial({ color: '#b86b2a', roughness: 0.9 });
    const root = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), fur);
    body.scale.set(2.3, 2.1, 4.4); body.position.y = 4.3;
    const belly = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), white);
    belly.scale.set(1.9, 1.5, 3.6); belly.position.set(0, 3.7, 0.3);
    for (let i = 0; i < 3; i++) {                                   // rayures
        const st = new THREE.Mesh(new THREE.TorusGeometry(2.05, 0.18, 6, 24, Math.PI), dark);   // demi-anneau sur le dos
        st.position.set(0, 4.3, -1.6 + i * 1.3);
        st.scale.set(1.06, 0.98, 1);
        root.add(st);
    }
    const head = new THREE.Group();
    head.position.set(0, 6.4, 4.2);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(1.9, 24, 16), fur);
    const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.9, 16, 12), white);
    muzzle.scale.set(1.2, 0.8, 0.9); muzzle.position.set(0, -0.6, 1.4);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshStandardMaterial({ color: '#f08aa0', roughness: 0.5 }));
    nose.position.set(0, -0.25, 2.2);
    head.add(skull, muzzle, nose);
    for (const sx of [-1, 1]) {
        const ear = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.4, 4), fur);
        ear.position.set(sx * 1.1, 1.6, -0.1); ear.rotation.z = -sx * 0.35;
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.42, 14, 10), new THREE.MeshStandardMaterial({ color: '#7bd64a', roughness: 0.2 }));
        eye.position.set(sx * 0.75, 0.35, 1.6);
        const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), new THREE.MeshStandardMaterial({ color: '#111', roughness: 0.2 }));
        pupil.scale.set(0.5, 1.2, 0.5); pupil.position.set(sx * 0.78, 0.35, 1.98);
        head.add(ear, eye, pupil);
    }
    const legs = [];
    for (const [lx, lz] of [[-1.2, 2.6], [1.2, 2.6], [-1.2, -2.6], [1.2, -2.6]]) {
        const leg = new THREE.Group();
        leg.position.set(lx, 3.4, lz);
        const bone = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.55, 3.2, 12), fur);
        bone.position.y = -1.6;
        const paw = new THREE.Mesh(new THREE.SphereGeometry(0.65, 12, 8), white);
        paw.scale.set(1, 0.6, 1.3); paw.position.set(0, -3.2, 0.25);
        leg.add(bone, paw);
        legs.push(leg);
        root.add(leg);
    }
    const tail = new THREE.Group();
    tail.position.set(0, 5.2, -4.1);
    const t1 = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 4, 10), fur);
    t1.position.y = 2; tail.rotation.x = -0.5;
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), dark);
    tip.position.y = 4;
    tail.add(t1, tip);
    root.add(body, belly, head, tail);
    root.traverse(o => { if (o.isMesh) o.castShadow = true; });
    return { root, legs, tail, head };
}
const roomCat = makeCat();
// les pièces de la tirelire
const coinGeo = new THREE.CylinderGeometry(0.6, 0.6, 0.14, 20).rotateX(Math.PI / 2);
const coinMat = new THREE.MeshStandardMaterial({ color: '#f6c21a', metalness: 0.9, roughness: 0.25, emissive: '#5a4200', emissiveIntensity: 0.4 });
const roomCoins = new Map();
for (const o of [roomBall, roomCube, roomCat.root]) { o.visible = false; scene.add(o); }
const roomPos = { ball: { x: 0, z: 0 }, cat: { x: 0, z: 0 } };

function onRoomSnapshot(rm) {
    if (!rm) return;
    const [next, kind, left, obj] = rm;
    roomKind = kind;
    // le compte à rebours : on sait QUAND, jamais QUOI
    const chip = el('roomEvt');
    chip.classList.toggle('active', !!kind);
    chip.classList.toggle('soon', !kind && next <= 10);
    if (kind) setText(chip, ROOM_LABEL[kind] + (left > 3 && kind !== 'ball' && kind !== 'roar' ? ` · ${mmss(left)}` : ''));
    else setText(chip, next <= 10 ? `🧸 La chambre frémit… ❓ dans ${mmss(next)}` : `🧸 Prochain événement : ❓ dans ${mmss(next)}`);
    // objets
    roomBall.visible = kind === 'ball';
    roomCat.root.visible = kind === 'cat';
    if (kind === 'ball' || kind === 'cat') {
        const p = roomPos[kind], [x, z, dir] = obj;
        if (Math.abs(x - p.x) > 8) { p.x = x; p.z = z; }            // il vient d'apparaître : pas de glissade depuis l'ancienne place
        p.tx = x; p.tz = z; p.dir = dir;
    }
    if (kind === 'cube') {
        const [x, z, letter, fall] = obj;
        if (letter !== cubeLetter) {                                   // une nouvelle lettre sur la face du dessus et de devant
            cubeLetter = letter;
            for (const i of [2, 4]) { roomCube.material[i].dispose(); roomCube.material[i] = letterMat(CUBE_LETTERS[letter], CUBE_COLORS[(letter + i) % 6]); }
        }
        roomCube.userData.fall = fall;
        roomCube.position.set(x, 1.6 + (fall / 1.2) ** 2 * 26, z);
        roomCube.visible = true;
        cubeCollide(fall <= 0);
    } else if (roomCube.visible) { roomCube.visible = false; cubeCollide(false); cubeLetter = -1; }
    // pièces : on ajoute les nouvelles, on retire les ramassées
    const seen = new Set();
    if (kind === 'coins') for (const [id, x, z] of obj) {
        seen.add(id);
        if (!roomCoins.has(id)) {
            const m = new THREE.Mesh(coinGeo, coinMat);
            m.position.set(x, groundAt(x, 6, z) + 0.6, z);
            m.castShadow = true;
            m.userData.phase = id * 1.3;
            scene.add(m);
            roomCoins.set(id, m);
        }
    }
    for (const [id, m] of roomCoins) if (!seen.has(id)) { scene.remove(m); roomCoins.delete(id); }
}
// effets ponctuels envoyés par le serveur (fx)
function roomFx(f) {
    if (f.k === 'room') {
        if (f.e === 'ball') play('boing', null, 0.7);
        else if (f.e === 'cat') play('meow', null, 0.9);
        else if (f.e === 'cube') play('whoosh', null, 0.8);
        else if (f.e === 'roar') { play('plushRoar', null, 1); shakeT = 1.6; }
        else if (f.e === 'mist') play('mist', null, 0.9);
        else if (f.e === 'coins') play('coins', null, 1);
        return true;
    }
    if (f.k === 'bump') { puff(new THREE.Vector3(...f.p), '#ffd23a', 4, 1, 1.2); play('boing', f.p, 0.8); return true; }
    if (f.k === 'cubeLand') {
        const at = new THREE.Vector3(...f.p);
        puff(at.clone().setY(0.6), '#e8e2d6', 18, 3, 1);
        play('thud', f.p, 1);
        if (Math.hypot(pos.x - at.x, pos.z - at.z) < 25) shakeT = Math.max(shakeT, 0.5);
        return true;
    }
    if (f.k === 'poof') { puff(new THREE.Vector3(...f.p), '#f3ead8', 14, 2.5, 1.5); return true; }
    if (f.k === 'coin') {
        puff(new THREE.Vector3(...f.p).setY(0.9), '#ffd23a', 6, 0.9, 2);
        play('coins', f.p, f.pid === myId ? 1 : 0.5);
        if (f.pid === myId) toast('🪙 +30 pièces pour ton royaume !', 1.5);
        return true;
    }
    return false;
}
// animation, à chaque image
const MIST_FOG = 0.03, BASE_FOG = scene.fog.density;
function updateRoomFx(dt, t) {
    for (const [kind, obj] of [['ball', roomBall], ['cat', roomCat.root]]) {
        if (!obj.visible) continue;
        const p = roomPos[kind];
        if (p.tx === undefined) continue;
        const k = 1 - Math.exp(-10 * dt), ox = p.x;
        p.x += (p.tx - p.x) * k; p.z += (p.tz - p.z) * k;
        if (kind === 'ball') {
            roomBall.position.set(p.x, 2.2 + Math.abs(Math.sin(t * 5)) * 0.4, p.z);
            roomBall.rotation.z -= (p.x - ox) / 2.2;                    // il roule
        } else {
            const c = roomCat;
            c.root.position.set(p.x, 0, p.z);
            c.root.rotation.y = p.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
            c.legs.forEach((l, i) => { l.rotation.x = Math.sin(t * 6 + (i === 0 || i === 3 ? 0 : Math.PI)) * 0.45; });
            c.tail.rotation.z = Math.sin(t * 2) * 0.4;
            c.head.rotation.y = Math.sin(t * 0.7) * 0.3;
        }
    }
    if (roomCube.visible && roomCube.userData.fall > 0) roomCube.rotation.y += dt * 3;
    for (const m of roomCoins.values()) {
        m.rotation.y += dt * 4;
        m.position.y += Math.sin(t * 3 + m.userData.phase) * 0.004;
    }
    // brume de la veilleuse : le brouillard s'épaissit doucement, puis se dissipe
    const fog = roomKind === 'mist' ? MIST_FOG : BASE_FOG;
    scene.fog.density += (fog - scene.fog.density) * (1 - Math.exp(-1.5 * dt));
    // la peluche rugit : la caméra tremble
    if (shakeT > 0) {
        shakeT = Math.max(0, shakeT - dt);
        const a = shakeT * 0.35;
        camera.position.x += (Math.random() - 0.5) * a;
        camera.position.y += (Math.random() - 0.5) * a;
    }
}
// mini-carte brouillée par la brume : seuls les châteaux restent visibles
function mistMinimap(W, H) {
    mm.fillStyle = 'rgba(236, 230, 220, 0.88)';
    mm.fillRect(0, 0, W, H);
    for (let i = 0; i < 70; i++) {
        mm.fillStyle = `rgba(150, 140, 130, ${Math.random() * 0.35})`;
        mm.fillRect(Math.random() * W, Math.random() * H, 3, 3);
    }
    mm.font = '28px system-ui';
    mm.textAlign = 'center';
    mm.fillText('🌫️', W / 2, H / 2 + 10);
}

// =====================================================================
//  BROUILLARD DE GUERRE (mode de jeu)
// =====================================================================
// Le serveur n'envoie que les ennemis que l'on voit ; ici, un voile sombre couvre le tapis, percé autour
// de ce qui voit : ses troupes, son roi, son château, ses dragons et les boules de feu tombées (fv).
let fogMode = false, VISION = null, fogTimer = 0;
const FOG_W = 80, FOG_D = 124, FOG_PX = 2;                       // terrain couvert (unités) et pixels par unité
const fogCanvas = document.createElement('canvas');
fogCanvas.width = FOG_W * FOG_PX; fogCanvas.height = FOG_D * FOG_PX;
const fogCtx = fogCanvas.getContext('2d');
const fogTex = new THREE.CanvasTexture(fogCanvas);
const fogPlane = new THREE.Mesh(new THREE.PlaneGeometry(FOG_W, FOG_D).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: fogTex, transparent: true, depthWrite: false }));
fogPlane.position.y = 0.3;
fogPlane.renderOrder = 1;
fogPlane.visible = false;
scene.add(fogPlane);
// ce qui voit, de notre côté : [x, z, rayon]
function visionSources() {
    const src = [];
    const g = toWorld(myTeam, 0, 0, 9);
    src.push([g.x, g.z, VISION.castle]);
    for (const u of unitObjs.values()) if (u.team === myTeam) src.push([u.x, u.z, u.type === 'archer' ? VISION.archer : VISION.unit]);
    if (!kingDead) src.push([pos.x, pos.z, VISION.king]);
    for (const r of remotes.values()) if (r.team === myTeam) src.push([r.fig.root.position.x, r.fig.root.position.z, VISION.king]);
    for (const d of dragonObjs.values()) if (d.team === myTeam) src.push([d.m.root.position.x, d.m.root.position.z, VISION.dragon]);
    for (const [x, z] of lastSnap?.fv || []) src.push([x, z, VISION.reveal]);
    return src;
}
// voile : sombre partout, éclairci en dégradé autour de chaque source
function paintFog(ctx, src, toPx, scale) {
    const { width: w, height: h } = ctx.canvas;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(28, 24, 44, 0.62)';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-out';
    for (const [x, z, r] of src) {
        const [px, py] = toPx(x, z), pr = r * scale;
        const grad = ctx.createRadialGradient(px, py, pr * 0.55, px, py, pr);
        grad.addColorStop(0, 'rgba(0,0,0,1)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
}
function updateFog(dt) {
    if (!fogMode || !VISION) return;
    if ((fogTimer -= dt) > 0) return;
    fogTimer = 1 / 10;                                                   // 10 fois par seconde suffit
    paintFog(fogCtx, visionSources(), (x, z) => [(x + FOG_W / 2) * FOG_PX, (z + FOG_D / 2) * FOG_PX], FOG_PX);
    fogTex.needsUpdate = true;
}
function setFogMode(on, vision) {
    fogMode = on && !spectating;                                         // les spectateurs voient tout
    VISION = vision;
    fogPlane.visible = fogMode;
}
// la mini-carte aussi est voilée (calque à part, posé par-dessus)
const mmFog = document.createElement('canvas');
function fogMinimap(mx, my, W, H) {
    if (!fogMode || !VISION) return;
    mmFog.width = W; mmFog.height = H;
    const ctx = mmFog.getContext('2d');
    paintFog(ctx, visionSources(), (x, z) => [mx(x), my(z)], W / 64);
    mm.drawImage(mmFog, 0, 0);
}

// =====================================================================
//  ORDRES AUX TROUPES
// =====================================================================
const ORDER_MODES = ['attack', 'defend', 'follow', 'hill'];
const ORDER_HINT = {
    attack: 'Tes troupes marchent sur le château ennemi.',
    defend: 'Tes troupes tiennent la ligne devant ton pont-levis (sous l\'étendard).',
    follow: 'Tes troupes escortent ton roi, même jusque dans le château ennemi.',
    hill: 'Tes troupes se postent autour du drapeau de la colline.',
};
function giveOrder(mode) {
    if (phase !== 'playing' || !lastSnap) return;
    if (ORDER_MODES[lastSnap.or[myTeam === 'red' ? 0 : 1]] === mode) return;
    send({ t: 'order', mode });
}
for (const b of document.querySelectorAll('.orderBtn')) b.addEventListener('click', () => { giveOrder(b.dataset.order); b.blur(); });
function refreshOrders(s) {
    const mode = ORDER_MODES[s.or[myTeam === 'red' ? 0 : 1]] || 'attack';
    for (const b of document.querySelectorAll('.orderBtn')) b.classList.toggle('active', b.dataset.order === mode);
    setText(el('orderHint'), ORDER_HINT[mode]);
    // étendard planté au point de défense de chaque camp qui défend
    ['red', 'blue'].forEach((t, i) => { defendFlags[t].visible = ORDER_MODES[s.or[i]] === 'defend'; });
}
// étendard de défense : un mât et un fanion aux couleurs du camp, devant le pont-levis
const defendFlags = {};
for (const t of ['red', 'blue']) {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 3.2, 10), plastic('#6b4423', 0.6));
    pole.position.y = 1.6;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 10), plastic('#e8b923', 0.3));
    tip.position.y = 3.35;
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.8).translate(0.6, 0, 0), new THREE.MeshStandardMaterial({ color: TEAM[t].main, roughness: 0.6, side: THREE.DoubleSide }));
    cloth.position.y = 2.75;
    const shield = new THREE.Mesh(new THREE.CircleGeometry(0.22, 20), new THREE.MeshStandardMaterial({ color: '#f6c21a', roughness: 0.4, side: THREE.DoubleSide }));
    shield.position.set(0.55, 2.75, 0.01);
    g.add(pole, tip, cloth, shield);
    g.traverse(o => { if (o.isMesh) o.castShadow = true; });
    const p = toWorld(t, 0, 0, 18.6);
    g.position.set(p.x, 0, p.z);
    g.visible = false;
    scene.add(g);
    defendFlags[t] = g;
}

function buildSpells() {
    const box = el('spellBtns');
    box.innerHTML = '';
    for (const key of MAGE_KEYS) {
        const m = MAGES[key];
        const b = document.createElement('button');
        b.className = 'spellBtn locked';
        b.dataset.spell = key;
        b.innerHTML = `<span class="skey">${m.key}</span><span class="slock">🔒</span><span class="sico">${m.icon}</span><span class="scd"></span>` +
            `<span class="sname">${m.spell}</span><span class="saction"></span>`;
        b.addEventListener('click', () => { useSpell(key); b.blur(); });
        // fiche du sort au survol (ou au focus clavier)
        b.addEventListener('mouseenter', () => showSpellInfo(key));
        b.addEventListener('focus', () => showSpellInfo(key));
        b.addEventListener('mouseleave', hideSpellInfo);
        b.addEventListener('blur', hideSpellInfo);
        box.appendChild(b);
    }
}
// durées lisibles : « 45 s », « 4:59 », « 5 min »
const fmtLeft = sec => (sec >= 60 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : `${sec} s`);
const fmtDuration = sec => (sec >= 60 && sec % 60 === 0 ? `${sec / 60} min` : fmtLeft(sec));
// ce que fait chaque sort, en une phrase
const SPELL_EFFECT = {
    potion: m => `Rend <b>${m.heal} PV</b> à ton roi, même en pleine bataille.`,
    fireball: m => `Clique sur le champ de bataille : elle s'abat là où tu vises et brûle les <b>troupes, barricades et chapiteau</b> ennemis dans la zone.`,
    dragon: m => `Ton dragon chasse pendant <b>${m.duration} s</b> les troupes ennemies hors de leur château et les réduit en cendres (sans prime, sans toucher aux constructions).`,
};
// état d'un sort pour mon royaume : 'locked' (tour à bâtir), 'cooling', 'full' (potion inutile), 'poor', 'ready'
function spellState(key) {
    if (!lastSnap) return { state: 'locked', cd: 0 };
    const i = myTeam === 'red' ? 0 : 1, j = MAGE_KEYS.indexOf(key), m = MAGES[key];
    const built = lastSnap.mg[i][j], cd = lastSnap.sc[i][j];
    if (!built) return { state: myGold < m.build ? 'lockedPoor' : 'locked', cd };
    if (cd > 0) return { state: 'cooling', cd };
    if (key === 'potion' && myKingHpPct >= 100) return { state: 'full', cd };
    if (myGold < m.cost) return { state: 'poor', cd };
    return { state: 'ready', cd };
}
let spellInfoKey = null;
function showSpellInfo(key) {
    spellInfoKey = key;
    refreshSpellInfo();
    el('spellInfo').classList.add('show');
}
function hideSpellInfo() {
    spellInfoKey = null;
    el('spellInfo').classList.remove('show');
}
function refreshSpellInfo() {
    if (!spellInfoKey) return;
    const key = spellInfoKey, m = MAGES[key], { state, cd } = spellState(key);
    const next = {
        locked: `👉 Clique (ou touche <b>${m.key}</b>) pour bâtir la tour : <b>${m.build} 🪙</b>.`,
        lockedPoor: `🏗️ Il faut <b>${m.build} 🪙</b> pour bâtir la tour (tu en as ${myGold}).`,
        cooling: `⏳ Le mage reprend des forces : encore <b>${fmtLeft(cd)}</b>.`,
        full: `❤️ Ton roi a déjà toute sa vie : garde ta potion pour plus tard.`,
        poor: `🪙 Il faut <b>${m.cost} 🪙</b> pour lancer ce sort (tu en as ${myGold}).`,
        ready: key === 'fireball' ? `✨ Clique (ou touche <b>${m.key}</b>), puis vise le champ de bataille.` : `✨ Prêt ! Clique ou appuie sur <b>${m.key}</b>.`,
    }[state];
    el('spellInfo').innerHTML = `<div class="siHead">${m.icon} <b>${m.spell}</b><span>${m.tower}</span></div>` +
        `<div>${SPELL_EFFECT[key](m)}</div>` +
        `<div class="siStats">Lancer : ${m.cost} 🪙 · Recharge : ${fmtDuration(m.cd)}${state.startsWith('locked') ? ` · Tour : ${m.build} 🪙` : ''}</div>` +
        `<div class="siNext ${state === 'ready' || state === 'locked' ? 'ok' : ''}">${next}</div>`;
}
let pendingBuild = null;            // touche R/T/Y sur une tour pas encore bâtie : il faut confirmer
function useSpell(key, fromKey = false) {
    if (!lastSnap || phase !== 'playing') return;
    if (kingDead) { toast('👑 Attends le couronnement de ton nouveau roi pour lancer un sort.', 2.5); return; }
    const m = MAGES[key], { state, cd } = spellState(key);
    // on explique pourquoi ça ne marche pas, plutôt que de laisser un bouton muet
    if (state !== 'ready' && state !== 'locked') play('deny');
    if (state === 'lockedPoor') { toast(`🏗️ Il te faut ${m.build} 🪙 pour bâtir la ${m.tower} (tu en as ${myGold}).`, 2.5); return; }
    if (state === 'locked') {
        if (fromKey && !(pendingBuild && pendingBuild.key === key && performance.now() < pendingBuild.until)) {
            pendingBuild = { key, until: performance.now() + 3000 };
            toast(`🏗️ Appuie encore sur ${m.key} pour bâtir la ${m.tower} (${m.build} 🪙).`, 3);
            return;
        }
        pendingBuild = null;
        send({ t: 'mage', key });
        return;
    }
    if (state === 'cooling') { toast(`⏳ ${m.spell} : le mage reprend des forces, encore ${fmtLeft(cd)}.`, 2); return; }
    if (state === 'full') { toast('❤️ Ton roi a déjà toute sa vie : garde ta potion !', 2); return; }
    if (state === 'poor') { toast(`🪙 Il te faut ${m.cost} 🪙 pour lancer ${m.spell} (tu en as ${myGold}).`, 2.5); return; }
    if (key === 'fireball') { setAiming(!aiming); return; }
    send({ t: 'spell', key });
}
// une tour vient d'être bâtie : on l'annonce, avec la touche à utiliser, et des étincelles sur la tour
let myMagesBuilt = null;
function watchMageTowers(s) {
    const now = s.mg[myTeam === 'red' ? 0 : 1];
    if (myMagesBuilt) {
        MAGE_KEYS.forEach((key, j) => {
            if (!now[j] || myMagesBuilt[j]) return;
            const m = MAGES[key];
            toast(`🔮 La ${m.tower} est bâtie ! Appuie sur ${m.key} (ou clique dans le grimoire) pour lancer ${m.icon} ${m.spell}.`, 4.5);
            play('build');
            const g = castles[myTeam].mageTowers?.[key]?.group;
            if (g) {
                const p = g.getWorldPosition(new THREE.Vector3());
                for (const y of [3, 7, 11]) puff(p.clone().setY(y), '#ffe27a', 6, 2, 2);
            }
        });
    }
    myMagesBuilt = [...now];
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
aimRay.firstHitOnly = true;
function setAiming(on) {
    aiming = on;
    aimRing.visible = on && aimValid;
    el('aimMsg').classList.toggle('show', on);
    if (on && MAGES.fireball) el('aimCost').textContent = MAGES.fireball.cost;
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
            play('roar', m.root.position.toArray(), 1.2);
            d = { m, team: ti ? 'blue' : 'red' };
            dragonObjs.set(id, d);
        }
        Object.assign(d, { tx: x, tz: z, ry, breath, leaving });
    }
    for (const [id, d] of dragonObjs) {
        if (seen.has(id)) continue;
        puff(d.m.root.position.clone(), '#f4f1ea', 12, 2.5, 1.5);
        d.sound?.stop();
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
        if (d.breath && !d.sound) d.sound = startLoop('fire', r.position.toArray());
        if (!d.breath && d.sound) { d.sound.stop(); d.sound = null; }
        d.sound?.update(r.position.toArray());
        if (Math.sin(t * 7 + d.m.phase) > 0.95 && !d.flapped) { d.flapped = true; play('flap', r.position.toArray()); }
        if (Math.sin(t * 7 + d.m.phase) < 0) d.flapped = false;
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

// troupe vue de près : figurine détaillée ; de loin : version allégée (même pose, même animation)
const LOD_FAR = 26 * 26, LOD_NEAR = 22 * 22;
function useModel(u, m) {
    const old = u.model;
    if (old === m) return;
    m.root.position.copy(old.root.position);
    m.root.rotation.copy(old.root.rotation);
    m.phase = old.phase; m.swing = old.swing;
    if ('anim' in old) m.anim = old.anim;
    m.root.add(u.bar);
    scene.remove(old.root);
    scene.add(m.root);
    u.model = m;
}

function updateUnits(dt) {
    const cx = camera.position.x, cz = camera.position.z;
    for (const u of unitObjs.values()) {
        const d2 = (u.x - cx) ** 2 + (u.z - cz) ** 2;
        if (u.model === u.hi && d2 > LOD_FAR) useModel(u, u.low);
        else if (u.model === u.low && d2 < LOD_NEAR) useModel(u, u.hi);
        const k = 1 - Math.exp(-10 * dt);
        const ox = u.x, oz = u.z;
        if (Math.hypot(u.tx - u.x, u.tz - u.z) > 6) { u.x = u.tx; u.z = u.tz; }
        u.x += (u.tx - u.x) * k;
        u.z += (u.tz - u.z) * k;
        const moved = Math.hypot(u.x - ox, u.z - oz);
        const root = u.model.root;
        if (Math.abs(u.x - u.gx) > 0.02 || Math.abs(u.z - u.gz) > 0.02 || --u.gt <= 0) {
            u.gy = unitGround(u.x, u.z); u.gx = u.x; u.gz = u.z; u.gt = 12;
        }
        root.position.set(u.x, THREE.MathUtils.lerp(root.position.y, u.gy, 1 - Math.exp(-15 * dt)), u.z);
        let diff = u.rot - root.rotation.y;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        root.rotation.y += diff * (1 - Math.exp(-8 * dt));

        const speed = moved / Math.max(dt, 1e-4);
        if (u.big) {
            for (const w of u.model.wheels) w.rotation.x += moved / 0.36;
            if (u.model.kind === 'ram') {
                // le tronc recule puis frappe d'un coup, et se stabilise
                u.model.anim = Math.max(0, u.model.anim - dt * 1.2);
                const k = 1 - u.model.anim;
                u.model.swing.rotation.x = u.model.anim === 0 ? 0 : k < 0.45 ? 0.55 * (k / 0.45) : k < 0.6 ? 0.55 - 1.05 * ((k - 0.45) / 0.15) : -0.5 * (1 - (k - 0.6) / 0.4);
            } else if (u.model.kind === 'cannon') {
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
            // peur (rugissement de la peluche) : la figurine tremble sur place
            root.rotation.z = u.state === 3 ? Math.sin(performance.now() / 22 + u.id) * 0.12 : 0;
            // l'archer tend son arc quand il tire
            if (u.type === 'archer' && (u.state === 1 || u.state === 2)) {
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
const fireballMat = new THREE.MeshStandardMaterial({ color: '#ffb02e', emissive: '#ff6a00', emissiveIntensity: 2.5 });
const arrowModel = (() => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(arrowGeo, plastic('#7a4a22')), new THREE.Mesh(arrowTipGeo, plastic('#5a5f66')));
    return bakeModel({ root }).root;                       // fût et pointe fusionnés : un seul objet par flèche
})();
function launch(kind, a, b, d, r = 0) {
    const A = new THREE.Vector3(...a), Bv = new THREE.Vector3(...b);
    if (A.y < 3) A.y += unitGround(A.x, A.z);
    if (Bv.y < 1.5) Bv.y += unitGround(Bv.x, Bv.z);
    let mesh;
    if (kind === 'arrow') {
        mesh = arrowModel.clone();
    } else if (kind === 'ball') {
        mesh = new THREE.Mesh(ballGeo, plastic('#1f2024', 0.3));
        mesh.castShadow = true;
    } else if (kind === 'fireball') {
        mesh = new THREE.Mesh(fireballGeo, fireballMat);
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
            if (p.kind === 'stone' || p.kind === 'ball') play('impact', p.B.toArray());
            if (p.kind === 'stone') puff(p.B, '#b8a58a', 9, 1.6);
            else if (p.kind === 'ball') puff(p.B, '#6a6560', 8, 1.3);
            else if (p.kind === 'fireball') {
                play('fireballBoom', p.B.toArray());
                // explosion : flammes sur toute la zone, puis fumée
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

// fumée, poussière, étincelles : toutes les bouffées sont dessinées en un seul appel (un maillage instancié,
// chaque bouffée y a sa position, sa taille, sa couleur et sa transparence) au lieu d'un objet et d'un matériau chacune
const PUFF_MAX = 700;
const puffs = [];
const puffGeo = new THREE.SphereGeometry(1, 12, 8);
const puffAlpha = new THREE.InstancedBufferAttribute(new Float32Array(PUFF_MAX), 1);
puffAlpha.setUsage(THREE.DynamicDrawUsage);
puffGeo.setAttribute('puffAlpha', puffAlpha);
const puffMat = new THREE.MeshStandardMaterial({ roughness: 1, transparent: true, depthWrite: false });
puffMat.onBeforeCompile = sh => {
    sh.vertexShader = `attribute float puffAlpha;
varying float vPuffAlpha;
${sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvPuffAlpha = puffAlpha;')}`;
    sh.fragmentShader = `varying float vPuffAlpha;
${sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n\tdiffuseColor.a *= vPuffAlpha;')}`;
};
const puffMesh = new THREE.InstancedMesh(puffGeo, puffMat, PUFF_MAX);
puffMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
puffMesh.setColorAt(0, new THREE.Color());
puffMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
puffMesh.count = 0;
puffMesh.frustumCulled = false;
scene.add(puffMesh);
const puffColors = new Map();
function puff(at, color = '#d9d2c5', n = 6, size = 1, rise = 1) {
    let c = puffColors.get(color);
    if (!c) puffColors.set(color, c = new THREE.Color(color));
    for (let i = 0; i < n; i++) {
        if (puffs.length >= PUFF_MAX) puffs.shift();             // bataille géante : les plus anciennes s'effacent
        puffs.push({
            x: at.x + (Math.random() - 0.5) * size, y: at.y + Math.random() * 0.4 * size, z: at.z + (Math.random() - 0.5) * size,
            c, t: 0, life: 0.6 + Math.random() * 0.5, grow: (0.4 + Math.random() * 0.5) * size, vy: (0.5 + Math.random()) * rise,
        });
    }
}
function updatePuffs(dt) {
    const M = puffMesh.instanceMatrix.array, C = puffMesh.instanceColor.array, A = puffAlpha.array;
    let n = 0;
    for (let i = 0; i < puffs.length; i++) {
        const p = puffs[i];
        p.t += dt;
        const k = p.t / p.life;
        if (k >= 1) continue;
        p.y += p.vy * dt;
        puffs[n] = p;
        const sc = 0.15 + p.grow * k, o = n * 16;
        M[o] = sc; M[o + 1] = 0; M[o + 2] = 0; M[o + 3] = 0;
        M[o + 4] = 0; M[o + 5] = sc; M[o + 6] = 0; M[o + 7] = 0;
        M[o + 8] = 0; M[o + 9] = 0; M[o + 10] = sc; M[o + 11] = 0;
        M[o + 12] = p.x; M[o + 13] = p.y; M[o + 14] = p.z; M[o + 15] = 1;
        C[n * 3] = p.c.r; C[n * 3 + 1] = p.c.g; C[n * 3 + 2] = p.c.b;
        A[n] = 0.85 * (1 - k);
        n++;
    }
    puffs.length = n;
    puffMesh.count = n;
    if (!n) return;
    puffMesh.instanceMatrix.clearUpdateRanges(); puffMesh.instanceMatrix.addUpdateRange(0, n * 16); puffMesh.instanceMatrix.needsUpdate = true;
    puffMesh.instanceColor.clearUpdateRanges(); puffMesh.instanceColor.addUpdateRange(0, n * 3); puffMesh.instanceColor.needsUpdate = true;
    puffAlpha.clearUpdateRanges(); puffAlpha.addUpdateRange(0, n); puffAlpha.needsUpdate = true;
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
        castle.merlonBatch.setVisible(m.userData.batchIndex, false);
        m.visible = true;
        scene.attach(m);
        falling.push({ m, vy: 2, vx: (Math.random() - 0.5) * 3, vz: (Math.random() - 0.5) * 3, spin: (Math.random() - 0.5) * 8, done: false });
        puff(m.position, '#c9c4bb', 4, 1.2);
    }
    castle.merlonBatch.sync();
}
function restoreCastle(castle) {
    for (let i = 0; i < castle.fallen; i++) {
        const m = castle.merlons[i];
        const h = m.userData.home;
        h.parent.add(m);
        m.position.copy(h.pos);
        m.rotation.copy(h.rot);
        m.visible = false;
        castle.merlonBatch.setVisible(m.userData.batchIndex, true);
        const f = falling.findIndex(f => f.m === m);
        if (f >= 0) falling.splice(f, 1);
    }
    castle.fallen = 0;
    castle.merlonBatch.sync();
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
let lastSnap = null, lastDefLevels = null;
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
    // une troupe qui disparaît : morte (petit nuage), ou partie dans le brouillard (elle s'efface sans bruit)
    const died = fogMode ? new Set(s.fx.filter(f => f.k === 'die').map(f => f.id)) : null;
    for (const [id, u] of unitObjs) {
        if (u.seen) continue;
        if (!died || died.has(id)) puff(u.model.root.position.clone().setY(u.model.root.position.y + 0.6), '#e8e2d6', u.big ? 10 : 6, u.big ? 1.8 : 1);
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

    // effets (onglet caché : l'animation est en pause, on ne les accumule pas pour tout rejouer d'un coup au retour)
    for (const f of document.hidden ? [] : s.fx) {
        if (roomFx(f)) continue;                     // événements de la chambre
        if (f.k === 'arrow' || f.k === 'stone' || f.k === 'ball' || f.k === 'fireball') {
            launch(f.k, f.a, f.b, f.d, f.r);
            if (f.k === 'arrow') play('arrow', f.a);
            else if (f.k === 'fireball') play('fireballLaunch', f.a);
        }
        else if (f.k === 'swing' && f.pid !== myId) {
            const r = remotes.get(f.pid);
            if (r) { r.fig.swing = 0.35; play('swing', r.fig.root.position.toArray()); }
        }
        else if (f.k === 'kingDie') { puff(new THREE.Vector3(...f.p).setY(f.p[1] + 0.8), '#f6c21a', 12, 1.5, 1.5); play('kingDie', null, 0.8); }
        else if (f.k === 'crown') { coronation(new THREE.Vector3(...f.p)); play('crown', null, f.pid === myId ? 1 : 0.6); }
        else if (f.k === 'die') play('die', f.p);
        else if (f.k === 'heal') {
            const at = new THREE.Vector3(...f.p);
            puff(at.clone().setY(at.y + 0.8), '#7dff9a', 14, 1.4, 2.5);
            puff(at.clone().setY(at.y + 1.6), '#eafff0', 6, 1, 3);
            if (f.pid === myId) toast(`🧪 La potion de vie te rend des forces !`, 2);
            play('heal', f.p);
        } else if (f.k === 'oil') {
            // l'huile tombe du chaudron et éclabousse tout le devant de la porte
            const c = new THREE.Vector3(...f.p);
            for (let i = 0; i < 6; i++) {
                const a = Math.random() * Math.PI * 2, r = Math.random() * f.r * 0.8;
                puff(c.clone().add(new THREE.Vector3(Math.cos(a) * r, 0.2, Math.sin(a) * r)), i % 2 ? '#ffb02e' : '#8a5a1e', 3, 1.2, 0.6);
            }
            puff(c.clone().setY(1.5), '#efe6d6', 6, 2.2, 2.5);
            play('oil', f.p);
        } else if (f.k === 'defDown') {
            const castle = castles[f.team];
            const obj = f.key === 'tent' ? castle.tentGroup : castle.barricadeGroup;
            const at = obj.getWorldPosition(new THREE.Vector3());
            puff(at.setY(0.8), f.key === 'tent' ? '#e8e2d6' : '#b08a5a', 14, f.key === 'tent' ? 3 : 2.2, 1.2);
            play('crash', at.toArray());
        }
        else if (f.k === 'melee') {
            const u = unitObjs.get(f.id);
            if (u && !u.big) u.model.swing = 0.35;
            if (f.crit && f.p) puff(new THREE.Vector3(...f.p), '#ffd23a', 4, 0.9, 1.2);     // coup efficace (troupe favorable)
            else if (f.p) puff(new THREE.Vector3(...f.p), '#d9d2c5', 2, 0.6);
            if (u) play('sword', u.model.root.position.toArray(), f.crit ? 1.2 : 0.8);
        } else if (f.k === 'fire') {
            const u = unitObjs.get(f.id);
            if (u) {
                u.model.anim = 1;
                play(u.type === 'cannon' ? 'cannon' : u.type === 'ram' ? 'ram' : 'catapult', u.model.root.position.toArray());
                if (u.type === 'ram') {
                    // le choc sur le pont-levis (ou les barricades) : éclats de bois devant le bélier
                    const r = u.model.root;
                    setTimeout(() => puff(new THREE.Vector3(r.position.x + Math.sin(r.rotation.y) * 2.4, r.position.y + 0.9, r.position.z + Math.cos(r.rotation.y) * 2.4), '#b08a5a', 6, 1.1, 1), 450);
                }
                if (u.type === 'cannon') {
                    const r = u.model.root;
                    puff(new THREE.Vector3(r.position.x + Math.sin(r.rotation.y) * 1.1, r.position.y + 1.0, r.position.z + Math.cos(r.rotation.y) * 1.1), '#efe9df', 7, 1.0, 1.5);
                }
            }
        }
    }

    // châteaux
    ['red', 'blue'].forEach((t, i) => {
        const gate = toWorld(t, 0, 2, 9).toArray();
        if (castles[t].door.open !== !!s.door[i] && !castles[t].door.broken) play('chain', gate);
        if (s.br[i] && !castles[t].door.broken) play('crash', gate);
        castles[t].door.open = !!s.door[i];
    });
    setBattle(s.ph === 'playing');
    tutoUpdate(s);
    updateModeBar(s);
    onRoomSnapshot(s.rm);
    refreshOrders(s);
    castles.red.setMages(Object.fromEntries(MAGE_KEYS.map((k, j) => [k, s.mg[0][j]])));
    castles.blue.setMages(Object.fromEntries(MAGE_KEYS.map((k, j) => [k, s.mg[1][j]])));
    syncDragons(s.dr);
    castles.red.setBroken(!!s.br[0]);
    castles.blue.setBroken(!!s.br[1]);
    if (lastDefLevels && s.d[myTeam === 'red' ? 0 : 1].some((v, j) => v > lastDefLevels[j])) play('build');
    lastDefLevels = [...s.d[myTeam === 'red' ? 0 : 1]];
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
    if (s.hp[myIdx] < lastHp[myIdx] - 30 && !spectating) flashDamage();
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
        const strong = Object.keys(COUNTERS[type] || {}).filter(t => COUNTERS[type][t] > 1);
        const weak = TYPES.filter(t => (COUNTERS[t]?.[type] ?? 1) > 1);
        const names = list => list.map(t => UNITS[t].name.toLowerCase()).join(', ');
        b.title = `${u.name} : coûte ${u.cost}, rapporte ${u.bounty} à l'ennemi qui l'abat · ${u.train} s de formation ` +
            `(${u.building === 'barracks' ? 'caserne, ou chapiteau s\'il est dressé' : 'atelier de siège'})` +
            (strong.length ? `\n💪 Fort contre : ${names(strong)}` : '') + (weak.length ? `\n⚠️ Craint : ${names(weak)}` : '') +
            (type === 'ram' ? '\n🐏 Frappe le pont-levis à pleine force, même levé, et défonce les barricades.' : '') +
            (u.splash ? '\n💥 Ses boulets explosent au milieu des troupes ennemies (dégâts de zone) ; sinon, il tire sur le château.' : '') +
            (type === 'catapult' ? '\n🎯 Tire de plus loin que les tours de garde : pilonne chapiteau, barricades puis château.' : '');
        // pastille verte : ce que la troupe bat ; pastille rouge : ce qu'elle craint
        const vs = (strong.length ? `<b>${strong.map(t => UNITS[t].icon).join('')}</b>` : '') +
            (weak.length ? `<i>${weak.map(t => UNITS[t].icon).join('')}</i>` : '');
        b.innerHTML = `<span class="key">${i + 1}</span><span class="queued"></span><span class="ico">${u.icon}</span><span class="nm">${u.name}</span>` +
            `<span class="vs">${vs || '&nbsp;'}</span><span class="cost">🪙 ${u.cost}</span><span class="prog"><i></i></span>`;
        b.addEventListener('click', () => { send({ t: 'spawn', unit: type }); b.blur(); });
        ui.btns.appendChild(b);
    });
    // défenses du château (touches 7, 8, 9, 0)
    const sep = document.createElement('div');
    sep.className = 'shopSep';
    ui.btns.appendChild(sep);
    DEF_KEYS.forEach((key, i) => {
        const d = DEFENSES[key];
        const b = document.createElement('button');
        b.className = 'unitBtn defBtn';
        b.dataset.def = key;
        b.title = DEF_HELP[key];
        b.innerHTML = `<span class="key">${(i + 7) % 10}</span><span class="lvl"></span><span class="ico">${d.icon}</span><span class="nm">${d.name}</span>` +
            `<span class="cost"></span><span class="prog"><i></i></span>`;
        b.addEventListener('click', () => { send({ t: 'defense', key }); b.blur(); });
        ui.btns.appendChild(b);
    });
}
const DEF_HELP = {
    towers: "Tours de garde : flèches plus fortes, plus rapides et plus lointaines. Au niveau 3, les deux tours tirent ensemble.",
    oil: "Huile bouillante : un chaudron au-dessus de la porte arrose régulièrement les ennemis massés devant le pont-levis.",
    barricade: "Barricades : elles se placent devant le pont-levis. Soldats, chevaliers et roi ennemis doivent les abattre pour passer. Niveau 2 : chevaux de frise qui piquent ceux qui les frappent.",
    tent: "Chapiteau : une caserne hors les murs. Tes soldats, archers et chevaliers peuvent y être formés et partent sans passer par le pont-levis. Mais l'ennemi peut l'abattre (les engins de siège le pilonnent de loin), et il faut alors attendre 40 s pour le relever !",
};

// l'interface est rafraîchie 20 fois par seconde : on n'écrit dans la page que ce qui a changé
// (chaque écriture oblige le navigateur à recalculer la mise en page)
const shown = new WeakMap();
function changed(node, key, v) {
    let m = shown.get(node);
    if (!m) shown.set(node, m = {});
    if (m[key] === v) return false;
    m[key] = v;
    return true;
}
const setText = (node, v) => { v = String(v); if (changed(node, 't', v)) node.textContent = v; };
const setHTML = (node, v) => { if (changed(node, 'h', v)) node.innerHTML = v; };
const setWidth = (node, v) => { if (changed(node, 'w', v)) node.style.width = v; };

function updateHud(s, kingHp) {
    setText(ui.gold, myGold);
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
        setText(b.querySelector('.queued'), n ? `×${n}` : '');
        b.querySelector('.queued').classList.toggle('show', n > 0);
        setWidth(b.querySelector('.prog i'), Math.round(progress * 100) + '%');
        b.disabled = phase !== 'playing' || myGold < u.cost || lists.every(([list]) => list.length >= QUEUE_MAX);
    }
    // défenses : niveau actuel, prix du prochain, PV des constructions
    for (const b of ui.btns.querySelectorAll('[data-def]')) {
        const key = b.dataset.def, d = DEFENSES[key];
        const lv = s.d[myI][DEF_KEYS.indexOf(key)];
        const next = d.levels[lv + 1];
        const max = d.levels.length - 1;
        const lvShown = key === 'towers' ? lv + 1 : lv;          // les tours démarrent au niveau 1
        setText(b.querySelector('.lvl'), key === 'tent' ? (lv ? 'dressé' : '') : `Nv ${lvShown}/${key === 'towers' ? max + 1 : max}`);
        b.querySelector('.lvl').classList.toggle('show', key !== 'tent' || lv > 0);
        const hpI = ['barricade', 'tent'].indexOf(key);
        const rebuild = hpI >= 0 && s.dc ? s.dc[myI][hpI] : 0;    // abattue : délai avant de pouvoir la relever
        setText(b.querySelector('.cost'), rebuild ? `⏳ ${rebuild} s` : next ? `🪙 ${next.cost}` : (key === 'tent' ? '✔ dressé' : '✔ max'));
        setWidth(b.querySelector('.prog i'), (hpI >= 0 && lv ? s.dh[myI][hpI] : 0) + '%');
        b.classList.toggle('built', !next);
        b.disabled = phase !== 'playing' || !next || myGold < next.cost || rebuild > 0;
    }
    myKingHpPct = kingHp;
    let anyBuilt = false;
    for (const b of document.querySelectorAll('.spellBtn')) {
        const key = b.dataset.spell, m = MAGES[key];
        const { state, cd } = spellState(key);
        const locked = state.startsWith('locked');
        if (!locked) anyBuilt = true;
        const cls = `spellBtn ${locked ? 'locked' : ''} ${state}${key === 'fireball' && aiming ? ' aiming' : ''}${tutoHi.includes(b) ? ' tutoHi' : ''}`;
        if (changed(b, 'c', cls)) b.className = cls;
        setHTML(b.querySelector('.saction'), {
            locked: `🏗️ Bâtir · ${m.build}`, lockedPoor: `🏗️ Bâtir · ${m.build}`,
            cooling: `⏳ ${fmtLeft(cd)}`, full: '❤️ PV max', poor: `🪙 ${m.cost}`, ready: `✨ Lancer · ${m.cost}`,
        }[state]);
        setText(b.querySelector('.scd'), state === 'cooling' ? (cd >= 60 ? fmtLeft(cd) : cd) : '');
        const cdv = state === 'cooling' ? cd / m.cd : 0;
        if (changed(b, 'cd', cdv)) b.style.setProperty('--cd', cdv);
        b.disabled = phase !== 'playing';
    }
    el('spellHint').style.display = anyBuilt ? 'none' : '';
    refreshSpellInfo();
    watchMageTowers(s);
    if (aiming && (kingDead || phase !== 'playing')) setAiming(false);
    setWidth(ui.kingFill, (kingDead ? 0 : kingHp) + '%');
    setText(ui.kingTxt, kingDead ? '👑 couronnement…' : `❤️ ${Math.round(kingHp / 100 * KING_HP)} / ${KING_HP}`);
    setWidth(ui.hpRed, (s.hp[0] / CASTLE_HP * 100).toFixed(1) + '%');
    setWidth(ui.hpBlue, (s.hp[1] / CASTLE_HP * 100).toFixed(1) + '%');
    setText(ui.hpRedTxt, s.hp[0]);
    setText(ui.hpBlueTxt, s.hp[1]);

    if (phase === 'waiting') {
        ui.lobby.classList.add('show');
        ui.lobbyText.innerHTML = myRoom
            ? `Salon <b>${escapeHtml(myRoom.name)}</b> ${myRoom.locked ? '🔒' : ''} : ${spectating ? 'les tribunes attendent les rois…' : "on guette l'arrivée d'un roi adverse…"}`
            : 'En attente d\'un adversaire…';
    } else ui.lobby.classList.remove('show');

    if (phase === 'over') {
        const [title, text] = spectating
            ? [`🏁 Le royaume ${winner === 'red' ? 'du Crâne' : 'du Lion'} l'emporte !`, 'Quelle bataille ! Reste dans les tribunes : la revanche peut commencer à tout moment.']
            : overTexts(winner === myTeam);
        setText(ui.overTitle, title);
        setText(ui.overText, text);
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
    if (roomKind === 'mist') return mistMinimap(W, H);          // la brume brouille la mini-carte
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
    fogMinimap(mx, my, W, H);                                   // brouillard de guerre : voile sur la mini-carte
    for (const r of remotes.values()) dot(r.fig.root.position.x, r.fig.root.position.z, TEAM[r.team].main, '#fff');
    dot(pos.x, pos.z, '#fff', spectating ? '#f6c21a' : TEAM[myTeam].main);     // spectateur : le point regardé
}

// =====================================================================
//  BOUCLE
// =====================================================================
let last = performance.now(), viewW = 0, viewH = 0, sendTimer = 0, mapTimer = 0, firstFrame = false;
// outil de test (« ?perf » dans l'adresse) : les scripts de mesure accèdent ici aux entrailles du jeu
if (new URLSearchParams(location.search).has('perf')) {
    window.__perf = {
        THREE, renderer, scene, camera, send, unitObjs, colliders, groundColliders, castRay, groundAt, unitGround, makeUnitModel, makePlayerModel, quality,
        teleport(x, z) { pos.set(x, groundAt(x, 20, z), z); vy = 0; },
        look(y, p, d) { yaw = y; pitch = p; camDistWanted = d; },
        room: { ball: roomBall, cat: roomCat, cube: roomCube },
    };
}

// Pré-compilation : pendant que le menu s'affiche, tous les effets (troupes, rois, dragons, projectiles) sont préparés
// sans figer la page. Sinon, la première apparition de chaque troupe provoque un accroc le temps de compiler son effet.
async function warmUp() {
    const g = new THREE.Group();
    for (const team of ['red', 'blue']) {
        for (const type of ['infantry', 'archer', 'knight', 'cannon', 'catapult', 'ram']) g.add(makeUnitModel(type, team).root);
        g.add(makePlayerModel(team).root, makeWarDragon(team).root);
    }
    g.add(arrowModel.clone(), new THREE.Mesh(stoneGeo, plastic('#8d939a', 0.6)), new THREE.Mesh(ballGeo, plastic('#1f2024', 0.3)),
        new THREE.Mesh(fireballGeo, fireballMat), new THREE.Mesh(fireConeGeo, fireMatOuter), new THREE.Mesh(fireConeGeo, fireMatInner));
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scene.add(g);
    try {
        await Promise.race([renderer.compileAsync(scene, camera), new Promise(r => setTimeout(r, 8000))]);
    } catch { /* la compilation se fera au fil de l'eau */ }
    scene.remove(g);
}
warmUp().finally(() => requestAnimationFrame(render));

function render(now) {
    if (canvas.clientWidth !== viewW || canvas.clientHeight !== viewH) {
        viewW = canvas.clientWidth; viewH = canvas.clientHeight;
        renderer.setSize(viewW, viewH, false);
        camera.aspect = viewW / viewH;
        camera.updateProjectionMatrix();
    }
    quality.frame((now - last) / 1000);
    updateFps((now - last) / 1000);
    const dt = THREE.MathUtils.clamp((now - last) / 1000, 0, 0.05);
    last = now;
    const t = now / 1000;

    // portes et ponts-levis
    for (const c of Object.values(castles)) c.updateDoor(dt);

    updatePlayer(dt);
    if (inMenu) menuCamera(t);
    else updateCamera(dt);
    updateRoomFx(dt, t);
    updateFog(dt);
    setListener(camera.position.x, camera.position.y, camera.position.z);
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
    updateBubbles();
    updateDragons(dt, t);
    updateAim();
    updateTutoArrow(t);
    if (lastSnap) updateSmoke(dt, lastSnap.hp);

    // entrée dans une salle des coffres
    const vault = vaults.find(v => Math.hypot(pos.x - v.pos.x, pos.z - v.pos.z) < v.r && pos.y < v.pos.y + 2);
    if (vault && vault !== inVault && lastSnap && !spectating) {
        const mine = vault.castle.team === myTeam;
        const g = lastSnap.g[vault.castle.team === 'red' ? 0 : 1];
        toast(mine ? `💰 Le trésor de ton royaume : ${g} pièces d'or. Garde-le bien !` : `💰 Le trésor d'en face ! La couronne est à toi…`, 3);
    }
    inVault = vault || null;

    if (myId !== null && !spectating && nearOwnGate()) {
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

    if ((mapTimer -= dt) <= 0) { mapTimer = 1 / 15; drawMinimap(); }   // 15 fois par seconde suffit
    renderer.render(scene, camera);
    if (!firstFrame) { firstFrame = true; performance.mark('frame1'); setTimeout(finishColliders, 50); }
    requestAnimationFrame(render);
}

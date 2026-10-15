import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// =====================================================================
//  Construction du monde : chambre, châteaux, figurines, engins de siège
// =====================================================================

export const COLORS = {
    red: '#d7262e', yellow: '#f6c21a', blue: '#1f5fbf', green: '#3fae49',
    darkGreen: '#2b8a3a', window: '#1b2340', wood: '#8a5a2b', orange: '#f0a640',
    gold: '#e8b923', black: '#2a2a33',
};
export const TEAM = {
    red: { main: '#d7262e', dark: '#a3171d', label: 'du Crâne' },
    blue: { main: '#1f5fbf', dark: '#123f85', label: 'du Lion' },
};

export const colliders = [];        // tout ce contre quoi le chevalier bute / marche
export const groundColliders = [];  // sols sur lesquels marchent les unités
export const flags = [];
export const flames = [];

let PARENT = null;                  // groupe dans lequel on construit
let CUR = null;                     // château en cours de construction
export function initWorld(scene) { PARENT = scene; }

// ---------------------------------------------------------------- matériaux
const matCache = {};
export function plastic(color, roughness = 0.38) {
    const key = 'p' + color + roughness;
    return matCache[key] ??= new THREE.MeshStandardMaterial({ color, roughness });
}
export function metal(color) {
    const key = 'm' + color;
    return matCache[key] ??= new THREE.MeshStandardMaterial({ color, roughness: 0.28, metalness: 0.75 });
}

function makeCanvas(size, draw) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    draw(c.getContext('2d'), size);
    return c;
}

const stoneCanvas = makeCanvas(256, (ctx, s) => {
    ctx.fillStyle = '#80868d';
    ctx.fillRect(0, 0, s, s);
    const rows = 4, cols = 2, bh = s / rows, bw = s / cols, gap = 7;
    const shades = [];
    for (let r = 0; r < rows; r++) {
        shades.push([]);
        for (let c = 0; c < cols; c++) shades[r].push(185 + Math.random() * 30);
    }
    for (let r = 0; r < rows; r++) {
        const off = (r % 2) * bw / 2;
        for (let c = -1; c <= cols; c++) {
            const v = shades[r][(c + cols) % cols];
            ctx.fillStyle = `rgb(${v},${v + 3},${v + 8})`;
            ctx.beginPath();
            ctx.roundRect(c * bw + off + gap / 2, r * bh + gap / 2, bw - gap, bh - gap, 10);
            ctx.fill();
            ctx.fillStyle = 'rgba(255,255,255,0.18)';
            ctx.fillRect(c * bw + off + gap, r * bh + gap, bw - gap * 2, 4);
        }
    }
});
const stoneTex = new THREE.CanvasTexture(stoneCanvas);
stoneTex.wrapS = stoneTex.wrapT = THREE.RepeatWrapping;
stoneTex.colorSpace = THREE.SRGBColorSpace;
stoneTex.anisotropy = 8;
const stoneBump = new THREE.CanvasTexture(stoneCanvas);
stoneBump.wrapS = stoneBump.wrapT = THREE.RepeatWrapping;

const stoneMat = new THREE.MeshStandardMaterial({
    map: stoneTex, bumpMap: stoneBump, bumpScale: 1.5, roughness: 0.55, color: '#f2f4f7',
});

const woodCanvas = makeCanvas(512, (ctx, s) => {
    const h = s / 8;
    for (let i = 0; i < 8; i++) {
        const v = Math.random() * 25;
        ctx.fillStyle = `rgb(${205 + v},${155 + v},${100 + v * 0.6})`;
        ctx.fillRect(0, i * h, s, h);
        ctx.strokeStyle = 'rgba(120,70,30,0.15)';
        for (let k = 0; k < 6; k++) {
            ctx.beginPath();
            const y = i * h + Math.random() * h;
            ctx.moveTo(0, y);
            ctx.bezierCurveTo(s * 0.3, y + 6, s * 0.6, y - 6, s, y);
            ctx.stroke();
        }
        ctx.fillStyle = 'rgba(90,50,20,0.45)';
        ctx.fillRect(0, i * h, s, 3);
        ctx.fillRect(((i * 197) % s), i * h, 3, h);
    }
});
const woodTex = new THREE.CanvasTexture(woodCanvas);
woodTex.wrapS = woodTex.wrapT = THREE.RepeatWrapping;
woodTex.repeat.set(24, 24);
woodTex.colorSpace = THREE.SRGBColorSpace;
woodTex.anisotropy = 8;

// ---------------------------------------------------------------- utilitaires
export function add(mesh, { collide = true, ground = false, parent = PARENT } = {}) {
    mesh.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    parent.add(mesh);
    if (collide) colliders.push(mesh);
    if (ground) groundColliders.push(mesh);
    return mesh;
}

const BRICK = 1 / 1.6;
function boxUV(geo, ox, oy, oz) {
    const p = geo.attributes.position, n = geo.attributes.normal;
    const uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
        const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
        const x = p.getX(i) + ox, y = p.getY(i) + oy, z = p.getZ(i) + oz;
        let u, v;
        if (ax >= ay && ax >= az) { u = z; v = y; }
        else if (ay >= az) { u = x; v = z; }
        else { u = x; v = y; }
        uv[i * 2] = u * BRICK;
        uv[i * 2 + 1] = v * BRICK;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

export function roundedBox(w, h, d, r = 0.12, seg = 2) {
    r = Math.min(r, w / 2 - 0.01, h / 2 - 0.01, d / 2 - 0.01);
    return new RoundedBoxGeometry(w, h, d, seg, Math.max(r, 0.005));
}

function stoneBox(w, h, d, x, y, z, { r = 0.12, mat = stoneMat, collide = true } = {}) {
    const geo = roundedBox(w, h, d, r);
    boxUV(geo, x, y + h / 2, z);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y + h / 2, z);
    return add(m, { collide });
}

function stoneCylinder(r, h, x, y, z, { seg = 40, mat = stoneMat } = {}) {
    const geo = new THREE.CylinderGeometry(r, r, h, seg);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2 * Math.PI * r * BRICK, uv.getY(i) * h * BRICK);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y + h / 2, z);
    return add(m);
}

function archShape(target, w, h, b = 0) {
    const r = w / 2, R = r + b;
    target.moveTo(-R, -b);
    target.lineTo(R, -b);
    target.lineTo(R, h - r);
    target.absarc(0, h - r, R, 0, Math.PI, false);
    target.lineTo(-R, -b);
    return target;
}
function makeWindow(w, h, { frame = COLORS.yellow, bars = false, inner = COLORS.window, barColor = null, barStep = 4 } = {}) {
    const g = new THREE.Group();
    const dark = new THREE.Mesh(new THREE.ShapeGeometry(archShape(new THREE.Shape(), w, h)), plastic(inner, 0.6));
    dark.position.z = 0.03;
    g.add(dark);
    const outer = archShape(new THREE.Shape(), w, h, 0.14);
    outer.holes.push(archShape(new THREE.Path(), w, h));
    const fr = new THREE.Mesh(new THREE.ExtrudeGeometry(outer, {
        depth: 0.08, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2, curveSegments: 16,
    }), plastic(frame));
    g.add(fr);
    if (bars) {
        const barGeo = new THREE.CylinderGeometry(0.045, 0.045, 1, 8);
        const bm = barColor ? plastic(barColor, 0.5) : metal('#4a4e55');
        for (let x = -w / 2 + w / barStep; x < w / 2 - 0.01; x += w / barStep) {
            const b = new THREE.Mesh(barGeo, bm);
            const top = h - w / 2 + Math.sqrt(Math.max(0, (w / 2) ** 2 - x * x));
            b.scale.y = top; b.position.set(x, top / 2, 0.12);
            g.add(b);
        }
        for (const y of [h * 0.3, h * 0.6]) {
            const b = new THREE.Mesh(barGeo, bm);
            b.scale.y = w; b.rotation.z = Math.PI / 2; b.position.set(0, y, 0.12);
            g.add(b);
        }
    }
    return g;
}

function shieldShape(w, h) {
    const s = new THREE.Shape();
    s.moveTo(-w / 2, h / 2);
    s.lineTo(w / 2, h / 2);
    s.lineTo(w / 2, 0);
    s.quadraticCurveTo(w / 2, -h * 0.35, 0, -h / 2);
    s.quadraticCurveTo(-w / 2, -h * 0.35, -w / 2, 0);
    s.lineTo(-w / 2, h / 2);
    return s;
}
function placeOn(obj, x, y, z, rotY = 0) {
    obj.position.set(x, y, z);
    obj.rotation.y = rotY;
    return add(obj, { collide: false });
}
function placeOnTower(obj, cx, cz, r, y, angle) {
    return placeOn(obj, cx + Math.sin(angle) * (r + 0.02), y, cz + Math.cos(angle) * (r + 0.02), angle);
}

function makeFlag(x, y, z, color, { map = null, pole: poleColor = null } = {}) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.2, 8), poleColor ? plastic(poleColor) : metal('#9a7b3a'));
    pole.position.set(x, y + 1.1, z);
    add(pole, { collide: false });
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 8), metal(COLORS.gold));
    ball.position.set(x, y + 2.25, z);
    add(ball, { collide: false });
    const geo = new THREE.PlaneGeometry(1.3, 0.75, 14, 4);
    geo.translate(0.65, 0, 0);
    const flag = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: map ? '#ffffff' : color, map, roughness: 0.5, side: THREE.DoubleSide }));
    flag.position.set(x + 0.04, y + 1.75, z);
    flag.userData.base = Float32Array.from(geo.attributes.position.array);
    flag.userData.phase = Math.random() * 6;
    add(flag, { collide: false });
    flags.push(flag);
}

function roundedRectShape(w, h, r) {
    const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
    return s;
}

const rockGeo = new THREE.IcosahedronGeometry(1, 1);
function rock(x, y, z, s, color = COLORS.darkGreen, collide = false) {
    const m = new THREE.Mesh(rockGeo, plastic(color, 0.4));
    m.position.set(x, y, z);
    m.scale.set(s * (0.9 + Math.random() * 0.4), s * (0.5 + Math.random() * 0.3), s * (0.9 + Math.random() * 0.4));
    m.rotation.set(Math.random(), Math.random() * 6, Math.random());
    return add(m, { collide });
}

// =====================================================================
//  LA CHAMBRE : parquet, tapis de jeu, cubes, arbres jouets
// =====================================================================
function letterTexture(letter, bg, fg) {
    const c = makeCanvas(256, (ctx, s) => {
        ctx.fillStyle = bg; ctx.fillRect(0, 0, s, s);
        ctx.strokeStyle = fg; ctx.lineWidth = 14;
        ctx.beginPath(); ctx.roundRect(20, 20, s - 40, s - 40, 28); ctx.stroke();
        ctx.fillStyle = fg; ctx.font = 'bold 170px Arial Black, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(letter, s / 2, s / 2 + 10);
    });
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}
function toyBlock(letter, bg, fg, x, y, z, rot) {
    const m = new THREE.Mesh(new RoundedBoxGeometry(2.4, 2.4, 2.4, 3, 0.18),
        new THREE.MeshStandardMaterial({ map: letterTexture(letter, bg, fg), roughness: 0.45 }));
    m.position.set(x, y + 1.2, z);
    m.rotation.y = rot;
    add(m);
}
function toyTree(x, z, s = 1) {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25 * s, 0.32 * s, 1.4 * s, 12), plastic('#8a5a2b', 0.5));
    trunk.position.y = 0.7 * s;
    g.add(trunk);
    const greens = ['#3fae49', '#57c25f', '#2b8a3a'];
    for (let i = 0; i < 3; i++) {
        const c = new THREE.Mesh(new THREE.ConeGeometry((1.4 - i * 0.35) * s, 1.4 * s, 20), plastic(greens[i], 0.35));
        c.position.y = (1.6 + i * 0.75) * s;
        g.add(c);
    }
    g.position.set(x, 0, z);
    add(g);
}

export function buildRoom() {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(320, 320), new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.7 }));
    floor.rotation.x = -Math.PI / 2;
    add(floor, { ground: true });

    // tapis de jeu avec le chemin entre les deux châteaux
    const mat = new THREE.Mesh(new THREE.ShapeGeometry(roundedRectShape(64, 124, 6), 12), plastic('#bfe0a0', 0.95));
    mat.rotation.x = -Math.PI / 2;
    mat.position.y = 0.01;
    add(mat, { collide: false });
    const road = new THREE.Mesh(new THREE.PlaneGeometry(22, 50), plastic('#e8cf9c', 0.95));
    road.rotation.x = -Math.PI / 2;
    road.position.y = 0.02;
    add(road, { collide: false });
    for (const z of [-25, 25]) {
        const end = new THREE.Mesh(new THREE.CircleGeometry(11, 40, z < 0 ? Math.PI : 0, Math.PI), plastic('#e8cf9c', 0.95));
        end.rotation.x = -Math.PI / 2;
        end.position.set(0, 0.02, z);
        add(end, { collide: false });
    }

    toyBlock('A', '#d7262e', '#fff', -30, 0, -6, 0.3);
    toyBlock('B', '#1f5fbf', '#f6c21a', -28, 0, -2.5, -0.2);
    toyBlock('C', '#f6c21a', '#d7262e', -29.6, 2.4, -5.3, 0.9);
    toyBlock('D', '#3fae49', '#fff', 30, 0, 4, 0.5);

    const ballCanvas = makeCanvas(256, (ctx, s) => {
        const cols = ['#d7262e', '#fff', '#1f5fbf', '#fff', '#f6c21a', '#fff', '#3fae49', '#fff'];
        cols.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(i * s / 8, 0, s / 8, s); });
    });
    const ballTex = new THREE.CanvasTexture(ballCanvas);
    ballTex.colorSpace = THREE.SRGBColorSpace;
    const bigBall = new THREE.Mesh(new THREE.SphereGeometry(1.4, 40, 24), new THREE.MeshStandardMaterial({ map: ballTex, roughness: 0.3 }));
    bigBall.position.set(28, 1.4, -8);
    bigBall.rotation.z = 0.4;
    add(bigBall);

    for (const [x, z, s] of [[-19, -12, 1.1], [-22, 3, 1.3], [-18, 14, 1], [19, 10, 1.2], [22, -4, 1], [18, -15, 1.3],
        [-24, -22, 1], [24, 22, 1.1], [-25, 24, 1.2], [25, -24, 1]]) toyTree(x, z, s);
    for (const [x, z] of [[-14, 6], [13, -7], [-12, -16], [15, 17]]) rock(x, 0.3, z, 0.9, '#9aa0a8', true);

    buildBedroom();
    buildMist();
}

// ---------------------------------------------------------------- nappes de brume au ras du tapis
export const mists = [];
function buildMist() {
    const tex = canvasTex(128, 128, (ctx, s) => {
        const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        g.addColorStop(0, 'rgba(255,255,255,1)');
        g.addColorStop(0.45, 'rgba(255,255,255,0.45)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    });
    for (let i = 0; i < 46; i++) {
        const mat = new THREE.SpriteMaterial({ map: tex, color: '#f4f7fb', transparent: true, opacity: 0, depthWrite: false });
        const sp = new THREE.Sprite(mat);
        const w = 16 + Math.random() * 18;
        sp.scale.set(w, w * (0.28 + Math.random() * 0.12), 1);     // nappes aplaties
        sp.position.set((Math.random() * 2 - 1) * 40, 1 + Math.random() * 2.5, (Math.random() * 2 - 1) * 68);
        sp.renderOrder = 2;
        PARENT.add(sp);
        mists.push({ sprite: sp, base: 0.2 + Math.random() * 0.15, speed: 0.6 + Math.random() * 0.8, phase: Math.random() * 6 });
    }
}

// =====================================================================
//  LA CHAMBRE D'ENFANT : passion chevaliers et dragons
//  (échelle : 1 unité ≈ 2,7 cm -> pièce d'environ 4,3 m × 5,4 m × 2,4 m)
// =====================================================================
export const spinners = [];         // objets qui tournent doucement (mobile du plafond)

const RX = 80, RZ = 100, RH = 90, WAINSCOT = 26;

function canvasTex(w, h, draw, { repeat = null } = {}) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
    return t;
}

// dragon de profil, tourné vers la droite (sert aux affiches, à la fresque et au papier peint)
function drawDragon(ctx, x, y, k, { body = '#2f9e44', wing = '#1f7a33', belly = '#f3d98a', fire = false } = {}) {
    ctx.save();
    ctx.translate(x, y); ctx.scale(k, k);
    ctx.lineCap = ctx.lineJoin = 'round';
    // aile du fond
    ctx.fillStyle = wing;
    ctx.beginPath(); ctx.moveTo(-5, -20); ctx.lineTo(-60, -125); ctx.lineTo(-20, -100); ctx.lineTo(10, -135); ctx.lineTo(25, -95);
    ctx.lineTo(60, -110); ctx.quadraticCurveTo(45, -50, 30, -22); ctx.fill();
    // queue effilée
    ctx.strokeStyle = body;
    const tail = [[-50, 5], [-95, 25], [-135, 20], [-160, -5], [-170, -30]];
    for (let i = 0; i < tail.length - 1; i++) {
        ctx.lineWidth = 26 - i * 6;
        ctx.beginPath(); ctx.moveTo(...tail[i]); ctx.lineTo(...tail[i + 1]); ctx.stroke();
    }
    ctx.fillStyle = '#f0a640';
    ctx.beginPath(); ctx.moveTo(-170, -48); ctx.lineTo(-184, -24); ctx.lineTo(-158, -26); ctx.fill();
    // pattes
    ctx.lineWidth = 16;
    for (const [lx, ly, fx] of [[-30, 15, -38], [30, 15, 36]]) {
        ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(fx, ly + 38); ctx.lineTo(fx + 14, ly + 40); ctx.stroke();
    }
    // corps, ventre, cou et tête
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.ellipse(0, 0, 62, 34, 0, 0, 7); ctx.fill();
    ctx.lineWidth = 26;
    ctx.beginPath(); ctx.moveTo(35, -10); ctx.quadraticCurveTo(70, -20, 82, -62); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(98, -70, 28, 17, 0.15, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(122, -62, 18, 10, 0.25, 0, 7); ctx.fill();
    ctx.fillStyle = belly;
    ctx.beginPath(); ctx.ellipse(8, 14, 44, 14, 0, 0, 7); ctx.fill();
    // cornes, piques du dos, oeil
    ctx.fillStyle = '#f3e3b0';
    ctx.beginPath(); ctx.moveTo(86, -84); ctx.lineTo(70, -110); ctx.lineTo(96, -88); ctx.fill();
    ctx.fillStyle = '#f0a640';
    for (let i = 0; i < 5; i++) {
        const sx = -40 + i * 18;
        ctx.beginPath(); ctx.moveTo(sx - 7, -30 + Math.abs(i - 2) * 2); ctx.lineTo(sx, -46 + Math.abs(i - 2) * 3); ctx.lineTo(sx + 7, -30 + Math.abs(i - 2) * 2); ctx.fill();
    }
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(102, -76, 6, 0, 7); ctx.fill();
    ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(104, -76, 3, 0, 7); ctx.fill();
    if (fire) {
        const g = ctx.createLinearGradient(140, -60, 260, -40);
        g.addColorStop(0, '#fff3a0'); g.addColorStop(0.4, '#ffb52a'); g.addColorStop(1, 'rgba(230,60,20,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.moveTo(138, -60); ctx.quadraticCurveTo(200, -100, 265, -70); ctx.quadraticCurveTo(220, -50, 262, -20);
        ctx.quadraticCurveTo(200, -30, 138, -56); ctx.fill();
    }
    ctx.restore();
}
function drawStar(ctx, x, y, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r;
        ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.fill();
}
function drawCrown(ctx, x, y, k) {
    ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
    ctx.fillStyle = '#e8b923';
    ctx.beginPath(); ctx.moveTo(-20, 12); ctx.lineTo(-22, -10); ctx.lineTo(-11, 0); ctx.lineTo(0, -16); ctx.lineTo(11, 0);
    ctx.lineTo(22, -10); ctx.lineTo(20, 12); ctx.fill();
    ctx.fillStyle = '#d62128'; ctx.beginPath(); ctx.arc(0, 4, 4, 0, 7); ctx.fill();
    ctx.restore();
}
function drawMiniShield(ctx, x, y, k, field, cross) {
    ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
    ctx.fillStyle = field;
    ctx.beginPath(); ctx.moveTo(-16, -18); ctx.lineTo(16, -18); ctx.lineTo(16, 2); ctx.quadraticCurveTo(14, 16, 0, 22);
    ctx.quadraticCurveTo(-14, 16, -16, 2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = cross; ctx.fillRect(-3, -15, 6, 32); ctx.fillRect(-13, -6, 26, 6);
    ctx.restore();
}

// papier peint bleu ciel : petits dragons, écus, couronnes et étoiles
const wallpaperTex = () => canvasTex(512, 512, (ctx, s) => {
    ctx.fillStyle = '#bcd7ec'; ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (let x = 0; x < s; x += 64) ctx.fillRect(x, 0, 22, s);          // rayures douces
    for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
        const x = col * 128 + (row % 2) * 64 + 32, y = row * 128 + 64;
        const kind = (row * 3 + col) % 4;
        if (kind === 0) drawDragon(ctx, x - 6, y + 14, 0.2, { body: '#3a9d5d', wing: '#2b7a47', belly: '#f3e3b0' });
        else if (kind === 1) drawMiniShield(ctx, x, y, 1.1, row % 2 ? '#1f5fbf' : '#d62128', '#f6c21a');
        else if (kind === 2) drawCrown(ctx, x, y, 1.1);
        else drawStar(ctx, x, y, 14, '#f6c21a');
    }
}, { repeat: [1, 1] });

// lambris peint en bas des murs et frise de créneaux au-dessus
const wainscotTex = () => canvasTex(256, 256, (ctx, s) => {
    ctx.fillStyle = '#2d4a7a'; ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = '#3e5f96'; ctx.lineWidth = 10;
    ctx.strokeRect(24, 24, s - 48, s - 48);
    ctx.strokeStyle = '#1d3358'; ctx.lineWidth = 4;
    ctx.strokeRect(34, 34, s - 68, s - 68);
    ctx.fillStyle = '#e8b923'; ctx.beginPath(); ctx.arc(s / 2, s / 2, 14, 0, 7); ctx.fill();
}, { repeat: [1, 1] });
const friezeTex = () => canvasTex(256, 64, (ctx, w, h) => {
    ctx.fillStyle = '#e9e2d0'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#9aa0a8';
    ctx.fillRect(0, 26, w, h - 26);
    for (let x = 0; x < w; x += 64) ctx.fillRect(x + 8, 6, 32, 24);   // merlons
    ctx.fillStyle = '#7d8287';
    for (let x = 0; x < w; x += 32) ctx.fillRect(x, 44, 2, 20);
    ctx.fillRect(0, 44, w, 2);
}, { repeat: [1, 1] });

let WALL_TEX = null;
// un mur : groupe dont le +z local pointe vers l'intérieur de la pièce, x le long du mur
function roomWall(len, x, z, rotY) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rotY;
    PARENT.add(g);
    const part = (tex, h, y0, rough, rx, ry) => {
        const t = tex.clone(); t.needsUpdate = true;
        t.repeat.set(rx, ry);
        const m = new THREE.Mesh(new THREE.PlaneGeometry(len, h), new THREE.MeshStandardMaterial({ map: t, roughness: rough }));
        m.position.y = y0 + h / 2;
        add(m, { parent: g });
        m.castShadow = false;
        return m;
    };
    WALL_TEX ??= { paper: wallpaperTex(), panel: wainscotTex(), frieze: friezeTex() };
    part(WALL_TEX.paper, RH - WAINSCOT - 4, WAINSCOT + 4, 0.85, len / 22, (RH - WAINSCOT - 4) / 22);
    part(WALL_TEX.panel, WAINSCOT, 0, 0.6, len / 24, 1);
    part(WALL_TEX.frieze, 4, WAINSCOT, 0.7, len / 16, 1);
    // plinthe et cimaise
    const base = new THREE.Mesh(roundedBox(len, 2.2, 0.8, 0.2), plastic('#f4efe4', 0.5));
    base.position.set(0, 1.1, 0.4);
    const rail = new THREE.Mesh(roundedBox(len, 0.9, 0.9, 0.3), plastic('#f4efe4', 0.5));
    rail.position.set(0, WAINSCOT + 4.2, 0.4);
    const cornice = new THREE.Mesh(roundedBox(len, 2, 1.4, 0.4), plastic('#f4efe4', 0.5));
    cornice.position.set(0, RH - 1, 0.7);
    for (const m of [base, rail, cornice]) add(m, { parent: g, collide: false });
    return g;
}
const onWall = (wall, obj, x, y, z = 0.1) => { obj.position.set(x, y, z); return add(obj, { parent: wall, collide: false }); };

// cadre doré avec une image peinte
function framedPicture(tex, w, h, frame = '#c9971a') {
    const g = new THREE.Group();
    const pic = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }));
    pic.position.z = 0.5;
    g.add(pic);
    for (const [fw, fh, fx, fy] of [[w + 3, 1.5, 0, h / 2 + 0.75], [w + 3, 1.5, 0, -h / 2 - 0.75], [1.5, h, w / 2 + 0.75, 0], [1.5, h, -w / 2 - 0.75, 0]]) {
        const f = new THREE.Mesh(roundedBox(fw, fh, 1.2, 0.35), metal(frame));
        f.position.set(fx, fy, 0.6);
        g.add(f);
    }
    return g;
}

// guirlande de fanions entre deux points (dans le plan du mur)
function bunting(wall, x0, x1, y, sag, colors) {
    const n = Math.round((x1 - x0) / 4.5);
    const pts = [];
    for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        pts.push(new THREE.Vector3(x0 + (x1 - x0) * t, y - Math.sin(t * Math.PI) * sag, 1.2));
    }
    const string = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.12, 5), plastic('#f4efe4', 0.6));
    add(string, { parent: wall, collide: false });
    const tri = new THREE.Shape();
    tri.moveTo(-1.6, 0); tri.lineTo(1.6, 0); tri.lineTo(0, -4); tri.lineTo(-1.6, 0);
    const triGeo = new THREE.ShapeGeometry(tri);
    for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const f = new THREE.Mesh(triGeo, new THREE.MeshStandardMaterial({ color: colors[i % colors.length], roughness: 0.8, side: THREE.DoubleSide }));
        f.position.set(x0 + (x1 - x0) * t, y - Math.sin(t * Math.PI) * sag, 1.3);
        f.rotation.z = Math.cos(t * Math.PI) * sag / (x1 - x0) * 2.5;
        add(f, { parent: wall, collide: false });
    }
}

// grosse peluche de dragon (aussi utilisée, en petit, pour le mobile)
function makeDragonPlush({ body = '#3fae49', belly = '#f3d98a', wing = '#2b8a3a', spikes = '#f0a640' } = {}) {
    const g = new THREE.Group();
    const soft = c => plastic(c, 0.85);
    const sph = (r, c, x, y, z, sx = 1, sy = 1, sz = 1) => {
        const m = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), soft(c));
        m.position.set(x, y, z); m.scale.set(sx, sy, sz);
        g.add(m);
        return m;
    };
    sph(1, body, 0, 1.0, 0, 1, 0.92, 1.2);                     // corps
    sph(0.8, belly, 0, 0.95, 0.62, 0.86, 0.9, 0.55);           // ventre
    sph(0.75, body, 0, 2.3, 0.3);                              // tête
    sph(0.5, body, 0, 2.12, 0.86, 1.05, 0.75, 1);              // museau
    for (const s of [-1, 1]) {
        sph(0.06, '#1b3d22', 0.16 * s, 2.2, 1.34);             // naseaux
        sph(0.2, '#ffffff', 0.3 * s, 2.52, 0.84);              // yeux
        sph(0.11, '#111111', 0.31 * s, 2.54, 1.0);
        sph(0.035, '#ffffff', 0.33 * s, 2.6, 1.09);
        const horn = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.55, 12), soft('#f3e3b0'));
        horn.position.set(0.35 * s, 3.0, 0.05); horn.rotation.set(-0.4, 0, -0.35 * s);
        g.add(horn);
        sph(0.22, body, 0.6 * s, 2.55, 0.1, 0.5, 1, 0.8);      // oreilles
        sph(0.3, body, 0.62 * s, 0.32, 0.62, 1, 0.7, 1.3);     // pattes avant
        sph(0.48, body, 0.78 * s, 0.5, -0.3, 0.9, 1, 1.2);     // cuisses
        sph(0.18, body, 0.75 * s, 1.35, 0.7, 0.9, 1.6, 0.9);   // petits bras
        for (const c of [-0.12, 0, 0.12]) {
            const claw = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 8), soft('#ffffff'));
            claw.position.set(0.62 * s + c, 0.18, 1.0); claw.rotation.x = Math.PI / 2;
            g.add(claw);
        }
        // aile en tissu, festonnée
        const sh = new THREE.Shape();
        sh.moveTo(0, 0); sh.lineTo(0.3, 1.5); sh.lineTo(1.7, 1.1);
        sh.quadraticCurveTo(1.3, 0.75, 1.35, 0.45); sh.quadraticCurveTo(0.95, 0.4, 0.9, 0.1); sh.quadraticCurveTo(0.5, 0.15, 0, 0);
        const wg = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: 0.08, bevelEnabled: true, bevelSize: 0.04, bevelThickness: 0.04, bevelSegments: 2 }), soft(wing));
        wg.position.set(0.45 * s, 1.55, -0.55);
        wg.rotation.set(0, s > 0 ? 0.7 : Math.PI - 0.7, 0.35);
        g.add(wg);
    }
    // piques le long du dos et de la queue
    for (let i = 0; i < 6; i++) {
        const a = 0.25 + i * 0.32;
        const sp = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.4, 10), soft(spikes));
        sp.position.set(0, 1.0 + Math.cos(a) * 0.95, -Math.sin(a) * 1.2);
        sp.rotation.x = -a;
        g.add(sp);
    }
    // queue qui s'enroule
    let r = 0.42;
    for (let i = 0; i < 7; i++) {
        const a = i / 6 * 2.6;
        sph(r, body, 0.9 - 0.9 * Math.cos(a), 0.35 + i * 0.04, -1.3 - 0.9 * Math.sin(a));
        r *= 0.86;
    }
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.5, 4), soft(spikes));
    tip.position.set(0.9 - 0.9 * Math.cos(2.95), 0.62, -1.3 - 0.9 * Math.sin(2.95));
    tip.rotation.set(Math.PI / 2, 0, 0);
    g.add(tip);
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return g;
}

// lit-château : quatre tours aux toits pointus, tête de lit crénelée, couette aux dragons
function castleBed(x, z) {
    const g = new THREE.Group();
    const W = 36, L = 72, wood = plastic('#e9e2d0', 0.55), roofMat = plastic('#d42330', 0.45);
    const frame = new THREE.Mesh(roundedBox(W, 8, L, 1), wood);
    frame.position.y = 7;
    const mattress = new THREE.Mesh(roundedBox(W - 3, 6, L - 4, 2), plastic('#f7f4ee', 0.9));
    mattress.position.y = 14;
    const duvetTex = canvasTex(512, 512, (ctx, s) => {
        ctx.fillStyle = '#2d4a7a'; ctx.fillRect(0, 0, s, s);
        for (let i = 0; i < 26; i++) drawStar(ctx, Math.random() * s, Math.random() * s, 6 + Math.random() * 6, '#f6c21a');
        drawDragon(ctx, 200, 300, 1.0, { body: '#3fae49', wing: '#2b8a3a', fire: true });
        ctx.strokeStyle = '#f6c21a'; ctx.lineWidth = 12; ctx.strokeRect(10, 10, s - 20, s - 20);
    });
    const duvet = new THREE.Mesh(roundedBox(W - 1, 3, L * 0.68, 1.2), new THREE.MeshStandardMaterial({ map: duvetTex, roughness: 0.9 }));
    duvet.position.set(0, 17.6, L * 0.15);
    const pillow = new THREE.Mesh(roundedBox(W * 0.62, 3.6, 10, 1.6), plastic('#f3d98a', 0.9));
    pillow.position.set(0, 18.4, -L / 2 + 8);
    pillow.rotation.x = -0.15;
    g.add(frame, mattress, duvet, pillow);
    // tête et pied de lit crénelés
    for (const [zz, h] of [[-L / 2 - 1, 34], [L / 2 + 1, 20]]) {
        const board = new THREE.Mesh(roundedBox(W, h, 2, 0.6), wood);
        board.position.set(0, h / 2, zz);
        g.add(board);
        for (let i = 0; i < 5; i++) {
            const m = new THREE.Mesh(roundedBox(4.2, 3.4, 2, 0.5), wood);
            m.position.set(-W / 2 + 3.6 + i * (W - 7.2) / 4, h + 1.7, zz);
            g.add(m);
        }
        const sh = paintedShield(zz < 0 ? 'lionFlag' : 'skullFlag', 9, 11, '#e8b923');
        sh.position.set(0, zz < 0 ? h * 0.72 : h * 0.58, zz + 1.1);
        g.add(sh);
    }
    // tours d'angle
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const h = sz < 0 ? 40 : 26;
        const tw = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, h, 24), wood);
        tw.position.set(sx * (W / 2), h / 2, sz * (L / 2 + 1));
        const roof = new THREE.Mesh(new THREE.ConeGeometry(4, 8, 24), roofMat);
        roof.position.set(sx * (W / 2), h + 4, sz * (L / 2 + 1));
        const win = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 3), plastic('#1b2340', 0.6));
        win.position.set(sx * (W / 2 + 3.02), h - 6, sz * (L / 2 + 1));
        win.rotation.y = sx * Math.PI / 2;
        g.add(tw, roof, win);
    }
    g.position.set(x, 0, z);
    return g;
}

// coffre à jouets en bois, couvercle bombé décoré d'un écu
function toyChest() {
    const g = new THREE.Group();
    const W = 30, H = 15, D = 16;
    const body = new THREE.Mesh(roundedBox(W, H, D, 1), plastic('#b5773f', 0.6));
    body.position.y = H / 2;
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(D / 2, D / 2, W, 24, 1, false, 0, Math.PI), plastic('#9a5f33', 0.6));
    lid.rotation.z = Math.PI / 2;
    lid.position.y = H;
    g.add(body, lid);
    for (const x of [-W / 2 + 3, W / 2 - 3]) {
        const strap = new THREE.Mesh(roundedBox(1.6, H + 0.2, D + 0.3, 0.4), metal('#3d4046'));
        strap.position.set(x, H / 2, 0);
        const band = new THREE.Mesh(new THREE.TorusGeometry(D / 2 + 0.1, 0.5, 6, 20, Math.PI), metal('#3d4046'));
        band.rotation.y = Math.PI / 2;
        band.position.set(x, H, 0);
        g.add(strap, band);
    }
    const sh = paintedShield('quarter', 7, 8.5, '#e8b923');
    sh.position.set(0, H / 2, D / 2 + 0.3);
    g.add(sh);
    // une épée en bois appuyée contre le coffre
    const sword = new THREE.Group();
    const blade = new THREE.Mesh(roundedBox(1.6, 18, 0.6, 0.3), plastic('#d9b07a', 0.6));
    blade.position.y = 9;
    const guard = new THREE.Mesh(roundedBox(6, 1.2, 1.2, 0.4), plastic('#8a5228', 0.6));
    guard.position.y = 18.5;
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 4, 10), plastic('#d42330', 0.6));
    grip.position.y = 21;
    sword.add(blade, guard, grip);
    sword.position.set(W / 2 + 3, 0, 3);
    sword.rotation.z = 0.2;
    g.add(sword);
    return g;
}

// bibliothèque avec livres, trophée et oeuf de dragon
function bookshelf() {
    const g = new THREE.Group();
    const W = 30, H = 52, D = 10, wood = plastic('#c79a62', 0.6);
    for (const x of [-W / 2, W / 2]) {
        const side = new THREE.Mesh(roundedBox(1.2, H, D, 0.3), wood);
        side.position.set(x, H / 2, 0);
        g.add(side);
    }
    const back = new THREE.Mesh(roundedBox(W, H, 0.6, 0.2), plastic('#a8794a', 0.7));
    back.position.set(0, H / 2, -D / 2 + 0.3);
    g.add(back);
    const colors = ['#d42330', '#1f5fbf', '#3fae49', '#f6c21a', '#7b3fb8', '#f0a640', '#2d4a7a', '#ffffff'];
    const levels = [0.6, 13, 26, 39, H - 0.6];
    levels.forEach((y, li) => {
        const shelf = new THREE.Mesh(roundedBox(W, 1.2, D, 0.3), wood);
        shelf.position.set(0, y, 0);
        g.add(shelf);
        if (li >= 3) return;
        for (let x = -W / 2 + 1.4; x < W / 2 - 3;) {
            const bw = 1.2 + Math.random() * 1.4, bh = 7 + Math.random() * 4;
            const book = new THREE.Mesh(roundedBox(bw, bh, 7, 0.2), plastic(colors[Math.floor(Math.random() * colors.length)], 0.6));
            book.position.set(x + bw / 2, y + 0.6 + bh / 2, 0.5);
            if (Math.random() < 0.12) { book.rotation.z = 0.25; book.position.x += 0.8; x += 1; }
            g.add(book);
            x += bw + 0.15;
            if (Math.random() < 0.08) x += 3;
        }
    });
    // sur l'étagère du haut : oeuf de dragon et coupe de tournoi
    const egg = new THREE.Mesh(new THREE.SphereGeometry(2.6, 20, 14), new THREE.MeshStandardMaterial({ color: '#7b3fb8', roughness: 0.3, emissive: '#3a1460', emissiveIntensity: 0.4 }));
    egg.scale.y = 1.35;
    egg.position.set(-7, 39.6 + 3.4, 0);
    const nest = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.8, 8, 20), plastic('#c49a52', 0.9));
    nest.rotation.x = Math.PI / 2; nest.position.set(-7, 40.6, 0);
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 1.0, 4, 18), metal(COLORS.gold));
    cup.position.set(6, 45, 0);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 2.5, 10), metal(COLORS.gold));
    stem.position.set(6, 41.7, 0);
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 2.0, 0.8, 18), metal(COLORS.gold));
    foot.position.set(6, 40.6, 0);
    g.add(egg, nest, cup, stem, foot);
    // sur le dessus : un heaume de jouet
    const helm = toyHelmet();
    helm.position.y = H;
    g.add(helm);
    return g;
}

// heaume de déguisement (taille enfant)
function toyHelmet() {
    const g = new THREE.Group();
    const steel = metal('#b9c0c8');
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(4, 4.1, 6, 28), steel);
    cyl.position.y = 3;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(4, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2), steel);
    dome.position.y = 6; dome.scale.y = 0.6;
    const slit = new THREE.Mesh(roundedBox(6, 0.6, 0.6, 0.2), plastic('#111'));
    slit.position.set(0, 3.8, 3.85);
    const ridge = new THREE.Mesh(roundedBox(0.9, 6, 0.8, 0.3), steel);
    ridge.position.set(0, 3.2, 3.95);
    const plume = new THREE.Mesh(new THREE.SphereGeometry(1.6, 16, 12), plastic('#d42330', 0.8));
    plume.scale.set(0.6, 1.4, 2.2); plume.position.set(0, 9.2, -0.6);
    g.add(cyl, dome, slit, ridge, plume);
    return g;
}

function buildBedroom() {
    // ------------------------------------------------ murs et plafond
    const back = roomWall(2 * RX, 0, -RZ, 0);
    const front = roomWall(2 * RX, 0, RZ, Math.PI);
    const left = roomWall(2 * RZ, -RX, 0, Math.PI / 2);
    const right = roomWall(2 * RZ, RX, 0, -Math.PI / 2);

    const ceilTex = canvasTex(512, 512, (ctx, s) => {
        ctx.fillStyle = '#eef3f8'; ctx.fillRect(0, 0, s, s);
    });
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(2 * RX, 2 * RZ), new THREE.MeshStandardMaterial({ map: ceilTex, roughness: 0.95 }));
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = RH;
    add(ceiling, { collide: false });
    ceiling.castShadow = false;
    // étoiles phosphorescentes collées au plafond
    const starShape = new THREE.Shape();
    for (let i = 0; i < 10; i++) {
        const a = i * Math.PI / 5, r = i % 2 ? 0.45 : 1;
        starShape[i ? 'lineTo' : 'moveTo'](Math.sin(a) * r, Math.cos(a) * r);
    }
    const starGeo = new THREE.ShapeGeometry(starShape);
    const starMat = new THREE.MeshStandardMaterial({ color: '#fff6b0', emissive: '#f6e27a', emissiveIntensity: 0.6, side: THREE.DoubleSide });
    for (let i = 0; i < 40; i++) {
        const st = new THREE.Mesh(starGeo, starMat);
        st.rotation.set(Math.PI / 2, 0, Math.random() * 6);
        st.scale.setScalar(1.2 + Math.random() * 1.6);
        st.position.set((Math.random() * 2 - 1) * (RX - 8), RH - 0.1, (Math.random() * 2 - 1) * (RZ - 8));
        add(st, { collide: false });
    }
    // plafonnier rond
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(7, 28, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), new THREE.MeshStandardMaterial({
        color: '#fff8e6', emissive: '#ffe9b8', emissiveIntensity: 1.2,
    }));
    lamp.position.set(0, RH - 0.2, 0);
    lamp.scale.y = 0.45;
    add(lamp, { collide: false });

    // ------------------------------------------------ mobile de dragons au-dessus du champ de bataille
    {
        const mobile = new THREE.Group();
        mobile.position.set(0, RH - 16, 0);
        const string = (x, z, len) => {
            const s = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, len, 4), plastic('#f4efe4'));
            s.position.set(x, -len / 2, z);
            mobile.add(s);
        };
        const top = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 16, 4), plastic('#f4efe4'));
        top.position.y = 8;
        mobile.add(top);
        for (const a of [0, Math.PI / 2]) {
            const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 34, 10), plastic('#c79a62', 0.6));
            stick.rotation.set(0, a, Math.PI / 2);
            mobile.add(stick);
        }
        const hang = [
            [17, 0, 10, { body: '#d42330', belly: '#f6c21a', wing: '#a3171d', spikes: '#f6c21a' }],
            [-17, 0, 14, { body: '#3fae49' }],
            [0, 17, 8, { body: '#1f5fbf', belly: '#bcd7ec', wing: '#123f85', spikes: '#f6c21a' }],
            [0, -17, 12, { body: '#7b3fb8', belly: '#f3d98a', wing: '#4b2a8c' }],
        ];
        for (const [x, z, len, colors] of hang) {
            string(x, z, len);
            const d = makeDragonPlush(colors);
            d.scale.setScalar(2.2);
            d.position.set(x, -len - 6.8, z);
            d.rotation.set(0.25, Math.atan2(-z, x), 0);       // ils se suivent en rond
            mobile.add(d);
        }
        for (const [x, z] of [[12, 12], [-12, -12], [12, -12], [-12, 12]]) {
            string(x * 0.7, z * 0.7, 6);
            const st = new THREE.Mesh(new THREE.ExtrudeGeometry(starShape, { depth: 0.4, bevelEnabled: false }), metal(COLORS.gold));
            st.scale.setScalar(2);
            st.position.set(x * 0.7, -8, z * 0.7);
            mobile.add(st);
        }
        add(mobile, { collide: false });
        spinners.push({ obj: mobile, speed: 0.06 });
    }

    // ------------------------------------------------ mur de droite : fenêtre à rideaux et lit-château
    {
        const W = 40, H = 40, Y = 34, Z = 30;           // Z : position le long du mur
        const sky = canvasTex(512, 512, (ctx, s) => {
            const g = ctx.createLinearGradient(0, 0, 0, s);
            g.addColorStop(0, '#6fb2ea'); g.addColorStop(0.7, '#cfe8f7'); g.addColorStop(1, '#e9f4e0');
            ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
            ctx.fillStyle = 'rgba(255,255,255,0.9)';
            for (const [cx, cy, k] of [[120, 120, 1], [360, 80, 0.8], [400, 210, 0.6]]) {
                for (const [dx, dy, r] of [[0, 0, 30], [30, -10, 36], [62, 4, 28], [28, 14, 30]]) {
                    ctx.beginPath(); ctx.arc(cx + dx * k, cy + dy * k, r * k, 0, 7); ctx.fill();
                }
            }
            ctx.fillStyle = '#7fbf6a'; ctx.beginPath(); ctx.moveTo(0, 430); ctx.quadraticCurveTo(160, 360, 320, 420); ctx.quadraticCurveTo(420, 380, 512, 400); ctx.lineTo(512, 512); ctx.lineTo(0, 512); ctx.fill();
            ctx.fillStyle = '#5a9e52'; ctx.beginPath(); ctx.moveTo(0, 470); ctx.quadraticCurveTo(250, 420, 512, 470); ctx.lineTo(512, 512); ctx.lineTo(0, 512); ctx.fill();
            // un vrai château au loin, sur la colline
            ctx.fillStyle = '#8b9096';
            ctx.fillRect(330, 360, 60, 40);
            for (const x of [322, 382]) { ctx.fillRect(x, 340, 16, 60); ctx.beginPath(); ctx.moveTo(x - 3, 340); ctx.lineTo(x + 8, 322); ctx.lineTo(x + 19, 340); ctx.fill(); }
        });
        const glass = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: sky }));
        onWall(right, glass, Z, Y + H / 2, 0.05);
        const white = plastic('#f4efe4', 0.5);
        for (const [w, h, x, y] of [[W + 3, 1.6, 0, H / 2 + 0.8], [W + 3, 1.6, 0, -H / 2 - 0.8], [1.6, H, W / 2 + 0.8, 0], [1.6, H, -W / 2 - 0.8, 0],
            [1, H, 0, 0], [W, 1, 0, 0]]) {
            onWall(right, new THREE.Mesh(roundedBox(w, h, 1.2, 0.3), white), Z + x, Y + H / 2 + y, 0.6);
        }
        onWall(right, new THREE.Mesh(roundedBox(W + 8, 1.4, 4, 0.5), white), Z, Y - 1.4, 2);    // rebord
        // tringle à embouts en fer de lance
        const rodY = Y + H + 5;
        const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, W + 26, 10), metal('#3d4046'));
        rod.rotation.z = Math.PI / 2;
        onWall(right, rod, Z, rodY, 3);
        for (const s of [-1, 1]) {
            const tip = new THREE.Mesh(new THREE.ConeGeometry(1, 3, 4), metal(COLORS.gold));
            tip.rotation.z = -s * Math.PI / 2;
            onWall(right, tip, Z + s * (W / 2 + 14.5), rodY, 3);
        }
        // rideaux ondulés rouge et bleu, à motif de fleurs de lys simplifiées
        for (const s of [-1, 1]) {
            const ct = canvasTex(128, 128, (ctx, w) => {
                ctx.fillStyle = s < 0 ? '#c41e2a' : '#1f5fbf'; ctx.fillRect(0, 0, w, w);
                drawStar(ctx, 32, 32, 9, '#f6c21a'); drawStar(ctx, 96, 96, 9, '#f6c21a');
            }, { repeat: [3, 8] });
            const geo = new THREE.PlaneGeometry(14, H + 18, 24, 30);
            const p = geo.attributes.position;
            for (let i = 0; i < p.count; i++) {
                const yy = (p.getY(i) + (H + 18) / 2) / (H + 18);           // 0 en bas, 1 en haut
                const pinch = 1 - 0.45 * Math.exp(-((yy - 0.38) ** 2) / 0.01);  // embrasse
                p.setX(i, p.getX(i) * pinch);
                p.setZ(i, Math.sin(p.getX(i) * 1.3) * 0.9);
            }
            geo.computeVertexNormals();
            const curtain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: ct, roughness: 0.85, side: THREE.DoubleSide }));
            onWall(right, curtain, Z + s * (W / 2 + 6), rodY - (H + 18) / 2, 2.5);
            const tie = new THREE.Mesh(new THREE.TorusGeometry(4.2, 0.5, 8, 20), metal(COLORS.gold));
            tie.rotation.x = Math.PI / 2;
            onWall(right, tie, Z + s * (W / 2 + 6), rodY - (H + 18) * 0.62, 2.5);
        }
    }
    add(castleBed(RX - 22, -RZ + 41));
    // table de chevet avec une lampe oeuf de dragon
    {
        const g = new THREE.Group();
        const box = new THREE.Mesh(roundedBox(12, 20, 12, 1), plastic('#e9e2d0', 0.55));
        box.position.y = 10;
        const knob = new THREE.Mesh(new THREE.SphereGeometry(0.8, 10, 8), metal(COLORS.gold));
        knob.position.set(0, 13, 6.1);
        const drawerLine = new THREE.Mesh(roundedBox(10, 0.3, 0.3, 0.1), plastic('#c9bfa8'));
        drawerLine.position.set(0, 15.5, 6.05);
        const eggLamp = new THREE.Mesh(new THREE.SphereGeometry(3, 20, 14), new THREE.MeshStandardMaterial({
            color: '#ffcf70', emissive: '#ff9a2a', emissiveIntensity: 0.9, roughness: 0.4,
        }));
        eggLamp.scale.y = 1.35;
        eggLamp.position.y = 24.5;
        const stand = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3, 1.5, 18), metal(COLORS.gold));
        stand.position.y = 20.75;
        g.add(box, knob, drawerLine, eggLamp, stand);
        g.position.set(29, 0, -RZ + 8);
        add(g);
    }

    // ------------------------------------------------ mur du fond (derrière le Crâne) : grande affiche du dragon + fanions
    {
        const poster = canvasTex(1024, 640, (ctx, w, h) => {
            const g = ctx.createLinearGradient(0, 0, 0, h);
            g.addColorStop(0, '#2a1f4a'); g.addColorStop(1, '#d1603a');
            ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
            for (let i = 0; i < 40; i++) drawStar(ctx, Math.random() * w, Math.random() * h * 0.5, 3 + Math.random() * 4, '#fff3c0');
            ctx.fillStyle = '#f7e7b0'; ctx.beginPath(); ctx.arc(820, 130, 60, 0, 7); ctx.fill();
            // montagne et château sombre
            ctx.fillStyle = '#1d1630';
            ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(0, 520); ctx.lineTo(260, 380); ctx.lineTo(480, 520); ctx.lineTo(700, 430); ctx.lineTo(w, 540); ctx.lineTo(w, h); ctx.fill();
            ctx.fillRect(140, 300, 90, 120);
            for (const x of [125, 215]) { ctx.fillRect(x, 270, 30, 150); }
            drawDragon(ctx, 560, 300, 1.9, { body: '#c41e2a', wing: '#7a1018', belly: '#f6c21a', fire: true });
            ctx.fillStyle = '#f6c21a'; ctx.font = 'bold 72px Georgia, serif'; ctx.textAlign = 'center';
            ctx.fillText('LE DRAGON DU CRÂNE', w / 2, h - 40);
        });
        onWall(back, framedPicture(poster, 52, 32.5), -10, 58);
        bunting(back, -RX + 4, -38, RH - 6, 7, ['#d42330', '#f6c21a', '#1f5fbf', '#ffffff']);
        bunting(back, 18, RX - 4, RH - 6, 7, ['#1f5fbf', '#f6c21a', '#d42330', '#3fae49']);
    }

    // ------------------------------------------------ mur avant (derrière le Lion) : porte, affiche du chevalier, épée et bouclier
    {
        const DW = 32, DH = 74, DX = -42;
        const doorTex = canvasTex(256, 512, (ctx, w, h) => {
            ctx.fillStyle = '#f4efe4'; ctx.fillRect(0, 0, w, h);
            ctx.strokeStyle = '#d8d0bc'; ctx.lineWidth = 8;
            for (const [x, y, ww, hh] of [[30, 30, 196, 190], [30, 260, 196, 222]]) ctx.strokeRect(x, y, ww, hh);
        });
        const door = new THREE.Mesh(roundedBox(DW, DH, 1.6, 0.4), new THREE.MeshStandardMaterial({ map: doorTex, roughness: 0.55 }));
        onWall(front, door, DX, DH / 2, 0.8);
        for (const [w, h, x, y] of [[DW + 6, 3, 0, DH + 1.5], [3, DH, DW / 2 + 1.5, DH / 2], [3, DH, -DW / 2 - 1.5, DH / 2]]) {
            onWall(front, new THREE.Mesh(roundedBox(w, h, 2.2, 0.5), plastic('#f4efe4', 0.5)), DX + x, y, 1.1);
        }
        const knob = new THREE.Mesh(new THREE.SphereGeometry(1.3, 14, 10), metal(COLORS.gold));
        onWall(front, knob, DX + DW / 2 - 4, 33, 2.4);
        // pancarte accrochée à la porte
        const sign = canvasTex(512, 256, (ctx, w, h) => {
            ctx.fillStyle = '#c79a62'; ctx.fillRect(0, 0, w, h);
            ctx.strokeStyle = '#7a4a22'; ctx.lineWidth = 14; ctx.strokeRect(8, 8, w - 16, h - 16);
            ctx.fillStyle = '#5b2a10'; ctx.font = 'bold 58px Georgia, serif'; ctx.textAlign = 'center';
            ctx.fillText('ATTENTION', w / 2, 100);
            ctx.font = 'bold 44px Georgia, serif';
            ctx.fillText('DRAGONS !', w / 2, 170);
            drawStar(ctx, 60, 60, 18, '#d42330'); drawStar(ctx, w - 60, 60, 18, '#d42330');
        });
        const board = new THREE.Mesh(roundedBox(18, 9, 0.8, 0.3), [plastic('#a8794a'), plastic('#a8794a'), plastic('#a8794a'), plastic('#a8794a'),
            new THREE.MeshStandardMaterial({ map: sign, roughness: 0.7 }), plastic('#a8794a')]);
        onWall(front, board, DX, 52, 2.2);

        // affiche du chevalier au lion
        const poster = canvasTex(640, 900, (ctx, w, h) => {
            ctx.fillStyle = '#f1e4c4'; ctx.fillRect(0, 0, w, h);
            ctx.strokeStyle = '#1f5fbf'; ctx.lineWidth = 24; ctx.strokeRect(20, 20, w - 40, h - 40);
            ctx.save(); ctx.translate(w / 2 - 190, 170); ctx.scale(1.5, 1.5);
            ctx.fillStyle = '#1d4fb8';
            ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(256, 0); ctx.lineTo(256, 180); ctx.quadraticCurveTo(250, 280, 128, 330); ctx.quadraticCurveTo(6, 280, 0, 180); ctx.fill();
            drawLion(ctx, '#f5c518');
            ctx.restore();
            ctx.fillStyle = '#1d4fb8'; ctx.font = 'bold 70px Georgia, serif'; ctx.textAlign = 'center';
            ctx.fillText('CHEVALIERS', w / 2, 120);
            ctx.fillStyle = '#c41e2a'; ctx.font = 'bold 54px Georgia, serif';
            ctx.fillText('DU LION', w / 2, h - 70);
        });
        onWall(front, framedPicture(poster, 26, 36.5), 10, 56);
        // épée en bois et bouclier rond accrochés au mur
        const shield = new THREE.Group();
        const disc = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 1, 32), plastic('#1f5fbf', 0.5));
        disc.rotation.x = Math.PI / 2;
        const rim = new THREE.Mesh(new THREE.TorusGeometry(7, 0.6, 8, 32), plastic(COLORS.gold, 0.4));
        const boss = new THREE.Mesh(new THREE.SphereGeometry(1.8, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), metal(COLORS.gold));
        boss.rotation.x = Math.PI / 2;
        shield.add(disc, rim, boss);
        onWall(front, shield, 46, 48, 1.2);
        const sword = new THREE.Group();
        const blade = new THREE.Mesh(roundedBox(2, 26, 0.7, 0.3), plastic('#d9b07a', 0.6));
        const guard = new THREE.Mesh(roundedBox(8, 1.4, 1.2, 0.4), plastic('#8a5228', 0.6));
        guard.position.y = -12;
        const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 5, 10), plastic('#d42330', 0.6));
        grip.position.y = -15.2;
        sword.add(blade, guard, grip);
        sword.rotation.z = 0.6;
        onWall(front, sword, 46, 48, 2.2);
        for (const x of [40, 52]) onWall(front, new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 2.5, 8).rotateX(Math.PI / 2), metal(COLORS.gold)), x, 40, 1.2);
    }

    // ------------------------------------------------ mur de gauche : fresque, bibliothèque, coffre à jouets, peluche
    {
        const mural = canvasTex(1024, 512, (ctx, w, h) => {
            const g = ctx.createLinearGradient(0, 0, 0, h);
            g.addColorStop(0, '#8cc8f0'); g.addColorStop(1, '#e8f4fb');
            ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
            ctx.fillStyle = '#ffe27a'; ctx.beginPath(); ctx.arc(110, 100, 55, 0, 7); ctx.fill();
            ctx.fillStyle = '#8fcf7a'; ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(0, 400); ctx.quadraticCurveTo(300, 290, 620, 390); ctx.quadraticCurveTo(820, 330, w, 380); ctx.lineTo(w, h); ctx.fill();
            // château blanc à toits rouges sur la colline
            ctx.fillStyle = '#eef0f2'; ctx.fillRect(250, 250, 170, 110);
            for (const x of [228, 402]) { ctx.fillRect(x, 200, 44, 160); }
            ctx.fillStyle = '#d42330';
            for (const x of [228, 402]) { ctx.beginPath(); ctx.moveTo(x - 6, 200); ctx.lineTo(x + 22, 140); ctx.lineTo(x + 50, 200); ctx.fill(); }
            ctx.fillStyle = '#5b3a1e'; ctx.beginPath(); ctx.moveTo(310, 360); ctx.lineTo(310, 320); ctx.arc(335, 320, 25, Math.PI, 0); ctx.lineTo(360, 360); ctx.fill();
            ctx.fillStyle = '#eef0f2'; for (let x = 250; x < 420; x += 28) ctx.fillRect(x, 236, 16, 16);
            // petit chevalier sur la colline face au dragon
            ctx.fillStyle = '#9aa0a8'; ctx.fillRect(560, 330, 22, 40); ctx.beginPath(); ctx.arc(571, 322, 12, 0, 7); ctx.fill();
            ctx.fillStyle = '#1f5fbf'; ctx.fillRect(552, 336, 14, 22);
            ctx.strokeStyle = '#555'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(585, 345); ctx.lineTo(630, 290); ctx.stroke();
            drawDragon(ctx, 800, 210, 1.1, { body: '#3fae49', wing: '#2b8a3a', fire: false });
            ctx.fillStyle = '#fff'; for (const [cx, cy] of [[520, 90], [660, 60]]) for (const [dx, r] of [[0, 22], [26, 28], [52, 20]]) { ctx.beginPath(); ctx.arc(cx + dx, cy, r, 0, 7); ctx.fill(); }
        });
        const m = new THREE.Mesh(new THREE.PlaneGeometry(80, 40), new THREE.MeshStandardMaterial({ map: mural, roughness: 0.9 }));
        onWall(left, m, 5, WAINSCOT + 28, 0.08);
        // nom du petit chevalier en lettres de bois sous la fresque
        'MESSIRE'.split('').forEach((ch, i) => {
            const t = letterTexture(ch, ['#d42330', '#1f5fbf', '#f6c21a', '#3fae49'][i % 4], '#ffffff');
            const L = new THREE.Mesh(roundedBox(4.6, 4.6, 0.8, 0.5), [plastic('#ffffff'), plastic('#ffffff'), plastic('#ffffff'), plastic('#ffffff'),
                new THREE.MeshStandardMaterial({ map: t, roughness: 0.5 }), plastic('#ffffff')]);
            L.rotation.z = (Math.random() - 0.5) * 0.25;
            onWall(left, L, 5 + (i - 3) * 6, WAINSCOT + 54, 0.5);
        });
    }
    {
        const shelf = bookshelf();
        shelf.position.set(-RX + 5.5, 0, 60);
        shelf.rotation.y = Math.PI / 2;
        add(shelf);
        const chest = toyChest();
        chest.position.set(-RX + 9, 0, -30);
        chest.rotation.y = Math.PI / 2;
        add(chest);
        const plush = makeDragonPlush();
        plush.scale.setScalar(8.5);
        plush.position.set(-RX + 22, 0, RZ - 16);
        plush.rotation.y = Math.PI * 0.78;
        add(plush);
    }

    // ------------------------------------------------ jouets éparpillés sur le parquet
    // dessin d'enfant et crayons
    {
        const drawing = canvasTex(512, 360, (ctx, w, h) => {
            ctx.fillStyle = '#fffdf6'; ctx.fillRect(0, 0, w, h);
            ctx.lineWidth = 6; ctx.strokeStyle = '#3fae49'; ctx.fillStyle = 'rgba(63,174,73,0.6)';
            ctx.beginPath(); ctx.ellipse(220, 210, 90, 50, 0, 0, 7); ctx.fill(); ctx.stroke();
            ctx.beginPath(); ctx.arc(330, 140, 40, 0, 7); ctx.fill(); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(130, 210); ctx.lineTo(50, 260); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(200, 160); ctx.lineTo(160, 60); ctx.lineTo(260, 150); ctx.stroke();
            ctx.strokeStyle = '#f0a640'; ctx.lineWidth = 10;
            ctx.beginPath(); ctx.moveTo(370, 140); ctx.lineTo(470, 110); ctx.moveTo(370, 150); ctx.lineTo(480, 160); ctx.stroke();
            ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(340, 128, 6, 0, 7); ctx.fill();
            ctx.fillStyle = '#d42330'; ctx.font = 'bold 34px Comic Sans MS, cursive'; ctx.fillText('MON DRAGON', 40, 340);
        });
        const paper = new THREE.Mesh(new THREE.PlaneGeometry(14, 10), new THREE.MeshStandardMaterial({ map: drawing, roughness: 0.9 }));
        paper.rotation.set(-Math.PI / 2, 0, 0.3);
        paper.position.set(-46, 0.06, -8);
        add(paper, { collide: false });
        ['#d42330', '#1f5fbf', '#3fae49', '#f6c21a', '#7b3fb8'].forEach((c, i) => {
            const cr = new THREE.Group();
            const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 5, 6), plastic(c, 0.5));
            const tipC = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.9, 6), plastic(c, 0.5));
            tipC.position.y = 2.95;
            cr.add(stick, tipC);
            cr.rotation.set(Math.PI / 2, 0, 0.6 + i * 0.5);
            cr.position.set(-38 + i * 1.3, 0.36, -3 + Math.sin(i) * 2);
            add(cr, { collide: false });
        });
    }
    // pile de livres et heaume de déguisement près du lit
    {
        let y = 0;
        ['#1f5fbf', '#d42330', '#3fae49'].forEach((c, i) => {
            const b = new THREE.Mesh(roundedBox(10, 1.6, 7, 0.3), plastic(c, 0.6));
            b.position.set(48, y + 0.8, -10);
            b.rotation.y = i * 0.3;
            add(b);
            y += 1.6;
        });
        const helm = toyHelmet();
        helm.position.set(46, 0, 8);
        helm.rotation.set(0, -0.8, 0.12);
        add(helm);
    }
}

// =====================================================================
//  FIGURINES (style jouet, sur leur petit socle rond)
// =====================================================================

// les deux camps de la planche de personnages
export const FACTIONS = {
    blue: {   // Château du Lion : bleu, jaune, bois clair
        emblem: 'blueGold', border: '#e8b923', stand: '#b08a4a',
        wood: '#8a5a2b', woodDark: '#6b4423', hub: '#e8b923',
        armor: '#c9cfd6', armorMetal: true, tunic: '#1f5fbf', legs: '#5b5b66',
    },
    red: {    // Château du Crâne : rouge, noir, bois sombre
        emblem: 'skull', border: '#1f1f24', stand: '#8c6a3a',
        wood: '#5a3a22', woodDark: '#3e2716', hub: '#c41e2a',
        armor: '#34343c', armorMetal: true, tunic: '#b81d26', legs: '#26262c',
    },
};

const geoCache = {};
const geo = (key, make) => (geoCache[key] ??= make());

export function makeFigure(o) {
    const {
        tunic = '#1f5fbf', skin = '#f6c79f', legs = '#4a4a55', boots = '#5b3a1e',
        arms = null, armsMetal = false, legsMetal = false,
        helm = null, helmColor = '#c3cad2', helmMetal = true, plume = null, hood = null,
        crown = false, hair = null, beard = null, cape = null, ermine = false, pauldrons = null,
        emblem = null, emblemBorder = '#2a2a33', shield = null, shieldSize = 1, weapon = 'sword', stand = null,
    } = o;
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const mk = (g, color, isMetal = false) => {
        const m = new THREE.Mesh(g, isMetal ? metal(color) : plastic(color, 0.32));
        m.castShadow = true; m.receiveShadow = true;
        return m;
    };

    // petit socle rond des figurines
    if (stand) {
        const s = mk(geo('stand', () => new THREE.CylinderGeometry(0.3, 0.32, 0.08, 28)), stand);
        s.position.y = 0.04;
        root.add(s);
        body.position.y = 0.08;
    }

    // jambes
    const hips = [];
    for (const s of [-1, 1]) {
        const hip = new THREE.Group();
        hip.position.set(0.1 * s, 0.42, 0);
        const leg = mk(geo('leg', () => new THREE.CapsuleGeometry(0.085, 0.2, 4, 12)), legs, legsMetal);
        leg.position.y = -0.19;
        const foot = mk(geo('foot', () => roundedBox(0.17, 0.12, 0.25, 0.04)), boots);
        foot.position.set(0, -0.36, 0.04);
        hip.add(leg, foot);
        body.add(hip);
        hips.push(hip);
    }

    const upper = new THREE.Group();
    body.add(upper);
    const torso = mk(geo('torso', () => new THREE.CapsuleGeometry(0.21, 0.24, 6, 16)), tunic);
    torso.position.y = 0.7; torso.scale.z = 0.82;
    const belt = mk(geo('belt', () => new THREE.TorusGeometry(0.2, 0.035, 8, 24)), '#5b3a1e');
    belt.rotation.x = Math.PI / 2; belt.position.y = 0.55; belt.scale.y = 0.85;
    const buckle = mk(geo('buckle', () => roundedBox(0.08, 0.07, 0.03, 0.01)), COLORS.gold, true);
    buckle.position.set(0, 0.55, 0.18);
    upper.add(torso, belt, buckle);
    if (emblem) {
        const e = paintedShield(emblem, 0.22, 0.27, emblemBorder);
        e.position.set(0, 0.8, 0.15);
        upper.add(e);
    }

    // tête
    const head = mk(geo('head', () => new THREE.SphereGeometry(0.2, 28, 18)), skin);
    head.position.y = 1.2;
    upper.add(head);
    for (const s of [-1, 1]) {
        const eye = mk(geo('eye', () => new THREE.SphereGeometry(0.026, 10, 8)), '#111');
        eye.position.set(0.07 * s, 1.21, 0.182);
        const brow = mk(geo('brow', () => roundedBox(0.08, 0.02, 0.02, 0.008)), beard || '#5b3a1e');
        brow.position.set(0.07 * s, 1.26, 0.185); brow.rotation.z = -0.25 * s;
        upper.add(eye, brow);
    }
    const mouth = mk(geo('mouth', () => roundedBox(0.07, 0.015, 0.02, 0.006)), '#7a2a1a');
    mouth.position.set(0, 1.12, 0.19);
    upper.add(mouth);
    if (hair) {
        const h = mk(geo('hair', () => new THREE.SphereGeometry(0.212, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.62)), hair);
        h.position.set(0, 1.21, -0.02); h.rotation.x = -0.45;
        upper.add(h);
    }
    if (beard) {
        const b = mk(geo('beard', () => new THREE.SphereGeometry(0.15, 16, 12)), beard);
        b.position.set(0, 1.06, 0.1); b.scale.set(1.05, 0.85, 0.7);
        const mus = mk(geo('mustache', () => roundedBox(0.16, 0.035, 0.04, 0.015)), beard);
        mus.position.set(0, 1.145, 0.19);
        upper.add(b, mus);
    }

    // couvre-chefs
    if (hood) {
        const h = mk(geo('hood', () => new THREE.SphereGeometry(0.228, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.62)), hood);
        h.position.y = 1.2; h.rotation.x = -0.35;
        const tip = mk(geo('hoodTip', () => new THREE.ConeGeometry(0.1, 0.3, 12)), hood);
        tip.position.set(0, 1.3, -0.24); tip.rotation.x = -2.2;
        const cowl = mk(geo('cowl', () => new THREE.TorusGeometry(0.2, 0.06, 8, 20)), hood);
        cowl.rotation.x = Math.PI / 2; cowl.position.y = 1.0;
        upper.add(h, tip, cowl);
    } else if (helm === 'great') {
        // heaume fermé : seule une fente pour les yeux
        const cyl = mk(geo('greatCyl', () => new THREE.CylinderGeometry(0.22, 0.225, 0.34, 24)), helmColor, helmMetal);
        cyl.position.y = 1.2;
        const dome = mk(geo('greatDome', () => new THREE.SphereGeometry(0.22, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2)), helmColor, helmMetal);
        dome.position.y = 1.37; dome.scale.y = 0.55;
        const slit = mk(geo('slit', () => roundedBox(0.32, 0.04, 0.03, 0.01)), '#111');
        slit.position.set(0, 1.23, 0.215);
        const ridge = mk(geo('ridge', () => roundedBox(0.05, 0.36, 0.04, 0.015)), helmColor, helmMetal);
        ridge.position.set(0, 1.21, 0.22);
        upper.add(cyl, dome, slit, ridge);
        for (let i = 0; i < 3; i++) {
            const hole = mk(geo('hole', () => new THREE.SphereGeometry(0.014, 6, 4)), '#111');
            hole.position.set(0.09, 1.13 - i * 0.035, 0.215);
            upper.add(hole);
        }
    } else if (helm === 'nasal' || helm === 'horned') {
        const hel = mk(geo('helDome', () => new THREE.SphereGeometry(0.215, 28, 12, 0, Math.PI * 2, 0, Math.PI * 0.5)), helmColor, helmMetal);
        hel.position.y = 1.24;
        const rim = mk(geo('helRim', () => new THREE.TorusGeometry(0.215, 0.028, 8, 28)), helmColor, helmMetal);
        rim.rotation.x = Math.PI / 2; rim.position.y = 1.24;
        const nose = mk(geo('nose', () => roundedBox(0.04, 0.14, 0.035, 0.015)), helmColor, helmMetal);
        nose.position.set(0, 1.2, 0.205);
        upper.add(hel, rim, nose);
        if (helm === 'horned') {
            for (const s of [-1, 1]) {
                const horn = mk(geo('horn', () => new THREE.ConeGeometry(0.075, 0.36, 12)), '#e8d9b0');
                horn.position.set(0.3 * s, 1.44, 0.02); horn.rotation.z = -1.0 * s;
                const tip = mk(geo('hornTip', () => new THREE.ConeGeometry(0.045, 0.22, 10)), '#e8d9b0');
                tip.position.set(0.43 * s, 1.6, 0.02); tip.rotation.z = -0.15 * s;
                upper.add(horn, tip);
            }
            const gem = mk(geo('gem', () => new THREE.SphereGeometry(0.035, 10, 8)), '#c41e2a');
            gem.position.set(0, 1.33, 0.2);
            upper.add(gem);
        }
    }
    if (plume) {
        const p = mk(geo('plume', () => new THREE.SphereGeometry(0.09, 16, 12)), plume);
        p.scale.set(0.6, 1.5, 2.0);
        p.position.set(0, helm === 'great' ? 1.52 : 1.46, -0.04);
        upper.add(p);
    }
    if (crown) {
        const c = new THREE.Mesh(geo('crown', () => new THREE.CylinderGeometry(0.17, 0.16, 0.12, 24, 1, true)), new THREE.MeshStandardMaterial({
            color: COLORS.gold, metalness: 0.75, roughness: 0.25, side: THREE.DoubleSide,
        }));
        c.position.y = 1.39;
        upper.add(c);
        for (let i = 0; i < 6; i++) {
            const a = i / 6 * Math.PI * 2;
            const spike = mk(geo('crownSpike', () => new THREE.ConeGeometry(0.04, 0.12, 8)), COLORS.gold, true);
            spike.position.set(Math.sin(a) * 0.165, 1.5, Math.cos(a) * 0.165);
            const pearl = mk(geo('pearl', () => new THREE.SphereGeometry(0.022, 8, 6)), '#fff6e0');
            pearl.position.set(Math.sin(a) * 0.165, 1.57, Math.cos(a) * 0.165);
            upper.add(spike, pearl);
        }
        const jewel = mk(geo('jewel', () => new THREE.SphereGeometry(0.035, 10, 8)), '#c41e2a');
        jewel.position.set(0, 1.39, 0.17);
        upper.add(jewel);
    }

    // cape (avec col d'hermine pour le roi)
    if (cape) {
        const cp = mk(geo('cape', () => roundedBox(0.58, 0.9, 0.05, 0.02)), cape);
        cp.position.set(0, 0.62, -0.21); cp.rotation.x = 0.12;
        upper.add(cp);
        if (ermine) {
            const col = mk(geo('ermine', () => new THREE.TorusGeometry(0.2, 0.07, 10, 24)), '#f7f4ee');
            col.rotation.x = Math.PI / 2; col.position.y = 0.99;
            upper.add(col);
            for (let i = 0; i < 9; i++) {
                const a = i / 9 * Math.PI * 2;
                const dot = mk(geo('ermineDot', () => new THREE.SphereGeometry(0.018, 6, 4)), '#111');
                dot.position.set(Math.sin(a) * 0.22, 1.02, Math.cos(a) * 0.22);
                upper.add(dot);
            }
        }
    }
    if (pauldrons) {
        for (const s of [-1, 1]) {
            const p = mk(geo('pauldron', () => new THREE.SphereGeometry(0.13, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.6)), pauldrons, true);
            p.position.set(0.27 * s, 0.93, 0);
            const spike = mk(geo('spike', () => new THREE.ConeGeometry(0.035, 0.12, 8)), '#9aa0a8', true);
            spike.position.set(0.3 * s, 1.06, 0); spike.rotation.z = -0.4 * s;
            upper.add(p, spike);
        }
    }

    // bras et armes
    const armList = [];
    for (const s of [-1, 1]) {
        const shoulder = new THREE.Group();
        shoulder.position.set(0.26 * s, 0.92, 0);
        shoulder.rotation.z = 0.15 * s;
        const arm = mk(geo('arm', () => new THREE.CapsuleGeometry(0.065, 0.2, 4, 10)), arms || tunic, armsMetal);
        arm.position.y = -0.15;
        const hand = mk(geo('hand', () => new THREE.SphereGeometry(0.07, 14, 10)), armsMetal ? (arms || tunic) : skin, armsMetal);
        hand.position.y = -0.31;
        shoulder.add(arm, hand);

        if (s === -1 && shield) {
            const sh = paintedShield(shield.kind, 0.36 * shieldSize, 0.44 * shieldSize, shield.border);
            sh.position.set(-0.1, -0.2, 0.02);
            sh.rotation.y = -Math.PI / 2;
            shoulder.add(sh);
        }
        if (s === -1 && weapon === 'bow') {
            // l'arc reste vertical quand l'archer tend le bras pour tirer
            const holder = new THREE.Group();
            holder.position.y = -0.31;
            holder.rotation.x = 1.5;
            const turn = new THREE.Group();
            turn.rotation.y = -Math.PI / 2;
            const arc = mk(geo('bow', () => new THREE.TorusGeometry(0.32, 0.022, 6, 20, Math.PI)), '#7a4a22');
            arc.rotation.z = -Math.PI / 2;
            turn.add(arc);
            const string = mk(geo('string', () => new THREE.CylinderGeometry(0.006, 0.006, 0.64, 4)), '#eeeeee');
            holder.add(turn, string);
            shoulder.add(holder);
        }
        if (s === 1 && weapon) {
            const w = new THREE.Group();
            w.position.y = -0.31;
            if (weapon === 'sword') {
                w.rotation.x = 0.9;
                const blade = mk(geo('blade', () => roundedBox(0.05, 0.5, 0.02, 0.008)), '#dfe4ea', true); blade.position.y = 0.33;
                const guard = mk(geo('guard', () => roundedBox(0.2, 0.04, 0.05, 0.015)), COLORS.gold, true); guard.position.y = 0.07;
                const grip = mk(geo('grip', () => new THREE.CylinderGeometry(0.025, 0.025, 0.12, 8)), '#5b3a1e');
                w.add(blade, guard, grip);
            } else if (weapon === 'spear') {
                w.rotation.x = 0.15;
                const shaft = mk(geo('shaft', () => new THREE.CylinderGeometry(0.025, 0.025, 1.9, 8)), '#8a5a2b');
                shaft.position.y = 0.55;
                const tip = mk(geo('spearTip', () => new THREE.ConeGeometry(0.05, 0.22, 8)), '#dfe4ea', true);
                tip.position.y = 1.6;
                w.add(shaft, tip);
            } else if (weapon === 'scepter') {
                w.rotation.set(0.35, 0, -0.45);
                const rod = mk(geo('rod', () => new THREE.CylinderGeometry(0.03, 0.03, 0.7, 10)), COLORS.gold, true);
                rod.position.y = 0.25;
                const orb = mk(geo('orb', () => new THREE.SphereGeometry(0.08, 14, 10)), COLORS.gold, true);
                orb.position.y = 0.63;
                const ring = mk(geo('ring', () => new THREE.TorusGeometry(0.05, 0.015, 6, 14)), COLORS.gold, true);
                ring.rotation.x = Math.PI / 2; ring.position.y = 0.55;
                w.add(rod, orb, ring);
            } else if (weapon === 'mace') {
                w.rotation.set(0.3, 0, -0.7);
                const shaft = mk(geo('maceShaft', () => new THREE.CylinderGeometry(0.03, 0.03, 0.75, 8)), '#3a2a1a');
                shaft.position.y = 0.28;
                const ball = mk(geo('maceBall', () => new THREE.SphereGeometry(0.12, 14, 10)), '#2a2a30', true);
                ball.position.y = 0.7;
                w.add(shaft, ball);
                for (let i = 0; i < 8; i++) {
                    const sp = mk(geo('maceSpike', () => new THREE.ConeGeometry(0.03, 0.1, 6)), '#2a2a30', true);
                    const a = i / 8 * Math.PI * 2, e = i % 2 ? 0.5 : -0.5;
                    const dir = new THREE.Vector3(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e));
                    sp.position.copy(dir).multiplyScalar(0.13).add(ball.position);
                    sp.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
                    w.add(sp);
                }
            }
            shoulder.add(w);
        }
        upper.add(shoulder);
        armList.push(shoulder);
    }
    if (weapon === 'bow') {
        const quiver = mk(geo('quiver', () => new THREE.CylinderGeometry(0.07, 0.06, 0.4, 10)), '#7a4a22');
        quiver.position.set(0.1, 0.85, -0.2); quiver.rotation.z = -0.4;
        upper.add(quiver);
    }

    root.traverse(m => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
    return { root, body, upper, hips, arms: armList, phase: Math.random() * 6, swing: 0, kind: 'figure' };
}

export function animateFigure(f, amount, dt = 0) {
    const s = Math.sin(f.phase) * amount;
    f.hips[0].rotation.x = s * 0.7;
    f.hips[1].rotation.x = -s * 0.7;
    f.arms[0].rotation.x = -s * 0.6;
    f.arms[1].rotation.x = s * 0.6;
    f.upper.position.y = Math.abs(Math.cos(f.phase)) * 0.04 * amount;
    f.body.rotation.z = Math.sin(f.phase) * 0.06 * amount;
    // coup d'arme : le bras droit monte puis frappe
    if (f.swing > 0) {
        f.swing = Math.max(0, f.swing - dt);
        const k = 1 - f.swing / 0.35;
        f.arms[1].rotation.x = k < 0.35 ? -2.6 * (k / 0.35) : -2.6 + 3.4 * ((k - 0.35) / 0.65);
    }
}

// --- les troupes de chaque camp (d'après la planche de personnages)
function makeSoldier(type, team) {
    const F = FACTIONS[team];
    const lion = team === 'blue';
    const stand = F.stand;
    const shield = { kind: F.emblem, border: F.border };
    if (type === 'archer') {
        return makeFigure(lion
            ? { tunic: '#2f8a3a', hood: '#3fa04a', legs: '#6b4a2b', arms: '#2f8a3a', weapon: 'bow', stand }
            : { tunic: '#2f2f36', hood: '#25252b', legs: '#3a2a1a', arms: '#2f2f36', weapon: 'bow', stand, beard: '#3a2a1a' });
    }
    if (type === 'knight') {
        return makeFigure({
            tunic: F.tunic === '#b81d26' ? '#2a2a30' : F.tunic, emblem: F.emblem, emblemBorder: F.border,
            arms: F.armor, armsMetal: true, legs: F.armor, legsMetal: true, boots: F.armor,
            helm: 'great', helmColor: F.armor, plume: Math.random() < 0.5 ? (lion ? '#1f5fbf' : '#d42330') : null,
            shield, shieldSize: 1.15, weapon: 'sword', stand,
        });
    }
    // soldats : casque à nasal, lance, petit bouclier
    return makeFigure({
        tunic: F.tunic, emblem: F.emblem, emblemBorder: F.border, legs: F.legs, arms: lion ? '#9aa0a8' : '#2a2a30',
        helm: 'nasal', helmColor: F.armor, shield, weapon: 'spear', stand,
        beard: Math.random() < 0.4 ? '#6b4a2b' : null,
    });
}

// le joueur : le Roi (Lion) ou le Seigneur de guerre (Crâne)
export function makePlayerModel(team) {
    if (team === 'blue') {
        return makeFigure({
            tunic: '#1f5fbf', emblem: 'blueGold', emblemBorder: '#e8b923', arms: '#1f5fbf', legs: '#2a3a7a',
            crown: true, hair: '#6b4423', beard: '#6b4423', cape: '#123f85', ermine: true,
            weapon: 'scepter', stand: FACTIONS.blue.stand,
        });
    }
    return makeFigure({
        tunic: '#25252b', emblem: 'skull', emblemBorder: '#1f1f24', arms: '#34343c', armsMetal: true,
        legs: '#25252b', boots: '#1f1f24', helm: 'horned', helmColor: '#2a2a30', beard: '#3a2a1a',
        cape: '#c41e2a', pauldrons: '#34343c', weapon: 'mace', stand: FACTIONS.red.stand,
    });
}

export function makeUnitModel(type, team) {
    if (type === 'ram') return makeRam(team);
    if (type === 'cannon') return makeCannon(team);
    if (type === 'catapult') return makeCatapult(team);
    return makeSoldier(type, team);
}

// =====================================================================
//  ENGINS DE SIÈGE ET CANONS
// =====================================================================
function spokedWheel(r, wood, hubColor) {
    const g = new THREE.Group();
    const rim = new THREE.Mesh(geo('rim' + r, () => new THREE.TorusGeometry(r * 0.86, r * 0.14, 8, 24)), plastic(wood, 0.5));
    rim.rotation.y = Math.PI / 2;
    const hub = new THREE.Mesh(geo('hub' + r, () => new THREE.CylinderGeometry(r * 0.24, r * 0.24, 0.22, 12)), plastic(hubColor, 0.4));
    hub.rotation.z = Math.PI / 2;
    g.add(rim, hub);
    for (let i = 0; i < 3; i++) {
        const spoke = new THREE.Mesh(geo('spoke' + r, () => roundedBox(0.07, r * 1.7, 0.07, 0.02)), plastic(wood, 0.5));
        spoke.rotation.x = i * Math.PI / 3;
        g.add(spoke);
    }
    return g;
}

// poutre entre deux points
function beam(a, b, t, color) {
    const d = new THREE.Vector3().subVectors(b, a);
    const m = new THREE.Mesh(roundedBox(t, d.length(), t, 0.03), plastic(color, 0.5));
    m.position.copy(a).addScaledVector(d, 0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    return m;
}

export function makeCatapult(team) {
    const F = FACTIONS[team];
    const root = new THREE.Group();
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    for (const x of [-0.5, 0.5]) {
        const rail = new THREE.Mesh(roundedBox(0.18, 0.22, 2.5, 0.04), plastic(F.wood, 0.5));
        rail.position.set(x, 0.55, 0);
        root.add(rail);
        // montants en A
        root.add(beam(V(x, 0.6, -0.7), V(x, 1.85, 0.2), 0.16, F.wood));
        root.add(beam(V(x, 0.6, 0.95), V(x, 1.85, 0.2), 0.16, F.wood));
    }
    for (const z of [-1.1, 0, 1.1]) {
        const cross = new THREE.Mesh(roundedBox(1.18, 0.16, 0.16, 0.04), plastic(F.woodDark, 0.5));
        cross.position.set(0, 0.55, z);
        root.add(cross);
    }
    const stop = new THREE.Mesh(roundedBox(1.2, 0.16, 0.16, 0.04), plastic(F.woodDark, 0.5));
    stop.position.set(0, 1.85, 0.2);
    root.add(stop);
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.2, 10), metal('#5a5f66'));
    axle.rotation.z = Math.PI / 2;
    axle.position.set(0, 0.85, 0.15);
    root.add(axle);

    const wheels = [];
    for (const x of [-0.72, 0.72]) for (const z of [-0.85, 0.85]) {
        const w = spokedWheel(0.4, F.wood, F.hub);
        w.position.set(x, 0.4, z);
        root.add(w);
        wheels.push(w);
    }
    // bras de lancement
    const arm = new THREE.Group();
    arm.position.set(0, 0.85, 0.15);
    const pole = new THREE.Mesh(roundedBox(0.16, 0.16, 2.1, 0.05), plastic(F.wood, 0.5));
    pole.position.z = -0.9;
    const cup = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), plastic(F.woodDark, 0.5));
    cup.position.set(0, 0.12, -1.85);
    cup.rotation.x = Math.PI;
    const stone = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), plastic('#8d939a', 0.6));
    stone.position.set(0, 0.22, -1.85);
    arm.add(pole, cup, stone);
    arm.rotation.x = -0.25;
    root.add(arm);
    // blason du camp sur l'avant
    const sh = paintedShield(F.emblem, 0.5, 0.6, F.border);
    sh.position.set(0, 0.85, 1.2);
    root.add(sh);
    root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return { root, arm, stone, wheels, kind: 'catapult', anim: 0 };
}

// bélier : un abri roulant à toit aux couleurs du camp, sous lequel se balance un tronc à tête de bélier en fer
export function makeRam(team) {
    const F = FACTIONS[team];
    const root = new THREE.Group();
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const wood = plastic(F.wood, 0.5), dark = plastic(F.woodDark, 0.5);
    const roofColor = team === 'red' ? '#a3171d' : '#1f5fbf';
    // châssis et roues
    for (const x of [-0.65, 0.65]) {
        const rail = new THREE.Mesh(roundedBox(0.16, 0.2, 2.7, 0.04), wood);
        rail.position.set(x, 0.5, 0);
        root.add(rail);
    }
    for (const z of [-1.15, 0, 1.15]) {
        const cross = new THREE.Mesh(roundedBox(1.46, 0.15, 0.15, 0.04), dark);
        cross.position.set(0, 0.5, z);
        root.add(cross);
    }
    const wheels = [];
    for (const x of [-0.86, 0.86]) for (const z of [-0.9, 0.9]) {
        const w = spokedWheel(0.42, F.wood, F.hub);
        w.position.set(x, 0.42, z);
        root.add(w);
        wheels.push(w);
    }
    // montants et toit à deux pans (il protège les servants… des flèches, pas des lances)
    for (const x of [-0.62, 0.62]) for (const z of [-1.15, 1.15]) root.add(beam(V(x, 0.55, z), V(x * 0.25, 2.15, z), 0.13, F.wood));
    for (const s of [-1, 1]) {
        const slab = new THREE.Mesh(roundedBox(0.95, 0.09, 2.9, 0.03), plastic(roofColor, 0.5));
        slab.position.set(s * 0.4, 1.9, 0);
        slab.rotation.z = s * -0.62;
        root.add(slab);
        for (const z of [-1.0, -0.33, 0.33, 1.0]) {
            const plank = new THREE.Mesh(roundedBox(0.97, 0.04, 0.06, 0.01), dark);
            plank.position.set(s * 0.4, 1.95, z);
            plank.rotation.z = s * -0.62;
            root.add(plank);
        }
        const sh = paintedShield(F.emblem, 0.5, 0.6, F.border);
        sh.position.set(s * 0.71, 1.25, 0);
        sh.rotation.y = s * Math.PI / 2;
        root.add(sh);
    }
    const ridge = new THREE.Mesh(roundedBox(0.14, 0.14, 3.0, 0.04), dark);
    ridge.position.y = 2.2;
    root.add(ridge);
    // le tronc suspendu, qui se balance d'avant en arrière pour frapper
    const swing = new THREE.Group();
    swing.position.set(0, 1.95, 0);
    root.add(swing);
    for (const z of [-0.6, 0.6]) {
        const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.95, 6), plastic('#d9c7a0', 0.8));
        rope.position.set(0, -0.47, z);
        swing.add(rope);
    }
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.23, 3.0, 14), plastic('#7a4f28', 0.6));
    log.rotation.x = Math.PI / 2;
    log.position.set(0, -0.98, 0.15);
    swing.add(log);
    const iron = metal('#8a9098');
    for (const z of [-0.9, 0, 0.9]) {
        const band = new THREE.Mesh(new THREE.TorusGeometry(0.225, 0.035, 6, 18), iron);
        band.position.set(0, -0.98, z);
        swing.add(band);
    }
    // tête de bélier en fer, cornes enroulées
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 12), iron);
    head.scale.set(1, 0.9, 1.25);
    head.position.set(0, -0.98, 1.72);
    const snout = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), iron);
    snout.position.set(0, -1.04, 2.0);
    swing.add(head, snout);
    for (const s of [-1, 1]) {
        const horn = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.065, 8, 18, Math.PI * 1.5), metal(COLORS.gold));
        horn.position.set(s * 0.3, -0.92, 1.62);
        horn.rotation.set(0, Math.PI / 2, s > 0 ? 0.6 : 2.5);
        swing.add(horn);
    }
    root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return { root, wheels, swing, kind: 'ram', anim: 0 };
}

export function makeCannon(team) {
    const F = FACTIONS[team];
    const root = new THREE.Group();
    // affût en bois
    for (const s of [-1, 1]) {
        const cheek = new THREE.Shape();
        cheek.moveTo(-0.75, 0); cheek.lineTo(0.7, 0); cheek.lineTo(0.7, 0.42); cheek.lineTo(0.25, 0.5);
        cheek.lineTo(0.05, 0.36); cheek.lineTo(-0.35, 0.3); cheek.lineTo(-0.75, 0.18); cheek.lineTo(-0.75, 0);
        const g = new THREE.ExtrudeGeometry(cheek, { depth: 0.14, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 1 });
        g.rotateY(-Math.PI / 2);
        const m = new THREE.Mesh(g, plastic(F.wood, 0.5));
        m.position.set(s * 0.3 + (s > 0 ? 0.14 : 0), 0.42, 0);
        root.add(m);
    }
    const bed = new THREE.Mesh(roundedBox(0.6, 0.14, 1.4, 0.04), plastic(F.woodDark, 0.5));
    bed.position.set(0, 0.42, -0.05);
    root.add(bed);
    const wheels = [];
    for (const [z, r] of [[0.45, 0.42], [-0.55, 0.32]]) {
        for (const x of [-0.58, 0.58]) {
            const w = spokedWheel(r, F.wood, F.hub);
            w.position.set(x, r, z);
            root.add(w);
            wheels.push(w);
        }
    }
    // fût en fonte noire
    const pts = [[0, -0.95], [0.1, -0.95], [0.12, -0.9], [0.24, -0.82], [0.27, -0.66], [0.25, -0.5], [0.22, 0.55],
        [0.26, 0.6], [0.26, 0.78], [0.2, 0.8], [0.13, 0.8], [0.13, 0.6]].map(([r, y]) => new THREE.Vector2(r, y));
    const barrelGeo = new THREE.LatheGeometry(pts, 28);
    barrelGeo.rotateX(Math.PI / 2);
    const barrel = new THREE.Group();
    barrel.position.set(0, 0.92, 0.05);
    barrel.rotation.x = -0.12;
    const tube = new THREE.Mesh(barrelGeo, plastic('#2b2c31', 0.25));
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), plastic('#2b2c31', 0.25));
    knob.position.z = -1.0;
    const trunnion = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.7, 10), plastic('#2b2c31', 0.25));
    trunnion.rotation.z = Math.PI / 2;
    barrel.add(tube, knob, trunnion);
    root.add(barrel);
    for (const s of [-1, 1]) {
        const sh = paintedShield(F.emblem, 0.36, 0.44, F.border);
        sh.position.set(s * 0.47, 0.62, -0.15);
        sh.rotation.y = s * Math.PI / 2;
        root.add(sh);
    }
    root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return { root, barrel, wheels, kind: 'cannon', anim: 0, barrelZ: 0.05 };
}

// =====================================================================
//  LE CHÂTEAU "JOUET" (reproduction du château Fisher-Price des photos)
//  repère local : porte rouge vers +z, 4 tours rondes aux coins
// =====================================================================

// pierres irrégulières moulées (gris ou sable selon la palette)
function makeStoneMat({ mortar, stone, tint }) {
    const S = 512;
    const rows = [];
    for (let y = 0; y < S;) {
        let h = 44 + Math.random() * 24;
        if (S - y - h < 40) h = S - y;
        rows.push([y, h]);
        y += h;
    }
    const stones = [];
    for (const [ry, rh] of rows) {
        const start = Math.random() * S;
        for (let acc = 0; acc < S;) {
            let w = 60 + Math.random() * 75;
            if (S - acc - w < 45) w = S - acc;
            stones.push([start + acc, ry, w, rh, Math.random()]);
            acc += w;
        }
    }
    const each = fn => { for (const st of stones) for (const ox of [0, -S]) fn(st[0] + ox, st[1], st[2], st[3], st[4]); };
    const color = makeCanvas(S, ctx => {
        ctx.fillStyle = mortar;
        ctx.fillRect(0, 0, S, S);
        each((x, y, w, h, v) => {
            ctx.fillStyle = stone(v);
            ctx.beginPath(); ctx.roundRect(x + 4, y + 4, w - 8, h - 8, 13); ctx.fill();
            const g = ctx.createLinearGradient(x, y, x + w * 0.4, y + h);
            g.addColorStop(0, 'rgba(255,255,255,0.2)');
            g.addColorStop(0.5, 'rgba(255,255,255,0)');
            g.addColorStop(1, 'rgba(0,0,0,0.14)');
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.roundRect(x + 4, y + 4, w - 8, h - 8, 13); ctx.fill();
        });
    });
    const height = makeCanvas(S, ctx => {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, S, S);
        ctx.filter = 'blur(4px)';
        each((x, y, w, h) => {
            ctx.fillStyle = '#cfcfcf';
            ctx.beginPath(); ctx.roundRect(x + 6, y + 6, w - 12, h - 12, 14); ctx.fill();
        });
        ctx.filter = 'none';
    });
    const map = new THREE.CanvasTexture(color);
    map.colorSpace = THREE.SRGBColorSpace;
    const bump = new THREE.CanvasTexture(height);
    for (const t of [map, bump]) {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(0.36, 0.36);
        t.anisotropy = 8;
    }
    return new THREE.MeshStandardMaterial({ map, bumpMap: bump, bumpScale: 2, roughness: 0.5, color: tint });
}
const toyStone = makeStoneMat({
    mortar: '#7d8287', tint: '#c4c8cc',
    stone: r => { const v = Math.round(172 + r * 26); return `rgb(${v},${v + 3},${v + 7})`; },
});
const sandStone = makeStoneMat({
    mortar: '#b58f5f', tint: '#ffffff',
    stone: r => `rgb(${Math.round(222 + r * 22)},${Math.round(190 + r * 20)},${Math.round(146 + r * 18)})`,
});

// blasons peints (lions héraldiques)
function drawLion(ctx, color) {
    ctx.save();
    ctx.translate(132, 170);
    ctx.fillStyle = ctx.strokeStyle = color;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.ellipse(0, 8, 32, 54, -0.35, 0, 7); ctx.fill();          // corps
    ctx.beginPath(); ctx.arc(-18, -56, 30, 0, 7); ctx.fill();                       // tête + crinière
    ctx.beginPath(); ctx.ellipse(-48, -50, 17, 11, 0.1, 0, 7); ctx.fill();          // museau
    ctx.lineWidth = 15;
    ctx.beginPath(); ctx.moveTo(-14, -14); ctx.lineTo(-56, -24); ctx.lineTo(-64, -46); ctx.stroke();   // pattes levées
    ctx.beginPath(); ctx.moveTo(-8, 12); ctx.lineTo(-52, 14); ctx.lineTo(-62, -2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(8, 44); ctx.lineTo(-12, 84); ctx.lineTo(-34, 90); ctx.stroke();      // pattes arrière
    ctx.beginPath(); ctx.moveTo(24, 38); ctx.lineTo(34, 84); ctx.lineTo(14, 96); ctx.stroke();
    ctx.lineWidth = 8;
    ctx.beginPath(); ctx.moveTo(28, 28); ctx.quadraticCurveTo(82, 18, 62, -30); ctx.quadraticCurveTo(56, -52, 78, -62); ctx.stroke(); // queue
    ctx.restore();
}
function drawSkull(ctx, cx = 128, cy = 150, k = 1) {
    ctx.save();
    ctx.translate(cx, cy); ctx.scale(k, k);
    ctx.strokeStyle = ctx.fillStyle = '#f4f1ea';
    ctx.lineCap = 'round'; ctx.lineWidth = 20;
    for (const [x0, y0, x1, y1] of [[-80, -80, 80, 100], [80, -80, -80, 100]]) {   // os croisés
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        for (const [x, y] of [[x0, y0], [x1, y1]]) {
            ctx.beginPath(); ctx.arc(x - 9, y, 13, 0, 7); ctx.arc(x + 9, y, 13, 0, 7); ctx.fill();
        }
    }
    ctx.beginPath(); ctx.arc(0, -10, 62, 0, 7); ctx.fill();                         // crâne
    ctx.beginPath(); ctx.roundRect(-38, 25, 76, 50, 14); ctx.fill();                 // mâchoire
    ctx.fillStyle = '#1a1a1f';
    for (const x of [-25, 25]) { ctx.beginPath(); ctx.ellipse(x, -8, 17, 20, 0, 0, 7); ctx.fill(); }
    ctx.beginPath(); ctx.moveTo(0, 18); ctx.lineTo(-9, 34); ctx.lineTo(9, 34); ctx.fill();
    ctx.fillRect(-20, 52, 4, 22); ctx.fillRect(-2, 52, 4, 22); ctx.fillRect(16, 52, 4, 22);
    ctx.restore();
}
const heraldryCache = {};
function heraldry(kind) {
    if (heraldryCache[kind]) return heraldryCache[kind];
    const c = document.createElement('canvas');
    c.width = 256; c.height = 320;
    const ctx = c.getContext('2d');
    const blue = '#1d4fb8', yellow = '#f5c518', red = '#d62128', white = '#f4f1ea';
    if (kind === 'skull') {
        ctx.fillStyle = '#1f1f24'; ctx.fillRect(0, 0, 256, 320);
        ctx.fillStyle = '#c41e2a'; ctx.fillRect(128, 0, 128, 320);
        drawSkull(ctx, 128, 165, 0.9);
    } else if (kind === 'skullFlag') {
        ctx.fillStyle = '#c41e2a'; ctx.fillRect(0, 0, 256, 320);
        ctx.fillStyle = '#1f1f24'; ctx.beginPath(); ctx.moveTo(256, 0); ctx.lineTo(256, 320); ctx.lineTo(0, 320); ctx.fill();
        drawSkull(ctx, 128, 160, 0.85);
    } else if (kind === 'skullRed' || kind === 'skullBlack') {
        const [field, rim] = kind === 'skullRed' ? ['#c41e2a', '#1f1f24'] : ['#1f1f24', '#c41e2a'];
        ctx.fillStyle = field; ctx.fillRect(0, 0, 256, 320);
        ctx.strokeStyle = rim; ctx.lineWidth = 14; ctx.strokeRect(10, 10, 236, 300);
        drawSkull(ctx, 128, 160, 0.8);
    } else if (kind === 'lionFlag') {
        ctx.fillStyle = blue; ctx.fillRect(0, 0, 256, 320);
        ctx.strokeStyle = yellow; ctx.lineWidth = 14; ctx.strokeRect(10, 10, 236, 300);
        drawLion(ctx, yellow);
    } else if (kind === 'quarter') {
        ctx.fillStyle = blue; ctx.fillRect(0, 0, 256, 320);
        ctx.fillStyle = yellow; ctx.fillRect(128, 0, 128, 160); ctx.fillRect(0, 160, 128, 160);
        ctx.save(); ctx.scale(0.5, 0.5); drawLion(ctx, yellow); ctx.restore();
        ctx.save(); ctx.translate(128, 160); ctx.scale(0.5, 0.5); drawLion(ctx, blue); ctx.restore();
        ctx.fillStyle = '#2a2a33'; ctx.fillRect(124, 0, 8, 320); ctx.fillRect(0, 156, 256, 8);
    } else {
        const [field, beast] = {
            redWhite: [red, white], redGold: [red, yellow], blueGold: [blue, yellow], blueWhite: [blue, white],
        }[kind];
        ctx.fillStyle = field; ctx.fillRect(0, 0, 256, 320);
        drawLion(ctx, beast);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return (heraldryCache[kind] = t);
}
const shieldCache = {};
function paintedShield(kind, w = 1.0, h = 1.2, border = '#2a2a33') {
    const key = `${kind}|${w}|${h}|${border}`;
    if (!shieldCache[key]) {
        const tex = heraldry(kind).clone();
        tex.needsUpdate = true;
        tex.repeat.set(1 / w, 1 / h);
        tex.offset.set(0.5, 0.5);
        const t = Math.min(w, h);
        shieldCache[key] = {
            geo: new THREE.ExtrudeGeometry(shieldShape(w, h), {
                depth: 0.06 * t, bevelEnabled: true, bevelThickness: 0.04 * t, bevelSize: 0.05 * t, bevelSegments: 2,
            }),
            mats: [new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35 }), plastic(border, 0.4)],
        };
    }
    const c = shieldCache[key];
    const m = new THREE.Mesh(c.geo, c.mats);
    m.castShadow = true;
    return m;
}

// bannière de tissu à pointe, suspendue à une tringle (origine = milieu de la tringle)
function wallBanner(kind, w = 1.1, h = 2.6, rodColor = COLORS.gold) {
    const g = new THREE.Group();
    const s = new THREE.Shape();
    s.moveTo(0, 1); s.lineTo(1, 1); s.lineTo(1, 0.12); s.lineTo(0.5, 0); s.lineTo(0, 0.12); s.lineTo(0, 1);
    const geo = new THREE.ShapeGeometry(s);           // les UV de ShapeGeometry valent (x, y) : déjà dans [0, 1]
    geo.translate(-0.5, -1, 0);
    const cloth = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: heraldry(kind), roughness: 0.7, side: THREE.DoubleSide }));
    cloth.scale.set(w, h, 1);
    cloth.position.set(0, -0.05, 0.06);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, w + 0.4, 10), metal(rodColor));
    rod.rotation.z = Math.PI / 2;
    rod.position.z = 0.08;
    g.add(cloth, rod);
    for (const sx of [-1, 1]) {
        const knob = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), metal(rodColor));
        knob.position.set(sx * (w / 2 + 0.22), 0, 0.08);
        g.add(knob);
    }
    return g;
}

// torche murale de part et d'autre d'une porte
function gateTorch(x, y, z, cupColor, ringColor) {
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.14, 0.55, 14), plastic(cupColor, 0.35));
    cup.position.set(x, y, z + 0.2);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.06, 8, 18), plastic(ringColor, 0.35));
    ring.rotation.x = Math.PI / 2; ring.position.set(x, y + 0.27, z + 0.2);
    const arm = new THREE.Mesh(roundedBox(0.14, 0.14, 0.4, 0.04), plastic(cupColor, 0.35));
    arm.position.set(x, y - 0.1, z);
    add(cup, { collide: false }); add(ring, { collide: false }); add(arm, { collide: false });
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.55, 14), new THREE.MeshStandardMaterial({
        color: '#ffd23a', emissive: '#ff9a1a', emissiveIntensity: 2.4,
    }));
    flame.position.set(x, y + 0.6, z + 0.2);
    add(flame, { collide: false });
    flames.push(flame);
    const light = new THREE.PointLight('#ffb040', 2.5, 6, 1.6);
    light.position.set(x, y + 0.8, z + 0.75);
    PARENT.add(light);
}

// tonneaux, caisses et râtelier d'armes dans un coin de la cour
function courtyardProps(x, y, z, rotY, { band = '#3d4046', wood = '#8a5228', banner = null } = {}) {
    const g = new THREE.Group();
    const staves = plastic(wood, 0.55), iron = metal(band);
    for (const [bx, bz, up] of [[0, 0, true], [0.75, 0.15, true], [0.35, 0.7, false]]) {
        const barrel = new THREE.Group();
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.8, 16), staves);
        body.scale.set(1.12, 1, 1.12);
        const bulge = new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 10), staves);
        bulge.scale.y = 1.15;
        barrel.add(body, bulge);
        for (const y of [-0.28, 0.28]) {
            const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.335, 0.03, 6, 20), iron);
            hoop.rotation.x = Math.PI / 2; hoop.position.y = y;
            barrel.add(hoop);
        }
        if (up) barrel.position.set(bx, 0.4, bz);
        else { barrel.rotation.z = Math.PI / 2; barrel.position.set(bx, 0.34, bz); }
        g.add(barrel);
    }
    // caisses empilées
    const crateMat = plastic('#b07a42', 0.6), slat = plastic('#7a4f28', 0.6);
    for (const [cx, cy, cz, s] of [[-0.9, 0.35, 0.1, 0.7], [-0.85, 0.95, 0.1, 0.5]]) {
        const crate = new THREE.Mesh(roundedBox(s, s, s, 0.04), crateMat);
        crate.position.set(cx, cy, cz);
        crate.rotation.y = cy > 0.5 ? 0.3 : 0;
        g.add(crate);
        const cross = new THREE.Mesh(roundedBox(s * 1.25, 0.08, 0.03, 0.01), slat);
        cross.position.set(0, 0, s / 2 + 0.01);
        cross.rotation.z = 0.78;
        crate.add(cross);
    }
    // râtelier avec trois lances
    const rack = new THREE.Group();
    rack.position.set(-0.2, 0, -0.55);
    for (const sx of [-0.6, 0.6]) {
        const post = new THREE.Mesh(roundedBox(0.1, 1.5, 0.1, 0.03), slat);
        post.position.set(sx, 0.75, 0);
        rack.add(post);
    }
    for (const y of [0.4, 1.25]) {
        const bar = new THREE.Mesh(roundedBox(1.3, 0.08, 0.08, 0.02), slat);
        bar.position.y = y;
        rack.add(bar);
    }
    for (const sx of [-0.35, 0, 0.35]) {
        const spear = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 2.0, 8), plastic('#8a5a2b', 0.5));
        spear.position.set(sx, 1.0, 0.06);
        const tip = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.22, 8), metal('#dfe4ea'));
        tip.position.set(sx, 2.1, 0.06);
        rack.add(spear, tip);
    }
    if (banner) {
        const sh = paintedShield(banner, 0.5, 0.6);
        sh.position.set(0, 0.85, 0.08);
        rack.add(sh);
    }
    g.add(rack);
    g.position.set(x, y, z);
    g.rotation.y = rotY;
    return g;
}

// socle vert avec une encoche devant la porte, pour que le pont-levis descende jusqu'au sol
function notchedBase(a, b, color, n = 2.3, nz = 7.6, r = 4) {
    const s = new THREE.Shape();
    s.moveTo(-a + r, -b);
    s.lineTo(-n, -b); s.lineTo(-n, -nz); s.lineTo(n, -nz); s.lineTo(n, -b);
    s.lineTo(a - r, -b); s.quadraticCurveTo(a, -b, a, -b + r);
    s.lineTo(a, b - r); s.quadraticCurveTo(a, b, a - r, b);
    s.lineTo(-a + r, b); s.quadraticCurveTo(-a, b, -a, b - r);
    s.lineTo(-a, -b + r); s.quadraticCurveTo(-a, -b, -a + r, -b);
    const geo = new THREE.ExtrudeGeometry(s, { depth: 0.4, bevelEnabled: true, bevelThickness: 0.3, bevelSize: 0.3, bevelSegments: 3, curveSegments: 16 });
    geo.rotateX(-Math.PI / 2);
    const base = new THREE.Mesh(geo, plastic(color, 0.35));
    base.position.y = 0.3;
    return add(base, { ground: true });
}

// pont-levis articulé en bas de l'arche : levé il ferme l'entrée, baissé il fait une rampe jusqu'au sol
// (le même modèle en bois cerclé de fer pour les deux châteaux)
function addDrawbridge(castle, { z, B, L, width = 3.3, chains = true }) {
    const openAngle = Math.PI / 2 + Math.asin(B / L);
    const pivot = new THREE.Group();
    pivot.position.set(0, B, z);
    castle.group.add(pivot);

    const tex = makeCanvas(128, (ctx, s) => {
        for (let i = 0; i < 6; i++) {          // planches de bois
            const v = Math.random() * 20;
            ctx.fillStyle = `rgb(${150 + v},${98 + v * 0.7},${52 + v * 0.4})`;
            ctx.fillRect(i * s / 6, 0, s / 6, s);
            ctx.fillStyle = 'rgba(60,30,10,0.55)';
            ctx.fillRect(i * s / 6, 0, 2, s);
        }
    });
    const t = new THREE.CanvasTexture(tex);
    t.colorSpace = THREE.SRGBColorSpace;
    const plank = new THREE.Mesh(roundedBox(width, L, 0.25, 0.08), new THREE.MeshStandardMaterial({
        map: t, roughness: 0.75, envMapIntensity: 0.25,
    }));
    plank.position.y = L / 2;
    pivot.add(plank);
    // bandes de fer et clous des deux côtés
    for (const side of [1, -1]) {
        for (const y of [0.5, L / 2, L - 0.5]) {
            const band = new THREE.Mesh(roundedBox(width - 0.1, 0.18, 0.05, 0.02), metal('#3d4046'));
            band.position.set(0, y, side * 0.14);
            pivot.add(band);
            for (const x of [-1.2, -0.4, 0.4, 1.2]) {
                const nail = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), metal('#9aa0a8'));
                nail.position.set(x, y, side * 0.17);
                pivot.add(nail);
            }
        }
    }
    pivot.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    colliders.push(pivot);
    groundColliders.push(pivot);

    // chaînes entre le mur et le bout du pont
    const links = [];
    if (chains) {
        const g = new THREE.CylinderGeometry(0.05, 0.05, 1, 6);
        for (const x of [-(width / 2 - 0.15), width / 2 - 0.15]) {
            const c = new THREE.Mesh(g, metal('#4a4e55'));
            c.castShadow = true;
            castle.group.add(c);
            const anchor = new THREE.Vector3(Math.sign(x) * (width / 2 + 0.35), B + L + 0.1, z - 0.1);
            const ring = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.04, 8, 16), metal('#4a4e55'));
            ring.position.copy(anchor);
            castle.group.add(ring);
            links.push({ mesh: c, ring, anchor, local: new THREE.Vector3(x, L - 0.15, 0) });
        }
    }

    castle.door = { angle: openAngle, open: true, broken: false };
    castle.doorText = open => (open ? 'lever le pont-levis' : 'baisser le pont-levis');
    // château à 0 PV : les chaînes cassent, le pont retombe de travers et ne peut plus se relever
    castle.setBroken = b => {
        if (castle.door.broken === b) return;
        castle.door.broken = b;
        for (const l of links) l.mesh.visible = !b;
    };
    const tA = new THREE.Vector3(), tB = new THREE.Vector3(), UPV = new THREE.Vector3(0, 1, 0);
    castle.updateDoor = dt => {
        const door = castle.door;
        const target = door.broken ? openAngle - 0.09 : door.open ? openAngle : 0;
        door.angle += THREE.MathUtils.clamp(target - door.angle, -1.6 * dt, 1.6 * dt);
        pivot.rotation.x = door.angle;
        pivot.rotation.y = THREE.MathUtils.lerp(pivot.rotation.y, door.broken ? 0.13 : 0, 1 - Math.exp(-3 * dt));
        pivot.updateMatrix();
        pivot.updateMatrixWorld(true);
        if (door.broken) return;
        for (const l of links) {
            tA.copy(l.local).applyMatrix4(pivot.matrix);
            tB.subVectors(l.anchor, tA);
            const len = tB.length();
            l.mesh.position.copy(tA).addScaledVector(tB, 0.5);
            l.mesh.scale.y = len;
            l.mesh.quaternion.setFromUnitVectors(UPV, tB.normalize());
        }
    };
}

const VAULT_H = 3.6;

// coffre au trésor ouvert, rempli de pièces
function treasureChest() {
    const g = new THREE.Group();
    const W = 0.9, H = 0.48, D = 0.6, R = D / 2;
    const wood = plastic('#8a5228', 0.55), woodDark = plastic('#5e3418', 0.55);
    const iron = metal('#3d4046'), gold = metal(COLORS.gold);

    // caisse en planches
    const body = new THREE.Mesh(roundedBox(W, H, D, 0.04), wood);
    body.position.y = H / 2;
    g.add(body);
    for (const y of [H * 0.36, H * 0.68]) {          // rainures entre les planches
        const groove = new THREE.Mesh(roundedBox(W + 0.005, 0.018, D + 0.005, 0.005), woodDark);
        groove.position.y = y;
        g.add(groove);
    }
    // ferrures : cerclage du haut et du bas, coins, bandes verticales
    for (const y of [0.04, H - 0.035]) {
        const rim = new THREE.Mesh(roundedBox(W + 0.03, 0.07, D + 0.03, 0.02), iron);
        rim.position.y = y;
        g.add(rim);
    }
    for (const x of [-W * 0.32, W * 0.32]) {
        const strap = new THREE.Mesh(roundedBox(0.08, H, D + 0.035, 0.02), iron);
        strap.position.set(x, H / 2, 0);
        g.add(strap);
    }
    // serrure dorée avec trou de serrure
    const plate = new THREE.Mesh(roundedBox(0.16, 0.18, 0.03, 0.02), gold);
    plate.position.set(0, H - 0.1, D / 2 + 0.02);
    const keyhole = new THREE.Mesh(roundedBox(0.03, 0.07, 0.02, 0.01), plastic('#1a1a1f'));
    keyhole.position.set(0, H - 0.11, D / 2 + 0.035);
    g.add(plate, keyhole);

    // le trésor qui dépasse
    const fill = new THREE.Mesh(roundedBox(W - 0.08, 0.06, D - 0.08, 0.02), gold);
    fill.position.y = H - 0.01;
    g.add(fill);
    const coinGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.02, 12);
    for (let i = 0; i < 14; i++) {
        const c = new THREE.Mesh(coinGeo, gold);
        c.position.set((Math.random() - 0.5) * (W - 0.2), H + 0.04 + Math.random() * 0.08, (Math.random() - 0.5) * (D - 0.2));
        c.rotation.set((Math.random() - 0.5) * 1.2, 0, (Math.random() - 0.5) * 1.2);
        g.add(c);
    }
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.06), new THREE.MeshStandardMaterial({
        color: '#d62128', roughness: 0.15, emissive: '#d62128', emissiveIntensity: 0.3,
    }));
    gem.position.set(0.15, H + 0.1, 0.05);
    g.add(gem);

    // couvercle bombé, ouvert vers l'arrière (charnière sur l'arête arrière)
    const hinge = new THREE.Group();
    hinge.position.set(0, H, -D / 2);
    hinge.rotation.x = -1.85;                        // un peu au-delà de la verticale
    const lid = new THREE.Group();
    lid.position.z = R;                               // le couvercle couvre la caisse quand il est fermé
    const dome = new THREE.Mesh(new THREE.CylinderGeometry(R, R, W, 20, 1, false, 0, Math.PI), wood);
    dome.rotation.z = Math.PI / 2;
    lid.add(dome);
    const lining = new THREE.Mesh(roundedBox(W - 0.06, 0.02, D - 0.06, 0.008), plastic('#c41e2a', 0.8));
    lining.position.y = 0.005;                         // tissu rouge sous le couvercle
    lid.add(lining);
    for (const x of [-W * 0.32, W * 0.32]) {
        const band = new THREE.Mesh(new THREE.TorusGeometry(R + 0.012, 0.03, 6, 18, Math.PI), iron);
        band.rotation.y = Math.PI / 2;
        band.position.x = x;
        lid.add(band);
    }
    // cadre de fer autour du couvercle (le tissu rouge reste visible au milieu)
    for (const z of [-D / 2, D / 2]) {
        const bar = new THREE.Mesh(roundedBox(W + 0.03, 0.05, 0.05, 0.02), iron);
        bar.position.set(0, 0.02, z);
        lid.add(bar);
    }
    for (const x of [-W / 2, W / 2]) {
        const bar = new THREE.Mesh(roundedBox(0.05, 0.05, D + 0.03, 0.02), iron);
        bar.position.set(x, 0.02, 0);
        lid.add(bar);
    }
    hinge.add(lid);
    g.add(hinge);

    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return g;
}

// salle des coffres au pied d'une tour ; la taille du tas d'or suit l'or de l'équipe
function addVault(castle, { cx, cz, r, angle, B, team }) {
    const room = new THREE.Group();
    room.position.set(cx, B, cz);
    room.rotation.y = angle;               // +z local = vers la porte
    const inner = r - 0.5;
    const gold = metal(COLORS.gold);

    const rug = new THREE.Mesh(new THREE.CircleGeometry(inner - 0.35, 40), plastic(TEAM[team].main, 0.9));
    rug.rotation.x = -Math.PI / 2;
    rug.position.y = 0.02;
    const rugEdge = new THREE.Mesh(new THREE.RingGeometry(inner - 0.45, inner - 0.3, 40), plastic(COLORS.gold, 0.6));
    rugEdge.rotation.x = -Math.PI / 2;
    rugEdge.position.y = 0.025;
    room.add(rug, rugEdge);

    // trois coffres contre le mur du fond, tournés vers le centre
    for (const b of [Math.PI, Math.PI - 1.0, Math.PI + 1.0]) {
        const c = treasureChest();
        c.position.set(Math.sin(b) * (inner - 0.55), 0, Math.cos(b) * (inner - 0.55));
        c.rotation.y = b + Math.PI;
        room.add(c);
    }

    // tas de pièces au milieu (sa taille suit l'or de l'équipe)
    const pile = new THREE.Group();
    pile.position.set(0, 0, -0.2);
    const MR = 0.55, MY = 0.5;                         // rayon et aplatissement du tas
    const mound = new THREE.Mesh(new THREE.SphereGeometry(MR, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), metal('#c9971a'));
    mound.scale.y = MY;
    pile.add(mound);
    // des pièces posées à plat sur toute la surface du tas, et quelques-unes autour
    const coinGeo = new THREE.CylinderGeometry(0.085, 0.085, 0.025, 14);
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < 70; i++) {
        const coin = new THREE.Mesh(coinGeo, gold);
        const a = Math.random() * Math.PI * 2;
        const d = i < 55 ? Math.sqrt(Math.random()) * MR * 0.95 : MR + Math.random() * 0.35;
        const h = d < MR ? Math.sqrt(MR * MR - d * d) * MY : 0;
        coin.position.set(Math.cos(a) * d, h + 0.012, Math.sin(a) * d);
        // pièce couchée selon la pente du tas, avec un peu de désordre
        const n = d < MR ? new THREE.Vector3(Math.cos(a) * d * MY, h, Math.sin(a) * d * MY).normalize() : up.clone();
        n.x += (Math.random() - 0.5) * 0.5; n.z += (Math.random() - 0.5) * 0.5;
        coin.quaternion.setFromUnitVectors(up, n.normalize());
        pile.add(coin);
    }
    room.add(pile);

    // socle avec un gobelet et des pierres précieuses
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.7, 16), plastic('#9aa0a6', 0.5));
    ped.position.set(Math.sin(1.55) * (inner - 0.4), 0.35, Math.cos(1.55) * (inner - 0.4));
    room.add(ped);
    const goblet = new THREE.Group();
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.05, 0.16, 14), gold);
    cup.position.y = 0.2;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.12, 8), gold);
    stem.position.y = 0.08;
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.02, 14), gold);
    goblet.add(cup, stem, foot);
    goblet.position.copy(ped.position).setY(0.7);
    room.add(goblet);
    const gemGeo = new THREE.OctahedronGeometry(0.07);
    ['#d62128', '#1d4fb8', '#2fae47', '#d62128', '#9b3fd0'].forEach((c, i) => {
        const gem = new THREE.Mesh(gemGeo, new THREE.MeshStandardMaterial({ color: c, roughness: 0.15, metalness: 0.2, emissive: c, emissiveIntensity: 0.25 }));
        const a = Math.PI * 2 * i / 5 + 0.4;
        gem.position.set(Math.cos(a) * 0.62, 0.06, Math.sin(a) * 0.62 - 0.2);
        gem.rotation.set(Math.random(), Math.random(), Math.random());
        room.add(gem);
    });

    // deux torches murales et une lumière chaude
    for (const a of [Math.PI / 2 + 0.2, -Math.PI / 2 - 0.2]) {
        const x = Math.sin(a) * (inner - 0.05), z = Math.cos(a) * (inner - 0.05);
        const holder = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.05, 0.3, 10), plastic('#3a2a1a', 0.5));
        holder.position.set(x, 2.0, z);
        const flame = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.32, 12), new THREE.MeshStandardMaterial({
            color: '#ffd23a', emissive: '#ff9a1a', emissiveIntensity: 2.4,
        }));
        flame.position.set(x, 2.32, z);
        room.add(holder, flame);
        flames.push(flame);
    }
    const light = new THREE.PointLight('#ffbf6a', 5, 4.2, 1.4);
    light.position.set(0, VAULT_H - 0.7, 0);
    room.add(light);
    add(room);

    // cadre en bois et médaillon doré autour de la porte (face extérieure)
    for (const s of [-1, 1]) {
        const post = new THREE.Mesh(roundedBox(0.18, 2.55, 0.18, 0.04), plastic('#6b4423', 0.5));
        placeOnTower(post, cx, cz, r + 0.05, B + 1.27, angle + s * (0.8 / r));
    }
    placeOnTower(new THREE.Mesh(roundedBox(1.8, 0.22, 0.2, 0.05), plastic('#6b4423', 0.5)), cx, cz, r + 0.05, B + 2.6, angle);
    const medal = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.08, 28), gold);
    disc.rotation.x = Math.PI / 2;
    const inset = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.1, 28), metal('#c9971a'));
    inset.rotation.x = Math.PI / 2;
    medal.add(disc, inset);
    placeOnTower(medal, cx, cz, r + 0.06, B + 3.15, angle);

    castle.vaultLocal = new THREE.Vector3(cx, B, cz);
    castle.vaultRadius = inner;
    castle.setTreasure = g => {
        const k = 0.45 + Math.min(g, 1200) / 1200 * 1.0;
        pile.scale.setScalar(k);
    };
}

// briques communes aux châteaux jouets : créneaux, rochers, tours rondes creuses
function toyKit(castle, mat, rockMat, B, walkH, stairMat = mat) {
    const toyMerlon = (x, y, z, rot, w = 0.85, h = 0.8, d = 0.5) => {
        const geo = roundedBox(w, h, d, 0.08);
        boxUV(geo, x, y, z);
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y + h / 2, z);
        m.rotation.y = rot;
        add(m);
        castle.merlons.push(m);
    };
    const merlonRow = (x0, z0, x1, z1, y) => {
        const len = Math.hypot(x1 - x0, z1 - z0);
        const n = Math.max(2, Math.round(len / 1.45) + 1);
        const rot = Math.atan2(x1 - x0, z1 - z0) + Math.PI / 2;
        for (let i = 0; i < n; i++) {
            const t = i / (n - 1);
            toyMerlon(x0 + (x1 - x0) * t, y, z0 + (z1 - z0) * t, rot);
        }
    };

    // gros rochers à facettes tout autour (comme le moulage du jouet)
    const rockGeo2 = new THREE.DodecahedronGeometry(1, 0);
    const bigRock = (x, y, z, s, sy = 0.75) => {
        const m = new THREE.Mesh(rockGeo2, rockMat);
        m.position.set(x, y, z);
        m.scale.set(s * (0.85 + Math.random() * 0.4), s * sy * (0.8 + Math.random() * 0.4), s * (0.85 + Math.random() * 0.4));
        m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
        add(m, { collide: false });
    };
    // ---- tours creuses : portes, plancher au niveau du chemin de ronde, escalier en colimaçon
    // angles : a = 0 vers +z, a = π/2 vers +x (direction (sin a, cos a)) ; une forme 2D tournée de -90° autour de x
    // voit ses angles décalés de -π/2
    const SHELL = 0.5, COL = 0.3, DTH = 0.38, OPEN = 5 * DTH, OPEN_TOP = 7 * DTH, STEP_RISE = 0.3, STEP_T = 0.06;
    const walkY = B + walkH;
    const sectorShape = (r0, r1, a0, a1) => {
        const sh = new THREE.Shape();
        sh.absarc(0, 0, r1, a0 - Math.PI / 2, a1 - Math.PI / 2, false);
        if (r0 > 0) sh.absarc(0, 0, r0, a1 - Math.PI / 2, a0 - Math.PI / 2, true);
        else sh.lineTo(0, 0);
        sh.closePath();
        return sh;
    };
    const ringShape = (r0, r1) => {
        const sh = new THREE.Shape().absarc(0, 0, r1, 0, Math.PI * 2, false);
        if (r0 > 0) sh.holes.push(new THREE.Path().absarc(0, 0, r0, 0, Math.PI * 2, true));
        return sh;
    };
    const extrudeAt = (shape, cx, y, cz, h, segs = 48, material = mat) => {
        const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: segs });
        g.rotateX(-Math.PI / 2);
        const m = new THREE.Mesh(g, material);
        m.position.set(cx, y, cz);
        return add(m);
    };
    // mur circulaire percé d'ouvertures { a, half, y0, y1 }
    const shell = (cx, cz, r, y0, y1, gaps) => {
        const ys = [...new Set([y0, y1, ...gaps.flatMap(g => [g.y0, g.y1])])]
            .filter(y => y >= y0 && y <= y1).sort((a, b) => a - b);
        for (let i = 0; i < ys.length - 1; i++) {
            const ya = ys[i], yb = ys[i + 1];
            const open = gaps.filter(g => g.y0 <= ya && g.y1 >= yb).sort((a, b) => a.a - b.a);
            if (!open.length) { extrudeAt(ringShape(r - SHELL, r), cx, ya, cz, yb - ya); continue; }
            open.forEach((g, k) => {
                const next = open[(k + 1) % open.length];
                let a0 = g.a + g.half, a1 = next.a - next.half;
                if (a1 <= a0) a1 += Math.PI * 2;
                extrudeAt(sectorShape(r - SHELL, r, a0, a1), cx, ya, cz, yb - ya);
            });
        }
    };
    // marches d'escalier en colimaçon autour de la colonne : des planches fines, d'une hauteur ~0,30
    // (assez basse pour être montée, et le dessous des marches suivantes reste hors des rayons de collision)
    const stepsFor = (y0, y1) => Math.max(1, Math.round((y1 - y0) / STEP_RISE));
    const spiral = (cx, cz, ri, a0, y0, y1) => {
        const n = stepsFor(y0, y1);
        const rise = (y1 - y0) / n;
        for (let k = 1; k <= n; k++) {
            const a = a0 + (k - 1) * DTH;
            extrudeAt(sectorShape(COL - 0.02, ri + 0.03, a, a + DTH + 0.02), cx, y0 + k * rise - STEP_T, cz, STEP_T, 8, stairMat);
        }
        return a0 + n * DTH;
    };
    const doorFrame = (t, y, angle, h) => {
        for (const sd of [-1, 1]) {
            const post = new THREE.Mesh(roundedBox(0.18, h, 0.18, 0.04), plastic('#6b4423', 0.5));
            placeOnTower(post, t.x, t.z, t.r + 0.05, y + h / 2, angle + sd * (0.8 / t.r));
        }
        placeOnTower(new THREE.Mesh(roundedBox(1.8, 0.22, 0.2, 0.05), plastic('#6b4423', 0.5)), t.x, t.z, t.r + 0.05, y + h + 0.05, angle);
    };

    // t = { x, z, r } ; remplit t.top (sommet), t.floor (plancher du haut), t.safe (angle loin de la trémie)
    const tower = (t, H, { vault = false } = {}) => {
        const { x: cx, z: cz, r } = t;
        const yTop = B + H, floorY = yTop - 1.0, ri = r - SHELL;
        const ac = Math.atan2(-cx, -cz);                  // direction de la cour
        const half = 0.75 / ri, wHalf = 0.8 / ri, shift = 0.25 / ri;
        // une porte vers la cour (ou la salle des coffres) et deux portes sur le chemin de ronde
        shell(cx, cz, r, B, floorY, [
            { a: ac, half, y0: B, y1: B + 2.5 },
            { a: ac + Math.PI / 4 - shift, half: wHalf, y0: walkY, y1: walkY + 2.2 },
            { a: ac - Math.PI / 4 + shift, half: wHalf, y0: walkY, y1: walkY + 2.2 },
        ]);
        if (!vault) doorFrame(t, B, ac, 2.5);

        // escalier : arrivée au niveau du chemin de ronde côté extérieur, loin des portes
        const aWalk = ac + 1.3 + OPEN;
        const col = new THREE.Mesh(new THREE.CylinderGeometry(COL, COL, 1, 16), mat);
        const colBottom = vault ? walkY - 0.25 : B;
        col.scale.y = floorY - colBottom;
        col.position.set(cx, (floorY + colBottom) / 2, cz);
        add(col);
        if (vault) {
            extrudeAt(ringShape(0, ri + 0.05), cx, B + VAULT_H, cz, 0.3);                  // plafond de la salle des coffres
            extrudeAt(ringShape(0, ri + 0.05), cx, walkY - 0.25, cz, 0.25);                // plancher du chemin de ronde
        } else {
            const n1 = stepsFor(B, walkY);
            spiral(cx, cz, ri, aWalk - n1 * DTH, B, walkY);
            extrudeAt(sectorShape(0, ri + 0.05, aWalk, aWalk + Math.PI * 2 - OPEN), cx, walkY - 0.25, cz, 0.25);
        }
        const aTop = spiral(cx, cz, ri, aWalk, walkY, floorY);
        extrudeAt(sectorShape(0, ri + 0.05, aTop, aTop + Math.PI * 2 - OPEN_TOP), cx, floorY - 0.3, cz, 0.3);   // terrasse du haut (trémie plus large : pas de porte ici)

        extrudeAt(ringShape(r - 0.1, r + 0.35), cx, yTop - 1.9, cz, 0.35);             // corniche (un anneau : la tour est creuse)
        extrudeAt(ringShape(r - 0.2, r + 0.3), cx, yTop - 1.55, cz, 1.55);            // parapet
        const rm = r + 0.05, n = Math.round(2 * Math.PI * rm / 1.35);
        for (let i = 0; i < n; i++) {
            const a = (i + 0.5) / n * Math.PI * 2;
            toyMerlon(cx + Math.sin(a) * rm, yTop, cz + Math.cos(a) * rm, a, 0.8, 0.85, 0.5);
        }
        t.top = yTop;
        t.floor = floorY;
        t.safe = aTop + Math.PI - OPEN_TOP / 2;
        return yTop;
    };
    return { toyMerlon, merlonRow, bigRock, tower };
}

// ---------------------------------------------------------------- bâtiments de formation dans la cour
// caserne contre le mur du fond (soldats, archers, chevaliers), atelier de siège contre le mur de gauche
// (canons, catapultes), tapis du couronnement au centre. Les positions sont reprises par le serveur.
function courtyardBuildings(castle, { B, mat, team, roof, trim, emblem, border, wood }) {
    const beamMat = plastic('#5b3a1e', 0.6), woodMat = plastic(wood, 0.6), roofMat = plastic(roof, 0.5);
    const box = (w, h, d, x, y, z, m, collide = true) => {
        const b = new THREE.Mesh(roundedBox(w, h, d, Math.min(0.06, w / 3, h / 3, d / 3)), m);
        b.position.set(x, y, z);
        return add(b, { collide });
    };

    // ---- caserne : rez-de-chaussée en pierre, étage à colombages, toit à deux pans aux couleurs du camp
    const BW = 5.2, front = -3.8;
    stoneBox(BW, 2.4, 2.4, 0, B, -5.0, { mat, r: 0.08 });
    box(BW + 0.3, 1.5, 2.7, 0, B + 3.15, -4.95, plastic('#efe6d2', 0.85));
    for (const y of [B + 2.45, B + 3.85]) box(BW + 0.34, 0.16, 0.1, 0, y, -3.58, beamMat, false);
    for (const x of [-2.65, -1.3, 1.3, 2.65]) box(0.16, 1.4, 0.1, x, B + 3.15, -3.58, beamMat, false);
    {
        const sh = new THREE.Shape();
        sh.moveTo(-1.5, 0); sh.lineTo(1.5, 0); sh.lineTo(0, 1.5); sh.lineTo(-1.5, 0);
        const g = new THREE.ExtrudeGeometry(sh, { depth: BW + 0.7, bevelEnabled: false });
        g.rotateY(Math.PI / 2);
        g.translate(-(BW + 0.7) / 2, 0, 0);
        const r = new THREE.Mesh(g, roofMat);
        r.position.set(0, B + 3.9, -4.95);
        add(r);
        box(BW + 0.8, 0.14, 0.14, 0, B + 5.4, -4.95, beamMat, false);              // faîtage
    }
    stoneBox(0.6, 1.5, 0.6, 1.8, B + 4.4, -5.6, { mat, r: 0.06 });                // cheminée
    placeOn(makeWindow(1.3, 1.9, { frame: trim, inner: '#20160e' }), 0, B, front + 0.02);
    for (const s of [-1, 1]) {
        placeOn(makeWindow(0.5, 0.8, { frame: trim, bars: true, inner: '#20160e' }), s * 1.7, B + 0.8, front + 0.02);
        placeOn(makeWindow(0.45, 0.65, { frame: '#5b3a1e', inner: '#2a2018' }), s * 1.97, B + 2.75, -3.55);
    }
    placeOn(paintedShield(emblem, 0.7, 0.85, border), 0, B + 3.15, -3.5);

    // mannequin d'entraînement en paille, avec un écu aux couleurs de l'ennemi
    {
        const g = new THREE.Group();
        const straw = plastic('#d9b45a', 0.9);
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.7, 8), woodMat);
        post.position.y = 0.85;
        const body = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 10), straw);
        body.scale.set(1, 1.4, 0.8); body.position.y = 1.15;
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 8), straw);
        head.position.y = 1.72;
        const arms = new THREE.Mesh(roundedBox(1.1, 0.1, 0.1, 0.03), woodMat);
        arms.position.y = 1.35;
        const target = paintedShield(emblem === 'skull' ? 'blueGold' : 'skull', 0.36, 0.44, '#5b3a1e');
        target.position.set(0, 1.12, 0.26);
        g.add(post, body, head, arms, target);
        g.position.set(-1.9, B, -2.8);
        g.rotation.y = 0.25;
        add(g);
    }

    // ---- atelier de siège : appentis ouvert vers la cour
    const ax = -3.6;
    for (const z of [-2.3, 2.3]) {
        box(0.25, 3.0, 0.25, ax, B + 1.5, z, woodMat);
        box(2.6, 1.3, 0.14, -4.9, B + 0.65, z + Math.sign(z) * 0.1, woodMat);       // murets latéraux
    }
    box(0.3, 0.3, 4.9, ax, B + 3.0, 0, woodMat);
    {
        const r = box(3.3, 0.2, 5.3, -4.85, B + 3.55, 0, roofMat, false);
        r.rotation.z = -0.4;
        for (const z of [-1.8, -0.6, 0.6, 1.8]) {
            const plank = box(3.3, 0.06, 0.08, -4.85, B + 3.67, z, beamMat, false);
            plank.rotation.z = -0.4;
        }
    }
    placeOn(paintedShield(emblem, 0.6, 0.72, border), ax + 0.2, B + 2.85, 0, Math.PI / 2);

    // établi, marteau, rondins, roue de rechange et boulets
    box(0.8, 0.12, 1.8, -5.7, B + 0.9, -1.2, woodMat);
    for (const z of [-1.95, -0.45]) box(0.12, 0.85, 0.12, -5.7, B + 0.43, z, woodMat);
    {
        const hammer = new THREE.Group();
        const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.45, 6), beamMat);
        handle.rotation.z = Math.PI / 2;
        const headM = new THREE.Mesh(roundedBox(0.1, 0.18, 0.1, 0.02), metal('#5a5f66'));
        headM.position.x = 0.22;
        hammer.add(handle, headM);
        hammer.position.set(-5.65, B + 1.0, -1.5);
        hammer.rotation.y = 0.6;
        add(hammer, { collide: false });
    }
    for (const [y, z] of [[0.18, 0], [0.18, 0.38], [0.5, 0.19]]) {
        const log = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 1.3, 10), plastic('#8a5a2b', 0.7));
        log.rotation.z = Math.PI / 2;
        log.position.set(-5.4, B + y, z + 0.1);
        add(log);
    }
    {
        const w = spokedWheel(0.55, wood, COLORS.gold);
        w.position.set(-6.0, B + 0.55, 1.7);
        w.rotation.z = 0.15;
        add(w);
        const ballGeo = new THREE.SphereGeometry(0.22, 16, 12);
        for (const [x, y, z] of [[-0.22, 0, -0.22], [0.22, 0, -0.22], [-0.22, 0, 0.22], [0.22, 0, 0.22], [0, 0.31, 0]]) {
            const b = new THREE.Mesh(ballGeo, metal('#3a3d44'));
            b.position.set(-4.7 + x, B + 0.22 + y, 1.6 + z);
            add(b);
        }
    }

    // ---- tapis du couronnement : c'est là que le roi réapparaît
    const rug = new THREE.Mesh(new THREE.CircleGeometry(1.3, 40), plastic(TEAM[team].main, 0.9));
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(0, B + 0.03, 0.5);
    const edge = new THREE.Mesh(new THREE.RingGeometry(1.2, 1.38, 40), plastic(COLORS.gold, 0.5));
    edge.rotation.x = -Math.PI / 2;
    edge.position.set(0, B + 0.035, 0.5);
    add(rug, { collide: false }); add(edge, { collide: false });
}

// ---------------------------------------------------------------- défenses achetables (visibles selon leur niveau)
// braseros sur les tours avant, chaudron d'huile au-dessus de la porte, barricades devant le pont-levis,
// chapiteau hors les murs. Positions locales reprises par le serveur (TENT, BARRICADE).
const TENT_POS = [-7.5, 17.5], BARRICADE_Z = 14.2;

function stripeTexture(c1, c2, n, vertical = true) {
    return canvasTex(256, 256, (ctx, s) => {
        for (let i = 0; i < n; i++) {
            ctx.fillStyle = i % 2 ? c2 : c1;
            if (vertical) ctx.fillRect(i * s / n, 0, s / n + 1, s);
            else ctx.fillRect(0, i * s / n, s, s / n + 1);
        }
    });
}

// grand chapiteau rayé aux couleurs du camp, porte tournée vers +x (vers la route)
function makeTent(team) {
    const red = team === 'red';
    const [c1, c2] = red ? ['#c41e2a', '#26262c'] : ['#1f5fbf', '#f2c12e'];
    const g = new THREE.Group();
    const cloth = new THREE.MeshStandardMaterial({ map: stripeTexture(c1, c2, 16), roughness: 0.75, side: THREE.DoubleSide });
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.3, 1.8, 40, 1, true), cloth);
    wall.position.y = 0.9;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(2.75, 2.5, 40, 1, true), cloth);
    roof.position.y = 1.8 + 1.25;
    g.add(wall, roof);
    // lambrequin festonné sous le bord du toit
    for (let i = 0; i < 20; i++) {
        const a = i / 20 * Math.PI * 2;
        const v = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.42, 3), plastic(i % 2 ? c2 : c1, 0.6));
        v.position.set(Math.sin(a) * 2.68, 1.62, Math.cos(a) * 2.68);
        v.rotation.set(Math.PI, a, 0);
        g.add(v);
    }
    // mât, boule dorée et fanion au sommet
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.3, 8), metal('#9a7b3a'));
    pole.position.y = 4.6;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), metal(COLORS.gold));
    ball.position.y = 5.3;
    const fg = new THREE.PlaneGeometry(0.95, 0.55, 10, 3);
    fg.translate(0.475, 0, 0);
    const flag = new THREE.Mesh(fg, new THREE.MeshStandardMaterial({ map: heraldry(red ? 'skullFlag' : 'lionFlag'), roughness: 0.6, side: THREE.DoubleSide }));
    flag.position.set(0.05, 4.95, 0);
    flag.userData.base = Float32Array.from(fg.attributes.position.array);
    flag.userData.phase = Math.random() * 6;
    flags.push(flag);
    g.add(pole, ball, flag);
    // entrée ouverte (vers +x) avec ses deux pans relevés
    const door = makeWindow(1.1, 1.55, { frame: COLORS.gold, inner: '#1b130c' });
    door.position.set(2.31, 0, 0);
    door.rotation.y = Math.PI / 2;
    g.add(door);
    for (const s of [-1, 1]) {
        const flap = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 1.4), new THREE.MeshStandardMaterial({ color: c1, roughness: 0.75, side: THREE.DoubleSide }));
        flap.position.set(2.38, 1.0, s * 0.85);
        flap.rotation.set(0, Math.PI / 2 + s * 0.5, s * 0.25);
        g.add(flap);
    }
    // cordes et piquets
    const rope = plastic('#d9c7a0', 0.8), peg = plastic('#6b4423', 0.6);
    for (let i = 0; i < 8; i++) {
        const a = (i + 0.5) / 8 * Math.PI * 2;
        if (Math.abs(Math.sin(a)) > 0.92 && Math.cos(a) > 0) continue;
        const top = new THREE.Vector3(Math.sin(a) * 2.6, 1.85, Math.cos(a) * 2.6);
        const bottom = new THREE.Vector3(Math.sin(a) * 3.7, 0.05, Math.cos(a) * 3.7);
        const d = new THREE.Vector3().subVectors(bottom, top);
        const r = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, d.length(), 4), rope);
        r.position.copy(top).addScaledVector(d, 0.5);
        r.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
        const p = new THREE.Mesh(roundedBox(0.1, 0.25, 0.1, 0.02), peg);
        p.position.copy(bottom).setY(0.12);
        g.add(r, p);
    }
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return g;
}

// chapiteau effondré : la toile à plat et le mât couché
function makeTentRuins(team) {
    const [c1, c2] = team === 'red' ? ['#c41e2a', '#26262c'] : ['#1f5fbf', '#f2c12e'];
    const g = new THREE.Group();
    const cloth = new THREE.Mesh(new THREE.ConeGeometry(2.9, 0.55, 28), new THREE.MeshStandardMaterial({ map: stripeTexture(c1, c2, 16), roughness: 0.8 }));
    cloth.position.y = 0.27;
    cloth.rotation.z = 0.08;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.4, 8), metal('#9a7b3a'));
    pole.rotation.set(0, 0.7, Math.PI / 2 - 0.12);
    pole.position.set(0.9, 0.5, 0.4);
    g.add(cloth, pole);
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return g;
}

// barricades : palissade de pieux en quinconce (niveau 1) + chevaux de frise devant (niveau 2)
function makeBarricades() {
    const level1 = new THREE.Group(), level2 = new THREE.Group();
    const wood = plastic('#8a5a2b', 0.6), dark = plastic('#5e3a1c', 0.6), rope = plastic('#d9c7a0', 0.8);
    const stakeGeo = new THREE.CylinderGeometry(0.12, 0.13, 1.3, 8), tipGeo = new THREE.ConeGeometry(0.12, 0.3, 8);
    const palisade = (x0, x1, z) => {
        for (let x = x0; x <= x1 + 0.01; x += 0.27) {
            const h = 0.9 + Math.random() * 0.3;
            const st = new THREE.Mesh(stakeGeo, wood);
            st.scale.y = h / 1.3;
            st.position.set(x, h / 2, z);
            st.rotation.z = (Math.random() - 0.5) * 0.08;
            const tip = new THREE.Mesh(tipGeo, wood);
            tip.position.set(x, h + 0.15, z);
            level1.add(st, tip);
        }
        for (const y of [0.3, 0.75]) {
            const band = new THREE.Mesh(roundedBox(x1 - x0 + 0.3, 0.08, 0.32, 0.03), dark);
            band.position.set((x0 + x1) / 2, y, z);
            level1.add(band);
        }
    };
    // deux rangées décalées : on devine un passage en zigzag, que seuls les défenseurs connaissent
    palisade(-4.6, -2.2, -0.4); palisade(-0.9, 0.9, -0.4); palisade(2.2, 4.6, -0.4);
    palisade(-2.6, -0.6, 0.45); palisade(0.6, 2.6, 0.45);
    // chevaux de frise : poutres hérissées de pieux en croix
    for (const x of [-3.4, 0, 3.4]) {
        const g = new THREE.Group();
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 2.6, 8), dark);
        beam.rotation.z = Math.PI / 2;
        beam.position.y = 0.55;
        g.add(beam);
        for (let i = 0; i < 6; i++) {
            const bx = -1.1 + i * 0.44;
            for (const s of [-1, 1]) {
                const spike = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 1.4, 6), wood);
                spike.position.set(bx, 0.55, 0);
                spike.rotation.x = s * 0.75;
                const tip = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.2, 6), metal('#9aa0a8'));
                tip.position.set(bx, 0.55 + Math.cos(0.75) * 0.75, s * Math.sin(0.75) * 0.75);
                tip.rotation.x = s * 0.75;
                g.add(spike, tip);
            }
            const knot = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.03, 6, 12), rope);
            knot.rotation.y = Math.PI / 2;
            knot.position.set(bx, 0.55, 0);
            g.add(knot);
        }
        g.position.set(x, 0, 1.4);
        g.rotation.y = (Math.random() - 0.5) * 0.15;
        level2.add(g);
    }
    for (const grp of [level1, level2]) grp.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return { level1, level2 };
}

function makeBrazier() {
    const g = new THREE.Group();
    const iron = metal('#3d4046');
    for (let i = 0; i < 3; i++) {
        const a = i / 3 * Math.PI * 2;
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.95, 6), iron);
        leg.position.set(Math.sin(a) * 0.2, 0.45, Math.cos(a) * 0.2);
        leg.rotation.set(Math.cos(a) * 0.25, 0, -Math.sin(a) * 0.25);
        g.add(leg);
    }
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.22, 0.32, 16), iron);
    bowl.position.y = 1.0;
    const coals = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.05, 16), new THREE.MeshStandardMaterial({ color: '#ff7a1a', emissive: '#ff4a00', emissiveIntensity: 1.6 }));
    coals.position.y = 1.15;
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.8, 14), new THREE.MeshStandardMaterial({ color: '#ffd23a', emissive: '#ff9a1a', emissiveIntensity: 2.4 }));
    flame.position.y = 1.55;
    flames.push(flame);
    g.add(bowl, coals, flame);
    return g;
}

// chaudron d'huile sur le chemin de ronde, avec sa goulotte au-dessus de la porte
function makeCauldron() {
    const g = new THREE.Group();
    const iron = metal('#2e3036');
    for (const s of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.3, 8), plastic('#5e3a1c', 0.6));
        post.position.set(s * 0.65, 0.65, 0);
        g.add(post);
    }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.5, 8), iron);
    bar.rotation.z = Math.PI / 2;
    bar.position.y = 1.25;
    const pot = new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 12, 0, Math.PI * 2, Math.PI * 0.35, Math.PI * 0.65), iron);
    pot.position.y = 0.85;
    const oil = new THREE.Mesh(new THREE.CircleGeometry(0.44, 20), new THREE.MeshStandardMaterial({ color: '#ffb02e', emissive: '#ff7a00', emissiveIntensity: 1.2 }));
    oil.rotation.x = -Math.PI / 2;
    oil.position.y = 1.08;
    const fire = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.45, 12), new THREE.MeshStandardMaterial({ color: '#ffd23a', emissive: '#ff8a1a', emissiveIntensity: 2.2 }));
    fire.position.y = 0.25;
    flames.push(fire);
    const chute = new THREE.Mesh(roundedBox(0.4, 0.08, 1.5, 0.03), iron);
    chute.position.set(0, 0.95, 0.95);
    chute.rotation.x = 0.35;
    g.add(bar, pot, oil, fire, chute);
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; } });
    return g;
}

function defenseProps(castle, { B, C, top, towers, team }) {
    // braseros sur les deux tours avant (tours de garde améliorées)
    const braziers = towers.map(t => {
        const b = makeBrazier();
        const a = t.safe - 1.1;
        b.position.set(t.x + Math.sin(a) * 1.3, t.floor, t.z + Math.cos(a) * 1.3);
        b.visible = false;
        add(b, { collide: false });
        return b;
    });
    const cauldron = makeCauldron();
    cauldron.position.set(0, top, C - 0.45);
    cauldron.visible = false;
    add(cauldron, { collide: false });

    const { level1, level2 } = makeBarricades();
    const barricade = new THREE.Group();
    barricade.add(level1, level2);
    barricade.position.set(0, 0, BARRICADE_Z);
    barricade.visible = false;
    PARENT.add(barricade);

    const tent = makeTent(team), ruins = makeTentRuins(team);
    for (const o of [tent, ruins]) {
        o.position.set(TENT_POS[0], 0, TENT_POS[1]);
        o.visible = false;
        PARENT.add(o);
    }
    castle.tentGroup = tent;
    castle.barricadeGroup = barricade;

    // un objet ne bloque le joueur que s'il est visible (les rayons ne tiennent pas compte de la visibilité)
    const solid = (obj, on) => {
        const i = colliders.indexOf(obj);
        if (on && i < 0) colliders.push(obj);
        if (!on && i >= 0) colliders.splice(i, 1);
    };
    let tentWasUp = false;
    // levels = { towers, oil, barricade, tent } ; blocking = les barricades arrêtent-elles CE joueur ? (celles de l'ennemi)
    castle.setDefense = (levels, blocking) => {
        braziers.forEach(b => { b.visible = levels.towers >= 1; b.scale.setScalar(levels.towers >= 2 ? 1.35 : 1); });
        cauldron.visible = levels.oil >= 1;
        barricade.visible = levels.barricade >= 1;
        level2.visible = levels.barricade >= 2;
        solid(level1, barricade.visible && blocking);
        solid(level2, level2.visible && blocking);
        tent.visible = levels.tent >= 1;
        if (tent.visible) tentWasUp = true;
        ruins.visible = !tent.visible && tentWasUp;
        solid(tent, tent.visible);
    };
    castle.resetDefense = () => { tentWasUp = false; };
}

// ---------------------------------------------------------------- tours de mage (derrière le château)
// positions locales reprises par le serveur (MAGES[...].pos)
const MAGE_POS = { potion: [-6, -15.5], fireball: [6, -15.5], dragon: [0, -17.5] };
const ORB_COLORS = { potion: '#5dff8a', fireball: '#ff7a1a' };

// bannière peinte du sort : fiole, boule de feu ou dragon
function spellBanner(kind, team) {
    const red = team === 'red';
    const tex = canvasTex(256, 320, (ctx, w, h) => {
        ctx.fillStyle = red ? '#2a2a30' : '#1d4fb8'; ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = red ? '#c41e2a' : '#f5c518'; ctx.lineWidth = 14; ctx.strokeRect(10, 10, w - 20, h - 20);
        for (const [x, y] of [[50, 50], [206, 60], [60, 270], [200, 262]]) drawStar(ctx, x, y, 10, red ? '#c41e2a' : '#f5c518');
        if (kind === 'potion') {
            ctx.fillStyle = '#e8f4ff';
            ctx.fillRect(108, 70, 40, 50);
            ctx.beginPath(); ctx.arc(128, 175, 62, 0, 7); ctx.fill();
            ctx.fillStyle = '#3fd46a';
            ctx.beginPath(); ctx.arc(128, 180, 52, 0.1, Math.PI - 0.1); ctx.fill();
            ctx.fillStyle = '#8a5a2b'; ctx.fillRect(104, 58, 48, 18);
            ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.beginPath(); ctx.arc(104, 150, 12, 0, 7); ctx.fill();
        } else if (kind === 'fireball') {
            const g = ctx.createRadialGradient(140, 150, 10, 128, 165, 75);
            g.addColorStop(0, '#fff3a0'); g.addColorStop(0.45, '#ffb52a'); g.addColorStop(1, '#e8401a');
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.moveTo(60, 250); ctx.quadraticCurveTo(40, 110, 128, 70); ctx.quadraticCurveTo(105, 120, 150, 110);
            ctx.quadraticCurveTo(220, 150, 196, 220); ctx.quadraticCurveTo(170, 270, 110, 262); ctx.closePath(); ctx.fill();
        } else {
            drawDragon(ctx, 140, 200, 0.7, red ? { body: '#d42a22', wing: '#f07a2a', belly: '#f2b48a', fire: true }
                : { body: '#2f6fd8', wing: '#efdca0', belly: '#f1dfa6', fire: true });
        }
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.4), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7, side: THREE.DoubleSide }));
    return m;
}

function makeMageTower(kind, team, mat) {
    const red = team === 'red';
    const tall = kind === 'dragon' ? 1.25 : 1;
    const H = 9.5 * tall, R = kind === "dragon" ? 1.25 : 1.05;      // assez hautes pour dépasser des murs vus du champ de bataille
    const g = new THREE.Group();
    const roofColor = red ? '#5a1830' : '#1f4fb0', trim = red ? '#c41e2a' : COLORS.gold;
    const orbColor = ORB_COLORS[kind] || (red ? '#ff3a3a' : '#4aa3ff');
    // socle et fût en pierre
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.5, R + 0.6, 0.6, 28), mat);
    plinth.position.y = 0.3;
    const shaftGeo = new THREE.CylinderGeometry(R, R + 0.15, H, 28);
    const uv = shaftGeo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2 * Math.PI * R / 1.6, uv.getY(i) * H / 1.6);
    const shaft = new THREE.Mesh(shaftGeo, mat);
    shaft.position.y = 0.6 + H / 2;
    g.add(plinth, shaft);
    // balcon doré, petite salle ouverte avec l'orbe magique, chapeau pointu de magicien
    const top = 0.6 + H;
    const balcony = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.45, R + 0.3, 0.3, 28), plastic(trim, 0.4));
    balcony.position.y = top + 0.15;
    g.add(balcony);
    for (let i = 0; i < 4; i++) {
        const a = i / 4 * Math.PI * 2 + Math.PI / 4;
        const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.3, 8), plastic(trim, 0.4));
        pillar.position.set(Math.sin(a) * (R + 0.15), top + 0.95, Math.cos(a) * (R + 0.15));
        g.add(pillar);
    }
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.42 * tall, 20, 14), new THREE.MeshStandardMaterial({
        color: orbColor, emissive: orbColor, emissiveIntensity: 1.6, roughness: 0.2,
    }));
    orb.position.y = top + 0.95;
    g.add(orb);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.75, R + 0.75, 0.14, 32), plastic(roofColor, 0.5));
    brim.position.y = top + 1.65;
    const hat = new THREE.Mesh(new THREE.ConeGeometry(R + 0.55, 3.2 * tall, 32), plastic(roofColor, 0.5));
    hat.position.y = top + 1.72 + 1.6 * tall;
    hat.rotation.z = 0.08;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.5, R + 0.56, 0.3, 32), plastic(trim, 0.4));
    band.position.y = top + 1.88;
    g.add(brim, hat, band);
    // étoiles dorées sur le chapeau
    const starShape = new THREE.Shape();
    for (let i = 0; i < 10; i++) {
        const a = i * Math.PI / 5, r = i % 2 ? 0.45 : 1;
        starShape[i ? 'lineTo' : 'moveTo'](Math.sin(a) * r, Math.cos(a) * r);
    }
    const starGeo = new THREE.ShapeGeometry(starShape);
    for (let i = 0; i < 5; i++) {
        const a = i / 5 * Math.PI * 2 + 0.3, hgt = 0.6 + (i % 3) * 0.7;
        const rr = (R + 0.55) * (1 - hgt / (3.2 * tall)) + 0.02;
        const st = new THREE.Mesh(starGeo, plastic(COLORS.gold, 0.3));
        st.scale.setScalar(0.18);
        st.position.set(Math.sin(a) * rr, top + 1.72 + hgt, Math.cos(a) * rr);
        st.rotation.y = a;
        g.add(st);
    }
    // fenêtres et bannière tournées vers le château (vers +z)
    for (const [y, a] of [[0.6 + H * 0.35, 0.5], [0.6 + H * 0.68, -0.6]]) {
        const w = makeWindow(0.45, 0.8, { frame: trim, inner: '#1b2340' });
        w.position.set(Math.sin(a) * (R + 0.08), y, Math.cos(a) * (R + 0.08));
        w.rotation.y = a;
        g.add(w);
    }
    const banner = spellBanner(kind, team);
    banner.position.set(0, 0.6 + H * 0.52, R + 0.12);
    g.add(banner);
    // l'Invocateur : deux ailes de pierre dorées sur les côtés du chapeau
    if (kind === 'dragon') {
        for (const s of [-1, 1]) {
            const sh = new THREE.Shape();
            sh.moveTo(0, 0); sh.lineTo(1.4, 0.9); sh.lineTo(1.1, 0.35); sh.lineTo(1.5, 0.2); sh.lineTo(1.0, -0.1); sh.lineTo(0, 0);
            const wing = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: 0.08, bevelEnabled: false }), plastic(trim, 0.4));
            wing.position.set(s * (R + 0.3), top + 2.0, 0);
            wing.scale.x = s;
            g.add(wing);
        }
    }
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return { group: g, orb };
}

// les trois tours apparaissent quand elles sont bâties (mage = { potion, fireball, dragon } en booléens)
function mageTowers(castle, { team, mat }) {
    const towers = {};
    for (const kind of Object.keys(MAGE_POS)) {
        const t = makeMageTower(kind, team, mat);
        t.group.position.set(MAGE_POS[kind][0], 0, MAGE_POS[kind][1]);
        t.group.visible = false;
        PARENT.add(t.group);
        towers[kind] = t;
    }
    castle.mageTowers = towers;
    castle.setMages = built => {
        for (const kind of Object.keys(towers)) {
            const g = towers[kind].group, on = !!built[kind];
            if (g.visible === on) continue;
            g.visible = on;
            const i = colliders.indexOf(g);
            if (on && i < 0) colliders.push(g);
            if (!on && i >= 0) colliders.splice(i, 1);
        }
    };
}

// ---------------------------------------------------------------- dragons de guerre (planche de personnages)
// Dragon Royal (Lion) : bleu, ventre crème à plaques, cornes, piques et griffes jaunes, ailes crème à armature bleue
// Dragon des Ombres (Crâne) : corps rouge, tête, dos et dessus de queue noirs, ventre pêche, ailes orange à armature noire
export function makeWarDragon(team) {
    const royal = team === 'blue';
    const C = royal
        ? { body: '#2156d0', head: '#2156d0', back: '#2156d0', spots: '#3b72e8', belly: '#f3e2ad', plates: '#e3cc8a', horn: '#f5c21b',
            spike: '#f5c21b', frame: '#2156d0', membrane: '#f1dfa4', iris: '#2a2a30', claw: '#f5c21b', knob: '#f5c21b', mouth: '#16306e' }
        : { body: '#d8261f', head: '#2b2b31', back: '#2b2b31', spots: '#3a3a42', belly: '#f4b98f', plates: '#e89e72', horn: '#dcc59a',
            spike: '#d8261f', frame: '#2b2b31', membrane: '#f27c25', iris: '#ff8a1a', claw: '#ecdcbc', knob: '#d8261f', mouth: '#7a1410' };
    // plastique brillant façon figurine
    const mats = {};
    const toy = c => (mats[c] ??= new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.25 }));
    const root = new THREE.Group();
    const model = new THREE.Group();
    root.add(model);
    const sph = (r, c, x, y, z, sx = 1, sy = 1, sz = 1, parent = model) => {
        const m = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 22), toy(c));
        m.position.set(x, y, z); m.scale.set(sx, sy, sz);
        parent.add(m);
        return m;
    };
    const cone = (r, h, c, x, y, z, rx = 0, ry = 0, rz = 0, parent = model) => {
        const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 16), toy(c));
        m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
        parent.add(m);
        return m;
    };
    const bone = (a, b, t, c, parent) => {
        const d = new THREE.Vector3().subVectors(b, a);
        const m = new THREE.Mesh(new THREE.CapsuleGeometry(t, Math.max(0.01, d.length() - 2 * t), 6, 12), toy(c));
        m.position.copy(a).addScaledVector(d, 0.5);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
        parent.add(m);
        return m;
    };

    // ---- corps en poire, dos sombre (Ombres), ventre clair à plaques, écailles en relief
    sph(1, C.body, 0, 0, 0, 0.92, 0.86, 1.22);
    sph(0.74, C.body, 0, 0.2, 0.62, 1, 1, 1);                                  // poitrail
    if (!royal) sph(1, C.back, 0, 0.22, -0.08, 0.78, 0.66, 1.12);             // le dos noir des Ombres
    sph(1, C.belly, 0, -0.16, 0.42, 0.7, 0.7, 0.95);
    for (let i = 0; i < 5; i++) {                                              // plaques du ventre
        const th = 0.25 + i * 0.32;
        const plate = new THREE.Mesh(new THREE.TorusGeometry(0.5 - Math.abs(i - 2) * 0.06, 0.035, 6, 24, Math.PI), toy(C.plates));
        plate.position.set(0, -0.16 - Math.sin(th) * 0.62, 0.42 + Math.cos(th) * 0.86);
        plate.rotation.set(th, 0, Math.PI);
        plate.scale.set(1.15, 1, 0.55);
        model.add(plate);
    }
    for (const [x, y, z, r] of [[0.32, 0.58, 0.3, 0.13], [-0.34, 0.55, 0.05, 0.12], [0.38, 0.48, -0.35, 0.11], [-0.3, 0.45, -0.6, 0.12],
        [0.2, 0.62, -0.05, 0.09], [-0.18, 0.66, 0.45, 0.1]]) sph(r, C.spots, x, y, z, 1, 0.55, 1);

    // ---- cou et tête ronde aux grands yeux
    const neck = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 0.55, 8, 16), toy(royal ? C.body : C.head));
    neck.position.set(0, 0.7, 1.05); neck.rotation.x = 0.75;
    model.add(neck);
    sph(0.32, C.belly, 0, 0.55, 1.28, 0.9, 1.25, 0.6);                        // gorge claire
    const head = new THREE.Group();
    head.position.set(0, 1.3, 1.45);
    model.add(head);
    sph(0.66, C.head, 0, 0, 0, 1, 0.92, 0.95, head);                           // crâne
    sph(0.5, C.head, 0, -0.2, 0.5, 0.98, 0.72, 0.95, head);                   // museau
    sph(0.18, C.head, 0, -0.06, 0.92, 1.4, 0.7, 0.6, head);                   // bout du nez
    const smile = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.03, 6, 20, Math.PI * 0.75), toy(C.mouth));
    smile.position.set(0, -0.3, 0.84); smile.rotation.set(0.25, 0, Math.PI + Math.PI * 0.125);
    head.add(smile);
    for (const s of [-1, 1]) {
        sph(0.05, '#141418', 0.12 * s, -0.08, 1.02, 1, 0.8, 1, head);          // naseaux
        sph(0.21, '#ffffff', 0.3 * s, 0.14, 0.46, 0.9, 1.05, 0.7, head);      // grands yeux
        sph(0.14, C.iris, 0.32 * s, 0.14, 0.58, 0.9, 1, 0.6, head);
        sph(0.08, '#0d0d10', 0.33 * s, 0.14, 0.65, 0.9, 1, 0.6, head);
        sph(0.04, '#ffffff', 0.36 * s, 0.21, 0.69, 1, 1, 1, head);              // reflet
        sph(0.11, C.head, 0.3 * s, 0.33, 0.44, 1.6, 0.45, 0.8, head).rotation.z = (royal ? 0.15 : -0.35) * s;  // sourcils (froncés chez les Ombres)
        // cornes recourbées vers l'arrière, en deux morceaux
        const h1 = cone(0.15, 0.42, C.horn, 0.3 * s, 0.52, -0.12, -0.55, 0, -0.35 * s, head);
        cone(0.1, 0.34, C.horn, 0.38 * s, 0.78, -0.33, -1.15, 0, -0.3 * s, head);
        h1.castShadow = true;
        cone(0.13, 0.36, royal ? C.horn : C.body, 0.6 * s, 0.22, -0.08, -0.2, 0, -1.25 * s, head);  // nageoires d'oreille
        sph(0.12, C.head, 0.42 * s, -0.25, 0.2, 1, 0.7, 1, head);              // joues
    }
    for (let i = 0; i < 3; i++) cone(0.09 - i * 0.015, 0.3, royal ? C.spike : C.body, 0, 0.6 - i * 0.08, 0.15 - i * 0.28, -0.4, 0, 0, head);

    // ---- piques du dos
    for (let i = 0; i < 7; i++) {
        const z = 1.0 - i * 0.36, y = 0.82 - Math.max(0, -z) * 0.25 - (i === 0 ? 0.05 : 0);
        cone(0.15 - i * 0.008, 0.38, C.spike, 0, y, z, -0.35);
    }

    // ---- queue effilée, dessus sombre chez les Ombres, pointe en fer de lance
    const tail = new THREE.Group();
    tail.position.set(0, -0.1, -1.1);
    model.add(tail);
    const segs = [];
    let r = 0.42, prev = tail;
    for (let i = 0; i < 7; i++) {
        const seg = new THREE.Group();
        seg.position.z = i ? -r * 1.15 : 0;
        seg.rotation.x = i ? -0.06 : 0;
        prev.add(seg);
        sph(r, C.body, 0, 0, 0, 1, 0.92, 1.3, seg);
        if (!royal) sph(r * 0.86, C.back, 0, r * 0.22, 0, 1, 0.7, 1.32, seg);
        cone(r * 0.32, r * 0.75, C.spike, 0, r * 0.95, 0, -0.3, 0, 0, seg);
        segs.push(seg);
        prev = seg;
        r *= 0.83;
    }
    const spade = new THREE.Mesh(new THREE.OctahedronGeometry(0.34, 0), toy(royal ? C.spike : C.body));
    spade.scale.set(1.05, 0.3, 1.35); spade.position.z = -0.42;
    prev.add(spade);

    // ---- pattes potelées repliées, griffes claires
    for (const [x, z, s, back] of [[0.48, 0.72, 0.27, false], [-0.48, 0.72, 0.27, false], [0.6, -0.55, 0.38, true], [-0.6, -0.55, 0.38, true]]) {
        sph(s, C.body, x, -0.55, z, 0.9, 1.1, 1.05);
        const foot = sph(s * 0.75, C.body, x * 1.05, -0.88, z + (back ? -0.12 : 0.1), 1.05, 0.65, 1.25);
        foot.rotation.x = back ? -0.4 : 0.2;
        for (const c of [-0.1, 0, 0.1]) cone(0.055, 0.17, C.claw, x * 1.05 + c, -0.95, z + (back ? -0.12 : 0.1) + s * 0.85, back ? Math.PI / 2 + 0.4 : Math.PI / 2 - 0.2);
    }

    // ---- ailes : bras, poignet à boule, doigts, membrane festonnée (construites pour chaque côté, sans miroir négatif)
    const wings = [];
    for (const s of [-1, 1]) {
        const pivot = new THREE.Group();
        pivot.position.set(0.5 * s, 0.55, 0.35);
        model.add(pivot);
        const P = (x, y, z) => new THREE.Vector3(x * s, y, z);
        const S0 = P(0, 0, 0), E = P(0.95, 0.28, 0.12), W = P(1.75, 0.45, 0.02);
        const F = [P(3.0, 0.32, -0.3), P(2.75, 0.08, -1.05), P(1.95, -0.02, -1.5), P(1.0, 0.02, -1.25)];
        const BODY = P(0.05, 0, -0.75);
        // membrane : éventail depuis le poignet, avec un creux entre chaque doigt
        const edge = [];
        for (let i = 0; i < F.length; i++) {
            edge.push(F[i]);
            const next = i + 1 < F.length ? F[i + 1] : BODY;
            edge.push(F[i].clone().lerp(next, 0.5).lerp(W, 0.22));             // feston
        }
        edge.push(BODY, S0, E);
        const pos = [];
        for (let i = 0; i < edge.length - 1; i++) pos.push(W.x, W.y, W.z, edge[i].x, edge[i].y, edge[i].z, edge[i + 1].x, edge[i + 1].y, edge[i + 1].z);
        pos.push(W.x, W.y, W.z, E.x, E.y, E.z, F[0].x, F[0].y, F[0].z);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.computeVertexNormals();
        const membrane = new THREE.Mesh(g, new THREE.MeshPhysicalMaterial({ color: C.membrane, roughness: 0.45, clearcoat: 0.3, side: THREE.DoubleSide }));
        pivot.add(membrane);
        bone(S0, E, 0.12, C.frame, pivot);
        bone(E, W, 0.1, C.frame, pivot);
        for (const f of F) bone(W, f, 0.055, C.frame, pivot);
        sph(0.13, C.frame, E.x, E.y, E.z, 1, 1, 1, pivot);
        sph(0.17, C.knob, W.x, W.y, W.z, 1, 1, 1, pivot);                     // la boule au poignet
        cone(0.08, 0.28, C.claw, W.x + 0.12 * s, W.y + 0.16, W.z + 0.1, -0.4, 0, -0.7 * s, pivot);
        wings.push(pivot);
    }

    const mouth = new THREE.Object3D();
    mouth.position.set(0, -0.3, 0.95);
    head.add(mouth);
    root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    root.scale.setScalar(1.35);
    return { root, model, wings, tail: segs, head, mouth, phase: Math.random() * 6 };
}

export function buildToyCastle(team) {
    const group = new THREE.Group();
    const outerParent = PARENT;
    PARENT.add(group);
    PARENT = group;
    const castle = { team, group, merlons: [], chains: [], fallen: 0, figures: [] };
    CUR = castle;

    const B = 1;                 // dessus du socle
    const WALL_H = 6.4;          // hauteur des courtines -> dessus à y = 7.4
    const WT = 1.6;              // épaisseur des murs (on peut marcher dessus)
    const C = 7;                 // les murs passent par x/z = ±7, les tours sont aux coins
    const mat = toyStone;
    const rockMat = new THREE.MeshStandardMaterial({ color: '#1f9e3c', roughness: 0.45, flatShading: true, envMapIntensity: 0.5 });
    const stairWood = plastic('#a0693a', 0.6);   // même bois brun que le pont-levis
    const { merlonRow, bigRock, tower } = toyKit(castle, mat, rockMat, B, WALL_H, stairWood);

    // ------------------------------------------------ socle vert rocheux (encoche pour le pont-levis)
    notchedBase(11.6, 11.1, '#2fae47');

    const HX = 11.6, HZ = 11.1;
    for (let x = -HX + 1.2; x <= HX - 1.2; x += 1.25) {
        if (Math.abs(x) > 3.2) bigRock(x, 0.6, HZ + 0.2, 1.2 + Math.random() * 0.7, 0.85);
        bigRock(x, 0.6, -HZ - 0.2, 1.2 + Math.random() * 0.7, 0.85);
    }
    for (let z = -HZ + 1.2; z <= HZ - 1.2; z += 1.25) {
        bigRock(-HX - 0.2, 0.6, z, 1.2 + Math.random() * 0.7, 0.85);
        bigRock(HX + 0.2, 0.6, z, 1.2 + Math.random() * 0.7, 0.85);
    }
    // rochers qui remontent contre le pied des tours
    for (const [cx, cz] of [[-C, C], [C, C], [-C, -C], [C, -C]]) {
        for (let i = 0; i < 7; i++) {
            const a = Math.atan2(cx, cz) + (Math.random() - 0.5) * 2.2;
            const r = 4.0 + Math.random() * 0.9;            // assez loin pour ne pas traverser la tour creuse
            const x = cx + Math.sin(a) * r, z = cz + Math.cos(a) * r;
            if (z > C && Math.abs(x) < 3.2) continue;
            bigRock(x, 1.0 + Math.random() * 0.4, z, 0.8 + Math.random() * 0.25, 0.9);
        }
    }
    // petites bosses sur le plateau, hors de la cour et du passage devant la porte
    for (let i = 0; i < 40; i++) {
        const x = (Math.random() * 2 - 1) * 10.6, z = (Math.random() * 2 - 1) * 10.2;
        const outside = Math.abs(x) > C + 1.2 || Math.abs(z) > C + 1.2;
        const inFront = z > C && Math.abs(x) < 3.2;
        const nearTower = Math.hypot(Math.abs(x) - C, Math.abs(z) - C) < 3.8;   // les tours sont creuses
        if (outside && !inFront && !nearTower) bigRock(x, 1.0, z, 0.35 + Math.random() * 0.4, 0.5);
    }

    // dallage rouge de la cour (couleur du Crâne)
    {
        const pave = makeCanvas(256, (ctx, s) => {
            ctx.fillStyle = '#5e1016'; ctx.fillRect(0, 0, s, s);
            for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
                const v = Math.random() * 22;
                ctx.fillStyle = `rgb(${178 + v},${32 + v * 0.4},${40 + v * 0.4})`;
                ctx.beginPath(); ctx.roundRect(x * 64 + 3 + (y % 2) * 10, y * 64 + 3, 58, 58, 10); ctx.fill();
            }
        });
        const t = new THREE.CanvasTexture(pave);
        t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(5, 5);
        const floor = new THREE.Mesh(new THREE.PlaneGeometry(12.4, 12.4), new THREE.MeshStandardMaterial({ map: t, roughness: 0.4 }));
        floor.rotation.x = -Math.PI / 2;
        floor.position.y = B + 0.01;
        add(floor, { collide: false });
    }

    // ------------------------------------------------ courtines
    const wall = (w, h, d, x, y, z) => stoneBox(w, h, d, x, y, z, { mat, r: 0.1 });
    const top = B + WALL_H;
    // les courtines s'arrêtent dans l'épaisseur des tours (creuses) : le chemin de ronde passe par leurs portes
    const FL = { x: -C, z: C, r: 2.6 }, FR = { x: C, z: C, r: 3.0 }, BL = { x: -C, z: -C, r: 2.6 }, BR = { x: C, z: -C, r: 2.6 };
    const wallX = (z, t0, t1) => { const x0 = t0.x + t0.r - 0.25, x1 = t1.x - t1.r + 0.25; wall(x1 - x0, WALL_H, WT, (x0 + x1) / 2, B, z); };
    const wallZ = (x, t0, t1) => { const z0 = t0.z + t0.r - 0.25, z1 = t1.z - t1.r + 0.25; wall(WT, WALL_H, z1 - z0, x, B, (z0 + z1) / 2); };
    wallZ(-C, BL, FL);                                    // gauche
    wallZ(C, BR, FR);                                     // droite
    wallX(-C, BL, BR);                                    // fond
    {
        const x0 = FL.x + FL.r - 0.25, x1 = FR.x - FR.r + 0.25;
        wall(-1.5 - x0, WALL_H, WT, (x0 - 1.5) / 2, B, C);   // façade, à gauche de la porte
        wall(x1 - 1.5, WALL_H, WT, (x1 + 1.5) / 2, B, C);    // façade, à droite
    }
    wall(3.0, WALL_H - 4.5, WT, 0, B + 4.5, C);           // au-dessus de l'arche
    // remplissage autour de l'arc de la porte
    {
        const s = new THREE.Shape();
        s.moveTo(1.5, 3.0);
        s.absarc(0, 3.0, 1.5, 0, Math.PI, false);
        s.lineTo(-1.5, 4.55);
        s.lineTo(1.5, 4.55);
        s.lineTo(1.5, 3.0);
        const geo = new THREE.ExtrudeGeometry(s, { depth: WT, bevelEnabled: false, curveSegments: 20 });
        const m = new THREE.Mesh(geo, mat);
        m.position.set(0, B, C - WT / 2);
        add(m);
    }
    // corniche sous les créneaux (face extérieure)
    stoneBox(0.3, 0.35, 8.8, -C - WT / 2 - 0.1, top - 0.35, 0, { mat, r: 0.08, collide: false });
    stoneBox(0.3, 0.35, 8.8, C + WT / 2 + 0.1, top - 0.35, 0, { mat, r: 0.08, collide: false });
    stoneBox(8.8, 0.35, 0.3, 0, top - 0.35, -C - WT / 2 - 0.1, { mat, r: 0.08, collide: false });
    stoneBox(8.8, 0.35, 0.3, 0, top - 0.35, C + WT / 2 + 0.1, { mat, r: 0.08, collide: false });
    // créneaux sur le bord extérieur des murs
    const edge = C + WT / 2 - 0.25;
    merlonRow(-4.2, edge, 3.9, edge, top);
    merlonRow(-4.2, -edge, 4.2, -edge, top);
    merlonRow(-edge, -4.2, -edge, 4.2, top);
    merlonRow(edge, -4.2, edge, 4.2, top);

    // ------------------------------------------------ tours rondes
    // toutes les tours sont creuses, avec un escalier en colimaçon jusqu'à la terrasse
    tower(FL, 10);
    tower(FR, 14);
    tower(BL, 11.5);
    tower(BR, 10.5, { vault: true });
    addVault(castle, { cx: BR.x, cz: BR.z, r: BR.r, angle: Math.atan2(-BR.x, -BR.z), B, team });

    const onTower = (obj, t, y, a) => placeOnTower(obj, t.x, t.z, t.r + 0.04, y, a);
    const stoneFrame = '#8b9096';

    // tour avant droite (la grande) : 3 blasons au crâne, fenêtre haute, herse en bois au pied
    // (uniquement les armes du Crâne : plus aucun lion sur ce château)
    onTower(paintedShield('skullBlack', 1.0, 1.2, '#c41e2a'), FR, B + 11.0, -0.5);
    onTower(paintedShield('skull', 1.0, 1.2, '#1f1f24'), FR, B + 11.0, 0);
    onTower(paintedShield('skullRed', 1.0, 1.2, '#1f1f24'), FR, B + 11.0, 0.5);
    onTower(makeWindow(0.8, 2.0, { frame: stoneFrame }), FR, B + 6.5, 0.55);
    onTower(makeWindow(1.7, 2.7, { frame: stoneFrame, bars: true, barColor: '#8a5a2b', barStep: 6, inner: '#24180e' }), FR, B + 0.02, 0.3);
    onTower(makeWindow(0.7, 1.6, { frame: stoneFrame }), FR, B + 8, Math.PI / 2 + 0.3);
    onTower(paintedShield('skullRed', 1.0, 1.2, '#1f1f24'), FR, B + 11.0, Math.PI / 2 + 0.4);

    // tour avant gauche
    onTower(paintedShield('skull', 1.0, 1.2, '#1f1f24'), FL, B + 5.9, 0.05);
    onTower(paintedShield('skullBlack', 1.0, 1.2, '#c41e2a'), FL, B + 5.9, -0.75);
    onTower(makeWindow(0.9, 1.6, { frame: stoneFrame }), FL, B + 2.6, -0.35);
    onTower(makeWindow(0.6, 1.1, { frame: stoneFrame }), FL, B + 4.4, -1.35);

    // tours arrière
    onTower(paintedShield('skullRed', 1.0, 1.2, '#1f1f24'), BL, B + 7.9, -0.9);
    onTower(paintedShield('skull', 1.0, 1.2, '#1f1f24'), BL, B + 7.9, -1.8);
    onTower(makeWindow(0.6, 1.3, { frame: stoneFrame }), BL, B + 4.5, -1.4);
    onTower(paintedShield('skullBlack', 1.0, 1.2, '#c41e2a'), BR, B + 6.4, Math.PI / 2 + 0.6);
    onTower(makeWindow(0.6, 1.3, { frame: stoneFrame }), BR, B + 4, Math.PI / 2 + 1.2);

    // bannières suspendues : façade de part et d'autre de la porte, et mur du fond côté cour
    for (const s of [-1, 1]) {
        placeOn(wallBanner(s < 0 ? 'skullBlack' : 'skullRed', 1.1, 2.6, '#2a2a30'), s * 3.6, B + 5.6, C + WT / 2 + 0.02);
        placeOn(wallBanner('skullFlag', 1.2, 2.8, '#2a2a30'), s * 2.4, B + 5.4, -C + WT / 2 + 0.02);
    }
    // torches en fer noir et rouge devant l'entrée
    for (const s of [-1, 1]) gateTorch(s * 2.6, B + 2.6, C + WT / 2 + 0.15, '#2a2a30', '#c41e2a');

    // bannières noir et rouge du Crâne
    makeFlag(FR.x + 1.9, FR.top + 0.2, FR.z + 1.9, '#000', { map: paintedFlag('skullFlag'), pole: '#2a2a30' });
    makeFlag(BL.x - 1.6, BL.top + 0.2, BL.z - 1.6, '#000', { map: paintedFlag('skullFlag'), pole: '#2a2a30' });

    // ------------------------------------------------ la porte d'entrée
    // encadrement en arc
    {
        const outer = archShape(new THREE.Shape(), 3.0, 4.5, 0.35);
        outer.holes.push(archShape(new THREE.Path(), 3.0, 4.5));
        const geo = new THREE.ExtrudeGeometry(outer, { depth: 0.2, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 2, curveSegments: 20 });
        const m = new THREE.Mesh(geo, plastic('#9a9fa5', 0.45));
        m.position.set(0, B, C + WT / 2 - 0.02);
        add(m, { collide: false });
    }
    // grille noire dans l'arc au-dessus des battants
    {
        const bar = new THREE.CylinderGeometry(0.05, 0.05, 1, 8);
        const bm = metal('#1e1f24');
        const z = C + WT / 2 - 0.35;
        for (const x of [-1.05, -0.5, 0, 0.5, 1.05]) {
            const hgt = Math.sqrt(1.5 * 1.5 - x * x);
            const b = new THREE.Mesh(bar, bm);
            b.scale.y = hgt; b.position.set(x, B + 3.0 + hgt / 2, z);
            add(b, { collide: false });
        }
        for (const y of [0.05, 0.6, 1.1]) {
            const half = Math.sqrt(1.5 * 1.5 - y * y);
            const b = new THREE.Mesh(bar, bm);
            b.scale.y = half * 2; b.rotation.z = Math.PI / 2; b.position.set(0, B + 3.0 + y, z);
            add(b, { collide: false });
        }
    }
    // pont-levis en bois cerclé de fer, avec ses chaînes
    addDrawbridge(castle, { z: C + WT / 2 + 0.15, B, L: 4.6 });

    // plaque en bois aux épées croisées au-dessus de la porte
    {
        const plaque = new THREE.Group();
        const board = new THREE.Mesh(roundedBox(3.6, 1.1, 0.18, 0.06), plastic('#7d4a26', 0.5));
        const inner = new THREE.Mesh(roundedBox(3.2, 0.8, 0.06, 0.04), plastic('#9a5f33', 0.5));
        inner.position.z = 0.1;
        plaque.add(board, inner);
        for (const s of [-1, 1]) {
            const sword = new THREE.Group();
            const blade = new THREE.Mesh(roundedBox(0.08, 1.3, 0.05, 0.02), plastic('#6a3c1e', 0.45));
            const guard = new THREE.Mesh(roundedBox(0.34, 0.07, 0.06, 0.02), plastic('#6a3c1e', 0.45));
            guard.position.y = -0.38;
            const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), plastic('#6a3c1e', 0.45));
            pommel.position.y = -0.62;
            sword.add(blade, guard, pommel);
            sword.rotation.z = s * 0.95;
            sword.position.z = 0.15;
            plaque.add(sword);
        }
        const crest = paintedShield('skull', 0.5, 0.6, '#1f1f24');    // petit écu au crâne sur les épées
        crest.position.z = 0.22;
        plaque.add(crest);
        plaque.position.set(0, B + 5.55, C + WT / 2 + 0.1);
        add(plaque, { collide: false });
    }

    // ------------------------------------------------ dans la cour
    const guard = makeUnitModel('knight', team);
    guard.root.position.set(FR.x + Math.sin(FR.safe) * 1.2, FR.floor, FR.z + Math.cos(FR.safe) * 1.2);
    add(guard.root);
    castle.figures.push(guard);
    courtyardBuildings(castle, { B, mat, team, roof: '#a3171d', trim: stoneFrame, emblem: 'skull', border: '#1f1f24', wood: '#5a3a22' });
    add(courtyardProps(5.0, B, 0, -Math.PI / 2, { band: '#1e1f24', wood: '#6a4224', banner: 'skull' }));

    defenseProps(castle, { B, C, top, towers: [FL, FR], team });
    mageTowers(castle, { team, mat });

    castle.merlons.sort(() => Math.random() - 0.5);
    for (const m of castle.merlons) m.userData.home = { parent: m.parent, pos: m.position.clone(), rot: m.rotation.clone() };

    PARENT = outerParent;
    CUR = null;
    return castle;
}

// =====================================================================
//  LE CHÂTEAU "LION" (2e jouet des photos : pierre couleur sable,
//  tête de lion au-dessus de la porte, cour bleue, pont-levis en bois)
// =====================================================================

function paintedFlag(kind) {
    const src = heraldry(kind).image;
    const c = makeCanvas(256, ctx => ctx.drawImage(src, 0, 0, 256, 256));
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}
function makeLionHead() {
    const g = new THREE.Group();
    const mane = plastic('#d8ab6f', 0.55), face = plastic('#e6c592', 0.5), dark = plastic('#2a2018', 0.4), nose = plastic('#c99a62', 0.5);
    const sph = new THREE.SphereGeometry(1, 20, 14);
    const part = (m, x, y, z, sx, sy, sz) => { const p = new THREE.Mesh(sph, m); p.position.set(x, y, z); p.scale.set(sx, sy, sz); g.add(p); return p; };
    // crinière en touffes tout autour
    for (let i = 0; i < 14; i++) {
        const a = i / 14 * Math.PI * 2;
        const tuft = part(mane, Math.cos(a) * 1.2, Math.sin(a) * 1.25, 0, 0.55, 0.55, 0.45);
        tuft.rotation.z = a;
    }
    part(face, 0, 0, 0.25, 1.0, 1.08, 0.6);              // visage
    for (const s of [-1, 1]) {
        const eye = part(dark, 0.36 * s, 0.2, 0.72, 0.24, 0.13, 0.1);  // yeux en amande, l'air sévère
        eye.rotation.z = 0.25 * s;
        const brow = new THREE.Mesh(roundedBox(0.55, 0.16, 0.2, 0.06), face);
        brow.position.set(0.36 * s, 0.42, 0.68);
        brow.rotation.z = -0.25 * s;
        g.add(brow);
        part(face, 0.24 * s, -0.42, 0.68, 0.32, 0.26, 0.22); // babines
        part(face, 0.75 * s, 0.85, 0.05, 0.28, 0.28, 0.2);   // oreilles
    }
    part(nose, 0, -0.12, 0.82, 0.3, 0.22, 0.18);           // truffe
    part(face, 0, -0.75, 0.55, 0.3, 0.2, 0.2);             // menton
    for (const s of [-1, 1]) {
        const mouth = new THREE.Mesh(roundedBox(0.3, 0.05, 0.05, 0.02), dark);
        mouth.position.set(0.13 * s, -0.6, 0.8);
        mouth.rotation.z = 0.25 * s;
        g.add(mouth);
    }
    return g;
}

export function buildLionCastle(team) {
    const group = new THREE.Group();
    const outerParent = PARENT;
    PARENT.add(group);
    PARENT = group;
    const castle = { team, group, merlons: [], chains: [], fallen: 0, figures: [] };
    CUR = castle;

    const B = 1, WALL_H = 6.4, FRONT_H = 8.2, WT = 1.6, C = 7;
    const mat = sandStone;
    const rockMat = new THREE.MeshStandardMaterial({ color: '#1e9c3a', roughness: 0.4, flatShading: true, envMapIntensity: 0.5 });
    const stairWood = plastic('#a0693a', 0.6);   // même bois brun que le pont-levis (comme l'autre château)
    const { merlonRow, bigRock, tower } = toyKit(castle, mat, rockMat, B, WALL_H, stairWood);

    // ------------------------------------------------ socle vert avec une encoche pour le pont-levis
    notchedBase(11.3, 10.8, '#22a63f');
    // rochers verticaux, plus pointus que sur l'autre château
    const HX = 11.6, HZ = 11.1;
    for (let x = -HX + 1.0; x <= HX - 1.0; x += 1.05) {
        if (Math.abs(x) > 3.0) bigRock(x, 0.7, HZ + 0.2, 0.85 + Math.random() * 0.5, 1.5);
        bigRock(x, 0.7, -HZ - 0.2, 0.85 + Math.random() * 0.5, 1.5);
    }
    for (let z = -HZ + 1.0; z <= HZ - 1.0; z += 1.05) {
        bigRock(-HX - 0.2, 0.7, z, 0.85 + Math.random() * 0.5, 1.5);
        bigRock(HX + 0.2, 0.7, z, 0.85 + Math.random() * 0.5, 1.5);
    }
    for (const [cx, cz] of [[-C, C], [C, C], [-C, -C], [C, -C]]) {
        for (let i = 0; i < 6; i++) {
            const a = Math.atan2(cx, cz) + (Math.random() - 0.5) * 2.2;
            const r = 4.0 + Math.random() * 0.9;            // assez loin pour ne pas traverser la tour creuse
            const x = cx + Math.sin(a) * r, z = cz + Math.cos(a) * r;
            if (z > C && Math.abs(x) < 3.2) continue;
            bigRock(x, 1.1, z, 0.75 + Math.random() * 0.25, 1.4);
        }
    }

    // cour bleue à motif en losanges (couleur du Lion), petits clous dorés aux croisements
    {
        const tex = makeCanvas(256, (ctx, s) => {
            ctx.fillStyle = '#1f5fbf'; ctx.fillRect(0, 0, s, s);
            ctx.strokeStyle = '#123f85'; ctx.lineWidth = 6;
            for (let i = -s; i <= s; i += 64) {
                ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + s, s); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(i + s, 0); ctx.lineTo(i, s); ctx.stroke();
            }
            ctx.fillStyle = '#e8b923';
            for (let y = 0; y <= s; y += 32) for (let x = (y / 32) % 2 ? 32 : 0; x <= s; x += 64) {
                ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill();
            }
        });
        const t = new THREE.CanvasTexture(tex);
        t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(3, 3);
        const floor = new THREE.Mesh(new THREE.PlaneGeometry(12.4, 12.4), new THREE.MeshStandardMaterial({ map: t, roughness: 0.4 }));
        floor.rotation.x = -Math.PI / 2;
        floor.position.y = B + 0.01;
        add(floor, { collide: false });
    }

    // ------------------------------------------------ courtines
    const wall = (w, h, d, x, y, z) => stoneBox(w, h, d, x, y, z, { mat, r: 0.1 });
    const top = B + WALL_H, frontTop = B + FRONT_H;
    const FL = { x: -C, z: C, r: 2.6 }, FR = { x: C, z: C, r: 3.0 }, BL = { x: -C, z: -C, r: 2.0 }, BR = { x: C, z: -C, r: 2.6 };
    const wallX = (z, t0, t1) => { const x0 = t0.x + t0.r - 0.25, x1 = t1.x - t1.r + 0.25; wall(x1 - x0, WALL_H, WT, (x0 + x1) / 2, B, z); };
    const wallZ = (x, t0, t1) => { const z0 = t0.z + t0.r - 0.25, z1 = t1.z - t1.r + 0.25; wall(WT, WALL_H, z1 - z0, x, B, (z0 + z1) / 2); };
    wallZ(-C, BL, FL);
    wallZ(C, BR, FR);
    wallX(-C, BL, BR);
    // façade : le chemin de ronde passe à hauteur normale, derrière un haut parapet (corps de garde à tête de lion)
    const hw = 1.5, archC = 2.1, archTop = archC + hw;
    const fx0 = FL.x + FL.r - 0.25, fx1 = FR.x - FR.r + 0.25;
    wall(-hw - fx0, WALL_H, WT, (fx0 - hw) / 2, B, C);
    wall(fx1 - hw, WALL_H, WT, (fx1 + hw) / 2, B, C);
    wall(2 * hw, WALL_H - archTop, WT, 0, B + archTop, C);
    wall(fx1 - fx0, FRONT_H - WALL_H, 0.6, (fx0 + fx1) / 2, B + WALL_H, C + WT / 2 - 0.3);
    {
        const s = new THREE.Shape();
        s.moveTo(hw, archC);
        s.absarc(0, archC, hw, 0, Math.PI, false);
        s.lineTo(-hw, archTop + 0.05);
        s.lineTo(hw, archTop + 0.05);
        s.lineTo(hw, archC);
        const geo = new THREE.ExtrudeGeometry(s, { depth: WT, bevelEnabled: false, curveSegments: 20 });
        const m = new THREE.Mesh(geo, mat);
        m.position.set(0, B, C - WT / 2);
        add(m);
    }
    for (const [w, d, x, z] of [[0.3, 8.8, -C - WT / 2 - 0.1, 0], [0.3, 8.8, C + WT / 2 + 0.1, 0], [8.8, 0.3, 0, -C - WT / 2 - 0.1]]) {
        stoneBox(w, 0.35, d, x, top - 0.35, z, { mat, r: 0.08, collide: false });
    }
    stoneBox(fx1 - fx0, 0.35, 0.3, (fx0 + fx1) / 2, frontTop - 0.35, C + WT / 2 + 0.1, { mat, r: 0.08, collide: false });
    const edge = C + WT / 2 - 0.25;
    merlonRow(-4.2, edge, 3.9, edge, frontTop);
    merlonRow(-4.2, -edge, 4.2, -edge, top);
    merlonRow(-edge, -4.2, -edge, 4.2, top);
    merlonRow(edge, -4.2, edge, 4.2, top);

    // ------------------------------------------------ tours (la fine et haute derrière à gauche)
    tower(FL, 10);
    tower(FR, 11);
    tower(BL, 15);
    tower(BR, 10, { vault: true });
    addVault(castle, { cx: BR.x, cz: BR.z, r: BR.r, angle: Math.atan2(-BR.x, -BR.z), B, team });
    const onTower = (obj, t, y, a) => placeOnTower(obj, t.x, t.z, t.r + 0.04, y, a);
    const relief = '#d9b480';

    onTower(paintedShield('blueGold', 0.9, 1.1, '#e8b923'), FL, B + 4.6, -0.4);
    onTower(paintedShield('quarter', 0.9, 1.1, '#e8b923'), FR, B + 8.2, 0.1);
    onTower(paintedShield('blueWhite', 0.8, 1.0, '#e8b923'), BL, B + 11.5, -1.2);
    onTower(makeWindow(0.8, 1.1, { frame: relief, bars: true, barColor: '#3a2a1a', barStep: 4, inner: '#2a2018' }), FL, B + 1.6, -0.55);
    onTower(makeWindow(0.5, 1.4, { frame: relief, inner: '#2a2018' }), FL, B + 5.2, -1.4);
    onTower(makeWindow(0.7, 2.0, { frame: relief, inner: '#c9a36e' }), FR, B + 5.2, 0.55);   // niche sculptée
    onTower(makeWindow(0.5, 1.3, { frame: relief, inner: '#2a2018' }), FR, B + 2.2, 1.3);
    {
        const tag = new THREE.Mesh(roundedBox(1.0, 0.18, 0.1, 0.04), plastic(COLORS.gold));
        onTower(tag, FR, B + 8.1, 0.95);
    }
    onTower(makeWindow(0.5, 1.4, { frame: relief, inner: '#2a2018' }), BL, B + 9, -0.8);
    onTower(makeWindow(0.5, 1.4, { frame: relief, inner: '#2a2018' }), BL, B + 4.5, -1.6);
    onTower(makeWindow(0.5, 1.3, { frame: relief, inner: '#2a2018' }), BR, B + 4.2, Math.PI / 2 + 0.5);
    for (const z of [-3, 3]) {
        placeOn(makeWindow(0.45, 0.9, { frame: relief, inner: '#2a2018' }), -C - WT / 2 - 0.01, B + 4.6, z, -Math.PI / 2);
        placeOn(makeWindow(0.45, 0.9, { frame: relief, inner: '#2a2018' }), C + WT / 2 + 0.01, B + 4.6, z, Math.PI / 2);
    }
    for (const x of [-3, 0, 3]) placeOn(makeWindow(0.45, 0.9, { frame: relief, inner: '#2a2018' }), x, B + 4.6, -C - WT / 2 - 0.01, Math.PI);
    makeFlag(FR.x + 1.6, FR.top + 0.2, FR.z + 1.6, '#1f5fbf', { map: paintedFlag('quarter'), pole: '#123f85' });
    makeFlag(BL.x, BL.top + 0.2, BL.z, '#1f5fbf', { map: paintedFlag('lionFlag'), pole: '#123f85' });

    // bannières bleu et or : façade de part et d'autre de la porte, et mur du fond côté cour
    for (const s of [-1, 1]) {
        placeOn(wallBanner(s < 0 ? 'lionFlag' : 'blueGold', 1.1, 2.6), s * 3.6, B + 5.6, C + WT / 2 + 0.02);
        placeOn(wallBanner('quarter', 1.2, 2.8), s * 2.4, B + 5.4, -C + WT / 2 + 0.02);
    }

    // ------------------------------------------------ l'entrée : rayons de pierre, tête de lion, torches
    const front = C + WT / 2;
    for (let i = 0; i < 11; i++) {
        const a = Math.PI * (i + 0.5) / 11;
        const v = new THREE.Mesh(roundedBox(0.55, 1.0, 0.3, 0.08), plastic(i % 2 ? '#dcb987' : '#e3c495', 0.5));
        v.position.set(Math.cos(a) * (hw + 0.5), B + archC + Math.sin(a) * (hw + 0.5), front + 0.1);
        v.rotation.z = a - Math.PI / 2;
        add(v, { collide: false });
    }
    for (const s of [-1, 1]) {
        const jamb = new THREE.Mesh(roundedBox(0.5, archC, 0.3, 0.08), plastic('#dcb987', 0.5));
        jamb.position.set(s * (hw + 0.25), B + archC / 2, front + 0.1);
        add(jamb, { collide: false });
    }
    const lion = makeLionHead();
    lion.position.set(0, B + 6.0, front + 0.2);
    lion.scale.setScalar(1.15);
    add(lion, { collide: false });

    // torches bleu et or (aux couleurs du Lion)
    for (const s of [-1, 1]) gateTorch(s * 2.6, B + 2.6, front + 0.15, '#123f85', COLORS.gold);

    // ------------------------------------------------ pont-levis : le même qu'au château du Crâne (bois cerclé de fer, chaînes)
    addDrawbridge(castle, { z: front + 0.15, B, L: 4.2 });

    // ------------------------------------------------ habitants
    const guard = makeUnitModel('knight', team);
    guard.root.position.set(FR.x + Math.sin(FR.safe) * 1.2, FR.floor, FR.z + Math.cos(FR.safe) * 1.2);
    add(guard.root);
    castle.figures.push(guard);
    courtyardBuildings(castle, { B, mat, team, roof: '#1f5fbf', trim: relief, emblem: 'blueGold', border: '#e8b923', wood: '#8a5a2b' });
    add(courtyardProps(5.0, B, 0, -Math.PI / 2, { banner: 'blueGold' }));

    defenseProps(castle, { B, C, top, towers: [FL, FR], team });
    mageTowers(castle, { team, mat });

    castle.merlons.sort(() => Math.random() - 0.5);
    for (const m of castle.merlons) m.userData.home = { parent: m.parent, pos: m.position.clone(), rot: m.rotation.clone() };

    PARENT = outerParent;
    CUR = null;
    return castle;
}

// =====================================================================
//  Sons et musique, entièrement synthétisés (Web Audio API) : aucun fichier audio à charger.
//  - bruitages de bataille, atténués selon la distance à la caméra
//  - musique de boîte à musique médiévale en boucle (+ tambour pendant les batailles)
//  - réglages « sons » et « musique » mémorisés dans le navigateur
// =====================================================================

let ctx = null, master, sfxBus, musicBus, noise = null;
const listener = { x: 0, y: 0, z: 0 };

const prefs = { sfx: true, music: true };
try {
    const saved = JSON.parse(localStorage.getItem('deuxCouronnes.audio') || '{}');
    if (typeof saved.sfx === 'boolean') prefs.sfx = saved.sfx;
    if (typeof saved.music === 'boolean') prefs.music = saved.music;
} catch { /* stockage indisponible : réglages par défaut */ }
function savePrefs() {
    try { localStorage.setItem('deuxCouronnes.audio', JSON.stringify(prefs)); } catch { /* tant pis */ }
}

// le navigateur n'autorise le son qu'après un geste du joueur : on démarre au premier clic ou touche
export function unlockAudio() {
    if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        const comp = ctx.createDynamicsCompressor();             // évite la saturation quand tout explose en même temps
        comp.threshold.value = -14; comp.ratio.value = 4;
        master = ctx.createGain(); master.gain.value = 0.9;
        sfxBus = ctx.createGain(); sfxBus.gain.value = prefs.sfx ? 1 : 0;
        musicBus = ctx.createGain(); musicBus.gain.value = prefs.music ? 0.55 : 0;
        sfxBus.connect(master); musicBus.connect(master);
        master.connect(comp); comp.connect(ctx.destination);
        const len = ctx.sampleRate * 2;
        noise = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = noise.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        startMusic();
    }
    if (ctx.state === 'suspended') ctx.resume();
}

export const audioPrefs = () => ({ ...prefs });
export function setSfx(on) {
    prefs.sfx = on; savePrefs();
    if (sfxBus) sfxBus.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.05);
    if (!on) for (const loop of loops) loop.stop();
}
export function setMusic(on) {
    prefs.music = on; savePrefs();
    if (musicBus) musicBus.gain.setTargetAtTime(on ? 0.55 : 0, ctx.currentTime, 0.2);
}
export function setListener(x, y, z) { listener.x = x; listener.y = y; listener.z = z; }

// ---------------------------------------------------------------- briques de synthèse
const now = () => ctx.currentTime;
const midi = n => 440 * Math.pow(2, (n - 69) / 12);

function out(vol, pos) {
    // volume selon la distance : plein à moins de 12 unités, inaudible au-delà de ~90
    let v = vol;
    if (pos) {
        const d = Math.hypot(pos[0] - listener.x, (pos[1] || 0) - listener.y, pos[2] - listener.z);
        v *= Math.max(0, Math.min(1, 1.15 - d / 80));
        if (v < 0.01) return null;
    }
    const g = ctx.createGain();
    g.gain.value = v;
    g.connect(sfxBus);
    return g;
}
function tone(dest, { type = 'sine', f = 440, f2 = null, t = 0, dur = 0.3, a = 0.005, vol = 1, vib = 0 }) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    const t0 = now() + t;
    o.frequency.setValueAtTime(f, t0);
    if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t0 + dur);
    if (vib) {
        const lfo = ctx.createOscillator(), lg = ctx.createGain();
        lfo.frequency.value = 6; lg.gain.value = vib;
        lfo.connect(lg); lg.connect(o.frequency);
        lfo.start(t0); lfo.stop(t0 + dur + 0.05);
    }
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(dest);
    o.start(t0); o.stop(t0 + dur + 0.05);
}
function hiss(dest, { t = 0, dur = 0.3, a = 0.005, vol = 1, type = 'bandpass', f = 1000, f2 = null, q = 1 }) {
    const src = ctx.createBufferSource(), flt = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = noise;
    flt.type = type; flt.Q.value = q;
    const t0 = now() + t;
    flt.frequency.setValueAtTime(f, t0);
    if (f2) flt.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(flt); flt.connect(g); g.connect(dest);
    src.start(t0, Math.random() * Math.max(0, 1.9 - dur)); src.stop(t0 + dur + 0.05);   // départ au hasard dans les 2 s de bruit
}
// cloche / boîte à musique : quelques partiels qui s'éteignent doucement
function bell(dest, f, t, vol, dur = 1.4) {
    tone(dest, { f, t, dur, vol });
    tone(dest, { f: f * 2.01, t, dur: dur * 0.6, vol: vol * 0.35 });
    tone(dest, { f: f * 3.98, t, dur: dur * 0.3, vol: vol * 0.12 });
}
// trompette de jouet : dents de scie adoucies par un filtre
function horn(dest, f, t, dur, vol) {
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass'; flt.frequency.value = 1800;
    flt.connect(dest);
    tone(flt, { type: 'sawtooth', f, t, dur, a: 0.03, vol, vib: 3 });
    tone(flt, { type: 'square', f: f / 2, t, dur, a: 0.03, vol: vol * 0.25 });
}

// ---------------------------------------------------------------- catalogue des bruitages
const SOUNDS = {
    sword(o) {                                               // choc d'épées : deux tintements métalliques
        const f = 1700 + Math.random() * 900;
        tone(o, { type: 'triangle', f, dur: 0.22, vol: 0.35 });
        tone(o, { type: 'triangle', f: f * 1.47, t: 0.01, dur: 0.15, vol: 0.18 });
        hiss(o, { type: 'highpass', f: 3500, dur: 0.06, vol: 0.4 });
    },
    swing(o) { hiss(o, { f: 500, f2: 1800, dur: 0.2, vol: 0.35, q: 2, a: 0.04 }); },
    arrow(o) { hiss(o, { f: 3200, f2: 900, dur: 0.28, vol: 0.18, q: 3, a: 0.02 }); },
    cannon(o) {
        hiss(o, { type: 'lowpass', f: 1200, f2: 80, dur: 0.9, vol: 0.9, a: 0.004 });
        tone(o, { f: 95, f2: 32, dur: 0.7, vol: 0.9 });
    },
    catapult(o) {                                            // grincement du bois puis claquement du bras
        tone(o, { type: 'sawtooth', f: 140, f2: 90, dur: 0.25, vol: 0.12, a: 0.05 });
        hiss(o, { type: 'lowpass', f: 600, t: 0.22, dur: 0.25, vol: 0.6 });
        tone(o, { f: 120, f2: 60, t: 0.22, dur: 0.25, vol: 0.5 });
    },
    impact(o) {                                              // boulet ou pierre qui retombe
        hiss(o, { type: 'lowpass', f: 700, f2: 120, dur: 0.45, vol: 0.7 });
        tone(o, { f: 80, f2: 40, dur: 0.35, vol: 0.6 });
    },
    ram(o) {                                                 // le tronc recule… puis le grand choc sourd sur le bois
        tone(o, { type: 'sawtooth', f: 90, f2: 70, dur: 0.35, vol: 0.08, a: 0.1 });
        hiss(o, { type: 'lowpass', f: 900, f2: 90, t: 0.45, dur: 0.7, vol: 0.9 });
        tone(o, { f: 75, f2: 38, t: 0.45, dur: 0.6, vol: 0.9 });
        for (let i = 0; i < 3; i++) hiss(o, { type: 'bandpass', f: 1400 + i * 500, t: 0.47 + i * 0.05, dur: 0.08, vol: 0.25, q: 3 });
    },
    die(o) { tone(o, { type: 'triangle', f: 520, f2: 180, dur: 0.16, vol: 0.18 }); hiss(o, { type: 'lowpass', f: 900, dur: 0.18, vol: 0.2 }); },
    chain(o) {                                               // chaînes du pont-levis qui cliquettent
        for (let i = 0; i < 12; i++) {
            const t = i * 0.085 + Math.random() * 0.03;
            hiss(o, { type: 'highpass', f: 2500, t, dur: 0.05, vol: 0.35 });
            tone(o, { type: 'triangle', f: 1300 + Math.random() * 900, t, dur: 0.08, vol: 0.08 });
        }
        tone(o, { f: 70, f2: 50, t: 1.05, dur: 0.35, vol: 0.5 });   // le pont touche le sol / se bloque
    },
    crash(o) {                                               // effondrement (chapiteau, barricades, pont-levis brisé)
        hiss(o, { type: 'lowpass', f: 1800, f2: 150, dur: 1.3, vol: 0.8 });
        for (let i = 0; i < 4; i++) tone(o, { f: 110 - i * 15, f2: 45, t: i * 0.12, dur: 0.3, vol: 0.45 });
        for (let i = 0; i < 6; i++) hiss(o, { type: 'bandpass', f: 1500 + Math.random() * 2000, t: 0.1 + Math.random() * 0.8, dur: 0.06, vol: 0.25, q: 4 });
    },
    oil(o) {                                                 // grésillement de l'huile
        hiss(o, { type: 'highpass', f: 4000, dur: 1.4, vol: 0.45, a: 0.05 });
        hiss(o, { type: 'bandpass', f: 1800, dur: 1.2, vol: 0.25, q: 0.7, a: 0.1 });
    },
    fireballLaunch(o) { hiss(o, { f: 300, f2: 2500, dur: 0.5, vol: 0.5, q: 1.5, a: 0.05 }); },
    fireballBoom(o) {
        hiss(o, { type: 'lowpass', f: 2500, f2: 120, dur: 1.1, vol: 1 });
        tone(o, { f: 110, f2: 35, dur: 0.8, vol: 0.8 });
        hiss(o, { type: 'highpass', f: 3500, t: 0.1, dur: 0.9, vol: 0.2, a: 0.1 });
    },
    roar(o) {                                                // rugissement du dragon
        const flt = ctx.createBiquadFilter();
        flt.type = 'lowpass'; flt.frequency.value = 900; flt.connect(o);
        tone(flt, { type: 'sawtooth', f: 150, f2: 70, dur: 1.5, a: 0.12, vol: 0.7, vib: 9 });
        tone(flt, { type: 'sawtooth', f: 225, f2: 105, dur: 1.4, a: 0.15, vol: 0.35, vib: 12 });
        hiss(o, { type: 'bandpass', f: 500, f2: 250, dur: 1.4, vol: 0.4, q: 1, a: 0.1 });
    },
    flap(o) { hiss(o, { type: 'lowpass', f: 400, dur: 0.25, vol: 0.35, a: 0.06 }); },
    heal(o) { [79, 83, 86, 91, 95].forEach((n, i) => bell(o, midi(n), i * 0.07, 0.18, 0.9)); },
    crown(o) {                                               // couronnement : cloches + fanfare
        [72, 76, 79, 84].forEach((n, i) => bell(o, midi(n), i * 0.12, 0.2, 1.6));
        [[67, 0.5, 0.18], [72, 0.7, 0.18], [76, 0.9, 0.5]].forEach(([n, t, d]) => horn(o, midi(n), t, d, 0.22));
    },
    kingDie(o) { [[67, 0, 0.45], [62, 0.45, 0.45], [55, 0.9, 1.0]].forEach(([n, t, d]) => horn(o, midi(n), t, d, 0.25)); },
    fanfare(o) {                                             // début de bataille
        [[60, 0, 0.16], [60, 0.18, 0.16], [60, 0.36, 0.16], [67, 0.56, 0.5], [64, 1.1, 0.2], [67, 1.32, 0.7]]
            .forEach(([n, t, d]) => horn(o, midi(n), t, d, 0.28));
        tone(o, { f: 70, f2: 50, t: 0.56, dur: 0.3, vol: 0.4 });
    },
    victory(o) {
        [[60, 0, 0.2], [64, 0.2, 0.2], [67, 0.4, 0.2], [72, 0.6, 0.6], [67, 1.25, 0.2], [72, 1.45, 1.2]]
            .forEach(([n, t, d]) => horn(o, midi(n), t, d, 0.3));
        [84, 88, 91].forEach((n, i) => bell(o, midi(n), 1.45 + i * 0.1, 0.15, 2));
    },
    defeat(o) { [[64, 0, 0.5], [63, 0.55, 0.5], [62, 1.1, 0.5], [55, 1.65, 1.6]].forEach(([n, t, d]) => horn(o, midi(n), t, d, 0.25)); },
    coins(o) { [88, 93, 96].forEach((n, i) => tone(o, { type: 'triangle', f: midi(n), t: i * 0.06, dur: 0.2, vol: 0.18 })); },
    build(o) {                                               // coups de marteau puis pièces
        for (let i = 0; i < 3; i++) { tone(o, { f: 180, f2: 90, t: i * 0.16, dur: 0.12, vol: 0.4 }); hiss(o, { type: 'bandpass', f: 1800, t: i * 0.16, dur: 0.05, vol: 0.3, q: 3 }); }
        SOUNDS.coins(o);
    },
    click(o) { tone(o, { type: 'triangle', f: 900, f2: 600, dur: 0.06, vol: 0.12 }); },
    deny(o) { tone(o, { type: 'square', f: 220, f2: 160, dur: 0.18, vol: 0.08 }); },
    horn(o) { horn(o, midi(55), 0, 0.5, 0.2); horn(o, midi(62), 0.15, 0.6, 0.15); },   // une troupe sort de la caserne
};

// limiteur : pas plus d'un même son toutes les X ms (une mêlée de 30 soldats reste supportable)
const MIN_GAP = { ram: 150, sword: 45, arrow: 40, die: 60, swing: 60, impact: 70, horn: 400, flap: 150 };
const lastPlay = {};
export function play(name, pos = null, vol = 1) {
    if (!ctx || !prefs.sfx || !SOUNDS[name]) return;
    const t = performance.now();
    if (MIN_GAP[name] && t - (lastPlay[name] || 0) < MIN_GAP[name]) return;
    lastPlay[name] = t;
    const o = out(vol, pos);
    if (o) SOUNDS[name](o);
}

// ---------------------------------------------------------------- sons qui durent (souffle du dragon)
const loops = new Set();
export function startLoop(name, pos) {
    if (!ctx || !prefs.sfx) return null;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(sfxBus);
    const src = ctx.createBufferSource(), flt = ctx.createBiquadFilter(), lfo = ctx.createOscillator(), lg = ctx.createGain();
    src.buffer = noise; src.loop = true;
    flt.type = 'lowpass'; flt.frequency.value = 1100; flt.Q.value = 0.8;
    lfo.frequency.value = 7; lg.gain.value = 300;                  // les flammes « ronflent »
    lfo.connect(lg); lg.connect(flt.frequency);
    src.connect(flt); flt.connect(g);
    src.start(); lfo.start();
    const loop = {
        update(p) {
            const d = Math.hypot(p[0] - listener.x, p[1] - listener.y, p[2] - listener.z);
            g.gain.setTargetAtTime(0.55 * Math.max(0, Math.min(1, 1.15 - d / 80)), now(), 0.08);
        },
        stop() {
            g.gain.setTargetAtTime(0, now(), 0.1);
            setTimeout(() => { try { src.stop(); lfo.stop(); } catch { /* déjà arrêté */ } g.disconnect(); }, 400);
            loops.delete(loop);
        },
    };
    loops.add(loop);
    if (pos) loop.update(pos);
    return loop;
}

// ---------------------------------------------------------------- musique : boîte à musique en ré dorien
// deux phrases de 4 mesures (croches) ; 0 = silence. La basse joue sur les temps 1 et 3.
const MELODY = [
    62, 0, 65, 0, 69, 0, 67, 65, 64, 0, 0, 62, 64, 0, 65, 0, 67, 0, 69, 0, 72, 0, 71, 69, 69, 0, 0, 0, 0, 0, 0, 0,
    74, 0, 72, 0, 69, 0, 67, 0, 65, 0, 67, 0, 69, 0, 0, 0, 67, 0, 65, 64, 62, 0, 64, 0, 62, 0, 0, 0, 0, 0, 0, 0,
];
const BASS = [50, 48, 53, 45, 50, 53, 48, 50];             // une note de basse par mesure
const STEP = 60 / 92 / 2;                                    // croches à 92 battements par minute
let battle = false, nextTime = 0, step = 0, musicTimer = null;
export function setBattle(on) { battle = on; }

function startMusic() {
    if (musicTimer) return;
    nextTime = now() + 0.2;
    musicTimer = setInterval(() => {
        if (ctx.state !== 'running') return;
        // programmation légèrement à l'avance : la musique reste régulière même si la page rame
        while (nextTime < now() + 0.35) {
            const t = nextTime - now();
            const n = MELODY[step % MELODY.length];
            if (n) bell(musicBus, midi(n), t, 0.16, 1.5);
            if (step % 4 === 0) {
                const bass = BASS[Math.floor(step / 8) % BASS.length];
                tone(musicBus, { type: 'triangle', f: midi(bass), t, dur: 1.1, a: 0.02, vol: 0.13 });
            }
            // en bataille : un tambour de jouet sur chaque temps, plus appuyé sur le premier
            if (battle && step % 2 === 0) {
                const strong = step % 8 === 0;
                tone(musicBus, { f: strong ? 110 : 90, f2: 50, t, dur: 0.25, vol: strong ? 0.28 : 0.15 });
                hiss(musicBus, { type: 'lowpass', f: 500, t, dur: 0.1, vol: strong ? 0.12 : 0.06 });
            }
            nextTime += STEP;
            step++;
        }
    }, 80);
}

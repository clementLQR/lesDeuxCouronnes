// =====================================================================
//  Qualité de l'image
//  - « Auto » (par défaut) : la définition de l'image s'adapte toute seule à la machine, image par image.
//    Un ordinateur rapide garde le plus beau rendu ; un vieux portable ou une tablette baisse la définition
//    (et, en dernier recours, les ombres) pour rester fluide.
//  - « Belle », « Équilibrée », « Rapide » : réglages fixes, choisis à la main (bouton ⚙️, mémorisé).
// =====================================================================

const MODES = ['auto', 'belle', 'equilibree', 'rapide'];
export const QUALITY_LABEL = {
    auto: "Auto : l'image s'adapte à ton appareil",
    belle: 'Belle : tous les détails',
    equilibree: 'Équilibrée',
    rapide: 'Rapide : pour les petits appareils',
};
// maxPR : définition maximale (1 = un pixel d'image par pixel CSS) ; shadow : taille de la carte d'ombres
const PRESETS = {
    belle:      { maxPR: 2,    minPR: 2,    shadow: 2048, shadows: true,  lights: true },
    equilibree: { maxPR: 1.25, minPR: 1.25, shadow: 1024, shadows: true,  lights: true },
    rapide:     { maxPR: 0.85, minPR: 0.85, shadow: 1024, shadows: false, lights: false },
    auto:       { maxPR: 2,    minPR: 0.6,  shadow: 2048, shadows: true,  lights: true },
};
const KEY = 'deuxCouronnes.qualite';

const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
const dpr = window.devicePixelRatio || 1;
// petit appareil probable : tactile, peu de cœurs ou peu de mémoire
const modest = isTouch || (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;

export function savedMode() {
    try { const m = localStorage.getItem(KEY); if (MODES.includes(m)) return m; } catch { /* stockage indisponible */ }
    return 'auto';
}
// l'anticrénelage se choisit à la création du rendu : inutile sur un écran très fin, trop cher en mode rapide
export function wantAntialias(mode = savedMode()) {
    return mode !== 'rapide' && !(isTouch && dpr >= 2);
}

export function createQuality({ renderer, sun, scene, toast }) {
    let mode = savedMode();
    let preset, pr, ceiling;
    let samples = [], window0 = 0, fastFor = 0, slowAtFloor = 0, cooldown = 0, autoShadowsOff = false;

    const setPR = v => {
        pr = v;
        renderer.setPixelRatio(pr);
        // carte d'ombres plus petite quand l'image est moins définie
        const size = Math.min(preset.shadow, pr >= 1.2 ? 2048 : pr >= 0.8 ? 1024 : 512);
        if (sun.shadow.mapSize.x !== size) {
            sun.shadow.mapSize.set(size, size);
            sun.shadow.map?.dispose();
            sun.shadow.map = null;
        }
    };
    // ombres et petites lumières (torches) : les changer recompile les effets, on ne le fait que rarement
    const setLights = (shadows, lights) => {
        sun.castShadow = shadows;
        scene.traverse(o => { if (o.isPointLight) o.visible = lights; });
    };

    function apply() {
        preset = PRESETS[mode];
        ceiling = Math.min(dpr, preset.maxPR);
        const floor = Math.min(ceiling, preset.minPR);
        // en auto, on démarre prudemment sur un petit appareil et on monte si tout va bien
        setPR(mode === 'auto' ? Math.min(ceiling, modest ? 1 : 1.5) : Math.max(floor, Math.min(ceiling, preset.maxPR)));
        autoShadowsOff = false;
        setLights(preset.shadows, preset.lights);
        samples = []; window0 = 0; fastFor = 0; slowAtFloor = 0; cooldown = 1.5;
    }
    apply();

    // appelée à chaque image : en auto, ajuste la définition selon la cadence mesurée
    function frame(rawDt) {
        if (mode !== 'auto') return;
        if (rawDt > 0.25) { samples = []; window0 = 0; return; }    // onglet caché, chargement : on ne compte pas
        cooldown -= rawDt;
        samples.push(rawDt);
        window0 += rawDt;
        if (window0 < 1.5) return;                                   // on juge sur 1,5 s
        samples.sort((a, b) => a - b);
        const typical = samples[Math.floor(samples.length * 0.6)];  // une image « ordinaire » (on ignore les rares accrocs)
        samples = []; window0 = 0;
        if (cooldown > 0) return;
        const floor = Math.min(ceiling, preset.minPR);
        if (typical > 1 / 45) {
            // trop lent : on baisse la définition
            fastFor = 0;
            if (pr > floor + 0.01) {
                const prev = pr;
                setPR(Math.max(floor, pr * 0.85));
                cooldown = 1.5;
                ceiling = Math.max(floor, Math.min(ceiling, prev * 0.95));    // on ne remontera plus jusqu'au palier qui ramait
            }
            else if (!autoShadowsOff && typical > 1 / 30 && (slowAtFloor += 1.5) >= 6) {
                // déjà au plus bas et toujours poussif : on retire les ombres, une fois pour toutes
                autoShadowsOff = true;
                setLights(false, true);
                toast?.('🖼️ Ton appareil peine un peu : les ombres sont retirées pour garder le jeu fluide.', 4);
            }
        } else if (typical < 1 / 57) {
            // large marge : on remonte doucement, sans dépasser le dernier palier où ça ramait
            slowAtFloor = 0;
            if ((fastFor += 1.5) >= 4.5 && pr < ceiling - 0.01) { setPR(Math.min(ceiling, pr * 1.12)); fastFor = 0; cooldown = 1.5; }
        } else fastFor = 0;
    }

    function cycle() {
        mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
        try { localStorage.setItem(KEY, mode); } catch { /* tant pis */ }
        apply();
        return mode;
    }

    return { frame, cycle, get mode() { return mode; }, get pixelRatio() { return pr; } };
}

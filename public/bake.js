import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// =====================================================================
//  Fusion des maillages (moins d'appels de dessin = jeu plus fluide)
//
//  Le décor et les figurines sont faits de centaines de petites pièces. Les dessiner une par une coûte cher :
//  on fusionne donc, une fois pour toutes, les pièces qui ne bougent pas les unes par rapport aux autres.
//  - Les matériaux « plastique » unis (même rugosité, même aspect métallique) sont réunis en un seul maillage :
//    leur couleur passe dans les sommets (vertex colors), le rendu est identique.
//  - Les matériaux à texture ne sont réunis qu'avec les pièces qui partagent exactement le même matériau.
//  Marquage des objets (userData) :
//  - frame : l'objet bouge, se cache ou change d'échelle (pont-levis, défenses, bras d'une figurine…) :
//    on fusionne son contenu avec lui, mais jamais avec le reste ;
//  - skip : on n'y touche pas du tout (flammes qui palpitent, drapeaux qui ondulent, créneaux qui tombent…).
// =====================================================================

const MAPS = ['map', 'bumpMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap', 'aoMap', 'lightMap', 'displacementMap', 'envMap'];
const plainMats = new Map();
const defaultBeforeRender = THREE.Object3D.prototype.onBeforeRender;

// plastique uni : sa couleur peut passer dans les sommets sans rien changer à l'image
function isPlain(m) {
    if (!m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) return false;
    if (m.transparent || m.opacity < 1 || m.vertexColors || m.flatShading || m.alphaTest > 0 || m.wireframe) return false;
    if (MAPS.some(k => m[k])) return false;
    return !(m.emissive.r || m.emissive.g || m.emissive.b);
}
function plainMaterial(m) {
    const key = [m.roughness, m.metalness, m.side, m.envMapIntensity, m.fog].join('|');
    let mat = plainMats.get(key);
    if (!mat) {
        mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: m.roughness, metalness: m.metalness, side: m.side, envMapIntensity: m.envMapIntensity, fog: m.fog });
        plainMats.set(key, mat);
    }
    return mat;
}

function mergeable(o) {
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || Array.isArray(o.material) || !o.material) return false;
    if (o.renderOrder !== 0 || o.onBeforeRender !== defaultBeforeRender || !o.frustumCulled) return false;
    const g = o.geometry;
    if (!g?.attributes.position || g.morphAttributes.position) return false;
    if (isPlain(o.material)) return true;
    return !o.material.transparent && !!g.attributes.uv;             // texture : il faut des coordonnées de texture
}

const tmpN = new THREE.Matrix3();

// valeurs brutes d'un attribut (copie si l'attribut est entrelacé ou d'un autre format)
function flat(attr, size) {
    if (!attr.isInterleavedBufferAttribute && attr.itemSize === size && !attr.normalized && attr.array instanceof Float32Array) return attr.array;
    const out = new Float32Array(attr.count * size);
    for (let i = 0; i < attr.count; i++) for (let k = 0; k < size; k++) out[i * size + k] = attr.getComponent(i, k);
    return out;
}

// parts : [{ geometry, matrix, color }] → une seule géométrie (positions, normales, uv ou couleurs)
// (calculs faits directement sur les tableaux : c'est exécuté au chargement sur des centaines de milliers de sommets)
export function mergeParts(parts, { uv = false, color = false, normal = true } = {}) {
    let vCount = 0, iCount = 0;
    for (const p of parts) {
        const n = p.geometry.attributes.position.count;
        vCount += n;
        iCount += p.geometry.index ? p.geometry.index.count : n;
    }
    const pos = new Float32Array(vCount * 3);
    const nor = normal ? new Float32Array(vCount * 3) : null;
    const uvs = uv ? new Float32Array(vCount * 2) : null;
    const col = color ? new Float32Array(vCount * 3) : null;
    const index = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
    let vo = 0, io = 0;
    for (const p of parts) {
        const g = p.geometry, P = g.attributes.position, count = P.count;
        const src = flat(P, 3);
        const e = p.matrix.elements;
        for (let i = 0, o = vo * 3; i < count; i++, o += 3) {
            const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
            pos[o] = e[0] * x + e[4] * y + e[8] * z + e[12];
            pos[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
            pos[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
        }
        if (nor) {
            if (g.attributes.normal) {
                const ns = flat(g.attributes.normal, 3), n = tmpN.getNormalMatrix(p.matrix).elements;
                for (let i = 0, o = vo * 3; i < count; i++, o += 3) {
                    const x = ns[i * 3], y = ns[i * 3 + 1], z = ns[i * 3 + 2];
                    let a = n[0] * x + n[3] * y + n[6] * z, b = n[1] * x + n[4] * y + n[7] * z, c = n[2] * x + n[5] * y + n[8] * z;
                    const l = Math.hypot(a, b, c) || 1;
                    nor[o] = a / l; nor[o + 1] = b / l; nor[o + 2] = c / l;
                }
            } else for (let i = 0, o = vo * 3; i < count; i++, o += 3) nor[o + 1] = 1;
        }
        if (uvs) uvs.set(flat(g.attributes.uv, 2).subarray(0, count * 2), vo * 2);
        if (col) {
            const { r, g: gg, b } = p.color;
            for (let i = 0, o = vo * 3; i < count; i++, o += 3) { col[o] = r; col[o + 1] = gg; col[o + 2] = b; }
        }
        // une pièce retournée en miroir (échelle négative) : on inverse l'ordre des sommets pour garder les bonnes faces
        const flip = p.matrix.determinant() < 0;
        const I = g.index?.array, n = I ? I.length : count;
        for (let j = 0; j + 2 < n; j += 3) {
            const a = I ? I[j] : j, b = I ? I[j + 1] : j + 1, c = I ? I[j + 2] : j + 2;
            index[io++] = vo + a;
            index[io++] = vo + (flip ? c : b);
            index[io++] = vo + (flip ? b : c);
        }
        vo += count;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (nor) geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    if (uvs) geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    if (col) geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
}

// Fusionne les pièces immobiles sous root. chunk > 0 : découpe aussi en cases de cette taille
// (les grandes pièces de décor restent éliminées quand elles sont hors champ ou hors de la zone d'ombre).
// Renvoie les maillages créés.
export function mergeStatic(root, { chunk = 0 } = {}) {
    root.updateMatrixWorld(true);
    const buckets = new Map();
    const merged = [];
    const center = new THREE.Vector3();
    const visit = (obj, frame) => {
        for (const c of obj.children) {
            const u = c.userData;
            if (u.skip || u.merlon) continue;
            const isFrame = !!u.frame;
            if (!isFrame && !c.visible) continue;               // caché pour de bon : on laisse tel quel
            if (!isFrame && mergeable(c)) {
                const plain = isPlain(c.material);
                let cell = '';
                if (chunk && frame === root) {
                    if (!c.geometry.boundingSphere) c.geometry.computeBoundingSphere();
                    center.copy(c.geometry.boundingSphere.center).applyMatrix4(c.matrixWorld);
                    cell = Math.floor(center.x / chunk) + ',' + Math.floor(center.z / chunk);
                }
                const mat = plain ? plainMaterial(c.material) : c.material;
                const key = `${frame.id}|${mat.uuid}|${c.castShadow}|${c.receiveShadow}|${cell}`;
                let b = buckets.get(key);
                if (!b) buckets.set(key, b = { frame, mat, plain, cast: c.castShadow, receive: c.receiveShadow, meshes: [] });
                b.meshes.push(c);
            }
            visit(c, isFrame ? c : frame);
        }
    };
    visit(root, root);

    const inv = new THREE.Matrix4();
    for (const b of buckets.values()) {
        if (b.meshes.length < 2) continue;                      // rien à gagner
        inv.copy(b.frame.matrixWorld).invert();
        const parts = b.meshes.map(m => ({
            geometry: m.geometry,
            matrix: new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld),
            color: b.plain ? m.material.color : null,
        }));
        const geo = mergeParts(parts, { uv: !b.plain, color: b.plain });
        const mesh = new THREE.Mesh(geo, b.mat);
        mesh.castShadow = b.cast;
        mesh.receiveShadow = b.receive;
        mesh.userData.merged = true;
        b.frame.add(mesh);
        merged.push(mesh);
        for (const m of b.meshes) {
            // une pièce qui porte d'autres objets reste dans l'arbre (ses enfants en dépendent) mais n'est plus dessinée
            if (m.children.length) { m.layers.disableAll(); m.castShadow = false; }
            else m.parent.remove(m);
        }
    }
    return merged;
}

// ---------------------------------------------------------------- modèles animés (figurines, engins, dragons)
// Les objets désignés par le modèle (bras, roues, tête…) sont ses articulations : on fusionne autour d'elles.
export function bakeModel(model) {
    const mark = v => {
        if (Array.isArray(v)) return v.forEach(mark);
        if (!v?.isObject3D || v === model.root) return;
        if (v.isMesh) v.userData.skip = true;                  // pièce manipulée directement (pierre de la catapulte…)
        else v.userData.frame = true;
    };
    for (const v of Object.values(model)) mark(v);
    mergeStatic(model.root);
    return model;
}

// copie d'un modèle déjà fusionné : géométries et matériaux partagés, articulations retrouvées dans la copie
export function cloneModel(t) {
    const root = t.root.clone(true);
    const map = new Map();
    const a = [], b = [];
    t.root.traverse(o => a.push(o));
    root.traverse(o => b.push(o));
    a.forEach((o, i) => map.set(o, b[i]));
    const remap = v => (Array.isArray(v) ? v.map(remap) : v?.isObject3D ? map.get(v) ?? v : v);
    const out = {};
    for (const [k, v] of Object.entries(t)) out[k] = remap(v);
    if ('phase' in t) out.phase = Math.random() * 6;
    return out;
}

// ---------------------------------------------------------------- lot de pièces identiques qu'on peut retirer une à une
// (les créneaux : dessinés ensemble tant qu'ils sont en place ; celui qui tombe redevient un objet à part).
// Une pièce retirée n'est pas supprimée : ses sommets sont réunis en un point, elle disparaît sans rien réallouer.
export function makeBatch(meshes) {
    const mat = meshes[0].material;
    const plain = isPlain(mat);
    const ranges = [];
    let start = 0;
    const parts = meshes.map(m => {
        m.updateWorldMatrix(true, false);
        const n = m.geometry.attributes.position.count;
        ranges.push([start, n]);
        start += n;
        return { geometry: m.geometry, matrix: m.matrixWorld.clone(), color: plain ? m.material.color : null };
    });
    const geo = mergeParts(parts, { uv: !plain, color: plain });
    const mesh = new THREE.Mesh(geo, plain ? plainMaterial(mat) : mat);
    mesh.castShadow = meshes[0].castShadow;
    mesh.receiveShadow = meshes[0].receiveShadow;
    const pos = geo.attributes.position, orig = pos.array.slice();
    let dirty = false;
    const setVisible = (i, on) => {
        dirty = true;
        const [s, n] = ranges[i];
        const arr = pos.array;
        if (on) arr.set(orig.subarray(s * 3, (s + n) * 3), s * 3);
        else for (let k = s * 3; k < (s + n) * 3; k += 3) { arr[k] = orig[s * 3]; arr[k + 1] = orig[s * 3 + 1]; arr[k + 2] = orig[s * 3 + 2]; }
        pos.addUpdateRange(s * 3, n * 3);
        pos.needsUpdate = true;
    };
    // le lot sert aussi d'obstacle : après des changements, son arbre de collision est réajusté (rapide, sans tout reconstruire)
    const sync = () => {
        if (!dirty) return;
        dirty = false;
        geo.boundsTree?.refit();
    };
    return { mesh, setVisible, sync };
}

// ---------------------------------------------------------------- version allégée (vue de loin)
// Une figurine au loin ne fait que quelques pixels : on la redessine avec moins de facettes.
// Chaque forme garde ses paramètres de construction (rayon, nombre de segments…) : on la reconstruit avec moins de segments.
// Une forme modifiée après coup (déplacée, tournée) est reconnue à sa boîte englobante et laissée telle quelle.
const lowCache = new Map();
const fewer = (n, k, min) => Math.max(min, Math.round(n * k));
function rebuildLow(g) {
    const p = g.parameters;
    if (!p) return null;
    switch (g.type) {
        case 'SphereGeometry': return new THREE.SphereGeometry(p.radius, fewer(p.widthSegments, 0.4, 6), fewer(p.heightSegments, 0.45, 4), p.phiStart, p.phiLength, p.thetaStart, p.thetaLength);
        case 'CapsuleGeometry': return new THREE.CapsuleGeometry(p.radius, p.height, fewer(p.capSegments, 0.5, 2), fewer(p.radialSegments, 0.5, 6), p.heightSegments);
        case 'CylinderGeometry': return new THREE.CylinderGeometry(p.radiusTop, p.radiusBottom, p.height, fewer(p.radialSegments, 0.4, 6), 1, p.openEnded, p.thetaStart, p.thetaLength);
        case 'ConeGeometry': return new THREE.ConeGeometry(p.radius, p.height, fewer(p.radialSegments, 0.4, 5), 1, p.openEnded, p.thetaStart, p.thetaLength);
        case 'TorusGeometry': return new THREE.TorusGeometry(p.radius, p.tube, fewer(p.radialSegments, 0.5, 3), fewer(p.tubularSegments, 0.4, 6), p.arc);
        case 'CircleGeometry': return new THREE.CircleGeometry(p.radius, fewer(p.segments, 0.4, 6), p.thetaStart, p.thetaLength);
        case 'IcosahedronGeometry': return new THREE.IcosahedronGeometry(p.radius, Math.max(0, p.detail - 1));
        case 'RoundedBoxGeometry': return new RoundedBoxGeometry(p.width, p.height, p.depth, 1, p.radius);
        case 'ExtrudeGeometry': return new THREE.ExtrudeGeometry(p.shapes, { ...p.options, curveSegments: fewer(p.options.curveSegments ?? 12, 0.4, 3), bevelSegments: Math.min(p.options.bevelSegments ?? 3, 1) });
        case 'ShapeGeometry': return new THREE.ShapeGeometry(p.shapes, fewer(p.curveSegments, 0.4, 3));
    }
    return null;
}
const triCount = g => (g.index ? g.index.count : g.attributes.position.count) / 3;
function sameBox(a, b) {
    a.computeBoundingBox(); b.computeBoundingBox();
    const A = a.boundingBox, B = b.boundingBox;
    const tol = 0.03 * Math.max(A.max.x - A.min.x, A.max.y - A.min.y, A.max.z - A.min.z) + 1e-4;
    return A.min.distanceTo(B.min) < tol && A.max.distanceTo(B.max) < tol;
}
export function lowPoly(g) {
    let out = lowCache.get(g);
    if (out) return out;
    out = g;
    try {
        const n = rebuildLow(g);
        if (n && triCount(n) < triCount(g) * 0.9 && sameBox(g, n) && (!g.attributes.uv || n.attributes.uv)) out = n;
    } catch { /* forme inconnue : on garde l'originale */ }
    lowCache.set(g, out);
    return out;
}
export function simplify(root) {
    root.traverse(o => { if (o.isMesh) o.geometry = lowPoly(o.geometry); });
    return root;
}

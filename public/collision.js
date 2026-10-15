import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { mergeParts } from './bake.js';

// =====================================================================
//  Collisions rapides
//  Le roi, la caméra et chaque troupe lancent des rayons contre le décor plusieurs fois par image.
//  Sans aide, un rayon teste chaque triangle de centaines d'objets (≈ 0,5 ms le rayon).
//  - three-mesh-bvh range les triangles dans un arbre (BVH) : un rayon ne teste plus que ceux qu'il croise ;
//  - tout le décor immobile est réuni en un seul objet de collision, invisible.
//  Les objets qui bougent ou apparaissent (pont-levis, créneaux, barricades, chapiteau, tours de mage)
//  restent à part, chacun avec son propre arbre.
// =====================================================================
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const dynamic = o => o.userData.frame || o.userData.merlon;
const later = [];                       // gros arbres construits après la première image (voir finishColliders)
const hiddenMat = new THREE.MeshBasicMaterial({ visible: false });

// remplace, dans une liste de collision, tous les objets immobiles par un seul maillage avec arbre ;
// les objets mobiles gardent leur place (le code du jeu les retrouve avec indexOf)
export function compactColliders(list) {
    const parts = [], keep = [];
    for (const entry of list) {
        if (dynamic(entry)) { keep.push(entry); continue; }
        entry.updateWorldMatrix(true, true);
        const walk = o => {
            if (o !== entry && dynamic(o)) return;              // une partie mobile dans un ensemble immobile
            if (o.isMesh && o.geometry?.attributes.position) parts.push({ geometry: o.geometry, matrix: o.matrixWorld.clone() });
            for (const c of o.children) walk(c);
        };
        walk(entry);
    }
    list.length = 0;
    if (parts.length) {
        const geo = mergeParts(parts, { normal: false });
        later.push(geo);
        const mesh = new THREE.Mesh(geo, hiddenMat);
        mesh.updateMatrixWorld(true);
        mesh.userData.staticCollider = true;
        list.push(mesh);
    }
    for (const o of keep) { if (!o.userData.merlon) prepare(o); list.push(o); }
}

// arbre de collision pour un objet mobile (et tout ce qu'il contient)
export function prepare(obj) {
    obj.traverse(o => {
        if (o.isMesh && o.geometry?.attributes.position && !o.geometry.boundsTree) o.geometry.computeBoundsTree();
    });
}

// Construire l'arbre du décor prend un moment (des centaines de milliers de triangles) : on le fait juste après
// la première image, pendant que le joueur lit le menu, plutôt que de retarder l'affichage du jeu.
// En attendant, les rayons marchent quand même (plus lentement).
export function finishColliders() {
    for (const geo of later.splice(0)) if (!geo.boundsTree) geo.computeBoundsTree();
}

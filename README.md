# 👑 Les Deux Couronnes

*Quand la lumière s'éteint dans la chambre, les jouets se réveillent…*

Sur le grand tapis de jeu d'une chambre d'enfant, le **royaume du Lion** et le **royaume du Crâne** s'affrontent.
Chaque joueur incarne un roi : il lève son armée, défend son pont-levis et tente d'entrer dans la salle au trésor du château d'en face.

Jeu 3D dans le navigateur, réalisé avec [Three.js](https://threejs.org/) et un petit serveur Node.js (WebSocket).

## Les règles

- **Lève ton armée** : soldats, archers et chevaliers sortent de la caserne, canons, catapultes et béliers de l'atelier de siège (touches `1` à `6`). Ils quittent le château par le pont-levis.
- **Remplis ton coffre** : 10 pièces d'or par seconde, et chaque soldat ennemi vaincu rapporte la moitié de ce qu'il a coûté.
- **Le roi aussi se bat** (`F` ou clic). S'il tombe, un nouveau roi est couronné dans la cour 5 secondes plus tard.
- **Le pont-levis** (`E`) : le lever protège ton trésor, mais tes soldats restent enfermés.
- **Les ordres** : toute l'armée obéit à un même ordre. ⚔️ **Attaquer** (`V`) : marcher sur le château ennemi ; 🛡️ **Défendre** (`B`) : tenir la ligne devant son pont-levis, sous l'étendard ; 👑 **Suivre le roi** (`N`) : escorter son roi, en passant par les portes, jusque dans le château adverse.
- **Forces et faiblesses** : les lances des soldats battent les chevaliers (dégâts ×1,7) et le bélier (×3), les chevaliers battent les archers (×1,7), les archers battent les soldats (×1,7). À l'inverse, les chevaliers frappent moins fort les soldats (×0,8) et les flèches rebondissent sur leur armure (×0,75). À prix égal, chaque troupe bat celle qu'elle contre, et une armée variée bat une armée d'un seul type.
- **Les engins** : les boulets du canon explosent au milieu des troupes ennemies (dégâts de zone), sinon il tire sur le château ; l'engin de siège tire de plus loin que les tours (il faut sortir pour l'abattre) ; le bélier frappe le pont-levis même levé.
- **Dernier rempart** : sous 40 % de ses PV, un château se défend avec l'énergie du désespoir : ses tours tirent plus vite.
- **La guerre s'éternise ?** Passé 12 minutes, les revenus montent par paliers (+20 %, +40 %, puis +60 % à 22 minutes).
- **Les défenses** (touches `7`, `8`, `9` et `0`) : renforcer ses tours, chauffer l'huile, dresser des barricades ou un chapiteau hors les murs. Tenir un siège devient possible… mais les canons ennemis finissent toujours par user les murs.
- **L'armure royale** : flèches des tours et huile bouillante ne font qu'un tiers environ de leurs dégâts à un roi, qui peut ainsi foncer jusqu'au trésor.
- **La victoire** : un château à 0 PV voit son pont-levis céder pour de bon. Le premier roi qui entre dans la salle au trésor adverse gagne.

| Troupe | Coût | Prime | Formation |
|---|---|---|---|
| Soldats | 25 | 13 | 3 s |
| Archers | 35 | 18 | 4 s |
| Chevalier | 65 | 33 | 6 s |
| Canon | 150 | 75 | 9 s |
| Engin de siège | 200 | 100 | 10 s |
| 🐏 Bélier | 160 | 80 | 8 s |
| Roi adverse | — | 100 | — |

| Défense | Niveaux (prix) | Effet |
|---|---|---|
| 🏹 Tours de garde | 2 (150), 3 (300) | Flèches plus fortes, plus rapides, plus lointaines ; au niveau 3 les deux tours tirent ensemble. |
| 🔥 Huile bouillante | 1 (200), 2 (350) | Un chaudron au-dessus de la porte arrose régulièrement tous les ennemis massés devant. |
| 🪵 Barricades | 1 (120), 2 (220) | Placées d'office devant le pont-levis : soldats, chevaliers et roi ennemis doivent les abattre pour passer. Niveau 2 : chevaux de frise qui blessent ceux qui frappent. |
| 🎪 Chapiteau | 200 | Une caserne hors les murs : les troupes qui y sont formées partent sans passer par le pont-levis. Fragile (300 PV) : les engins de siège ennemis le pilonnent de loin. Abattu, il faut attendre 40 s pour le redresser (20 s pour des barricades). |

**Les tours de mage** se bâtissent derrière le château. Elles sont indestructibles et les troupes les ignorent. Chacune débloque un sort, payé à chaque lancer :

| Tour (prix) | Sort (touche) | Coût | Recharge | Effet |
|---|---|---|---|---|
| Alchimiste (250) | 🧪 Potion de vie (`R`) | 60 | 30 s | Rend 150 PV au roi. |
| Pyromancien (350) | ☄️ Boule de feu (`T`) | 90 | 16 s | On vise le champ de bataille à la souris : elle brûle les troupes et les obstacles ennemis (barricades, chapiteau). |
| Invocateur (1200) | 🐉 Dragon (`Y`) | 500 | 5 min | Le dragon du royaume (Dragon Royal pour le Lion, Dragon des Ombres pour le Crâne) survole le terrain pendant 18 s, chasse les troupes ennemies et réduit en cendres toutes celles qu'il survole hors de leur château (la cour adverse reste à l'abri). Il ne touche à aucune construction, et ses victimes ne rapportent pas d'or. |

**Commandes** : `ZQSD` / flèches pour marcher, `Maj` pour courir, `Espace` pour sauter, glisser la souris pour tourner la caméra, molette pour zoomer.

**Sur tablette** : un joystick pour marcher, des boutons pour frapper, sauter, courir et manœuvrer le pont-levis ; un doigt tourne la caméra, deux doigts zooment.

**Cris rapides** : le bouton 📣 fait crier ton roi (« Oyez, oyez ! », « À l'attaque ! », « Bien joué ! »…), dans une bulle visible de tous.

**Partie guidée** : depuis l'accueil, une partie solo pas à pas (se déplacer, former une troupe, le pont-levis, les ordres, une tour de mage, les barricades) pendant laquelle l'IA attend que la leçon soit finie.

**Fin de partie** : un tableau compare les deux royaumes (troupes formées, abattues et perdues, or gagné, dégâts au château, sorts, constructions, rois tombés) et donne la durée de la bataille.

**Son** : bruitages et musique de boîte à musique sont synthétisés en direct dans le navigateur (aucun fichier audio). Les boutons 🔊 et 🎵, en haut à droite, coupent les bruitages ou la musique ; le choix est mémorisé.

**Qualité de l'image** : le bouton ⚙️ choisit entre *Auto* (par défaut : la définition de l'image s'adapte toute seule à l'appareil pour rester fluide), *Belle*, *Équilibrée* et *Rapide* (pour les petits appareils : sans ombres ni lumières des torches). Le choix est mémorisé.

## Modes de jeu

- **Solo** contre l'IA, avec trois adversaires : l'Écuyer (facile), le Chevalier (normal) et le Dragon (difficile).
- **Multijoueur** par salons : crée un salon (ouvert ou protégé par un mot de passe) ou rejoins-en un depuis la liste ou avec son code à 4 caractères. Jusqu'à 4 joueurs par salon, deux rois par château.

## Lancer le jeu sur son ordinateur

Il faut [Node.js](https://nodejs.org/) 18 ou plus récent.

```bash
npm install
npm start
```

Puis ouvrir <http://localhost:3000>. Les autres joueurs du même réseau Wi-Fi peuvent rejoindre avec l'adresse affichée dans la console.

Pour tester rapidement :
- la fin de partie : `CASTLE_HP=200 npm start` (les châteaux démarrent avec 200 PV au lieu de 2500) ;
- les achats : `START_GOLD=3000 npm start` (chaque camp démarre avec 3000 pièces au lieu de 300).

## Mettre le jeu en ligne sur Render

Le projet contient un fichier [`render.yaml`](render.yaml).

1. Sur [render.com](https://render.com), choisir **New → Blueprint** et sélectionner ce dépôt GitHub.
   (Ou **New → Web Service**, langage *Node*, build `npm ci`, démarrage `npm start`, offre *Free*.)
2. Render fournit une adresse du type `https://les-deux-couronnes.onrender.com` : c'est elle qu'on partage aux autres joueurs.

À savoir avec l'offre gratuite : le service s'endort après 15 minutes sans joueur et met environ une minute à se réveiller. Les parties et salons sont gardés en mémoire : ils disparaissent à chaque redémarrage ou redéploiement.

## Organisation du code

| Fichier | Rôle |
|---|---|
| `server.js` | Serveur HTTP + WebSocket : salons, règles, troupes, IA, rois. Il fait autorité sur la partie. |
| `public/index.html` | Page, interface (menu, boutique, barres de vie) et styles. |
| `public/main.js` | Client : connexion, joueur, caméra, affichage des troupes, effets, menu. |
| `public/world.js` | Construction du monde 3D : chambre, châteaux, figurines, engins de siège. |
| `public/audio.js` | Sons et musique synthétisés (Web Audio API), atténués selon la distance. |
| `public/bake.js` | Fusion des pièces immobiles (décor, figurines) pour dessiner moins d'objets ; versions allégées des troupes vues de loin. |
| `public/collision.js` | Collisions rapides : décor immobile réuni dans un arbre de recherche ([three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh)). |
| `public/quality.js` | Qualité de l'image adaptée à l'appareil (définition, ombres). |

## Équilibrage

Les règles sont réglées avec un simulateur qui fait tourner la vraie logique du serveur en accéléré (sans navigateur) :

```bash
node tools/sim.js games normal 30   # 30 parties IA contre IA (durées, victoires, dépenses)
node tools/sim.js duels 600 16      # combats à or égal entre troupes, en plein champ
node tools/sim.js siege             # temps pour briser un château selon l'engin et les défenses
```

Repères actuels : à or égal, chaque troupe bat celle qu'elle contre et une armée variée l'emporte ; aucune arme de siège ne gagne seule contre toutes les défenses ; une partie IA normale contre IA normale dure une quinzaine de minutes, sans blocage.

## Performances

Le jeu doit tourner aussi sur un vieux portable ou une tablette :
- **moins d'objets à dessiner** : au chargement, les milliers de petites pièces immobiles du décor sont fusionnées par matériau ; chaque modèle de troupe n'est construit qu'une fois, puis copié ; les troupes lointaines utilisent une version allégée ; toute la fumée est dessinée d'un coup ;
- **collisions rapides** : un arbre de recherche (BVH) évite de tester chaque triangle à chaque rayon ;
- **qualité adaptative** : en mode *Auto*, la définition baisse si les images ralentissent et remonte quand tout va bien ;
- **chargement** : les effets sont pré-compilés pendant l'affichage du menu, les modules sont préchargés en parallèle, le serveur envoie les fichiers compressés (brotli/gzip) et répond « rien de neuf » (304) quand ils n'ont pas changé ;
- **réseau** : les messages WebSocket sont compressés (environ 5 fois moins de données).

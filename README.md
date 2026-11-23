# Prixcarburant

Application web (PWA) qui affiche le prix du **SP95** dans les stations autour de votre position, du moins cher au plus cher.
Toutes les stations du rayon sont listées. Sans SP95 (non vendu ou en rupture), c'est le prix du **SP98** qui est affiché
(étiquette « SP98 », classé avec les autres prix, historique du SP98). Les stations sans le carburant choisi ni son
repli viennent ensuite, par distance, avec leurs autres prix (beaucoup ne vendent que du SP95-E10).
Autres carburants disponibles dans le sélecteur : SP95-E10, SP98, Gazole, E85, GPL.

- Rayon réglable (2 à 30 km), tri par distance (par défaut) ou par prix, vue liste ou carte (Leaflet + OpenStreetMap).
- Couleur du prix : vert = tiers le moins cher, orange = moyen, rouge = le plus cher (calculé sur les stations affichées).
- Prix non mis à jour depuis plus de 3 jours grisés (« prix ancien »).
- Enseigne et logo de chaque station (liste et carte).
- Lien d'itinéraire Google Maps.
- Clic sur une station de la liste : historique du prix sur 7 jours (courbe, tendance, min/max).
- Préférences (carburant, rayon, tri) mémorisées dans le navigateur (`localStorage`, clé `prixcarburant.v1`).

## Données

Flux instantané officiel [prix-carburants.gouv.fr](https://www.prix-carburants.gouv.fr/), via l'API Opendatasoft de
data.economie.gouv.fr (jeu `prix-des-carburants-en-france-flux-instantane-v2`) : sans clé, CORS ouvert, appelée
directement depuis le navigateur (filtre `within_distance(geom, …)`, pagination par 100, 1000 stations maximum).

Historique : fichiers quotidiens officiels `https://donnees.roulez-eco.fr/opendata/jour/AAAAMMJJ` (zip ~1 Mo,
CORS ouvert, dernier prix connu de chaque station en fin de journée). J-6 à J-1 sont téléchargés au premier clic,
décompressés dans le navigateur (`DecompressionStream`) et gardés dans le Cache Storage (`prixcarburant-jours`) ;
le point du jour est le prix du flux instantané.

Enseignes : le jeu officiel ne les contient pas. Elles viennent de l'API communautaire
[prix-carburants.2aaz.fr](https://swagger.2aaz.fr/) (mêmes identifiants de station, CORS ouvert, sans clé) :
`/station/{id}` pour quelques stations, sinon `/stations/around/{lat},{lon}` par pages de 20 (en-tête `Range`).
Résultat mis en cache 30 jours par station (`localStorage`, clé `prixcarburant.brands.v1`) ; si l'API ne répond pas,
l'appli fonctionne sans enseignes. Logo : icône du site de l'enseigne (`google.com/s2/favicons`, table `BRAND_LOGOS`
dans `app.js`), à défaut une pastille avec les initiales.

OpenStreetMap (Overpass) a été écarté : trop lent depuis le navigateur (30 à 40 s) et souvent indisponible.

## Fichiers

- `index.html`, `style.css`, `app.js` : l'application, sans build.
- `sw.js`, `manifest.webmanifest`, `icon.svg` : installation sur l'écran d'accueil et ouverture hors ligne de l'interface.

## Lancer en local

```bash
python -m http.server 8124
```

Puis http://localhost:8124 (la géolocalisation exige `localhost` ou HTTPS).

## Déploiement

Site 100 % statique : Netlify (*Import from Git*, aucune commande de build, dossier publié `.`), GitHub Pages ou
Azure Static Web Apps. HTTPS obligatoire pour la géolocalisation.

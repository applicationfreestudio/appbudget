# App Budget

Suivi des budgets de dépenses de l'**Accueil jeunes de Selles-sur-Cher** (analytique 3382, CC Val de Cher Controis, nomenclature M57).

L'application tient dans un seul fichier, `public/index.html`. Elle est servie par un **Worker Cloudflare**, qui stocke aussi les fichiers dans **R2**. Elle est également publiée comme artefact Claude ; dans Claude, le stockage Cloudflare n'est pas disponible.

## Contenu du dépôt

| Fichier | Rôle |
|---|---|
| `public/index.html` | L'application complète (HTML, CSS, JavaScript) |
| `public/manifest.webmanifest`, `public/sw.js`, icônes | Installation comme application Chrome (PWA) |
| `worker/index.js` | Worker Cloudflare : sert l'application et l'API de stockage `/api/*` |
| `wrangler.jsonc` | Configuration du Worker (assets, bucket R2 `appbudget-files`) |
| `config/periodes-cle-2026.json` | Périodes et clé de répartition 2026 (restaurable seule) |
| `config/sauvegarde-complete-2026-11-13.json` | Sauvegarde complète : situation budgétaire, articles suivis, régie, périodes |

## Fonctions

- Jauge globale et jauges par article (bleu : disponible, or : 90 à 100 %, rouge : dépassement).
- Import de la « Situation budgétaire détaillée par analytique » (PDF), avec un contrôle des totaux par chapitre.
- Import des états de régie (.ods / .xlsx) pour les dépenses pas encore mandatées.
- Choix des articles suivis.
- Périodes de l'année avec une clé de répartition (%). Les écarts des périodes passées sont reportés sur les suivantes.
- Sauvegarde et restauration au format JSON (Paramètres → Sauvegarde et restauration).

## Mise en place sur Cloudflare (une seule fois)

1. **R2 → Create bucket** : nommer le bucket `appbudget-files`.
2. **Workers & Pages** : le projet relié au dépôt GitHub doit être un **Worker**, et non un projet Pages, pour que `wrangler.jsonc` soit pris en compte.
   - Commande de build : aucune.
   - Commande de déploiement : `npx wrangler deploy`.

   Chaque push sur `main` redéploie automatiquement.
3. **Worker → Settings → Variables and Secrets** : ajouter un **secret** `APP_TOKEN`, un mot de passe long de ton choix. Le dépôt étant public, ce jeton ne doit jamais être écrit dans le code.
4. Ouvrir l'adresse du Worker (`https://appbudget.<compte>.workers.dev`), puis **Paramètres → Stockage Cloudflare**. Saisir le jeton et cliquer sur **Connecter**.

### Ce que fait le stockage

- **État courant :** les données de l'application sont enregistrées automatiquement (`etat/courant.json`) à chaque modification et rechargées sur tout appareil connecté avec le jeton.
- **Sauvegardes :** les sauvegardes datées à la demande vont dans `sauvegardes/`, restaurables depuis la liste.
- **Archives :** les PDF de situation et les états de régie importés sont archivés dans `documents/`.

### API (`/api`, en-tête `Authorization: Bearer <APP_TOKEN>`)

| Méthode | Chemin | Rôle |
|---|---|---|
| GET | `/api/health` | État du Worker : R2 relié et secret défini (sans jeton) |
| GET | `/api/files?prefix=` | Liste des fichiers |
| GET / PUT / DELETE | `/api/files/<chemin>` | Lire, écrire ou supprimer un fichier (25 Mo maximum) |

## Restaurer une configuration

1. Ouvrir l'application, puis **Paramètres → Sauvegarde et restauration → Restaurer depuis un fichier**.
2. Choisir l'un des fichiers du dossier `config/`.
   - `periodes-cle-*.json` remplace uniquement les périodes et la clé.
   - `sauvegarde-complete-*.json` remplace toutes les données.
3. Confirmer.

## Clé de répartition 2026 : méthode

Calculée à partir des dépenses 2026 rattachées à la **date de l'activité**, et non à la date du mandat :

- les 148 lignes du PDF du 06/11/2026 (mandats et engagements) et les 143 lignes des états de régie de juillet à octobre ;
- les périodes suivent le calendrier scolaire de la zone B ;
- les dépôts de régie couvrant plusieurs semaines sont répartis au jour, avec un poids plus fort pour les vacances (≈ 5,3 fois, mesuré sur la régie 2026) ;
- les charges fixes (ménage, téléphone, assurance, copieurs, abonnements, matériel) sont réparties uniformément sur l'année ;
- les dépenses d'activités 2025 payées en 2026 sont exclues (8 093 €) ;
- novembre–décembre : les dépenses de novembre–décembre 2025 servent de base estimée ;
- Toussaint : factures pas encore arrivées, estimation par la moyenne des vacances d'hiver et de printemps ;
- séjours : Séjour 1 = Printemps de Bourges (12–19/04), Séjour 2 = début juillet (3–12/07), Petit séjour 1 = St-Pardoux (15–17/07), Petit séjour 2 = Toussaint (21–23/10).

| Période | % |
|---|---|
| Janvier → février | 3,8 |
| Vacances d'hiver | 10,0 |
| Février → avril | 10,1 |
| Vacances de printemps | 7,3 |
| Avril → juin | 9,6 |
| Vacances d'été · juillet | 13,5 |
| Vacances d'été · août | 11,5 |
| Septembre → octobre | 8,1 |
| Vacances de la Toussaint | 8,6 |
| Octobre → décembre | 4,1 |
| Vacances de Noël | 4,0 |
| Séjour 1 | 2,9 |
| Séjour 2 | 5,1 |
| Petit séjour 1 | 1,0 |
| Petit séjour 2 | 0,4 |

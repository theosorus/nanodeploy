---
name: nanoploy-app
description: Crée et déploie des applications web sur Nanoploy, la plateforme auto-hébergée de Théo (Jetson Nano, scale-to-zero, Postgres mutualisé, auth par gateway). Utilise cette skill DÈS QUE Théo demande de créer, coder, scaffolder, modifier ou déployer une app, un outil interne, un dashboard, un tracker, un mini SaaS ou "un truc qui fait X" destiné à son serveur, même s'il ne dit pas "Nanoploy". Déclenche aussi sur "déploie ça", "mets ça sur mon serveur", "fais-moi une app pour...", "ajoute une page à mon app", ou toute mention de app.yaml, du control plane, de Sablier ou du template Nanoploy. En cas de doute sur la destination d'une app web, demande si c'est pour Nanoploy plutôt que de scaffolder du générique.
---

# Nanoploy app

Nanoploy déploie des apps sur un Jetson Nano 4 Go. La plateforme impose une stack
unique et des contraintes dures. Une app qui ne les respecte pas se déploie quand
même, puis casse en silence après la première mise en veille.

## La stack, non négociable

| Couche | Choix |
|---|---|
| Frontend | Vite + React + TypeScript, buildé en statique dans `dist/` |
| Backend | Hono sur Node 20, bundlé en un seul `server.js` par esbuild |
| Base de données | Postgres mutualisé, accès via Drizzle ORM |
| Auth | aucune ligne de code dans l'app, la gateway injecte l'identité |
| Routes API | tout sous `/api/*`, le reste est servi en statique par Caddy |
| Appels API | tous via `src/client.ts`, jamais de `fetch` nu |

Ne propose jamais Next.js, Express, Prisma, Mongo, NextAuth, Passport, Redis ou
un ORM alternatif. Chacun casse un élément de la plateforme.

## Les six contraintes du scale-to-zero

Le conteneur est arrêté après `idle.timeout` et redémarré à la première requête.
Donc, dans le code généré :

1. **Aucun état en mémoire.** Pas de cache local, pas de session en RAM, pas de
   compteur global, pas de Map partagée entre requêtes. Tout va en base.
2. **Aucun `setInterval`, `setTimeout` long ni cron interne.** Une app endormie
   n'exécute rien. Si une tâche périodique est indispensable, dis-le à Théo et
   mets `idle.warm: true` dans le manifest, en expliquant que l'app tournera
   alors en permanence pour ~40 Mo.
3. **Pas de websocket.** Le réveil coupe la connexion. Utilise du polling ou du
   SSE avec reconnexion automatique.
4. **Boot sous une seconde.** Pas de warm-up, pas de chargement de modèle, pas de
   migration au démarrage.
5. **Pool Postgres à `max: 3`.** La base est partagée par toutes les apps et
   chaque connexion est un process forké côté serveur.
6. **Fichiers uploadés dans `/data`**, jamais ailleurs. Le système de fichiers
   du conteneur est monté en lecture seule ; seuls `/data` (volume dédié,
   persistant) et `/tmp` (16 Mo, effacé à chaque réveil) sont inscriptibles.

Le redémarrage de la machine n'est pas un cas particulier : une app endormie et
une app arrêtée par une coupure de courant sont le même état. Le code doit
supporter d'être tué à tout moment sans perdre de données, donc écrire en base
avant de répondre, pas après.

## Le client API

Le premier appel qui réveille une app endormie est répondu par la page
d'attente de sablier (du HTML) au lieu du JSON du backend. La requête n'a donc
jamais atteint le serveur. Tout appel du frontend passe par `src/client.ts`,
qui détecte cette page et réessaie automatiquement. Un `fetch` nu casse en
silence au premier réveil, surtout sur un POST. Ne jamais contourner le client.

## L'identité utilisateur

L'app ne gère pas le login. Caddy authentifie, puis injecte les headers
`Remote-Sub`, `Remote-Email`, `Remote-Name`, `Remote-Groups`. Lis-les via
`server/auth.ts`, jamais à la main.

```typescript
const user = tryGetUser(c);   // null si la requête n'a pas d'identité
```

Une app basculée `public` depuis le dashboard ne reçoit plus aucun header
d'identité. Toute route qui a besoin d'un utilisateur renvoie donc 401 quand
`tryGetUser` retourne null : c'est ce qui évite les 500 en cascade. `getUser(c)`
(qui jette une erreur) ne se justifie que dans une app qui restera toujours
privée.

Toute table appartenant à un utilisateur porte une colonne `ownerId` remplie avec
`user.id`, et toute requête de lecture filtre dessus. C'est ça qui rend le compte
unique utilisable dans toutes les apps.

Ne crée jamais de table `users`, de page de login, de formulaire d'inscription,
de gestion de mot de passe ou de JWT dans une app.

## Le manifest

`app.yaml` à la racine, c'est le seul contrat avec la plateforme.

```yaml
name: Suivi de dépenses
slug: depenses          # devient depenses.<domaine>, [a-z0-9-] uniquement
                        # deploy, auth, id et www sont réservés par la plateforme
access: private         # public | private | groups
groups: []
frontend: true
backend:
  entry: server.js
  port: 3000
database:
  enabled: true
  migrations: ./migrations
idle:
  timeout: 10m
  warm: false           # true seulement si l'app doit tourner en continu
env: [OPENAI_API_KEY]   # noms seulement, les valeurs se saisissent au dashboard
```

`access: private` est le défaut. Ne mets `public` que si Théo le demande
explicitement, et signale-lui que l'app sera alors ouverte à tout internet.

Les secrets ne sont jamais écrits dans le repo : on déclare le nom dans `env`,
Théo saisit la valeur dans le dashboard.

## Procédure

1. **Copier le template.** `cp -r templates/app-template <slug>` depuis le repo
   Nanoploy, ou repartir de sa structure exacte si le repo n'est pas là.
2. **Écrire `app.yaml`** en premier, c'est lui qui cadre le reste.
3. **Définir le schéma** dans `server/schema.ts` avec Drizzle, `ownerId` inclus.
4. **Générer les migrations** : `npm run db:generate`. Elles sont produites sur
   la machine de dev, jamais sur le serveur, et jouées une seule fois au déploiement.
5. **Écrire les routes** dans `server/index.ts`, toutes sous `/api/*`.
6. **Écrire le frontend** dans `src/`, sans logique d'authentification.
7. **Déployer** : `npm run deploy`. Ça build le front, bundle le serveur, zippe
   `dist/ server.js app.yaml migrations/` et poste le tout au control plane.
   Nécessite `NANOPLOY_URL` et `NANOPLOY_TOKEN` dans l'environnement.

Après un déploiement réussi, donne l'URL à Théo et rappelle-lui les variables
d'environnement restant à saisir, s'il y en a.

## Modifier une app existante

Le déploiement remplace l'image et le conteneur, mais **jamais la base**. Un
changement de schéma passe donc par une nouvelle migration : modifie
`server/schema.ts`, relance `npm run db:generate`, vérifie le SQL produit, et
déploie. Ne modifie jamais un fichier de migration déjà déployé, et ne supprime
jamais une colonne sans le dire explicitement à Théo.

## Vérification avant de déclarer que c'est fini

- [ ] aucune variable de module mutée entre deux requêtes
- [ ] aucun timer, aucun cron, aucun websocket
- [ ] `max: 3` sur le pool Postgres
- [ ] toutes les routes sous `/api/*`
- [ ] toute table utilisateur filtrée par `ownerId`
- [ ] aucun code d'authentification dans l'app
- [ ] tous les appels API passent par `src/client.ts`
- [ ] `slug` unique, en minuscules, sans underscore
- [ ] secrets déclarés dans `env`, jamais en dur

## Style de code

Commentaires en anglais. Interface en français. Pas de commentaire qui répète ce
que fait la ligne suivante, seulement ceux qui expliquent une contrainte de la
plateforme ou une décision non évidente.

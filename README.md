# Nanoploy

Un mini Vercel auto-hébergé, taillé pour une machine à 4 Go de RAM.

Les apps déployées dorment par défaut et ne consomment rien. La première requête
les réveille en une seconde. Une seule base Postgres est partagée entre toutes
les apps, avec une database et un rôle isolés par app. Un seul compte donne accès
à toutes les apps, et chaque app peut être basculée publique ou privée en un clic.

## Ce qu'il y a dans la boîte

| Composant | Rôle | RAM au repos |
|---|---|---|
| Caddy + plugin Sablier | routage, front statique, réveil des apps | ~25 Mo |
| Sablier | arrêt et démarrage des conteneurs à la demande | ~15 Mo |
| Postgres 16 | base mutualisée, une database par app | ~60 Mo |
| Pocket ID | fournisseur d'identité, gestion des comptes | ~15 Mo |
| tinyauth v5 | forward-auth devant chaque app privée | ~10 Mo |
| control plane | dépôt de bundle, provisioning, routes | ~50 Mo |
| socket-proxy | accès Docker restreint pour le control plane | ~5 Mo |

Une app réveillée coûte environ 40 Mo et est plafonnée à 256 Mo.

## Préparer la machine

À faire une fois, avant l'installation. Ces trois points sont ce qui casse un
homelab sur carte SD.

1. Déplacer le stockage Docker sur un disque externe, dans
   `/etc/docker/daemon.json` :

   ```json
   {
     "data-root": "/mnt/ssd/docker",
     "log-driver": "json-file",
     "log-opts": { "max-size": "10m", "max-file": "3" }
   }
   ```

   Sur Jetson, ajouter `RequiresMountsFor=/mnt/ssd` à l'unit systemd de Docker,
   sinon un démarrage avant le montage du disque recrée un data-root vide.

2. Passer la machine en headless : `sudo systemctl set-default multi-user.target`
   libère environ 500 Mo sur un Jetson.

3. Sur JetPack 4, mettre à jour `libseccomp2` depuis bionic-backports, sinon les
   images Debian récentes échouent avec des erreurs `Illegal instruction`.

## Installation

```bash
git clone <ce-repo> nanoploy && cd nanoploy
./install.sh          # génère .env, puis s'arrête pour que vous le remplissiez
$EDITOR .env          # APPS_DOMAIN et APPS_DIR
./install.sh          # build et démarre tout
```

`install.sh` génère les secrets (`POSTGRES_PASSWORD`, `POCKETID_ENCRYPTION_KEY`,
`DEPLOY_TOKEN`). `POCKETID_ENCRYPTION_KEY` est exigé par les versions récentes de
Pocket ID, sans lui le conteneur boucle au démarrage.

Ensuite :

1. Créer un tunnel Cloudflare vers `http://localhost:8080`, avec un hostname
   générique `*.apps.exemple.com` et `apps.exemple.com`.
2. Ouvrir `https://id.apps.exemple.com` et créer le compte administrateur.
3. Créer un client OIDC pour tinyauth, callback
   `https://auth.apps.exemple.com/api/oauth/callback/generic`, reporter l'id et
   le secret dans `.env`, puis `docker compose up -d tinyauth`.
4. Créer une clé API dans Pocket ID, la mettre dans `POCKETID_API_KEY`, puis
   `docker compose up -d control-plane`. C'est ce qui active l'onglet Comptes.
5. Mettre `DEPLOY_TOKEN` dans le gestionnaire de mots de passe.

Le token vit dans `.env` et sert aussi de mot de passe du bypass CLI dans la
Caddyfile (comparé en toutes lettres, pas seulement par préfixe). Si vous le
changez, relancez `docker compose up -d caddy`.

## Le dashboard

Deux onglets, sur `deploy.apps.exemple.com`.

**Apps** : jauge des apps réveillées, dépôt de bundle par glisser-déposer, et une
ligne par app. Cliquer sur une ligne ouvre le détail : bascule privé, groupes ou
public, saisie des variables d'environnement, 40 dernières lignes de log, bouton
de réveil et suppression.

**Comptes** : la liste des personnes, avec leurs groupes en pastilles cliquables.
Inviter quelqu'un crée le compte dans Pocket ID et renvoie un lien à usage unique
à lui transmettre. Il n'y a pas de mot de passe, la personne enregistre une clé
d'accès. Créer un groupe ici le rend disponible dans le sélecteur d'accès de
chaque app.

Les comptes vivent uniquement dans Pocket ID, le dashboard ne fait que piloter
son API. Sans `POCKETID_API_KEY`, l'onglet renvoie simplement vers Pocket ID.
Les chemins d'API utilisés (`/api/users`, `/api/user-groups`) dépendent de la
version de Pocket ID, à vérifier si l'onglet renvoie une erreur.

Recommandé : protéger `deploy.apps.exemple.com` avec Cloudflare Access, en plus
de tinyauth. C'est la seule surface qui pilote Docker. Toutes les routes
`/api/*` exigent de toute façon un token valide ou une session, un en-tête
`Authorization` inventé ne suffit plus depuis que Caddy compare le token exact.

## Déployer une app

```bash
cp -r templates/app-template mon-app && cd mon-app
npm install
export NANOPLOY_URL=https://deploy.apps.exemple.com
export NANOPLOY_TOKEN=...
npm run deploy
```

Le build se fait sur la machine de dev. Le serveur ne compile jamais rien de
lourd : il reçoit un zip contenant `dist/`, `server.js`, `app.yaml` et
`migrations/`, construit une image minuscule et lance le conteneur.

Ou, sans terminal : glisser le zip dans le dashboard.

Une app "froide" (le cas par défaut) est **remise en veille immédiatement après
le déploiement** : un conteneur lancé hors d'une session Sablier ne se serait
jamais arrêté tout seul. La première visite affiche la page d'attente une
seconde, puis répond. Seules les apps `idle.warm: true` tournent en permanence.

## La skill

`skills/nanoploy-app/` contient la skill Claude qui connaît la stack, les
contraintes du scale-to-zero et la procédure de déploiement. Une fois installée,
"fais-moi une app qui suit mes dépenses" produit une app conforme et déployable.

Le template embarque `src/client.ts`, un wrapper `fetch` qui retente
automatiquement les requêtes tombées sur la page d'attente de Sablier. Ne pas
l'utiliser est la cause n°1 des apps "qui marchent puis cassent en silence" au
premier réveil.

## Après une coupure de courant

Rien à faire, mais il faut l'avoir installé une fois :

```bash
sudo cp nanoploy.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable nanoploy
```

Ce qui se passe au redémarrage :

1. systemd attend que la baie soit montée, puis relance la plateforme.
2. Les conteneurs d'apps sont toujours là, simplement arrêtés. Les routes Caddy
   aussi, ce sont des fichiers. La première requête sur une app la réveille.
3. Le control plane se réconcilie au démarrage : il relit la table `apps` dans
   Postgres et recrée tout conteneur ou route manquants. Si le data-root Docker
   a été vidé, **les images sont reconstruites depuis le bundle stocké** dans
   `APPS_DIR` (le zip y est conservé), puis les apps froides sont rendormies.

Pour forcer une réconciliation à la main :

```bash
curl -X POST -H "Authorization: Bearer $NANOPLOY_TOKEN" \
  https://deploy.apps.exemple.com/api/reconcile
```

Une app qui doit être disponible instantanément, sans page d'attente, passe en
`idle.warm: true` dans son manifest. Elle sort alors du scale-to-zero, tourne en
permanence et redémarre automatiquement avec la machine. Ça coûte ~40 Mo, donc à
réserver à une ou deux apps.

**Ne jamais faire `docker compose down`.** Ça supprime les réseaux, et les
conteneurs d'apps, qui n'appartiennent pas au projet compose, deviennent
indémarrables. Utiliser `docker compose stop`. Les réseaux sont déclarés en
`external` pour limiter la casse, mais l'habitude reste la bonne.

## Sauvegardes

Rien n'est sauvegardé automatiquement. À mettre en place tout de suite :

```bash
# nightly, one dump per app database
docker compose exec -T postgres pg_dumpall -U postgres | gzip > /mnt/ssd/backups/pg-$(date +%F).sql.gz
```

Plus une copie chiffrée hors site avec restic. Une base mutualisée est un point
de perte unique pour toutes les apps. Côté images, une seule par app est
conservée (prune automatique à chaque déploiement) ; les bundles dans `APPS_DIR`
ne sont supprimés que lorsqu'on supprime l'app.

## Limites connues

- Pas de rollback automatique : un déploiement remplace le conteneur.
- Pas de logs centralisés, `docker logs app-<slug>` fait le travail.
- Le premier réveil d'une app affiche une page d'attente pendant une seconde
  environ (un fetch SPA la contourne via `src/client.ts`, qui retente).
- Les websockets ne survivent pas à une mise en veille, par conception.
- Caddy répond 404 pour tout sous-domaine inconnu, y compris une app supprimée.

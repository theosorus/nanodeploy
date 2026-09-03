# Nanoploy

Un mini Vercel auto-hébergé, taillé pour une machine à 4 Go de RAM.

*[English version](README.md)*

Les apps déployées dorment par défaut et ne consomment rien. La première requête
les réveille en une seconde. Une seule base Postgres est partagée entre toutes
les apps, avec une database et un rôle isolés par app. Un seul compte donne accès
à toutes les apps, et chaque app peut basculer entre privée, réservée à des
groupes et publique en un clic.

Ça tourne sur un Jetson Nano, un Raspberry Pi 4/5, un vieux portable, ou
n'importe quelle machine capable de faire tourner Docker en continu.

## Ce qu'il y a dans la boîte

| Composant | Rôle | RAM au repos |
|---|---|---|
| Caddy + plugin Sablier | routage, front statique, réveil des apps | ~25 Mo |
| Sablier | arrêt et démarrage des conteneurs à la demande | ~15 Mo |
| Postgres 16 | base mutualisée, une database par app | ~60 Mo |
| Pocket ID | fournisseur d'identité, passkeys, comptes | ~15 Mo |
| tinyauth v5 | forward-auth devant chaque app privée | ~10 Mo |
| control plane | dépôt de bundle, provisioning, routes | ~50 Mo |
| socket-proxy | accès Docker restreint, un par consommateur | ~10 Mo |

Une app réveillée coûte environ 40 Mo et est plafonnée à 256 Mo.

## Ce qu'il faut

- Une machine avec Docker et Docker Compose v2, idéalement avec du stockage qui
  n'est pas une carte SD.
- Un domaine à vous, et un wildcard `*.apps.exemple.com` qui pointe vers la
  machine. Un [tunnel Cloudflare](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
  est le plus simple depuis une box ; n'importe quel reverse proxy qui termine
  le TLS fait l'affaire.
- Node 20 sur la machine de dev, pour construire et déployer les apps.

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
git clone https://github.com/<vous>/nanoploy && cd nanoploy
./install.sh          # génère .env, puis s'arrête pour que vous le remplissiez
$EDITOR .env          # APPS_DOMAIN et APPS_DIR
./install.sh          # build et démarre tout
```

`install.sh` génère les secrets (`POSTGRES_PASSWORD`, `POCKETID_ENCRYPTION_KEY`,
`DEPLOY_TOKEN`), vérifie la machine, et refuse de démarrer sur une configuration
qui partirait cassée ou grande ouverte. Le build de Caddy avec le plugin Sablier
compile depuis les sources : environ 10 minutes sur un Jetson.

Ensuite :

1. Pointer le tunnel ou le reverse proxy vers `http://localhost:8080`
   (modifiable par `CADDY_PORT`), avec un hostname générique
   `*.apps.exemple.com` et `apps.exemple.com`.
2. Ouvrir `https://id.apps.exemple.com` et créer le compte administrateur
   Pocket ID.
3. Créer un client OIDC pour tinyauth, callback
   `https://auth.apps.exemple.com/api/oauth/callback/generic`, reporter l'id et
   le secret dans `.env`, puis `docker compose up -d tinyauth`.
4. Créer une clé API dans Pocket ID, la mettre dans `POCKETID_API_KEY`, puis
   `docker compose up -d control-plane`. C'est ce qui active l'onglet Comptes.
5. Ouvrir `https://deploy.apps.exemple.com`, onglet Comptes, et choisir un
   groupe d'administrateurs. Lire la section suivante d'abord.
6. Mettre `DEPLOY_TOKEN` dans le gestionnaire de mots de passe.

Le token vit dans `.env` et sert aussi de mot de passe du bypass CLI dans la
Caddyfile, où il est comparé en toutes lettres. Si vous le changez, relancez les
deux conteneurs qui le portent : `docker compose up -d caddy control-plane`.

## Qui a le droit de piloter la console

Le dashboard déploie du code arbitraire et pilote Docker. Qui peut l'ouvrir a
de fait les pleins pouvoirs sur la machine.

Une installation fraîche est mono-utilisateur, donc **tout compte capable de se
connecter est administrateur**. C'est acceptable tant que vous êtes seul, et le
dashboard l'affiche en rouge jusqu'à ce que ce soit réglé. Deux choses changent
dès que vous n'êtes plus seul :

- Le dashboard refuse de créer un deuxième compte tant qu'aucun groupe
  d'administrateurs n'est défini.
- Une fois défini, seuls les membres de ce groupe atteignent `/api/*` ; les
  autres gardent l'accès aux apps et voient une page « vous n'administrez pas ce
  serveur » sur la console.

Pour le définir : onglet Comptes → créer un groupe (par exemple `admins`) →
cliquer sa pastille sur votre propre ligne pour l'y ajouter → le choisir dans le
panneau rouge → Appliquer. Le control plane vérifie auprès de Pocket ID que vous
appartenez bien au groupe avant d'appliquer : le changement ne peut donc pas
vous verrouiller hors de votre propre console, et il n'attend pas le
rafraîchissement de votre session.

On peut aussi le figer dans `.env` avec `ADMIN_GROUP=admins`, ce qui le rend non
modifiable depuis le dashboard. Le remettre à vide exige le token de déploiement,
volontairement : c'est le seul changement qui rouvre l'accès à tout le monde.

Recommandé en plus : protéger `deploy.apps.exemple.com` avec Cloudflare Access
ou une couche équivalente.

## Le dashboard

Deux onglets, sur `deploy.apps.exemple.com`.

**Apps** : la mémoire réellement utilisée par la machine, une zone de dépôt de
bundle `.zip`, et une ligne par app. Cliquer sur une ligne ouvre le détail :
mode d'accès (privé, groupes, public), variables d'environnement, derniers logs,
réveil et suppression.

**Comptes** : la liste des personnes, avec leurs groupes en pastilles cliquables.
Inviter quelqu'un crée le compte dans Pocket ID et renvoie un lien à usage unique
à lui transmettre. Il n'y a pas de mot de passe, la personne enregistre une clé
d'accès. Créer un groupe ici le rend disponible dans le sélecteur d'accès de
chaque app.

Les comptes vivent uniquement dans Pocket ID, le dashboard ne fait que piloter
son API. Sans `POCKETID_API_KEY`, l'onglet renvoie simplement vers Pocket ID.
Les chemins d'API utilisés (`/api/users`, `/api/user-groups`) dépendent de la
version de Pocket ID, à vérifier si l'onglet renvoie une erreur.

**Isolation** : chaque app tourne en conteneur non-root, capabilities retirées,
système de fichiers racine en lecture seule, `/data` sur un volume dédié et RAM
plafonnée, sur un réseau qui ne contient que Caddy et Postgres. Le socket
Docker, Sablier, tinyauth et le control plane ne sont pas joignables depuis une
app. Voir [SECURITY.md](SECURITY.md) pour la liste complète des frontières et
des limites assumées.

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

Une app « froide » (le cas par défaut) est **remise en veille immédiatement après
le déploiement** : un conteneur lancé hors d'une session Sablier ne se serait
jamais arrêté tout seul. Le HTML et les assets sont servis instantanément par
Caddy sans réveiller l'app ; seule la première requête `/api/*` déclenche le
réveil, avec une page d'attente d'une seconde que le wrapper `src/client.ts`
retente en silence. Seules les apps `idle.warm: true` tournent en permanence.

Les sous-domaines `deploy`, `auth`, `id` et `www` sont réservés par la
plateforme et refusés comme slug.

## La skill

`skills/nanoploy-app/` contient la skill Claude qui connaît la stack, les
contraintes du scale-to-zero et la procédure de déploiement. Une fois installée,
« fais-moi une app qui suit mes dépenses » produit une app conforme et
déployable.

Le template embarque `src/client.ts`, un wrapper `fetch` qui retente
automatiquement les requêtes tombées sur la page d'attente de Sablier. Ne pas
l'utiliser est la cause n°1 des apps « qui marchent puis cassent en silence » au
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
   Postgres et recrée tout conteneur, image ou route manquant. Les images sont
   reconstruites depuis le bundle stocké dans `APPS_DIR` (les fichiers extraits
   y vivent, pas le zip), puis les apps froides sont rendormies. Le heal couvre
   aussi le cas d'une image supprimée à la main pendant que l'app dormait.

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
de perte unique pour toutes les apps, et les secrets des apps y dorment en
clair : chiffrez ces dumps. Côté images, une seule par app est conservée (prune
automatique à chaque déploiement) ; les bundles dans `APPS_DIR` ne sont
supprimés que lorsqu'on supprime l'app.

## Limites connues

- Pas de rollback automatique : un déploiement remplace le conteneur.
- Pas de logs centralisés, `docker logs app-<slug>` fait le travail.
- Les variables d'env et le mot de passe de base d'une app dorment en clair
  dans la table `apps` du Postgres de contrôle (acceptable sur un homelab,
  à garder en tête pour les sauvegardes).
- Le premier réveil d'une app affiche une page d'attente pendant une seconde
  environ (un fetch SPA la contourne via `src/client.ts`, qui retente).
- Les websockets ne survivent pas à une mise en veille, par conception.
- Caddy répond 404 pour tout sous-domaine inconnu, y compris une app supprimée.
- Les apps se voient entre elles sur le réseau partagé : ne pas y héberger de
  données sensibles à côté d'une app ouverte à des inconnus.
- Supprimer une app conserve sa base Postgres mais efface son volume `/data`.

## Licence

MIT, voir [LICENSE](LICENSE). Contributions bienvenues, voir
[CONTRIBUTING.md](CONTRIBUTING.md).

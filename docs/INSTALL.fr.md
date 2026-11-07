# Installer Nanodeploy

[English](INSTALL.md) · [Présentation](../README.md) · [Mise à jour d'un serveur existant](UPGRADING.md)

Nanodeploy s'installe sur votre propre serveur Linux, à domicile ou chez un
hébergeur. Aucun compte du créateur du projet, matériel particulier ou service
cloud n'est nécessaire. Le code et la documentation sont sous
[licence MIT](../LICENSE). Les polices incluses conservent leur licence OFL.

## Prérequis

- Un serveur Linux **64 bits, x86-64 ou ARM64** : VPS, mini PC ou carte ARM.
  Prévoyez **4 Go de RAM et 20 Go sur SSD**, davantage selon vos applications
  et les builds Git. Aucun GPU n'est nécessaire.
- Un **Docker Engine 28+ à jour**, installé sur cette machine, et **Compose v2**.
  L'installateur utilise Docker avec les privilèges habituels du démon ;
  Docker rootless, Podman, Swarm et les démons distants ne sont pas pris en charge.
- Git, Bash et OpenSSL. Python 3, curl et `flock` pour les mises à jour
  automatiques facultatives. Le script de sauvegarde utilise Bash 4+ et les
  outils Linux.
- Pour publier sur Internet : votre domaine, un DNS wildcard et un reverse
  proxy ou tunnel qui termine HTTPS. Le fournisseur est libre.
- **Node.js 24, npm et `zip` uniquement sur le poste qui développe les apps**.
  Le serveur utilise le Node fourni par les images Docker.

Suivez les guides officiels pour [Docker](https://docs.docker.com/engine/install/)
et [Compose](https://docs.docker.com/compose/install/linux/). Sur Debian/Ubuntu :

```bash
sudo apt-get update
sudo apt-get install git openssl python3 curl util-linux
docker info
docker compose version
```

Utilisez le même compte pour cloner le dépôt et lancer les commandes Docker.
Après l'ajout éventuel au groupe Docker, reconnectez-vous. Conservez un noyau
Linux récent et placez les données Docker et celles des apps sur un stockage
persistant. Le chemin standard `/var/lib/docker` convient s'il est sur SSD.
Il n'est pas nécessaire d'avoir un disque monté sous un nom particulier.
Le premier build nécessite un accès Internet aux registres de paquets et
d'images, ainsi qu'aux modules Go utilisés pour construire Caddy.

Une seule installation Nanodeploy peut utiliser un même démon Docker. Pour
un essai sur macOS ou Windows/WSL2, Docker Desktop en mode conteneurs Linux
convient ; les instructions de production visent Linux.

## Essayer en local, sans domaine

```bash
git clone https://github.com/theosorus/nanodeploy.git
cd nanodeploy
./install.sh --local
```

Le script génère un `.env` privé avec des secrets aléatoires, utilise `var/apps`
pour les applications, construit les images et démarre la plateforme. Le premier
build de Caddy peut prendre plusieurs minutes. Aucun Node n'est requis sur
l'hôte. Vous pouvez relancer la commande : les secrets existants sont conservés.

Récupérez le lien de création de votre compte administrateur :

```bash
docker compose logs control-plane | grep -A1 SETUP
```

Ouvrez ce lien, choisissez un identifiant et un mot de passe, puis ouvrez
**<http://deploy.apps.localhost:8080>**. La page de compte est à
<http://auth.apps.localhost:8080>. Les navigateurs récents résolvent
`*.localhost` vers votre machine. Sinon, ajoutez ces noms au fichier hosts
de la machine où tourne le navigateur :

```text
127.0.0.1 auth.apps.localhost deploy.apps.localhost my-app.apps.localhost
```

Ajoutez le nom de chaque nouvelle app si nécessaire. Cet essai utilise HTTP et
la connexion par mot de passe. Utilisez HTTPS pour une installation publique
et pour les passkeys. Le port de la plateforme reste lié à `127.0.0.1`.

Pour choisir un autre port : lancez d'abord `./install.sh --init --local`,
modifiez **`CADDY_PORT` et `PUBLIC_PORT`** dans `.env`, puis lancez
`./install.sh`. Le mode local ne convertit jamais une configuration existante.

## Installer sur votre serveur

### 1. Préparer la configuration

Sur le serveur :

```bash
git clone https://github.com/theosorus/nanodeploy.git
cd nanodeploy
./install.sh --init
```

Cette étape génère `.env` et ses secrets, sans démarrer de service et sans
nécessiter Docker. Une copie de `.env.example` fonctionne aussi : `--init`
remplit les secrets vides et conserve les valeurs existantes.

Modifiez `.env` avec votre éditeur :

```dotenv
APPS_DOMAIN=apps.example.com
PUBLIC_SCHEME=https
COOKIE_SECURE=true
TIMEZONE=UTC
```

Remplacez `apps.example.com` par **votre domaine**, sans protocole, port,
wildcard ou chemin. Choisissez votre fuseau horaire, par exemple `Europe/Paris`.

Le stockage `APPS_DIR` est, par défaut, le chemin absolu de `var/apps` dans
votre copie du dépôt. Vous pouvez conserver ce choix. Pour un autre disque,
utilisez un chemin absolu et donnez les droits d'écriture au compte qui lance
l'installation. Exemple :

```bash
sudo install -d -m 755 -o "$(id -un)" -g "$(id -gn)" /srv/nanodeploy/apps
```

Puis définissez `APPS_DIR=/srv/nanodeploy/apps`. Entourez de guillemets un chemin
contenant des espaces. `.env` est lu par Bash et Compose : utilisez de simples
affectations `NOM=valeur`.

### 2. Démarrer

```bash
./install.sh --check
./install.sh
docker compose ps
```

`--check` vérifie la configuration et Docker sans modifier les fichiers ni les
services. L'installation crée les réseaux, construit les images puis démarre
la plateforme. Le service d'authentification peut redémarrer brièvement pendant
la création de son rôle PostgreSQL.

Une installation neuve n'a pas besoin de Pocket ID. Pour reprendre une ancienne
installation, suivez [UPGRADING.md](UPGRADING.md) avant de continuer.

### 3. Configurer DNS et HTTPS

La plateforme écoute en HTTP sur **`127.0.0.1:8080`**. Configurez devant elle
votre reverse proxy ou votre tunnel HTTPS :

1. Le DNS **`*.apps.example.com`** doit mener à votre serveur ou à votre tunnel.
2. Tous ces noms doivent arriver à `http://127.0.0.1:8080`, en conservant
   l'en-tête `Host` et le protocole public dans `X-Forwarded-Proto`.
3. Le certificat doit couvrir **`*.apps.example.com`**. Un certificat pour
   `*.example.com` ne couvre pas ce niveau supplémentaire.

Le domaine de base n'a pas de page d'accueil ; une réponse 404 y est normale.
La console est à `deploy.<APPS_DOMAIN>`, les comptes à `auth.<APPS_DOMAIN>` et
chaque app à `<slug>.<APPS_DOMAIN>`.

Un [exemple Nginx](../examples/nginx.conf) est fourni pour un proxy installé sur
l'hôte. Remplacez le domaine et les chemins du certificat, puis vérifiez avec
`sudo nginx -t` avant de recharger Nginx. Les certificats wildcard utilisent
la validation [DNS-01](https://letsencrypt.org/docs/challenge-types/#dns-01-challenge).

Un tunnel est également possible, sans ouvrir de port sur le routeur. Avec
Cloudflare, configurez le routage wildcard **et** le DNS correspondant ; vérifiez
que le certificat couvre la profondeur du domaine choisi. Conservez le Host
d'origine. Pour recevoir les déploiements Git, une éventuelle protection externe
de la console doit laisser passer `/hooks/`.

Configurez `TRUSTED_PROXY_CIDRS` avec les adresses réelles du proxy **vues par
Caddy**. Docker peut remplacer l'adresse loopback par celle de la passerelle
du réseau. Après le déploiement d'une app, vérifiez `remote_ip` dans :

```bash
docker compose exec caddy tail -n 5 /var/log/caddy/apps.log
docker network inspect nanodeploy_edge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

Ajoutez seulement l'adresse précise avec `/32`, puis exécutez
`docker compose up -d caddy`. Ne faites pas confiance à toutes les plages privées.
Un proxy dans un autre conteneur ne peut pas utiliser son propre `localhost`
pour joindre le loopback de l'hôte. Les options de raccordement et des exemples
détaillés sont dans le [guide réseau](INSTALL.md#https-and-dns).

### 4. Créer le compte administrateur

```bash
docker compose logs control-plane | grep -A1 SETUP
```

Ouvrez le lien complet, créez votre identifiant et votre mot de passe, puis
ajoutez une passkey depuis votre compte si vous le souhaitez. Aucun compte ou
mot de passe fixe n'est fourni. Le lien SETUP est un secret à usage unique.

Ouvrez ensuite `https://deploy.<APPS_DOMAIN>`. La console demande de confirmer
votre connexion avant d'accorder sa session. L'onglet **Utilisateurs** permet
d'inviter d'autres personnes. Nanodeploy n'envoie pas d'email : transmettez
vous-même leurs liens d'invitation.

## Déployer votre première app

Sur votre poste de développement, avec Node.js 24 et `zip` :

```bash
cp -R templates/app-template ../my-app
cd ../my-app
npm ci
```

Dans `app.yaml`, définissez `name: My app` et `slug: my-app`. Conservez
`access: private`. Préparez la table de notes du modèle :

```bash
npm run db:generate
```

Dans la console, choisissez **Nouvelle application → Terminal et agents** et
créez une clé de déploiement pour le slug `my-app`, puis :

```bash
export NANODEPLOY_URL=https://deploy.apps.example.com
export NANODEPLOY_TOKEN=ndd_REMPLACEZ_PAR_VOTRE_CLE
npm run deploy -- -m "Premier déploiement"
```

Utilisez votre domaine, ou `http://deploy.apps.localhost:8080` pour l'essai local.
Ouvrez l'URL retournée, connectez-vous et ajoutez une note. Elle reste en base
après la mise en veille du backend. La clé et `app.yaml` doivent utiliser le
même slug. Gardez le jeton global `DEPLOY_TOKEN` sur le serveur.
Le [guide du modèle](../templates/app-template/README.md) détaille le développement.

## Démarrage automatique et maintenance

Sur un serveur Linux avec systemd :

```bash
./scripts/configure-systemd.sh
cat var/systemd/nanodeploy.service
sudo cp var/systemd/nanodeploy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nanodeploy.service
```

Le générateur utilise vos chemins, votre utilisateur et le répertoire de données
Docker. Les fichiers produits sont ignorés par Git. L'option `--user UTILISATEUR`
permet de choisir un autre compte local autorisé à gérer Docker et ces fichiers.
Sans systemd, utilisez votre superviseur pour lancer `docker compose up -d`.
Les mises à jour automatiques sont **facultatives et désactivées par défaut** ;
voir [UPGRADING.md](UPGRADING.md).

Commandes utiles :

```bash
docker compose logs --tail=100 gate control-plane
docker compose stop
docker compose up -d
./scripts/backup.sh
```

La sauvegarde comprend les bases et rôles PostgreSQL, les fichiers des apps,
leurs volumes `/data`, les volumes de la plateforme, `.env` et le commit Git.
Par défaut, cinq copies sont conservées dans `backups` à côté de `APPS_DIR`.
`BACKUP_DIR` et `BACKUP_KEEP` changent ce comportement. Conservez une copie
chiffrée hors du serveur. Aucune planification de sauvegarde n'est activée
automatiquement. Pour synchroniser les fichiers et la base d'une app qui écrit
dans les deux, arrêtez son backend pendant la sauvegarde.

Conservez **`NANODEPLOY_SECRET_KEY` avec sa base** : la remplacer rend les
secrets chiffrés illisibles. Consultez la
[procédure de restauration](OPERATIONS.md#restore-a-backup).
Pour un arrêt normal, utilisez `stop`. N'utilisez pas `down -v`, le nettoyage
des volumes ou la suppression du stockage comme procédure de mise à jour.

## En cas de problème

| Symptôme | Vérification |
| --- | --- |
| Docker inaccessible | `docker info` avec le même utilisateur, démon démarré, contexte local Linux. |
| Droits insuffisants sur le stockage | Conservez `var/apps` ou créez le dossier avec le propriétaire approprié. |
| Port 8080 occupé | Modifiez `CADDY_PORT`, le proxy et, en local, `PUBLIC_PORT`. |
| Nom de serveur introuvable | Vérifiez le DNS wildcard et pas seulement la règle de tunnel. |
| Erreur de certificat | Le certificat doit couvrir `*.<APPS_DOMAIN>` au bon niveau. |
| Page vide ou 404 | Utilisez le sous-domaine `deploy` ; vérifiez que le proxy conserve Host. |
| Boucle de connexion | Vérifiez protocole, port public, cookies et proxy de confiance ; relancez `docker compose up -d`. |
| Lien SETUP absent | Regardez les logs de Postgres et du control plane ; attendez leur démarrage. |
| Table de notes absente | Générez les migrations et redéployez avec `migrations/`. |
| Clé refusée avec 403 | Le slug de la clé doit correspondre à `app.yaml`. |
| Premier appel API en HTML | L'app se réveille ; utilisez le client du modèle, qui réessaie. |
| Appel sortant bloqué | Le client HTTP doit utiliser le proxy ; les destinations privées et le TCP brut sont bloqués. |

Pour signaler un problème, indiquez OS, architecture, versions Docker/Compose,
commande et logs expurgés. Ne publiez jamais `.env`, une sauvegarde, un lien
d'invitation ou une clé. Plus de détails dans le [guide anglais](INSTALL.md#troubleshooting),
[CONTRIBUTING.md](../CONTRIBUTING.md) et [SECURITY.md](../SECURITY.md).

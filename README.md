# ANRAN Timelapse

Application web auto-hébergée (Docker) qui pilote une caméra ANRAN solaire/batterie
via le cloud Meari/CloudEdge : réveil planifié de la caméra, capture d'images via
le flux P2P, assemblage en timelapse MP4, le tout consultable dans un navigateur.

Conçue pour le cas « caméra solaire qui dort + NAS distant » : aucune machine
n'est requise sur le réseau de la caméra.

## Comment ça marche

1. **Auth cloud** — login ANRAN (plateforme Meari, partnerId 84) avec un compte
   dédié sur lequel la caméra est partagée.
2. **Réveil** — chaque capture ouvre un flux : la plateforme réveille la caméra
   (deep-dormancy réessayée automatiquement ~45 s).
3. **Capture P2P** — flux vidéo (VVP/PPStrong, NAT punch ou relais TURN)
   enregistré quelques secondes, puis extraction d'1 à N frames JPEG.
4. **Assemblage** — les frames du jour sont assemblées en MP4 (ffmpeg, H.264)
   à l'heure planifiée, ou à la demande depuis l'interface.

Le protocole P2P et l'API cloud sont implémentés par le projet MIT
[Ha-CloudEdge-Meari](https://github.com/ajeanney/Ha-CloudEdge-Meari)
(intégré comme harness, commit épinglé dans le Dockerfile).

## Image Docker

Une image multi-architecture (`linux/amd64`, `linux/arm64`) est construite par
GitHub Actions et publiée sur GitHub Container Registry :

```
ghcr.io/beungoud/anran-timelapse:latest     # branche main
ghcr.io/beungoud/anran-timelapse:1.2.3      # tag git v1.2.3
ghcr.io/beungoud/anran-timelapse:sha-abc1234
```

Le workflow (`.github/workflows/docker.yml`) n'utilise que le `GITHUB_TOKEN`
fourni automatiquement : aucun secret à configurer. Les identifiants ANRAN ne
sont jamais dans l'image, ils sont lus au démarrage depuis le fichier `.env`.

## Installation sur un NAS Synology (Container Manager)

1. Dans **File Station**, créer le dossier `/docker/anran-timelapse`.
2. Y déposer [`synology/docker-compose.yml`](synology/docker-compose.yml) et une
   copie de [`synology/.env.example`](synology/.env.example) renommée en `.env`,
   puis y renseigner `MEARI_EMAIL` / `MEARI_PASSWORD` du compte **dédié**.
3. **Container Manager → Projet → Créer** : nom `anran-timelapse`, chemin
   `/docker/anran-timelapse`, « Utiliser le docker-compose.yml existant ».
4. Ouvrir `http://<ip-du-nas>:8787`.

Mise à jour : **Projet → anran-timelapse → Action → Construire** (re-télécharge
`latest`), ou en SSH : `docker compose pull && docker compose up -d`.

> Fichiers cachés : File Station n'affiche pas `.env` par défaut. Le plus simple
> est de créer le fichier en SSH (`sudo vi /volume1/docker/anran-timelapse/.env`)
> ou de le téléverser depuis l'ordinateur.

## Déploiement depuis les sources (tout serveur Docker)

```bash
cp .env.example .env
nano .env        # MEARI_EMAIL / MEARI_PASSWORD du compte DÉDIÉ
docker compose up -d --build
# http://<serveur>:8787
```

## Prérequis compte

- Créer un **2e compte ANRAN** (autre email) dans l'app officielle.
- Depuis le compte principal : réglages de la caméra → **Partager** → vers le 2e compte.
- Renseigner ce 2e compte dans `.env`.

> Le broker MQTT de Meari n'autorise qu'une session live par compte : un compte
> dédié évite que l'application éjecte les notifications du téléphone (et inversement).

## Séries de timelapse

L'application gère plusieurs **séries** indépendantes (onglet Réglages). Deux
séries sont créées par défaut :

| Série | Déclenchement | Seuil batterie | Vidéo |
|---|---|---|---|
| **Horaire** | une image par heure (plage horaire réglable) | pause sous 80 % | une vidéo par jour |
| **Midi · météo & neige** | chaque jour à 12:00, 2 relances si échec | aucun | une vidéo de toute la période (`complet`) |

- **Intervalle régulier** : une image toutes les X minutes, alignée sur l'horloge
  (60 min → 08:00, 09:00…), éventuellement limitée à une plage (ex. 07:00–19:00).
- **Heures fixes** : une ou plusieurs heures par jour ; en cas d'échec, nouvelles
  tentatives toutes les 5 min pendant 2 h.
- Si plusieurs séries tombent au même moment, **un seul réveil** de la caméra
  alimente toutes les séries concernées.
- **Seuil batterie** : sous le seuil, les captures de la série sont ignorées
  (et journalisées) ; elle reprend au seuil + la marge (5 % par défaut).
  La batterie est relevée dans le cloud toutes les 15 min et après chaque
  capture, sans réveiller la caméra.

> Le niveau de batterie n'est mis à jour côté cloud que lorsque la caméra se
> manifeste (réveil, détection). Une série en pause compte donc sur les autres
> réveils (ex. la capture de midi) pour constater que la batterie est remontée.

## Réglages globaux

| Réglage | Défaut | Description |
|---|---|---|
| Qualité | SD | SD = 640×360 H.264 ; QHD = 2304×1296 HEVC (plus fragile/lent) |
| Durée du flux | 30 s | ≥ 25 s : l'enregistreur analyse ~20 s de flux avant d'écrire |
| Assemblage automatique | 23:55 | Génère la vidéo du jour (intervalle) et `complet` (heures fixes) |
| Relevé batterie | 15 min | Fréquence de lecture du niveau de batterie |
| Marge de reprise | 5 % | Hystérésis du seuil batterie |

## Structure des données (`./data`)

```
data/
├── series/<id>/frames/YYYY/MM/DD/HHMMSS.jpg   # images de la série
├── series/<id>/videos/<nom>.mp4                # YYYY-MM-DD, complet, début_fin
├── settings.json                               # réglages globaux + séries
├── captures.jsonl                              # journal des captures (60 j)
├── battery.jsonl                               # historique batterie (60 j)
└── scheduler-state.json
```

Les données de l'ancienne version (`data/frames`, `data/timelapses`) sont
déplacées automatiquement dans la série « Horaire » au démarrage.

## Développement local

```bash
# Backend (Python 3.12+)
cd backend
python -m venv .venv && .venv/bin/pip install -r requirements.txt
HARNESS_DIR=/chemin/vers/Ha-CloudEdge-Meari DATA_DIR=../data \
  MEARI_EMAIL=... MEARI_PASSWORD=... MEARI_PROFILE=anran \
  .venv/bin/uvicorn app.main:app --port 8787

# Frontend (Vite proxy /api et /media → 8787)
cd frontend && npm install && npm run dev
```

## Crédits et avertissements

- Protocole : [ajeanney/Ha-CloudEdge-Meari](https://github.com/ajeanney/Ha-CloudEdge-Meari) (MIT).
- Issu du reverse engineering de l'APK ANRAN 6.3.0 (`com.anran.arcloud`,
  plateforme Meari/PPStrong weeye) pour interopérabilité, conformément à la
  directive 2009/24/CE. Projet non officiel, sans affiliation avec ANRAN/Meari.
- Les API cloud peuvent changer sans préavis ; l'usage d'un compte dédié limite
  les risques (banniment, éjection de session).
- Chaque capture consomme de la batterie : adapter l'intervalle à l'ensoleillement.

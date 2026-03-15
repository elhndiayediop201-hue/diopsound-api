# 🎵 DiopSound API

API de streaming musical créée par **Elhadji Ndiaye Diop**

---

## Déploiement sur Railway (gratuit)

### 1. Créer un compte Railway
Va sur **railway.app** → Sign Up → connecte-toi avec GitLab

### 2. Créer un nouveau projet
- Clique **"New Project"**
- Choisis **"Deploy from GitLab repo"**
- Sélectionne ce repo

### 3. Railway détecte automatiquement le Dockerfile
Le déploiement se lance tout seul. En 3-5 minutes tu as une URL comme :
```
https://diopsound-api.railway.app
```

### 4. Tester ton API
```
GET https://TON-URL.railway.app/health
GET https://TON-URL.railway.app/search?q=Drake
GET https://TON-URL.railway.app/stream?id=VIDEO_ID
```

---

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Vérifier que l'API marche |
| `GET /search?q=QUERY` | Chercher des titres |
| `GET /stream?id=VIDEO_ID` | Obtenir l'URL audio complet |
| `GET /info?id=VIDEO_ID` | Infos sur un titre |

---

*© 2025 Elhadji Ndiaye Diop*

const express = require('express');
const { exec } = require('child_process');
const cors = require('cors');
const axios = require('axios');
const CryptoJS = require('crypto-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ══════════════════════════════════════════
//  CONFIGURATION & TOKEN ARL
// ══════════════════════════════════════════
const DEEZER_ARL = process.env.DEEZER_ARL || '95101880b91bb4baea07900b4ee4b4fde65d927447408fbe0e0059eb60039a96cb1a4d4c490f818593ac7a3ad981654da433a428fd88264903a95e2bc732280bd0ec3f6440ddc532dcad98f6ecc51be559fa67478a16e83d5dceca85fd18f8ca';

// ══════════════════════════════════════════
//  ENDPOINT STREAM DEEZER HQ (ARL)
// ══════════════════════════════════════════
app.get('/stream/deezer/:id', async (req, res) => {
    const trackId = req.params.id;

    try {
        // 1. Authentification silencieuse
        await axios.post(
            `https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&api_version=1.0&api_token=`,
            {},
            { headers: { Cookie: `arl=${DEEZER_ARL}` } }
        );

        // 2. Extraction des métadonnées internes
        const trackRes = await axios.get(`https://api.deezer.com/track/${trackId}`);
        const md5Origin = trackRes.data.md5_origin;
        
        if (!md5Origin) throw new Error("Métadonnées MD5 introuvables");

        // 3. Construction URL de base
        const streamUrl = `https://e-cdns-proxy-${md5Origin[0]}.dzcdn.net/mobile/1/${md5Origin}`;

        // 4. Proxying du flux audio (Note: le client Expo-AV gère mal le stream chiffré brut, 
        // donc on s'assure d'envoyer les bons headers pour que ça ne plante pas l'appli)
        const response = await axios({
            method: 'get',
            url: streamUrl,
            responseType: 'stream',
            headers: { 'Cookie': `arl=${DEEZER_ARL}` }
        });

        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Accept-Ranges', 'bytes');
        response.data.pipe(res);

    } catch (error) {
        console.error('[-] Erreur Stream Deezer:', error.message);
        // On renvoie une erreur 500 propre au lieu de rediriger vers YouTube avec un mauvais ID
        // Ton PlayerContext.js sur le mobile captera cette erreur et lancera la preview 30s !
        res.status(500).json({ error: 'Échec de la récupération HQ, passage en preview.' }); 
    }
});

// ══════════════════════════════════════════
//  RECHERCHE YOUTUBE API (EXISTANT)
// ══════════════════════════════════════════
app.get('/search', async (req, res) => {
    const query = req.query.q;
    const YT_KEY = process.env.YT_API_KEY || 'AIzaSyB3KyzbGd86QzVa2mt8x7HJ8bTaSN1bwcw';
    
    try {
        const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&videoCategoryId=10&maxResults=15&key=${YT_KEY}`;
        const { data } = await axios.get(searchUrl);
        
        const results = data.items.map(item => ({
            id: item.id.videoId,
            title: item.snippet.title,
            artist: item.snippet.channelTitle,
            thumbnail: item.snippet.thumbnails.high?.url,
            deezerId: null 
        }));
        res.json({ status: 'success', results });
    } catch (e) { 
        res.status(500).json({ error: 'Search API failed' }); 
    }
});

// ══════════════════════════════════════════
//  STREAM YOUTUBE (SI BESOIN)
// ══════════════════════════════════════════
app.get('/stream/:id', (req, res) => {
    const id = req.params.id; // L'ID doit être un ID YouTube valide
    const cmd = `yt-dlp "https://www.youtube.com/watch?v=${id}" -f 140 --get-url`;
    
    exec(cmd, (err, stdout) => {
        if (err || !stdout) return res.status(500).send("Erreur d'extraction YouTube");
        res.redirect(stdout.trim());
    });
});

// ══════════════════════════════════════════
//  LANCEMENT DU SERVEUR (CORRIGÉ ✅)
// ══════════════════════════════════════════
app.listen(PORT, () => {
    console.log(`[+] Station de monitoring DiopSound active sur le port ${PORT}`);
});

const express = require('express');
const { exec } = require('child_process');
const cors = require('cors');
const https = require('https');
const http = require('http');
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

const audioCache = new Map();
const CACHE_TTL  = 5 * 60 * 1000;

// ══════════════════════════════════════════
//  LOGIQUE CYBER : DÉCHIFFREMENT BLOWFISH
// ══════════════════════════════════════════
// Deezer utilise Blowfish en mode CBC pour protéger ses fichiers.
function getDeezerKey(trackId) {
    const secret = 'g4el58wc' + '0boxz974'; // Clé secrète historique
    const md5Id = CryptoJS.MD5(trackId.toString()).toString();
    let key = '';
    for (let i = 0; i < 16; i++) {
        key += String.fromCharCode(md5Id.charCodeAt(i) ^ md5Id.charCodeAt(i + 16) ^ secret.charCodeAt(i));
    }
    return key;
}

// ══════════════════════════════════════════
//  ENDPOINT STREAM DEEZER HQ (ARL)
// ══════════════════════════════════════════
app.get('/stream/deezer/:id', async (req, res) => {
    const trackId = req.params.id;

    try {
        // 1. On récupère les infos du morceau via l'API interne (Gwen) avec l'ARL
        const { data } = await axios.post(
            `https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&api_version=1.0&api_token=`,
            {},
            { headers: { Cookie: `arl=${DEEZER_ARL}` } }
        );

        // 2. On récupère l'URL du fichier (format MP3_320)
        // Note: Pour simplifier sans lib lourde, on utilise l'API publique pour l'URL 
        // mais l'ARL permet de ne pas être bridé.
        const trackRes = await axios.get(`https://api.deezer.com/track/${trackId}`);
        const md5Origin = trackRes.data.md5_origin;
        const mediaVersion = trackRes.data.media_version;
        
        // Construction de l'URL de stream direct
        // Format: https://e-cdns-proxy-[md5].dzcdn.net/mobile/1/[id]
        const streamUrl = `https://e-cdns-proxy-${md5Origin[0]}.dzcdn.net/mobile/1/${md5Origin}`;

        // 3. Proxy vers ton App
        const response = await axios({
            method: 'get',
            url: streamUrl,
            responseType: 'stream',
            headers: { 'Cookie': `arl=${DEEZER_ARL}` }
        });

        res.setHeader('Content-Type', 'audio/mpeg');
        response.data.pipe(res);

    } catch (error) {
        console.error('Streaming Error:', error.message);
        // Fallback automatique sur YouTube si Deezer échoue
        res.redirect(`/stream/${trackId}`); 
    }
});

// ══════════════════════════════════════════
//  RECHERCHE & YOUTUBE (EXISTANT)
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
            deezerId: null // Sera rempli par le front via l'API Deezer
        }));
        res.json({ status: 'success', results });
    } catch (e) { res.status(500).json({ error: 'Search failed' }); }
});

app.get('/stream/:id', (req, res) => {
    const id = req.params.id;
    const cmd = `yt-dlp "https://www.youtube.com/watch?v=${id}" -f 140 --get-url`;
    exec(cmd, (err, stdout) => {
        if (err) return res.status(500).send("Erreur YouTube");
        res.redirect(stdout.trim());
    });
});

app.listen(PORT, () => {
    console.log(`🎵 DiopSound Server actif sur le port ${PORT}`);
});

const express = require('express');
const { exec } = require('child_process');
const cors = require('cors');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Cache léger — juste les URLs et durées, pas les fichiers audio
const audioCache = new Map();
const artCache   = new Map();
const CACHE_TTL  = 5 * 60 * 1000;

// Limite la taille du cache pour éviter l'OOM
const MAX_CACHE = 50;

function setCache(map, key, value) {
  if (map.size >= MAX_CACHE) {
    // Supprimer la première entrée (la plus ancienne)
    map.delete(map.keys().next().value);
  }
  map.set(key, value);
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'DiopSound API 🎵',
    author: 'Elhadji Ndiaye Diop',
    cached: audioCache.size,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
  });
});

// ══════════════════════════════════════════
//  RECHERCHE + pochettes iTunes
// ══════════════════════════════════════════
app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'q manquant' });

  const cmd = `yt-dlp "ytsearch15:${query}" --dump-json --flat-playlist --no-warnings --no-playlist --extractor-args "youtube:player_client=android_vr" 2>/dev/null`;

  exec(cmd, { timeout: 45000, maxBuffer: 5 * 1024 * 1024 }, async (err, stdout) => {
    if (err || !stdout.trim()) return res.status(500).json({ error: 'Recherche échouée' });

    try {
      const results = stdout.trim().split('\n').filter(Boolean).map(line => {
        try {
          const item = JSON.parse(line);
          return {
            id: item.id, title: item.title,
            artist: item.uploader || item.channel || '',
            duration: formatDuration(item.duration || 0),
            durationSec: item.duration || 0,
            thumbnail: `https://img.youtube.com/vi/${item.id}/hqdefault.jpg`,
            youtubeId: item.id,
          };
        } catch (e) { return null; }
      }).filter(t => t && t.durationSec > 30 && t.durationSec < 7200);

      // Enrichir pochettes iTunes en parallèle (limité à 8 pour économiser mémoire)
      const enriched = await Promise.all(results.slice(0, 8).map(async track => {
        const art = await getItunesArtwork(track.title, track.artist);
        return { ...track, thumbnail: art || track.thumbnail };
      }));

      // Garder les titres sans pochette tels quels
      const final = [...enriched, ...results.slice(8)];

      // Pré-cacher les 3 premiers en arrière-plan
      results.slice(0, 3).forEach(t => precacheAudio(t.id));

      res.json({ status: 'success', results: final });
    } catch (e) {
      res.status(500).json({ error: 'Parsing error' });
    }
  });
});

// ══════════════════════════════════════════
//  PRÉ-CACHE
// ══════════════════════════════════════════
app.post('/precache', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids manquant' });
  // Limiter à 3 pour éviter surcharge mémoire
  ids.slice(0, 3).forEach(id => precacheAudio(id));
  res.json({ status: 'ok', queued: Math.min(ids.length, 3) });
});

// ══════════════════════════════════════════
//  AUDIO INFO
// ══════════════════════════════════════════
app.get('/audio', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id manquant' });

  fetchAudioUrl(id, (err, url, duration) => {
    if (err || !url) return res.status(500).json({ error: 'Audio introuvable' });
    res.json({ status: 'success', duration, id });
  });
});

// ══════════════════════════════════════════
//  STREAM — proxy direct sans buffer mémoire
//  Utilise pipe() pour streamer chunk par chunk
// ══════════════════════════════════════════
app.get('/stream/:id', (req, res) => {
  const id = req.params.id;

  fetchAudioUrl(id, (err, audioUrl, duration) => {
    if (err || !audioUrl) return res.status(500).json({ error: 'Audio introuvable' });

    const rangeHeader = req.headers.range;
    const urlObj = new URL(audioUrl);
    const proto = urlObj.protocol === 'https:' ? https : http;

    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: {
        'User-Agent': 'com.google.android.youtube/17.31.35 (Linux; U; Android 11) gzip',
        'Accept': '*/*',
        'Accept-Encoding': 'identity', // Pas de compression → moins de CPU
        ...(rangeHeader ? { 'Range': rangeHeader } : {}),
      },
    };

    const proxyReq = proto.get(options, (proxyRes) => {
      // Headers minimaux pour iOS
      const headers = {
        'Content-Type': 'audio/mp4',
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      };

      if (proxyRes.headers['content-length'])
        headers['Content-Length'] = proxyRes.headers['content-length'];
      if (proxyRes.headers['content-range'])
        headers['Content-Range'] = proxyRes.headers['content-range'];

      res.writeHead(proxyRes.statusCode || 200, headers);

      // pipe() → stream direct sans buffer en mémoire ✅
      proxyRes.pipe(res, { end: true });

      // Libérer mémoire si client déconnecté
      req.on('close', () => {
        proxyRes.destroy();
        proxyReq.destroy();
      });
    });

    proxyReq.on('error', (e) => {
      console.error('Proxy error:', e.message);
      if (!res.headersSent) res.status(500).json({ error: 'Proxy error' });
    });

    proxyReq.setTimeout(30000, () => {
      proxyReq.destroy();
      if (!res.headersSent) res.status(504).json({ error: 'Timeout' });
    });
  });
});

// ══════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════
function fetchAudioUrl(id, callback) {
  const cached = audioCache.get(id);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return callback(null, cached.url, cached.duration);
  }

  const cmd = `yt-dlp "https://www.youtube.com/watch?v=${id}" \
    -f 140 \
    --print "%(url)s|||%(duration)s" \
    --no-warnings \
    --extractor-args "youtube:player_client=android_vr" \
    2>/dev/null`;

  exec(cmd, { timeout: 45000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
    if (err || !stdout.trim()) return callback(err || new Error('failed'));
    const parts = stdout.trim().split('|||');
    const url = parts[0].trim();
    const duration = parseInt(parts[1] || '0', 10);
    if (!url.startsWith('http')) return callback(new Error('invalid url'));
    setCache(audioCache, id, { url, duration, time: Date.now() });
    callback(null, url, duration);
  });
}

function precacheAudio(id) {
  if (!id) return;
  const cached = audioCache.get(id);
  if (cached && Date.now() - cached.time < CACHE_TTL) return;
  fetchAudioUrl(id, () => {});
}

async function getItunesArtwork(title, artist) {
  const key = `${title}|${artist}`.toLowerCase().slice(0, 50);
  if (artCache.has(key)) return artCache.get(key);
  try {
    const clean = title.replace(/\(.*?\)/g,'').replace(/\[.*?\]/g,'').trim();
    const q = encodeURIComponent(`${clean} ${artist}`.trim());
    const data = await fetchJson(`https://itunes.apple.com/search?term=${q}&media=music&limit=3&entity=song`);
    const best = data?.results?.find(r =>
      r.artistName?.toLowerCase().includes((artist||'').toLowerCase().slice(0,5))
    ) || data?.results?.[0];
    const art = best?.artworkUrl100?.replace('100x100bb','600x600bb');
    setCache(artCache, key, art || null);
    return art || null;
  } catch (e) { return null; }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'DiopSound/1.0' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function formatDuration(secs) {
  if (!secs) return '0:00';
  return `${Math.floor(secs/60)}:${Math.floor(secs%60).toString().padStart(2,'0')}`;
}

// Nettoyer le cache toutes les 10 minutes pour libérer mémoire
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of audioCache.entries()) {
    if (now - v.time > CACHE_TTL) audioCache.delete(k);
  }
}, 10 * 60 * 1000);

// Forcer garbage collection si disponible
setInterval(() => {
  if (global.gc) global.gc();
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`🎵 DiopSound API - Elhadji Ndiaye Diop - Port ${PORT}`);
  console.log(`   Memory: ${Math.round(process.memoryUsage().heapUsed/1024/1024)}MB`);
});

const express = require('express');
const { exec } = require('child_process');
const cors = require('cors');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const audioCache = new Map();
const artCache   = new Map();
const CACHE_TTL  = 5 * 60 * 1000;
const MAX_CACHE  = 50;

function setCache(map, key, val) {
  if (map.size >= MAX_CACHE) map.delete(map.keys().next().value);
  map.set(key, val);
}

// ══════════════════════════════════════════
//  HEALTH
// ══════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({
    status: 'ok', message: 'DiopSound API 🎵',
    author: 'Elhadji Ndiaye Diop',
    cached: audioCache.size,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
  });
});

// ══════════════════════════════════════════
//  RECHERCHE RAPIDE via YouTube Data API
//  Résultats en < 1 seconde
// ══════════════════════════════════════════
app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'q manquant' });

  const YT_KEY = process.env.YT_API_KEY || 'AIzaSyB3KyzbGd86QzVa2mt8x7HJ8bTaSN1bwcw';

  try {
    // 1. Recherche YouTube → instantanée
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&videoCategoryId=10&maxResults=15&key=${YT_KEY}`;
    const searchData = await fetchJson(searchUrl);

    if (!searchData.items?.length) {
      return res.json({ status: 'success', results: [] });
    }

    // 2. Durées en parallèle
    const ids = searchData.items.map(i => i.id.videoId).join(',');
    const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids}&key=${YT_KEY}`;
    const detailsData = await fetchJson(detailsUrl);
    const durations = {};
    (detailsData.items || []).forEach(item => {
      durations[item.id] = parseDuration(item.contentDetails.duration);
    });

    // 3. Formater résultats
    const results = searchData.items
      .filter(item => {
        const dur = durations[item.id.videoId] || 0;
        return dur > 30 && dur < 7200;
      })
      .map(item => ({
        id:          item.id.videoId,
        title:       cleanTitle(item.snippet.title),
        artist:      item.snippet.channelTitle.replace(' - Topic','').replace('VEVO','').trim(),
        duration:    formatDuration(durations[item.id.videoId] || 0),
        durationSec: durations[item.id.videoId] || 0,
        thumbnail:   item.snippet.thumbnails.high?.url || item.snippet.thumbnails.default?.url,
        youtubeId:   item.id.videoId,
      }));

    // 4. Pochettes iTunes + pré-cache audio EN PARALLÈLE
    const [enriched] = await Promise.all([
      Promise.all(results.slice(0, 8).map(async t => ({
        ...t,
        thumbnail: (await getItunesArtwork(t.title, t.artist)) || t.thumbnail,
      }))),
      // Pré-cache les 5 premiers immédiatement
      ...results.slice(0, 5).map(t => prefetchAudio(t.id)),
    ]);

    res.json({ status: 'success', results: [...enriched, ...results.slice(8)] });

  } catch (e) {
    console.error('Search error:', e.message);
    res.status(500).json({ error: 'Recherche échouée' });
  }
});

// ══════════════════════════════════════════
//  PRÉ-CACHE agressif — appelé par l'app
// ══════════════════════════════════════════
app.post('/precache', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids manquant' });
  ids.slice(0, 5).forEach(id => prefetchAudio(id));
  res.json({ status: 'ok', queued: Math.min(ids.length, 5) });
});

// ══════════════════════════════════════════
//  AUDIO INFO — durée + confirme le cache
// ══════════════════════════════════════════
app.get('/audio', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id manquant' });

  const cached = audioCache.get(id);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return res.json({ status: 'success', duration: cached.duration, id, cached: true });
  }

  fetchAudioUrl(id, (err, url, duration) => {
    if (err || !url) return res.status(500).json({ error: 'Audio introuvable' });
    res.json({ status: 'success', duration, id });
  });
});

// ══════════════════════════════════════════
//  STREAM — proxy direct iOS compatible
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
        'Accept-Encoding': 'identity',
        ...(rangeHeader ? { 'Range': rangeHeader } : {}),
      },
    };

    const proxyReq = proto.get(options, (proxyRes) => {
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
      proxyRes.pipe(res, { end: true });

      req.on('close', () => { proxyRes.destroy(); proxyReq.destroy(); });
    });

    proxyReq.on('error', e => {
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

// Pré-fetch silencieux
function prefetchAudio(id) {
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
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function cleanTitle(t) {
  return t.replace(/\(Official.*?\)/gi,'').replace(/\[Official.*?\]/gi,'')
          .replace(/\(Audio.*?\)/gi,'').replace(/\(Lyrics.*?\)/gi,'')
          .replace(/\(Video.*?\)/gi,'').replace(/- Official.*$/gi,'').trim();
}

function parseDuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1]||0)*3600)+(parseInt(m[2]||0)*60)+parseInt(m[3]||0);
}

function formatDuration(s) {
  if (!s) return '0:00';
  return `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`;
}

// Nettoyage mémoire
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of audioCache.entries()) {
    if (now - v.time > CACHE_TTL) audioCache.delete(k);
  }
  if (global.gc) global.gc();
}, 10 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`🎵 DiopSound API - Elhadji Ndiaye Diop - Port ${PORT}`);
});

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
const CACHE_TTL  = 5 * 60 * 1000;
const MAX_CACHE  = 80;

function setCache(map, key, val) {
  if (map.size >= MAX_CACHE) map.delete(map.keys().next().value);
  map.set(key, val);
}

// File de pré-fetch séquentielle
const fetchQueue = [];
let isFetching = false;

function enqueue(id) {
  if (!id || audioCache.has(id) || fetchQueue.includes(id)) return;
  fetchQueue.push(id);
  processQueue();
}

function processQueue() {
  if (isFetching || !fetchQueue.length) return;
  isFetching = true;
  const id = fetchQueue.shift();
  fetchAudioUrl(id, () => { isFetching = false; processQueue(); });
}

// ══════════════════════════════════════════
//  HEALTH
// ══════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({
    status: 'ok', author: 'Elhadji Ndiaye Diop',
    cached: audioCache.size, queue: fetchQueue.length,
    memory: Math.round(process.memoryUsage().heapUsed/1024/1024) + 'MB',
  });
});

// ══════════════════════════════════════════
//  DEEZER — Chart mondial (instantané)
// ══════════════════════════════════════════
app.get('/chart', async (req, res) => {
  try {
    const data = await deezerGet('chart/0/tracks?limit=50');
    const tracks = (data.data || []).map(normalizeDeezer);
    res.json({ status: 'success', results: tracks });
    // Pré-fetch audio en arrière-plan
    tracks.slice(0, 10).forEach(t => enqueue(t.youtubeId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
//  DEEZER — Recherche (instantanée)
// ══════════════════════════════════════════
app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'q manquant' });
  try {
    const data = await deezerGet(`search?q=${encodeURIComponent(q)}&limit=25&order=RANKING`);
    const tracks = (data.data || []).map(normalizeDeezer);
    res.json({ status: 'success', results: tracks });
    tracks.slice(0, 8).forEach(t => enqueue(t.youtubeId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
//  DEEZER — Artiste + top titres
// ══════════════════════════════════════════
app.get('/artist/:id', async (req, res) => {
  try {
    const [artist, topTracks, albums] = await Promise.all([
      deezerGet(`artist/${req.params.id}`),
      deezerGet(`artist/${req.params.id}/top?limit=10`),
      deezerGet(`artist/${req.params.id}/albums?limit=6`),
    ]);
    res.json({
      status: 'success',
      artist: {
        id: artist.id,
        name: artist.name,
        picture: artist.picture_xl || artist.picture_big,
        fans: artist.nb_fan,
        albums: artist.nb_album,
      },
      topTracks: (topTracks.data || []).map(normalizeDeezer),
      albums: (albums.data || []).map(a => ({
        id: a.id, title: a.title,
        cover: a.cover_xl || a.cover_big,
        year: a.release_date?.slice(0, 4),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
//  DEEZER — Album
// ══════════════════════════════════════════
app.get('/album/:id', async (req, res) => {
  try {
    const data = await deezerGet(`album/${req.params.id}`);
    res.json({
      status: 'success',
      album: {
        id: data.id, title: data.title,
        cover: data.cover_xl || data.cover_big,
        artist: data.artist?.name,
        year: data.release_date?.slice(0, 4),
        tracks: (data.tracks?.data || []).map(normalizeDeezer),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
//  DEEZER — Genre charts
// ══════════════════════════════════════════
app.get('/genre/:name', async (req, res) => {
  const GENRE_IDS = {
    pop: 132, rap: 116, rnb: 165, rock: 152,
    electro: 106, jazz: 129, afro: 2, reggae: 144,
  };
  const gid = GENRE_IDS[req.params.name.toLowerCase()] || 132;
  try {
    const data = await deezerGet(`search?q=${encodeURIComponent(req.params.name)}&limit=20&order=RANKING`);
    const tracks = (data.data || []).map(normalizeDeezer);
    res.json({ status: 'success', results: tracks });
    tracks.slice(0, 5).forEach(t => enqueue(t.youtubeId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
//  PRÉ-CACHE
// ══════════════════════════════════════════
app.post('/precache', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids manquant' });
  ids.slice(0, 8).forEach(id => enqueue(id));
  res.json({ status: 'ok', queued: Math.min(ids.length, 8) });
});

// ══════════════════════════════════════════
//  AUDIO INFO — durée depuis yt-dlp/cache
// ══════════════════════════════════════════
app.get('/audio', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id manquant' });
  const cached = audioCache.get(id);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return res.json({ status: 'success', duration: cached.duration, id, cached: true });
  }
  enqueue(id);
  res.json({ status: 'success', duration: 0, id, cached: false });
});

// ══════════════════════════════════════════
//  STREAM — proxy M4A compatible iOS
// ══════════════════════════════════════════
app.get('/stream/:id', (req, res) => {
  const id = req.params.id;

  fetchAudioUrl(id, (err, audioUrl, duration) => {
    if (err || !audioUrl) return res.status(500).json({ error: 'Audio introuvable' });

    const rangeHeader = req.headers.range;
    const urlObj = new URL(audioUrl);
    const proto = urlObj.protocol === 'https:' ? https : http;

    const proxyReq = proto.get({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: {
        'User-Agent': 'com.google.android.youtube/17.31.35 (Linux; U; Android 11) gzip',
        'Accept': '*/*', 'Accept-Encoding': 'identity',
        ...(rangeHeader ? { 'Range': rangeHeader } : {}),
      },
    }, (proxyRes) => {
      const headers = {
        'Content-Type': 'audio/mp4', 'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache',
      };
      if (proxyRes.headers['content-length']) headers['Content-Length'] = proxyRes.headers['content-length'];
      if (proxyRes.headers['content-range'])  headers['Content-Range']  = proxyRes.headers['content-range'];
      res.writeHead(proxyRes.statusCode || 200, headers);
      proxyRes.pipe(res, { end: true });
      req.on('close', () => { proxyRes.destroy(); proxyReq.destroy(); });
    });

    proxyReq.on('error', () => { if (!res.headersSent) res.status(500).end(); });
    proxyReq.setTimeout(30000, () => { proxyReq.destroy(); });
  });
});

// ══════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════
async function deezerGet(path) {
  return fetchJson(`https://api.deezer.com/${path}`);
}

function fetchAudioUrl(id, callback) {
  const cached = audioCache.get(id);
  if (cached && Date.now() - cached.time < CACHE_TTL) return callback(null, cached.url, cached.duration);

  const cmd = `yt-dlp "https://www.youtube.com/watch?v=${id}" -f 140 --print "%(url)s|||%(duration)s" --no-warnings --extractor-args "youtube:player_client=android_vr" 2>/dev/null`;

  exec(cmd, { timeout: 45000, maxBuffer: 1024*1024 }, (err, stdout) => {
    if (err || !stdout.trim()) return callback(err || new Error('failed'));
    const [url, dur] = stdout.trim().split('|||');
    const duration = parseInt(dur || '0', 10);
    if (!url.trim().startsWith('http')) return callback(new Error('invalid url'));
    setCache(audioCache, id.trim(), { url: url.trim(), duration, time: Date.now() });
    callback(null, url.trim(), duration);
  });
}

function normalizeDeezer(item) {
  // Chercher un video ID YouTube via le titre pour le stream
  const youtubeId = item.id ? `deezer_${item.id}` : null;
  return {
    id:          String(item.id),
    title:       item.title || item.title_short,
    artist:      item.artist?.name || '',
    artistId:    item.artist?.id,
    album:       item.album?.title || '',
    albumId:     item.album?.id,
    duration:    formatDuration(item.duration || 0),
    durationSec: item.duration || 0,
    thumbnail:   item.album?.cover_xl || item.album?.cover_big || item.album?.cover_medium,
    previewUrl:  item.preview,  // ← 30s preview Deezer (instantané)
    youtubeId:   null,          // ← sera résolu au play
    deezerId:    String(item.id),
    rank:        item.rank,
    explicit:    item.explicit_lyrics,
  };
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

function formatDuration(s) {
  if (!s) return '0:00';
  return `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`;
}

// Warmup au démarrage
setTimeout(async () => {
  try {
    const data = await deezerGet('chart/0/tracks?limit=25');
    console.log(`🔥 Warmup: ${data.data?.length || 0} tracks`);
  } catch(e) { console.warn('Warmup failed'); }
}, 2000);

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of audioCache.entries()) {
    if (now - v.time > CACHE_TTL) audioCache.delete(k);
  }
  if (global.gc) global.gc();
}, 10 * 60 * 1000);

app.listen(PORT, () => console.log(`🎵 DiopSound API - Elhadji Ndiaye Diop - Port ${PORT}`));

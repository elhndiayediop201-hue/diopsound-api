const express = require('express');
const { exec }  = require('child_process');
const cors      = require('cors');
const axios     = require('axios');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ══════════════════════════════════════════════════════════════════
//  CACHE EN MÉMOIRE — évite de re-lancer yt-dlp pour le même ID
// ══════════════════════════════════════════════════════════════════
const streamCache   = new Map(); // ytId   → { url, time }
const resolveCache  = new Map(); // query  → { youtubeId, time }
const durationCache = new Map(); // ytId   → { duration, time }
const CACHE_TTL     = 5 * 60 * 1000; // 5 minutes

function cacheSet(map, key, value) {
  map.set(key, { value, time: Date.now() });
}
function cacheGet(map, key) {
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) { map.delete(key); return null; }
  return entry.value;
}

// ══════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════

// Exécute une commande shell avec timeout
function execPromise(cmd, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const proc = exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(err);
      else     resolve(stdout.trim());
    });
  });
}

// Récupère l'URL de stream d'un video YouTube via yt-dlp
async function getStreamUrl(ytId) {
  const cached = cacheGet(streamCache, ytId);
  if (cached) return cached;

  const url = await execPromise(
    `yt-dlp "https://www.youtube.com/watch?v=${ytId}" -f 140 --get-url --no-playlist`
  );
  if (!url) throw new Error('yt-dlp returned empty URL');

  cacheSet(streamCache, ytId, url);
  return url;
}

// ══════════════════════════════════════════════════════════════════
//  ROUTE : RESOLVE — trouve le YouTube ID d'un titre
//  GET /resolve?q=Drake+God%27s+Plan
// ══════════════════════════════════════════════════════════════════
app.get('/resolve', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  // Cache
  const cached = cacheGet(resolveCache, query);
  if (cached) return res.json({ youtubeId: cached });

  try {
    // Utilise yt-dlp pour chercher directement sur YouTube Music
    // (plus fiable que l'API YouTube pour trouver la bonne version)
    const ytId = await execPromise(
      `yt-dlp "ytsearch1:${query.replace(/"/g, '')}" --get-id --no-playlist`,
      10000
    );

    if (!ytId || ytId.length !== 11) {
      return res.json({ youtubeId: null });
    }

    cacheSet(resolveCache, query, ytId);
    res.json({ youtubeId: ytId });

  } catch (e) {
    console.error('[resolve] error:', e.message);
    res.json({ youtubeId: null });
  }
});

// ══════════════════════════════════════════════════════════════════
//  ROUTE : DURATION — durée réelle d'un track YouTube
//  GET /duration/:ytId
// ══════════════════════════════════════════════════════════════════
app.get('/duration/:id', async (req, res) => {
  const ytId = req.params.id;

  const cached = cacheGet(durationCache, ytId);
  if (cached) return res.json({ duration: cached });

  try {
    const raw = await execPromise(
      `yt-dlp "https://www.youtube.com/watch?v=${ytId}" --get-duration --no-playlist`,
      10000
    );

    // Format "3:45" ou "1:02:30" → secondes
    const parts    = raw.split(':').map(Number);
    let   duration = 0;
    if (parts.length === 2) duration = parts[0] * 60 + parts[1];
    if (parts.length === 3) duration = parts[0] * 3600 + parts[1] * 60 + parts[2];

    cacheSet(durationCache, ytId, duration);
    res.json({ duration });

  } catch (e) {
    res.json({ duration: 0 });
  }
});

// ══════════════════════════════════════════════════════════════════
//  ROUTE : STREAM — proxy audio vers l'app mobile
//  GET /stream/:ytId
// ══════════════════════════════════════════════════════════════════
app.get('/stream/:id', async (req, res) => {
  const ytId = req.params.id;

  try {
    const streamUrl = await getStreamUrl(ytId);

    // Supporte le Range header pour la seekbar mobile
    const rangeHeader = req.headers.range;

    const axiosConfig = {
      method:       'get',
      url:          streamUrl,
      responseType: 'stream',
      headers:      {
        'User-Agent': 'Mozilla/5.0 (compatible; DiopSound/1.0)',
        ...(rangeHeader ? { Range: rangeHeader } : {}),
      },
      timeout: 30000,
    };

    const response = await axios(axiosConfig);

    // Transfère les headers importants
    res.setHeader('Content-Type',  response.headers['content-type']  || 'audio/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    if (response.headers['content-length'])
      res.setHeader('Content-Length', response.headers['content-length']);
    if (response.headers['content-range'])
      res.setHeader('Content-Range', response.headers['content-range']);

    res.status(rangeHeader ? 206 : 200);
    response.data.pipe(res);

    // Nettoyage si le client coupe la connexion
    req.on('close', () => response.data.destroy());

  } catch (e) {
    console.error('[stream] error:', e.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Stream unavailable' });
    }
  }
});

// ══════════════════════════════════════════════════════════════════
//  ROUTE : SEARCH — recherche YouTube (optionnel, pour usage futur)
//  GET /search?q=Drake
// ══════════════════════════════════════════════════════════════════
app.get('/search', async (req, res) => {
  const query  = req.query.q;
  const YT_KEY = process.env.YT_API_KEY;

  if (!YT_KEY) return res.status(500).json({ error: 'YT_API_KEY not configured' });

  try {
    const url    = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&videoCategoryId=10&maxResults=15&key=${YT_KEY}`;
    const { data } = await axios.get(url);

    const results = (data.items || []).map(item => ({
      youtubeId: item.id.videoId,
      title:     item.snippet.title.replace(/\(Official.*?\)/gi, '').trim(),
      artist:    item.snippet.channelTitle.replace(' - Topic', '').trim(),
      thumbnail: item.snippet.thumbnails.high?.url || '',
    }));

    res.json({ status: 'success', results });
  } catch (e) {
    res.status(500).json({ error: 'Search failed', detail: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  ROUTE : HEALTH CHECK
// ══════════════════════════════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    service:   'DiopSound API',
    timestamp: new Date().toISOString(),
    cache: {
      streams:  streamCache.size,
      resolves: resolveCache.size,
      durations: durationCache.size,
    },
  });
});

app.get('/', (req, res) => {
  res.json({ message: '🎵 DiopSound API is running', version: '2.0.0' });
});

app.listen(PORT, () => {
  console.log(`🎵 DiopSound API v2.0 — port ${PORT}`);
});

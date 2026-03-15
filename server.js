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
const CACHE_TTL  = 4 * 60 * 1000; // 4 min

// ══════════════════════════════════════════
//  HEALTH
// ══════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'DiopSound API 🎵', author: 'Elhadji Ndiaye Diop' });
});

// ══════════════════════════════════════════
//  RECHERCHE + pochettes iTunes
// ══════════════════════════════════════════
app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'q manquant' });

  const cmd = `yt-dlp "ytsearch15:${query}" --dump-json --flat-playlist --no-warnings --no-playlist --extractor-args "youtube:player_client=android_vr" 2>/dev/null`;

  exec(cmd, { timeout: 45000 }, async (err, stdout) => {
    if (err || !stdout.trim()) return res.status(500).json({ error: 'Recherche échouée' });
    try {
      const results = stdout.trim().split('\n').filter(Boolean).map(line => {
        try {
          const item = JSON.parse(line);
          return {
            id: item.id,
            title: item.title,
            artist: item.uploader || item.channel || '',
            duration: formatDuration(item.duration || 0),
            durationSec: item.duration || 0,
            thumbnail: `https://img.youtube.com/vi/${item.id}/hqdefault.jpg`,
            youtubeId: item.id,
          };
        } catch (e) { return null; }
      }).filter(t => t && t.durationSec > 30 && t.durationSec < 7200);

      // Enrichir avec pochettes iTunes en parallèle
      const enriched = await Promise.all(results.map(async (track) => {
        const artwork = await getItunesArtwork(track.title, track.artist);
        return { ...track, thumbnail: artwork || track.thumbnail };
      }));

      // Pré-charger les URLs audio en arrière-plan (les 3 premiers)
      enriched.slice(0, 3).forEach(t => prefetchAudio(t.id));

      res.json({ status: 'success', results: enriched });
    } catch (e) { res.status(500).json({ error: 'Parsing error' }); }
  });
});

// ══════════════════════════════════════════
//  POCHETTE iTunes — belle qualité
// ══════════════════════════════════════════
app.get('/artwork', async (req, res) => {
  const { title, artist } = req.query;
  if (!title) return res.status(400).json({ error: 'title manquant' });
  const url = await getItunesArtwork(title, artist || '');
  res.json({ url: url || null });
});

async function getItunesArtwork(title, artist) {
  const key = `${title}|${artist}`.toLowerCase();
  if (artCache.has(key)) return artCache.get(key);

  try {
    const clean = title.replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '').trim();
    const q = encodeURIComponent(`${clean} ${artist}`.trim());
    const url = `https://itunes.apple.com/search?term=${q}&media=music&limit=3&entity=song`;

    const data = await fetchJson(url);
    if (data?.results?.length > 0) {
      // Prendre la meilleure pochette (600x600)
      const artwork = data.results[0].artworkUrl100
        ?.replace('100x100', '600x600');
      if (artwork) {
        artCache.set(key, artwork);
        return artwork;
      }
    }
  } catch (e) {}
  return null;
}

// ══════════════════════════════════════════
//  AUDIO INFO
// ══════════════════════════════════════════
app.get('/audio', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id manquant' });

  const cached = audioCache.get(id);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return res.json({ status: 'success', url: `${req.protocol}://${req.get('host')}/stream/${id}`, duration: cached.duration, id, cached: true });
  }

  fetchAudioUrl(id, (err, url, duration) => {
    if (err || !url) return res.status(500).json({ error: 'Audio introuvable' });
    res.json({ status: 'success', url: `${req.protocol}://${req.get('host')}/stream/${id}`, duration, id });
  });
});

// ══════════════════════════════════════════
//  STREAM — proxy audio vers iOS
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
        'X-Content-Duration': String(duration),
      };
      if (proxyRes.headers['content-length'])
        headers['Content-Length'] = proxyRes.headers['content-length'];
      if (proxyRes.headers['content-range'])
        headers['Content-Range'] = proxyRes.headers['content-range'];

      res.writeHead(proxyRes.statusCode || 200, headers);
      proxyRes.pipe(res);
      proxyRes.on('error', () => res.end());
    });

    proxyReq.on('error', (e) => {
      if (!res.headersSent) res.status(500).json({ error: 'Proxy error' });
    });

    req.on('close', () => proxyReq.destroy());
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

  const cmd = `yt-dlp "https://www.youtube.com/watch?v=${id}" -f 140 --print "%(url)s|||%(duration)s" --no-warnings --extractor-args "youtube:player_client=android_vr" 2>/dev/null`;

  exec(cmd, { timeout: 45000 }, (err, stdout) => {
    if (err || !stdout.trim()) return callback(err || new Error('failed'));
    const parts = stdout.trim().split('|||');
    const url = parts[0].trim();
    const duration = parseInt(parts[1] || '0', 10);
    if (!url.startsWith('http')) return callback(new Error('invalid url'));
    audioCache.set(id, { url, duration, time: Date.now() });
    callback(null, url, duration);
  });
}

// Pré-charger l'URL audio en arrière-plan
function prefetchAudio(id) {
  if (audioCache.has(id)) return;
  fetchAudioUrl(id, () => {});
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'DiopSound/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function formatDuration(secs) {
  if (!secs) return '0:00';
  return `${Math.floor(secs/60)}:${Math.floor(secs%60).toString().padStart(2,'0')}`;
}

app.listen(PORT, () => {
  console.log(`🎵 DiopSound API - Elhadji Ndiaye Diop - Port ${PORT}`);
});

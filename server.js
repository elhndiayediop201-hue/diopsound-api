const express = require('express');
const { exec } = require('child_process');
const cors = require('cors');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const cache = new Map();
const CACHE_TTL = 4 * 60 * 1000;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'DiopSound API 🎵', author: 'Elhadji Ndiaye Diop' });
});

app.get('/search', (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'q manquant' });
  const cmd = `yt-dlp "ytsearch15:${query}" --dump-json --flat-playlist --no-warnings --no-playlist --extractor-args "youtube:player_client=android_vr" 2>/dev/null`;
  exec(cmd, { timeout: 45000 }, (err, stdout) => {
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
      res.json({ status: 'success', results });
    } catch (e) { res.status(500).json({ error: 'Parsing error' }); }
  });
});

// ══════════════════════════════════════════
//  AUDIO INFO — retourne URL + durée (pour debug)
// ══════════════════════════════════════════
app.get('/audio', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id manquant' });

  const cached = cache.get(id);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return res.json({ status: 'success', url: cached.url, duration: cached.duration, id, cached: true });
  }

  const cmd = `yt-dlp "https://www.youtube.com/watch?v=${id}" -f 140 --print "%(url)s|||%(duration)s" --no-warnings --extractor-args "youtube:player_client=android_vr" 2>/dev/null`;

  exec(cmd, { timeout: 45000 }, (err, stdout) => {
    if (!err && stdout.trim()) {
      const parts = stdout.trim().split('|||');
      const url = parts[0].trim();
      const duration = parseInt(parts[1] || '0', 10);
      if (url.startsWith('http')) {
        cache.set(id, { url, duration, time: Date.now() });
        return res.json({ status: 'success', url, duration, id });
      }
    }
    res.status(500).json({ error: 'Audio introuvable' });
  });
});

// ══════════════════════════════════════════
//  STREAM — Railway télécharge et streame
//  vers iOS avec les bons headers
// ══════════════════════════════════════════
app.get('/stream/:id', (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: 'id manquant' });

  const getAudioUrl = (callback) => {
    const cached = cache.get(id);
    if (cached && Date.now() - cached.time < CACHE_TTL) {
      return callback(null, cached.url, cached.duration);
    }
    const cmd = `yt-dlp "https://www.youtube.com/watch?v=${id}" -f 140 --print "%(url)s|||%(duration)s" --no-warnings --extractor-args "youtube:player_client=android_vr" 2>/dev/null`;
    exec(cmd, { timeout: 45000 }, (err, stdout) => {
      if (err || !stdout.trim()) return callback(err || new Error('yt-dlp failed'));
      const parts = stdout.trim().split('|||');
      const url = parts[0].trim();
      const duration = parseInt(parts[1] || '0', 10);
      if (!url.startsWith('http')) return callback(new Error('Invalid URL'));
      cache.set(id, { url, duration, time: Date.now() });
      callback(null, url, duration);
    });
  };

  getAudioUrl((err, audioUrl, duration) => {
    if (err) return res.status(500).json({ error: 'Audio introuvable' });

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
      const status = rangeHeader ? 206 : 200;
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

      res.writeHead(proxyRes.statusCode || status, headers);
      proxyRes.pipe(res);

      proxyRes.on('error', () => res.end());
    });

    proxyReq.on('error', (e) => {
      console.error('Proxy error:', e.message);
      if (!res.headersSent) res.status(500).json({ error: 'Proxy error' });
    });

    req.on('close', () => proxyReq.destroy());
  });
});

function formatDuration(secs) {
  if (!secs) return '0:00';
  return `${Math.floor(secs/60)}:${Math.floor(secs%60).toString().padStart(2,'0')}`;
}

app.listen(PORT, () => {
  console.log(`🎵 DiopSound API - Elhadji Ndiaye Diop - Port ${PORT}`);
});

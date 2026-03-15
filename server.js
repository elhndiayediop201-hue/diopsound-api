const express = require('express');
const { exec, spawn } = require('child_process');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ══════════════════════════════════════════
//  HEALTH CHECK
// ══════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'DiopSound API fonctionne 🎵', author: 'Elhadji Ndiaye Diop' });
});

// ══════════════════════════════════════════
//  RECHERCHE
// ══════════════════════════════════════════
app.get('/search', (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Paramètre q manquant' });

  const cmd = `yt-dlp "ytsearch15:${query}" --dump-json --flat-playlist --no-warnings --no-playlist --extractor-args "youtube:player_client=android_vr" 2>/dev/null`;

  exec(cmd, { timeout: 45000 }, (err, stdout) => {
    if (err || !stdout.trim()) {
      return res.status(500).json({ error: 'Recherche échouée' });
    }
    try {
      const results = stdout.trim().split('\n')
        .filter(Boolean)
        .map(line => {
          try {
            const item = JSON.parse(line);
            return {
              id:          item.id,
              title:       item.title,
              artist:      item.uploader || item.channel || '',
              duration:    formatDuration(item.duration || 0),
              durationSec: item.duration || 0,
              thumbnail:   item.thumbnail || `https://img.youtube.com/vi/${item.id}/hqdefault.jpg`,
              youtubeId:   item.id,
            };
          } catch (e) { return null; }
        })
        .filter(t => t && t.durationSec > 30 && t.durationSec < 7200);
      res.json({ status: 'success', results });
    } catch (e) {
      res.status(500).json({ error: 'Erreur parsing' });
    }
  });
});

// ══════════════════════════════════════════
//  STREAM URL — retourne l'URL directe
// ══════════════════════════════════════════
app.get('/stream', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Paramètre id manquant' });

  const cmd = `yt-dlp "https://www.youtube.com/watch?v=${id}" -f "140/bestaudio[ext=m4a]/bestaudio[ext=mp4]" --get-url --no-warnings --extractor-args "youtube:player_client=android_vr" 2>/dev/null`;

  exec(cmd, { timeout: 45000 }, (err, stdout) => {
    if (err || !stdout.trim()) {
      return res.status(500).json({ error: 'Stream introuvable' });
    }
    const url = stdout.trim().split('\n')[0];
    res.json({ status: 'success', url, id });
  });
});

// ══════════════════════════════════════════
//  AUDIO PROXY — télécharge et sert l'audio
//  avec les bons headers pour iOS
// ══════════════════════════════════════════
app.get('/audio', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Paramètre id manquant' });

  // Étape 1 — récupérer l'URL directe
  const cmd = `yt-dlp "https://www.youtube.com/watch?v=${id}" -f "140/bestaudio[ext=m4a]/bestaudio[ext=mp4]" --get-url --no-warnings --extractor-args "youtube:player_client=android_vr" 2>/dev/null`;

  exec(cmd, { timeout: 45000 }, async (err, stdout) => {
    if (err || !stdout.trim()) {
      return res.status(500).json({ error: 'Audio introuvable' });
    }

    const audioUrl = stdout.trim().split('\n')[0];

    // Étape 2 — proxy avec les bons headers iOS
    try {
      const fetch = (await import('node-fetch')).default;

      // Transmettre le Range header si iOS le demande
      const headers = {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
      };
      if (req.headers.range) {
        headers['Range'] = req.headers.range;
      }

      const response = await fetch(audioUrl, { headers });

      // Headers de réponse pour iOS
      res.setHeader('Content-Type', 'audio/mp4');
      res.setHeader('Accept-Ranges', 'bytes');

      if (response.headers.get('content-length')) {
        res.setHeader('Content-Length', response.headers.get('content-length'));
      }
      if (response.headers.get('content-range')) {
        res.setHeader('Content-Range', response.headers.get('content-range'));
      }

      // Status 206 si Range request, 200 sinon
      res.status(req.headers.range ? 206 : 200);

      response.body.pipe(res);

      req.on('close', () => {
        response.body.destroy();
      });

    } catch (fetchErr) {
      console.error('Fetch error:', fetchErr.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Erreur proxy audio' });
      }
    }
  });
});

// ══════════════════════════════════════════
//  HELPER
// ══════════════════════════════════════════
function formatDuration(secs) {
  if (!secs) return '0:00';
  return `${Math.floor(secs / 60)}:${Math.floor(secs % 60).toString().padStart(2, '0')}`;
}

app.listen(PORT, () => {
  console.log(`🎵 DiopSound API - Elhadji Ndiaye Diop - Port ${PORT}`);
});

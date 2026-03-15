const express = require('express');
const { exec } = require('child_process');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Cache pour éviter de rappeler yt-dlp pour le même titre
const cache = new Map();
const CACHE_TTL = 4 * 60 * 1000; // 4 minutes (URLs YouTube expirent en ~6min)

// ══════════════════════════════════════════
//  HEALTH CHECK
// ══════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'DiopSound API 🎵', author: 'Elhadji Ndiaye Diop' });
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
              thumbnail:   `https://img.youtube.com/vi/${item.id}/hqdefault.jpg`,
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
//  AUDIO — retourne URL directe + durée exacte
//  Beaucoup plus rapide que le proxy
// ══════════════════════════════════════════
app.get('/audio', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id manquant' });

  // Vérifier le cache d'abord
  const cached = cache.get(id);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return res.json({ status: 'success', url: cached.url, duration: cached.duration, id, cached: true });
  }

  // Récupérer URL + durée exacte en une seule commande
  const cmd = `yt-dlp "https://www.youtube.com/watch?v=${id}" \
    -f "140/bestaudio[ext=m4a]/bestaudio[ext=mp4]" \
    --print "%(url)s|||%(duration)s" \
    --no-warnings \
    --extractor-args "youtube:player_client=android_vr" \
    2>/dev/null`;

  exec(cmd, { timeout: 45000 }, (err, stdout) => {
    if (err || !stdout.trim()) {
      // Fallback android client
      const cmd2 = `yt-dlp "https://www.youtube.com/watch?v=${id}" \
        -f "140/bestaudio[ext=m4a]/bestaudio[ext=mp4]" \
        --print "%(url)s|||%(duration)s" \
        --no-warnings \
        --extractor-args "youtube:player_client=android" \
        2>/dev/null`;

      exec(cmd2, { timeout: 45000 }, (err2, stdout2) => {
        if (err2 || !stdout2.trim()) {
          return res.status(500).json({ error: 'Audio introuvable' });
        }
        const [url, dur] = stdout2.trim().split('|||');
        const duration = parseInt(dur || '0', 10);
        cache.set(id, { url: url.trim(), duration, time: Date.now() });
        res.json({ status: 'success', url: url.trim(), duration, id });
      });
      return;
    }

    const [url, dur] = stdout.trim().split('|||');
    const duration = parseInt(dur || '0', 10);
    cache.set(id, { url: url.trim(), duration, time: Date.now() });
    res.json({ status: 'success', url: url.trim(), duration, id });
  });
});

// ══════════════════════════════════════════
//  HELPER
// ══════════════════════════════════════════
function formatDuration(secs) {
  if (!secs) return '0:00';
  return `${Math.floor(secs/60)}:${Math.floor(secs%60).toString().padStart(2,'0')}`;
}

app.listen(PORT, () => {
  console.log(`🎵 DiopSound API - Elhadji Ndiaye Diop - Port ${PORT}`);
});

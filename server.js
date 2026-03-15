const express = require('express');
const { exec } = require('child_process');
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
//  RECHERCHE — GET /search?q=Drake
// ══════════════════════════════════════════
app.get('/search', (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Paramètre q manquant' });

  const cmd = `yt-dlp "ytsearch15:${query}" --dump-json --flat-playlist --no-warnings --no-playlist --extractor-args "youtube:player_client=android" 2>/dev/null`;

  exec(cmd, { timeout: 45000 }, (err, stdout) => {
    if (err || !stdout.trim()) {
      return res.status(500).json({ error: 'Recherche échouée', details: err?.message });
    }
    try {
      const lines = stdout.trim().split('\n').filter(Boolean);
      const results = lines
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
        .filter(Boolean)
        .filter(t => t.durationSec > 30 && t.durationSec < 7200);
      res.json({ status: 'success', results });
    } catch (e) {
      res.status(500).json({ error: 'Erreur parsing', details: e.message });
    }
  });
});

// ══════════════════════════════════════════
//  STREAM AUDIO — GET /stream?id=VIDEO_ID
//  Essaie plusieurs stratégies pour iOS/Android
// ══════════════════════════════════════════
app.get('/stream', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Paramètre id manquant' });

  // Stratégie 1 — Android client (contourne le blocage datacenter)
  const cmd1 = `yt-dlp "https://www.youtube.com/watch?v=${id}" \
    -f "bestaudio[ext=m4a]/bestaudio[ext=mp4]/bestaudio" \
    --get-url --no-warnings \
    --extractor-args "youtube:player_client=android" \
    2>/dev/null`;

  exec(cmd1, { timeout: 45000 }, (err1, stdout1) => {
    if (!err1 && stdout1.trim()) {
      const url = stdout1.trim().split('\n')[0];
      return res.json({ status: 'success', url, id, strategy: 'android' });
    }

    // Stratégie 2 — Android VR client
    const cmd2 = `yt-dlp "https://www.youtube.com/watch?v=${id}" \
      -f "bestaudio[ext=m4a]/bestaudio[ext=mp4]/bestaudio" \
      --get-url --no-warnings \
      --extractor-args "youtube:player_client=android_vr" \
      2>/dev/null`;

    exec(cmd2, { timeout: 45000 }, (err2, stdout2) => {
      if (!err2 && stdout2.trim()) {
        const url = stdout2.trim().split('\n')[0];
        return res.json({ status: 'success', url, id, strategy: 'android_vr' });
      }

      // Stratégie 3 — TV client
      const cmd3 = `yt-dlp "https://www.youtube.com/watch?v=${id}" \
        -f "bestaudio" \
        --get-url --no-warnings \
        --extractor-args "youtube:player_client=tv" \
        2>/dev/null`;

      exec(cmd3, { timeout: 45000 }, (err3, stdout3) => {
        if (!err3 && stdout3.trim()) {
          const url = stdout3.trim().split('\n')[0];
          return res.json({ status: 'success', url, id, strategy: 'tv' });
        }

        return res.status(500).json({
          error: 'Stream introuvable — YouTube bloque cet accès',
          id,
        });
      });
    });
  });
});

// ══════════════════════════════════════════
//  INFOS TITRE — GET /info?id=VIDEO_ID
// ══════════════════════════════════════════
app.get('/info', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Paramètre id manquant' });

  const cmd = `yt-dlp "https://www.youtube.com/watch?v=${id}" --dump-json --no-warnings --extractor-args "youtube:player_client=android" 2>/dev/null`;

  exec(cmd, { timeout: 45000 }, (err, stdout) => {
    if (err || !stdout.trim()) {
      return res.status(500).json({ error: 'Info introuvable' });
    }
    try {
      const data = JSON.parse(stdout.trim());
      res.json({
        status:      'success',
        id:          data.id,
        title:       data.title,
        artist:      data.uploader || data.channel,
        duration:    formatDuration(data.duration || 0),
        durationSec: data.duration || 0,
        thumbnail:   data.thumbnail,
      });
    } catch (e) {
      res.status(500).json({ error: 'Erreur parsing' });
    }
  });
});

// ══════════════════════════════════════════
//  HELPER
// ══════════════════════════════════════════
function formatDuration(secs) {
  if (!secs) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

app.listen(PORT, () => {
  console.log(`🎵 DiopSound API démarrée sur le port ${PORT}`);
  console.log(`   Créée par Elhadji Ndiaye Diop`);
});

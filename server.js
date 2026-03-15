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

  const cmd = `yt-dlp "ytsearch10:${query}" --dump-json --flat-playlist --no-warnings --no-playlist 2>/dev/null`;

  exec(cmd, { timeout: 30000 }, (err, stdout) => {
    if (err || !stdout.trim()) {
      return res.status(500).json({ error: 'Recherche échouée', details: err?.message });
    }

    try {
      const lines = stdout.trim().split('\n').filter(Boolean);
      const results = lines.map(line => {
        const item = JSON.parse(line);
        return {
          id:        item.id,
          title:     item.title,
          artist:    item.uploader || item.channel || '',
          duration:  formatDuration(item.duration || 0),
          durationSec: item.duration || 0,
          thumbnail: item.thumbnail || `https://img.youtube.com/vi/${item.id}/hqdefault.jpg`,
          youtubeId: item.id,
        };
      });
      res.json({ status: 'success', results });
    } catch (e) {
      res.status(500).json({ error: 'Erreur parsing', details: e.message });
    }
  });
});

// ══════════════════════════════════════════
//  STREAM AUDIO — GET /stream?id=VIDEO_ID
// ══════════════════════════════════════════
app.get('/stream', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Paramètre id manquant' });

  // Forcer M4A/AAC — compatible iOS et Android
  const cmd = `yt-dlp "https://www.youtube.com/watch?v=${id}" -f "bestaudio[ext=m4a]/bestaudio[ext=mp4]/bestaudio" --get-url --no-warnings 2>/dev/null`;

  exec(cmd, { timeout: 30000 }, (err, stdout) => {
    if (err || !stdout.trim()) {
      return res.status(500).json({ error: 'Stream introuvable', details: err?.message });
    }
    const audioUrl = stdout.trim().split('\n')[0];
    res.json({ status: 'success', url: audioUrl, id });
  });
});

// ══════════════════════════════════════════
//  INFOS TITRE — GET /info?id=VIDEO_ID
// ══════════════════════════════════════════
app.get('/info', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Paramètre id manquant' });

  const cmd = `yt-dlp "https://www.youtube.com/watch?v=${id}" --dump-json --no-warnings 2>/dev/null`;

  exec(cmd, { timeout: 30000 }, (err, stdout) => {
    if (err || !stdout.trim()) {
      return res.status(500).json({ error: 'Info introuvable' });
    }
    try {
      const data = JSON.parse(stdout.trim());
      res.json({
        status: 'success',
        id:        data.id,
        title:     data.title,
        artist:    data.uploader || data.channel,
        duration:  formatDuration(data.duration || 0),
        durationSec: data.duration || 0,
        thumbnail: data.thumbnail,
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

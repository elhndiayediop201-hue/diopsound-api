const express = require('express');
const { exec, spawn } = require('child_process');
const cors = require('cors');
const https = require('https');
const http = require('http');

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

  const cmd = `yt-dlp "ytsearch15:${query}" --dump-json --flat-playlist --no-warnings --no-playlist --extractor-args "youtube:player_client=android_vr" 2>/dev/null`;

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
//  PROXY AUDIO — GET /audio?id=VIDEO_ID
//  Railway télécharge et sert l'audio → iOS peut lire directement
// ══════════════════════════════════════════
app.get('/audio', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Paramètre id manquant' });

  // Utiliser yt-dlp en mode pipe — envoie l'audio directement dans la réponse HTTP
  res.setHeader('Content-Type', 'audio/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Transfer-Encoding', 'chunked');

  const ytdlp = spawn('yt-dlp', [
    `https://www.youtube.com/watch?v=${id}`,
    '-f', 'bestaudio[ext=m4a]/bestaudio[ext=mp4]/140/bestaudio',
    '--extractor-args', 'youtube:player_client=android_vr',
    '-o', '-',          // output vers stdout
    '--no-warnings',
    '--quiet',
  ]);

  ytdlp.stdout.pipe(res);

  ytdlp.stderr.on('data', (data) => {
    console.error('yt-dlp stderr:', data.toString());
  });

  ytdlp.on('error', (err) => {
    console.error('yt-dlp error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Erreur yt-dlp' });
    }
  });

  ytdlp.on('close', (code) => {
    if (code !== 0) console.warn(`yt-dlp exited with code ${code}`);
  });

  req.on('close', () => {
    ytdlp.kill();
  });
});

// ══════════════════════════════════════════
//  STREAM URL — GET /stream?id=VIDEO_ID
//  Retourne l'URL directe (fallback)
// ══════════════════════════════════════════
app.get('/stream', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Paramètre id manquant' });

  const cmd = `yt-dlp "https://www.youtube.com/watch?v=${id}" \
    -f "bestaudio[ext=m4a]/bestaudio[ext=mp4]/140/bestaudio" \
    --get-url --no-warnings \
    --extractor-args "youtube:player_client=android_vr" \
    2>/dev/null`;

  exec(cmd, { timeout: 45000 }, (err, stdout) => {
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

  const cmd = `yt-dlp "https://www.youtube.com/watch?v=${id}" --dump-json --no-warnings --extractor-args "youtube:player_client=android_vr" 2>/dev/null`;

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

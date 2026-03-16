const express = require('express');
const cors    = require('cors');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ══════════════════════════════════════════
//  CONFIG SPOTIFY
//  ⚠️  Sur Railway : mets ces valeurs dans
//      les Variables d'environnement,
//      PAS en dur dans le code !
// ══════════════════════════════════════════
const SPOTIFY_CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID    ;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET 
const SPOTIFY_REDIRECT_URI  = process.env.SPOTIFY_REDIRECT_URI  

// Cache token client credentials (pour search/chart)
let ccToken     = null;
let ccExpiresAt = 0;

// ══════════════════════════════════════════
//  TOKEN CLIENT CREDENTIALS
//  (pas besoin d'un utilisateur connecté,
//   pour search et metadata uniquement)
// ══════════════════════════════════════════
async function getClientToken() {
  if (ccToken && Date.now() < ccExpiresAt - 10000) return ccToken;

  const creds  = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const body   = 'grant_type=client_credentials';

  const data = await fetchJson('https://accounts.spotify.com/api/token', {
    method:  'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body,
  });

  ccToken     = data.access_token;
  ccExpiresAt = Date.now() + data.expires_in * 1000;
  return ccToken;
}

// ══════════════════════════════════════════
//  AUTH UTILISATEUR — Étape 1 : Login
//  L'app mobile redirige l'utilisateur ici
// ══════════════════════════════════════════
app.get('/auth/login', (req, res) => {
  const scopes = [
    'streaming',
    'user-read-email',
    'user-read-private',
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'user-library-read',
    'user-library-modify',
    'playlist-read-private',
    'user-top-read',
    'user-read-recently-played',
  ].join(' ');

  const params = new URLSearchParams({
    client_id:     SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri:  SPOTIFY_REDIRECT_URI,
    scope:         scopes,
    show_dialog:   'false',
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

// ══════════════════════════════════════════
//  AUTH UTILISATEUR — Étape 2 : Callback
//  Spotify redirige ici avec le code
// ══════════════════════════════════════════
app.post('/auth/token', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code manquant' });

  try {
    const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const data  = await fetchJson('https://accounts.spotify.com/api/token', {
      method:  'POST',
      headers: {
        'Authorization': `Basic ${creds}`,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
      }).toString(),
    });

    res.json({
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_in:    data.expires_in,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
//  AUTH — Refresh token
// ══════════════════════════════════════════
app.post('/auth/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token manquant' });

  try {
    const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const data  = await fetchJson('https://accounts.spotify.com/api/token', {
      method:  'POST',
      headers: {
        'Authorization': `Basic ${creds}`,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token,
      }).toString(),
    });

    res.json({
      access_token: data.access_token,
      expires_in:   data.expires_in,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
//  HEALTH
// ══════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    author: 'Elhadji Ndiaye Diop',
    source: 'Spotify API',
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
  });
});

// ══════════════════════════════════════════
//  CHART — Top 50 mondial Spotify
// ══════════════════════════════════════════
app.get('/chart', async (req, res) => {
  try {
    const token = await getClientToken();
    // Playlist "Top 50 - Global" officielle Spotify
    const data  = await spotifyGet('playlists/37i9dQZEVXbMDoHDwVN2tF/tracks?limit=50&market=FR', token);
    const tracks = (data.items || [])
      .filter(i => i.track && i.track.type === 'track')
      .map(i => normalizeSpotify(i.track));
    res.json({ status: 'success', results: tracks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
//  SEARCH
// ══════════════════════════════════════════
app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'q manquant' });

  try {
    const token = await getClientToken();
    const data  = await spotifyGet(
      `search?q=${encodeURIComponent(q)}&type=track&limit=25&market=FR`,
      token
    );
    const tracks = (data.tracks?.items || []).map(normalizeSpotify);
    res.json({ status: 'success', results: tracks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
//  ARTISTE
// ══════════════════════════════════════════
app.get('/artist/:id', async (req, res) => {
  try {
    const token = await getClientToken();
    const [artist, topTracks, albums] = await Promise.all([
      spotifyGet(`artists/${req.params.id}`, token),
      spotifyGet(`artists/${req.params.id}/top-tracks?market=FR`, token),
      spotifyGet(`artists/${req.params.id}/albums?limit=6&include_groups=album,single&market=FR`, token),
    ]);

    res.json({
      status: 'success',
      artist: {
        id:      artist.id,
        name:    artist.name,
        picture: artist.images?.[0]?.url || '',
        fans:    artist.followers?.total || 0,
        genres:  artist.genres || [],
      },
      topTracks: (topTracks.tracks || []).map(normalizeSpotify),
      albums: (albums.items || []).map(a => ({
        id:    a.id,
        title: a.name,
        cover: a.images?.[0]?.url || '',
        year:  a.release_date?.slice(0, 4),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
//  ALBUM
// ══════════════════════════════════════════
app.get('/album/:id', async (req, res) => {
  try {
    const token = await getClientToken();
    const data  = await spotifyGet(`albums/${req.params.id}?market=FR`, token);

    res.json({
      status: 'success',
      album: {
        id:     data.id,
        title:  data.name,
        cover:  data.images?.[0]?.url || '',
        artist: data.artists?.[0]?.name || '',
        year:   data.release_date?.slice(0, 4),
        tracks: (data.tracks?.items || []).map(t => normalizeSpotify({ ...t, album: data })),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
//  GENRE — recherche par genre
// ══════════════════════════════════════════
app.get('/genre/:name', async (req, res) => {
  try {
    const token = await getClientToken();
    const data  = await spotifyGet(
      `search?q=genre:${encodeURIComponent(req.params.name)}&type=track&limit=20&market=FR`,
      token
    );
    const tracks = (data.tracks?.items || []).map(normalizeSpotify);
    res.json({ status: 'success', results: tracks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
//  RECOMMENDATIONS — basé sur une piste
// ══════════════════════════════════════════
app.get('/recommendations', async (req, res) => {
  const { seed_tracks, seed_artists } = req.query;
  if (!seed_tracks && !seed_artists) return res.status(400).json({ error: 'seed manquant' });

  try {
    const token  = await getClientToken();
    const params = new URLSearchParams({ limit: '20', market: 'FR' });
    if (seed_tracks)  params.set('seed_tracks',  seed_tracks);
    if (seed_artists) params.set('seed_artists', seed_artists);

    const data   = await spotifyGet(`recommendations?${params}`, token);
    const tracks = (data.tracks || []).map(normalizeSpotify);
    res.json({ status: 'success', results: tracks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════
async function spotifyGet(path, token) {
  return fetchJson(`https://api.spotify.com/v1/${path}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
}

function normalizeSpotify(item) {
  return {
    id:          item.id,
    spotifyId:   item.id,
    title:       item.name || '',
    artist:      item.artists?.[0]?.name || '',
    artistId:    item.artists?.[0]?.id   || '',
    album:       item.album?.name        || '',
    albumId:     item.album?.id          || '',
    duration:    formatDuration(Math.floor((item.duration_ms || 0) / 1000)),
    durationSec: Math.floor((item.duration_ms || 0) / 1000),
    thumbnail:   item.album?.images?.[0]?.url || '',
    previewUrl:  item.preview_url || null,  // preview 30s Spotify (peut être null)
    explicit:    item.explicit || false,
    popularity:  item.popularity || 0,
    uri:         item.uri || `spotify:track:${item.id}`,
  };
}

function formatDuration(s) {
  if (!s) return '0:00';
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj  = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const lib     = isHttps ? https : require('http');

    const reqOptions = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   options.method || 'GET',
      headers:  {
        'User-Agent':   'DiopSound/2.0',
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    };

    const req = lib.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });

    if (options.body) req.write(options.body);
    req.end();
  });
}

app.listen(PORT, () => console.log(`🎵 DiopSound API v2 (Spotify) — Elhadji Ndiaye Diop — Port ${PORT}`));

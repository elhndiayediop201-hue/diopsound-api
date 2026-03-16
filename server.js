const express = require('express');
const cors    = require('cors');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI  = process.env.SPOTIFY_REDIRECT_URI || 'https://auth.expo.io/@elhadji2002/diopsound';

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: headers || {} };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const buf = Buffer.from(body);
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': buf.length }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const creds = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
  const data = await httpsPost(
    'https://accounts.spotify.com/api/token',
    { 'Authorization': 'Basic ' + creds, 'Content-Type': 'application/x-www-form-urlencoded' },
    'grant_type=client_credentials'
  );
  if (!data.access_token) throw new Error('Token failed: ' + JSON.stringify(data));
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

function normalize(t) {
  return {
    id:          t.id,
    spotifyId:   t.id,
    uri:         t.uri || ('spotify:track:' + t.id),
    title:       t.name || '',
    artist:      (t.artists && t.artists[0] && t.artists[0].name) || '',
    artistId:    (t.artists && t.artists[0] && t.artists[0].id)   || '',
    album:       (t.album && t.album.name) || '',
    albumId:     (t.album && t.album.id)   || '',
    thumbnail:   (t.album && t.album.images && t.album.images[0] && t.album.images[0].url) || '',
    previewUrl:  t.preview_url || null,
    durationSec: Math.floor((t.duration_ms || 0) / 1000),
    duration:    Math.floor((t.duration_ms||0)/60000) + ':' + String(Math.floor(((t.duration_ms||0)%60000)/1000)).padStart(2,'0'),
    explicit:    t.explicit || false,
    popularity:  t.popularity || 0,
  };
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', has_id: !!CLIENT_ID, has_secret: !!CLIENT_SECRET });
});

app.get('/debug-token', async (req, res) => {
  try {
    const t = await getToken();
    res.json({ ok: true, token_prefix: t.slice(0,10) });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'q manquant' });
  try {
    const token = await getToken();
    const url = 'https://api.spotify.com/v1/search?q=' + encodeURIComponent(q) + '&type=track&limit=20&market=FR';
    console.log('Search URL:', url);
    const data = await httpsGet(url, { 'Authorization': 'Bearer ' + token });
    console.log('Search result:', data.tracks ? data.tracks.items.length + ' tracks' : JSON.stringify(data).slice(0,100));
    const tracks = (data.tracks && data.tracks.items ? data.tracks.items : []).map(normalize);
    res.json({ status: 'success', results: tracks });
  } catch(e) { console.error('search error:', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/chart', async (req, res) => {
  try {
    const token = await getToken();
    const url = 'https://api.spotify.com/v1/search?q=top+hits+2025&type=track&limit=50&market=FR';
    const data = await httpsGet(url, { 'Authorization': 'Bearer ' + token });
    const tracks = (data.tracks && data.tracks.items ? data.tracks.items : []).map(normalize);
    res.json({ status: 'success', results: tracks });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/genre/:name', async (req, res) => {
  try {
    const token = await getToken();
    const url = 'https://api.spotify.com/v1/search?q=' + encodeURIComponent(req.params.name) + '&type=track&limit=20&market=FR';
    const data = await httpsGet(url, { 'Authorization': 'Bearer ' + token });
    const tracks = (data.tracks && data.tracks.items ? data.tracks.items : []).map(normalize);
    res.json({ status: 'success', results: tracks });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/artist/:id', async (req, res) => {
  try {
    const token = await getToken();
    const [artist, tops, albums] = await Promise.all([
      httpsGet('https://api.spotify.com/v1/artists/' + req.params.id, { 'Authorization': 'Bearer ' + token }),
      httpsGet('https://api.spotify.com/v1/artists/' + req.params.id + '/top-tracks?market=FR', { 'Authorization': 'Bearer ' + token }),
      httpsGet('https://api.spotify.com/v1/artists/' + req.params.id + '/albums?limit=6&include_groups=album,single&market=FR', { 'Authorization': 'Bearer ' + token }),
    ]);
    res.json({
      status: 'success',
      artist: { id: artist.id, name: artist.name, picture: (artist.images && artist.images[0] && artist.images[0].url) || '', fans: (artist.followers && artist.followers.total) || 0 },
      topTracks: (tops.tracks || []).map(normalize),
      albums: (albums.items || []).map(a => ({ id: a.id, title: a.name, cover: (a.images && a.images[0] && a.images[0].url) || '', year: a.release_date ? a.release_date.slice(0,4) : '' })),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/album/:id', async (req, res) => {
  try {
    const token = await getToken();
    const data  = await httpsGet('https://api.spotify.com/v1/albums/' + req.params.id + '?market=FR', { 'Authorization': 'Bearer ' + token });
    res.json({
      status: 'success',
      album: {
        id: data.id, title: data.name,
        cover: (data.images && data.images[0] && data.images[0].url) || '',
        artist: (data.artists && data.artists[0] && data.artists[0].name) || '',
        year: data.release_date ? data.release_date.slice(0,4) : '',
        tracks: (data.tracks && data.tracks.items ? data.tracks.items : []).map(t => normalize({ ...t, album: data })),
      },
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/recommendations', async (req, res) => {
  const { seed_tracks, seed_artists } = req.query;
  if (!seed_tracks && !seed_artists) return res.status(400).json({ error: 'seed manquant' });
  try {
    const token = await getToken();
    let url = 'https://api.spotify.com/v1/recommendations?limit=20&market=FR';
    if (seed_tracks)  url += '&seed_tracks='  + encodeURIComponent(seed_tracks);
    if (seed_artists) url += '&seed_artists=' + encodeURIComponent(seed_artists);
    const data = await httpsGet(url, { 'Authorization': 'Bearer ' + token });
    res.json({ status: 'success', results: (data.tracks || []).map(normalize) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/auth/login', (req, res) => {
  const scopes = 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state user-read-currently-playing user-library-read user-library-modify playlist-read-private user-top-read user-read-recently-played';
  const url = 'https://accounts.spotify.com/authorize?client_id=' + CLIENT_ID + '&response_type=code&redirect_uri=' + encodeURIComponent(REDIRECT_URI) + '&scope=' + encodeURIComponent(scopes);
  res.redirect(url);
});

app.post('/auth/token', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code manquant' });
  try {
    const creds = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
    const data  = await httpsPost(
      'https://accounts.spotify.com/api/token',
      { 'Authorization': 'Basic ' + creds, 'Content-Type': 'application/x-www-form-urlencoded' },
      'grant_type=authorization_code&code=' + encodeURIComponent(code) + '&redirect_uri=' + encodeURIComponent(REDIRECT_URI)
    );
    res.json({ access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/auth/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token manquant' });
  try {
    const creds = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
    const data  = await httpsPost(
      'https://accounts.spotify.com/api/token',
      { 'Authorization': 'Basic ' + creds, 'Content-Type': 'application/x-www-form-urlencoded' },
      'grant_type=refresh_token&refresh_token=' + encodeURIComponent(refresh_token)
    );
    res.json({ access_token: data.access_token, expires_in: data.expires_in });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log('DiopSound API — Port', PORT);
  console.log('CLIENT_ID:', CLIENT_ID ? CLIENT_ID.slice(0,8) + '...' : 'MANQUANT');
  console.log('CLIENT_SECRET:', CLIENT_SECRET ? '****' : 'MANQUANT');
});

// ===================================
// --- IMPORTS & INITIALIZATION ---
// ===================================
require('dotenv').config(); // Load .env file FIRST
const siteName = process.env.SITE_NAME || 'RatuHentai'; // Define siteName globally
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const { inject } = require('@vercel/analytics');
// Import Models
const Anime = require('./models/Anime');
const Episode = require('./models/Episode');
const Bookmark = require('./models/Bookmark');

// Import Scraper Utilities for nekopoi.chat
const { scrapeAndSaveCv, getAndCacheEpisodeDataCv } = require('./scraperUtilsCv');

const app = express();
inject();
// ===================================
// --- GLOBAL CONFIGURATION ---
// ===================================
const PORT = process.env.PORT || 3000;
const ITEMS_PER_PAGE = 24;
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;

// ===================================
// --- MIDDLEWARE ---
// ===================================
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ===================================
// --- DATABASE CONNECTION (DIPINDAHKAN KE ATAS) ---
// ===================================
const DB_URI = process.env.DB_URI || 'mongodb://localhost:27017/animeCvDB';
mongoose.connect(DB_URI, {
  serverSelectionTimeoutMS: 30000
})
  .then(() => console.log('Successfully connected to MongoDB...'))
  .catch(err => console.error('Failed to connect to MongoDB:', err));


// ===================================
// --- SESSION CONFIGURATION (SEKARANG DI BAWAH DB) ---
// ===================================
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback_secret_please_change',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 // 1 day
  },
  store: MongoStore.create({
    mongoUrl: DB_URI,
    collectionName: 'sessions',
    ttl: 14 * 24 * 60 * 60
  })
}));

// ===================================
// --- HELPER FUNCTIONS ---
// ===================================
const encodeAnimeSlugs = (animes) => {
  if (!animes || !Array.isArray(animes)) return [];
  return animes.map(anime => {
    if (!anime) return null;
    const encodedSlug = anime.pageSlug ? encodeURIComponent(anime.pageSlug) : null;
    const imageUrl = (anime.imageUrl && anime.imageUrl.startsWith('http'))
      ? anime.imageUrl
      : SITE_URL + (anime.imageUrl || '/images/default.jpg');
    return { ...anime, pageSlug: encodedSlug, imageUrl: imageUrl };
  }).filter(Boolean);
};

// ===================================
// --- ADMIN AUTH MIDDLEWARE ---
// ===================================
const isAdmin = (req, res, next) => {
  if (req.session && req.session.isAdmin) {
    return next();
  } else {
    res.redirect('/admin/login');
  }
};

// ===================================
// --- ADMIN ROUTES ---
// ===================================

app.get('/admin/login', (req, res) => {
  if (req.session && req.session.isAdmin) {
    return res.redirect('/admin');
  }
  res.render('admin/login', {
    page: 'admin-login', pageTitle: `Admin Login - ${siteName}`, error: req.query.error,
    pageDescription: '', pageImage: '', pageUrl: '', query: '', siteName: siteName
  });
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const adminUser = process.env.ADMIN_USERNAME;
  const adminPass = process.env.ADMIN_PASSWORD;

  if (username === adminUser && password === adminPass) {
    req.session.isAdmin = true;
    res.redirect('/admin');
  } else {
    res.redirect('/admin/login?error=Invalid credentials');
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error("Error destroying session:", err);
    res.clearCookie('connect.sid');
    res.redirect('/admin/login');
  });
});

app.get('/admin', isAdmin, (req, res) => {
  res.render('admin/dashboard', {
    page: 'admin-dashboard', pageTitle: `Admin Dashboard - ${siteName}`,
    pageDescription: '', pageImage: '', pageUrl: '', query: '', siteName: siteName
  });
});

app.get('/admin/anime', isAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 30;
    const skipVal = (page - 1) * limit;
    const [animes, totalCount] = await Promise.all([
      Anime.find().sort({ updatedAt: -1 }).skip(skipVal).limit(limit).lean(),
      Anime.countDocuments()
    ]);
    const totalPages = Math.ceil(totalCount / limit);
    res.render('admin/anime-list', {
      animes: animes, page: 'admin-anime-list', pageTitle: `Admin - Anime List (Halaman ${page}) - ${siteName}`,
      currentPage: page, totalPages: totalPages, baseUrl: '/admin/anime',
      pageDescription: '', pageImage: '', pageUrl: '', query: '', siteName: siteName
    });
  } catch (error) { console.error("Admin Anime List Error:", error); res.status(500).send('Error loading admin anime list.'); }
});

app.get('/admin/anime/:slug/edit', isAdmin, async (req, res) => {
  try {
    const pageSlug = decodeURIComponent(req.params.slug);
    const anime = await Anime.findOne({ pageSlug: pageSlug }).lean();
    if (!anime) return res.status(404).send('Anime not found.');
    res.render('admin/edit-anime', {
      anime: anime, page: 'admin-edit-anime', pageTitle: `Edit Anime: ${anime.title} - ${siteName}`,
      pageDescription: '', pageImage: '', pageUrl: '', query: '', siteName: siteName
    });
  } catch (error) { console.error(`Admin Edit Anime GET Error (${req.params.slug}):`, error); res.status(500).send('Error loading anime edit form.'); }
});

app.post('/admin/anime/:slug/edit', isAdmin, async (req, res) => {
  try {
    const pageSlug = decodeURIComponent(req.params.slug);
    const updateData = req.body;
    const dataToUpdate = {
      title: updateData.title, alternativeTitle: updateData.alternativeTitle,
      synopsis: updateData.synopsis, imageUrl: updateData.imageUrl,
      "info.Status": updateData['info.Status'], "info.Released": updateData['info.Released'],
      "info.Type": updateData['info.Type'], "info.Studio": updateData['info.Studio'], // Example add
      "info.Producers": updateData['info.Producers'], // Example add
      genres: updateData.genres ? updateData.genres.split(',').map(g => g.trim()).filter(Boolean) : [],
    };
    Object.keys(dataToUpdate).forEach(key => (dataToUpdate[key] === undefined || dataToUpdate[key] === '') && delete dataToUpdate[key]);
    const updatedAnime = await Anime.findOneAndUpdate({ pageSlug: pageSlug }, { $set: dataToUpdate }, { new: true });
    if (!updatedAnime) return res.status(404).send('Anime not found for update.');
    console.log(`Successfully updated anime: ${pageSlug}`);
    res.redirect('/admin/anime');
  } catch (error) { console.error(`Admin Update Anime POST Error (${req.params.slug}):`, error); res.status(500).send('Error updating anime.'); }
});

app.get('/admin/episodes', isAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 30;
    const skipVal = (page - 1) * limit;
    const [episodes, totalCount] = await Promise.all([
      Episode.find().sort({ updatedAt: -1 }).skip(skipVal).limit(limit).lean(),
      Episode.countDocuments()
    ]);
    const totalPages = Math.ceil(totalCount / limit);
    res.render('admin/episode-list', {
      episodes: episodes, page: 'admin-episode-list', pageTitle: `Admin - Episode List (Halaman ${page}) - ${siteName}`,
      currentPage: page, totalPages: totalPages, baseUrl: '/admin/episodes',
      pageDescription: '', pageImage: '', pageUrl: '', query: '', siteName: siteName
    });
  } catch (error) { console.error("Admin Episode List Error:", error); res.status(500).send('Error loading admin episode list.'); }
});

app.get('/admin/episode/:slug/edit', isAdmin, async (req, res) => {
  try {
    const episodeSlug = decodeURIComponent(req.params.slug);
    const episode = await Episode.findOne({ episodeSlug: episodeSlug }).lean();
    if (!episode) return res.status(404).send('Episode not found.');
    res.render('admin/edit-episode', {
      episode: episode, page: 'admin-edit-episode', pageTitle: `Edit Episode: ${episode.title || episode.episodeSlug} - ${siteName}`,
      pageDescription: '', pageImage: '', pageUrl: '', query: '', siteName: siteName
    });
  } catch (error) { console.error(`Admin Edit Episode GET Error (${req.params.slug}):`, error); res.status(500).send('Error loading episode edit form.'); }
});

app.post('/admin/episode/:slug/edit', isAdmin, async (req, res) => {
  try {
    const episodeSlug = decodeURIComponent(req.params.slug);
    const formData = req.body;
    const dataToUpdate = { title: formData.title, thumbnailUrl: formData.thumbnailUrl };
    if (formData.streams && Array.isArray(formData.streams)) {
      dataToUpdate.streaming = formData.streams.filter(stream => stream && stream.name && stream.url)
        .map(stream => ({ name: stream.name.trim(), url: stream.url.trim() }));
    } else { dataToUpdate.streaming = []; }
    if (formData.downloads && Array.isArray(formData.downloads)) {
      dataToUpdate.downloads = formData.downloads.filter(qG => qG && qG.quality)
        .map(qG => ({ quality: qG.quality.trim(), links: (qG.links && Array.isArray(qG.links)) ? qG.links.filter(l => l && l.host && l.url).map(l => ({ host: l.host.trim(), url: l.url.trim() })) : [] }))
        .filter(qG => qG.links.length > 0);
    } else { dataToUpdate.downloads = []; }
    Object.keys(dataToUpdate).forEach(key => (dataToUpdate[key] === undefined || dataToUpdate[key] === '') && delete dataToUpdate[key]);
    const updatedEpisode = await Episode.findOneAndUpdate({ episodeSlug: episodeSlug }, { $set: dataToUpdate }, { new: true, runValidators: true });
    if (!updatedEpisode) return res.status(404).send('Episode not found for update.');
    console.log(`Successfully updated episode: ${episodeSlug}`);
    res.redirect('/admin/episodes');
  } catch (error) { console.error(`Admin Update Episode POST Error (${req.params.slug}):`, error); res.status(500).send(`Error updating episode: ${error.message}`); }
});

app.get('/admin/anime/add', isAdmin, (req, res) => {
  res.render('admin/add-anime', {
    page: 'admin-add-anime', pageTitle: `Tambah Anime Baru - ${siteName}`,
    pageDescription: '', pageImage: '', pageUrl: '', query: '', siteName: siteName
  });
});

app.post('/admin/anime/add', isAdmin, async (req, res) => {
  try {
    const formData = req.body;
    if (!formData.title || !formData.pageSlug) return res.status(400).send('Judul dan Slug wajib diisi.');
    const existingAnime = await Anime.findOne({ pageSlug: formData.pageSlug });
    if (existingAnime) return res.status(400).send(`Slug "${formData.pageSlug}" sudah digunakan.`);
    const newAnimeData = {
      title: formData.title, pageSlug: formData.pageSlug,
      alternativeTitle: formData.alternativeTitle || '', imageUrl: formData.imageUrl || '/images/default.jpg',
      synopsis: formData.synopsis || '', info: { Status: formData['info.Status'] || 'Unknown', Released: formData['info.Released'] || '', Type: formData['info.Type'] || '', Studio: formData['info.Studio'] || '', Producers: formData['info.Producers'] || '' },
      genres: formData.genres ? formData.genres.split(',').map(g => g.trim()).filter(Boolean) : [], episodes: [], characters: []
    };
    const createdAnime = await Anime.create(newAnimeData);
    console.log(`Anime baru ditambahkan: ${createdAnime.pageSlug}`);
    try {
      const { notifyGoogleIndexing } = require('./scraperUtilsCv');
      await notifyGoogleIndexing(createdAnime.pageSlug, 'URL_UPDATED');
    } catch (e) { console.warn("Gagal notifikasi Google Indexing saat tambah manual"); }
    res.redirect('/admin/anime');
  } catch (error) { console.error("Admin Add Anime POST Error:", error); res.status(500).send('Gagal menambahkan anime baru.'); }
});

app.post('/admin/anime/:slug/episodes/add', isAdmin, async (req, res) => {
  const parentPageSlug = decodeURIComponent(req.params.slug);
  try {
    const { episodeTitle, episodeSlug, episodeDate } = req.body;
    if (!episodeTitle || !episodeSlug) return res.status(400).send('Judul dan Slug Episode wajib diisi.');
    const existingEpisode = await Episode.findOne({ episodeSlug: episodeSlug });
    if (existingEpisode) return res.status(400).send(`Slug Episode "${episodeSlug}" sudah digunakan.`);
    const parentAnime = await Anime.findOne({ pageSlug: parentPageSlug });
    if (!parentAnime) return res.status(404).send('Anime induk tidak ditemukan.');
    const newEpisodeForAnime = { title: episodeTitle, url: episodeSlug, date: episodeDate || new Date().toLocaleDateString('id-ID') };
    await Anime.updateOne({ pageSlug: parentPageSlug }, { $push: { episodes: newEpisodeForAnime } });
    console.log(`Episode "${episodeSlug}" ditambahkan ke array Anime "${parentPageSlug}"`);
    const newEpisodeDataForCache = {
      episodeSlug: episodeSlug, title: episodeTitle, streaming: [], downloads: [], thumbnailUrl: '/images/default_thumb.jpg',
      animeTitle: parentAnime.title, animeSlug: parentAnime.pageSlug, animeImageUrl: parentAnime.imageUrl
    };
    await Episode.create(newEpisodeDataForCache);
    console.log(`Dokumen cache dibuat untuk Episode "${episodeSlug}"`);
    res.redirect(`/admin/anime/${encodeURIComponent(parentPageSlug)}/edit`);
  } catch (error) { console.error(`Admin Add Episode POST Error for ${parentPageSlug}:`, error); res.status(500).send('Gagal menambahkan episode baru.'); }
});

// Homepage (Fetches directly from DB)
app.get('/', async (req, res) => {
  try {
    const SLIDER_COUNT = 5;
    const SECTION_LIMIT = 12;
    const statusField = "info.Status";
    const [sliderAnimes, ongoingAnimes, completedAnimes] = await Promise.all([
      Anime.find().sort({ updatedAt: -1 }).limit(SLIDER_COUNT).select('title pageSlug imageUrl').lean(),
      Anime.find({ [statusField]: /ongoing/i }).sort({ _id: -1 }).limit(SECTION_LIMIT).select('title pageSlug imageUrl').lean(),
      Anime.find({ [statusField]: /completed/i }).sort({ _id: -1 }).limit(SECTION_LIMIT).select('title pageSlug imageUrl').lean()
    ]);
    res.render('home', {
      sliderAnimes: encodeAnimeSlugs(sliderAnimes), ongoingAnimes: encodeAnimeSlugs(ongoingAnimes), completedAnimes: encodeAnimeSlugs(completedAnimes),
      page: 'home', pageTitle: `${siteName} – Nonton Dan Download Hentai Subtitle Indonesia`, pageDescription: 'Duniahentai tempat download dan streaming anime hentai sub indo maupun subtitle Indonesia dengan kualitas terbaik dan selalu cepat updated hanya di duniahentai. Nikmati sensasi menonton anime hentai, ecchi, uncensored, sub indo kualitas video HD 1080p 720p 480p.',
      pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL + req.originalUrl, siteName: siteName
    });
  } catch (error) { console.error("Homepage Error:", error); res.status(500).send('Terjadi kesalahan: ' + error.message); }
});

// Search (Fetches directly from DB)
app.get('/search', async (req, res) => {
  try {
    const searchQuery = req.query.q;
    const page = parseInt(req.query.page) || 1;
    if (!searchQuery) return res.redirect('/');
    const query = { title: new RegExp(searchQuery, 'i') };
    const skipVal = (page - 1) * ITEMS_PER_PAGE;
    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ _id: -1 }).skip(skipVal).limit(ITEMS_PER_PAGE).lean(), Anime.countDocuments(query)
    ]);
    const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
    res.render('list', {
      animes: encodeAnimeSlugs(animes), pageTitle: `Cari: "${searchQuery}" - Halaman ${page} - ${siteName}`,
      query: searchQuery, page: 'list', pageDescription: `Hasil pencarian untuk "${searchQuery}".`,
      pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL + req.originalUrl,
      currentPage: page, totalPages: totalPages, baseUrl: `/search?q=${encodeURIComponent(searchQuery)}`, siteName: siteName
    });
  } catch (error) { console.error("Search Error:", error); res.status(500).send('Terjadi kesalahan: ' + error.message); }
});

// Genre Filter (Fetches directly from DB)
app.get('/genre/:genreName', async (req, res) => {
  try {
    const genreName = req.params.genreName;
    const page = parseInt(req.query.page) || 1;
    const query = { genres: genreName };
    const skipVal = (page - 1) * ITEMS_PER_PAGE;
    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ _id: -1 }).skip(skipVal).limit(ITEMS_PER_PAGE).lean(), Anime.countDocuments(query)
    ]);
    const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
    res.render('list', {
      animes: encodeAnimeSlugs(animes), pageTitle: `Genre: ${genreName} - Halaman ${page} - ${siteName}`,
      query: '', page: 'list', pageDescription: `Daftar hentai dengan genre ${genreName}.`,
      pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL + req.originalUrl,
      currentPage: page, totalPages: totalPages, baseUrl: `/genre/${encodeURIComponent(genreName)}`, siteName: siteName
    });
  } catch (error) { console.error("Genre Filter Error:", error); res.status(500).send('Terjadi kesalahan: ' + error.message); }
});

// Status Filter (Fetches directly from DB)
app.get('/status/:statusName', async (req, res) => {
  try {
    const statusName = req.params.statusName;
    const page = parseInt(req.query.page) || 1;
    const query = { "info.Status": new RegExp(`^${statusName}$`, 'i') };
    const skipVal = (page - 1) * ITEMS_PER_PAGE;
    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ _id: -1 }).skip(skipVal).limit(ITEMS_PER_PAGE).lean(), Anime.countDocuments(query)
    ]);
    const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
    res.render('list', {
      animes: encodeAnimeSlugs(animes), pageTitle: `Status: ${statusName} - Halaman ${page} - ${siteName}`,
      query: '', page: 'list', pageDescription: `Daftar hentai dengan status ${statusName}.`,
      pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL + req.originalUrl,
      currentPage: page, totalPages: totalPages, baseUrl: `/status/${encodeURIComponent(statusName)}`, siteName: siteName
    });
  } catch (error) { console.error(`Status Filter Error (${req.params.statusName}):`, error); res.status(500).send('Terjadi kesalahan: ' + error.message); }
});

// Type Filter (Fetches directly from DB)
app.get('/type/:typeName', async (req, res) => {
  try {
    const typeName = req.params.typeName;
    const page = parseInt(req.query.page) || 1;
    const query = { "info.Type": new RegExp(`^${typeName}$`, 'i') };
    const skipVal = (page - 1) * ITEMS_PER_PAGE;
    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ _id: -1 }).skip(skipVal).limit(ITEMS_PER_PAGE).lean(), Anime.countDocuments(query)
    ]);
    const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
    res.render('list', {
      animes: encodeAnimeSlugs(animes), pageTitle: `Type: ${typeName} - Halaman ${page} - ${siteName}`,
      query: '', page: 'list', pageDescription: `Daftar hentai type ${typeName}.`,
      pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL + req.originalUrl,
      currentPage: page, totalPages: totalPages, baseUrl: `/type/${encodeURIComponent(typeName)}`, siteName: siteName
    });
  } catch (error) { console.error(`Type Filter Error (${req.params.typeName}):`, error); res.status(500).send('Terjadi kesalahan: ' + error.message); }
});

// Studio Filter (Fetches directly from DB)
app.get('/studio/:studioName', async (req, res) => {
  try {
    const studioName = req.params.studioName;
    const page = parseInt(req.query.page) || 1;
    const query = { "info.Studio": new RegExp(`^${studioName}$`, 'i') };
    const skipVal = (page - 1) * ITEMS_PER_PAGE;
    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ _id: -1 }).skip(skipVal).limit(ITEMS_PER_PAGE).lean(), Anime.countDocuments(query)
    ]);
    const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
    res.render('list', {
      animes: encodeAnimeSlugs(animes), pageTitle: `Studio: ${studioName} - Halaman ${page} - ${siteName}`,
      query: '', page: 'list', pageDescription: `Daftar hentai studio ${studioName}.`,
      pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL + req.originalUrl,
      currentPage: page, totalPages: totalPages, baseUrl: `/studio/${encodeURIComponent(studioName)}`, siteName: siteName
    });
  } catch (error) { console.error(`Studio Filter Error (${req.params.studioName}):`, error); res.status(500).send('Terjadi kesalahan: ' + error.message); }
});

// Anime List (Fetches directly from DB)
app.get('/anime-list', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const skipVal = (page - 1) * ITEMS_PER_PAGE;
    const [animes, totalCount] = await Promise.all([
      Anime.find().sort({ _id: -1 }).skip(skipVal).limit(ITEMS_PER_PAGE).lean(), Anime.countDocuments()
    ]);
    const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
    res.render('anime-list', {
      animes: encodeAnimeSlugs(animes), page: 'anime-list', pageTitle: `Daftar Anime - Halaman ${page} - ${siteName}`,
      pageDescription: 'Lihat semua koleksi hentai kami.', pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL + req.originalUrl,
      currentPage: page, totalPages: totalPages, baseUrl: '/anime-list', siteName: siteName
    });
  } catch (error) { console.error("Anime List Error:", error); res.status(500).send('Terjadi kesalahan: ' + error.message); }
});

// Genre List (Fetches directly from DB)
app.get('/genre-list', async (req, res) => {
  try {
    const genres = await Anime.distinct('genres');
    genres.sort();
    res.render('genre-list', {
      genres: genres, page: 'genre-list', pageTitle: `Daftar Genre - ${siteName}`,
      pageDescription: 'Jelajahi hentai berdasarkan genre.', pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL + req.originalUrl, siteName: siteName
    });
  } catch (error) { console.error("Genre List Error:", error); res.status(500).send('Terjadi kesalahan: ' + error.message); }
});

// Latest Episodes (Fetches directly from DB)
app.get('/episode', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = ITEMS_PER_PAGE;
    const skipVal = (page - 1) * limit;
    const [episodes, totalCount] = await Promise.all([
      Episode.find().sort({ createdAt: -1 }).skip(skipVal).limit(limit).lean(), Episode.countDocuments()
    ]);
    const totalPages = Math.ceil(totalCount / limit);
    const encodedEpisodes = episodes.map(ep => ({ ...ep, episodeSlug: ep.episodeSlug ? encodeURIComponent(ep.episodeSlug) : null, animeSlug: ep.animeSlug ? encodeURIComponent(ep.animeSlug) : null }));
    res.render('latest-episodes', {
      episodes: encodedEpisodes, page: 'latest-episodes', pageTitle: `Episode Terbaru - Halaman ${page} - ${siteName}`,
      pageDescription: 'Lihat daftar episode terbaru.', pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL + req.originalUrl,
      currentPage: page, totalPages: totalPages, baseUrl: '/episode', siteName: siteName
    });
  } catch (error) { console.error("Latest Episodes Error:", error); res.status(500).send('Terjadi kesalahan: ' + error.message); }
});


// --- Anime Detail Route (NO AUTO SCRAPE) ---
app.get('/anime/:slug', async (req, res) => {
  try {
    const pageSlug = decodeURIComponent(req.params.slug);
    // --- BERUBAH: HANYA cari di DB ---
    const [animeData, recommendations] = await Promise.all([
      Anime.findOne({ pageSlug: pageSlug }).lean(),
      Anime.aggregate([{ $match: { pageSlug: { $ne: pageSlug } } }, { $sample: { size: 9 } }])
    ]);
    // --- AKHIR PERUBAHAN ---

    // --- BERUBAH: Hapus blok 'if (!mainAnimeData) { scrape... }' ---
    // Langsung cek jika tidak ditemukan
    if (!animeData) {
      console.log(`Data '${pageSlug}' not found in DB.`);
      return res.status(404).render('404', {
        page: '404', pageTitle: `404 - ${siteName}`, pageDescription: 'Anime tidak ditemukan.',
        pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL + req.originalUrl, query: '', siteName: siteName
      });
    }
    // --- AKHIR PERUBAHAN ---

    console.log(`Data '${pageSlug}' found in Database.`);
    const encodedRecommendations = encodeAnimeSlugs(recommendations);
    const description = (animeData.synopsis || '').substring(0, 160) + '...';
    const imageUrl = (animeData.imageUrl && animeData.imageUrl.startsWith('http')) ? animeData.imageUrl : SITE_URL + (animeData.imageUrl || '/images/default.jpg');
    const encodedMainData = { ...animeData, pageSlugEncoded: animeData.pageSlug ? encodeURIComponent(animeData.pageSlug) : null, episodes: animeData.episodes?.map(ep => ({ ...ep, url: encodeURIComponent(ep.url) })) || [] };

    res.render('anime', {
      data: encodedMainData, recommendations: encodedRecommendations, page: 'anime',
      pageTitle: `${animeData.title || pageSlug} Subtitle Indonesia - ${siteName}`,
      pageDescription: description, pageImage: imageUrl, pageUrl: SITE_URL + req.originalUrl, siteName: siteName
    });
  } catch (error) { console.error(`Anime Detail Error (${req.params.slug}):`, error); res.status(500).send('Terjadi kesalahan: ' + error.message); }
});

// Watch Episode (Uses Caching Function)
app.get('/nonton/:episodeSlug', async (req, res) => {
  try {
    const episodeSlug = decodeURIComponent(req.params.episodeSlug);
    // getAndCacheEpisodeDataCv handles DB check first, then scrapes if needed
    const [cacheResult, parentAnime, recommendations] = await Promise.all([
      getAndCacheEpisodeDataCv(episodeSlug),
      Anime.findOne({ "episodes.url": episodeSlug }).lean(),
      Anime.aggregate([{ $sample: { size: 9 } }])
    ]);
    let episodeData = cacheResult.data;

    // Handle case where DB lookup AND scraping failed
    if (!episodeData || cacheResult.status === 'failed') {
      console.error(`Failed to get or scrape episode data for slug: ${episodeSlug}`);
      return res.status(404).render('404', {
        page: '404', pageTitle: `404 - ${siteName}`, pageDescription: 'Episode tidak ditemukan.',
        pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL + req.originalUrl, query: '', siteName: siteName
      });
    }

    // Base64 Encode URLs for template
    if (episodeData.streaming) episodeData.streaming = episodeData.streaming.map(s => ({ ...s, url: s.url ? Buffer.from(s.url).toString('base64') : null }));
    if (episodeData.downloads) episodeData.downloads = episodeData.downloads.map(q => ({ ...q, links: q.links.map(l => ({ ...l, url: l.url ? Buffer.from(l.url).toString('base64') : null })) }));

    const encodedRecommendations = encodeAnimeSlugs(recommendations).filter(rec => !parentAnime || rec._id.toString() !== parentAnime._id.toString());
    const nav = { prev: null, next: null, all: null };
    if (parentAnime) {
      nav.all = `/anime/${parentAnime.pageSlug ? encodeURIComponent(parentAnime.pageSlug) : ''}`;
      const episodes = parentAnime.episodes || [];
      const currentIndex = episodes.findIndex(ep => ep.url === episodeSlug);
      if (currentIndex > -1) {
        if (currentIndex < episodes.length - 1) nav.prev = { ...episodes[currentIndex + 1], url: encodeURIComponent(episodes[currentIndex + 1].url) };
        if (currentIndex > 0) nav.next = { ...episodes[currentIndex - 1], url: encodeURIComponent(episodes[currentIndex - 1].url) };
      }
    }
    const description = `Nonton Hentai ${episodeData.title || episodeSlug}...`;
    let seoImage = `${SITE_URL}/images/default.jpg`;
    if (parentAnime && parentAnime.imageUrl) { seoImage = parentAnime.imageUrl.startsWith('http') ? parentAnime.imageUrl : SITE_URL + parentAnime.imageUrl; }

    res.render('nonton', {
      data: episodeData, nav: nav, recommendations: encodedRecommendations, page: 'nonton',
      pageTitle: `${episodeData.title || episodeSlug} Subtitle Indonesia - ${siteName}`,
      pageDescription: description, pageImage: seoImage, pageUrl: SITE_URL + req.originalUrl, siteName: siteName
    });
  } catch (error) { console.error(`Watch Episode Error (${req.params.episodeSlug}):`, error); res.status(500).send('Gagal memuat video: ' + error.message); }
});

// Bookmarks Page
app.get('/bookmarks', (req, res) => {
  try {
    res.render('bookmarks', {
      animes: [], page: 'bookmarks', pageTitle: `Bookmark Saya - ${siteName}`, pageDescription: 'Lihat daftar anime...',
      pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL + req.originalUrl, query: '', siteName: siteName
    });
  } catch (error) { console.error("Bookmarks Page Error:", error); res.status(500).send('Terjadi kesalahan.'); }
});

// ===================================
// --- API ROUTES ---
// ===================================

async function handleLoadMoreApi(req, res, queryBase) {
  try {
    const page = parseInt(req.query.page) || 1;
    const skipVal = (page - 1) * ITEMS_PER_PAGE;
    const animes = await queryBase.sort({ _id: -1 }).skip(skipVal).limit(ITEMS_PER_PAGE).select('title pageSlug imageUrl').lean();
    res.json(encodeAnimeSlugs(animes));
  } catch (error) { console.error("Load More API Error:", error); res.status(500).json({ error: 'Gagal mengambil data' }); }
}

app.get('/api/anime', async (req, res) => handleLoadMoreApi(req, res, Anime.find()));
app.get('/api/search', async (req, res) => { const q = req.query.q; if (!q) return res.json([]); handleLoadMoreApi(req, res, Anime.find({ title: new RegExp(q, 'i') })); });
app.get('/api/genre/:genreName', async (req, res) => handleLoadMoreApi(req, res, Anime.find({ genres: req.params.genreName })));
app.get('/api/status/:statusName', async (req, res) => handleLoadMoreApi(req, res, Anime.find({ "info.Status": new RegExp(`^${req.params.statusName}$`, 'i') })));
app.get('/api/type/:typeName', async (req, res) => handleLoadMoreApi(req, res, Anime.find({ "info.Type": new RegExp(`^${req.params.typeName}$`, 'i') })));
app.get('/api/studio/:studioName', async (req, res) => handleLoadMoreApi(req, res, Anime.find({ "info.Studio": new RegExp(`^${req.params.studioName}$`, 'i') })));


app.delete('/api/bookmarks/all', async (req, res) => {
  try {
    const { userId } = req.query; // Ambil userId dari query parameter
    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId diperlukan' });
    }

    // Hapus semua dokumen bookmark yang cocok dengan userId
    const deleteResult = await Bookmark.deleteMany({ userId: userId });
    console.log(`Cleared ${deleteResult.deletedCount} bookmarks for userId: ${userId}`);

    res.status(200).json({ success: true, deletedCount: deleteResult.deletedCount });
  } catch (error) {
    console.error("API DELETE /api/bookmarks/all Error:", error);
    res.status(500).json({ success: false, error: 'Gagal menghapus semua bookmark' });
  }
});
app.get('/api/bookmark-status', async (req, res) => { try { const { userId, animeId } = req.query; if (!userId || !mongoose.Types.ObjectId.isValid(animeId)) return res.status(400).json({ isBookmarked: false, error: '...' }); const bookmark = await Bookmark.findOne({ userId: userId, animeRef: animeId }); res.json({ isBookmarked: !!bookmark }); } catch (error) { console.error("API /api/bookmark-status Error:", error); res.status(500).json({ isBookmarked: false, error: '...' }); } });
app.post('/api/bookmarks', async (req, res) => { try { const { userId, animeId } = req.body; if (!userId || !mongoose.Types.ObjectId.isValid(animeId)) return res.status(400).json({ success: false, error: '...' }); await Bookmark.findOneAndUpdate({ userId: userId, animeRef: animeId }, { $setOnInsert: { userId: userId, animeRef: animeId } }, { upsert: true }); res.status(200).json({ success: true, isBookmarked: true }); } catch (error) { console.error("API POST /api/bookmarks Error:", error); res.status(500).json({ success: false, error: '...' }); } });
app.delete('/api/bookmarks', async (req, res) => { try { const { userId, animeId } = req.query; if (!userId || !mongoose.Types.ObjectId.isValid(animeId)) return res.status(400).json({ success: false, error: '...' }); await Bookmark.deleteOne({ userId: userId, animeRef: animeId }); res.status(200).json({ success: true, isBookmarked: false }); } catch (error) { console.error("API DELETE /api/bookmarks Error:", error); res.status(500).json({ success: false, error: '...' }); } });
app.get('/api/my-bookmarks', async (req, res) => { try { const userId = req.query.userId; if (!userId) return res.json([]); const bookmarks = await Bookmark.find({ userId: userId }).populate({ path: 'animeRef', model: 'Anime', select: 'title pageSlug imageUrl' }).sort({ createdAt: -1 }).lean(); const animes = bookmarks.map(b => b.animeRef).filter(Boolean); res.json(encodeAnimeSlugs(animes)); } catch (error) { console.error("API /api/my-bookmarks Error:", error); res.status(500).json({ error: '...' }); } });

// ===================================
// --- UTILITY ROUTES (ADMIN & SEO) ---
// ===================================

app.get('/batch-scrape', isAdmin, async (req, res) => { const { slugs } = req.query; if (!slugs) return res.status(400).json({ error: '...' }); const slugsToScrape = slugs.split(/[\s,]+/).filter(Boolean); const results = { total: slugsToScrape.length, berhasil: [], gagal: [], dilewati: [] }; console.log(`BATCH SCRAPE: Starting process for ${slugsToScrape.length} slug(s)...`); for (const slug of slugsToScrape) { const decodedSlug = decodeURIComponent(slug); try { const existing = await Anime.findOne({ pageSlug: decodedSlug }); if (existing) { results.dilewati.push(decodedSlug); } else { await scrapeAndSaveCv(decodedSlug); results.berhasil.push(decodedSlug); } } catch (error) { console.error(`BATCH SCRAPE: Failed '${decodedSlug}':`, error.message); results.gagal.push(decodedSlug); } } console.log('BATCH SCRAPE: Finished.'); res.json(results); });
app.get('/robots.txt', (req, res) => { res.type('text/plain'); res.send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /batch-scrape\nDisallow: /search\nSitemap: ${SITE_URL}/sitemap.xml`); });
app.get('/sitemap.xml', async (req, res) => { try { const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'; const xmlFooter = '</urlset>'; let xmlBody = ''; const formatDate = (date) => date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]; const staticPages = ['/', '/anime-list', '/genre-list', '/episode']; staticPages.forEach(page => { xmlBody += `<url><loc>${SITE_URL}${page}</loc><lastmod>${formatDate(new Date())}</lastmod><changefreq>${page === '/' ? 'daily' : 'weekly'}</changefreq><priority>${page === '/' ? '1.0' : '0.7'}</priority></url>`; }); const animes = await Anime.find({}, 'pageSlug updatedAt').lean().exec(); animes.forEach(anime => { if (anime.pageSlug) xmlBody += `<url><loc>${SITE_URL}/anime/${encodeURIComponent(anime.pageSlug)}</loc><lastmod>${formatDate(anime.updatedAt)}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`; }); const genres = await Anime.distinct('genres').exec(); genres.forEach(genre => { if (genre) xmlBody += `<url><loc>${SITE_URL}/genre/${encodeURIComponent(genre)}</loc><changefreq>daily</changefreq><priority>0.7</priority></url>`; }); const episodes = await Episode.find({}, 'episodeSlug updatedAt').lean().exec(); episodes.forEach(episode => { if (episode.episodeSlug) xmlBody += `<url><loc>${SITE_URL}/nonton/${encodeURIComponent(episode.episodeSlug)}</loc><lastmod>${formatDate(episode.updatedAt)}</lastmod><changefreq>monthly</changefreq><priority>0.6</priority></url>`; }); const types = await Anime.distinct('info.Type').exec(); types.forEach(type => { if (type) xmlBody += `<url><loc>${SITE_URL}/type/${encodeURIComponent(type)}</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>`; }); const studios = await Anime.distinct('info.Studio').exec(); studios.forEach(studio => { if (studio) xmlBody += `<url><loc>${SITE_URL}/studio/${encodeURIComponent(studio)}</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>`; }); res.header('Content-Type', 'application/xml'); res.send(xmlHeader + xmlBody + xmlFooter); } catch (error) { console.error('Error generating sitemap:', error.message); res.status(500).send('Gagal membuat sitemap'); } });

// ===================================
// --- 404 HANDLER (MUST BE LAST Route) ---
// ===================================
app.use((req, res, next) => {
  res.status(404).render('404', {
    page: '404', pageTitle: `404 - Halaman Tidak Ditemukan - ${siteName}`,
    pageDescription: 'Maaf, halaman yang Anda cari tidak ada.',
    pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL + req.originalUrl, query: '', siteName: siteName
  });
});

// ===================================
// --- START THE SERVER ---
// ===================================
app.listen(PORT, () => {
  const serverUrl = process.env.SITE_URL || `http://localhost:${PORT}`;
  console.log(`Server is running on ${serverUrl}`);
});
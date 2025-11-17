// ===================================
// --- IMPORTS & INITIALIZATION ---
// ===================================
require('dotenv').config(); // Load .env file FIRST
const siteName = process.env.SITE_NAME || 'RatuHentai'; // Define siteName globally
const express = require('express');
const path = require('path');
const fs = require('fs'); // Diperlukan untuk menyimpan file unggahan
const axios = require('axios'); // <-- PASTIKAN INI ADA
const multer = require('multer'); // Import multer
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');

// Import Models
const Anime = require('./models/Anime');
const Episode = require('./models/Episode');
const Bookmark = require('./models/Bookmark');

// Import Scraper Utilities for ${siteName}.cv
const { scrapeAndSaveCv, getAndCacheEpisodeDataCv } = require('./scraperUtilsCv');

const app = express();

// --- Fungsi Slugify (Sudah ada) ---
function slugify(text) {
  if (typeof text !== 'string' || !text) {
    return ''; // Kembalikan string kosong jika input tidak valid
  }
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')       // Ganti spasi dengan -
    .replace(/[^\w\-]+/g, '')   // Hapus semua karakter non-word
    .replace(/\-\-+/g, '-');      // Ganti -- ganda dengan - tunggal
}

const compactFormatter = new Intl.NumberFormat('en-US', {
  notation: "compact",
  compactDisplay: "short",
  maximumFractionDigits: 1
});

function formatCompactNumber(num) {
  if (num === undefined || num === null) {
    return '0'; // Default jika data tidak ada
  }
  try {
    return compactFormatter.format(num);
  } catch (e) {
    return num.toString(); // Fallback jika ada error
  }
}
// ------------------------------

const storage = multer.memoryStorage();
// Filter untuk memastikan hanya gambar yang di-upload
const fileFilter = (req, file, cb) => {
  if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png' || file.mimetype === 'image/webp') {
    cb(null, true); // Terima file
  } else {
    cb(new Error('Hanya file .jpg, .png, atau .webp yang diizinkan!'), false); // Tolak file
  }
};
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // Batas 5MB
});

// ===================================
// --- GLOBAL CONFIGURATION ---
// ===================================
const PORT = process.env.PORT || 3000;
const ITEMS_PER_PAGE = 12;
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;

// --- PERBAIKAN RENDER: Konfigurasi Persistent Disk ---
const UPLOAD_WEB_PATH_NAME = 'images'; 
const UPLOAD_DISK_PATH = process.env.RENDER_DISK_PATH || path.join(__dirname, 'public', UPLOAD_WEB_PATH_NAME);

// --- BARU: Path untuk Gambar Karakter ---
// Path fisik di disk (cth: /var/data/public/images/characters)
const CHAR_UPLOAD_DISK_PATH = path.join(UPLOAD_DISK_PATH, 'characters');
// Path web (cth: /images/characters)
const CHAR_UPLOAD_WEB_PATH_NAME = path.posix.join('/', UPLOAD_WEB_PATH_NAME, 'characters'); // Paksa '/'
// ----------------------------------------


// Pastikan direktori upload ada saat development lokal
if (!process.env.RENDER_DISK_PATH) {
  if (!fs.existsSync(UPLOAD_DISK_PATH)) {
    console.log(`Membuat direktori upload lokal di: ${UPLOAD_DISK_PATH}`);
    fs.mkdirSync(UPLOAD_DISK_PATH, { recursive: true });
  }
  // --- BARU: Buat juga direktori karakter ---
  if (!fs.existsSync(CHAR_UPLOAD_DISK_PATH)) {
    console.log(`Membuat direktori karakter lokal di: ${CHAR_UPLOAD_DISK_PATH}`);
    fs.mkdirSync(CHAR_UPLOAD_DISK_PATH, { recursive: true });
  }
  // ---------------------------------------
}
// --- AKHIR PERBAIKAN RENDER ---


// ===================================
// --- MIDDLEWARE ---
// ===================================
app.use(express.static(path.join(__dirname, 'public'))); // Sajikan folder /public

// --- PERBAIKAN RENDER: Sajikan file dari Persistent Disk ---
app.use(`/${UPLOAD_WEB_PATH_NAME}`, express.static(UPLOAD_DISK_PATH));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- PERBAIKAN RENDER: Percayai proxy untuk Sesi Admin ---
app.set('trust proxy', 1); 

// --- BARU: Buat slugify tersedia di semua file EJS ---
app.locals.slugify = slugify;
app.locals.formatCompactNumber = formatCompactNumber;
// ----------------------------------------------------

// Session Configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback_secret_please_change',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // Otomatis true di Render
    maxAge: 1000 * 60 * 60 * 24 // 1 day
  },
  // --- TAMBAHKAN 'store' DI BAWAH INI ---
  store: MongoStore.create({
    mongoUrl: process.env.DB_URI, // Ambil URI dari env yang sudah ada
    collectionName: 'sessions' // Nama koleksi untuk menyimpan sesi
  })
  // --- BATAS TAMBAHAN ---
}));

// ===================================
// --- HELPER FUNCTIONS ---
// ===================================
const encodeAnimeSlugs = (animes) => {
  if (!animes || !Array.isArray(animes)) return [];
  return animes.map(anime => {
    if (!anime) return null;
    const encodedSlug = anime.pageSlug ? encodeURIComponent(anime.pageSlug) : null;
    
    let imageUrl = anime.imageUrl || '/images/default.jpg';

    // --- PERBAIKAN RENDER: Sesuaikan path gambar ---
    if (imageUrl.startsWith('http')) {
      // Biarkan jika sudah URL lengkap (http://...)
    } else if (imageUrl.startsWith(`/${UPLOAD_WEB_PATH_NAME}`)) {
      // Tambahkan SITE_URL jika itu adalah hasil upload (/images/...)
      imageUrl = SITE_URL + imageUrl;
    } else {
      // Tambahkan SITE_URL untuk path lama (/images/...)
      imageUrl = SITE_URL + imageUrl;
    }
    
    return { ...anime, pageSlug: encodedSlug, imageUrl: imageUrl };
  }).filter(Boolean);
};

// --- BARU: Fungsi Download Gambar Karakter ---
/**
 * Mengunduh gambar karakter jika URL-nya eksternal.
 * @param {string} imageUrl URL gambar (bisa eksternal 'http' or internal '/images')
 * @param {string} animeSlug Slug anime (untuk nama file unik)
 * @param {string} characterName Nama karakter (untuk nama file unik)
 * @returns {Promise<string>} Path web lokal yang baru atau path asli jika gagal/sudah lokal.
 */
async function downloadCharacterImage(imageUrl, animeSlug, characterName) {
    // Jika imageUrl kosong atau sudah menjadi path lokal, lewati saja
    if (!imageUrl || (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://'))) {
        return imageUrl;
    }

    try {
        // Buat nama file yang aman dan unik
        const safeCharName = slugify(characterName); // Gunakan slugify yang ada
        let extension = path.extname(new URL(imageUrl).pathname);
        if (!['.jpg', '.jpeg', '.png', '.webp'].includes(extension)) {
            extension = '.jpg'; // Default ke .jpg jika ekstensi aneh
        }
        
        const newFilename = `${animeSlug}-${safeCharName}${extension}`;

        // 1. Download gambar
        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer' // Penting untuk file gambar
        });

        // 2. Tentukan path simpan di disk
        const localDiskPath = path.join(CHAR_UPLOAD_DISK_PATH, newFilename);
        
        // 3. Tulis file ke disk
        fs.writeFileSync(localDiskPath, response.data);

        // 4. Buat path web baru untuk disimpan di DB
        const newWebPath = path.posix.join(CHAR_UPLOAD_WEB_PATH_NAME, newFilename); 
        
        console.log(`Character image downloaded: ${imageUrl} -> ${newWebPath}`);
        return newWebPath; // Kembalikan path lokal baru

    } catch (error) {
        console.error(`Gagal download character image ${imageUrl}: ${error.message.substring(0, 100)}...`);
        return imageUrl; // Jika gagal, kembalikan URL asli agar tidak rusak
    }
}
// --- AKHIR FUNGSI BARU ---


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

app.get('/admin', isAdmin, async (req, res) => { // <-- Tambahkan async
  try {
    // --- BARU: Ambil data counts ---
    const [totalAnime, totalEpisodes] = await Promise.all([
      Anime.countDocuments(),
      Episode.countDocuments()
    ]);
    // --- AKHIR BARU ---

    res.render('admin/dashboard', {
      page: 'admin-dashboard', 
      pageTitle: `Admin Dashboard - ${siteName}`,
      pageDescription: 'Admin dashboard', 
      pageImage: '', 
      pageUrl: '', 
      query: '', 
      siteName: siteName,
      // --- BARU: Kirim data ke EJS ---
      totalAnime: totalAnime,
      totalEpisodes: totalEpisodes
    });

  } catch (error) {
    console.error("Error loading admin dashboard stats:", error);
    res.status(500).send('Gagal memuat statistik dashboard.');
  }
});


// 1. Halaman untuk menampilkan UI Backup/Restore
app.get('/admin/backup', isAdmin, (req, res) => {
  try {
    res.render('admin/backup', {
      page: 'admin-backup', 
      pageTitle: `Backup & Restore - ${siteName}`,
      pageDescription: 'Halaman admin untuk backup dan restore database.', 
      pageImage: '', 
      pageUrl: '', 
      query: '', 
      siteName: siteName
    });
  } catch (error) {
    console.error("Error rendering backup page:", error);
    res.status(500).send('Error memuat halaman.');
  }
});


// 2. Rute untuk MENGEKSPOR (DOWNLOAD) data
app.get('/admin/backup/export', isAdmin, async (req, res) => {
  try {
    console.log("Memulai proses ekspor database...");
    
    // Ambil semua data dari semua koleksi
    const [animes, episodes, bookmarks] = await Promise.all([
      Anime.find().lean(),
      Episode.find().lean(),
      Bookmark.find().lean()
    ]);

    const backupData = {
      exportedAt: new Date().toISOString(),
      collections: {
        animes,
        episodes,
        bookmarks
      }
    };

    const jsonString = JSON.stringify(backupData, null, 2);
    const fileName = `backup_${siteName.toLowerCase()}_${new Date().toISOString().split('T')[0]}.json`;

    // Atur header untuk memicu download
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
    
    console.log(`Ekspor berhasil: ${fileName} (Animes: ${animes.length}, Episodes: ${episodes.length})`);
    res.send(jsonString);

  } catch (error) {
    console.error("Gagal melakukan ekspor database:", error);
    res.status(500).send('Gagal mengekspor data: ' + error.message);
  }
});


// 3. Rute untuk MENGIMPOR (RESTORE) data
// Kita gunakan 'upload' (multer) yang sudah Anda konfigurasikan
app.post('/admin/backup/import', isAdmin, upload.single('backupFile'), async (req, res) => {
  try {
    console.log("Memulai proses impor database...");
    
    // --- 1. Validasi File ---
    if (!req.file) {
      return res.status(400).send('Tidak ada file backup yang diupload.');
    }
    if (req.file.mimetype !== 'application/json') {
      return res.status(400).send('File harus berformat .json');
    }

    // --- 2. Baca dan Parse File ---
    const jsonString = req.file.buffer.toString('utf8');
    const backupData = JSON.parse(jsonString);

    // --- 3. Validasi Data ---
    if (!backupData.collections || !backupData.collections.animes || !backupData.collections.episodes) {
      return res.status(400).send('Format file backup tidak valid. Data "collections" (animes, episodes) tidak ditemukan.');
    }

    const { animes, episodes, bookmarks } = backupData.collections;

    // --- 4. HAPUS SEMUA DATA LAMA (BAGIAN BERBAHAYA) ---
    console.log("PERINGATAN: Menghapus semua data lama...");
    await Promise.all([
      Anime.deleteMany({}),
      Episode.deleteMany({}),
      Bookmark.deleteMany({})
    ]);
    console.log("Data lama berhasil dihapus.");

    // --- 5. MASUKKAN DATA BARU ---
    console.log(`Memasukkan data baru... (Animes: ${animes.length}, Episodes: ${episodes.length})`);
    await Promise.all([
      Anime.insertMany(animes),
      Episode.insertMany(episodes),
      (bookmarks && bookmarks.length > 0) ? Bookmark.insertMany(bookmarks) : Promise.resolve() // Impor bookmark jika ada
    ]);

    console.log("PROSES IMPOR DATABASE BERHASIL.");
    
    // Kirim respons HTML sederhana dengan link kembali ke dashboard
    res.send(`
      <style>body { background-color: #222; color: #eee; font-family: sans-serif; padding: 20px; }</style>
      <h2>Impor Berhasil!</h2>
      <p>Database Anda telah berhasil dipulihkan.</p>
      <p>
        - ${animes.length} data Anime diimpor.<br>
        - ${episodes.length} data Episode diimpor.<br>
        - ${bookmarks ? bookmarks.length : 0} data Bookmark diimpor.
      </p>
      <a href="/admin" style="color: #87CEEB;">« Kembali ke Dasbor</a>
    `);

  } catch (error) {
    console.error("Gagal melakukan impor database:", error);
    res.status(500).send('Gagal mengimpor data: ' + error.message);
  }
});

// --- Admin Anime List (Protected & with Search) ---
app.get('/admin/anime', isAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 30;
    const skipVal = (page - 1) * limit;

    const searchQuery = req.query.search || ''; 
    const query = {}; 

    if (searchQuery) {
      const regex = new RegExp(searchQuery, 'i'); 
      query.$or = [
        { title: regex },
        { pageSlug: regex }
      ];
    }

    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ updatedAt: -1 }).skip(skipVal).limit(limit).lean(),
      Anime.countDocuments(query) 
    ]);
    const totalPages = Math.ceil(totalCount / limit);

    const baseUrl = searchQuery
      ? `/admin/anime?search=${encodeURIComponent(searchQuery)}`
      : '/admin/anime';

    res.render('admin/anime-list', {
      animes: animes,
      page: 'admin-anime-list',
      pageTitle: `Admin - Anime List (Hal ${page})`,
      currentPage: page,
      totalPages: totalPages,
      baseUrl: baseUrl, 
      searchQuery: searchQuery, 
      pageDescription: '', pageImage: '', pageUrl: '', query: '', siteName: siteName
    });
  } catch (error) {
    console.error("Admin Anime List Error:", error);
    res.status(500).send('Error loading admin anime list.');
  }
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

// --- PERBAIKAN: Rute Edit Anime POST (Handle Object/Array) ---
app.post('/admin/anime/:slug/edit', isAdmin, async (req, res) => {
  try {
    const pageSlug = decodeURIComponent(req.params.slug);
    const updateData = req.body;
    console.log("--- Memulai Log Proses Karakter (Edit Anime) ---");

    // --- LOGIKA BARU YANG DIPERBAIKI: Proses Karakter ---
    let charactersToProcess = [];
    if (updateData.characters) {
      if (Array.isArray(updateData.characters)) {
        console.log("Data karakter terdeteksi sebagai ARRAY.");
        charactersToProcess = updateData.characters;
      } else if (typeof updateData.characters === 'object' && updateData.characters !== null) {
        console.log("Data karakter terdeteksi sebagai OBJECT. Mengonversi ke array...");
        charactersToProcess = Object.values(updateData.characters);
        // Filter entri __INDEX__ (yang 'name'-nya kosong)
        charactersToProcess = charactersToProcess.filter(char => char.name); 
        console.log(`Berhasil dikonversi. Ditemukan ${charactersToProcess.length} entri karakter valid.`);
      }
    }
    
    let processedCharacters = [];
    if (charactersToProcess.length > 0) {
      console.log(`Memulai proses untuk ${charactersToProcess.length} karakter.`);
      processedCharacters = await Promise.all(
        charactersToProcess.map(async (char, index) => {
          console.log(`Memproses Karakter #${index}: ${char.name || 'N/A'}`);
          if (!char.name) return null;
          
          const newImageUrl = await downloadCharacterImage(
            char.imageUrl,
            pageSlug, // Gunakan slug anime yang ada
            char.name
          );
          
          return {
            name: char.name.trim(),
            role: (char.role || '').trim(),
            imageUrl: newImageUrl
          };
        })
      );
      processedCharacters = processedCharacters.filter(char => char != null);
    } else {
      console.log("Tidak ada data karakter valid untuk diproses.");
    }
    // --- AKHIR LOGIKA BARU ---
    console.log("Data karakter final yang akan disimpan:", JSON.stringify(processedCharacters, null, 2));


    const dataToUpdate = {
      title: updateData.title, 
      alternativeTitle: updateData.alternativeTitle,
      synopsis: updateData.synopsis, 
      imageUrl: updateData.imageUrl,
      "info.Status": updateData['info.Status'], 
      "info.Released": updateData['info.Released'],
      "info.Type": updateData['info.Type'], 
      "info.Studio": updateData['info.Studio'], 
      "info.Producers": updateData['info.Producers'], 
      genres: updateData.genres ? updateData.genres.split(',').map(g => g.trim()).filter(Boolean) : [],
      characters: processedCharacters // <-- MODIFIKASI: Gunakan data yang diproses
    };
    
    Object.keys(dataToUpdate).forEach(key => (dataToUpdate[key] === undefined || dataToUpdate[key] === '') && delete dataToUpdate[key]);

    // --- BARU: Pengecualian agar array 'characters' bisa di-update (termasuk jadi kosong) ---
    if (updateData.characters) {
         dataToUpdate.characters = processedCharacters;
    } else {
         delete dataToUpdate.characters; // Jangan update jika field tidak dikirim
    }
    
    console.log("--- Selesai Log Proses Karakter (Edit Anime) ---");

    const updatedAnime = await Anime.findOneAndUpdate(
        { pageSlug: pageSlug }, 
        { $set: dataToUpdate }, // $set akan menimpa seluruh array 'characters'
        { new: true, runValidators: true }
    );

    if (!updatedAnime) return res.status(404).send('Anime not found for update.');
    console.log(`Successfully updated anime: ${pageSlug}`);
    res.redirect('/admin/anime');

  } catch (error) { 
      console.error(`Admin Update Anime POST Error (${req.params.slug}):`, error); 
      res.status(500).send('Error updating anime.'); 
  }
});
// --- AKHIR PERBAIKAN ---


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
    const dataToUpdate = { 
        title: formData.title, 
        thumbnailUrl: formData.thumbnailUrl,
        episodeDate: formData.episodeDate // <-- TAMBAHKAN INI
    };
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

app.post('/admin/episode/:slug/delete', isAdmin, async (req, res) => {
  try {
    const episodeSlug = decodeURIComponent(req.params.slug);
    console.log(`Mencoba menghapus episode: ${episodeSlug}`);

    // Langkah 1: Hapus dari koleksi 'Episode' (cache)
    const deleteEpisodeResult = await Episode.deleteOne({ episodeSlug: episodeSlug });

    if (deleteEpisodeResult.deletedCount > 0) {
      console.log(`  > Sukses menghapus dari koleksi Episode: ${episodeSlug}`);
    } else {
      console.warn(`  > Peringatan: Slug ${episodeSlug} tidak ditemukan di koleksi Episode.`);
    }

    // Langkah 2: Hapus dari array 'episodes' di dalam 'Anime'
    const updateAnimeResult = await Anime.updateOne(
      { "episodes.url": episodeSlug },
      { $pull: { episodes: { url: episodeSlug } } }
    );

    if (updateAnimeResult.modifiedCount > 0) {
      console.log(`  > Sukses menghapus referensi dari koleksi Anime.`);
    } else {
      console.warn(`  > Peringatan: Slug ${episodeSlug} tidak ditemukan di array 'episodes' Anime manapun.`);
    }

    // Arahkan kembali ke daftar episode, atau ke halaman edit anime
    // Kita redirect ke /admin/episodes karena form ini juga ada di episode-list
    // Jika Anda ingin kembali ke halaman edit anime, Anda perlu mengirimkan slug anime-nya.
    // Untuk saat ini, kembali ke daftar episode adalah yang paling aman.
    
    // Cek referer untuk kembali ke halaman sebelumnya (lebih pintar)
    const referer = req.get('Referer');
    if (referer && (referer.includes('/admin/anime/') || referer.includes('/admin/episodes'))) {
      res.redirect(referer);
    } else {
      res.redirect('/admin/episodes'); // Fallback
    }

  } catch (error) {
    console.error(`Admin Delete Episode POST Error (${req.params.slug}):`, error);
    res.status(500).send(`Error menghapus episode: ${error.message}`);
  }
});

app.get('/admin/anime/add', isAdmin, (req, res) => {
  res.render('admin/add-anime', {
    page: 'admin-add-anime', pageTitle: `Tambah Anime Baru - ${siteName}`,
    pageDescription: '', pageImage: '', pageUrl: '', query: '', siteName: siteName
  });
});

// --- PERBAIKAN: Rute Add Anime POST (Handle Object/Array) ---
app.post('/admin/anime/add', isAdmin, upload.single('animeImage'), async (req, res) => {
  try {
    const formData = req.body; 
    const file = req.file; 

    // ... (Validasi slug, dll. tetap di sini) ...
    if (!formData.title || !formData.pageSlug) {
      return res.status(400).send('Judul dan Slug wajib diisi.');
    }
    const existingAnime = await Anime.findOne({ pageSlug: formData.pageSlug });
    if (existingAnime) {
      return res.status(400).send(`Slug "${formData.pageSlug}" sudah digunakan.`);
    }

    let imageUrl = formData.imageUrl || '/images/default.jpg'; // Fallback

    // ... (Logika simpan file poster Anda tetap di sini) ...
    if (file) {
      console.log(`Menerima upload file: ${file.originalname}`);
      const extension = path.extname(file.originalname); 
      const newFilename = `${formData.pageSlug}${extension}`;
      const localDiskPath = path.join(UPLOAD_DISK_PATH, newFilename);
      const webPath = path.posix.join('/', UPLOAD_WEB_PATH_NAME, newFilename);
      if (!fs.existsSync(UPLOAD_DISK_PATH)) {
        fs.mkdirSync(UPLOAD_DISK_PATH, { recursive: true });
      }
      fs.writeFileSync(localDiskPath, file.buffer);
      imageUrl = webPath;
      console.log(`File disimpan ke: ${localDiskPath}`);
    }
    
    // --- LOGIKA BARU YANG DIPERBAIKI: Proses Karakter ---
    console.log("--- Memulai Log Proses Karakter (Add Anime) ---");
    console.log("Data mentah 'formData.characters' yang diterima:", JSON.stringify(formData.characters, null, 2));

    let charactersToProcess = []; // Variabel baru untuk menampung array

    // --- MULAI PERBAIKAN ---
    if (formData.characters) {
      if (Array.isArray(formData.characters)) {
        // KASUS 1: Data sudah benar (Array)
        console.log("Data karakter terdeteksi sebagai ARRAY.");
        charactersToProcess = formData.characters;
      } else if (typeof formData.characters === 'object' && formData.characters !== null) {
        // KASUS 2: Data adalah OBJEK (seperti di log Anda)
        console.log("Data karakter terdeteksi sebagai OBJECT. Mengonversi ke array...");
        
        // Ubah nilai objek { "0": {...}, "1": {...} } menjadi array [ {...}, {...} ]
        charactersToProcess = Object.values(formData.characters);

        // Filter entri __INDEX__ yang tidak valid (yang field 'name'-nya kosong)
        charactersToProcess = charactersToProcess.filter(char => char.name);
        console.log(`Berhasil dikonversi. Ditemukan ${charactersToProcess.length} entri karakter valid.`);
      }
    }
    // --- AKHIR PERBAIKAN ---

    let processedCharacters = [];
    if (charactersToProcess.length > 0) { // Gunakan variabel baru
      
      console.log(`Memulai proses untuk ${charactersToProcess.length} karakter.`);

      processedCharacters = await Promise.all(
        charactersToProcess.map(async (char, index) => { // Gunakan variabel baru
          
          console.log(`Memproses Karakter #${index}: ${char.name || 'N/A'}`);
          if (!char.name) return null; // Filter tambahan
          
          const newImageUrl = await downloadCharacterImage(
            char.imageUrl,
            formData.pageSlug,
            char.name
          );
          
          return {
            name: char.name.trim(),
            role: (char.role || '').trim(),
            imageUrl: newImageUrl 
          };
        })
      );
      processedCharacters = processedCharacters.filter(char => char != null);
      
    } else {
      console.log("Tidak ada data karakter valid untuk diproses.");
    }
    // --- AKHIR LOGIKA BARU ---

    const newAnimeData = {
      title: formData.title,
      pageSlug: formData.pageSlug,
      alternativeTitle: formData.alternativeTitle || '',
      imageUrl: imageUrl, 
      synopsis: formData.synopsis || '',
      info: {
        Status: formData['info.Status'] || 'Unknown',
        Released: formData['info.Released'] || '',
        Type: formData['info.Type'] || '',
        Studio: formData['info.Studio'] || '',
        Producers: formData['info.Producers'] || '',
      },
      genres: formData.genres ? formData.genres.split(',').map(g => g.trim()).filter(Boolean) : [],
      episodes: [],
      characters: processedCharacters // Gunakan data yang diproses
    };

    console.log("Data karakter final yang akan disimpan di 'newAnimeData.characters':", JSON.stringify(newAnimeData.characters, null, 2));
    console.log("--- Selesai Log Proses Karakter ---");

    const createdAnime = await Anime.create(newAnimeData);
    console.log(`Anime baru berhasil ditambahkan: ${createdAnime.pageSlug}`);

    try {
      const { notifyGoogleIndexing } = require('./scraperUtilsCv');
      await notifyGoogleIndexing(createdAnime.pageSlug, 'URL_UPDATED');
    } catch (e) { console.warn("Gagal notifikasi Google Indexing saat tambah manual"); }

    res.redirect('/admin/anime');

  } catch (error) {
    console.error("Admin Add Anime POST Error:", error);
    if (error instanceof multer.MulterError) {
      return res.status(400).send(`Error Multer: ${error.message}`);
    } else if (error.message.includes('Hanya file')) { 
      return res.status(400).send(error.message);
    }
    res.status(500).send('Gagal menambahkan anime baru.');
  }
});
// --- AKHIR PERBAIKAN ---


// --- PERBAIKAN: Rute Add Episode (Menyimpan dengan urutan benar) ---
app.post('/admin/anime/:slug/episodes/add', isAdmin, async (req, res) => {
  const parentPageSlug = decodeURIComponent(req.params.slug);
  try {
    const { episodeTitle, episodeSlug, episodeDate } = req.body;
    if (!episodeTitle || !episodeSlug) return res.status(400).send('Judul dan Slug Episode wajib diisi.');
    
    const existingEpisode = await Episode.findOne({ episodeSlug: episodeSlug });
    if (existingEpisode) return res.status(400).send(`Slug Episode "${episodeSlug}" sudah digunakan.`);
    
    const parentAnime = await Anime.findOne({ pageSlug: parentPageSlug });
    if (!parentAnime) return res.status(404).send('Anime induk tidak ditemukan.');
    
    const newEpisodeForAnime = { 
      title: episodeTitle, 
      url: episodeSlug, 
      date: episodeDate || new Date().toLocaleDateString('id-ID') 
    };
    
    await Anime.updateOne(
      { pageSlug: parentPageSlug },
      {
        // --- PERBAIKAN: Hapus $position dan $each ---
        // $push tanpa $position akan otomatis menambah ke AKHIR array.
        $push: {
          episodes: newEpisodeForAnime
        }
        // --- AKHIR PERBAIKAN ---
      }
    );

    // Saya ubah lognya agar lebih jelas
    console.log(`Episode "${episodeSlug}" ditambahkan ke AKHIR array Anime "${parentPageSlug}"`);
    
    const newEpisodeDataForCache = {
      episodeSlug: episodeSlug, 
      title: episodeTitle, 
      streaming: [], 
      downloads: [], 
      thumbnailUrl: '/images/default_thumb.jpg',
      animeTitle: parentAnime.title, 
      animeSlug: parentAnime.pageSlug, 
      animeImageUrl: parentAnime.imageUrl,
      episodeDate: episodeDate || new Date().toLocaleDateString('id-ID') // <-- TAMBAHKAN INI
    };
    
    await Episode.create(newEpisodeDataForCache);
    console.log(`Dokumen cache dibuat untuk Episode "${episodeSlug}"`);
    
    res.redirect(`/admin/anime/${encodeURIComponent(parentPageSlug)}/edit`);

  } catch (error) { 
    console.error(`Admin Add Episode POST Error for ${parentPageSlug}:`, error); 
    res.status(500).send('Gagal menambahkan episode baru.'); 
  }
});

// --- BARU: Rute GET untuk halaman "Tambah Episode" mandiri ---
app.get('/admin/episode/add', isAdmin, async (req, res) => {
  try {
    // Kita perlu mengambil semua anime untuk mengisi dropdown
    const allAnimes = await Anime.find().sort({ title: 1 }).select('title pageSlug').lean();
    
    res.render('admin/add-episode', {
      page: 'admin-add-episode', // Untuk highlight sidebar
      pageTitle: `Tambah Episode Manual - ${siteName}`,
      siteName: siteName,
      animes: allAnimes, // Kirim daftar anime ke EJS
      pageDescription: 'Halaman admin untuk menambah episode baru.', 
      pageImage: '', 
      pageUrl: '', 
      query: ''
    });
  } catch (error) {
    console.error("Error loading 'Add Episode' page:", error);
    res.status(500).send('Gagal memuat halaman.');
  }
});

// ===================================
// --- WEBSITE PAGE ROUTES ---
// ===================================

// --- RUTE "SURPRISE ME" / RANDOM ---
app.get('/random', async (req, res) => {
  try {
    const randomAnime = await Anime.aggregate([
      { $sample: { size: 1 } }
    ]);

    if (randomAnime && randomAnime.length > 0 && randomAnime[0].pageSlug) {
      const slug = randomAnime[0].pageSlug;
      const encodedSlug = encodeURIComponent(slug);
      console.log(`Redirecting to random anime: /anime/${encodedSlug}`);
      res.redirect(`/anime/${encodedSlug}`);
    } else {
      console.warn("Random anime not found, redirecting to home.");
      res.redirect('/');
    }
  } catch (error) {
    console.error("Random Page Error:", error);
    res.redirect('/'); 
  }
});

app.get('/', (req, res) => {
  try {
    res.render('landing', {
      page: 'landing',
      pageTitle: `${siteName} - Nonton Anime Subtitle Indonesia`,
      siteName: siteName,
      SITE_URL: SITE_URL,
      // Tidak perlu data SEO lengkap di sini
      pageDescription: 'Situs terbaik untuk nonton anime hentai subtitle Indonesia gratis.',
      pageImage: `${SITE_URL}/images/default.jpg`,
      pageUrl: SITE_URL,
      query: '',
    });
  } catch (error) {
    res.status(500).send('Error memuat halaman.');
  }
});

// Homepage (Fetches directly from DB)
app.get('/home', async (req, res) => {
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
      sliderAnimes: encodeAnimeSlugs(sliderAnimes), 
      ongoingAnimes: encodeAnimeSlugs(ongoingAnimes), 
      completedAnimes: encodeAnimeSlugs(completedAnimes),
      page: 'home', 
      pageTitle: `${siteName} – Nonton AV Hentai Subtitle Indonesia`, 
      pageDescription: `${siteName} tempat download dan streaming anime hentai sub indo maupun subtitle Indonesia dengan kualitas terbaik dan selalu cepat updated hanya di ${siteName}. Nikmati sensasi menonton anime hentai, ecchi, uncensored, sub indo kualitas video HD 1080p 720p 480p.`,
      pageImage: `${SITE_URL}/images/default.jpg`, 
      pageUrl: SITE_URL + req.originalUrl, 
      siteName: siteName
    });
  } catch (error) { 
    console.error("Homepage Error:", error); 
    res.status(500).send('Terjadi kesalahan: ' + error.message); 
  }
});

//RUTE JADWAL RILIS
app.get('/jadwal', (req, res) => {
  res.render('jadwal', {
    page: 'jadwal', // Ini penting untuk skrip di footer
    pageTitle: `Jadwal Rilis - ${siteName}`,
    pageDescription: `Jadwal rilis anime Hentai terbaru dan yang akan datang.`,
    pageImage: `${SITE_URL}/images/default.jpg`,
    pageUrl: SITE_URL + req.originalUrl,
    siteName: siteName,
    // Kita tidak perlu mengirim data anime dari sini
  });
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

// --- PERUBAHAN: Genre Filter (menggunakan Slug) ---
app.get('/genre/:genreSlug', async (req, res) => {
  try {
    const genreSlug = req.params.genreSlug;
    const page = parseInt(req.query.page) || 1;

    // Langkah 1: Dapatkan semua genre unik dari DB
    const allGenres = await Anime.distinct('genres');
    
    // Langkah 2: Temukan nama genre asli yang cocok dengan slug
    const originalGenre = allGenres.find(g => slugify(g) === genreSlug);

    // Langkah 3: Jika tidak ada genre yang cocok, 404
    if (!originalGenre) {
      console.warn(`Genre slug not found: ${genreSlug}`);
      return res.status(404).send('Genre tidak ditemukan.');
    }

    // Langkah 4: Gunakan nama asli untuk query
    const query = { genres: originalGenre };
    const skipVal = (page - 1) * ITEMS_PER_PAGE;
    
    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ _id: -1 }).skip(skipVal).limit(ITEMS_PER_PAGE).lean(),
      Anime.countDocuments(query)
    ]);
    const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
    
    res.render('list', {
      animes: encodeAnimeSlugs(animes),
      pageTitle: `Genre: ${originalGenre} - Halaman ${page} - ${siteName}`, // Gunakan nama asli
      query: '', page: 'list',
      pageDescription: `Daftar hentai dengan genre ${originalGenre}.`, // Gunakan nama asli
      pageImage: `${SITE_URL}/images/default.jpg`,
      pageUrl: SITE_URL + req.originalUrl,
      currentPage: page,
      totalPages: totalPages,
      baseUrl: `/genre/${genreSlug}`, // URL dasar menggunakan slug
      siteName: siteName
    });
  } catch (error) { console.error("Genre Filter Error:", error); res.status(500).send('Terjadi kesalahan: ' + error.message); }
});

// --- PERUBAHAN: Status Filter (menggunakan Slug) ---
app.get('/status/:statusSlug', async (req, res) => {
  try {
    const statusSlug = req.params.statusSlug;
    const page = parseInt(req.query.page) || 1;

    const allStatuses = await Anime.distinct('info.Status');
    const originalStatus = allStatuses.find(s => slugify(s) === statusSlug);

    if (!originalStatus) {
      console.warn(`Status slug not found: ${statusSlug}`);
      return res.status(404).send('Status tidak ditemukan.');
    }

    const query = { "info.Status": new RegExp(`^${originalStatus}$`, 'i') };
    const skipVal = (page - 1) * ITEMS_PER_PAGE;
    
    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ _id: -1 }).skip(skipVal).limit(ITEMS_PER_PAGE).lean(),
      Anime.countDocuments(query)
    ]);
    const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
    
    res.render('list', {
      animes: encodeAnimeSlugs(animes),
      pageTitle: `Status: ${originalStatus} - Halaman ${page} - ${siteName}`,
      query: '', page: 'list',
      pageDescription: `Daftar hentai dengan status ${originalStatus}.`,
      pageImage: `${SITE_URL}/images/default.jpg`,
      pageUrl: SITE_URL + req.originalUrl,
      currentPage: page,
      totalPages: totalPages,
      baseUrl: `/status/${statusSlug}`,
      siteName: siteName
    });
  } catch (error) { console.error(`Status Filter Error (${req.params.statusSlug}):`, error); res.status(500).send('Terjadi kesalahan: ' + error.message); }
});

// --- PERUBAHAN: Type Filter (menggunakan Slug) ---
app.get('/type/:typeSlug', async (req, res) => {
  try {
    const typeSlug = req.params.typeSlug;
    const page = parseInt(req.query.page) || 1;

    const allTypes = await Anime.distinct('info.Type');
    const originalType = allTypes.find(t => slugify(t) === typeSlug);

    if (!originalType) {
      console.warn(`Type slug not found: ${typeSlug}`);
      return res.status(404).send('Type tidak ditemukan.');
    }

    const query = { "info.Type": new RegExp(`^${originalType}$`, 'i') };
    const skipVal = (page - 1) * ITEMS_PER_PAGE;
    
    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ _id: -1 }).skip(skipVal).limit(ITEMS_PER_PAGE).lean(),
      Anime.countDocuments(query)
    ]);
    const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
    
    res.render('list', {
      animes: encodeAnimeSlugs(animes),
      pageTitle: `Type: ${originalType} - Halaman ${page} - ${siteName}`,
      query: '', page: 'list',
      pageDescription: `Daftar hentai type ${originalType}.`,
      pageImage: `${SITE_URL}/images/default.jpg`,
      pageUrl: SITE_URL + req.originalUrl,
      currentPage: page,
      totalPages: totalPages,
      baseUrl: `/type/${typeSlug}`,
      siteName: siteName
    });
  } catch (error) { console.error(`Type Filter Error (${req.params.typeSlug}):`, error); res.status(500).send('Terjadi kesalahan: ' + error.message); }
});

// --- PERUBAHAN: Studio Filter (menggunakan Slug) ---
app.get('/studio/:studioSlug', async (req, res) => {
  try {
    const studioSlug = req.params.studioSlug;
    const page = parseInt(req.query.page) || 1;

    const allStudios = await Anime.distinct('info.Studio');
    const originalStudio = allStudios.find(s => slugify(s) === studioSlug);

    if (!originalStudio) {
      console.warn(`Studio slug not found: ${studioSlug}`);
      return res.status(404).send('Studio tidak ditemukan.');
    }

    const query = { "info.Studio": new RegExp(`^${originalStudio}$`, 'i') };
    const skipVal = (page - 1) * ITEMS_PER_PAGE;
    
    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ _id: -1 }).skip(skipVal).limit(ITEMS_PER_PAGE).lean(),
      Anime.countDocuments(query)
    ]);
    const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
    
    res.render('list', {
      animes: encodeAnimeSlugs(animes),
      pageTitle: `Studio: ${originalStudio} - Halaman ${page} - ${siteName}`,
      query: '', page: 'list',
      pageDescription: `Daftar hentai studio ${originalStudio}.`,
      pageImage: `${SITE_URL}/images/default.jpg`,
      pageUrl: SITE_URL + req.originalUrl,
      currentPage: page,
      totalPages: totalPages,
      baseUrl: `/studio/${studioSlug}`,
      siteName: siteName
    });
  } catch (error) { console.error(`Studio Filter Error (${req.params.studioSlug}):`, error); res.status(500).send('Terjadi kesalahan: ' + error.message); }
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
      animes: encodeAnimeSlugs(animes), page: 'anime-list', pageTitle: `Daftar Hentai Subtitle Indonesia - Halaman ${page} - ${siteName}`,
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

// --- BARU: Halaman Daftar Tahun ---
app.get('/tahun-list', async (req, res) => {
  try {
    // Ambil semua nilai 'Released' yang unik
    const allReleasedDates = await Anime.distinct('info.Released');
    
    // Gunakan regex untuk mengekstrak 4 digit tahun (YYYY)
    const yearRegex = /(\d{4})/;
    const years = allReleasedDates
      .map(dateStr => {
        const match = dateStr.match(yearRegex);
        return match ? match[1] : null; // Ambil tahunnya (match[1])
      })
      .filter(Boolean); // Hapus null/undefined

    // Buat daftar unik dan urutkan dari terbaru ke terlama
    const uniqueYears = [...new Set(years)].sort((a, b) => b - a);

    res.render('tahun-list', { // Anda perlu membuat file 'views/tahun-list.ejs'
      years: uniqueYears,
      page: 'tahun-list', 
      pageTitle: `Daftar Tahun Rilis - ${siteName}`,
      pageDescription: 'Jelajahi hentai berdasarkan tahun rilis.',
      pageImage: `${SITE_URL}/images/default.jpg`,
      pageUrl: SITE_URL + req.originalUrl,
      siteName: siteName
    });
  } catch (error) {
    console.error("Tahun List Error:", error);
    res.status(500).send('Terjadi kesalahan: ' + error.message);
  }
});

// --- BARU: Halaman Filter Tahun ---
app.get('/tahun/:year', async (req, res) => {
  try {
    const year = req.params.year;
    // Pastikan 'year' adalah 4 digit angka
    if (!/^\d{4}$/.test(year)) {
      return res.status(404).send('Tahun tidak valid.');
    }
    const page = parseInt(req.query.page) || 1;
    
    // Cari di 'info.Released' yang mengandung tahun tersebut
    const query = { "info.Released": new RegExp(year, 'i') }; 
    
    const skipVal = (page - 1) * ITEMS_PER_PAGE;
    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ _id: -1 }).skip(skipVal).limit(ITEMS_PER_PAGE).lean(),
      Anime.countDocuments(query)
    ]);
    const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
    
    res.render('list', {
      animes: encodeAnimeSlugs(animes),
      pageTitle: `Tahun Rilis: ${year} - Halaman ${page} - ${siteName}`,
      query: '', page: 'list',
      pageDescription: `Daftar hentai yang rilis pada tahun ${year}.`,
      pageImage: `${SITE_URL}/images/default.jpg`,
      pageUrl: SITE_URL + req.originalUrl,
      currentPage: page,
      totalPages: totalPages,
      baseUrl: `/tahun/${year}`, // Perhatikan: tidak perlu encode
      siteName: siteName
    });
  } catch (error) {
    console.error(`Tahun Filter Error (${req.params.year}):`, error);
    res.status(500).send('Terjadi kesalahan: ' + error.message);
  }
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


// --- Anime Detail Route (NO AUTO SCRAPE + VIEW COUNT) ---
app.get('/anime/:slug', async (req, res) => {
  try {
    const pageSlug = decodeURIComponent(req.params.slug);

    const [animeData, recommendations] = await Promise.all([
      Anime.findOne({ pageSlug: pageSlug }).lean(),
      Anime.aggregate([{ $match: { pageSlug: { $ne: pageSlug } } }, { $sample: { size: 9 } }])
    ]);

    if (!animeData) {
      console.log(`Data '${pageSlug}' not found in DB.`);
      return res.status(404).render('404', {
        page: '404', pageTitle: `404 - ${siteName}`, pageDescription: 'Anime tidak ditemukan.',
        pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL + req.originalUrl, query: '', siteName: siteName
      });
    }

    console.log(`Data '${pageSlug}' found in Database. Incrementing view count...`);
    Anime.updateOne({ pageSlug: pageSlug }, { $inc: { viewCount: 1 } })
      .exec() 
      .catch(err => console.error(`Failed to increment view count for ${pageSlug}:`, err)); 

    const encodedRecommendations = encodeAnimeSlugs(recommendations);
    const description = (animeData.synopsis || '').substring(0, 160) + '...';
    
    // Gunakan helper `encodeAnimeSlugs` untuk konsistensi (walaupun hanya 1 item)
    const [ encodedMainData ] = encodeAnimeSlugs([ animeData ]);
    // Tambahkan slug yang di-encode
    encodedMainData.pageSlugEncoded = animeData.pageSlug ? encodeURIComponent(animeData.pageSlug) : null;
    encodedMainData.episodes = animeData.episodes?.map(ep => ({ ...ep, url: encodeURIComponent(ep.url) })) || [];

    res.render('anime', {
      data: encodedMainData, recommendations: encodedRecommendations, page: 'anime',
      pageTitle: `${animeData.title || pageSlug} Subtitle Indonesia - ${siteName}`,
      pageDescription: description, pageImage: encodedMainData.imageUrl, // Gunakan URL yang sudah diproses
      pageUrl: SITE_URL + req.originalUrl, siteName: siteName, SITE_URL: SITE_URL
    });
  } catch (error) {
    console.error(`Anime Detail Error (${req.params.slug}):`, error);
    res.status(500).send('Terjadi kesalahan: ' + error.message);
  }
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

      // Array episodes diurutkan ASC (Ep 1, Ep 2, Ep 3...)
      const episodes = parentAnime.episodes || []; 
      const currentIndex = episodes.findIndex(ep => ep.url === episodeSlug);

      // Pastikan episode ditemukan
      if (currentIndex > -1) {

        // --- PERBAIKAN LOGIKA DI SINI ---
        
        // 'Prev' (Mundur) adalah episode SEBELUMNYA (indeks - 1)
        if (currentIndex > 0) {
          nav.prev = { ...episodes[currentIndex - 1], url: encodeURIComponent(episodes[currentIndex - 1].url) };
        }

        // 'Next' (Maju) adalah episode BERIKUTNYA (indeks + 1)
        if (currentIndex < episodes.length - 1) {
          nav.next = { ...episodes[currentIndex + 1], url: encodeURIComponent(episodes[currentIndex + 1].url) };
        }
        
        // --- AKHIR PERBAIKAN ---
      }
    }
    
    const description = `Nonton ${episodeData.title || episodeSlug} subtitle Indonesia kualitas HD. Streaming cepat, gratis, dan lengkap hanya di ${siteName}.`;
    let seoImage = `${SITE_URL}/images/default.jpg`;
    if (parentAnime && parentAnime.imageUrl) { 
      const [ encodedParent ] = encodeAnimeSlugs([ parentAnime ]);
      seoImage = encodedParent.imageUrl;
    }

    res.render('nonton', {
      data: episodeData, nav: nav, recommendations: encodedRecommendations, page: 'nonton',
      pageTitle: `${episodeData.title || episodeSlug} Subtitle Indonesia - ${siteName}`,
      pageDescription: description, pageImage: seoImage, pageUrl: SITE_URL + req.originalUrl, siteName: siteName, SITE_URL
    });
  } catch (error) { console.error(`Watch Episode Error (${req.params.episodeSlug}):`, error); res.status(500).send('Gagal memuat video: ' + error.message); }
});


app.get('/safelink', (req, res) => {
  const base64Url = req.query.url; 
  if (!base64Url) {
    return res.status(404).render('404', {
      page: '404', pageTitle: `404 - ${siteName}`, pageDescription: 'Halaman tidak ditemukan.',
      pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL + req.originalUrl, query: '', siteName: siteName
    });
  }

  try {
    res.render('safelink', {
      page: 'safelink',
      pageTitle: `Mengarahkan... - ${siteName}`,
      pageDescription: 'Harap tunggu untuk diarahkan ke link Anda.',
      pageImage: `${SITE_URL}/images/default.jpg`,
      pageUrl: SITE_URL + req.originalUrl,
      siteName: siteName,
      query: '',
      base64Url: base64Url 
    });

  } catch (error) {
    console.error("Safelink render error:", error);
    res.status(500).send('Error saat memuat halaman safelink.');
  }
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

//redirect old pagination URLs to new format

function handleOldPagination(req, res, newBasePath) {
  const pageNumber = req.params.pageNumber;
  // Pastikan pageNumber adalah angka
  if (pageNumber && /^\d+$/.test(pageNumber)) {
    const newUrl = `${newBasePath}?page=${pageNumber}`;
    res.redirect(301, newUrl); // 301 Redirect Permanen
  } else {
    // Jika /page/bukan-angka, redirect ke basisnya
    res.redirect(301, newBasePath);
  }
}

// Redirect untuk /anime-list/page/..
app.get('/anime-list/page/:pageNumber(\\d+)/?', (req, res) => {
  handleOldPagination(req, res, '/anime-list');
});

// Redirect untuk /genre/slug/page/..
app.get('/genre/:slug/page/:pageNumber(\\d+)/?', (req, res) => {
  handleOldPagination(req, res, `/genre/${req.params.slug}`);
});

// Redirect untuk /status/slug/page/..
app.get('/status/:slug/page/:pageNumber(\\d+)/?', (req, res) => {
  handleOldPagination(req, res, `/status/${req.params.slug}`);
});

// Redirect untuk /type/slug/page/..
app.get('/type/:slug/page/:pageNumber(\\d+)/?', (req, res) => {
  handleOldPagination(req, res, `/type/${req.params.slug}`);
});

// Redirect untuk /studio/slug/page/..
app.get('/studio/:slug/page/:pageNumber(\\d+)/?', (req, res) => {
  handleOldPagination(req, res, `/studio/${req.params.slug}`);
});

// Redirect untuk /tahun/tahun/page/..
app.get('/tahun/:year/page/:pageNumber(\\d+)/?', (req, res) => {
  handleOldPagination(req, res, `/tahun/${req.params.year}`);
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

app.get('/api/popular', async (req, res) => {
  try {
    const range = req.query.range || 'weekly';
    let dateFilter = {};
    const now = new Date();

    if (range === 'weekly') {
      dateFilter = { updatedAt: { $gte: new Date(now.setDate(now.getDate() - 7)) } };
    } else if (range === 'monthly') {
      dateFilter = { updatedAt: { $gte: new Date(now.setMonth(now.getMonth() - 1)) } };
    }
    
    const popularAnime = await Anime.find(dateFilter)
      .sort({ viewCount: -1 }) 
      .limit(10) 
      .select('title pageSlug imageUrl genres') 
      .lean(); 

    const encodedResults = encodeAnimeSlugs(popularAnime);
    res.json(encodedResults);

  } catch (error) {
    console.error("API /api/popular Error:", error);
    res.status(500).json({ error: 'Gagal mengambil data populer' });
  }
});

// Catatan: Rute API tidak diubah untuk menggunakan slug, agar tidak merusak JS frontend
app.get('/api/anime', async (req, res) => handleLoadMoreApi(req, res, Anime.find()));
app.get('/api/search', async (req, res) => { const q = req.query.q; if (!q) return res.json([]); handleLoadMoreApi(req, res, Anime.find({ title: new RegExp(q, 'i') })); });
app.get('/api/genre/:genreName', async (req, res) => handleLoadMoreApi(req, res, Anime.find({ genres: req.params.genreName })));
app.get('/api/status/:statusName', async (req, res) => handleLoadMoreApi(req, res, Anime.find({ "info.Status": new RegExp(`^${req.params.statusName}$`, 'i') })));
app.get('/api/type/:typeName', async (req, res) => handleLoadMoreApi(req, res, Anime.find({ "info.Type": new RegExp(`^${req.params.typeName}$`, 'i') })));
app.get('/api/studio/:studioName', async (req, res) => handleLoadMoreApi(req, res, Anime.find({ "info.Studio": new RegExp(`^${req.params.studioName}$`, 'i') })));


app.delete('/api/bookmarks/all', async (req, res) => {
  try {
    const { userId } = req.query; 
    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId diperlukan' });
    }

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
app.get('/robots.txt', (req, res) => { res.type('text/plain'); res.send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /batch-scrape\nDisallow: /search\nDisallow: /safelink\nSitemap: ${SITE_URL}/sitemap.xml`); });

// --- PERUBAHAN: Sitemap diperbarui untuk URL SEO Friendly ---
app.get('/sitemap.xml', async (req, res) => { 
  try { 
    const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'; 
    const xmlFooter = '</urlset>'; 
    let xmlBody = ''; 
    const formatDate = (date) => date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]; 
    
    // Tambahkan /tahun-list ke static pages
    const staticPages = ['/', '/home', '/anime-list', '/genre-list', '/episode', '/tahun-list', '/bookmarks', '/jadwal'];
    
    staticPages.forEach(page => { 
      xmlBody += `<url><loc>${SITE_URL}${page}</loc><lastmod>${formatDate(new Date())}</lastmod><changefreq>${page === '/home' ? 'daily' : 'weekly'}</changefreq><priority>${page === '/home' ? '1.0' : '0.7'}</priority></url>`; 
    }); 
    
    const animes = await Anime.find({}, 'pageSlug updatedAt').lean().exec(); 
    animes.forEach(anime => { 
      if (anime.pageSlug) xmlBody += `<url><loc>${SITE_URL}/anime/${encodeURIComponent(anime.pageSlug)}</loc><lastmod>${formatDate(anime.updatedAt)}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`; 
    }); 
    
    // --- PERUBAHAN: Gunakan slugify untuk sitemap ---
    const genres = await Anime.distinct('genres').exec(); 
    genres.forEach(genre => { 
      if (genre) xmlBody += `<url><loc>${SITE_URL}/genre/${slugify(genre)}</loc><changefreq>daily</changefreq><priority>0.7</priority></url>`; 
    }); 
    
    const episodes = await Episode.find({}, 'episodeSlug updatedAt').lean().exec(); 
    episodes.forEach(episode => { 
      if (episode.episodeSlug) xmlBody += `<url><loc>${SITE_URL}/nonton/${encodeURIComponent(episode.episodeSlug)}</loc><lastmod>${formatDate(episode.updatedAt)}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`; 
    }); 
    
    const types = await Anime.distinct('info.Type').exec(); 
    types.forEach(type => { 
      if (type) xmlBody += `<url><loc>${SITE_URL}/type/${slugify(type)}</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>`; 
    }); 
    
    const studios = await Anime.distinct('info.Studio').exec(); 
    studios.forEach(studio => { 
      if (studio) xmlBody += `<url><loc>${SITE_URL}/studio/${slugify(studio)}</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>`; 
    }); 
    
    // --- BARU: Tambahkan Tahun ke Sitemap ---
    const allReleasedDates = await Anime.distinct('info.Released');
    const yearRegex = /(\d{4})/;
    const years = allReleasedDates.map(d => d.match(yearRegex) ? d.match(yearRegex)[1] : null).filter(Boolean);
    const uniqueYears = [...new Set(years)];
    uniqueYears.forEach(year => {
      xmlBody += `<url><loc>${SITE_URL}/tahun/${year}</loc><changefreq>yearly</changefreq><priority>0.6</priority></url>`;
    });
    // --- AKHIR BLOK BARU ---
    
    res.header('Content-Type', 'application/xml'); 
    res.send(xmlHeader + xmlBody + xmlFooter); 
  } catch (error) { 
    console.error('Error generating sitemap:', error.message); 
    res.status(500).send('Gagal membuat sitemap'); 
  } 
});

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
// --- START DATABASE & SERVER ---
// ===================================

// --- PERBAIKAN RENDER: Wajibkan DB_URI dari Environment ---
const DB_URI = process.env.DB_URI;

if (!DB_URI) {
  console.error("FATAL ERROR: DB_URI is not defined in environment variables.");
  process.exit(1); // Wajib ada DB_URI
}

// 1. Hubungkan ke MongoDB di top-level (scope global)
// Mongoose akan mengelola koneksi dan antriannya
console.log('Attempting to connect to MongoDB...');
mongoose.connect(DB_URI, {
    serverSelectionTimeoutMS: 30000 // 30 detik timeout
}).then(() => {
    console.log('Successfully connected to MongoDB...');
}).catch(err => {
    // Tulis error tapi JANGAN hentikan proses build
    console.error('Initial MongoDB connection failed. Server will try to connect on first request.', err);
});

// 2. EKSPOR 'app' agar platform hosting bisa menjalankannya
// JANGAN panggil app.listen() di sini
module.exports = app;
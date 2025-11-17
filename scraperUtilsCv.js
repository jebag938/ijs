const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
// const atob = require('atob'); // <-- DIHAPUS, tidak perlu
const Anime = require('./models/Anime');
const Episode = require('./models/Episode');
const { GoogleAuth } = require('google-auth-library');

const SITE_URL_FOR_INDEXING = process.env.SITE_URL || 'https://nekopoi.cv';
const INDEXING_API_ENDPOINT = 'https://indexing.googleapis.com/v3/urlNotifications:publish';
const INDEXING_SCOPES = ['https://www.googleapis.com/auth/indexing'];
const SCRAPER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
  'Referer': 'https://nekopoi.cv/'
};
const BASE_SCRAPE_URL_ANIME = 'https://nekopoi.cv/anime/';
const BASE_SCRAPE_URL_EPISODE = 'https://nekopoi.cv/';

// ===================================
// --- LOCAL IMAGE DOWNLOAD FUNCTION ---
// ===================================
async function downloadImage(externalUrl, baseFilename, subfolder = '') {
  if (!externalUrl || !externalUrl.startsWith('http')) {
    console.warn(`  [GAMBAR LOKAL] Invalid external URL: ${externalUrl}`);
    return subfolder === 'episodes' ? '/images/default_thumb.jpg' : '/images/default.jpg';
  }
  try {
    const urlObject = new URL(externalUrl);
    let extension = path.extname(urlObject.pathname);
    if (!['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(extension.toLowerCase())) {
        console.warn(`  [GAMBAR LOKAL] Non-standard extension "${extension}" for ${externalUrl}. Defaulting to .jpg`);
        extension = '.jpg';
    }

    const safeFilename = baseFilename.replace(/[^a-zA-Z0-9-_]/g, '-').substring(0, 100);
    const localFilename = `${safeFilename}${extension}`;
    const targetDir = path.join(__dirname, 'public', 'images', subfolder);
    const localDiskPath = path.join(targetDir, localFilename);
    const webPath = `/images/${subfolder ? subfolder + '/' : ''}${localFilename}`;

    if (!fs.existsSync(targetDir)) {
      console.log(`  [GAMBAR LOKAL] Creating directory: ${targetDir}`);
      fs.mkdirSync(targetDir, { recursive: true });
    }

    if (fs.existsSync(localDiskPath)) {
      console.log(`  [GAMBAR LOKAL] File ${localFilename} in '${subfolder || 'images'}' already exists.`);
      return webPath;
    }

    console.log(`  [GAMBAR LOKAL] Downloading ${externalUrl} to ${localDiskPath}...`);
    const response = await axios({ url: externalUrl, method: 'GET', responseType: 'stream', headers: SCRAPER_HEADERS });

    const writer = fs.createWriteStream(localDiskPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        console.log(`  [GAMBAR LOKAL] Successfully saved: ${localFilename} in '${subfolder || 'images'}'`);
        resolve(webPath);
      });
      writer.on('error', (err) => {
        console.error(`  [GAMBAR LOKAL] Failed saving file ${localFilename}:`, err);
        fs.unlink(localDiskPath, () => {});
        reject(err);
      });
    });
  } catch (error) {
    console.error(`  [GAMBAR LOKAL] Failed download process for ${externalUrl}:`, error.message);
    return subfolder === 'episodes' ? '/images/default_thumb.jpg' : '/images/default.jpg';
  }
}

// ===================================
// --- GOOGLE INDEXING FUNCTION ---
// ===================================
async function notifyGoogleIndexing(pageSlug, requestType = 'URL_UPDATED') {
    console.log(`[Google Indexing] Attempting submit for slug: ${pageSlug} (Type: ${requestType})`);
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS) {
        console.warn('[Google Indexing] GOOGLE_SERVICE_ACCOUNT_CREDENTIALS not found. Skipping submit.');
        return;
    }
    try {
        const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
        const auth = new GoogleAuth({ credentials, scopes: INDEXING_SCOPES });
        const authToken = await auth.getAccessToken();
        const urlToSubmit = `${SITE_URL_FOR_INDEXING}/anime/${encodeURIComponent(pageSlug)}`;
        const requestData = { url: urlToSubmit, type: requestType };
        const config = { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` } };
        const response = await axios.post(INDEXING_API_ENDPOINT, requestData, config);
        console.log('[Google Indexing] --- Successfully Submitted ---', JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('[Google Indexing] --- Error Occurred ---');
        if (axios.isAxiosError(error) && error.response) {
             console.error('[Google Indexing] Status:', error.response.status, JSON.stringify(error.response.data, null, 2));
             if (error.response.status === 403) console.error('[Google Indexing] Error 403: Check Service Account permissions.');
             else if (error.response.status === 429) console.warn('[Google Indexing] Error 429: Quota exceeded.');
        } else { console.error('[Google Indexing] Message:', error.message); }
    }
}

// ===================================
// --- ANIME DETAIL SCRAPER (FIXED) ---
// ===================================
async function scrapeAndSaveCv(pageSlug) {
  const decodedSlug = decodeURIComponent(pageSlug);
  const encodedSlugForUrl = encodeURIComponent(decodedSlug);
  const targetUrl = `${BASE_SCRAPE_URL_ANIME}${encodedSlugForUrl}/`;

  try {
    // --- PERUBAHAN 1: Ambil data dari DB dulu ---
    const existingAnime = await Anime.findOne({ pageSlug: decodedSlug }).lean();
    let existingEpisodeCount = 0;
    
    if (existingAnime) {
      existingEpisodeCount = existingAnime.episodes ? existingAnime.episodes.length : 0;
    }
    console.log(`[SCRAPER CV] Status lokal untuk ${decodedSlug}: ${existingEpisodeCount} episode.`);
    // --- AKHIR PERUBAHAN 1 ---

    // --- Langkah 2: Lakukan scrape seperti biasa ---
    console.log(`[SCRAPER CV] Starting scrape for: ${decodedSlug} (URL: ${targetUrl})`);
    const { data } = await axios.get(targetUrl, { headers: SCRAPER_HEADERS });
    const $ = cheerio.load(data);

    if ($('title').text().includes('Just a moment...') || !$('h1.entry-title').length) {
      console.warn(`[SCRAPER CV] Block page or invalid content for ${decodedSlug}. Skipping.`);
      return null;
    }

    const scrapedData = { info: {}, genres: [], episodes: [], characters: [], pageSlug: decodedSlug };

    scrapedData.title = $('h1.entry-title').text().trim();
    const imgElement = $('div.thumb img');
    const externalImageUrl = imgElement.attr('data-src') || imgElement.attr('src');
    scrapedData.imageUrl = await downloadImage(externalImageUrl, decodedSlug); 
    scrapedData.alternativeTitle = $('span.alter').text().trim();

    $('div.spe span').each((i, el) => {
      const element = $(el);
      const keyElement = element.find('b');
      if (keyElement.length > 0) {
        let key = keyElement.text().replace(':', '').trim();
        keyElement.remove();
        let value = element.text().trim();
        const links = element.find('a');
        if (links.length > 0) value = links.map((i, link) => $(link).text().trim()).get().join(', ');
        if (key.toLowerCase() === 'dirilis') key = 'Released';
        if (key.toLowerCase() === 'tipe') key = 'Type';
        if (key && value) scrapedData.info[key] = value;
      }
    });

    $('div.genxed a').each((i, el) => { scrapedData.genres.push($(el).text().trim()); });
    scrapedData.synopsis = $('div.entry-content[itemprop="description"] p').map((i, el) => $(el).text().trim()).get().join('\n');

    // Process Characters in parallel
    const characterElements = $('div.cvlist div.cvitem');
    const characterPromises = characterElements.map(async (i, el) => {
      const charImgElem = $(el).find('.cvcover img');
      const externalCharImgUrl = charImgElem.attr('data-src') || charImgElem.attr('src');
      const charName = $(el).find('.charname').text().trim();
      const charRole = $(el).find('.charrole').text().trim();

      if (charName && externalCharImgUrl) {
        const safeCharName = charName.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
        const charFilenameBase = `${decodedSlug}-char-${safeCharName}`;
        const localCharImgPath = await downloadImage(externalCharImgUrl, charFilenameBase, 'characters');
        return { name: charName, role: charRole, imageUrl: localCharImgPath };
      }
      return null;
    }).get();

    const charactersData = await Promise.all(characterPromises);
    scrapedData.characters = charactersData.filter(char => char !== null);

    // Dapatkan daftar episode dari scrape
    console.log(`[SCRAPER CV] Extracting episodes for ${decodedSlug}...`);
    $('div.eplister ul li').each((i, el) => {
        const li = $(el);
        const anchor = li.find('a');
        const episodeUrl = anchor.attr('href');
        const episodeTitle = anchor.find('.epl-title').text().trim(); 
        const episodeDate = anchor.find('.epl-date').text().trim(); 

        let episodeSlug = null;
        if (episodeUrl) {
            episodeSlug = episodeUrl.replace(BASE_SCRAPE_URL_EPISODE, '').replace(/\/$/, '');
        }

        if (episodeUrl && episodeTitle && episodeSlug) {
            scrapedData.episodes.push({
                title: episodeTitle,
                url: episodeSlug,
                date: episodeDate
            });
        }
    });
    
    console.log(`[SCRAPER CV] Found ${scrapedData.episodes.length} remote episodes.`);
    
    if (scrapedData.episodes.length > 0) {
      scrapedData.episodes.reverse(); // Urutkan dari Ep 1 -> Ep Terakhir
    }

    // --- PERUBAHAN 2: Logika Pengecekan Kondisional ---
    // Bandingkan jumlah episode baru dengan jumlah episode lama
    if (!existingAnime || scrapedData.episodes.length > existingEpisodeCount) {
        
        console.log(`[SCRAPER CV] ${existingAnime ? 'Episode baru ditemukan!' : 'Anime baru.'} (${scrapedData.episodes.length} > ${existingEpisodeCount}). Memperbarui database...`);

        // Simpan semua data yang di-scrape (termasuk karakter, info, dll)
        const animeDocument = await Anime.findOneAndUpdate(
            { pageSlug: decodedSlug }, 
            scrapedData, // Simpan semua data baru
            { new: true, upsert: true }
        );
        console.log(`[SCRAPER CV] Successfully saved: ${decodedSlug}`);

        // Notify Google HANYA jika ada pembaruan
        if (animeDocument) {
            try { 
                await notifyGoogleIndexing(decodedSlug, 'URL_UPDATED'); 
            } catch (indexingError) { 
                console.warn(`[SCRAPER CV] Failed Google Indexing for ${decodedSlug}.`); 
            }
        }
        return animeDocument;

    } else {
        // JIKA TIDAK ADA EPISODE BARU
        console.log(`[SCRAPER CV] Tidak ada episode baru untuk ${decodedSlug} (${scrapedData.episodes.length} <= ${existingEpisodeCount}). Melewatkan pembaruan.`);
        return existingAnime; // Kembalikan data lama saja
    }
    // --- AKHIR PERUBAHAN 2 ---

  } catch (error) {
    if (axios.isAxiosError(error) && (error.response?.status === 403 || error.response?.status === 404)) {
      console.warn(`[SCRAPER CV] URL ${targetUrl} inaccessible (${error.response.status}). Skipping slug: ${decodedSlug}.`);
      return null;
    }
    console.error(`[SCRAPER CV] Error processing ${decodedSlug}:`, error);
    throw error;
  }
}


// ===================================
// --- EPISODE DETAIL SCRAPER (FIXED) ---
// ===================================
function decodeMirrorUrl(encodedValue) {
  if (!encodedValue) return null;
  try {
    const decodedHtml = Buffer.from(encodedValue, 'base64').toString('utf8');
    const $ = cheerio.load(decodedHtml);
    return $('iframe').attr('src') || null;
  } catch (e) {
    console.error(`Failed to decode value: ${encodedValue}`, e.message);
    return null;
  }
}

async function scrapeEpisodePageCv(episodeSlug) { // episodeSlug bisa jadi '...%e2%98%86...' ATAU '...☆...'

  // --- PERBAIKAN: Normalisasi slug (mengatasi double-encoding) ---
  // 1. Selalu DECODE slug yang masuk untuk mendapatkan bentuk aslinya.
  const decodedSlug = decodeURIComponent(episodeSlug);
  
  // 2. Selalu ENCODE slug asli tersebut untuk URL request yang aman.
  const encodedSlugForUrl = encodeURIComponent(decodedSlug);
  // --- AKHIR PERBAIKAN ---

  // 3. Gunakan slug yang sudah di-encode dengan benar
  const targetUrl = `${BASE_SCRAPE_URL_EPISODE}${encodedSlugForUrl}/`;

  try {
    // Gunakan decodedSlug di log agar lebih mudah dibaca
    console.log(`  [SCRAPER EP CV] Fetching episode data from: ${targetUrl}`);
    const { data } = await axios.get(targetUrl, { headers: SCRAPER_HEADERS });
    const $ = cheerio.load(data);

    if ($('title').text().includes('Just a moment...') || !$('h1.entry-title').length) {
      console.warn(`  [SCRAPER EP CV] Block page or invalid content for ${decodedSlug}. Skipping.`);
      return { title: decodedSlug.replace(/-/g, ' ').toUpperCase(), streaming: [], downloads: [], thumbnailUrl: '/images/default_thumb.jpg', errorStatus: 403 };
    }

    const result = {
        title: '',
        animeSeriesTitle: '', 
        animeSeriesLink: '', 
        streaming: [],
        downloads: [],
        thumbnailUrl: '/images/default_thumb.jpg' // <-- Ini akan selalu menjadi nilai akhir
    };

    result.title = $('h1.entry-title').text().trim();

    const breadcrumbLinks = $('div.ts-breadcrumb a');
    if (breadcrumbLinks.length >= 2) {
      const seriesLinkElement = $(breadcrumbLinks.get(breadcrumbLinks.length - 2));
      result.animeSeriesLink = seriesLinkElement.attr('href') || '';
      result.animeSeriesTitle = seriesLinkElement.find('span[itemprop="name"]').text().trim();
    }

    $('select.mirror option').each((i, el) => {
      const option = $(el);
      const serverName = option.text().trim();
      const encodedValue = option.val();
      if (encodedValue) {
        const decodedUrl = decodeMirrorUrl(encodedValue);
        if (decodedUrl) result.streaming.push({ name: serverName, url: decodedUrl });
      }
    });
    if (result.streaming.length === 0) {
      const mainIframeSrc = $('#pembed iframe').attr('src');
      if (mainIframeSrc) {
        let serverName = 'Default'; try { serverName = new URL(mainIframeSrc).hostname; } catch (e) {}
        result.streaming.push({ name: serverName, url: mainIframeSrc });
      }
    }

    $('div.soraddlx div.soraurlx').each((i, el) => {
      const qualityElement = $(el).find('strong');
      let quality = qualityElement.text().trim();
      qualityElement.remove();
      const links = [];
      $(el).find('a').each((i, linkEl) => {
        links.push({ host: $(linkEl).text().trim(), url: $(linkEl).attr('href') });
      });
      if (quality && links.length > 0) result.downloads.push({ quality: quality, links: links });
    });

    // --- BLOK LOGIKA THUMBNAIL DIHAPUS ---
    // Seluruh blok 'if (rawImageUrl) { ... }' dan pencarian selector
 // (dari baris 98-114 di kode asli Anda) telah dihapus.
    // 'result.thumbnailUrl' akan tetap '/images/default_thumb.jpg'.
    // --- AKHIR PENGHAPUSAN ---

    // Remove temporary fields not saved to Episode model
    delete result.animeSeriesTitle;
    delete result.animeSeriesLink;

    return result;

  } catch (error) {
    if (axios.isAxiosError(error) && (error.response?.status === 403 || error.response?.status === 404)) {
    console.warn(`  [SCRAPER EP CV] URL ${targetUrl} inaccessible (${error.response.status}). Skipping episode: ${decodedSlug}.`);
      return { title: decodedSlug.replace(/-/g, ' ').toUpperCase(), streaming: [], downloads: [], thumbnailUrl: '/images/default_thumb.jpg', errorStatus: error.response.status };
    }
    console.error(`  [SCRAPER EP CV] Error processing ${decodedSlug}:`, error);
    return { title: decodedSlug.replace(/-/g, ' ').toUpperCase(), streaming: [], downloads: [], thumbnailUrl: '/images/default_thumb.jpg', errorStatus: 500 };
  }
}


// ===================================
// --- EPISODE CACHING FUNCTION ---
// ===================================
async function getAndCacheEpisodeDataCv(episodeSlug) {
  const decodedSlug = decodeURIComponent(episodeSlug);
  console.log(`[CACHE CV] Checking cache for: ${decodedSlug}`);

  try {
    const existingEpisode = await Episode.findOne({ episodeSlug: decodedSlug }).lean();
    
    // --- LOGIKA PENGECEKAN (Sudah Benar) ---
    if (existingEpisode) {
      const hasStreaming = existingEpisode.streaming && existingEpisode.streaming.length > 0;
      const hasDownloads = existingEpisode.downloads && existingEpisode.downloads.length > 0;

      if (hasStreaming && hasDownloads) {
        console.log(`[CACHE CV] Data '${decodedSlug}' lengkap dan ditemukan di DB. Melewati scrape.`);
        return { status: 'skipped', data: existingEpisode };
      } else {
        console.log(`[CACHE CV] Data '${decodedSlug}' ada tapi tidak lengkap (Stream: ${hasStreaming}, Download: ${hasDownloads}). Memulai scrape ulang...`);
      }
    } else {
      console.log(`[CACHE CV] Data '${decodedSlug}' tidak ada di DB, memulai scrape...`);
    }
    // --- AKHIR LOGIKA PENGECEKAN ---

    const encodedSlugForUrl = encodeURIComponent(decodedSlug);
    const targetUrl = `${BASE_SCRAPE_URL_EPISODE}${encodedSlugForUrl}/`;

    console.log(`[SCRAPER CV] Mengambil URL: ${targetUrl}`);
    const { data } = await axios.get(targetUrl, { headers: SCRAPER_HEADERS });
    const $ = cheerio.load(data);

    // --- PERBAIKAN: Ekstrak Data (Selector Baru) ---
    const streaming = [];
    
    // Selector BARU untuk streaming (menggunakan select.mirror)
    $('select.mirror option').each((i, el) => {
        const option = $(el);
        const serverName = option.text().trim();
        const encodedValue = option.val(); // Ini adalah Base64
        
        // Lewati option pertama ("Pilih Server Video")
        if (serverName && encodedValue) {
            // Gunakan fungsi decodeMirrorUrl yang sudah ada
            const decodedUrl = decodeMirrorUrl(encodedValue); 
            if (decodedUrl) {
                streaming.push({ name: serverName, url: decodedUrl });
            }
        }
    });
    
    const downloads = [];
    
    // Selector BARU untuk download (menggunakan .soraddlx)
    $('div.soraddlx div.soraurlx').each((i, el) => {
        // Kualitas sekarang ada di tag <strong>
        const quality = $(el).find('strong').text().trim(); 
        const links = [];
        $(el).find('a').each((i, link) => {
            const host = $(link).text().trim();
            const url = $(link).attr('href');
            if (host && url) links.push({ host: host, url: url });
        });
        if (quality && links.length > 0) downloads.push({ quality: quality, links: links });
    });
    // --- AKHIR PERBAIKAN ---

    
    // Cek jika scrape gagal (tidak ada link)
    if (streaming.length === 0 && downloads.length === 0) {
        console.error(`[SCRAPER CV] Gagal scrape, tidak ada link stream/download ditemukan di ${targetUrl} (Mungkin selector berubah lagi)`);
        throw new Error(`Scrape ${decodedSlug} gagal, tidak ada link ditemukan.`);
    }

    // Ekstrak data anime induk
    const title = $('h1.entry-title').text().trim();
    // Selector breadcrumb masih sama
    const parentAnimeEl = $('div.ts-breadcrumb a').eq(1); 
    const parentAnimeTitle = parentAnimeEl.find('span[itemprop="name"]').text().trim();
    const parentAnimeUrl = parentAnimeEl.attr('href') || "";
    const parentAnimeSlug = parentAnimeUrl.replace(BASE_SCRAPE_URL_ANIME, '').replace(/\/$/, '');
    
    // Ambil gambar induk dari DB (jika ada)
    const parentAnimeImg = (await Anime.findOne({ pageSlug: parentAnimeSlug }).select('imageUrl').lean())?.imageUrl || '/images/default.jpg';
    
    // Ambil thumbnail dari meta tag (asumsi masih ada di <head>)
    const thumb = $('meta[property="og:image"]').attr('content') || '/images/default_thumb.jpg';

    const dataToSave = {
        episodeSlug: decodedSlug,
        title: title,
        thumbnailUrl: thumb,
        animeTitle: parentAnimeTitle,
        animeSlug: parentAnimeSlug,
        animeImageUrl: parentAnimeImg,
        streaming: streaming,
        downloads: downloads,
        // episodeDate akan diisi oleh proses 'add episode' manual
    };

    // Gunakan findOneAndUpdate + upsert (Sudah Benar)
    console.log(`[SCRAPER CV] Scrape berhasil. Menyimpan/Memperbarui cache DB...`);
    const updatedEntry = await Episode.findOneAndUpdate(
        { episodeSlug: decodedSlug }, // Kriteria pencarian
        { $set: dataToSave },         // Data baru/diperbarui
        { new: true, upsert: true, setDefaultsOnInsert: true } // Opsi
    );

    return { status: 'success', data: updatedEntry };

  } catch (error) {
    console.error(`[SCRAPER CV] Error processing ${decodedSlug}:`, error);
    return { status: 'failed', data: null, error: error.message };
  }
}

// ===================================
// --- EXPORTS ---
// ===================================
module.exports = {
  scrapeAndSaveCv,
  getAndCacheEpisodeDataCv,
  scrapeEpisodePageCv, // Export if needed
  // notifyGoogleIndexing // Export if needed
};
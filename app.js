// app.js - FINAL VERSION (FIXED)
require('dotenv').config({
  debug: false, quiet: true
});
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const Manga = require('./models/Manga');
const Chapter = require('./models/Chapter');

// IMPORT RUTE API (PENTING)
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;
const WEBSITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));

app.use((req, res, next) => {
  res.locals.siteName = process.env.SITE_NAME || 'DoujinShi';
  res.locals.siteUrl = process.env.SITE_URL || `${req.protocol}://${req.get('host')}`;
  res.locals.currentUrl = req.path;
  next();
});

// ==========================================
// SISTEM CACHE SEDERHANA (In-Memory)
// ==========================================
const cacheStore = new Map();

// Garbage Collection: Bersihkan cache expired setiap 5 menit
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cacheStore.entries()) {
    if (now > value.expiry) cacheStore.delete(key);
  }
}, 5 * 60 * 1000);

const simpleCache = (durationInSeconds) => {
  return (req, res, next) => {
    // Hanya cache method GET
    if (req.method !== 'GET') return next();

    // Key unik berdasarkan URL lengkap
    const key = `__cache__${req.originalUrl || req.url}`;
    const cachedBody = cacheStore.get(key);

    // Cek apakah data ada di cache dan belum expired
    if (cachedBody && Date.now() < cachedBody.expiry) {
      return res.send(cachedBody.html);
    }

    // Intercept res.send untuk menyimpan output ke cache
    const originalSend = res.send;
    res.send = (body) => {
      originalSend.call(res, body);
      cacheStore.set(key, {
        html: body,
        expiry: Date.now() + (durationInSeconds * 1000)
      });
    };
    next();
  };
};


// ==========================================
// HELPER FUNCTION: Hitung Chapter
// ==========================================
async function attachChapterCounts(mangas) {
  return await Promise.all(mangas.map(async (m) => {
    const count = await Chapter.countDocuments({
      manga_id: m._id
    });
    const mObj = m.toObject ? m.toObject(): m;
    mObj.chapter_count = count;
    return mObj;
  }));
}

// ==========================================
// HELPER: Ambil 1 Chapter Terbaru (SUPER RINGAN)
// Menggunakan Aggregation (1 Query untuk banyak Manga)
// ==========================================
async function attachLatestChapter(mangas) {
  if (!mangas || mangas.length === 0) return [];

  // 1. Kumpulkan semua ID Manga dalam array
  const mangaIds = mangas.map(m => m._id);

  // 2. Lakukan 1 Query Aggregation untuk mencari chapter terbaru dari semua ID tersebut
  const latestChapters = await mongoose.model('Chapter').aggregate([
    { 
      $match: { 
        manga_id: { $in: mangaIds } // Cari chapter yang manga_id nya ada di list
      } 
    },
    { $sort: { chapter_index: -1 } }, // Urutkan chapter dari besar ke kecil
    {
      $group: {
        _id: "$manga_id",           // Kelompokkan per Manga
        latest: { $first: "$$ROOT" } // Ambil chapter pertama (teratas/terbaru) setelah disortir
      }
    },
    {
      $project: { // Hanya ambil field yang penting (Hemat Bandwidth)
        _id: 1, 
        "latest.chapter_index": 1,
        "latest.slug": 1,
        "latest.createdAt": 1
      }
    }
  ]);

  // 3. Buat Map (Kamus) untuk pencarian cepat di memori
  const chapterMap = new Map();
  latestChapters.forEach(item => {
    chapterMap.set(item._id.toString(), item.latest);
  });

  // 4. Tempelkan data chapter ke object manga
  return mangas.map(m => {
    // Pastikan bentuknya object biasa (karena kita akan pakai .lean() di route)
    const mObj = m.toObject ? m.toObject() : m;
    
    // Ambil data dari Map, jika tidak ada set null
    mObj.latestChapter = chapterMap.get(mObj._id.toString()) || null;
    
    return mObj;
  });
}

// ==========================================
// 2. MAIN ROUTES (DENGAN CACHE)
// ==========================================

// HOME PAGE - Cache 60 Detik
app.get('/', simpleCache(180), async (req, res) => {
  try {
    const limit = 24;
    const page = parseInt(req.query.page) || 1;
    const skip = (page - 1) * limit;
    
    // 1. Recents (Update Terbaru)
    let recents = await Manga.find()
      .select('title slug thumb metadata tags updatedAt') // Optimasi: Select field
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit);
    // GANTI attachChapterCounts DENGAN attachLatestChapter
    recents = await attachLatestChapter(recents); 

    // 2. Trending (Biasanya tidak butuh chapter, tapi views)
    let trending = await Manga.find()
      .select('title slug thumb metadata views') // Optimasi
      .sort({ views: -1 })
      .limit(10);
    // Trending tidak wajib pakai chapter, biarkan raw atau attachLatestChapter jika mau

    // 3. Manhwa
    let manhwas = await Manga.find({ 'metadata.type': { $regex: 'manhwa', $options: 'i' } })
      .select('title slug thumb metadata')
      .sort({ updatedAt: -1 })
      .limit(24);
    // GANTI attachChapterCounts DENGAN attachLatestChapter
    manhwas = await attachLatestChapter(manhwas);

    // 4. Doujinshi
    let doujinshis = await Manga.find({ 'metadata.type': { $regex: 'doujinshi', $options: 'i' } })
      .select('title slug thumb metadata')
      .sort({ updatedAt: -1 })
      .limit(24);
    // GANTI attachChapterCounts DENGAN attachLatestChapter
    doujinshis = await attachLatestChapter(doujinshis);

    res.render('landing', {
      mangas: recents,
      trending: trending,
      manhwas: manhwas,
      doujinshis: doujinshis,
      title: `${res.locals.siteName} - Baca Komik Dewasa Terbaru Bahasa Indonesia`,
      desc: `${res.locals.siteName} Baca komik dewasa terbaru, manhwa 18+, manga, dan webtoon bahasa Indonesia gratis. Update harian dengan koleksi terlengkap di ${res.locals.siteName}.`
    });
  } catch (err) {
    console.error(err); // Penting untuk debugging
    res.status(500).send(err.message);
  }
});

// DETAIL PAGE - Cache 3 Menit
app.get('/manga/:slug', simpleCache(180), async (req, res) => {
  try {
    // Update Views
    const manga = await Manga.findOneAndUpdate(
      { slug: req.params.slug },
      { $inc: { views: 1 } },
      { new: true, timestamps: false }
    );

    // --- PERBAIKAN DI SINI ---
    // Tambahkan object { title: '...', desc: '...' } agar layout_head tidak error
    if (!manga) {
      return res.status(404).render('404', {
        title: '404 - Manga Tidak Ditemukan',
        desc: 'Maaf, manga yang Anda cari tidak dapat ditemukan.'
      });
    }
    // -------------------------

    // Ambil Chapters
    let chapters = await Chapter.find({
      manga_id: manga._id
    }).lean();

    // Sorting Descending (Chapter Baru di Atas)
    chapters.sort((b, a) => {
        const numB = parseFloat(String(b.chapter_index).replace(/[^0-9.]/g, '')) || 0;
        const numA = parseFloat(String(a.chapter_index).replace(/[^0-9.]/g, '')) || 0;
        return numB - numA; 
    });

    // Rekomendasi Manga Lain
    const recommendations = await Manga.aggregate([
        { $match: { _id: { $ne: manga._id } } },
        { $sample: { size: 12 } },
        { $project: { title: 1, slug: 1, thumb: 1, metadata: 1 } }
    ]);

    // SEO Data
    const siteName = res.locals.siteName;
    const type = manga.metadata && manga.metadata.type ? manga.metadata.type : 'Komik';
    const seoDesc = `Baca ${type} ${manga.title} bahasa Indonesia lengkap di ${siteName}. ${manga.synopsis || ''}`;

    res.render('detail', {
      manga,
      chapters,
      recommendations,
      title: `${manga.title} Bahasa Indonesia - ${res.locals.siteName}`,
      desc: seoDesc,
      ogType: 'article',
      image: manga.thumb
    });
  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

// MANGA LIST (A-Z) - Cache 5 Menit (300 detik)
app.get('/manga-list', simpleCache(300), async (req, res) => {
  try {
    const limit = 24;
    const page = parseInt(req.query.page) || 1;
    const skip = (page - 1) * limit;

    // --- FILTER QUERY LOGIC ---
    let query = {};
    const { q, status, type, orderby } = req.query;
    const genreParam = req.query['genre[]'] || req.query.genre; // Handle array or string

    // 1. Search
    if (q) {
      query.title = { $regex: q, $options: 'i' };
    }

    // 2. Filter Status
    if (status && status !== 'all') {
      query['metadata.status'] = { $regex: status, $options: 'i' };
    }

    // 3. Filter Type (Menangani data string atau object warisan)
    if (type && type !== 'all') {
      query.$or = [
        { 'metadata.type': { $regex: type, $options: 'i' } },
        { 'metadata.type.type': { $regex: type, $options: 'i' } } // Handle legacy object structure
      ];
    }

    // 4. Filter Genre
    if (genreParam) {
      const genres = Array.isArray(genreParam) ? genreParam : [genreParam];
      if (genres.length > 0) {
        // $all artinya manga harus punya SEMUA genre yang dipilih
        query.tags = { $all: genres.map(g => new RegExp(g, 'i')) };
      }
    }

    // --- SORTING LOGIC ---
    let sort = { title: 1 }; // Default A-Z
    if (orderby === 'titledesc') sort = { title: -1 };
    if (orderby === 'update') sort = { updatedAt: -1 };
    if (orderby === 'popular') sort = { views: -1 };

    // --- FETCH DATA UTAMA ---
    const totalManga = await Manga.countDocuments(query);
    const totalPages = Math.ceil(totalManga / limit);

    let mangas = await Manga.find(query)
      .select('title slug thumb metadata tags views updatedAt') // Select field penting saja
      .sort(sort)
      .skip(skip)
      .limit(limit);

    mangas = await attachChapterCounts(mangas);

    // --- [BARU] AMBIL DATA OPSI FILTER DARI DB ---
    // Mengambil daftar unik dari database agar dropdown sesuai isi DB
    const [dbGenres, dbStatuses, dbTypes] = await Promise.all([
      Manga.distinct('tags'),
      Manga.distinct('metadata.status'),
      Manga.distinct('metadata.type')
    ]);

    // Bersihkan data (hapus null/kosong dan urutkan)
    const genreList = dbGenres.filter(g => g).sort();
    const statusList = dbStatuses.filter(s => s).sort();
    
    // Normalisasi Type (karena ada kemungkinan data lama berbentuk object)
    const typeSet = new Set();
    dbTypes.forEach(t => {
      if (typeof t === 'string') typeSet.add(t);
      else if (t && t.type) typeSet.add(t.type); // Jika tersimpan sebagai object
    });
    const typeList = Array.from(typeSet).sort();

    res.render('manga_list', {
      mangas,
      currentPage: page,
      totalPages: totalPages,
      title: `Daftar Semua Manga - Halaman ${page}`,
      desc: `Daftar lengkap Manga diurutkan dari A-Z.`,
      
      // Kirim variable filter ke EJS
      queryParams: req.query, 
      genreList, 
      statusList, 
      typeList
    });

  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});


// READ CHAPTER - Cache 10 Menit (600 detik)
app.get('/read/:slug/:chapterSlug', simpleCache(600), async (req, res) => {
  try {
    const siteName = process.env.SITE_NAME || 'Doujinshi';

    const manga = await Manga.findOne({
      slug: req.params.slug
    }).lean();
    if (!manga) return res.status(404).send('Manga not found');
    
    const chapter = await Chapter.findOne({
      manga_id: manga._id, slug: req.params.chapterSlug
    });
    if (!chapter) return res.status(404).send('Chapter not found');

    const [allChapters, nextChap, prevChap] = await Promise.all([
        // 1. Ambil Semua Chapter untuk Sidebar/List
        Chapter.find({
          manga_id: manga._id
        })
        .select('title slug date chapter_index')
        .sort({
          chapter_index: -1
        }),

        // 2. LOGIKA NEXT (Chapter Selanjutnya / Angka Lebih Besar)
        // Contoh: Sekarang Ch 10, Next adalah Ch 11 ($gt: 10, sort asc)
        Chapter.findOne({
          manga_id: manga._id,
          chapter_index: {
            $gt: chapter.chapter_index // UBAH DISINI: Gunakan $gt (Greater Than)
          }
        }).sort({
          chapter_index: 1 // Sort Ascending (11, 12, 13...) ambil yang pertama
        }),

        // 3. LOGIKA PREV (Chapter Sebelumnya / Angka Lebih Kecil)
        // Contoh: Sekarang Ch 10, Prev adalah Ch 9 ($lt: 10, sort desc)
        Chapter.findOne({
          manga_id: manga._id,
          chapter_index: {
            $lt: chapter.chapter_index // UBAH DISINI: Gunakan $lt (Less Than)
          }
        }).sort({
          chapter_index: -1 // Sort Descending (9, 8, 7...) ambil yang pertama
        })
      ]);

    manga.chapters = allChapters;

    res.render('read', {
      manga,
      chapter,
      nextChap: nextChap,
      prevChap: prevChap,

      siteName,
      title: `${manga.title} - Chapter ${chapter.title}`,
      desc: `Baca manga ${manga.title} Chapter ${chapter.title} bahasa Indonesia terbaru di ${siteName}. Manga ${manga.title} bahasa Indonesia selalu update di ${siteName}. Jangan lupa membaca update manga lainnya ya. Daftar koleksi manga ${siteName} ada di menu Daftar Manga.`,
      ogType: 'article',
      image: manga.thumb
    });

  } catch (err) {
    console.error("Error Read Chapter:", err);
    res.status(500).send("Terjadi kesalahan pada server.");
  }
});

// ==========================================
// 3. SEARCH & FILTER ROUTES (DENGAN CACHE)
// ==========================================

// SEARCH - Cache 2 Menit (120 detik)
app.get('/search', simpleCache(120), async (req, res) => {
  try {
    const keyword = req.query.q;
    if (!keyword) return res.redirect('/');

    const limit = 24;
    const page = parseInt(req.query.page) || 1;
    const skip = (page - 1) * limit;
    const query = {
      title: {
        $regex: keyword,
        $options: 'i'
      }
    };

    const totalManga = await Manga.countDocuments(query);
    const totalPages = Math.ceil(totalManga / limit);

    let mangas = await Manga.find(query).limit(limit).skip(skip);
    mangas = await attachChapterCounts(mangas);

    res.render('archive', {
      mangas,
      pageTitle: `Hasil Pencarian: "${keyword}"`,
      title: `Cari ${keyword}`,
      desc: `Hasil pencarian ${keyword}`,
      currentPage: page,
      totalPages: totalPages,
      paginationBaseUrl: `/search?q=${keyword}&`
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// GENRES - Cache 1 Jam (3600 detik)
app.get('/genres', simpleCache(3600), async (req, res) => {
  try {
    const genres = await Manga.aggregate([{
      $unwind: "$tags"
    },
      {
        $group: {
          _id: "$tags", count: {
            $sum: 1
          }
        }
      },
      {
        $sort: {
          _id: 1
        }
      }]);
    res.render('genres', {
      genres, title: 'Daftar Genre', desc: 'Daftar genre komik.'
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// FILTER GENRE - Cache 5 Menit
app.get('/genre/:tag', simpleCache(300), async (req, res) => {
  try {
    const rawTag = req.params.tag;
    const limit = 24;
    const page = parseInt(req.query.page) || 1;
    const skip = (page - 1) * limit;

    const parts = rawTag.split('-').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const regexPattern = parts.join('[- ]');
    const query = {
      tags: {
        $regex: new RegExp(regexPattern, 'i')
      }
    };

    const totalManga = await Manga.countDocuments(query);
    const totalPages = Math.ceil(totalManga / limit);

    let mangas = await Manga.find(query).limit(limit).skip(skip);
    mangas = await attachChapterCounts(mangas);

    const displayTitle = rawTag.replace(/-/g, ' ').toUpperCase();

    // --- LOGIKA CANONICAL ---
    // Ambil URL dasar dari res.locals.siteUrl atau process.env
    const baseUrl = res.locals.siteUrl || process.env.SITE_URL || `http://localhost:${process.env.PORT || 3000}`;
    let canonicalUrl = `${baseUrl}/genre/${rawTag}`;
    if (page > 1) canonicalUrl += `?page=${page}`;

    res.render('archive', {
      mangas,
      pageTitle: `Genre: ${displayTitle}`,
      title: `Genre ${displayTitle} ${page > 1 ? '- Page ' + page : ''}`, // Tambah info page di title tab
      desc: `Daftar manga, manhwa, dan doujinshi dengan genre ${displayTitle}`,
      currentPage: page,
      totalPages: totalPages,
      paginationBaseUrl: `/genre/${rawTag}?`,
      canonicalUrl: canonicalUrl // <--- Kirim variable ini ke EJS
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// FILTER TYPE - Cache 5 Menit
app.get('/type/:type', simpleCache(300), async (req, res) => {
  try {
    const typeParam = req.params.type;
    const limit = 24;
    const page = parseInt(req.query.page) || 1;
    const skip = (page - 1) * limit;
    const sort = { updatedAt: -1 }; 

    const query = {
      'metadata.type': {
        $regex: `^${typeParam}$`,
        $options: 'i'
      }
    };

    const totalManga = await Manga.countDocuments(query);
    const totalPages = Math.ceil(totalManga / limit);
    
    let mangas = await Manga.find(query)
      .sort(sort)
      .limit(limit)
      .skip(skip);

    mangas = await attachChapterCounts(mangas);

    // --- LOGIKA CANONICAL ---
    const baseUrl = res.locals.siteUrl || process.env.SITE_URL || `http://localhost:${process.env.PORT || 3000}`;
    let canonicalUrl = `${baseUrl}/type/${typeParam}`;
    if (page > 1) canonicalUrl += `?page=${page}`;

    res.render('archive', {
      mangas,
      pageTitle: `${typeParam.toUpperCase()}`,
      title: `Type ${typeParam} ${page > 1 ? '- Page ' + page : ''}`,
      desc: `Daftar manga, manhwa, dan doujinshi dengan type ${typeParam}`,
      currentPage: page,
      totalPages: totalPages,
      paginationBaseUrl: `/type/${typeParam}?`,
      canonicalUrl: canonicalUrl // <--- Kirim variable ini ke EJS
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// FILTER STATUS - Cache 5 Menit
app.get('/status/:status', simpleCache(300), async (req, res) => {
  try {
    const statusParam = req.params.status;
    const limit = 24;
    const page = parseInt(req.query.page) || 1;
    const skip = (page - 1) * limit;
    const query = {
      'metadata.status': {
        $regex: `^${statusParam}$`,
        $options: 'i'
      }
    };

    const totalManga = await Manga.countDocuments(query);
    const totalPages = Math.ceil(totalManga / limit);

    let mangas = await Manga.find(query).limit(limit).skip(skip);
    mangas = await attachChapterCounts(mangas);

    // --- LOGIKA CANONICAL ---
    const baseUrl = res.locals.siteUrl || process.env.SITE_URL || `http://localhost:${process.env.PORT || 3000}`;
    let canonicalUrl = `${baseUrl}/status/${statusParam}`;
    if (page > 1) canonicalUrl += `?page=${page}`;

    res.render('archive', {
      mangas,
      pageTitle: `Status: ${statusParam.toUpperCase()}`,
      title: `Status ${statusParam} ${page > 1 ? '- Page ' + page : ''}`,
      desc: `Daftar manga, manhwa, dan doujinshi dengan status ${statusParam}`,
      currentPage: page,
      totalPages: totalPages,
      paginationBaseUrl: `/status/${statusParam}?`,
      canonicalUrl: canonicalUrl // <--- Kirim variable ini ke EJS
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ==========================================
// 4. SEO ROUTES (NO CHAPTERS - LIGHTWEIGHT)
// ==========================================

const SITEMAP_LIMIT = 1000; // Batas URL per file sitemap

// Helper: Escape XML Characters
function escapeXml(unsafe) {
    if (!unsafe) return "";
    return String(unsafe).replace(/[<>&'"]/g, function (c) {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
        }
    });
}

// A. Route untuk File Stylesheet (XSL)
app.get('/main-sitemap.xsl', (req, res) => {
    res.set('Content-Type', 'text/xsl');
    res.sendFile(path.join(__dirname, 'main-sitemap.xsl')); 
});

// B. ROBOTS.TXT
app.get('/robots.txt', (req, res) => {
    const baseUrl = process.env.SITE_URL || `https://${req.get('host')}`;
    res.type('text/plain');
    res.send(
`User-agent: *
Allow: /
Disallow: /api/
Disallow: /read/
Disallow: /search

Sitemap: ${baseUrl}/sitemap_index.xml`
    );
});

// Redirect sitemap lama
app.get('/sitemap.xml', (req, res) => res.redirect(301, '/sitemap_index.xml'));

// C. SITEMAP INDEX (Hanya Index Manga & Halaman Statis)
app.get('/sitemap_index.xml', async (req, res) => {
  try {
    const baseUrl = process.env.SITE_URL || `${req.protocol}://${req.get('host')}`;
    const lastMod = new Date().toISOString();

    // Hitung halaman Manga saja (Chapter dihapus)
    const totalManga = await Manga.countDocuments();
    const totalMangaPages = Math.ceil(totalManga / SITEMAP_LIMIT) || 1;

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
    <?xml-stylesheet type="text/xsl" href="/main-sitemap.xsl"?>
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap>
        <loc>${baseUrl}/page-sitemap.xml</loc>
        <lastmod>${lastMod}</lastmod>
      </sitemap>
      <sitemap>
        <loc>${baseUrl}/genre-sitemap.xml</loc>
        <lastmod>${lastMod}</lastmod>
      </sitemap>`;

    // Loop hanya untuk Manga
    for (let i = 1; i <= totalMangaPages; i++) {
      const suffix = i === 1 ? '' : `-${i}`; 
      xml += `<sitemap><loc>${baseUrl}/manga-sitemap${suffix}.xml</loc><lastmod>${lastMod}</lastmod></sitemap>`;
    }

    xml += `</sitemapindex>`;

    res.header('Content-Type', 'application/xml');
    res.send(xml);

  } catch (error) {
    console.error("Error Sitemap Index:", error);
    res.status(500).end();
  }
});

// D. PAGE SITEMAP (Statis)
app.get('/page-sitemap.xml', (req, res) => {
  const baseUrl = process.env.SITE_URL || `${req.protocol}://${req.get('host')}`;
  const now = new Date().toISOString();

  const staticPages = [
    { url: '/', priority: '1.0' },
    { url: '/manga-list', priority: '0.9' },
    { url: '/genres', priority: '0.8' },
    { url: '/type/manhwa', priority: '0.8' },
    { url: '/type/manga', priority: '0.8' },
    { url: '/type/doujinshi', priority: '0.8' },
  ];

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
  <?xml-stylesheet type="text/xsl" href="/main-sitemap.xsl"?>
  <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

  staticPages.forEach(page => {
    xml += `<url><loc>${baseUrl}${page.url}</loc><lastmod>${now}</lastmod><changefreq>daily</changefreq><priority>${page.priority}</priority></url>`;
  });

  xml += `</urlset>`;
  res.header('Content-Type', 'application/xml');
  res.send(xml);
});

// E. GENRE SITEMAP (FIX DUPLIKAT & LOWERCASE)
app.get('/genre-sitemap.xml', async (req, res) => {
    try {
        const baseUrl = process.env.SITE_URL || `${req.protocol}://${req.get('host')}`;
        const now = new Date().toISOString();
        const rawGenres = await Manga.distinct('tags');
        const uniqueGenres = new Set();

        rawGenres.forEach(tag => {
            if (tag) {
                const cleanSlug = tag.trim().replace(/\s+/g, '-').toLowerCase();
                if (cleanSlug.length > 0) {
                    uniqueGenres.add(cleanSlug);
                }
            }
        });

        let xml = `<?xml version="1.0" encoding="UTF-8"?>
        <?xml-stylesheet type="text/xsl" href="/main-sitemap.xsl"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;
        for (const slug of uniqueGenres) {
             const safeUrl = encodeURIComponent(slug); 
             xml += `<url><loc>${baseUrl}/genre/${safeUrl}</loc><lastmod>${now}</lastmod><priority>0.7</priority></url>`;
        }

        xml += `</urlset>`;
        res.header('Content-Type', 'application/xml');
        res.send(xml);
    } catch (e) { 
        console.error(e);
        res.status(500).end(); 
    }
});

// F. MANGA SITEMAP (Cursor Stream + allowDiskUse)
app.get(/^\/manga-sitemap(-(\d+))?\.xml$/, async (req, res) => {
  try {
    const baseUrl = process.env.SITE_URL || `${req.protocol}://${req.get('host')}`;
    const pageParam = req.params[1]; 
    const page = pageParam ? parseInt(pageParam) : 1;
    const skip = (page - 1) * SITEMAP_LIMIT;

    const xmlHeader = `<?xml version="1.0" encoding="UTF-8"?>
    <?xml-stylesheet type="text/xsl" href="/main-sitemap.xsl"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
            xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">`;
    const xmlFooter = `</urlset>`;

    res.header('Content-Type', 'application/xml');
    res.write(xmlHeader);

    const cursor = Manga.find()
      .select('slug updatedAt thumb title')
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(SITEMAP_LIMIT)
      .allowDiskUse(true)
      .lean()
      .cursor();

    for await (const m of cursor) {
      try {
          let dateObj = m.updatedAt ? new Date(m.updatedAt) : new Date();
          if (isNaN(dateObj.getTime())) dateObj = new Date();
          
          let imageXml = '';
          if (m.thumb && m.thumb.startsWith('http')) {
            const cleanTitle = escapeXml(m.title || 'Manga');
            const cleanThumb = escapeXml(m.thumb);
            imageXml = `<image:image><image:loc>${cleanThumb}</image:loc><image:title>${cleanTitle}</image:title></image:image>`;
          }

          const entry = `
          <url>
            <loc>${baseUrl}/manga/${escapeXml(m.slug)}</loc>
            <lastmod>${dateObj.toISOString()}</lastmod>
            <changefreq>weekly</changefreq>
            <priority>0.9</priority>
            ${imageXml}
          </url>`;
          res.write(entry);
      } catch (err) {
          console.error("Skipping bad manga:", m._id);
      }
    }

    res.end(xmlFooter);

  } catch (error) {
    console.error("Error Sitemap Manga Fatal:", error);
    if(!res.headersSent) res.status(500).end();
    else res.end();
  }
});




// STATIC PAGES - Cache 1 Jam
app.get('/privacy', simpleCache(3600), (req, res) => res.render('privacy', {
  title: 'Privacy Policy',
  desc: 'Kebijakan Privasi'
}));
app.get('/terms', simpleCache(3600), (req, res) => res.render('terms', {
  title: 'Terms of Service',
  desc: 'Syarat dan Ketentuan'
}));
app.get('/contact', simpleCache(3600), (req, res) => res.render('contact', {
  title: 'Contact Us',
  desc: 'Hubungi Kami'
}));

// PROFIL PAGE
app.get('/profile', (req, res) => {
  res.render('profile',
    {
      title: `Profil Saya - ${res.locals.siteName}`,
      desc: 'Lihat bookmark dan riwayat bacaan kamu.'
    });
});

// LANDING PAGE APLIKASI - Cache 1 Jam
app.get('/app', simpleCache(3600), (req, res) => {
  res.render('apk', {
    title: `Download Aplikasi - ${res.locals.siteName}`,
    desc: 'Download aplikasi Doujindesu versi terbaru untuk Android. Baca doujinshi lebih nyaman dan cepat.',
    currentUrl: '/app'
  });
});


app.use('/api', apiRoutes);

app.use((req, res) => res.status(404).render('404', {
  title: '404 - Tidak Ditemukan',
  desc: 'Halaman tidak ditemukan.'
}));

// ==========================================
// 4. SERVER STARTUP
// ==========================================

const DB_URI = process.env.DB_URI;

if (!DB_URI) {
  console.error("FATAL ERROR: DB_URI is not defined in environment variables.");
  process.exit(1);
}

const startServer = async () => {
  try {
    await mongoose.connect(DB_URI, {
      serverSelectionTimeoutMS: 30000
    });
    console.log('Successfully connected to MongoDB...');

    app.listen(PORT, () => {
      console.log(`Server is running on port: ${PORT}`);
      console.log(`Access at: ${WEBSITE_URL}`);
    });

  } catch (err) {
    console.error('Failed to connect to MongoDB. Server will not start.', err);
    process.exit(1);
  }
};

startServer();

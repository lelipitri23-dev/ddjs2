// app.js - FINAL VERSION (FIXED)
require('dotenv').config({
  debug: false, quiet: true
});
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const Manga = require('./models/Manga');
const Chapter = require('./models/Chapter');
const TelegramBot = require('node-telegram-bot-api');

// IMPORT RUTE API (PENTING)
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. DEFINISI VARIABLE & KONFIGURASI (FIXED)
// ==========================================
// PENTING: Token harus didefinisikan SEBELUM digunakan oleh new TelegramBot
const token = process.env.TELEGRAM_BOT_TOKEN;
// PENTING: URL Website harus didefinisikan untuk link di Telegram
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
//  SISTEM CACHE SEDERHANA (In-Memory)
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
// INISIALISASI BOT
// ==========================================
// Token sekarang sudah terdefinisi, jadi ini aman
const bot = new TelegramBot(token, {
  polling: true
});

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
// 2. MAIN ROUTES (DENGAN CACHE)
// ==========================================

// HOME PAGE - Cache 60 Detik
app.get('/', simpleCache(60), async (req, res) => {
  try {
    const limit = 24;
    const page = parseInt(req.query.page) || 1;
    const skip = (page - 1) * limit;

    const totalManga = await Manga.countDocuments();
    const totalPages = Math.ceil(totalManga / limit);

    // 1. Ambil Update Terbaru (FIXED: Gunakan updatedAt)
    // Ini akan menampilkan manga yang baru saja discrape chapter barunya
    let recents = await Manga.find().sort({
      updatedAt: -1 // <--- GANTI DARI createdAt JADI updatedAt
    }).skip(skip).limit(limit);
    recents = await attachChapterCounts(recents);

    // 2. Ambil Trending (Tetap berdasarkan views tertinggi)
    let trending = await Manga.find().sort({
      views: -1
    }).limit(10);
    trending = await attachChapterCounts(trending);

    // 3. Ambil Manhwa (FIXED: Gunakan updatedAt juga)
    // Agar list Manhwa juga menampilkan update terbaru
    let manhwas = await Manga.find({
      'metadata.type': {
        $regex: 'manhwa', $options: 'i'
      }
    }).sort({
      updatedAt: -1 // <--- GANTI DARI createdAt JADI updatedAt
    }).limit(24);
    manhwas = await attachChapterCounts(manhwas);

    res.render('landing', {
      mangas: recents,
      trending: trending,
      manhwas: manhwas,
      currentPage: page,
      totalPages: totalPages,
      title: `${res.locals.siteName} - Baca Manga & Manhwa Bahasa Indonesia`,
      desc: `${res.locals.siteName} adalah website download dan baca doujin bahasa indonesia terbaru dan terlengkap. Kamu bisa membaca berbagai macam doujin secara gratis di ${res.locals.siteName}.`
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// DETAIL PAGE - Cache 3 Menit
app.get('/manga/:slug', simpleCache(180), async (req, res) => {
  try {
    // 1. Ambil Data Manga
    const manga = await Manga.findOneAndUpdate(
      { slug: req.params.slug },
      { $inc: { views: 1 } },
      { new: true, timestamps: false }
    );

    if (!manga) return res.status(404).render('404');

    // 2. Ambil Chapter (Tanpa Sorting Database)
    let chapters = await Chapter.find({
      manga_id: manga._id
    }).lean();

    // 3. SORTING MANUAL JAVASCRIPT (ASCENDING: 1 -> 22)
    chapters.sort((a, b) => {
        // Ambil angkanya
        const numA = parseFloat(a.chapter_index) || 0;
        const numB = parseFloat(b.chapter_index) || 0;
        
        // Rumus Ascending (Kecil ke Besar): (A - B)
        // Jika hasil negatif, A ditaruh sebelum B
        return numA - numB; 
    });

    const siteName = res.locals.siteName;
    const type = manga.metadata && manga.metadata.type ? manga.metadata.type : 'Komik';
    const seoDesc = `Baca ${type} ${manga.title} bahasa Indonesia lengkap di ${siteName}.`;

    res.render('detail', {
      manga,
      chapters,
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

    const totalManga = await Manga.countDocuments();
    const totalPages = Math.ceil(totalManga / limit);

    let mangas = await Manga.find()
    .select('title slug thumb metadata.rating metadata.type metadata.status')
    .sort({
      title: 1
    })
    .skip(skip)
    .limit(limit);

    mangas = await attachChapterCounts(mangas);

    res.render('manga_list', {
      mangas,
      currentPage: page,
      totalPages: totalPages,
      title: `Daftar Komik A-Z - Halaman ${page}`,
      desc: `Daftar lengkap komik diurutkan dari A-Z.`
    });
  } catch (err) {
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

    const [allChapters,
      nextChap,
      prevChap] = await Promise.all([
        Chapter.find({
          manga_id: manga._id
        })
        .select('title slug date chapter_index')
        .sort({
          chapter_index: -1
        }),
        Chapter.findOne({
          manga_id: manga._id,
          chapter_index: {
            $lt: chapter.chapter_index
          }
        }).sort({
          chapter_index: -1
        }),
        Chapter.findOne({
          manga_id: manga._id,
          chapter_index: {
            $gt: chapter.chapter_index
          }
        }).sort({
          chapter_index: 1
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
    res.render('archive', {
      mangas,
      pageTitle: `Genre: ${displayTitle}`,
      title: `Genre ${displayTitle}`,
      desc: `Komik genre ${displayTitle}`,
      currentPage: page,
      totalPages: totalPages,
      paginationBaseUrl: `/genre/${rawTag}?`
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
    const query = {
      'metadata.type': {
        $regex: `^${typeParam}$`,
        $options: 'i'
      }
    };

    const totalManga = await Manga.countDocuments(query);
    const totalPages = Math.ceil(totalManga / limit);

    let mangas = await Manga.find(query).limit(limit).skip(skip);
    mangas = await attachChapterCounts(mangas);

    res.render('archive', {
      mangas,
      pageTitle: `Type: ${typeParam.toUpperCase()}`,
      title: `Tipe ${typeParam}`,
      desc: `Komik tipe ${typeParam}`,
      currentPage: page,
      totalPages: totalPages,
      paginationBaseUrl: `/type/${typeParam}?`
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

    res.render('archive', {
      mangas,
      pageTitle: `Status: ${statusParam.toUpperCase()}`,
      title: `Status ${statusParam}`,
      desc: `Komik status ${statusParam}`,
      currentPage: page,
      totalPages: totalPages,
      paginationBaseUrl: `/status/${statusParam}?`
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ==========================================
// 4. SEO ROUTES (Robots & Sitemap Generator)
// ==========================================

// Helper Formatter Tanggal
const formatDate = (date) => {
    const d = new Date(date || Date.now());
    return d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
};

// 1. ROBOTS.TXT
app.get('/robots.txt', (req, res) => {
    const baseUrl = process.env.SITE_URL || `https://${req.get('host')}`;
    res.type('text/plain');
    res.send(
        `User-agent: *\n` +
        `Allow: /\n` +
        `Disallow: /api/\n` +
        `\n` +
        `User-agent: Googlebot\n` +
        `Allow: /\n` +
        `\n` +
        `User-agent: Bingbot\n` +
        `Allow: /\n` +
        `\n` +
        `Sitemap: ${baseUrl}/sitemap.xml`
    );
});


// 2. SITEMAP INDEX
app.get('/sitemap.xml', (req, res) => {
    const baseUrl = process.env.SITE_URL || `https://${req.get('host')}`;
    const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
    const xmlFooter = '</sitemapindex>';
    const lastMod = formatDate();

    const sitemaps = [
        'sitemap-static.xml', 
        'sitemap-manga.xml',  
        'sitemap-chapter.xml' 
    ];

    let xmlBody = '';
    sitemaps.forEach(map => {
        xmlBody += `<sitemap><loc>${baseUrl}/${map}</loc><lastmod>${lastMod}</lastmod></sitemap>`;
    });

    res.header('Content-Type', 'application/xml');
    res.send(xmlHeader + xmlBody + xmlFooter);
});

// 3. SITEMAP STATIC
app.get('/sitemap-static.xml', (req, res) => {
    const baseUrl = process.env.SITE_URL || `https://${req.get('host')}`;
    const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
    const xmlFooter = '</urlset>';
    
    const staticPages = [
        { url: '/', changefreq: 'hourly', priority: '1.0' },
        { url: '/manga-list', changefreq: 'daily', priority: '0.9' },
        { url: '/genres', changefreq: 'weekly', priority: '0.8' },
        { url: '/status/publishing', changefreq: 'daily', priority: '0.8' },
        { url: '/status/finished', changefreq: 'weekly', priority: '0.8' },
        { url: '/type/manga', changefreq: 'weekly', priority: '0.7' },
        { url: '/type/manhwa', changefreq: 'weekly', priority: '0.7' },
        { url: '/type/doujinshi', changefreq: 'weekly', priority: '0.7' },
        { url: '/profile', changefreq: 'weekly', priority: '0.7' },
        { url: '/privacy', changefreq: 'weekly', priority: '0.7' },
        { url: '/terms', changefreq: 'weekly', priority: '0.7' },
        { url: '/contact', changefreq: 'weekly', priority: '0.7' }
    ];

    let xmlBody = '';
    const now = formatDate();
    
    staticPages.forEach(page => {
        xmlBody += `<url><loc>${baseUrl}${page.url}</loc><lastmod>${now}</lastmod><changefreq>${page.changefreq}</changefreq><priority>${page.priority}</priority></url>`;
    });

    res.header('Content-Type', 'application/xml');
    res.send(xmlHeader + xmlBody + xmlFooter);
});

// Fungsi bantu untuk membersihkan karakter khusus (Wajib ada)
function escapeXml(unsafe) {
    if (!unsafe) return "";
    return unsafe.replace(/[<>&'"]/g, function (c) {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
        }
    });
}

// 4. SITEMAP MANGA
app.get('/sitemap-manga.xml', async (req, res) => {
    try {
        const baseUrl = process.env.SITE_URL || `https://${req.get('host')}`;
        
        const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">';
        const xmlFooter = '</urlset>';

        res.header('Content-Type', 'application/xml');
        res.write(xmlHeader);

        const cursor = Manga.find({}, 'slug updatedAt thumb title').cursor();

        for await (const doc of cursor) {
            if (doc.slug) {
                // --- PERBAIKAN FORMAT TANGGAL DI SINI ---
                // 1. Buat objek Date
                const dateObj = doc.updatedAt ? new Date(doc.updatedAt) : new Date();
                
                // 2. Ambil format ISO (YYYY-MM-DDTHH:mm:ss...) lalu ambil bagian depan "T"
                // Hasil: "2025-12-15"
                const lastMod = dateObj.toISOString().split('T')[0]; 
                
                // Bersihkan data
                const cleanTitle = escapeXml(doc.title);
                const thumbUrl = doc.thumb ? doc.thumb.trim() : '';

                let urlEntry = `<url>
                    <loc>${baseUrl}/manga/${doc.slug}</loc>
                    <lastmod>${lastMod}</lastmod>
                    <changefreq>weekly</changefreq>
                    <priority>0.9</priority>`;

                if (thumbUrl) {
                    urlEntry += `
                    <image:image>
                        <image:loc>${thumbUrl}</image:loc>
                        <image:title>${cleanTitle}</image:title>
                    </image:image>`;
                }

                urlEntry += `</url>`;
                
                res.write(urlEntry);
            }
        }

        res.end(xmlFooter); 
    } catch (err) {
        console.error("Sitemap Manga Error:", err);
        res.status(500).end();
    }
});

// Konfigurasi Limit
const CHAPTER_LIMIT = 500;

// 1. SITEMAP INDEX CHAPTER (Daftar Halaman)
app.get('/sitemap-chapter.xml', async (req, res) => {
    try {
        const baseUrl = process.env.SITE_URL || `https://${req.get('host')}`;
        
        // Hitung total halaman
        const totalChapters = await Chapter.countDocuments();
        const totalPages = Math.ceil(totalChapters / CHAPTER_LIMIT);

        const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
        const xmlFooter = '</sitemapindex>';
        
        // Tanggal hari ini YYYY-MM-DD
        const lastMod = new Date().toISOString().split('T')[0];

        res.header('Content-Type', 'application/xml');
        res.write(xmlHeader);

        for (let i = 1; i <= totalPages; i++) {
            res.write(`
            <sitemap>
                <loc>${baseUrl}/sitemap-chapter${i}.xml</loc>
                <lastmod>${lastMod}</lastmod>
            </sitemap>`);
        }

        res.end(xmlFooter);

    } catch (err) {
        console.error("Sitemap Chapter Index Error:", err);
        res.status(500).end();
    }
});

// 2. SITEMAP HALAMAN PER CHAPTER (Data URL)
app.get('/sitemap-chapter:page.xml', async (req, res) => {
    try {
        const baseUrl = process.env.SITE_URL || `https://${req.get('host')}`;
        
        // Parsing Page: Hapus ".xml" jika terbawa, lalu jadi integer
        let pageParam = req.params.page.replace('.xml', '');
        const page = parseInt(pageParam) || 1;
        const skip = (page - 1) * CHAPTER_LIMIT;

        // Ambil Data dengan .lean() agar ringan & cepat
        const cursor = Chapter.find()
            .select('slug updatedAt manga_id')
            .populate('manga_id', 'slug')
            .sort({ updatedAt: -1 })
            .skip(skip)
            .limit(CHAPTER_LIMIT)
            .lean()
            .cursor(); // Gunakan cursor untuk streaming

        const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
        const xmlFooter = '</urlset>';

        res.header('Content-Type', 'application/xml');
        res.write(xmlHeader);

        // Loop menggunakan Cursor (Hemat Memori)
        for await (const doc of cursor) {
            // Pastikan data lengkap (cegah error null property)
            if (doc.slug && doc.manga_id && doc.manga_id.slug) {
                
                // Format Tanggal: YYYY-MM-DD
                const dateObj = doc.updatedAt ? new Date(doc.updatedAt) : new Date();
                const lastMod = dateObj.toISOString().split('T')[0];

                const url = `${baseUrl}/read/${doc.manga_id.slug}/${doc.slug}`;
                
                res.write(`
                <url>
                    <loc>${url}</loc>
                    <lastmod>${lastMod}</lastmod>
                    <changefreq>weekly</changefreq>
                    <priority>0.6</priority>
                </url>`);
            }
        }

        res.end(xmlFooter);

    } catch (err) {
        console.error(`Sitemap Chapter Page ${req.params.page} Error:`, err);
        res.status(500).end();
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

// ==========================================
// TELEGRAM BOT HELPER
// ==========================================
async function sendMangaMessage(chatId, manga) {
  // WEBSITE_URL diambil dari deklarasi di atas
  const link = `${WEBSITE_URL}/manga/${manga.slug}`;
  const caption = `<b><a href="${link}">${manga.title}</a></b>`; 

  if (manga.thumb && manga.thumb.startsWith('http')) {
    try {
      await bot.sendPhoto(chatId, manga.thumb, {
        caption: caption,
        parse_mode: 'HTML'
      });
    } catch (e) {
      await bot.sendMessage(chatId, caption, {
        parse_mode: 'HTML'
      });
    }
  } else {
    await bot.sendMessage(chatId, caption, {
      parse_mode: 'HTML'
    });
  }
}

// ==========================================
// COMMAND HANDLERS
// ==========================================

// 1. Command /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const welcomeMessage =
  `  *Halo! Saya Bot Doujinshi.*\n\n` +
  `Gunakan perintah berikut:\n` +
  `/search <judul> - Cari manga\n` +
  `/latest - Lihat update terbaru`;

  bot.sendMessage(chatId, welcomeMessage, {
    parse_mode: 'Markdown'
  });
});

// 2. Command /search <keyword>
bot.onText(/\/search (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const keyword = match[1];

  try {
    bot.sendChatAction(chatId, 'typing');

    const results = await Manga.find({
      title: {
        $regex: keyword, $options: 'i'
      }
    })
    .select('title slug thumb')
    .limit(5); 

    if (results.length === 0) {
      return bot.sendMessage(chatId, `  Tidak ditemukan: <b>${keyword}</b>`, {
        parse_mode: 'HTML'
      });
    }

    for (const manga of results) {
      await sendMangaMessage(chatId, manga);
    }

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, '  Terjadi kesalahan server.');
  }
});

// 3. Command /latest
bot.onText(/\/latest/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    bot.sendChatAction(chatId, 'typing');

    const recents = await Manga.find()
    .sort({
      createdAt: -1
    }) 
    .limit(5)
    .select('title slug thumb');

    if (recents.length === 0) {
      return bot.sendMessage(chatId, '  Belum ada data manga.');
    }

    await bot.sendMessage(chatId, '  <b>Update Terbaru:</b>', {
      parse_mode: 'HTML'
    });

    for (const manga of recents) {
      await sendMangaMessage(chatId, manga);
    }

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, '  Gagal mengambil data terbaru.');
  }
});

// Handler error global
bot.on('polling_error', (error) => {
  console.log('Telegram Polling Error:', error.code);
});

app.use((req, res) => res.status(404).render('404', {
  title: '404 - Tidak Ditemukan',
  desc: 'Halaman tidak ditemukan.'
}));

// ==========================================
// 4. SERVER STARTUP
// ==========================================

const DB_URI = process.env.DB_URI;

if (!DB_URI) {
  console.error(" FATAL ERROR: DB_URI is not defined in environment variables.");
  process.exit(1);
}

const startServer = async () => {
  try {
    await mongoose.connect(DB_URI, {
      serverSelectionTimeoutMS: 30000
    });
    console.log(' Successfully connected to MongoDB...');

    app.listen(PORT, () => {
      console.log(` Server is running on port: ${PORT}`);
      console.log(` Access at: ${WEBSITE_URL}`);
    });

  } catch (err) {
    console.error(' Failed to connect to MongoDB. Server will not start.', err);
    process.exit(1);
  }
};

startServer();

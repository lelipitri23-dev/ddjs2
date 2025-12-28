const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Manga = require('../models/Manga');
const Chapter = require('../models/Chapter');

// ==========================================
// HELPER: Pasang Chapter Terbaru ke Object Manga
// (Agar di Frontend muncul "Ch. 123" & "2 hours ago" di card)
// ==========================================
async function attachLatestChapter(mangas) {
    if (!mangas || mangas.length === 0) return [];
  
    const mangaIds = mangas.map(m => m._id);
  
    // Cari 1 chapter terbaru untuk setiap manga dalam list
    const latestChapters = await Chapter.aggregate([
      { $match: { manga_id: { $in: mangaIds } } },
      { $sort: { chapter_index: -1 } },
      {
        $group: {
          _id: "$manga_id",
          latest: { $first: "$$ROOT" } // Ambil yang paling atas (terbaru)
        }
      },
      {
        $project: { 
          _id: 1, 
          "latest.chapter_index": 1,
          "latest.slug": 1,
          "latest.createdAt": 1
        }
      }
    ]);
  
    // Buat Map untuk pencarian cepat
    const chapterMap = new Map();
    latestChapters.forEach(item => {
      chapterMap.set(item._id.toString(), item.latest);
    });
  
    // Tempel data ke object manga
    return mangas.map(m => {
      const mObj = m.toObject ? m.toObject() : m; // Pastikan jadi object biasa
      mObj.latestChapter = chapterMap.get(mObj._id.toString()) || null;
      return mObj;
    });
}

// ==========================================
// 1. ENDPOINT: LIST MANGA (Filter, Search, Page)
// ==========================================
router.get('/manga', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 24; // Support custom limit (e.g. for Sitemap)
        const skip = (page - 1) * limit;
        
        let query = {};
        const { q, status, type, genre } = req.query;

        // Filter Pencarian Judul
        if (q) query.title = { $regex: q, $options: 'i' };
        
        // Filter Status (Ongoing/Completed)
        if (status && status !== 'all') query['metadata.status'] = { $regex: status, $options: 'i' };
        
        // Filter Tipe (Manga/Manhwa/Manhua)
        if (type && type !== 'all') {
            query.$or = [
                { 'metadata.type': { $regex: type, $options: 'i' } },
                { 'metadata.type.type': { $regex: type, $options: 'i' } } // Handle variasi struktur data
            ];
        }

        // Filter Genre
        if (genre) {
            query.tags = { $regex: genre, $options: 'i' };
        }

        let mangas = await Manga.find(query)
            .select('title slug thumb metadata views tags updatedAt')
            .sort({ updatedAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        // Tempelkan data chapter terbaru
        mangas = await attachLatestChapter(mangas);

        res.json({
            success: true,
            page: page,
            data: mangas
        });

    } catch (err) {
        console.error("API List Error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ==========================================
// 2. ENDPOINT: DETAIL MANGA (+ 12 Recommendations)
// ==========================================
router.get('/manga/:slug', async (req, res) => {
    try {
        const { slug } = req.params;

        // 1. Ambil Info Manga Utama
        const manga = await Manga.findOne({ slug }).lean();
        if (!manga) {
            return res.status(404).json({ success: false, message: 'Manga not found' });
        }

        // 2. Ambil List Chapter
        const chapters = await Chapter.find({ manga_id: manga._id })
            .select('title slug chapter_index date createdAt')
            .sort({ chapter_index: -1 })
            .lean();

        // 3. Ambil 12 Rekomendasi (Random, kecuali manga ini sendiri)
        let recommendations = await Manga.aggregate([
            { $match: { _id: { $ne: manga._id } } }, // Jangan ambil manga yang sedang dibuka
            { $sample: { size: 12 } }, // Ambil 12 secara acak
            { $project: { title: 1, slug: 1, thumb: 1, metadata: 1, views: 1, updatedAt: 1 } }
        ]);

        // Pasang chapter terbaru ke rekomendasi agar card terlihat lengkap
        recommendations = await attachLatestChapter(recommendations);

        res.json({
            success: true,
            data: {
                ...manga,
                chapters: chapters,
                recommendations: recommendations
            }
        });

    } catch (err) {
        console.error("API Detail Error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ==========================================
// 3. ENDPOINT: BACA CHAPTER (Reader Data + Nav)
// ==========================================
router.get('/read/:slug/:chapterSlug', async (req, res) => {
  try {
    const { slug, chapterSlug } = req.params;

    // Cari Manga ID dulu
    const manga = await Manga.findOne({ slug })
      .select('_id title slug thumb author')
      .lean();

    if (!manga) {
      return res.status(404).json({ success: false, message: 'Manga tidak ditemukan' });
    }

    // Cari Chapter yang sedang dibuka
    const chapter = await Chapter.findOne({
      manga_id: manga._id,
      slug: chapterSlug
    }).lean();

    if (!chapter) {
      return res.status(404).json({ success: false, message: 'Chapter tidak ditemukan' });
    }

    // Cari Next & Prev Chapter untuk navigasi
    const [nextChap, prevChap] = await Promise.all([
      Chapter.findOne({
        manga_id: manga._id,
        chapter_index: { $gt: chapter.chapter_index } // Index lebih besar = Next
      }).select('slug title chapter_index').sort({ chapter_index: 1 }).lean(),

      Chapter.findOne({
        manga_id: manga._id,
        chapter_index: { $lt: chapter.chapter_index } // Index lebih kecil = Prev
      }).select('slug title chapter_index').sort({ chapter_index: -1 }).lean()
    ]);

    res.json({
      success: true,
      data: {
        _id: chapter._id,
        title: chapter.title,
        chapter_index: chapter.chapter_index,
        slug: chapter.slug,
        date: chapter.date || chapter.createdAt,
        images: chapter.images || [], 
        manga: {
          title: manga.title,
          slug: manga.slug,
          thumb: manga.thumb,
          author: manga.author || 'Unknown'
        },
        navigation: {
          next_slug: nextChap ? nextChap.slug : null,
          prev_slug: prevChap ? prevChap.slug : null,
          next_title: nextChap ? nextChap.title : null,
          prev_title: prevChap ? prevChap.title : null
        }
      }
    });

  } catch (err) {
    console.error("API Read Error:", err);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
});

// ==========================================
// 4. ENDPOINT: HOME DATA (Aggregated)
// ==========================================
router.get('/home', async (req, res) => {
    try {
        // Ambil 4 jenis data secara paralel agar cepat
        let [recents, popular, manhwa, doujinshi] = await Promise.all([
            // 1. Terbaru (Update Terakhir)
            Manga.find().select('title slug thumb metadata updatedAt').sort({ updatedAt: -1 }).limit(12).lean(),
            
            // 2. Populer (Berdasarkan Views)
            Manga.find().select('title slug thumb views metadata').sort({ views: -1 }).limit(10).lean(),
            
            // 3. Manhwa (Komik Korea)
            Manga.find({ 
                $or: [
                    { 'metadata.type': { $regex: 'manhwa', $options: 'i' } },
                    { 'tags': { $in: ['Manhwa'] } }
                ]
            }).select('title slug thumb metadata').sort({ updatedAt: -1 }).limit(8).lean(),
            
            // 4. Doujinshi
            Manga.find({ 
                $or: [
                    { 'metadata.type': { $regex: 'doujinshi', $options: 'i' } },
                    { 'tags': { $in: ['Doujinshi'] } }
                ]
            }).select('title slug thumb metadata').sort({ updatedAt: -1 }).limit(8).lean()
        ]);

        // Pasang Chapter Terbaru ke semua list
        recents = await attachLatestChapter(recents);
        manhwa = await attachLatestChapter(manhwa);
        doujinshi = await attachLatestChapter(doujinshi);
        popular = await attachLatestChapter(popular); 

        res.json({
            success: true,
            data: {
                recents,
                popular,
                manhwa,
                doujinshi
            }
        });
    } catch (err) {
        console.error("API Home Error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ==========================================
// 5. ENDPOINT: LIST GENRE
// ==========================================
router.get('/genres', async (req, res) => {
    try {
        // Ambil semua tags unik dari database
        const genres = await Manga.distinct('tags');
        // Bersihkan data kosong & urutkan abjad
        const cleanGenres = genres.filter(g => g).sort();
        
        res.json({
            success: true,
            data: cleanGenres
        });
    } catch (err) {
        console.error("API Genre Error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
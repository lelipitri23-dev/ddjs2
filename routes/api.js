const express = require('express');
const router = express.Router();
const Manga = require('../models/Manga');
const Chapter = require('../models/Chapter');

// 1. LIST MANGA (Filter, Search, Page)
router.get('/manga', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 24;
        const skip = (page - 1) * limit;
        
        let query = {};
        const { q, status, type, genre } = req.query;

        if (q) query.title = { $regex: q, $options: 'i' };
        if (status && status !== 'all') query['metadata.status'] = { $regex: status, $options: 'i' };
        
        if (type && type !== 'all') {
            query.$or = [
                { 'metadata.type': { $regex: type, $options: 'i' } },
                { 'metadata.type.type': { $regex: type, $options: 'i' } }
            ];
        }

        if (genre) {
            query.tags = { $regex: genre, $options: 'i' };
        }

        const mangas = await Manga.find(query)
            .select('title slug thumb metadata views tags updatedAt')
            .sort({ updatedAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        res.json({
            success: true,
            page: page,
            data: mangas
        });

    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ==========================================
// 2. ENDPOINT: DETAIL MANGA (+ Recommendations)
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
            { $project: { title: 1, slug: 1, thumb: 1, metadata: 1, views: 1 } } // Ambil field penting saja
        ]);

        // (Opsional) Pasang chapter terbaru ke rekomendasi agar card terlihat lengkap
        // Pastikan fungsi attachLatestChapter ada di scope atas (lihat kode api.js sebelumnya)
        if (typeof attachLatestChapter === 'function') {
             recommendations = await attachLatestChapter(recommendations);
        }

        res.json({
            success: true,
            data: {
                ...manga,
                chapters: chapters,       // Chapter list
                recommendations: recommendations // <--- Data baru ini dikirim ke frontend
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 3. READ CHAPTER (Images & Navigation)
router.get('/read/:slug/:chapterSlug', async (req, res) => {
    try {
        const { slug, chapterSlug } = req.params;

        const manga = await Manga.findOne({ slug })
            .select('_id title slug thumb author')
            .lean();

        if (!manga) {
            return res.status(404).json({ success: false, message: 'Manga not found' });
        }

        const chapter = await Chapter.findOne({
            manga_id: manga._id,
            slug: chapterSlug
        }).lean();

        if (!chapter) {
            return res.status(404).json({ success: false, message: 'Chapter not found' });
        }

        const [nextChap, prevChap] = await Promise.all([
            Chapter.findOne({
                manga_id: manga._id,
                chapter_index: { $gt: chapter.chapter_index }
            }).select('slug title chapter_index').sort({ chapter_index: 1 }).lean(),

            Chapter.findOne({
                manga_id: manga._id,
                chapter_index: { $lt: chapter.chapter_index }
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
                content: chapter.content || null, 
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
        res.status(500).json({ success: false, message: 'Terjadi kesalahan server saat memuat chapter.' });
    }
});

// 4. HOME DATA
router.get('/home', async (req, res) => {
    try {
        const [recents, popular, manhwa, doujinshi] = await Promise.all([
            Manga.find().select('title slug thumb metadata updatedAt').sort({ updatedAt: -1 }).limit(10).lean(),
            Manga.find().select('title slug thumb views').sort({ views: -1 }).limit(10).lean(),
            Manga.find({ 'metadata.type': { $regex: 'manhwa', $options: 'i' } }).select('title slug thumb').sort({ updatedAt: -1 }).limit(10).lean(),
            Manga.find({ 'metadata.type': { $regex: 'doujinshi', $options: 'i' } }).select('title slug thumb').sort({ updatedAt: -1 }).limit(10).lean()
        ]);

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
        res.status(500).json({ success: false, message: err.message });
    }
});

// 5. LIST GENRES
router.get('/genres', async (req, res) => {
    try {
        const genres = await Manga.distinct('tags');
        const cleanGenres = genres.filter(g => g).sort();
        
        res.json({
            success: true,
            data: cleanGenres
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
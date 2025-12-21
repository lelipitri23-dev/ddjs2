const express = require('express');
const router = express.Router();
const Manga = require('../models/Manga');
const Chapter = require('../models/Chapter');

// ==========================================
// HELPER FUNCTIONS
// ==========================================

// Standard Response Format
const successResponse = (res, data, pagination = null) => {
    res.json({
        success: true,
        data,
        pagination
    });
};

const errorResponse = (res, message, code = 500) => {
    console.error(`[Error] ${message}`); // Log error ke console server untuk debugging
    res.status(code).json({ success: false, message });
};

// Helper: Kalkulasi Pagination
const getPaginationParams = (req, defaultLimit = 24) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || defaultLimit);
    const skip = (page - 1) * limit;
    return { page, limit, skip };
};

// Helper: Optimized Chapter Count (Mencegah N+1 Query Problem)
async function attachChapterCounts(mangas) {
    if (!mangas || mangas.length === 0) return [];

    // 1. Ambil semua ID manga dari list
    const mangaIds = mangas.map(m => m._id);

    // 2. Lakukan 1 kali query Aggregate ke collection Chapter
    const counts = await Chapter.aggregate([
        { $match: { manga_id: { $in: mangaIds } } },
        { $group: { _id: "$manga_id", count: { $sum: 1 } } }
    ]);

    // 3. Buat Map untuk akses cepat (Dictionary)
    const countMap = {};
    counts.forEach(c => {
        countMap[c._id.toString()] = c.count;
    });

    // 4. Gabungkan data
    // Kita asumsikan input 'mangas' sudah berupa Plain Object (karena pakai .lean())
    return mangas.map(m => ({
        ...m,
        chapter_count: countMap[m._id.toString()] || 0
    }));
}

// ==========================================
// 1. HOME & LISTING ENDPOINTS
// ==========================================

// GET /api/home 
router.get('/home', async (req, res) => {
    try {
        const { page, limit, skip } = getPaginationParams(req);

        // Jalankan Query Count Total terpisah agar tidak blocking
        const totalMangaPromise = Manga.countDocuments();

        // Query 1: Recents (UPDATED: Gunakan updatedAt agar chapter baru naik ke atas)
        const recentsPromise = Manga.find()
            // Tambahkan 'updatedAt' agar bisa dicek frontend
            .select('title slug thumb metadata createdAt updatedAt') 
            // GANTI: Sort berdasarkan waktu update terakhir (Chapter baru = Atas)
            .sort({ updatedAt: -1 }) 
            .skip(skip)
            .limit(limit)
            .lean(); 

        // Query 2: Trending (Top Views) - Tetap sort by views
        const trendingPromise = Manga.find()
            .select('title slug thumb views metadata')
            .sort({ views: -1 })
            .limit(10)
            .lean();

        // Query 3: Manhwa (UPDATED: Sort by updatedAt juga)
        const manhwasPromise = Manga.find({ 'metadata.type': { $regex: 'manhwa', $options: 'i' } })
            .select('title slug thumb metadata updatedAt')
            // GANTI: Manhwa yang update chapter baru naik ke atas
            .sort({ updatedAt: -1 }) 
            .limit(10)
            .lean();

        // EKSEKUSI PARALEL (Kecepatan meningkat drastis)
        const [totalManga, recentsRaw, trendingRaw, manhwasRaw] = await Promise.all([
            totalMangaPromise,
            recentsPromise,
            trendingPromise,
            manhwasPromise
        ]);

        // Attach chapter counts secara paralel juga
        const [recents, trending, manhwas] = await Promise.all([
            attachChapterCounts(recentsRaw),
            attachChapterCounts(trendingRaw),
            attachChapterCounts(manhwasRaw)
        ]);

        successResponse(res, { 
            recents, 
            trending,
            manhwas 
        }, {
            currentPage: page,
            totalPages: Math.ceil(totalManga / limit),
            totalItems: totalManga,
            perPage: limit
        });

    } catch (err) {
        errorResponse(res, err.message);
    }
});

// GET /api/manga-list
router.get('/manga-list', async (req, res) => {
    try {
        const { page, limit, skip } = getPaginationParams(req);

        const [total, mangasRaw] = await Promise.all([
            Manga.countDocuments(),
            Manga.find()
                .select('title slug thumb metadata.rating metadata.status metadata.type')
                .sort({ title: 1 }) // A-Z
                .skip(skip)
                .limit(limit)
                .lean()
        ]);
        
        const mangas = await attachChapterCounts(mangasRaw);

        successResponse(res, mangas, {
            currentPage: page,
            totalPages: Math.ceil(total / limit),
            totalItems: total,
            perPage: limit
        });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// ==========================================
// 2. DETAIL & READ ENDPOINTS
// ==========================================

// GET /api/manga/:slug
router.get('/manga/:slug', async (req, res) => {
    try {
        // Cari dan update view sekalian ambil datanya
        const manga = await Manga.findOneAndUpdate(
            { slug: req.params.slug },
            { $inc: { views: 1 } },
            { 
                new: true, 
                timestamps: false // <--- TAMBAHKAN INI (Agar manga tidak loncat ke atas saat diklik)
            }
        ).lean();

        if (!manga) return errorResponse(res, 'Manga not found', 404);

        const chapters = await Chapter.find({ manga_id: manga._id })
            .select('title slug chapter_index createdAt')
            // Gunakan -1 untuk Descending (Chapter Terbesar/Terbaru paling atas)
            .sort({ chapter_index: -1 }) 
            // PENTING: Tambahkan collation agar sorting angka akurat
            .collation({ locale: "en_US", numericOrdering: true })
            .lean();

        // Gabungkan manual karena sudah .lean()
        manga.chapter_count = chapters.length;

        successResponse(res, { info: manga, chapters });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// GET /api/read/:slug/:chapterSlug
router.get('/read/:slug/:chapterSlug', async (req, res) => {
    try {
        const manga = await Manga.findOne({ slug: req.params.slug })
            .select('_id title slug thumb')
            .lean();
            
        if (!manga) return errorResponse(res, 'Manga not found', 404);

        const chapter = await Chapter.findOne({ 
            manga_id: manga._id, 
            slug: req.params.chapterSlug 
        }).lean();

        if (!chapter) return errorResponse(res, 'Chapter not found', 404);

        // Navigasi Smart: Menggunakan $gt dan $lt untuk mencari chapter tetangga
        // Ini menangani kasus jika index loncat (misal ch 1, lalu ch 1.5, lalu ch 2)
        const [nextChap, prevChap] = await Promise.all([
            Chapter.findOne({ 
                manga_id: manga._id, 
                chapter_index: { $gt: chapter.chapter_index } 
            }).sort({ chapter_index: 1 }).select('slug title').lean(),
            
            Chapter.findOne({ 
                manga_id: manga._id, 
                chapter_index: { $lt: chapter.chapter_index } 
            }).sort({ chapter_index: -1 }).select('slug title').lean()
        ]);

        successResponse(res, { 
            chapter, 
            manga, 
            navigation: {
                next: nextChap ? nextChap.slug : null,
                prev: prevChap ? prevChap.slug : null
            }
        });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// ==========================================
// 3. SEARCH & FILTERS
// ==========================================

// GET /api/search?q=keyword
router.get('/search', async (req, res) => {
    try {
        const keyword = req.query.q;
        if (!keyword) return errorResponse(res, 'Query parameter "q" required', 400);

        const { page, limit, skip } = getPaginationParams(req);
        const query = { title: { $regex: keyword, $options: 'i' } };

        const [total, mangasRaw] = await Promise.all([
            Manga.countDocuments(query),
            Manga.find(query)
                .select('title slug thumb metadata')
                .skip(skip)
                .limit(limit)
                .lean()
        ]);

        const mangas = await attachChapterCounts(mangasRaw);

        successResponse(res, mangas, {
            currentPage: page,
            totalPages: Math.ceil(total / limit),
            totalItems: total,
            perPage: limit
        });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// GET /api/genres
router.get('/genres', async (req, res) => {
    try {
        // Ambil genre unik dari semua manga
        const genres = await Manga.aggregate([
            { $unwind: "$tags" }, // Pecah array tags menjadi dokumen terpisah
            // Filter tags kosong jika ada
            { $match: { tags: { $ne: "" } } }, 
            { $group: { _id: "$tags", count: { $sum: 1 } } },
            { $sort: { _id: 1 } }
        ]);
        
        // Format output agar lebih bersih: [{name: "Action", count: 10}, ...]
        const formattedGenres = genres.map(g => ({ name: g._id, count: g.count }));
        
        successResponse(res, formattedGenres);
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// GET /api/filter/:type/:value
router.get('/filter/:type/:value', async (req, res) => {
    try {
        const { type, value } = req.params;
        const { page, limit, skip } = getPaginationParams(req);

        let query = {};

        if (type === 'genre') {
            // Perbaikan regex untuk menangani spasi atau dash
            // misal: 'action-adventure' bisa match 'Action Adventure'
            const cleanValue = value.replace(/-/g, '[\\s\\-]'); 
            query = { tags: { $regex: new RegExp(cleanValue, 'i') } };
        } else if (type === 'status') {
            query = { 'metadata.status': { $regex: `^${value}$`, $options: 'i' } };
        } else if (type === 'type') {
            // Perbaikan path: biasanya metadata.type langsung string, bukan object
            query = { 'metadata.type': { $regex: `^${value}$`, $options: 'i' } };
        } else {
            return errorResponse(res, 'Invalid filter type. Use: genre, status, or type.', 400);
        }

        const [total, mangasRaw] = await Promise.all([
            Manga.countDocuments(query),
            Manga.find(query)
                .select('title slug thumb metadata')
                .skip(skip)
                .limit(limit)
                .lean()
        ]);

        const mangas = await attachChapterCounts(mangasRaw);

        successResponse(res, mangas, {
            currentPage: page,
            totalPages: Math.ceil(total / limit),
            totalItems: total,
            filter: { type, value },
            perPage: limit
        });

    } catch (err) {
        errorResponse(res, err.message);
    }
});

module.exports = router;

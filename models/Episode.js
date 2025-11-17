// models/Episode.js
const mongoose = require('mongoose');

const episodeSchema = new mongoose.Schema({
  episodeSlug: { type: String, unique: true, required: true, index: true },
  title: String,
  streaming: [{ name: String, url: String }],
  downloads: [{
    quality: String,
    links: [{ host: String, url: String }]
  }],
  // Info Anime Induk
  animeTitle: String,
  animeSlug: String,
  animeImageUrl: String,
  // --- BARU ---
  thumbnailUrl: String // Untuk menyimpan URL thumbnail episode
  // -----------
}, { timestamps: true });

module.exports = mongoose.model('Episode', episodeSchema);
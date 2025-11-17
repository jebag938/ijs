const mongoose = require('mongoose');

const animeSchema = new mongoose.Schema({
  title: String,
  pageSlug: { type: String, unique: true, required: true, index: true },
  imageUrl: String,
  synopsis: String,
  info: Object, // Stores Status, Studio, Released, Type, Producers, etc.
  genres: [String],
  episodes: [{
    title: String, // Full episode title
    url: String,   // Episode Slug
    date: String,
  }],
  alternativeTitle: String,
  characters: [{
    name: String,
    role: String,
    imageUrl: String
  }],
  viewCount: {
    type: Number,
    default: 0, // Mulai dari 0
    index: true // Buat index agar sorting lebih cepat
  }
}, { timestamps: true });

module.exports = mongoose.model('Anime', animeSchema);
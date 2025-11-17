const mongoose = require('mongoose');

const bookmarkSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  animeRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Anime', required: true }
}, { timestamps: true });

bookmarkSchema.index({ userId: 1, animeRef: 1 }, { unique: true });

module.exports = mongoose.model('Bookmark', bookmarkSchema);
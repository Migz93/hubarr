import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { generateCollectionPoster } from "../../src/server/collection-artwork.js";

test("generateCollectionPoster creates a Plex poster-sized JPEG", async () => {
  const poster = await generateCollectionPoster({
    collectionName: "Alexs Watchlist",
    mediaType: "movie"
  });
  const metadata = await sharp(poster).metadata();

  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 1000);
  assert.equal(metadata.height, 1500);
  assert.ok(poster.byteLength > 10_000);
});

test("generateCollectionPoster creates different artwork for movies and shows", async () => {
  const moviePoster = await generateCollectionPoster({
    collectionName: "Alexs Watchlist",
    mediaType: "movie"
  });
  const showPoster = await generateCollectionPoster({
    collectionName: "Alexs Watchlist",
    mediaType: "show"
  });

  assert.notEqual(moviePoster.toString("base64"), showPoster.toString("base64"));
});

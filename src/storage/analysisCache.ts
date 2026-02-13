/**
 * IndexedDB-based cache for track analysis results.
 * Uses the `idb` library for a cleaner promise-based API.
 *
 * Schema:
 *   Database: "ytdj"
 *   Object Store: "analyses" (key: videoId)
 *
 * Typical record size for a 5-minute track:
 *   - beats array (~500 entries): ~2 KB
 *   - downbeats array (~125 entries): ~0.5 KB
 *   - waveform peaks (at 200 samples/sec = 60k floats): ~240 KB
 *   - Total per track: ~250 KB
 *
 * With IndexedDB's generous quota (typically 50%+ of disk),
 * this can store thousands of tracks.
 */

import { openDB, IDBPDatabase } from 'idb';
import { TrackAnalysis, TrackAnalysisSerialized } from '../types';

const DB_NAME = 'ytdj';
const DB_VERSION = 1;
const STORE_NAME = 'analyses';

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'videoId' });
        }
      },
    });
  }
  return dbPromise;
}

/** Serialize TrackAnalysis for storage (Float32Array -> number[]) */
function serialize(analysis: TrackAnalysis): TrackAnalysisSerialized {
  return {
    videoId: analysis.videoId,
    title: analysis.title,
    bpm: analysis.bpm,
    bpmConfidence: analysis.bpmConfidence,
    beats: analysis.beats,
    downbeats: analysis.downbeats,
    duration: analysis.duration,
    waveformPeaks: Array.from(analysis.waveformPeaks),
    analyzedAt: analysis.analyzedAt,
  };
}

/** Deserialize stored data back to TrackAnalysis */
function deserialize(data: TrackAnalysisSerialized): TrackAnalysis {
  return {
    ...data,
    waveformPeaks: new Float32Array(data.waveformPeaks),
  };
}

/** Get cached analysis for a video, or null if not cached */
export async function getCachedAnalysis(videoId: string): Promise<TrackAnalysis | null> {
  const db = await getDb();
  const data = await db.get(STORE_NAME, videoId) as TrackAnalysisSerialized | undefined;
  if (!data) return null;
  return deserialize(data);
}

/** Store a track analysis in the cache */
export async function cacheAnalysis(analysis: TrackAnalysis): Promise<void> {
  const db = await getDb();
  await db.put(STORE_NAME, serialize(analysis));
}

/** Delete cached analysis for a video */
export async function deleteCachedAnalysis(videoId: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_NAME, videoId);
}

/** Get all cached video IDs */
export async function getAllCachedIds(): Promise<string[]> {
  const db = await getDb();
  return db.getAllKeys(STORE_NAME) as Promise<string[]>;
}

/** Clear entire cache */
export async function clearCache(): Promise<void> {
  const db = await getDb();
  await db.clear(STORE_NAME);
}

/** Get cache size (number of stored analyses) */
export async function getCacheSize(): Promise<number> {
  const db = await getDb();
  return db.count(STORE_NAME);
}

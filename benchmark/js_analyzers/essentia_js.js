/**
 * Essentia.js WASM beat detection analyzer.
 *
 * Uses essentia.js running in Node.js via WASM.
 * This tests the same library that would run in the Chrome extension's offscreen document.
 */

import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

export async function analyze(audioData, sampleRate) {
  try {
    // Use CommonJS require for essentia.js (it uses __dirname internally)
    const EssentiaWASM = require('essentia.js/dist/essentia-wasm.umd.js');
    const EssentiaCore = require('essentia.js/dist/essentia.js-core.js');
    const Essentia = EssentiaCore.default || EssentiaCore;

    // Initialize WASM
    let wasmInstance;
    if (typeof EssentiaWASMModule === 'function') {
      wasmInstance = await EssentiaWASMModule();
    } else if (EssentiaWASMModule.EssentiaWASM) {
      wasmInstance = await EssentiaWASMModule.EssentiaWASM();
    } else {
      wasmInstance = EssentiaWASMModule;
    }

    const essentia = new Essentia(wasmInstance);

    // Convert audio to essentia vector
    const vecAudio = essentia.arrayToVector(audioData);

    // Try RhythmExtractor2013 first (most complete)
    let bpm = null;
    let beats = [];
    let confidence = null;

    try {
      const rhythm = essentia.RhythmExtractor2013(vecAudio);
      bpm = rhythm.bpm;
      confidence = rhythm.confidence;
      // Convert beat ticks vector to array
      const ticksVec = rhythm.ticks;
      if (ticksVec && ticksVec.size) {
        for (let i = 0; i < ticksVec.size(); i++) {
          beats.push(ticksVec.get(i));
        }
      }
    } catch (e) {
      // Fallback to PercivalBpmEstimator
      try {
        const result = essentia.PercivalBpmEstimator(vecAudio);
        bpm = result.bpm;
      } catch (e2) {
        // Last resort: manual tempo estimation
      }
    }

    // Estimate downbeats (every 4th beat)
    const downbeats = beats.filter((_, i) => i % 4 === 0);

    // Clean up
    vecAudio.delete();

    return {
      analyzer_name: 'essentia_js',
      bpm,
      bpm_confidence: confidence,
      beats,
      downbeats,
      phrase_boundaries: [],
      metadata: {
        runtime: 'node_wasm',
        method: beats.length > 0 ? 'RhythmExtractor2013' : 'PercivalBpmEstimator',
      },
    };
  } catch (err) {
    // If WASM loading fails entirely, return error result
    return {
      analyzer_name: 'essentia_js',
      bpm: null,
      bpm_confidence: null,
      beats: [],
      downbeats: [],
      phrase_boundaries: [],
      metadata: {
        error: `WASM init failed: ${err.message}`,
        note: 'essentia.js WASM may not fully support Node.js — works best in browser',
      },
    };
  }
}

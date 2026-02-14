/**
 * Common Node.js entry point for JS benchmark analyzers.
 *
 * Usage: node run_analyzer.js <analyzer_script> <audio_path> <sample_rate>
 *
 * Each analyzer script exports:
 *   export async function analyze(audioData: Float32Array, sampleRate: number): AnalyzerResult
 *
 * Output: JSON AnalyzerResult to stdout.
 */

import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { resolve } from 'path';

const [,, analyzerPath, audioPath, srStr] = process.argv;

if (!analyzerPath || !audioPath) {
  console.error('Usage: node run_analyzer.js <analyzer.js> <audio.wav> [sample_rate]');
  process.exit(1);
}

const sampleRate = parseInt(srStr || '44100', 10);

/**
 * Decode a WAV file to Float32Array (mono).
 * Supports 16-bit and 32-bit float PCM WAV files.
 */
function decodeWav(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // Parse WAV header
  const numChannels = view.getUint16(22, true);
  const fileSampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);

  // Find data chunk
  let offset = 12;
  while (offset < buffer.length - 8) {
    const chunkId = String.fromCharCode(
      buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]
    );
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === 'data') {
      offset += 8;
      break;
    }
    offset += 8 + chunkSize;
  }

  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.floor((buffer.length - offset) / (bytesPerSample * numChannels));
  const mono = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    let sample = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const pos = offset + (i * numChannels + ch) * bytesPerSample;
      if (bitsPerSample === 16) {
        sample += view.getInt16(pos, true) / 32768;
      } else if (bitsPerSample === 32) {
        sample += view.getFloat32(pos, true);
      } else if (bitsPerSample === 24) {
        const b0 = buffer[pos];
        const b1 = buffer[pos + 1];
        const b2 = buffer[pos + 2];
        let val = (b2 << 16) | (b1 << 8) | b0;
        if (val >= 0x800000) val -= 0x1000000;
        sample += val / 8388608;
      }
    }
    mono[i] = sample / numChannels;
  }

  return { audioData: mono, sampleRate: fileSampleRate };
}

async function main() {
  try {
    // Load audio
    const wavBuffer = readFileSync(audioPath);
    const { audioData } = decodeWav(wavBuffer);

    // Load analyzer module
    const fullPath = resolve(analyzerPath);
    const analyzerModule = await import(pathToFileURL(fullPath).href);

    if (typeof analyzerModule.analyze !== 'function') {
      throw new Error(`Analyzer ${analyzerPath} does not export an analyze() function`);
    }

    // Run analysis
    const t0 = performance.now();
    const result = await analyzerModule.analyze(audioData, sampleRate);
    const elapsed = performance.now() - t0;

    // Ensure required fields
    const output = {
      analyzer_name: result.analyzer_name || analyzerPath.replace(/\.js$/, ''),
      bpm: result.bpm ?? null,
      bpm_confidence: result.bpm_confidence ?? null,
      beats: result.beats || [],
      downbeats: result.downbeats || [],
      phrase_boundaries: result.phrase_boundaries || [],
      processing_time_ms: elapsed,
      metadata: result.metadata || {},
    };

    console.log(JSON.stringify(output));
  } catch (err) {
    console.log(JSON.stringify({
      analyzer_name: analyzerPath,
      bpm: null,
      bpm_confidence: null,
      beats: [],
      downbeats: [],
      phrase_boundaries: [],
      processing_time_ms: 0,
      metadata: { error: err.message },
    }));
    process.exit(0); // Still exit 0 so runner doesn't treat as crash
  }
}

main();

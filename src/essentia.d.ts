declare module 'essentia.js' {
  export class Essentia {
    constructor(wasmModule: any);
    RhythmExtractor2013(signal: Float32Array): {
      bpm: number;
      ticks: Float32Array;
      confidence: number;
      estimates: Float32Array;
      bpmIntervals: Float32Array;
    };
    arrayToVector(arr: Float32Array): any;
    vectorToArray(vec: any): Float32Array;
  }
  export function EssentiaWASM(): Promise<any>;
}

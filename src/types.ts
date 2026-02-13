/** Represents a single beat in a track's beat grid */
export interface Beat {
  /** Time in seconds from track start */
  time: number;
  /** Beat strength/confidence (0-1) */
  confidence: number;
}

/** Full analysis result for a track */
export interface TrackAnalysis {
  videoId: string;
  title: string;
  /** Beats per minute */
  bpm: number;
  /** BPM confidence (0-1) */
  bpmConfidence: number;
  /** Array of beat positions in seconds */
  beats: number[];
  /** Array of downbeat positions (first beat of each bar) in seconds */
  downbeats: number[];
  /** Duration in seconds */
  duration: number;
  /** Waveform peak data for visualization */
  waveformPeaks: Float32Array;
  /** Timestamp when analysis was performed */
  analyzedAt: number;
}

/** Serializable version of TrackAnalysis for storage */
export interface TrackAnalysisSerialized {
  videoId: string;
  title: string;
  bpm: number;
  bpmConfidence: number;
  beats: number[];
  downbeats: number[];
  duration: number;
  waveformPeaks: number[];
  analyzedAt: number;
}

/** State of a single deck */
export interface DeckState {
  /** Which deck (A or B) */
  id: 'A' | 'B';
  /** YouTube video ID loaded on this deck */
  videoId: string | null;
  /** Chrome tab ID for the YouTube tab */
  tabId: number | null;
  /** Current playback state */
  playing: boolean;
  /** Current time in seconds */
  currentTime: number;
  /** Playback rate (1.0 = normal) */
  playbackRate: number;
  /** Volume (0-1) */
  volume: number;
  /** Track analysis, if available */
  analysis: TrackAnalysis | null;
  /** Current beat index in the beat grid */
  currentBeatIndex: number;
  /** Whether this deck is the "master" for sync */
  isMaster: boolean;
}

/** Sync mode options */
export type SyncMode = 'off' | 'tempo' | 'beatSync';

/** Quantize options for sync alignment */
export type QuantizeMode = 'beat' | 'bar' | 'phrase';

/** Overall sync state */
export interface SyncState {
  mode: SyncMode;
  quantize: QuantizeMode;
  /** Phase offset in seconds between the two decks */
  phaseOffset: number;
  /** Whether drift correction is active */
  driftCorrection: boolean;
}

/** Cue point on a track */
export interface CuePoint {
  /** Position in seconds */
  time: number;
  /** Label for this cue */
  label: string;
  /** Color for visual display */
  color: string;
}

// ---- Message Protocol ----

/** Messages from controller to background */
export type ControllerMessage =
  | { type: 'LOAD_TRACK'; deck: 'A' | 'B'; videoId: string; url: string }
  | { type: 'PLAY'; deck: 'A' | 'B' }
  | { type: 'PAUSE'; deck: 'A' | 'B' }
  | { type: 'SEEK'; deck: 'A' | 'B'; time: number }
  | { type: 'SET_RATE'; deck: 'A' | 'B'; rate: number }
  | { type: 'SET_VOLUME'; deck: 'A' | 'B'; volume: number }
  | { type: 'SYNC'; deck: 'A' | 'B' }
  | { type: 'SET_SYNC_MODE'; mode: SyncMode }
  | { type: 'SET_CUE'; deck: 'A' | 'B'; cue: CuePoint }
  | { type: 'GET_STATE' }
  | { type: 'ANALYZE_TRACK'; deck: 'A' | 'B' }
  | { type: 'NUDGE'; deck: 'A' | 'B'; direction: 'forward' | 'backward'; amount: number };

/** Messages from background to controller */
export type BackgroundMessage =
  | { type: 'STATE_UPDATE'; deckA: DeckState; deckB: DeckState; sync: SyncState }
  | { type: 'ANALYSIS_PROGRESS'; deck: 'A' | 'B'; progress: number }
  | { type: 'ANALYSIS_COMPLETE'; deck: 'A' | 'B'; analysis: TrackAnalysis }
  | { type: 'ANALYSIS_ERROR'; deck: 'A' | 'B'; error: string }
  | { type: 'ERROR'; message: string };

/** Messages from background to content script */
export type ContentMessage =
  | { type: 'CAPTURE_AUDIO' }
  | { type: 'STOP_CAPTURE' }
  | { type: 'GET_PLAYER_STATE' }
  | { type: 'PLAYER_COMMAND'; command: 'play' | 'pause'; }
  | { type: 'PLAYER_SEEK'; time: number }
  | { type: 'PLAYER_SET_RATE'; rate: number }
  | { type: 'PLAYER_SET_VOLUME'; volume: number };

/** Messages from content script back to background */
export type ContentResponse =
  | { type: 'AUDIO_DATA'; data: Float32Array }
  | { type: 'PLAYER_STATE'; videoId: string; title: string; currentTime: number; duration: number; playing: boolean; playbackRate: number; volume: number }
  | { type: 'PLAYER_EVENT'; event: 'playing' | 'paused' | 'ended' | 'buffering' | 'seeked' }
  | { type: 'ERROR'; message: string }
  | { type: 'CONTENT_READY' };

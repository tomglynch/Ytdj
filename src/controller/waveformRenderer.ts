/**
 * Canvas-based waveform renderer for the DJ controller.
 *
 * Renders a scrolling waveform display centered on the current playhead position,
 * with beat markers and downbeat markers overlaid.
 *
 * Design inspired by djay Pro / Traktor's scrolling waveform view.
 */

export interface WaveformRendererOptions {
  /** Waveform color */
  color: string;
  /** Beat marker color */
  beatColor: string;
  /** Downbeat marker color */
  downbeatColor: string;
  /** Seconds of audio visible on screen */
  visibleDuration?: number;
  /** Peaks per second in the waveform data */
  peaksPerSecond?: number;
}

const DEFAULT_OPTIONS: Required<WaveformRendererOptions> = {
  color: '#00aaff',
  beatColor: 'rgba(255, 255, 255, 0.3)',
  downbeatColor: 'rgba(255, 255, 255, 0.6)',
  visibleDuration: 16,
  peaksPerSecond: 200,
};

export class WaveformRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private options: Required<WaveformRendererOptions>;

  private peaks: Float32Array | null = null;
  private beats: number[] = [];
  private downbeats: number[] = [];
  private duration: number = 0;
  private playheadTime: number = 0;

  constructor(canvas: HTMLCanvasElement, options: Partial<WaveformRendererOptions> = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.resize();
  }

  /** Update canvas size to match container */
  resize() {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (rect) {
      this.canvas.width = rect.width * window.devicePixelRatio;
      this.canvas.height = rect.height * window.devicePixelRatio;
      this.canvas.style.width = `${rect.width}px`;
      this.canvas.style.height = `${rect.height}px`;
    }
  }

  /** Set the waveform data */
  setData(peaks: Float32Array, beats: number[], downbeats: number[], duration: number) {
    this.peaks = peaks;
    this.beats = beats;
    this.downbeats = downbeats;
    this.duration = duration;
  }

  /** Set current playhead position */
  setPlayhead(time: number) {
    this.playheadTime = time;
  }

  /** Render the waveform */
  render() {
    const { ctx, canvas, options, peaks, playheadTime } = this;
    const { width, height } = canvas;

    // Clear
    ctx.clearRect(0, 0, width, height);

    if (!peaks || peaks.length === 0) {
      this.renderEmpty();
      return;
    }

    const { visibleDuration, peaksPerSecond, color, beatColor, downbeatColor } = options;

    // Calculate visible time range (centered on playhead)
    const halfVisible = visibleDuration / 2;
    const startTime = playheadTime - halfVisible;
    const endTime = playheadTime + halfVisible;

    // Pixels per second
    const pxPerSecond = width / visibleDuration;

    // Draw background gradient (darker at edges)
    const grad = ctx.createLinearGradient(0, 0, width, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0.3)');
    grad.addColorStop(0.5, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.3)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // Draw beat markers
    this.renderBeatMarkers(startTime, endTime, pxPerSecond, beatColor, downbeatColor, height);

    // Draw waveform
    this.renderWaveform(startTime, endTime, pxPerSecond, peaksPerSecond, color, width, height);
  }

  private renderEmpty() {
    const { ctx, canvas } = this;
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.font = `${14 * window.devicePixelRatio}px -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('No waveform data', canvas.width / 2, canvas.height / 2);
  }

  private renderBeatMarkers(
    startTime: number,
    endTime: number,
    pxPerSecond: number,
    beatColor: string,
    downbeatColor: string,
    height: number
  ) {
    const { ctx, beats, downbeats } = this;

    // Regular beats (thin lines)
    ctx.strokeStyle = beatColor;
    ctx.lineWidth = 1;
    for (const beatTime of beats) {
      if (beatTime < startTime || beatTime > endTime) continue;
      const x = (beatTime - startTime) * pxPerSecond;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    // Downbeats (thicker lines)
    ctx.strokeStyle = downbeatColor;
    ctx.lineWidth = 2;
    for (const dbTime of downbeats) {
      if (dbTime < startTime || dbTime > endTime) continue;
      const x = (dbTime - startTime) * pxPerSecond;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }

  private renderWaveform(
    startTime: number,
    endTime: number,
    pxPerSecond: number,
    peaksPerSecond: number,
    color: string,
    width: number,
    height: number
  ) {
    const { ctx, peaks } = this;
    if (!peaks) return;

    const centerY = height / 2;

    // Convert time range to peak indices
    const startPeak = Math.max(0, Math.floor(startTime * peaksPerSecond));
    const endPeak = Math.min(peaks.length - 1, Math.ceil(endTime * peaksPerSecond));

    // Create gradient for waveform
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, color);
    grad.addColorStop(0.5, color + '88');
    grad.addColorStop(1, color);

    ctx.fillStyle = grad;

    // Draw mirrored waveform bars
    const peakWidth = pxPerSecond / peaksPerSecond;

    for (let i = startPeak; i <= endPeak; i++) {
      const peakTime = i / peaksPerSecond;
      const x = (peakTime - startTime) * pxPerSecond;
      const amplitude = peaks[i] * centerY * 0.9; // 90% of half-height

      // Draw mirrored bar
      ctx.fillRect(
        x - peakWidth / 2,
        centerY - amplitude,
        Math.max(1, peakWidth - 0.5),
        amplitude * 2
      );
    }

    // Draw center line (playhead reference)
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(width, centerY);
    ctx.stroke();
  }
}

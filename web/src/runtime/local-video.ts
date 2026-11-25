/**
 * Local-file decoding for formats the browser's HTMLMediaElement cannot open.
 * Mediabunny demuxes the selected File and HEVC.js supplies a WebAssembly
 * decoder where WebCodecs does not support the HEVC profile. Video bytes stay
 * in this browser tab; only decoder modules and WASM assets are fetched.
 */

type DecodedSample = {
  readonly timestamp: number;
  readonly duration: number;
  draw(context: CanvasRenderingContext2D, dx: number, dy: number): void;
  close(): void;
};

type VideoTrack = {
  canDecode(): Promise<boolean>;
  getDisplayWidth(): Promise<number>;
  getDisplayHeight(): Promise<number>;
  getFirstTimestamp(): Promise<number>;
  computeDuration(): Promise<number>;
};

type InputHandle = {
  getPrimaryVideoTrack(): Promise<VideoTrack | null>;
  dispose(): void;
};

type SampleSink = {
  getSample(timestamp: number): Promise<DecodedSample | null>;
  samples(startTimestamp?: number, endTimestamp?: number): AsyncGenerator<DecodedSample, void, unknown>;
};

type MediabunnyModule = {
  readonly ALL_FORMATS: unknown;
  readonly BlobSource: new (file: File) => unknown;
  readonly Input: new (options: { source: unknown; formats: unknown }) => InputHandle;
  readonly VideoSampleSink: new (track: VideoTrack) => SampleSink;
};

type HevcPluginModule = {
  registerHevcDecoder(options: {
    workerUrl: string;
    wasmUrl: string;
    wasmBinaryUrl: string;
  }): Promise<void>;
};

const MEDIABUNNY_MODULE_URL = "https://esm.sh/mediabunny@1.62.1";
const HEVC_PLUGIN_MODULE_URL =
  "https://esm.sh/@hevcjs/mediabunny-plugin@0.1.4?external=mediabunny";
const HEVC_WORKER_URL =
  "https://cdn.jsdelivr.net/npm/@hevcjs/mediabunny-plugin@0.1.4/dist/decode-worker.js";
const HEVC_WASM_GLUE_URL =
  "https://cdn.jsdelivr.net/npm/@hevcjs/core@1.9.1/dist/wasm/hevc-decode.js";
const HEVC_WASM_BINARY_URL =
  "https://cdn.jsdelivr.net/npm/@hevcjs/core@1.9.1/dist/wasm/hevc-decode.wasm";

let decoderRegistration: Promise<void> | null = null;

async function registerDecoder(): Promise<MediabunnyModule> {
  const mediabunny = (await import(
    /* @vite-ignore */ MEDIABUNNY_MODULE_URL
  )) as MediabunnyModule;
  decoderRegistration ??= (async () => {
    const plugin = (await import(
      /* @vite-ignore */ HEVC_PLUGIN_MODULE_URL
    )) as HevcPluginModule;
    await plugin.registerHevcDecoder({
      workerUrl: HEVC_WORKER_URL,
      wasmUrl: HEVC_WASM_GLUE_URL,
      wasmBinaryUrl: HEVC_WASM_BINARY_URL,
    });
  })();
  await decoderRegistration;
  return mediabunny;
}

/** Decodes a local File into a reusable canvas, preserving source timestamps. */
export class LocalVideoDecoder {
  readonly canvas: HTMLCanvasElement;
  readonly fps: number;
  readonly duration: number;

  private readonly input: InputHandle;
  private readonly sink: SampleSink;
  private readonly firstTimestamp: number;
  private playing = false;
  private disposed = false;
  private generation = 0;
  private position = 0;

  private constructor(
    input: InputHandle,
    sink: SampleSink,
    canvas: HTMLCanvasElement,
    firstTimestamp: number,
    fps: number,
    duration: number,
  ) {
    this.input = input;
    this.sink = sink;
    this.canvas = canvas;
    this.firstTimestamp = firstTimestamp;
    this.fps = fps;
    this.duration = duration;
  }

  get currentTime(): number {
    return this.position;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  static async open(file: File): Promise<LocalVideoDecoder> {
    const mediabunny = await registerDecoder();
    const input = new mediabunny.Input({
      source: new mediabunny.BlobSource(file),
      formats: mediabunny.ALL_FORMATS,
    });

    try {
      const track = await input.getPrimaryVideoTrack();
      if (track === null) {
        throw new Error("the selected file contains no video track");
      }
      if (!(await track.canDecode())) {
        throw new Error(
          "Mediabunny could not decode this video track. The file may use an unsupported codec or profile.",
        );
      }

      const width = Math.round(await track.getDisplayWidth());
      const height = Math.round(await track.getDisplayHeight());
      if (width < 1 || height < 1) {
        throw new Error("the video track has invalid frame dimensions");
      }

      const firstTimestamp = await track.getFirstTimestamp();
      const sink = new mediabunny.VideoSampleSink(track);
      const firstSample = await sink.getSample(firstTimestamp);
      if (firstSample === null) {
        throw new Error("the video track contains no decodable frames");
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false });
      if (context === null) {
        firstSample.close();
        throw new Error("this browser could not create a canvas for decoded frames");
      }

      const fps = firstSample.duration > 0 ? 1 / firstSample.duration : 30;
      firstSample.draw(context, 0, 0);
      firstSample.close();

      const endTimestamp = await track.computeDuration();
      const duration = Math.max(0, endTimestamp - firstTimestamp);
      return new LocalVideoDecoder(input, sink, canvas, firstTimestamp, fps, duration);
    } catch (error) {
      input.dispose();
      throw error;
    }
  }

  start(onFrame: (timestamp: number) => void, onError: (error: unknown) => void): void {
    if (this.disposed || this.playing) return;
    if (this.duration > 0 && this.position >= this.duration) this.position = 0;
    this.playing = true;
    const generation = ++this.generation;
    void this.playLoop(generation, onFrame, onError);
  }

  stop(): void {
    this.playing = false;
    this.generation += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.input.dispose();
  }

  private async playLoop(
    generation: number,
    onFrame: (timestamp: number) => void,
    onError: (error: unknown) => void,
  ): Promise<void> {
    try {
      let startPosition = this.position;
      while (this.isActive(generation)) {
        const wallStart = performance.now() - startPosition * 1000;
        let frameCount = 0;

        for await (const sample of this.sink.samples(this.firstTimestamp + startPosition)) {
          if (!this.isActive(generation)) {
            sample.close();
            return;
          }

          const timestamp = Math.max(0, sample.timestamp - this.firstTimestamp);
          const due = wallStart + timestamp * 1000;
          if (!(await this.waitUntil(due, generation))) {
            sample.close();
            return;
          }

          try {
            const context = this.canvas.getContext("2d", { alpha: false });
            if (context === null) {
              throw new Error("the decoded-frame canvas lost its 2D context");
            }
            sample.draw(context, 0, 0);
            this.position = timestamp;
            frameCount += 1;
            onFrame(timestamp);
          } finally {
            sample.close();
          }
        }

        if (frameCount === 0) {
          throw new Error("the decoder returned no video frames");
        }
        // Start the next iterator at the beginning, but keep currentTime at
        // the last displayed frame until the first new frame is drawn. This
        // prevents the detector from pairing a reset clock with the old canvas.
        startPosition = 0;
      }
    } catch (error) {
      if (this.isActive(generation)) {
        this.playing = false;
        onError(error);
      }
    }
  }

  private isActive(generation: number): boolean {
    return this.playing && !this.disposed && generation === this.generation;
  }

  private async waitUntil(target: number, generation: number): Promise<boolean> {
    while (this.isActive(generation)) {
      const remaining = target - performance.now();
      if (remaining <= 0) return true;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(remaining, 40));
      });
    }
    return false;
  }
}

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
  getFormat(): Promise<{ name: string; mimeType: string }>;
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
  "https://cdn.jsdelivr.net/npm/@hevcjs/core@1.9.1/wasm/hevc-decode.js";
const HEVC_WASM_BINARY_URL =
  "https://cdn.jsdelivr.net/npm/@hevcjs/core@1.9.1/wasm/hevc-decode.wasm";

const FFMPEG_MODULE_URL =
  "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js";
const FFMPEG_CORE_BASE_URL =
  "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
const FFMPEG_CLASS_WORKER_URL =
  "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/worker.js";

type BrowserFFmpeg = {
  load(options: { coreURL: string; wasmURL: string; classWorkerURL: string }): Promise<void>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  exec(args: string[]): Promise<number>;
  readFile(path: string): Promise<Uint8Array | string>;
  deleteFile(path: string): Promise<void>;
  on(event: "log", callback: (event: { message: string }) => void): void;
};

type BrowserFFmpegModule = { FFmpeg: new () => BrowserFFmpeg };
let ffmpegInstance: Promise<BrowserFFmpeg> | null = null;
const ffmpegAssetUrls: string[] = [];
const ffmpegLog: string[] = [];

async function fetchBlobUrl(url: string, mimeType: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("Could not download local-video support asset (" + response.status + "): " + url);
  }
  const objectUrl = URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: mimeType }));
  ffmpegAssetUrls.push(objectUrl);
  return objectUrl;
}

async function getBrowserFFmpeg(): Promise<BrowserFFmpeg> {
  ffmpegInstance ??= (async () => {
    const module = (await import(/* @vite-ignore */ FFMPEG_MODULE_URL)) as BrowserFFmpegModule;
    const ffmpeg = new module.FFmpeg();
    ffmpeg.on("log", ({ message }) => {
      ffmpegLog.push(message);
      if (ffmpegLog.length > 30) ffmpegLog.shift();
    });
    const coreURL = await fetchBlobUrl(FFMPEG_CORE_BASE_URL + "/ffmpeg-core.js", "text/javascript");
    const wasmURL = await fetchBlobUrl(FFMPEG_CORE_BASE_URL + "/ffmpeg-core.wasm", "application/wasm");
    // Module workers must be same-origin. Use a same-origin blob entry point
    // that imports the CDN module; its own relative imports then resolve against
    // the original CDN URL rather than the blob URL.
    const classWorkerURL = URL.createObjectURL(
      new Blob([`import "${FFMPEG_CLASS_WORKER_URL}";`], { type: "text/javascript" }),
    );
    ffmpegAssetUrls.push(classWorkerURL);
    await ffmpeg.load({ coreURL, wasmURL, classWorkerURL });
    return ffmpeg;
  })();
  return ffmpegInstance;
}

/**
 * Hikvision IMKH exports contain an MPEG program stream with a proprietary
 * prefix. FFmpeg recognises this variant. Remux video packets into an
 * in-memory MP4 using stream copy (no video re-encoding). The source File
 * remains unchanged and is never uploaded.
 */
async function prepareLocalVideoFile(file: File): Promise<File> {
  const signature = new TextDecoder().decode(new Uint8Array(await file.slice(0, 4).arrayBuffer()));
  if (signature !== "IMKH") return file;

  ffmpegLog.length = 0;
  const ffmpeg = await getBrowserFFmpeg();
  const inputPath = "hikvision-source.imkh";
  const outputPath = "hikvision-remuxed.mp4";
  try {
    await ffmpeg.writeFile(inputPath, new Uint8Array(await file.arrayBuffer()));
    const exitCode = await ffmpeg.exec([
      "-f", "mpeg",
      "-probesize", "50000000",
      "-analyzeduration", "100000000",
      "-fflags", "+genpts",
      "-i", inputPath,
      "-map", "0:v:0",
      "-c:v", "copy",
      "-an",
      "-movflags", "+faststart",
      outputPath,
    ]);
    if (exitCode !== 0) {
      throw new Error("FFmpeg remux exited with code " + exitCode + ". " + ffmpegLog.slice(-8).join(" | "));
    }
    const result = await ffmpeg.readFile(outputPath);
    if (typeof result === "string" || result.byteLength === 0) {
      throw new Error("FFmpeg did not produce a video file.");
    }
    const bytes = new Uint8Array(result);
    const outputBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new File([outputBuffer], file.name + ".remuxed.mp4", { type: "video/mp4" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("Hikvision IMKH remux failed: " + detail + ". Recent FFmpeg output: " + (ffmpegLog.slice(-8).join(" | ") || "(none)"));
  } finally {
    await Promise.all([inputPath, outputPath].map((name) => ffmpeg.deleteFile(name).catch(() => undefined)));
  }
}

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

/** Inspect only the first 32 bytes; the selected video remains in this tab. */
async function inspectLocalFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
  const ascii = [...bytes]
    .map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : "."))
    .join("");
  const boxType =
    bytes.length >= 8
      ? String.fromCharCode(bytes[4] ?? 0, bytes[5] ?? 0, bytes[6] ?? 0, bytes[7] ?? 0)
      : "unavailable";
  return `name=${file.name}, size=${file.size} bytes, MIME=${file.type || "(empty)"}, box[4..7]=${boxType}, header(hex)=${hex}, header(text)=${ascii}`;
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
    const probe = await inspectLocalFile(file);
    const preparedFile = await prepareLocalVideoFile(file);
    const mediabunny = await registerDecoder();
    const input = new mediabunny.Input({
      source: new mediabunny.BlobSource(preparedFile),
      formats: mediabunny.ALL_FORMATS,
    });

    let phase = "identifying the container";
    try {
      const format = await input.getFormat();
      phase = `reading the ${format.name} (${format.mimeType}) tracks`;
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
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Mediabunny failed while ${phase}: ${detail}. Local file: ${probe}`,
      );
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

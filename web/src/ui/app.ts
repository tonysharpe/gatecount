/** The live demo.
 *
 * It opens on the simulated motorway, which needs no download and is already
 * moving when the page appears; the two clips and the visitor's own camera are
 * one tab away and run the real detector. Whatever the source, everything after
 * the boxes -- tracking, counting, the overlay, the readout -- is one path.
 *
 * The rules it is built to are about truth first and polish second:
 *
 *   - Detection is decoupled from render. The page draws every frame and runs
 *     the detector on the cadence the MEASURED backend can sustain, and says so
 *     whenever that is less than every frame rather than quietly dropping to a
 *     slideshow.
 *   - Nothing is reported that was not measured in this tab, in this session.
 *   - The line is the visitor's. Moving it restarts the counts from that
 *     moment, and the readout says so instead of showing a total that mixes two
 *     different geometries.
 *   - A count is shown where it happened: the "+1" rises from the exact point
 *     on the line the engine says the path crossed.
 *
 * The frame loop and the detection loop are separate on purpose. The render
 * loop is a `requestAnimationFrame` chain that only ever draws; the detect loop
 * is an async chain that awaits inference and is therefore paced by the
 * hardware. Neither waits on the other. */

import { Gate } from "../engine/gate";
import type { CrossingEvent } from "../engine/gate";
import type { Point } from "../engine/geometry";
import { SessionPipeline } from "../engine/pipeline";
import type { TrackView } from "../engine/pipeline";
import {
  DETECT_DEFAULT_CONF,
  DETECT_DEFAULT_NMS_IOU,
} from "../generated/constants";
import { MODEL_CONTENT_VERSION, MODEL_INPUT_SIZE, MODEL_URL } from "../model-asset";
import { probeBackend } from "../runtime/backend";
import type { BackendProbe } from "../runtime/backend";
import { letterbox } from "../runtime/preprocess";
import { decodeYolo } from "../runtime/postprocess";
import { ORT_ENTRY, browserDeps, createSession, vendoredUrl } from "../runtime/session";
import type { RuntimeSession } from "../runtime/session";
import {
  collectElements,
  installThemeToggle,
  markSelectedSource,
  renderStatus,
  renderSwitcher,
} from "./controls";
import type { Elements, RunState } from "./controls";
import { CAMERA } from "../sim/camera";
import { ScenePainter } from "../sim/scene";
import { Simulation } from "../sim/simulation";
import { DENSITIES } from "../sim/traffic";
import type { Density } from "../sim/traffic";
import { flowBins, inLast, pruneFlow } from "./flow";
import { RollingMedian, decideCadence } from "./format";
import type { Cadence } from "./format";
import { sizeCanvas } from "./canvas-size";
import { GATE_HANDLE_RADIUS_PX, applyDrag, beginDrag, moveGate } from "./gate-drag";
import type { Grab, GrabKind, Segment } from "./gate-drag";
import {
  POP_SECONDS,
  TRAIL_SECONDS,
  boxToFrame,
  drawOverlay,
  frameToBox,
  gateNormal,
  readPalette,
} from "./overlay";
import type { Fit, Palette, Trail } from "./overlay";
import { FEED_LENGTH, Readout } from "./readout";
import type { FeedEntry } from "./readout";
import { SOURCES, keepClassesOf, sourceById } from "./sources";
import type { SourceSpec } from "./sources";
import { displayOrder } from "./vehicles";

/** Trajectory history kept per track, in seconds: a little longer than the
 * trail the overlay draws, so a trail never starts mid-air. */
const HISTORY_S = 3;

/** Trail length on the simulated road, in seconds. */
const SIMULATED_TRAIL_S = 1.2;

/** How long a crossing is kept for drawing: its "+1" and the line's glow. */
const EVENT_KEEP_S = POP_SECONDS + 1;

/** Samples the rolling backend median is taken over: about four seconds of
 * WebGPU inference, so the figure settles quickly and still forgets a stall. */
const TIMING_WINDOW = 120;

/** The status figures change every detection; a visitor can read them twice a
 * second, not thirty times. */
const STATUS_REFRESH_MS = 500;

/** How often the readout is refreshed when nothing has crossed: often enough
 * for the flow chart's bars to move on time. */
const PANEL_REFRESH_MS = 250;

interface Sample {
  readonly t: number;
  readonly p: Point;
}

export class ControlRoom {
  private readonly elements: Elements;
  private readonly readout: Readout;
  private readonly video: HTMLVideoElement;
  private readonly videoCtx: CanvasRenderingContext2D;
  private readonly reducedMotion: boolean;

  private source: SourceSpec = SOURCES[0] as SourceSpec;
  /** Object URL for a visitor-selected video; revoked when that source is left. */
  private localVideoUrl: string | null = null;
  private frameSize = { width: 0, height: 0 };
  private gate: Segment = { start: [0, 0], end: [1, 1] };
  private pipeline: SessionPipeline | null = null;
  private probe: BackendProbe | null = null;
  private session: RuntimeSession | null = null;
  private tensorFactory:
    | ((data: Float32Array, dims: readonly number[]) => unknown)
    | null = null;

  private running = false;
  /** True once the selected source has frames to show. A source that failed to
   * open leaves this false: nothing is drawn, the line is hidden, and Start
   * stays disabled until another source is chosen. */
  private sourceReady = false;
  /** Whether the demo is on screen, which is when the clip may play as a
   * preview before the detector has been started. */
  private stageVisible = true;
  private runState: RunState = "checking";
  /** True once the visitor has paused this source; the button then resumes. */
  private pausedHere = false;
  /** True while the visitor has the simulated road paused. It survives a trip
   * to another tab, so coming back finds the road as it was left: moving if
   * it was moving, still if they stopped it. */
  private simulationHeld = false;
  private hasDragged = false;
  private detectGeneration = 0;
  private fit: Fit = { scale: 1, dx: 0, dy: 0 };
  private grab: Grab | null = null;

  private readonly trails = new Map<number, Sample[]>();
  /** The type each trail belongs to, kept as long as the trail is: a trail
   * outlives its track by up to `TRAIL_SECONDS`, and it should keep its
   * vehicle's colour rather than turn grey when the tracker loses it. */
  private readonly trailTypes = new Map<number, string>();
  private tracks: readonly TrackView[] = [];
  private events: CrossingEvent[] = [];
  private feed: FeedEntry[] = [];
  private feedSerial = 0;
  private readonly counted = new Set<number>();
  private readonly wrongWayIds = new Set<number>();

  /** The simulated motorway and its painter, made the first time the
   * simulation is chosen and kept: going back to it finds the road as it was. */
  private simulation: Simulation | null = null;
  private painter: ScenePainter | null = null;
  /** `performance.now()` of the last simulation tick, null while it is not
   * being advanced -- paused, off screen, or in a hidden tab -- so it resumes
   * where it stopped rather than catching up. */
  private simulatedAt: number | null = null;
  /** Seconds of footage the session has counted over. Unlike the clip's own
   * clock it keeps running when a clip loops, so the flow chart's last minute
   * is a real minute. */
  private sessionClock = 0;
  private crossingTimes: number[] = [];
  private readonly ambientCtx: CanvasRenderingContext2D | null;
  private frameCount = 0;
  private drawnOnce = false;
  private panelsAt = 0;

  private readonly frameMs = new RollingMedian(TIMING_WINDOW);
  private detectionTimes: number[] = [];
  private cadence: Cadence = decideCadence(null, 30);
  private statusAt = 0;
  private status = "";
  /** The pipeline's frame clock, and it belongs to the PIPELINE, not to a run
   * of the detect loop: `stop()` and `run()` keep the pipeline, so a clock
   * restarted at 0 on resume would hand it frame indices behind its own
   * `lastSeen` entries, reaping would stop, and long-gone vehicles would
   * suppress legitimate re-counts. It is reset where the pipeline is
   * constructed again, and only there. */
  private frameIndex = 0;
  private lastTimestamp = 0;
  private palette: Palette | null = null;
  private paletteKey = "";

  constructor() {
    this.elements = collectElements();
    this.readout = new Readout(this.elements);
    this.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.loop = true;
    this.video.preload = "auto";
    this.video.crossOrigin = "anonymous";

    const videoCtx = this.elements.videoCanvas.getContext("2d");
    if (videoCtx === null) {
      throw new Error("this browser has no 2d canvas context");
    }
    this.videoCtx = videoCtx;
    this.ambientCtx = this.elements.ambient.getContext("2d");
  }

  /** The live video element, exposed for the headless webcam check: the stub
   * replaces `getUserMedia`, and the verifier needs to see the same element the
   * detector reads. */
  get videoElement(): HTMLVideoElement {
    return this.video;
  }

  async start(): Promise<void> {
    installThemeToggle(this.elements.themeToggle);

    renderSwitcher(
      this.elements.switcher,
      this.source.id,
      (id) => {
        void this.selectSource(sourceById(id));
      },
      (file) => this.selectLocalVideo(file),
    );
    for (const button of [this.elements.startButton, this.elements.launchButton]) {
      button.addEventListener("click", () => {
        void this.toggleRunning();
      });
    }
    this.elements.resetButton.addEventListener("click", () => {
      this.resetCounts();
    });
    this.installGateControls();
    this.installTrafficControl();
    this.installPreview();
    if (!this.reducedMotion) {
      this.readout.boot();
    }
    this.setRunState("checking");

    // The simulation first: it needs nothing from the hardware probe and
    // nothing downloaded, so the road is moving before the probe returns. A
    // visitor who has asked for less motion gets the same road, still, with
    // Start to set it going.
    await this.selectSource(this.source);
    this.renderFrame();

    // Probed before anything is downloaded: the page can say what this machine
    // will run before it asks the visitor to download the detector to find out.
    this.probe = await probeBackend();
    if (this.runState === "checking") {
      this.setRunState("ready");
    }
    this.renderStatus(true);
  }

  // -- sources ----------------------------------------------------------------

  /** Attach a file chosen by the visitor without sending its bytes anywhere. */
  private selectLocalVideo(file: File): void {
    const extension = file.name.toLowerCase().split(".").pop() ?? "";
    const supportedExtensions = ["mp4", "webm", "mov", "m4v", "ogv"];
    if (!file.type.startsWith("video/") && !supportedExtensions.includes(extension)) {
      this.setStatus("Choose a video file, such as MP4, WebM or MOV.");
      return;
    }

    const url = URL.createObjectURL(file);
    const source: SourceSpec = {
      id: "local-video",
      label: "Your video",
      kind: "clip",
      url,
      fps: 30,
      classes: [
        [0, "person"],
        [1, "bicycle"],
        [2, "car"],
        [3, "motorcycle"],
        [5, "bus"],
        [7, "truck"],
      ],
      gate: {
        name: "midline",
        start: [0, 0.5],
        end: [1, 0.5],
        labelPositive: "in",
        labelNegative: "out",
        expectedDirection: null,
      },
      calibrated: false,
      caption: `${file.name}. Selected from this device; processed in this browser tab.`,
    };
    void this.selectSource(source);
  }

  private async selectSource(source: SourceSpec): Promise<void> {
    // Carry "running" across a switch only where nothing new would start
    // without being asked for: the detector is downloaded on a click on Start,
    // never because a tab was changed while the simulation was moving.
    const wasRunning = this.running && (source.kind === "simulation" || this.session !== null);
    this.stop();
    if (this.localVideoUrl !== null && source.url !== this.localVideoUrl) {
      this.video.pause();
      this.video.srcObject = null;
      this.video.removeAttribute("src");
      this.video.load();
      this.releaseLocalVideo();
    }
    if (source.id === "local-video" && source.url !== null) {
      this.localVideoUrl = source.url;
    }
    this.pausedHere = false;
    if (this.runState === "paused") {
      // A pause belonged to the clip being left; the new one has not started.
      // If it is about to resume, `run` says Live once it has.
      this.setRunState("ready");
    }
    // Until the new source has frames there is nothing to count and no picture
    // for the line to sit on.
    this.setPlayable(false);
    this.source = source;
    markSelectedSource(this.elements.switcher, source.id);
    this.elements.videoCaption.textContent = source.caption;
    this.elements.traffic.hidden = source.kind !== "simulation";
    // The launch panel offers the detector download; the simulation has
    // nothing to download, and once the detector is here it is not offered
    // again.
    this.elements.emptyState.hidden = source.kind === "simulation" || this.session !== null;
    this.clearSession();
    this.readout.reset();

    try {
      await this.attachSource(source);
    } catch (error) {
      this.setStatus(
        source.kind === "camera"
          ? `The camera could not be opened: ${describe(error)}. The two clips still run.`
          : `That clip could not be loaded: ${describe(error)}.`,
      );
      // Nothing is running on this source, and a "Paused" left over from the
      // one before would describe a session that has gone. The previous clip
      // is detached too: left in the player it would keep playing under this
      // source's name, and Start would count it with this source's settings.
      this.detachVideo();
      this.setRunState(this.probe === null ? "checking" : "ready");
      this.setPlayable(false);
      this.renderPanels();
      return;
    }

    this.frameSize =
      source.kind === "simulation"
        ? { width: CAMERA.width, height: CAMERA.height }
        : { width: this.video.videoWidth, height: this.video.videoHeight };
    this.gate = gateSegment(source, this.frameSize);
    this.pipeline = this.buildPipeline();
    this.setPlayable(true);
    this.setStatus("");
    if (source.kind === "simulation" && this.runState === "checking") {
      // Nothing to probe for: the simulated road can always run.
      this.setRunState("ready");
    } else if (source.kind !== "simulation" && this.probe === null) {
      this.setRunState("checking");
    }
    this.renderStatus(true);
    this.renderPanels();
    // The simulated road starts on its own -- on first load and on coming back
    // to it -- unless the visitor has asked for less motion or stopped it.
    const autoplay = source.kind === "simulation" && !this.reducedMotion && !this.simulationHeld;
    if (wasRunning || autoplay) {
      await this.run();
    } else {
      this.renderControls();
      this.syncPreview();
    }
    this.renderFrame();
  }

  private async attachSource(source: SourceSpec): Promise<void> {
    if (source.kind === "simulation") {
      // No video: the page draws the frames itself.
      this.releaseCamera();
      this.video.pause();
      this.video.srcObject = null;
      this.video.removeAttribute("src");
      this.simulation ??= new Simulation();
      this.painter ??= new ScenePainter(this.simulation.camera);
      return;
    }
    if (source.kind === "camera") {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720 },
        audio: false,
      });
      this.video.srcObject = stream;
      this.video.removeAttribute("src");
    } else {
      this.releaseCamera();
      this.video.srcObject = null;
      this.video.src = new URL(source.url as string, document.baseURI).href;
    }
    // Register listeners before explicitly starting the clip load, so an
    // immediate decode/unsupported-source error is not missed.
    const metadata = this.awaitMetadata();
    if (source.kind === "clip") {
      this.video.load();
    }
    await metadata;
    if (source.kind === "camera") {
      // A live stream has nothing to seek to and no first frame until it plays.
      await this.video.play();
    } else {
      this.video.currentTime = 0;
      await once(this.video, "seeked", 4000).catch(() => undefined);
    }
  }

  private awaitMetadata(): Promise<void> {
    if (this.video.readyState >= 1 && this.video.videoWidth > 0) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        this.video.removeEventListener("loadedmetadata", onLoaded);
        this.video.removeEventListener("error", onError);
        this.video.removeEventListener("abort", onAbort);
      };
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onLoaded = (): void => {
        if (this.video.videoWidth > 0 && this.video.videoHeight > 0) {
          finish();
        } else {
          finish(new Error("loadedmetadata arrived without usable video dimensions"));
        }
      };
      const onError = (): void => finish(new Error(describeMediaError(this.video)));
      const onAbort = (): void => finish(new Error(
        `video loading was aborted; ${describeMediaError(this.video)}`,
      ));
      const timer = setTimeout(() => {
        finish(new Error(
          `timed out waiting for loadedmetadata (readyState=${this.video.readyState}, ` +
          `networkState=${this.video.networkState}, dimensions=${this.video.videoWidth}x${this.video.videoHeight}; ` +
          describeMediaError(this.video) + ")",
        ));
      }, 15000);

      this.video.addEventListener("loadedmetadata", onLoaded);
      this.video.addEventListener("error", onError);
      this.video.addEventListener("abort", onAbort);
      // The error may have been raised while the source was being assigned.
      if (this.video.error !== null) onError();
      else if (this.video.readyState >= 1) onLoaded();
    });
  }

  private buildPipeline(): SessionPipeline {
    return new SessionPipeline({
      gates: [this.gateObject()],
      // No source reachable from this page has an independent along-road
      // survey, so there is no plane and every speed is null -- by refusal,
      // not by absence of data.
      plane: null,
      fps: this.source.fps,
      speedLimitKmh: null,
    });
  }

  private gateObject(): Gate {
    return new Gate(this.source.gate.name, this.gate.start, this.gate.end, {
      labelPositive: this.source.gate.labelPositive,
      labelNegative: this.source.gate.labelNegative,
      expectedDirection: this.source.gate.expectedDirection,
    });
  }

  // -- running ----------------------------------------------------------------

  private async toggleRunning(): Promise<void> {
    const simulated = this.source.kind === "simulation";
    if (this.running) {
      this.stop();
      this.pausedHere = true;
      this.simulationHeld = simulated;
      this.renderControls();
      this.renderFrame();
      return;
    }
    if (simulated) {
      this.simulationHeld = false;
    }
    await this.run();
  }

  private async run(): Promise<void> {
    if (this.pipeline === null || !this.sourceReady) {
      return;
    }
    if (this.source.kind === "simulation") {
      // Nothing to download and no detect loop: the render loop advances the
      // road, and each step's boxes go straight to the pipeline.
      this.running = true;
      this.pausedHere = false;
      this.simulatedAt = null;
      this.detectGeneration += 1;
      this.setRunState("live");
      return;
    }
    this.setBusy(true);
    try {
      await this.ensureSession();
    } catch (error) {
      this.setStatus(`The detector could not start: ${describe(error)}`);
      this.setBusy(false);
      this.setRunState("ready");
      return;
    }
    this.setBusy(false);
    this.elements.emptyState.hidden = true;
    this.running = true;
    this.pausedHere = false;
    this.setRunState("live");
    this.detectGeneration += 1;
    try {
      await this.video.play();
    } catch {
      // Autoplay refusal on a muted, user-initiated play is not expected; if it
      // happens the detect loop simply waits for frames.
    }
    void this.detectLoop(this.detectGeneration);
  }

  private stop(): void {
    const wasRunning = this.running;
    this.running = false;
    this.grab = null;
    this.detectGeneration += 1;
    this.video.pause();
    if (wasRunning) {
      this.setRunState("paused");
    }
  }

  private clearSession(): void {
    this.trails.clear();
    this.trailTypes.clear();
    this.tracks = [];
    this.events = [];
    this.feed = [];
    this.counted.clear();
    this.wrongWayIds.clear();
    this.frameMs.reset();
    this.detectionTimes = [];
    this.lastTimestamp = 0;
    this.sessionClock = 0;
    this.crossingTimes = [];
    // THE FRAME CLOCK AND THE PIPELINE RESTART TOGETHER, HERE, and nowhere
    // else. The pipeline's tracker retires tracks by comparing `lastSeen`
    // against the current frame index, so a pipeline carried across a clock
    // reset holds tracks stamped hundreds of frames in the future: nothing
    // reaps them, and the next crossing they are matched to is counted against
    // a stale identity. `selectSource` calls this and can then return early --
    // a denied camera, an unloadable clip -- before it builds a pipeline of its
    // own, so the two are one statement pair rather than a promise that every
    // caller will remember the second half.
    this.frameIndex = 0;
    this.pipeline = this.buildPipeline();
  }

  private resetCounts(): void {
    this.clearSession();
    this.readout.reset();
    this.renderPanels();
    this.renderFrame();
  }

  private async ensureSession(): Promise<void> {
    if (this.session !== null) {
      return;
    }
    const probe = this.probe;
    this.setRunState("loading");
    this.elements.progress.hidden = false;
    this.elements.emptyText.textContent = "Downloading the detector. This happens once.";

    const session = await createSession(
      new URL(MODEL_URL, document.baseURI).href,
      probe?.ep ?? "wasm",
      (progress) => {
        if (progress.total > 0) {
          this.elements.progress.max = progress.total;
          this.elements.progress.value = progress.loaded;
        } else {
          this.elements.progress.removeAttribute("value");
        }
        this.elements.emptyText.textContent = progress.fromCache
          ? "Detector loaded from this browser's cache."
          : `Downloading the detector: ${(progress.loaded / 1e6).toFixed(1)} MB.`;
      },
      browserDeps({ contentVersion: MODEL_CONTENT_VERSION }),
    );
    this.session = session;

    // The runtime module is imported from the same vendored URL the session
    // used, so this is the same module instance the session is running on --
    // the browser caches it -- and its Tensor is the one that session accepts.
    const ort = (await import(/* @vite-ignore */ vendoredUrl(ORT_ENTRY))) as {
      Tensor: new (type: string, data: Float32Array, dims: readonly number[]) => unknown;
    };
    this.tensorFactory = (data, dims) => new ort.Tensor("float32", data, dims);
    this.elements.progress.hidden = true;
  }

  // -- the detect loop --------------------------------------------------------

  private async detectLoop(generation: number): Promise<void> {
    const session = this.session;
    const makeTensor = this.tensorFactory;
    if (session === null || makeTensor === null) {
      return;
    }
    const keepClasses = keepClassesOf(this.source);
    let lastDetectedAt = -Infinity;

    while (this.running && generation === this.detectGeneration) {
      const now = this.video.currentTime;
      const spacing = this.cadence.stride / this.source.fps;
      if (this.video.readyState < 2 || this.video.videoWidth === 0) {
        await nextFrame();
        continue;
      }
      if (now < lastDetectedAt + spacing && now >= lastDetectedAt) {
        await nextFrame();
        continue;
      }
      lastDetectedAt = now;

      try {
        // The whole per-frame path is timed, not just the inference:
        // letterboxing and decoding are costs the visitor pays too, and a
        // number that left them out would not be the frame time the page is
        // actually achieving.
        const started = performance.now();
        const input = letterbox(this.video, MODEL_INPUT_SIZE);
        const output = (await session.session.run({
          [session.inputName]: makeTensor(input.tensor, [1, 3, input.size, input.size]),
        })) as Record<string, { data: Float32Array; dims: readonly number[] }>;
        const raw = output[session.outputName] as {
          data: Float32Array;
          dims: readonly number[];
        };
        const detections = decodeYolo(
          { data: raw.data, dims: raw.dims },
          input.scale,
          input.padX,
          input.padY,
          { conf: DETECT_DEFAULT_CONF, iou: DETECT_DEFAULT_NMS_IOU, keepClasses },
        );
        this.recordTiming(performance.now() - started);
        this.consume(detections, this.frameIndex, now);
        this.frameIndex += 1;
      } catch (error) {
        this.setStatus(`Inference stopped: ${describe(error)}`);
        this.stop();
        this.setRunState("ready");
        return;
      }
    }
  }

  private recordTiming(elapsedMs: number): void {
    this.frameMs.push(elapsedMs);
    const stamp = performance.now();
    this.detectionTimes.push(stamp);
    while (
      this.detectionTimes.length > 2 &&
      stamp - (this.detectionTimes[0] as number) > 2000
    ) {
      this.detectionTimes.shift();
    }
    this.cadence = decideCadence(this.frameMs.value(), this.source.fps);
    this.renderStatus();
  }

  /** Measured detections per second, over the last two seconds of wall clock.
   * Not derived from the median: a derived rate would hide the cost of
   * everything around inference, which the visitor is also paying. */
  private measuredFps(): number | null {
    if (this.detectionTimes.length < 2) {
      return null;
    }
    const first = this.detectionTimes[0] as number;
    const last = this.detectionTimes[this.detectionTimes.length - 1] as number;
    const seconds = (last - first) / 1000;
    return seconds > 0 ? (this.detectionTimes.length - 1) / seconds : null;
  }

  private consume(
    detections: Parameters<SessionPipeline["step"]>[0],
    frameIndex: number,
    timestamp: number,
  ): void {
    const pipeline = this.pipeline;
    if (pipeline === null) {
      return;
    }
    // The clips loop, so the clip clock jumps backwards. Counts carry across --
    // those vehicles really did cross -- but the drawn history cannot: trails
    // and markers are stamped in clip time and would sit in its future.
    if (timestamp < this.lastTimestamp - 0.5) {
      this.trails.clear();
      this.trailTypes.clear();
      this.events = [];
      this.wrongWayIds.clear();
      this.counted.clear();
      this.sessionClock += 1 / this.source.fps;
    } else {
      this.sessionClock += Math.max(0, timestamp - this.lastTimestamp);
    }
    this.lastTimestamp = timestamp;

    const step = pipeline.step(detections, frameIndex, timestamp);
    this.tracks = step.tracks;

    for (const track of step.tracks) {
      const trail = this.trails.get(track.trackId) ?? [];
      trail.push({ t: timestamp, p: track.anchor });
      while (trail.length > 1 && timestamp - (trail[0] as Sample).t > HISTORY_S) {
        trail.shift();
      }
      this.trails.set(track.trackId, trail);
      this.trailTypes.set(track.trackId, track.className);
    }
    for (const [trackId, trail] of this.trails) {
      const last = trail[trail.length - 1];
      if (last === undefined || timestamp - last.t > HISTORY_S) {
        this.trails.delete(trackId);
        this.trailTypes.delete(trackId);
      }
    }

    const expected = this.source.gate.expectedDirection;
    for (const event of step.events) {
      this.events.push(event);
      this.counted.add(event.trackId);
      const wrongWay = expected !== null && event.direction !== expected;
      if (wrongWay) {
        this.wrongWayIds.add(event.trackId);
      }
      this.feedSerial += 1;
      this.crossingTimes.push(this.sessionClock);
      this.feed.unshift({
        id: this.feedSerial,
        trackId: event.trackId,
        timestamp: event.timestamp,
        className: event.className,
        direction: event.direction,
        wrongWay,
      });
    }
    this.feed = this.feed.slice(0, FEED_LENGTH);
    this.events = this.events.filter((event) => timestamp - event.timestamp <= EVENT_KEEP_S);
    // The panels change when something crosses, and otherwise only as the
    // flow chart's bars age: the simulation steps sixty times a second, and
    // the readout does not need to be rewritten sixty times a second.
    const now = performance.now();
    if (step.events.length > 0 || now - this.panelsAt >= PANEL_REFRESH_MS) {
      this.panelsAt = now;
      this.renderPanels();
    }
  }

  // -- the render loop --------------------------------------------------------

  /** Draw one frame. Runs whether or not the detector is going: the page has to
   * be legible with the engine stopped. */
  renderFrame(): void {
    // Nobody is looking: draw nothing. The first frame is always drawn, so the
    // stage is never blank when it scrolls into view.
    if (this.drawnOnce && (!this.stageVisible || document.hidden)) {
      this.simulatedAt = null;
      return;
    }
    if (this.source.kind === "simulation") {
      this.tickSimulation();
    }
    const palette = this.themePalette();
    // The simulated scene is painted, not decoded, so every device pixel costs
    // drawing time; past 2x the extra sharpness is not visible on a moving road.
    const dpr = Math.min(this.source.kind === "simulation" ? 2 : 3, globalThis.devicePixelRatio || 1);

    const videoBox = sizeCanvas(this.elements.videoCanvas, dpr);
    if (!this.sourceReady) {
      // No frames and no line to draw: the stage stays dark, with the status
      // line saying why.
      this.videoCtx.save();
      this.videoCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.videoCtx.fillStyle = "#000";
      this.videoCtx.fillRect(0, 0, videoBox.width, videoBox.height);
      this.videoCtx.restore();
      return;
    }
    const simulation = this.source.kind === "simulation" ? this.simulation : null;
    const painter = this.painter;
    const total = this.pipeline?.total() ?? 0;
    this.fit = drawOverlay(
      this.videoCtx,
      videoBox,
      {
        frame: this.frameSize,
        gate: this.gate,
        gateLabels: {
          positive: this.source.gate.labelPositive,
          negative: this.source.gate.labelNegative,
        },
        tracks: this.tracks,
        trails: this.trailsForOverlay(),
        trailSeconds: simulation === null ? TRAIL_SECONDS : SIMULATED_TRAIL_S,
        trailTypes: this.trailTypes,
        events: this.events,
        now: this.clock(),
        dpr,
        source: simulation === null && this.video.readyState >= 2 ? this.video : null,
        paint:
          simulation !== null && painter !== null
            ? (ctx, resolution) => {
                painter.paint(ctx, resolution, simulation.traffic.vehicles, simulation.clock, total);
              }
            : null,
        reducedMotion: this.reducedMotion,
        wrongWay: this.wrongWayIds,
        counted: this.counted,
      },
      palette,
    );
    // Last, after the canvas has been measured: these writes invalidate
    // layout, and doing them earlier would force a synchronous recalculation on
    // the next `getBoundingClientRect` every single frame.
    this.positionHandles();
    this.drawnOnce = true;
    this.frameCount += 1;
    if (this.ambientCtx !== null && this.frameCount % 6 === 1) {
      // The stage, shrunk to a thumbnail and blurred by the stylesheet behind
      // it, so the scene's own light spills onto the console around it.
      const ambient = this.elements.ambient;
      this.ambientCtx.drawImage(this.elements.videoCanvas, 0, 0, ambient.width, ambient.height);
    }
  }

  /** The clock the overlay and the line live on: the simulation's, or the
   * video's. */
  private clock(): number {
    if (this.source.kind === "simulation") {
      return this.simulation?.clock ?? 0;
    }
    return this.video.currentTime;
  }

  /** Advance the simulated road by the wall time since the last frame, and
   * hand each step's boxes to the pipeline. The step is fixed at 1/60 s
   * whatever the display's refresh rate; see `Simulation`. */
  private tickSimulation(): void {
    const simulation = this.simulation;
    if (simulation === null || !this.running) {
      this.simulatedAt = null;
      return;
    }
    const now = performance.now();
    const elapsed = this.simulatedAt === null ? 0 : (now - this.simulatedAt) / 1000;
    this.simulatedAt = now;
    simulation.advance(elapsed, (detections, clock) => {
      this.consume(detections, this.frameIndex, clock);
      this.frameIndex += 1;
    });
  }

  // -- traffic ----------------------------------------------------------------

  private installTrafficControl(): void {
    const buttons = [...this.elements.traffic.querySelectorAll<HTMLButtonElement>("button[data-density]")];
    for (const button of buttons) {
      button.addEventListener("click", () => {
        const density = button.dataset["density"] as Density;
        if (!DENSITIES.includes(density)) {
          return;
        }
        this.simulation?.traffic.setDensity(density);
        this.renderTrafficControl();
      });
    }
    this.renderTrafficControl();
  }

  private renderTrafficControl(): void {
    const current = this.simulation?.traffic.currentDensity ?? "busy";
    for (const button of this.elements.traffic.querySelectorAll<HTMLButtonElement>("button[data-density]")) {
      button.setAttribute("aria-pressed", String(button.dataset["density"] === current));
    }
  }

  /** The canvas colours, recomputed only when the theme actually changes.
   * `getComputedStyle` is a layout read, and doing it per frame beside the
   * handle writes below is the classic way to make a canvas page stutter. */
  private themePalette(): Palette {
    const key = `${document.documentElement.getAttribute("data-theme") ?? "system"}:${
      matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    }`;
    if (this.palette === null || key !== this.paletteKey) {
      this.palette = readPalette(document.documentElement);
      this.paletteKey = key;
    }
    return this.palette;
  }

  private trailsForOverlay(): Map<number, Trail> {
    const out = new Map<number, Trail>();
    for (const [trackId, samples] of this.trails) {
      out.set(trackId, samples);
    }
    return out;
  }

  // -- the line ---------------------------------------------------------------

  private installGateControls(): void {
    const stage = this.elements.stage;
    stage.addEventListener("pointerdown", (event) => {
      const point = this.pointerToFrame(event);
      const grab = beginDrag(this.gate, point, this.grabRadius());
      if (grab === null) {
        return;
      }
      this.grab = grab;
      stage.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    stage.addEventListener("pointermove", (event) => {
      if (this.grab === null) {
        return;
      }
      this.setGate(applyDrag(this.grab, this.pointerToFrame(event), this.frameSize));
      event.preventDefault();
    });
    for (const type of ["pointerup", "pointercancel"] as const) {
      stage.addEventListener(type, (event) => {
        if (this.grab === null) {
          return;
        }
        this.grab = null;
        stage.releasePointerCapture(event.pointerId);
      });
    }

    const kinds: [HTMLButtonElement, GrabKind][] = [
      [this.elements.handles.start, "start"],
      [this.elements.handles.body, "body"],
      [this.elements.handles.end, "end"],
    ];
    for (const [button, kind] of kinds) {
      button.addEventListener("keydown", (event) => {
        const step = event.shiftKey ? 16 : 4;
        const deltas: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        };
        const delta = deltas[event.key];
        if (delta === undefined) {
          return;
        }
        event.preventDefault();
        this.setGate(moveGate(this.gate, kind, delta[0], delta[1], this.frameSize));
      });
    }
  }

  /** The grab radius in FRAME pixels: a constant on-screen radius, converted,
   * so the handle feels the same size on a phone and on a 4K display. */
  private grabRadius(): number {
    return GATE_HANDLE_RADIUS_PX / (this.fit.scale || 1);
  }

  private pointerToFrame(event: PointerEvent): Point {
    const rect = this.elements.videoCanvas.getBoundingClientRect();
    return boxToFrame([event.clientX - rect.left, event.clientY - rect.top], this.fit);
  }

  private setGate(next: Segment): void {
    this.gate = next;
    this.hasDragged = true;
    if (this.pipeline !== null) {
      if (this.frameIndex === 0) {
        // Nothing has been detected yet, so the move restarts nothing: a fresh
        // pipeline at the new line, with no "counting since" to explain.
        this.pipeline = this.buildPipeline();
      } else {
        this.pipeline.replaceGates([this.gateObject()], this.clock());
      }
      // The counts restart at the new line, so everything that described the
      // old one goes with them.
      this.feed = [];
      this.crossingTimes = [];
      this.counted.clear();
      this.wrongWayIds.clear();
      this.events = [];
    }
    this.renderPanels();
    this.renderFrame();
  }

  private positionHandles(): void {
    const middle: Point = [
      (this.gate.start[0] + this.gate.end[0]) / 2,
      (this.gate.start[1] + this.gate.end[1]) / 2,
    ];
    const points: [HTMLElement, Point][] = [
      [this.elements.handles.start, this.gate.start],
      [this.elements.handles.end, this.gate.end],
      [this.elements.handles.body, middle],
      [this.elements.gateHint, middle],
    ];
    for (const [node, point] of points) {
      const [x, y] = frameToBox(point, this.fit);
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
    }
    // The hint teaches the one interaction the page has, until it is used.
    const hideHint = this.hasDragged || !this.sourceReady;
    if (this.elements.gateHint.hidden !== hideHint) {
      this.elements.gateHint.hidden = hideHint;
    }
  }

  // -- rendering the markup ---------------------------------------------------

  private setRunState(state: RunState): void {
    this.runState = state;
    this.renderControls();
    this.renderStatus(true);
  }

  /** Play the clip as a silent preview while the demo is on screen and nothing
   * has been started, so the page moves from the first second; the detector
   * still downloads only when the visitor presses Start. Off screen, in a
   * hidden tab, or after the visitor has paused, the preview stops. */
  private installPreview(): void {
    if (typeof IntersectionObserver !== "undefined") {
      new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            this.stageVisible = entry.isIntersecting;
          }
          this.syncPreview();
        },
        { threshold: 0.15 },
      ).observe(this.elements.stage);
    }
    document.addEventListener("visibilitychange", () => {
      this.syncPreview();
    });
  }

  private syncPreview(): void {
    if (this.running || this.source.kind !== "clip" || !this.sourceReady) {
      return;
    }
    if (this.pausedHere || !this.stageVisible || document.hidden) {
      this.video.pause();
      return;
    }
    if (this.video.paused) {
      // A refused autoplay only means the preview stays on its first frame.
      void this.video.play().catch(() => undefined);
    }
  }

  private renderStatus(force = false): void {
    const now = performance.now();
    if (!force && now - this.statusAt < STATUS_REFRESH_MS) {
      return;
    }
    this.statusAt = now;
    renderStatus(this.elements, this.runState, {
      probe: this.probe,
      ep: this.session?.ep ?? null,
      msPerFrame: this.frameMs.value(),
      fps: this.measuredFps(),
      cadence: this.frameMs.count > 0 ? this.cadence : null,
      simulated: this.source.kind === "simulation",
    });
  }

  private renderControls(): void {
    this.elements.startButton.textContent = this.running
      ? "Pause"
      : this.pausedHere
        ? "Resume"
        : "Start";
  }

  private setBusy(busy: boolean): void {
    this.elements.startButton.disabled = busy || !this.sourceReady;
    this.elements.launchButton.disabled = busy || !this.sourceReady;
  }

  /** Whether the selected source can be counted: it gates Start and shows or
   * hides the line's handles, which have nothing to sit on without frames. */
  private setPlayable(playable: boolean): void {
    this.sourceReady = playable;
    this.setBusy(false);
    for (const node of [
      this.elements.handles.start,
      this.elements.handles.body,
      this.elements.handles.end,
    ]) {
      node.hidden = !playable;
    }
    this.elements.gateHint.hidden = !playable || this.hasDragged;
  }

  /** Stop and empty the player, so nothing keeps playing under a source that
   * failed to open. */
  private detachVideo(): void {
    this.video.pause();
    this.releaseCamera();
    this.video.srcObject = null;
    this.video.removeAttribute("src");
    this.video.load();
    this.releaseLocalVideo();
  }

  private renderPanels(): void {
    const pipeline = this.pipeline;
    const counts = pipeline?.counts() ?? {};
    const gateCounts = counts[this.source.gate.name] ?? {};

    const perClass = displayOrder(this.source.classes, ([, name]) => name).map(
      ([, name]) =>
        [name, Object.values(gateCounts[name] ?? {}).reduce((a, b) => a + b, 0)] as const,
    );
    const directions = [this.source.gate.labelPositive, this.source.gate.labelNegative];
    const perDirection = directions.map((direction) => {
      let total = 0;
      for (const byDirection of Object.values(gateCounts)) {
        total += byDirection[direction] ?? 0;
      }
      return [direction, total] as const;
    });
    const normal = gateNormal(this.gate.start, this.gate.end);
    this.crossingTimes = pruneFlow(this.crossingTimes, this.sessionClock);

    this.readout.render({
      total: pipeline?.total() ?? 0,
      perClass,
      perDirection,
      countingSince: pipeline?.countingSinceTimestamp ?? null,
      feed: this.feed,
      positiveAngleDeg: (Math.atan2(normal[1], normal[0]) * 180) / Math.PI,
      flow: {
        bins: flowBins(this.crossingTimes, this.sessionClock),
        lastMinute: inLast(this.crossingTimes, this.sessionClock),
      },
    });
  }

  private setStatus(message: string): void {
    this.status = message;
    this.elements.statusLine.textContent = message;
  }

  /** The last status message, for the headless checks. */
  get statusMessage(): string {
    return this.status;
  }

  private releaseCamera(): void {
    const stream = this.video.srcObject as MediaStream | null;
    if (stream !== null && typeof stream.getTracks === "function") {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
  }

  private releaseLocalVideo(): void {
    if (this.localVideoUrl !== null) {
      URL.revokeObjectURL(this.localVideoUrl);
      this.localVideoUrl = null;
    }
  }
}

// -- helpers ------------------------------------------------------------------

function gateSegment(source: SourceSpec, frame: { width: number; height: number }): Segment {
  return {
    start: [source.gate.start[0] * frame.width, source.gate.start[1] * frame.height],
    end: [source.gate.end[0] * frame.width, source.gate.end[1] * frame.height],
  };
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });
}

function once(target: EventTarget, type: string, timeoutMs: number): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.removeEventListener(type, handler);
      reject(new Error(`timed out waiting for ${type}`));
    }, timeoutMs);
    const handler = (event: Event): void => {
      clearTimeout(timer);
      target.removeEventListener(type, handler);
      resolve(event);
    };
    target.addEventListener(type, handler);
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeMediaError(video: HTMLVideoElement): string {
  const error = video.error;
  if (error === null) return "no MediaError details are available";
  const labels: Record<number, string> = {
    1: "MEDIA_ERR_ABORTED",
    2: "MEDIA_ERR_NETWORK",
    3: "MEDIA_ERR_DECODE",
    4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
  };
  const label = labels[error.code] ?? "unknown media error";
  const detail = error.message.trim();
  return `browser media error ${error.code} (${label})${detail ? `: ${detail}` : ""}`;
}

/** Boot the demo and keep drawing. */
export async function mountControlRoom(): Promise<ControlRoom> {
  const room = new ControlRoom();
  await room.start();
  const draw = (): void => {
    room.renderFrame();
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
  return room;
}

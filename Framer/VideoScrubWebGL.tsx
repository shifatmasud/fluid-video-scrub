import * as React from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { motion, useMotionValue } from "framer-motion";
import { addPropertyControls, ControlType } from "framer";
import * as THREE from "three";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

/**
 * High-performance scroll-driven video frame scrubber with dynamic spring progression and visual offsets.
 * 
 * Recommended Stack: React + R3F + Three.js + GSAP ScrollTrigger + ImageBitmap sequential decoding.
 * 
 * [SAFETY RULES]: Track errors, add tiny comments, explain what changed and how to undo.
 *   - Removed fluid simulation (FluidSolver.ts import, GPGPU solvers, splat variables, and pointer tracking) as requested.
 *   - Simplified interactions to direct progress scrubbing with custom spring damper interpolation.
 *   - Unified composition shader to handle radial chromatic aberration splits and zoom warp distortions directly based on scrub velocity, eliminating GPGPU overhead.
 *   - To undo: restore import of FluidSolver.ts, add back the splatQueue tracking in pointer actions, and restore the GPGPU solver steps in useFrame with its uniforms.
 */

interface VideoScrubWebGLProps {
  videoUrl?: string;
  inputMode?: "scroll" | "drag" | "both";
  dragSensitivity?: number;
  scrollSensitivity?: number;
  springMass?: number;
  springStiffness?: number;
  springDamping?: number;
  chromaticAberration?: number;
  warpDistortion?: number;
  scanlines?: number;
  showScanlines?: boolean;
  loopPlayback?: boolean;
  onScrub?: (progress: number) => void;
  fluidCursorSize?: number;
  fluidCursorPower?: number;
  fluidDistortionPower?: number;
  fluidResolution?: number;
}

export function VideoScrubWebGL(props: VideoScrubWebGLProps) {
  const {
    videoUrl = "https://res.cloudinary.com/dkemjl9se/video/upload/v1780345662/First-person_discovery_lake_vall__202606012155_bhyhue.mp4",
    inputMode = "both",
    dragSensitivity = 1.5,
    scrollSensitivity = 1.0,
    springMass = 1.0,
    springStiffness = 120,
    springDamping = 25,
    chromaticAberration = 0.5,
    warpDistortion = 0.6,
    scanlines = 0.3,
    showScanlines = true,
    loopPlayback = true,
    onScrub,
    fluidCursorSize = 0.5,
    fluidCursorPower = 0.6,
    fluidDistortionPower = 0.5,
    fluidResolution = 4,
  } = props;

  const containerRef = React.useRef<HTMLDivElement>(null);

  // Drag interaction variables (no fluid trackers)
  const isDraggingRef = React.useRef(false);
  const lastDragXRef = React.useRef(0.5);

  // Continuous pointer tracking variables for WebGL GPGPU fluid simulation
  const pointerXRef = React.useRef(0.5);
  const pointerYRef = React.useRef(0.5);
  const pointerDxRef = React.useRef(0);
  const pointerDyRef = React.useRef(0);
  const pointerMovedRef = React.useRef(false);
  const pointerHoveredRef = React.useRef(false);

  // Synchronized progress structures (0.0 - 1.0 chronological timeline)
  const targetProgress = React.useRef(0.0);
  const currentProgress = React.useRef(0.0);
  const currentVelocity = React.useRef(0);

  // Caching variables
  const NUM_FRAMES = 80;
  const frameCacheRef = React.useRef<{ [key: number]: THREE.Texture }>({});
  const [cachedCount, setCachedCount] = React.useState(0);
  const [videoLoaded, setVideoLoaded] = React.useState(false);
  const [errorText, setErrorText] = React.useState<string | null>(null);

  // 1. Parallel Round-Robin Extractor for rapid caching of frames to GPU memory
  React.useEffect(() => {
    let active = true;
    gsap.registerPlugin(ScrollTrigger);

    // Initializer playback node
    const previewVideo = document.createElement("video");
    previewVideo.src = videoUrl;
    previewVideo.crossOrigin = "anonymous";
    previewVideo.playsInline = true;
    previewVideo.muted = true;
    previewVideo.preload = "auto";
    previewVideo.style.display = "none";
    document.body.appendChild(previewVideo);

    const numWorkers = 8;
    const workersList: {
      video: HTMLVideoElement;
      queue: number[];
      index: number;
    }[] = [];

    const activeVideos: HTMLVideoElement[] = [previewVideo];

    for (let w = 0; w < numWorkers; w++) {
      const workerVideo = document.createElement("video");
      workerVideo.src = videoUrl;
      workerVideo.crossOrigin = "anonymous";
      workerVideo.playsInline = true;
      workerVideo.muted = true;
      workerVideo.preload = "auto";
      workerVideo.style.display = "none";
      document.body.appendChild(workerVideo);
      activeVideos.push(workerVideo);

      const queue: number[] = [];
      for (let i = w; i < NUM_FRAMES; i += numWorkers) {
        queue.push(i);
      }

      workersList.push({
        video: workerVideo,
        queue,
        index: 0,
      });
    }

    const startWorkerSegment = (workerIndex: number) => {
      if (!active) return;
      const worker = workersList[workerIndex];
      if (worker.index >= worker.queue.length) return;

      const frameIdx = worker.queue[worker.index];
      const duration = worker.video.duration;
      if (isNaN(duration) || duration <= 0) {
        // Retry if video metadata has a loading delay
        setTimeout(() => startWorkerSegment(workerIndex), 40);
        return;
      }
      worker.video.currentTime = (frameIdx / (NUM_FRAMES - 1)) * duration;
    };

    workersList.forEach((worker, workerIndex) => {
      const handleWorkerSeeked = () => {
        if (!active) return;
        const frameIdx = worker.queue[worker.index];

        if (worker.video.videoWidth > 0 && worker.video.videoHeight > 0) {
          try {
            // Asynchronous GPU hardware-accelerated decode
            createImageBitmap(worker.video)
              .then((imageBitmap) => {
                if (!active) {
                  imageBitmap.close();
                  return;
                }
                const texture = new THREE.Texture(imageBitmap);
                texture.flipY = false; // Fit standard direction orientation
                texture.minFilter = THREE.LinearFilter;
                texture.magFilter = THREE.LinearFilter;
                texture.needsUpdate = true;

                frameCacheRef.current[frameIdx] = texture;
                setCachedCount((prev) => prev + 1);

                worker.index++;
                setTimeout(() => startWorkerSegment(workerIndex), 1);
              })
              .catch((err) => {
                console.warn(`GPU Direct frame decode error, fallback requested. Index: ${frameIdx}`, err);
                fallbackExtractor(worker.video, frameIdx);
              });
          } catch (e) {
            console.warn(`WebGL texture worker try-block fallback. Index: ${frameIdx}`, e);
            fallbackExtractor(worker.video, frameIdx);
          }
        } else {
          worker.index++;
          setTimeout(() => startWorkerSegment(workerIndex), 5);
        }
      };

      const fallbackExtractor = (vid: HTMLVideoElement, frameIdx: number) => {
        try {
          const offscreenCanvas = document.createElement("canvas");
          offscreenCanvas.width = vid.videoWidth || 640;
          offscreenCanvas.height = vid.videoHeight || 360;
          const ctx = offscreenCanvas.getContext("2d");
          ctx?.drawImage(vid, 0, 0);

          const tex = new THREE.CanvasTexture(offscreenCanvas);
          tex.flipY = false;
          tex.minFilter = THREE.LinearFilter;
          tex.magFilter = THREE.LinearFilter;
          frameCacheRef.current[frameIdx] = tex;
          setCachedCount((prev) => prev + 1);
        } catch (err) {
          console.error("Frame canvas extraction fallback failed completely.", err);
        }
        worker.index++;
        setTimeout(() => startWorkerSegment(workerIndex), 5);
      };

      worker.video.addEventListener("seeked", handleWorkerSeeked);
      worker.video.addEventListener("loadedmetadata", () => {
        startWorkerSegment(workerIndex);
      });

      if (worker.video.readyState >= 1) {
        startWorkerSegment(workerIndex);
      }
    });

    previewVideo.addEventListener("loadedmetadata", () => {
      if (active) {
        setVideoLoaded(true);
        setErrorText(null);
      }
    });

    previewVideo.addEventListener("error", (err) => {
      console.error("Texture loader error on source URL:", err);
      if (active) {
        setErrorText("WebGL metadata connection denied. Verify CORS policies.");
      }
    });

    return () => {
      active = false;
      activeVideos.forEach((vid) => {
        if (vid.parentNode) {
          vid.parentNode.removeChild(vid);
        }
      });
      Object.values(frameCacheRef.current).forEach((tex) => tex.dispose());
      frameCacheRef.current = {};
    };
  }, [videoUrl]);

  // 2. Wire GSAP ScrollTrigger to track container body scrolls
  React.useEffect(() => {
    if (inputMode === "scroll" || inputMode === "both") {
      const trigger = ScrollTrigger.create({
        trigger: document.body,
        start: "top top",
        end: "bottom bottom",
        onUpdate: (self) => {
          targetProgress.current = self.progress;
        },
      });

      return () => {
        trigger.kill();
      };
    }
  }, [inputMode]);

  // Mouse drag and track progress swipe setup
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    isDraggingRef.current = true;
    containerRef.current?.setPointerCapture(e.pointerId);

    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      lastDragXRef.current = x;
      pointerXRef.current = x;
      pointerYRef.current = y;
      pointerHoveredRef.current = true;
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    // Convert relative normalized coordinates back to absolute pixel speeds
    // to match the exact mathematical force boundaries of the reference LiquidHover solver!
    const prevXPix = pointerXRef.current * rect.width;
    const prevYPix = pointerYRef.current * rect.height;
    const currXPix = x * rect.width;
    const currYPix = y * rect.height;

    pointerDxRef.current = 6.0 * (currXPix - prevXPix);
    pointerDyRef.current = 6.0 * (currYPix - prevYPix);

    pointerXRef.current = x;
    pointerYRef.current = y;
    pointerMovedRef.current = true;

    const dx = x - lastDragXRef.current;

    // Secondary virtual scroll gestures (swipe)
    if (isDraggingRef.current && (inputMode === "drag" || inputMode === "both")) {
      const progressDelta = dx * 0.32 * dragSensitivity;
      targetProgress.current = Math.max(0.0001, Math.min(0.9999, targetProgress.current + progressDelta));
    }

    lastDragXRef.current = x;
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      containerRef.current?.releasePointerCapture(e.pointerId);
    }
  };

  // Wheel scrubbing backup fallbacks
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (inputMode === "drag") return; // Let page native scroll proceed if mode is lock-dragged
    e.preventDefault();

    const scrollDelta = e.deltaY;
    const step = 0.00025 * scrollSensitivity;
    targetProgress.current = Math.max(0.0001, Math.min(0.9999, targetProgress.current + scrollDelta * step));
  };

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={(e) => {
        handlePointerUp(e);
        pointerMovedRef.current = false;
        pointerHoveredRef.current = false;
      }}
      onPointerLeave={(e) => {
        handlePointerUp(e);
        pointerMovedRef.current = false;
        pointerHoveredRef.current = false;
      }}
      onPointerEnter={() => {
        pointerHoveredRef.current = true;
      }}
      id="canvas-fullscreen-container"
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        background: "#0a0a0c",
        overflow: "hidden",
        borderRadius: "inherit",
        cursor: inputMode === "scroll" ? "default" : "grab",
      }}
    >
      {videoLoaded && !errorText && (
        <Canvas
          gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
          style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", display: "block" }}
        >
          <ScrubberScreen
            frameCacheRef={frameCacheRef}
            numFrames={NUM_FRAMES}
            targetProgress={targetProgress}
            currentProgress={currentProgress}
            currentVelocity={currentVelocity}
            springMass={springMass}
            springStiffness={springStiffness}
            springDamping={springDamping}
            chromaticAberration={chromaticAberration}
            warpDistortion={warpDistortion}
            scanlines={scanlines}
            showScanlines={showScanlines}
            onScrub={onScrub}
            pointerXRef={pointerXRef}
            pointerYRef={pointerYRef}
            pointerDxRef={pointerDxRef}
            pointerDyRef={pointerDyRef}
            pointerMovedRef={pointerMovedRef}
            pointerHoveredRef={pointerHoveredRef}
            fluidCursorSize={fluidCursorSize}
            fluidCursorPower={fluidCursorPower}
            fluidDistortionPower={fluidDistortionPower}
            fluidResolution={fluidResolution}
          />
        </Canvas>
      )}

      {/* Progress Caching HUD Overlay */}
      <div
        id="caching-hud"
        style={{
          position: "absolute",
          top: "24px",
          right: "24px",
          background: "rgba(10,10,12,0.76)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          padding: "8px 12px",
          borderRadius: "10px",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: "10px",
          color: cachedCount >= NUM_FRAMES ? "#6DD78C" : "#FF9800",
          letterSpacing: "0.05em",
          display: "flex",
          alignItems: "center",
          gap: "6px",
          pointerEvents: "none",
          boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
          border: `1px solid ${cachedCount >= NUM_FRAMES ? "rgba(109,215,140,0.15)" : "rgba(255,152,0,0.15)"}`,
          zIndex: 5,
        }}
      >
        <span
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            backgroundColor: cachedCount >= NUM_FRAMES ? "#6DD78C" : "#FF9800",
            display: "inline-block",
          }}
        />
        <span>{cachedCount >= NUM_FRAMES ? `WEBP READY (80/80)` : `LAZY WEBP PRE-CACHE: ${cachedCount}/80`}</span>
      </div>

      {!videoLoaded && !errorText && (
        <div
          id="loading-spinner-overlay"
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "12px",
            color: "#666",
            letterSpacing: "0.08em",
            pointerEvents: "none",
            textAlign: "center",
            zIndex: 10,
          }}
        >
          <motion.div
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
          >
            INITIALIZING CORE MEDIA PIPELINE...
          </motion.div>
        </div>
      )}

      {errorText && (
        <div
          id="error-msg-overlay"
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "11px",
            color: "#ff4444",
            padding: "16px",
            borderRadius: "12px",
            background: "rgba(18, 18, 18, 0.95)",
            border: "1px solid rgba(255, 68, 68, 0.2)",
            maxWidth: "80%",
            textAlign: "center",
            zIndex: 100,
          }}
        >
          <div style={{ fontWeight: "bold", marginBottom: "4px" }}>TEXTURE PIPELINE ERROR</div>
          <div>{errorText}</div>
        </div>
      )}
    </div>
  );
}

// --- SCRUBBER SCREEN COMPOSITOR COMPONENT (RUNS INSIDE THE R3F RENDER CYCLE) ---

// --- GPGPU FLUID NAVIER-STOKES SHADER PROGRAM PASSES ---

const FRAG_POINT = `
precision highp float;
varying vec2 vUv;
uniform sampler2D u_input_texture;
uniform float u_ratio;
uniform vec3 u_point_value;
uniform vec2 u_point;
uniform float u_point_size;

void main () {
  vec2 p = vUv - u_point;
  p.x *= u_ratio;
  vec3 splat = 0.6 * pow(2.0, -dot(p, p) / u_point_size) * u_point_value;
  vec3 base = texture2D(u_input_texture, vUv).xyz;
  gl_FragColor = vec4(base + splat, 1.0);
}
`;

const FRAG_DIVERGENCE = `
precision highp float;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform sampler2D u_velocity_texture;

void main () {
  float L = texture2D(u_velocity_texture, vL).x;
  float R = texture2D(u_velocity_texture, vR).x;
  float T = texture2D(u_velocity_texture, vT).y;
  float B = texture2D(u_velocity_texture, vB).y;
  float div = 0.25 * (R - L + T - B);
  gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
}
`;

const FRAG_PRESSURE = `
precision highp float;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform sampler2D u_pressure_texture;
uniform sampler2D u_divergence_texture;

void main () {
  float L = texture2D(u_pressure_texture, vL).x;
  float R = texture2D(u_pressure_texture, vR).x;
  float T = texture2D(u_pressure_texture, vT).x;
  float B = texture2D(u_pressure_texture, vB).x;
  float divergence = texture2D(u_divergence_texture, vUv).x;
  float pressure = (L + R + B + T - divergence) * 0.25;
  gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
}
`;

const FRAG_GRAD_SUB = `
precision highp float;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform sampler2D u_pressure_texture;
uniform sampler2D u_velocity_texture;

void main () {
  float L = texture2D(u_pressure_texture, vL).x;
  float R = texture2D(u_pressure_texture, vR).x;
  float T = texture2D(u_pressure_texture, vT).x;
  float B = texture2D(u_pressure_texture, vB).x;
  vec2 velocity = texture2D(u_velocity_texture, vUv).xy;
  velocity.xy -= vec2(R - L, T - B);
  gl_FragColor = vec4(velocity, 0.0, 1.0);
}
`;

const FRAG_ADVECT = `
precision highp float;
varying vec2 vUv;
uniform sampler2D u_velocity_texture;
uniform sampler2D u_input_texture;
uniform vec2 u_texel;
uniform vec2 u_output_textel;
uniform float u_dt;
uniform float u_dissipation;

vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
  vec2 st = uv / tsize - 0.5;
  vec2 iuv = floor(st);
  vec2 fuv = fract(st);
  vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
  vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
  vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
  vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
  return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
}

void main () {
  vec2 coord = vUv - u_dt * bilerp(u_velocity_texture, vUv, u_texel).xy * u_texel;
  vec4 velocity = bilerp(u_input_texture, coord, u_output_textel);
  gl_FragColor = u_dissipation * velocity;
}
`;

// --- THREE.JS HIGH PERFORMANCE GPGPU LIQUID SOLVER CLASS ---

class ThreeFluidSolver {
  gl: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  quad: THREE.Mesh;
  res: { w: number; h: number };
  texel: THREE.Vector2;
  velocity: { read: THREE.WebGLRenderTarget; write: THREE.WebGLRenderTarget; swap: () => void };
  dye: { read: THREE.WebGLRenderTarget; write: THREE.WebGLRenderTarget; swap: () => void };
  pressure: { read: THREE.WebGLRenderTarget; write: THREE.WebGLRenderTarget; swap: () => void };
  divergence: THREE.WebGLRenderTarget;

  splatMat: THREE.ShaderMaterial;
  divMat: THREE.ShaderMaterial;
  pressureMat: THREE.ShaderMaterial;
  gradSubMat: THREE.ShaderMaterial;
  advectMat: THREE.ShaderMaterial;

  constructor(gl: THREE.WebGLRenderer, res: { w: number; h: number }) {
    this.gl = gl;
    this.res = res;
    this.texel = new THREE.Vector2(1 / res.w, 1 / res.h);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geom = new THREE.PlaneGeometry(2, 2);
    this.quad = new THREE.Mesh(geom);
    this.scene.add(this.quad);

    const createDoubleRT = () => {
      const rt1 = new THREE.WebGLRenderTarget(res.w, res.h, {
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
      });
      const rt2 = rt1.clone();
      
      const obj = {
        read: rt1,
        write: rt2,
        swap: () => {
          const tmp = obj.read;
          obj.read = obj.write;
          obj.write = tmp;
        },
      };
      return obj;
    };

    this.velocity = createDoubleRT();
    this.dye = createDoubleRT();
    this.pressure = createDoubleRT();
    this.divergence = new THREE.WebGLRenderTarget(res.w, res.h, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });

    const vert = `
      varying vec2 vUv;
      varying vec2 vL;
      varying vec2 vR;
      varying vec2 vT;
      varying vec2 vB;
      uniform vec2 u_texel;
      void main() {
        vUv = uv;
        vL = vUv - vec2(u_texel.x, 0.0);
        vR = vUv + vec2(u_texel.x, 0.0);
        vT = vUv + vec2(0.0, u_texel.y);
        vB = vUv - vec2(0.0, u_texel.y);
        gl_Position = vec4(position, 1.0);
      }
    `;

    this.splatMat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: FRAG_POINT,
      uniforms: {
        u_texel: { value: this.texel },
        u_input_texture: { value: null },
        u_ratio: { value: 1 },
        u_point_value: { value: new THREE.Vector3() },
        u_point: { value: new THREE.Vector2() },
        u_point_size: { value: 0.001 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.divMat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: FRAG_DIVERGENCE,
      uniforms: {
        u_texel: { value: this.texel },
        u_velocity_texture: { value: null },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.pressureMat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: FRAG_PRESSURE,
      uniforms: {
        u_texel: { value: this.texel },
        u_pressure_texture: { value: null },
        u_divergence_texture: { value: null },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.gradSubMat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: FRAG_GRAD_SUB,
      uniforms: {
        u_texel: { value: this.texel },
        u_pressure_texture: { value: null },
        u_velocity_texture: { value: null },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.advectMat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: FRAG_ADVECT,
      uniforms: {
        u_texel: { value: this.texel },
        u_output_textel: { value: this.texel },
        u_velocity_texture: { value: null },
        u_input_texture: { value: null },
        u_dt: { value: 0.016 },
        u_dissipation: { value: 0.98 },
      },
      depthTest: false,
      depthWrite: false,
    });
  }

  renderPass(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = material;
    const prevTarget = this.gl.getRenderTarget();
    this.gl.setRenderTarget(target);
    this.gl.render(this.scene, this.camera);
    this.gl.setRenderTarget(prevTarget);
  }

  splat(point: THREE.Vector2, force: THREE.Vector3, size: number, ratio: number) {
    // 1. Splat Velocity force
    this.splatMat.uniforms.u_input_texture.value = this.velocity.read.texture;
    this.splatMat.uniforms.u_ratio.value = ratio;
    this.splatMat.uniforms.u_point.value.copy(point);
    this.splatMat.uniforms.u_point_value.value.copy(force);
    this.splatMat.uniforms.u_point_size.value = size;
    this.renderPass(this.splatMat, this.velocity.write);
    this.velocity.swap();

    // 2. Splat Dye concentration density
    this.splatMat.uniforms.u_input_texture.value = this.dye.read.texture;
    this.splatMat.uniforms.u_point_value.value.set(force.z, 0, 0); // density scalar mapping
    this.renderPass(this.splatMat, this.dye.write);
    this.dye.swap();
  }

  step(dt: number) {
    // 1. Compute velocity field divergence
    this.divMat.uniforms.u_velocity_texture.value = this.velocity.read.texture;
    this.renderPass(this.divMat, this.divergence);

    // 2. Jacobi Poisson pressure iterations
    for (let i = 0; i < 16; i++) {
      this.pressureMat.uniforms.u_pressure_texture.value = this.pressure.read.texture;
      this.pressureMat.uniforms.u_divergence_texture.value = this.divergence.texture;
      this.renderPass(this.pressureMat, this.pressure.write);
      this.pressure.swap();
    }

    // 3. Subtract pressure gradient from velocity
    this.gradSubMat.uniforms.u_pressure_texture.value = this.pressure.read.texture;
    this.gradSubMat.uniforms.u_velocity_texture.value = this.velocity.read.texture;
    this.renderPass(this.gradSubMat, this.velocity.write);
    this.velocity.swap();

    // 4. Advect velocity field over itself
    this.advectMat.uniforms.u_velocity_texture.value = this.velocity.read.texture;
    this.advectMat.uniforms.u_input_texture.value = this.velocity.read.texture;
    this.advectMat.uniforms.u_dt.value = dt;
    this.advectMat.uniforms.u_dissipation.value = 0.97;
    this.renderPass(this.advectMat, this.velocity.write);
    this.velocity.swap();

    // 5. Advect dye density flow
    this.advectMat.uniforms.u_velocity_texture.value = this.velocity.read.texture;
    this.advectMat.uniforms.u_input_texture.value = this.dye.read.texture;
    this.advectMat.uniforms.u_dt.value = dt * 8.0;
    this.advectMat.uniforms.u_dissipation.value = 0.98;
    this.renderPass(this.advectMat, this.dye.write);
    this.dye.swap();
  }

  dispose() {
    this.velocity.read.dispose();
    this.velocity.write.dispose();
    this.dye.read.dispose();
    this.dye.write.dispose();
    this.pressure.read.dispose();
    this.pressure.write.dispose();
    this.divergence.dispose();
    this.splatMat.dispose();
    this.divMat.dispose();
    this.pressureMat.dispose();
    this.gradSubMat.dispose();
    this.advectMat.dispose();
    this.quad.geometry.dispose();
  }
}

// --- SCRUBBER SCREEN COMPOSITOR COMPONENT (RUNS INSIDE THE R3F RENDER CYCLE) ---

interface ScrubberScreenProps {
  frameCacheRef: React.RefObject<{ [key: number]: THREE.Texture }>;
  numFrames: number;
  targetProgress: React.MutableRefObject<number>;
  currentProgress: React.MutableRefObject<number>;
  currentVelocity: React.MutableRefObject<number>;
  springMass: number;
  springStiffness: number;
  springDamping: number;
  chromaticAberration: number;
  warpDistortion: number;
  scanlines: number;
  showScanlines: boolean;
  onScrub?: (prog: number) => void;

  // Fluid tracker refs
  pointerXRef: React.MutableRefObject<number>;
  pointerYRef: React.MutableRefObject<number>;
  pointerDxRef: React.MutableRefObject<number>;
  pointerDyRef: React.MutableRefObject<number>;
  pointerMovedRef: React.MutableRefObject<boolean>;
  pointerHoveredRef: React.MutableRefObject<boolean>;
  fluidCursorSize: number;
  fluidCursorPower: number;
  fluidDistortionPower: number;
  fluidResolution: number;
}

function ScrubberScreen(props: ScrubberScreenProps) {
  const {
    frameCacheRef,
    numFrames,
    targetProgress,
    currentProgress,
    currentVelocity,
    springMass,
    springStiffness,
    springDamping,
    chromaticAberration,
    warpDistortion,
    scanlines,
    showScanlines,
    onScrub,
    pointerXRef,
    pointerYRef,
    pointerDxRef,
    pointerDyRef,
    pointerMovedRef,
    pointerHoveredRef,
    fluidCursorSize,
    fluidCursorPower,
    fluidDistortionPower,
    fluidResolution,
  } = props;

  const { gl, size } = useThree();

  const materialRef = React.useRef<THREE.ShaderMaterial>(null);

  // Initialize the Double-Buffered GPGPU Navier-Stokes Flow Solver
  const fluidSolver = React.useMemo(() => {
    const baseResolution = 128 + ((fluidResolution - 1) * (512 - 128)) / 9;
    const aspect = size.width / Math.max(1, size.height);
    const res = {
      w: Math.round(baseResolution * aspect),
      h: Math.round(baseResolution),
    };
    return new ThreeFluidSolver(gl, res);
  }, [fluidResolution, size.width, size.height, gl]);

  React.useEffect(() => {
    return () => {
      fluidSolver.dispose();
    };
  }, [fluidSolver]);

  // Composition Shader mapping dynamic frame sequence with fluid displacement and chromatic aberrations
  const compositorMaterial = React.useMemo(() => {
    return new THREE.ShaderMaterial({
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        uniform sampler2D uTexture;         // Preloaded scroll video frame texture
        uniform sampler2D uFluidVelocity;   // GPGPU advection velocity vector texture
        uniform sampler2D uFluidDye;        // GPGPU dye density intensity texture
        uniform float uFluidDistortionPower;

        uniform float uTime;
        uniform float uScrubVelocity;       // Dynamic spring speed
        uniform float uWarpDistortion;      // Zoom index
        uniform float uChromaticAberration; // RGB Split factor
        uniform float uScanlines;           // Holographic lines
        uniform vec2 uCanvasResolution;
        uniform vec2 uTextureResolution;

        float random(vec2 st) {
          return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123);
        }

        void main() {
          // 1. Process continuous GPGPU fluid warp vectors
          vec2 fluidVelocity = texture2D(uFluidVelocity, vUv).xy;
          float fluidDye = texture2D(uFluidDye, vUv).r;

          // Apply fluid vector coefficients to displacement channels based directly on LiquidHover's equation:
          // u_disturb_power * normalize(velocity) * offset
          // Here, fluidVelocity is the flow vector direction and fluidDye is the density magnitude.
          vec2 fluidDistort = normalize(fluidVelocity + 0.0001) * fluidDye * uFluidDistortionPower * 0.12;
          vec2 uv = clamp(vUv - fluidDistort, 0.001, 0.999);

          // Cover crop fitting algorithms (Aspect Ratio Fit)
          float canvasAspect = uCanvasResolution.x / uCanvasResolution.y;
          float textureAspect = uTextureResolution.x / uTextureResolution.y;

          if (canvasAspect > textureAspect) {
            float scale = textureAspect / canvasAspect;
            uv.y = (uv.y - 0.5) * scale + 0.5;
          } else {
            float scale = canvasAspect / textureAspect;
            uv.x = (uv.x - 0.5) * scale + 0.5;
          }

          // Crop clamps
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
            gl_FragColor = vec4(0.04, 0.04, 0.05, 1.0);
            return;
          }

          // Refractive Displacement Coordinates
          vec2 center = vec2(0.5);
          vec2 toCenter = uv - center;
          float dist = length(toCenter);
          
          // Dynamic zoom warp based on scrub acceleration/speed
          float warp = 1.0 + sin(dist * 6.5 - uTime * 2.0) * (abs(uScrubVelocity) * uWarpDistortion * 0.12);
          vec2 finalDistortedUv = center + toCenter * warp;

          finalDistortedUv = clamp(finalDistortedUv, 0.001, 0.999);

          // Radial Chromatic Aberration based on speed or aberration setting
          vec2 toCenterDir = normalize(toCenter + 0.0001);
          float dispersion = uChromaticAberration * 0.008 * (1.0 + abs(uScrubVelocity) * 0.5);

          vec2 finalUvFlipped = vec2(finalDistortedUv.x, 1.0 - finalDistortedUv.y);

          vec3 col;
          col.r = texture2D(uTexture, finalUvFlipped + toCenterDir * dispersion).r;
          col.g = texture2D(uTexture, finalUvFlipped).g;
          col.b = texture2D(uTexture, finalUvFlipped - toCenterDir * dispersion).b;

          // Blend cinematic fluid dye highlights onto image
          vec3 neonTealGlow = vec3(0.0, 0.72, 1.0) * fluidDye * 0.45;
          col += neonTealGlow;

          // Subtle retro scanner grids overlay
          if (uScanlines > 0.01) {
            float scanline = sin(finalDistortedUv.y * uCanvasResolution.y * 1.6) * 0.5 + 0.5;
            col = mix(col, col * (0.8 + 0.2 * scanline), uScanlines);
          }

          // Subtle analog grains
          float grain = (random(vUv + vec2(uTime * 0.001)) - 0.5) * 0.024;
          col += grain;

          // Classic dark edge diagnostic vignettes
          float vignette = smoothstep(1.2, 0.35, dist);
          col *= mix(0.4, 1.0, vignette);

          gl_FragColor = vec4(col, 1.0);
        }
      `,
      uniforms: {
        uTexture: { value: null },
        uTime: { value: 0 },
        uScrubVelocity: { value: 0 },
        uWarpDistortion: { value: warpDistortion },
        uChromaticAberration: { value: chromaticAberration },
        uScanlines: { value: showScanlines ? scanlines : 0.0 },
        uCanvasResolution: { value: new THREE.Vector2(size.width, size.height) },
        uTextureResolution: { value: new THREE.Vector2(1280, 720) },

        // Navier-Stokes additions
        uFluidVelocity: { value: null },
        uFluidDye: { value: null },
        uFluidDistortionPower: { value: fluidDistortionPower },
      },
    });
  }, [size.width, size.height, fluidSolver, fluidDistortionPower]);

  // Synchronize dynamic Canvas dimension shifts on the fly
  React.useEffect(() => {
    compositorMaterial.uniforms.uCanvasResolution.value.set(size.width, size.height);
  }, [size.width, size.height, compositorMaterial]);

  // ThreeJS per-frame updates tick callback
  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.03); // Avoid mathematical numerical spikes on window pause

    // 1. GPGPU Splatting on active pointer movements
    if (pointerMovedRef.current) {
      const u = pointerXRef.current;
      const v = 1.0 - pointerYRef.current;

      const cursorPowerValue = 5.0 + ((fluidCursorPower - 0.1) * (50.0 - 5.0)) / (1.0 - 0.1);
      const forceVector = new THREE.Vector3(
        pointerDxRef.current,
        -pointerDyRef.current,
        cursorPowerValue * 0.001 // Match exact density scale of LiquidHover to avoid layer saturation!
      );

      const splatRadius = (0.5 + ((fluidCursorSize - 0.1) * (5.0 - 0.5)) / (1.0 - 0.1)) * 0.001;
      const aspect = size.width / Math.max(1, size.height);

      fluidSolver.splat(new THREE.Vector2(u, v), forceVector, splatRadius, aspect);
      pointerMovedRef.current = false; // Reset to buffer next coordinate shifts
    }

    // 2. Perform Navier-Stokes mathematical step
    fluidSolver.step(dt);

    // 3. Pipe solver textures directly to compositor units
    compositorMaterial.uniforms.uFluidVelocity.value = fluidSolver.velocity.read.texture;
    compositorMaterial.uniforms.uFluidDye.value = fluidSolver.dye.read.texture;
    compositorMaterial.uniforms.uFluidDistortionPower.value = fluidDistortionPower;

    // 4. Hooke's Law Newtonian Spring Equations
    const displacement = targetProgress.current - currentProgress.current;
    
    // Spring Force = stiffness * displacement - damping * velocity
    const forceSpring = displacement * springStiffness;
    const forceDamping = currentVelocity.current * springDamping;
    const totalForce = forceSpring - forceDamping;

    // Acceleration = Force / mass
    const acceleration = totalForce / springMass;

    currentVelocity.current += acceleration * dt;
    currentProgress.current += currentVelocity.current * dt;

    // Boundary constraints clamp
    currentProgress.current = Math.max(0.0001, Math.min(0.9999, currentProgress.current));

    const smoothedProgress = currentProgress.current;

    // 5. Map the chronological frame index
    const index = Math.round(smoothedProgress * (numFrames - 1));
    let texture = frameCacheRef.current?.[index];

    // Search nearest fallback if frame is still buffering
    if (!texture && frameCacheRef.current) {
      let nearestDist = Infinity;
      let nearestIdx = -1;
      const keys = Object.keys(frameCacheRef.current);
      for (let i = 0; i < keys.length; i++) {
        const keyVal = parseInt(keys[i], 10);
        const distance = Math.abs(keyVal - index);
        if (distance < nearestDist) {
          nearestDist = distance;
          nearestIdx = keyVal;
        }
      }
      if (nearestIdx !== -1) {
        texture = frameCacheRef.current[nearestIdx];
      }
    }

    // 6. Pipe parameters to compositor materials
    if (texture) {
      compositorMaterial.uniforms.uTexture.value = texture;
      // Get resolution from video texture if loaded
      const img = texture.image as any;
      if (img && (img.width || img.videoWidth)) {
        compositorMaterial.uniforms.uTextureResolution.value.set(
          img.width || img.videoWidth || 1280,
          img.height || img.videoHeight || 720
        );
      }
    }

    compositorMaterial.uniforms.uTime.value = state.clock.getElapsedTime();
    compositorMaterial.uniforms.uScrubVelocity.value = currentVelocity.current;

    // Sync state values on dials flybys
    compositorMaterial.uniforms.uWarpDistortion.value = warpDistortion;
    compositorMaterial.uniforms.uChromaticAberration.value = chromaticAberration;
    compositorMaterial.uniforms.uScanlines.value = showScanlines ? scanlines : 0.0;

    // Synchronize HUD progress values
    if (onScrub) {
      onScrub(smoothedProgress);
    }
  });

  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <primitive object={compositorMaterial} ref={materialRef} attach="material" />
    </mesh>
  );
}

// --- FRAMER PROPERTY CONTROLS DEFINITION ---
try {
  addPropertyControls(VideoScrubWebGL, {
    videoUrl: {
      type: ControlType.String,
      title: "Video Link",
      defaultValue: "https://res.cloudinary.com/dkemjl9se/video/upload/v1780345662/First-person_discovery_lake_vall__202606012155_bhyhue.mp4",
    },
    inputMode: {
      type: ControlType.Enum,
      title: "Control Input",
      options: ["scroll", "drag", "both"],
      optionTitles: ["Page Scroll", "Drag Swipe", "Scroll & Drag"],
      defaultValue: "both",
    },
    dragSensitivity: {
      type: ControlType.Number,
      title: "Drag Factor",
      min: 0.1,
      max: 5.0,
      step: 0.1,
      defaultValue: 1.5,
    },
    scrollSensitivity: {
      type: ControlType.Number,
      title: "Scroll Factor",
      min: 0.1,
      max: 5.0,
      step: 0.1,
      defaultValue: 1.0,
    },
    springMass: {
      type: ControlType.Number,
      title: "Spring Mass",
      min: 0.1,
      max: 5.0,
      step: 0.1,
      defaultValue: 1.0,
    },
    springStiffness: {
      type: ControlType.Number,
      title: "Stiffness",
      min: 10,
      max: 500,
      step: 10,
      defaultValue: 120,
    },
    springDamping: {
      type: ControlType.Number,
      title: "Damping",
      min: 5,
      max: 100,
      step: 5,
      defaultValue: 25,
    },
    chromaticAberration: {
      type: ControlType.Number,
      title: "Aberration",
      min: 0.0,
      max: 3.0,
      step: 0.1,
      defaultValue: 0.5,
    },
    warpDistortion: {
      type: ControlType.Number,
      title: "Pinch Warp",
      min: 0.0,
      max: 3.0,
      step: 0.1,
      defaultValue: 0.6,
    },
    showScanlines: {
      type: ControlType.Boolean,
      title: "Scanlines Enable",
      defaultValue: true,
    },
    scanlines: {
      type: ControlType.Number,
      title: "Scanline Mix",
      min: 0.0,
      max: 1.0,
      step: 0.05,
      defaultValue: 0.3,
      hidden(props) {
        return !props.showScanlines;
      },
    },
    loopPlayback: {
      type: ControlType.Boolean,
      title: "Loop Seek bounds",
      defaultValue: true,
    },
    fluidCursorSize: {
      type: ControlType.Number,
      title: "Fluid Cursor Size",
      min: 0.1,
      max: 1.0,
      step: 0.05,
      defaultValue: 1.0,
    },
    fluidCursorPower: {
      type: ControlType.Number,
      title: "Fluid Force",
      min: 0.1,
      max: 1.0,
      step: 0.05,
      defaultValue: 1.0,
    },
    fluidDistortionPower: {
      type: ControlType.Number,
      title: "Fluid Warp",
      min: 0.0,
      max: 2.0,
      step: 0.05,
      defaultValue: 2.0,
    },
    fluidResolution: {
      type: ControlType.Number,
      title: "Fluid Resolution",
      min: 1,
      max: 10,
      step: 1,
      defaultValue: 4,
    }
  });
} catch (e) {
  // Gracefully skip adding property controls outside of Framer's editor thread environment.
}

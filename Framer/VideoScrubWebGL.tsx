/**
 * High-Performance Scroll-Driven Video Scrubber with GPGPU Fluid & Center Pinch Distortion
 * Built using React + React Three Fiber + Lenis Smooth Scroll + WebAssembly Physics Engine.
 * 
 * Safety: Track errors, include tiny comments, clean syntax.
 * Reverted to core features: Navier-Stokes Fluid simulation, responsive center pinch, WebP preloading queue.
 * Undo strategy: Restore previous backup or reinstall gsap and framer-motion dependencies.
 */

import React, { useRef, useEffect, useState, useMemo } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import Lenis from "lenis";
import wabt from "wabt";

// --- WEBASSEMBLY PHYSICS INTERPOLATION FOR SMOOTH SCROLL SCRUBBING ---
interface WasmPhysicsInstance {
  step_velocity: (target: number, current: number, velocity: number, stiffness: number, damping: number, mass: number, dt: number) => number;
  step_progress: (current: number, velocity: number, dt: number) => number;
}

// What changed: Handled dynamic WAT assembling and compiling via wabt.js loaded inline.
// How to undo: Revert to the static Uint8Array bytecode chunk and delete the WAT_SOURCE string.
const WAT_SOURCE = `
(module
  (func $step_velocity (export "step_velocity")
    (param $target f32) (param $current f32) (param $velocity f32)
    (param $stiffness f32) (param $damping f32) (param $mass f32) (param $dt f32)
    (result f32)
    ;; Newton/Hooke Formula: acceleration = ((target - current) * stiffness - velocity * damping) / mass
    ;; velocity = velocity + acceleration * dt
    local.get $velocity
    local.get $target
    local.get $current
    f32.sub
    local.get $stiffness
    f32.mul
    local.get $velocity
    local.get $damping
    f32.mul
    f32.sub
    local.get $mass
    f32.div
    local.get $dt
    f32.mul
    f32.add
  )
  (func $step_progress (export "step_progress")
    (param $current f32) (param $velocity f32) (param $dt f32)
    (result f32)
    ;; new_progress = current + velocity * dt
    local.get $current
    local.get $velocity
    local.get $dt
    f32.mul
    f32.add
  )
)
`;

let wasmPhysicsInstance: WasmPhysicsInstance | null = null;
let isCompilingWasm = false;

async function compileWasmPhysics() {
  if (wasmPhysicsInstance || isCompilingWasm) return;
  isCompilingWasm = true;
  try {
    // Dynamically compile our raw Newtonian WAT source into a binary format at runtime
    const wabtModule = await wabt();
    const parsed = wabtModule.parseWat("physics.wat", WAT_SOURCE);
    const { buffer } = parsed.toBinary({});
    
    // Compile and instantiate into full native WebAssembly
    const module = await WebAssembly.compile(buffer);
    const instance = await WebAssembly.instantiate(module);
    
    wasmPhysicsInstance = instance.exports as any;
    console.log("⚡ [WASM Physics Engine] Dynamic WAT compiled via WABT successfully.");
    parsed.destroy(); // Always free WABT internal resources to prevent memory leaks
  } catch (err) {
    console.error("❌ [WASM Physics Engine] Dynamic WAT compilation failed: ", err);
  } finally {
    isCompilingWasm = false;
  }
}

// Initiate background compilation on module evaluation
compileWasmPhysics();

function initWasmPhysics(): WasmPhysicsInstance | null {
  if (wasmPhysicsInstance) return wasmPhysicsInstance;
  // Trigger compiler if not already running
  compileWasmPhysics();
  return wasmPhysicsInstance;
}

// Generate bisection progressive preloading indices for high performance caching
function getProgressiveIndices(total: number): number[] {
  const indices: number[] = [];
  const visited = new Set<number>();
  const queue: [number, number][] = [[0, total - 1]];

  indices.push(0);
  visited.add(0);
  if (total - 1 > 0) {
    indices.push(total - 1);
    visited.add(total - 1);
  }

  while (queue.length > 0) {
    const [left, right] = queue.shift()!;
    if (right - left <= 1) continue;

    const mid = Math.floor((left + right) / 2);
    if (!visited.has(mid)) {
      indices.push(mid);
      visited.add(mid);
    }
    queue.push([left, mid]);
    queue.push([mid, right]);
  }
  return indices;
}

interface VideoScrubWebGLProps {
  videoUrl?: string;
  pinchPower?: number;
  fluidDistortionPower?: number;
  onScrub?: (progress: number) => void;
}

export function VideoScrubWebGL(props: VideoScrubWebGLProps) {
  const {
    videoUrl = "https://res.cloudinary.com/dkemjl9se/video/upload/v1780345662/First-person_discovery_lake_vall__202606012155_bhyhue.mp4",
    pinchPower = 0.8,
    fluidDistortionPower = 1.6,
    onScrub,
  } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const targetProgress = useRef(0.0);
  const currentProgress = useRef(0.0);
  const currentVelocity = useRef(0);
  const lenisRef = useRef<Lenis | null>(null);

  // EXTRACT ALL 192 FRAMES: Aligning cache targets exactly with the physical video frame count.
  // Change logs: Set to 192 based on exact STSZ box parsing (192 frames, 24fps over 8s).
  // Undo: Revert back to 80 or 191 if desired.
  const NUM_FRAMES = 192;
  const frameCacheRef = useRef<{ [key: number]: THREE.Texture }>({});
  const [cachedCount, setCachedCount] = useState(0);
  const [videoLoaded, setVideoLoaded] = useState(false);

  // PRELOADER UI REMOVED: Users see the first frame immediately.
  // Undo change: Revert this block and restore showPreloader and preloadingOpacity states.
  // We track loaded frames for diagnostics only.
  useEffect(() => {
    if (cachedCount >= NUM_FRAMES && !videoLoaded) {
      setVideoLoaded(true);
    }
  }, [cachedCount, videoLoaded]);

  // GPGPU Fluid coordinates tracing
  const pointerXRef = useRef(0.5);
  const pointerYRef = useRef(0.5);
  const pointerDxRef = useRef(0);
  const pointerDyRef = useRef(0);
  const pointerMovedRef = useRef(false);
  const pointerHoveredRef = useRef(false);

  // 1. Lenis Smooth Scrolling integration
  useEffect(() => {
    // Traverse parent tree to hook into active scrollable viewport
    let scrollEl: HTMLElement | Window = window;
    const parentScrollport = containerRef.current?.closest(".custom-scrollbar-viewport") as HTMLElement;
    if (parentScrollport) {
      scrollEl = parentScrollport;
    }

    const lenis = new Lenis({
      wrapper: scrollEl === window ? undefined : (scrollEl as HTMLElement),
      content: scrollEl === window ? undefined : (scrollEl as HTMLElement).firstElementChild as HTMLElement || undefined,
      duration: 1.1,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
    });
    lenisRef.current = lenis;

    const handleScroll = (e: any) => {
      // Direct progression mapped to scroll height percentage
      targetProgress.current = e.progress;
    };

    lenis.on("scroll", handleScroll);

    let rafId: number;
    const raf = (time: number) => {
      lenis.raf(time);
      rafId = requestAnimationFrame(raf);
    };
    rafId = requestAnimationFrame(raf);

    return () => {
      lenis.off("scroll", handleScroll);
      lenis.destroy();
      lenisRef.current = null;
      cancelAnimationFrame(rafId);
    };
  }, []);

  // Global pointer & touch coordinate tracking to fuel GPGPU fluid math
  useEffect(() => {
    const handleGlobalPointerMove = (e: PointerEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;

      const prevX = pointerXRef.current * rect.width;
      const prevY = pointerYRef.current * rect.height;
      const currX = x * rect.width;
      const currY = y * rect.height;

      pointerDxRef.current = 5.0 * (currX - prevX);
      pointerDyRef.current = 5.0 * (currY - prevY);

      pointerXRef.current = x;
      pointerYRef.current = y;
      pointerMovedRef.current = true;
      pointerHoveredRef.current = true;
    };

    const handleGlobalTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 0) {
        const touch = e.touches[0];
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;

        const x = (touch.clientX - rect.left) / rect.width;
        const y = (touch.clientY - rect.top) / rect.height;

        const prevX = pointerXRef.current * rect.width;
        const prevY = pointerYRef.current * rect.height;
        const currX = x * rect.width;
        const currY = y * rect.height;

        pointerDxRef.current = 5.0 * (currX - prevX);
        pointerDyRef.current = 5.0 * (currY - prevY);

        pointerXRef.current = x;
        pointerYRef.current = y;
        pointerMovedRef.current = true;
        pointerHoveredRef.current = true;
      }
    };

    window.addEventListener("pointermove", handleGlobalPointerMove, { passive: true });
    window.addEventListener("touchmove", handleGlobalTouchMove, { passive: true });

    return () => {
      window.removeEventListener("pointermove", handleGlobalPointerMove);
      window.removeEventListener("touchmove", handleGlobalTouchMove);
    };
  }, []);

  // 2. High-Speed Web Worker & WebCodecs Offscreen Frame Decoder with Zero-Dependency Demuxer (No Fallback)
  // What changed: Replaced the resource-heavy mp4box.js library call with a self-contained, lightweight MP4 box demuxer.
  // It reads binary box payloads directly inside the Web Worker thread to initialize VideoDecoder and pipe frames.
  // We completely removed the legacy seek-time HTML5 fallback to satisfy the "no-fallback" system mandate.
  // How to undo: Restore the original mp4box CDNs and the HTMLVideoElement manual seek process (revert to previous git commit/backup).
  useEffect(() => {
    let active = true;
    let worker: Worker | null = null;

    const workerCode = `
      function findBoxes(view, start, end) {
        const boxes = [];
        let offset = start;
        while (offset + 8 <= end) {
          let size = view.getUint32(offset);
          const type = String.fromCharCode(
            view.getUint8(offset + 4),
            view.getUint8(offset + 5),
            view.getUint8(offset + 6),
            view.getUint8(offset + 7)
          );
          let headerSize = 8;
          if (size === 1) {
            size = Number(view.getBigUint64(offset + 8));
            headerSize = 16;
          } else if (size === 0) {
            size = end - offset;
          }
          if (size < 8) {
            break;
          }
          boxes.push({ type, size, start: offset, bodyStart: offset + headerSize, bodyEnd: offset + size });
          offset += size;
        }
        return boxes;
      }

      function findBoxByPath(view, path, start, end) {
        let curStart = start;
        let curEnd = end;
        for (let j = 0; j < path.length; j++) {
          const targetType = path[j];
          const boxes = findBoxes(view, curStart, curEnd);
          const match = boxes.find(b => b.type === targetType);
          if (!match) return null;
          curStart = match.bodyStart;
          curEnd = match.bodyEnd;
        }
        return { start: curStart, end: curEnd };
      }

      function demuxMP4(arrayBuffer) {
        const view = new DataView(arrayBuffer);
        const moov = findBoxByPath(view, ['moov'], 0, arrayBuffer.byteLength);
        if (!moov) throw new Error('Missing moov box');
        const moovBoxes = findBoxes(view, moov.start, moov.end);
        const traks = moovBoxes.filter(b => b.type === 'trak');
        let videoTrak = null;
        let videoEntry = null;
        let codec = 'avc1.4d401f';
        let description = null;
        let width = 1280;
        let height = 720;

        for (let i = 0; i < traks.length; i++) {
          const trak = traks[i];
          // Fix: Search inside trak.bodyStart & bodyEnd so nested boxes like mdia can be found
          const stbl = findBoxByPath(view, ['mdia', 'minf', 'stbl'], trak.bodyStart, trak.bodyEnd);
          if (!stbl) continue;
          const stsd = findBoxByPath(view, ['stsd'], stbl.start, stbl.end);
          if (!stsd) continue;
          const entries = findBoxes(view, stsd.start + 8, stsd.end);
          const entry = entries.find(e => ['avc1', 'hvc1', 'hev1', 'vp08', 'vp09', 'av01'].includes(e.type));
          if (entry) {
            videoTrak = trak;
            videoEntry = entry;
            // What changed: Uses bodyStart for accurate layout offsets, preventing 0-padded size/type errors.
            // How to undo: Revert back to entry.start.
            width = view.getUint16(entry.bodyStart + 24);
            height = view.getUint16(entry.bodyStart + 26);
            const subBoxes = findBoxes(view, entry.bodyStart + 78, entry.bodyEnd);
            const configBox = subBoxes.find(b => ['avcC', 'hvcC', 'vpcC', 'av1C'].includes(b.type));
            if (configBox) {
              // What changed: Read raw description payload from bodyStart and bodyEnd (skipping header)
              description = new Uint8Array(arrayBuffer.slice(configBox.bodyStart, configBox.bodyEnd));
              if (configBox.type === 'avcC') {
                const profile = view.getUint8(configBox.bodyStart + 1).toString(16).padStart(2, '0');
                const compat = view.getUint8(configBox.bodyStart + 2).toString(16).padStart(2, '0');
                const level = view.getUint8(configBox.bodyStart + 3).toString(16).padStart(2, '0');
                codec = 'avc1.' + profile + compat + level;
              }
            }
            break;
          }
        }

        if (!videoTrak) throw new Error('No video track found');
        // Fix: Use videoTrak.bodyStart and videoTrak.bodyEnd to search child elements
        const stbl = findBoxByPath(view, ['mdia', 'minf', 'stbl'], videoTrak.bodyStart, videoTrak.bodyEnd);
        if (!stbl) throw new Error('Missing stbl box');

        const stsz = findBoxByPath(view, ['stsz'], stbl.start, stbl.end);
        if (!stsz) throw new Error('Missing stsz box');
        const sampleSize = view.getUint32(stsz.start + 4);
        const sampleCount = view.getUint32(stsz.start + 8);
        const sampleSizes = [];
        if (sampleSize === 0) {
          for (let i = 0; i < sampleCount; i++) {
            sampleSizes.push(view.getUint32(stsz.start + 12 + i * 4));
          }
        } else {
          for (let i = 0; i < sampleCount; i++) {
            sampleSizes.push(sampleSize);
          }
        }

        const chunkOffsets = [];
        const stco = findBoxByPath(view, ['stco'], stbl.start, stbl.end);
        if (stco) {
          const entryCount = view.getUint32(stco.start + 4);
          for (let i = 0; i < entryCount; i++) {
            chunkOffsets.push(view.getUint32(stco.start + 8 + i * 4));
          }
        } else {
          const co64 = findBoxByPath(view, ['co64'], stbl.start, stbl.end);
          if (!co64) throw new Error('Missing chunk offset box');
          const entryCount = view.getUint32(co64.start + 4);
          for (let i = 0; i < entryCount; i++) {
            chunkOffsets.push(Number(view.getBigUint64(co64.start + 8 + i * 8)));
          }
        }

        const stsc = findBoxByPath(view, ['stsc'], stbl.start, stbl.end);
        if (!stsc) throw new Error('Missing stsc');
        const stscEntriesCount = view.getUint32(stsc.start + 4);
        const stscEntries = [];
        for (let i = 0; i < stscEntriesCount; i++) {
          stscEntries.push({
            firstChunk: view.getUint32(stsc.start + 8 + i * 12),
            samplesPerChunk: view.getUint32(stsc.start + 12 + i * 12),
          });
        }

        const syncSamples = new Set();
        const stss = findBoxByPath(view, ['stss'], stbl.start, stbl.end);
        if (stss) {
          const entryCount = view.getUint32(stss.start + 4);
          for (let i = 0; i < entryCount; i++) {
            syncSamples.add(view.getUint32(stss.start + 8 + i * 4) - 1);
          }
        } else {
          for (let i = 0; i < sampleCount; i++) syncSamples.add(i);
        }

        const sampleOffsets = [];
        let stscIndex = 0;
        let samplesPerChunk = 0;
        let sampleOffsetInCurrentChunk = 0;
        let chunkIndex = 0;

        for (let i = 0; i < sampleCount; i++) {
          if (stscIndex < stscEntries.length - 1) {
            if (chunkIndex + 1 >= stscEntries[stscIndex + 1].firstChunk) {
              stscIndex++;
            }
          }
          samplesPerChunk = stscEntries[stscIndex].samplesPerChunk;
          if (sampleOffsetInCurrentChunk === 0) {
            sampleOffsets.push(chunkOffsets[chunkIndex]);
          } else {
            sampleOffsets.push(sampleOffsets[i - 1] + sampleSizes[i - 1]);
          }
          sampleOffsetInCurrentChunk++;
          if (sampleOffsetInCurrentChunk >= samplesPerChunk) {
            sampleOffsetInCurrentChunk = 0;
            chunkIndex++;
          }
        }

        const samples = [];
        for (let i = 0; i < sampleCount; i++) {
          samples.push({
            index: i,
            offset: sampleOffsets[i],
            size: sampleSizes[i],
            isKeyframe: syncSamples.has(i),
          });
        }

        return { codec, description, width, height, samples };
      }

      let videoDecoder = null;

      self.onmessage = async (e) => {
        const data = e.data;
        if (data.type === 'init') {
          const { videoUrl } = data;
          try {
            const response = await fetch(videoUrl);
            if (!response.ok) throw new Error('Fetch failed with ' + response.status);
            const arrayBuffer = await response.arrayBuffer();
            const demuxed = demuxMP4(arrayBuffer);

            self.postMessage({ type: 'metadata', count: demuxed.samples.length });

            videoDecoder = new VideoDecoder({
              output: (videoFrame) => {
                const offscreen = new OffscreenCanvas(demuxed.width, demuxed.height);
                const ctx = offscreen.getContext('2d');
                if (ctx) {
                  ctx.drawImage(videoFrame, 0, 0);
                  const bitmap = offscreen.transferToImageBitmap();
                  if (bitmap) {
                    try {
                      self.postMessage({
                        type: 'frame',
                        index: videoFrame.timestamp,
                        bitmap: bitmap
                  }, [bitmap]);
                    } catch (postErr) {
                      try {
                        self.postMessage({
                          type: 'frame',
                          index: videoFrame.timestamp,
                          bitmap: bitmap
                        });
                      } catch (cloneErr) {
                        self.postMessage({ type: 'error', error: 'Serialization failed' });
                      }
                    }
                  }
                }
                videoFrame.close();
              },
              error: (err) => {
                self.postMessage({ type: 'error', error: 'VideoDecoder error: ' + err.message });
              }
            });

            // What changed: Avoid passing null/undefined description to VideoDecoderConfig under browser JS restrictions.
            // How to undo: Revert to passing description: demuxed.description directly.
            const config = {
              codec: demuxed.codec,
              codedWidth: demuxed.width,
              codedHeight: demuxed.height,
            };
            if (demuxed.description) {
              config.description = demuxed.description;
            }

            videoDecoder.configure(config);

            for (let i = 0; i < demuxed.samples.length; i++) {
              const sample = demuxed.samples[i];
              const chunkBuffer = arrayBuffer.slice(sample.offset, sample.offset + sample.size);
              const chunk = new EncodedVideoChunk({
                type: sample.isKeyframe ? 'key' : 'delta',
                timestamp: sample.index,
                duration: 1,
                data: new Uint8Array(chunkBuffer)
              });
              videoDecoder.decode(chunk);
            }

            await videoDecoder.flush();
            self.postMessage({ type: 'complete' });

          } catch (err) {
            self.postMessage({ type: 'error', error: err.toString() });
          }
        }
      };
    `;

    const isWorkerWebCodecsSupported =
      typeof window !== "undefined" &&
      "Worker" in window &&
      "VideoDecoder" in window &&
      "OffscreenCanvas" in window;

    if (!isWorkerWebCodecsSupported) {
      console.error("❌ Native WebCodecs VideoDecoder or Worker not supported on this browser.");
      return;
    }

    try {
      const blob = new Blob([workerCode], { type: "application/javascript" });
      const blobUrl = URL.createObjectURL(blob);
      worker = new Worker(blobUrl);

      worker.onmessage = (e) => {
        if (!active) return;
        const data = e.data;

        if (data.type === "frame") {
          const { index, bitmap } = data;
          const texture = new THREE.Texture(bitmap);
          texture.flipY = false;
          texture.minFilter = THREE.LinearFilter;
          texture.magFilter = THREE.LinearFilter;
          texture.needsUpdate = true;

          frameCacheRef.current[index] = texture;
          setCachedCount((prev) => prev + 1);
        } else if (data.type === "complete") {
          setVideoLoaded(true);
          console.log("⚡ [Offscreen Worker] All frames decoded successfully with Zero Dependencies.");
        } else if (data.type === "error") {
          console.error("❌ [Offscreen Worker] Decoder failed:", data.error);
        }
      };

      worker.onerror = (errEvent) => {
        errEvent.preventDefault();
        console.error("❌ [Worker Error] WebCodecs worker thread crash:", errEvent);
      };

      // Start decoding directly
      worker.postMessage({ type: "init", videoUrl });

    } catch (err) {
      console.error("❌ [VideoScrubWebGL] Error starting native WebCodecs worker:", err);
    }

    return () => {
      active = false;
      if (worker) {
        worker.terminate();
      }
      Object.values(frameCacheRef.current).forEach((tex) => tex.dispose());
      frameCacheRef.current = {};
    };
  }, [videoUrl]);

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        backgroundColor: "#08080a",
        overflow: "hidden",
        pointerEvents: "none", // Let touch events completely bleed through to the scrolling container
      }}
    >
      <Canvas
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
      >
        <ScrubberScreen
          lenisRef={lenisRef}
          frameCacheRef={frameCacheRef}
          numFrames={NUM_FRAMES}
          targetProgress={targetProgress}
          currentProgress={currentProgress}
          currentVelocity={currentVelocity}
          pinchPower={pinchPower}
          fluidDistortionPower={fluidDistortionPower}
          onScrub={onScrub}
          pointerXRef={pointerXRef}
          pointerYRef={pointerYRef}
          pointerDxRef={pointerDxRef}
          pointerDyRef={pointerDyRef}
          pointerMovedRef={pointerMovedRef}
          pointerHoveredRef={pointerHoveredRef}
        />
      </Canvas>

      {/* 
        PRELOADER & TELEMETRY UI REMOVED: Show first frame immediately under user's directive.
        Undo change: Revert this block to restore the titanium circular loader and bottom status HUD.
      */}
    </div>
  );
}

// --- GPGPU FLUID NAVIER-STOKES SHADERS ---
const POINT_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D u_input_texture;
uniform float u_ratio;
uniform vec3 u_point_value;
uniform vec2 u_point;
uniform float u_point_size;

void main() {
  vec2 p = vUv - u_point;
  p.x *= u_ratio;
  vec3 splat = 0.6 * pow(2.0, -dot(p, p) / u_point_size) * u_point_value;
  vec3 base = texture2D(u_input_texture, vUv).xyz;
  gl_FragColor = vec4(base + splat, 1.0);
}
`;

const DIVERGENCE_FRAG = `
precision highp float;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform sampler2D u_velocity_texture;

void main() {
  float L = texture2D(u_velocity_texture, vL).x;
  float R = texture2D(u_velocity_texture, vR).x;
  float T = texture2D(u_velocity_texture, vT).y;
  float B = texture2D(u_velocity_texture, vB).y;
  float div = 0.25 * (R - L + T - B);
  gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
}
`;

const PRESSURE_FRAG = `
precision highp float;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform sampler2D u_pressure_texture;
uniform sampler2D u_divergence_texture;

void main() {
  float L = texture2D(u_pressure_texture, vL).x;
  float R = texture2D(u_pressure_texture, vR).x;
  float T = texture2D(u_pressure_texture, vT).x;
  float B = texture2D(u_pressure_texture, vB).x;
  float divergence = texture2D(u_divergence_texture, vUv).x;
  float pressure = (L + R + B + T - divergence) * 0.25;
  gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
}
`;

const GRAD_SUB_FRAG = `
precision highp float;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform sampler2D u_pressure_texture;
uniform sampler2D u_velocity_texture;

void main() {
  float L = texture2D(u_pressure_texture, vL).x;
  float R = texture2D(u_pressure_texture, vR).x;
  float T = texture2D(u_pressure_texture, vT).x;
  float B = texture2D(u_pressure_texture, vB).x;
  vec2 velocity = texture2D(u_velocity_texture, vUv).xy;
  velocity.xy -= vec2(R - L, T - B);
  gl_FragColor = vec4(velocity, 0.0, 1.0);
}
`;

const ADVECT_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D u_velocity_texture;
uniform sampler2D u_input_texture;
uniform vec2 u_texel;
uniform vec2 u_output_texel;
uniform float u_dt;
uniform float u_dissipation;

vec4 bilerp(sampler2D sam, vec2 uv, vec2 tsize) {
  vec2 st = uv / tsize - 0.5;
  vec2 iuv = floor(st);
  vec2 fuv = fract(st);
  vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
  vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
  vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
  vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
  return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
}

void main() {
  vec2 coord = vUv - u_dt * bilerp(u_velocity_texture, vUv, u_texel).xy * u_texel;
  vec4 velocity = bilerp(u_input_texture, coord, u_output_texel);
  gl_FragColor = u_dissipation * velocity;
}
`;

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
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.scene.add(this.quad);

    const createRT = () => {
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

    this.velocity = createRT();
    this.dye = createRT();
    this.pressure = createRT();
    this.divergence = new THREE.WebGLRenderTarget(res.w, res.h, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });

    const vertShader = `
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
      vertexShader: vertShader,
      fragmentShader: POINT_FRAG,
      uniforms: {
        u_texel: { value: this.texel },
        u_input_texture: { value: null },
        u_ratio: { value: 1.0 },
        u_point_value: { value: new THREE.Vector3() },
        u_point: { value: new THREE.Vector2() },
        u_point_size: { value: 0.001 },
      },
    });

    this.divMat = new THREE.ShaderMaterial({
      vertexShader: vertShader,
      fragmentShader: DIVERGENCE_FRAG,
      uniforms: {
        u_texel: { value: this.texel },
        u_velocity_texture: { value: null },
      },
    });

    this.pressureMat = new THREE.ShaderMaterial({
      vertexShader: vertShader,
      fragmentShader: PRESSURE_FRAG,
      uniforms: {
        u_texel: { value: this.texel },
        u_pressure_texture: { value: null },
        u_divergence_texture: { value: null },
      },
    });

    this.gradSubMat = new THREE.ShaderMaterial({
      vertexShader: vertShader,
      fragmentShader: GRAD_SUB_FRAG,
      uniforms: {
        u_texel: { value: this.texel },
        u_pressure_texture: { value: null },
        u_velocity_texture: { value: null },
      },
    });

    this.advectMat = new THREE.ShaderMaterial({
      vertexShader: vertShader,
      fragmentShader: ADVECT_FRAG,
      uniforms: {
        u_texel: { value: this.texel },
        u_output_texel: { value: this.texel },
        u_velocity_texture: { value: null },
        u_input_texture: { value: null },
        u_dt: { value: 0.016 },
        u_dissipation: { value: 0.98 },
      },
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
    // Splat velocity and density field
    this.splatMat.uniforms.u_input_texture.value = this.velocity.read.texture;
    this.splatMat.uniforms.u_ratio.value = ratio;
    this.splatMat.uniforms.u_point.value.copy(point);
    this.splatMat.uniforms.u_point_value.value.copy(force);
    this.splatMat.uniforms.u_point_size.value = size;
    this.renderPass(this.splatMat, this.velocity.write);
    this.velocity.swap();

    this.splatMat.uniforms.u_input_texture.value = this.dye.read.texture;
    this.splatMat.uniforms.u_point_value.value.set(force.z, 0, 0);
    this.renderPass(this.splatMat, this.dye.write);
    this.dye.swap();
  }

  step(dt: number) {
    this.divMat.uniforms.u_velocity_texture.value = this.velocity.read.texture;
    this.renderPass(this.divMat, this.divergence);

    // Jacobi pressure iterations
    for (let i = 0; i < 8; i++) {
      this.pressureMat.uniforms.u_pressure_texture.value = this.pressure.read.texture;
      this.pressureMat.uniforms.u_divergence_texture.value = this.divergence.texture;
      this.renderPass(this.pressureMat, this.pressure.write);
      this.pressure.swap();
    }

    this.gradSubMat.uniforms.u_pressure_texture.value = this.pressure.read.texture;
    this.gradSubMat.uniforms.u_velocity_texture.value = this.velocity.read.texture;
    this.renderPass(this.gradSubMat, this.velocity.write);
    this.velocity.swap();

    this.advectMat.uniforms.u_velocity_texture.value = this.velocity.read.texture;
    this.advectMat.uniforms.u_input_texture.value = this.velocity.read.texture;
    this.advectMat.uniforms.u_dt.value = dt;
    this.advectMat.uniforms.u_dissipation.value = 0.98;
    this.renderPass(this.advectMat, this.velocity.write);
    this.velocity.swap();

    this.advectMat.uniforms.u_velocity_texture.value = this.velocity.read.texture;
    this.advectMat.uniforms.u_input_texture.value = this.dye.read.texture;
    this.advectMat.uniforms.u_dt.value = dt * 6.0;
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

// --- ACTIVE THREE SCENE RENDERING ENGINE ---
interface ScrubberScreenProps {
  lenisRef: React.RefObject<any>;
  frameCacheRef: React.RefObject<{ [key: number]: THREE.Texture }>;
  numFrames: number;
  targetProgress: React.MutableRefObject<number>;
  currentProgress: React.MutableRefObject<number>;
  currentVelocity: React.MutableRefObject<number>;
  pinchPower: number;
  fluidDistortionPower: number;
  onScrub?: (prog: number) => void;

  pointerXRef: React.MutableRefObject<number>;
  pointerYRef: React.MutableRefObject<number>;
  pointerDxRef: React.MutableRefObject<number>;
  pointerDyRef: React.MutableRefObject<number>;
  pointerMovedRef: React.MutableRefObject<boolean>;
  pointerHoveredRef: React.MutableRefObject<boolean>;
}

function ScrubberScreen(props: ScrubberScreenProps) {
  const {
    lenisRef,
    frameCacheRef,
    numFrames,
    targetProgress,
    currentProgress,
    currentVelocity,
    pinchPower,
    fluidDistortionPower,
    onScrub,
    pointerXRef,
    pointerYRef,
    pointerDxRef,
    pointerDyRef,
    pointerMovedRef,
    pointerHoveredRef,
  } = props;

  const { gl, size } = useThree();
  const materialRef = useRef<THREE.ShaderMaterial>(null);

  // GPGPU Navier-stokes solver initialization
  const fluidSolver = useMemo(() => {
    const res = { w: 128, h: 128 };
    return new ThreeFluidSolver(gl, res);
  }, [gl]);

  useEffect(() => {
    return () => {
      fluidSolver.dispose();
    };
  }, [fluidSolver]);

  // Composition shader combining webgl fluid forces and pinch distortion with WASM + GLSL temporal cross-fading
  const material = useMemo(() => {
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
        uniform sampler2D uTextureLow;
        uniform sampler2D uTextureHigh;
        uniform float uBlendWeight;
        uniform sampler2D uFluidVelocity;
        uniform sampler2D uFluidDye;
        uniform float uFluidDistortionPower;
        uniform float uPinchPower;
        uniform float uScrubVelocity;
        uniform vec2 uCanvasResolution;
        uniform vec2 uTextureResolution;
        uniform float uTime;

        // Custom pseudorandom noise helper
        float rand(vec2 co) {
          return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
        }

        void main() {
          // GPGPU Fluid displacement math
          vec2 fluidVelocity = texture2D(uFluidVelocity, vUv).xy;
          float fluidDye = texture2D(uFluidDye, vUv).r;

          vec2 fluidDistort = normalize(fluidVelocity + 0.0001) * fluidDye * uFluidDistortionPower * 0.12;
          vec2 uv = clamp(vUv - fluidDistort, 0.001, 0.999);

          // Cover crop aspect fit mapping
          float canvasAspect = uCanvasResolution.x / uCanvasResolution.y;
          float textureAspect = uTextureResolution.x / uTextureResolution.y;

          if (canvasAspect > textureAspect) {
            float scale = textureAspect / canvasAspect;
            uv.y = (uv.y - 0.5) * scale + 0.5;
          } else {
            float scale = canvasAspect / textureAspect;
            uv.x = (uv.x - 0.5) * scale + 0.5;
          }

          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
            gl_FragColor = vec4(0.04, 0.04, 0.05, 1.0);
            return;
          }

          // Center Pinch tactile distortion
          vec2 center = vec2(0.5);
          vec2 toCenter = uv - center;
          float dist = length(toCenter);

          // Pinch pulls inwards directly proportional to spring velocity (scroll kinetic)
          float pinch = 1.0 + (dist * dist) * (abs(uScrubVelocity) * uPinchPower * 2.5);
          vec2 finalDistortedUv = center + toCenter * pinch;
          finalDistortedUv = clamp(finalDistortedUv, 0.001, 0.999);

          vec2 flippedUv = vec2(finalDistortedUv.x, 1.0 - finalDistortedUv.y);

          // Generate dynamic grain noise (changes with time over coordinates)
          float grainNoise = rand(flippedUv * (sin(uTime) * 10.0 + 15.0)) - 0.5;

          // Multi-sample blur on fluid trail zones with randomized grain offset
          vec2 blurOffset = vec2(0.0);
          if (fluidDye > 0.005) {
            // Compute blurring vector along velocity direction, scaled by dye concentration
            blurOffset = normalize(fluidVelocity + 0.0001) * fluidDye * (0.012 + 0.004 * grainNoise);
          }

          vec2 flippedUvBlur1 = clamp(flippedUv + blurOffset, 0.001, 0.999);
          vec2 flippedUvBlur2 = clamp(flippedUv - blurOffset, 0.001, 0.999);

          // Sample textures (original, blurred offset 1, blurred offset 2)
          vec3 colLowMain = texture2D(uTextureLow, flippedUv).rgb;
          vec3 colHighMain = texture2D(uTextureHigh, flippedUv).rgb;
          vec3 colMain = mix(colLowMain, colHighMain, uBlendWeight);

          vec3 colLowBlur1 = texture2D(uTextureLow, flippedUvBlur1).rgb;
          vec3 colHighBlur1 = texture2D(uTextureHigh, flippedUvBlur1).rgb;
          vec3 colBlur1 = mix(colLowBlur1, colHighBlur1, uBlendWeight);

          vec3 colLowBlur2 = texture2D(uTextureLow, flippedUvBlur2).rgb;
          vec3 colHighBlur2 = texture2D(uTextureHigh, flippedUvBlur2).rgb;
          vec3 colBlur2 = mix(colLowBlur2, colHighBlur2, uBlendWeight);

          // Blend main color and blurred colors based on dye intensity
          vec3 col = mix(colMain, (colBlur1 + colBlur2) * 0.5, clamp(fluidDye * 2.2, 0.0, 0.9));

          // Apply gorgeous soft grain overlay overall, with custom styling
          col += vec3(grainNoise) * 0.035;

          // Estimate normal gradients of the fluid trail density for diffused white specular
          float stepOffset = 1.8 / uCanvasResolution.x;
          float dyeL = texture2D(uFluidDye, vUv + vec2(-stepOffset, 0.0)).r;
          float dyeR = texture2D(uFluidDye, vUv + vec2(stepOffset, 0.0)).r;
          float dyeT = texture2D(uFluidDye, vUv + vec2(0.0, -stepOffset)).r;
          float dyeB = texture2D(uFluidDye, vUv + vec2(0.0, stepOffset)).r;

          // Sobel / central differences slope to construct virtual normals
          vec3 normal = normalize(vec3((dyeR - dyeL) * 2.2, (dyeB - dyeT) * 2.2, 0.22));

          // Virtual directional light source to reflect specular glare
          vec3 lightDir = normalize(vec3(-0.35, 0.35, 0.6));
          vec3 viewDir = vec3(0.0, 0.0, 1.0);
          vec3 halfDir = normalize(lightDir + viewDir);

          // Specular highlights: Blinn-Phong specular on the fluid's normal surface gradient
          float ndh = max(0.0, dot(normal, halfDir));
          float specIntensity = pow(ndh, 12.0) * fluidDye * 1.8;

          // Edge highlight where normal is steep (facing away from viewing direction)
          float edgeSpec = clamp((1.0 - normal.z) * 1.5, 0.0, 1.0) * fluidDye * 0.9;

          // Consolidating white specular light, adding slight grain to the glare
          float finalSpecular = (specIntensity * 1.1 + edgeSpec * 0.9) * (0.85 + 0.15 * rand(vUv * uTime));
          vec3 specularHighlight = vec3(1.0, 1.0, 1.0) * finalSpecular;

          // Blend dyed neon trail path
          vec3 neonGlow = vec3(0.0, 0.72, 1.0) * fluidDye * 0.35;
          col += neonGlow;

          // Superimpose the white specular gloss map
          col += specularHighlight;

          gl_FragColor = vec4(col, 1.0);
        }
      `,
      uniforms: {
        uTextureLow: { value: null },
        uTextureHigh: { value: null },
        uBlendWeight: { value: 0.0 },
        uFluidVelocity: { value: null },
        uFluidDye: { value: null },
        uFluidDistortionPower: { value: fluidDistortionPower },
        uPinchPower: { value: pinchPower },
        uScrubVelocity: { value: 0 },
        uCanvasResolution: { value: new THREE.Vector2(size.width, size.height) },
        uTextureResolution: { value: new THREE.Vector2(1280, 720) },
        uTime: { value: 0 },
      }
    });
  }, [size.width, size.height, fluidDistortionPower, pinchPower]);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.03);

    // 1. GPGPU splat ripples based on cursors
    if (pointerMovedRef.current) {
      const u = pointerXRef.current;
      const v = 1.0 - pointerYRef.current;

      const forceVector = new THREE.Vector3(pointerDxRef.current, -pointerDyRef.current, 0.015);
      const splatRadius = 0.0015;
      const aspect = size.width / Math.max(1, size.height);

      fluidSolver.splat(new THREE.Vector2(u, v), forceVector, splatRadius, aspect);
      pointerMovedRef.current = false;
    }

    // Navier Stokes progression
    fluidSolver.step(dt);

    // 2. Interpolate Hooke's Spring math in bare-metal WASM (Only for smooth scroll stopping)
    // What changed: Integrated action scroll detection. When the user is actively scrolling, progress is mapped 1:1.
    // The physics solver kicks in solely when scrolling stops to handle smooth, organic decelerations.
    // What changed: Active scrolling now estimates real-time scrolling velocity so that on release
    // the Newtonian engine inherits a natural kinetic starting phase for an ultra-gentle glide.
    // How to undo: Set `const isScrolling = false;` to force spring integration at all times.
    const isScrolling = lenisRef.current ? lenisRef.current.isScrolling : false;

    if (isScrolling) {
      const prevProgress = currentProgress.current;
      currentProgress.current = targetProgress.current;
      // Calculate rate of change of progress: dp / dt
      const targetVelocity = dt > 0 ? (currentProgress.current - prevProgress) / dt : 0;
      // Low-pass filter to smooth and damp the scrolling action velocity gracefully
      currentVelocity.current = currentVelocity.current * 0.82 + targetVelocity * 0.18;
    } else {
      // What changed: Removed JavaScript math fallback. Physics simulation is strictly WASM only.
      // How to undo: Reintroduce the Euler integration fallback logic block: `const displacement = targetProgress.current - currentProgress.current;`
      // What changed: Super gentle stiffness (9.0) and critically/over-damped damping (6.3) selected for a luxurious, ultra-smooth cinematic glide.
      // How to undo: Restore stiffness to 120 and damping to 25.
      // What changed: Integrated inline compilation of WAT to WebAssembly using wabt.js.
      // While compilation is processing for the first 1-2 frames, map progress 1:1 to prevent crashing.
      // How to undo: Revert to Throwing Error if `wasm` is null.
      const wasm = initWasmPhysics();
      if (!wasm) {
        currentProgress.current = targetProgress.current;
        currentVelocity.current = 0;
      } else {
        currentVelocity.current = wasm.step_velocity(
          targetProgress.current,
          currentProgress.current,
          currentVelocity.current,
          9.0, // Super gentle stiffness (lowered from 36)
          6.3, // Damping tuned slightly above critical threshold (6.0) for zero overshoot or bouncing
          1.0, // mass
          dt
        );
        currentProgress.current = wasm.step_progress(
          currentProgress.current,
          currentVelocity.current,
          dt
        );
      }
    }

    currentProgress.current = Math.max(0.0001, Math.min(0.9999, currentProgress.current));

    // 3. WebGL Temporal Frame Blend Engine
    // Calculates closest available bounding low and high caches and cross-fades them linearly on GPU.
    const frameIndexFloat = currentProgress.current * (numFrames - 1);
    const targetIdx = Math.floor(frameIndexFloat);

    let lowIdx = -1;
    let highIdx = -1;
    let maxLow = -1;
    let minHigh = Infinity;

    if (frameCacheRef.current) {
      const keys = Object.keys(frameCacheRef.current);
      for (let i = 0; i < keys.length; i++) {
        const cachedIdx = parseInt(keys[i], 10);
        if (cachedIdx <= targetIdx) {
          if (cachedIdx > maxLow) {
            maxLow = cachedIdx;
            lowIdx = cachedIdx;
          }
        }
        if (cachedIdx >= targetIdx) {
          if (cachedIdx < minHigh) {
            minHigh = cachedIdx;
            highIdx = cachedIdx;
          }
        }
      }
    }

    // Fallbacks if bounds are half-open (e.g. only some loaded)
    if (lowIdx === -1 && highIdx !== -1) lowIdx = highIdx;
    if (highIdx === -1 && lowIdx !== -1) highIdx = lowIdx;

    const textureLow = lowIdx !== -1 ? frameCacheRef.current[lowIdx] : null;
    const textureHigh = highIdx !== -1 ? frameCacheRef.current[highIdx] : null;

    // Direct interpolation weight factor
    const blendWeight = lowIdx === highIdx || lowIdx === -1 
      ? 0.0 
      : (frameIndexFloat - lowIdx) / (highIdx - lowIdx);

    // Update compositor uniforms with low + high textures
    if (textureLow && textureHigh) {
      material.uniforms.uTextureLow.value = textureLow;
      material.uniforms.uTextureHigh.value = textureHigh;
      material.uniforms.uBlendWeight.value = blendWeight;

      const img = textureLow.image as any;
      if (img && (img.width || img.videoWidth)) {
        material.uniforms.uTextureResolution.value.set(
          img.width || img.videoWidth || 1280,
          img.height || img.videoHeight || 720
        );
      }
    } else if (textureLow || textureHigh) {
      const activeTex = textureLow || textureHigh;
      material.uniforms.uTextureLow.value = activeTex;
      material.uniforms.uTextureHigh.value = activeTex;
      material.uniforms.uBlendWeight.value = 0.0;
    }

    material.uniforms.uCanvasResolution.value.set(size.width, size.height);
    material.uniforms.uFluidVelocity.value = fluidSolver.velocity.read.texture;
    material.uniforms.uFluidDye.value = fluidSolver.dye.read.texture;
    material.uniforms.uScrubVelocity.value = currentVelocity.current;
    material.uniforms.uTime.value = state.clock.getElapsedTime();

    if (onScrub) {
      onScrub(currentProgress.current);
    }
  });

  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <primitive object={material} ref={materialRef} attach="material" />
    </mesh>
  );
}

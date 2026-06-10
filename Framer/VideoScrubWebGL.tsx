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

// --- WEBASSEMBLY PHYSICS INTERPOLATION FOR SMOOTH SCROLL SCRUBBING ---
interface WasmPhysicsInstance {
  step_velocity: (target: number, current: number, velocity: number, stiffness: number, damping: number, mass: number, dt: number) => number;
  step_progress: (current: number, velocity: number, dt: number) => number;
}

let wasmPhysicsInstance: WasmPhysicsInstance | null = null;

function initWasmPhysics(): WasmPhysicsInstance | null {
  if (wasmPhysicsInstance) return wasmPhysicsInstance;
  try {
    // Compiled WASM bytecode containing Newtonian math solvers
    const bytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x13, 0x02, 
      0x60, 0x07, 0x7d, 0x7d, 0x7d, 0x7d, 0x7d, 0x7d, 0x7d, 0x01, 0x7d,
      0x60, 0x03, 0x7d, 0x7d, 0x7d, 0x01, 0x7d,
      0x03, 0x03, 0x02, 0x00, 0x01,
      0x07, 0x21, 0x02,
      0x0d, 0x73, 0x74, 0x65, 0x70, 0x5f, 0x76, 0x65, 0x6c, 0x6f, 0x63, 0x69, 0x74, 0x79, 0x00, 0x00,
      0x0d, 0x73, 0x74, 0x65, 0x70, 0x5f, 0x70, 0x72, 0x6f, 0x67, 0x72, 0x65, 0x73, 0x73, 0x00, 0x01,
      0x0a, 0x26, 0x02,
      0x19, 0x00,
      0x20, 0x02,
      0x20, 0x00,
      0x20, 0x01,
      0x93,
      0x20, 0x03,
      0x94,
      0x20, 0x02,
      0x20, 0x04,
      0x94,
      0x93,
      0x20, 0x05,
      0x95,
      0x20, 0x06,
      0x94,
      0x92,
      0x0b,
      0x0a, 0x00,
      0x20, 0x00,
      0x20, 0x01,
      0x20, 0x02,
      0x94,
      0x92,
      0x0b
    ]);

    const module = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(module);
    wasmPhysicsInstance = instance.exports as any;
    console.log("⚡ [WASM Physics Engine] WebAssembly acceleration compiled successfully.");
  } catch (err) {
    console.warn("⚠️ [WASM Physics Engine] Failed WASM build, using native JS f32 math.", err);
    wasmPhysicsInstance = null;
  }
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

  // 2. High-Speed Web Worker & WebCodecs Offscreen Frame Decoder with Legacy Fallback
  useEffect(() => {
    let active = true;
    let localBlobUrl: string | null = null;
    let worker: Worker | null = null;

    // Legacy fallback bindings (used if worker fails or is unsupported)
    let legacyVideo: HTMLVideoElement | null = null;
    let legCanvas: HTMLCanvasElement | null = null;
    let legCtx: CanvasRenderingContext2D | null = null;
    let seekTimeoutId: any = null;
    let rvfcId: any = null;
    let isProcessingCurrentLegacy = false;
    let queuePointerLegacy = 0;

    const priorityIndices: number[] = [];
    for (let i = 0; i < NUM_FRAMES; i++) {
      priorityIndices.push(i);
    }

    const clearLegacyTimeouts = () => {
      if (seekTimeoutId) {
        clearTimeout(seekTimeoutId);
        seekTimeoutId = null;
      }
      if (rvfcId !== null && legacyVideo && "cancelVideoFrameCallback" in legacyVideo) {
        (legacyVideo as any).cancelVideoFrameCallback(rvfcId);
        rvfcId = null;
      }
    };

    const runLegacyCanvasFallback = (frameIdx: number) => {
      if (!active || !legCtx || !legacyVideo) return;
      legCanvas!.width = legacyVideo.videoWidth || 640;
      legCanvas!.height = legacyVideo.videoHeight || 360;
      try {
        legCtx.drawImage(legacyVideo, 0, 0);
        const texture = new THREE.CanvasTexture(legCanvas!);
        texture.flipY = false;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;

        frameCacheRef.current[frameIdx] = texture;
        setCachedCount((prev) => prev + 1);
      } catch (err) {
        console.warn("Canvas predecoding fallback occurred for frame", frameIdx, err);
      }

      queuePointerLegacy++;
      setTimeout(processNextFrameLegacy, 6);
    };

    const captureFrameAndAdvanceLegacy = (frameIdx: number) => {
      if (!active || !isProcessingCurrentLegacy || !legacyVideo) return;
      isProcessingCurrentLegacy = false;
      clearLegacyTimeouts();

      if (legacyVideo.videoWidth > 0 && legacyVideo.videoHeight > 0) {
        if (typeof createImageBitmap !== "undefined") {
          createImageBitmap(legacyVideo)
            .then((bitmap) => {
              if (!active) {
                bitmap.close();
                return;
              }
              const texture = new THREE.Texture(bitmap);
              texture.flipY = false;
              texture.minFilter = THREE.LinearFilter;
              texture.magFilter = THREE.LinearFilter;
              texture.needsUpdate = true;

              frameCacheRef.current[frameIdx] = texture;
              setCachedCount((prev) => prev + 1);

              queuePointerLegacy++;
              setTimeout(processNextFrameLegacy, 6);
            })
            .catch(() => runLegacyCanvasFallback(frameIdx));
        } else {
          runLegacyCanvasFallback(frameIdx);
        }
      } else {
        queuePointerLegacy++;
        setTimeout(processNextFrameLegacy, 6);
      }
    };

    const processNextFrameLegacy = () => {
      if (!active || !legacyVideo) return;
      clearLegacyTimeouts();

      if (queuePointerLegacy >= priorityIndices.length) {
        setVideoLoaded(true);
        return;
      }

      const frameIdx = priorityIndices[queuePointerLegacy];
      const duration = legacyVideo.duration;

      if (isNaN(duration) || duration <= 0) {
        seekTimeoutId = setTimeout(processNextFrameLegacy, 50);
        return;
      }

      isProcessingCurrentLegacy = true;

      seekTimeoutId = setTimeout(() => {
        if (!active || !isProcessingCurrentLegacy) return;
        console.warn(`[Legacy Watchman] Skip seek stall at frame index ${frameIdx}`);
        isProcessingCurrentLegacy = false;
        queuePointerLegacy++;
        processNextFrameLegacy();
      }, 350);

      const targetTime = (frameIdx + 0.5) * (duration / NUM_FRAMES);

      if ("requestVideoFrameCallback" in legacyVideo) {
        const checkFrame = (now: number, metadata: any) => {
          if (!active || !isProcessingCurrentLegacy) return;
          
          const tolerance = (duration / NUM_FRAMES) * 0.55;
          const isAtEnd = frameIdx === NUM_FRAMES - 1 && metadata.mediaTime >= duration - 0.05;
          
          if (Math.abs(metadata.mediaTime - targetTime) < tolerance || isAtEnd) {
            captureFrameAndAdvanceLegacy(frameIdx);
          } else {
            rvfcId = (legacyVideo as any).requestVideoFrameCallback(checkFrame);
          }
        };
        rvfcId = (legacyVideo as any).requestVideoFrameCallback(checkFrame);
      }

      const safeTime = (frameIdx + 0.5) * (duration / NUM_FRAMES);
      legacyVideo.currentTime = safeTime;
    };

    const handleSeekedLegacy = () => {
      if (!active || !isProcessingCurrentLegacy || !legacyVideo) return;
      if ("requestVideoFrameCallback" in legacyVideo) {
        return;
      }
      captureFrameAndAdvanceLegacy(priorityIndices[queuePointerLegacy]);
    };

    const runLegacyFallbackPipeline = () => {
      console.warn("⚠️ [Preload Fallback] Initializing legacy main thread frame preloader.");
      legacyVideo = document.createElement("video");
      legacyVideo.crossOrigin = "anonymous";
      legacyVideo.playsInline = true;
      legacyVideo.muted = true;
      legacyVideo.preload = "auto";
      legacyVideo.style.position = "absolute";
      legacyVideo.style.width = "320px";
      legacyVideo.style.height = "180px";
      legacyVideo.style.left = "-9999px";
      legacyVideo.style.top = "-9999px";
      legacyVideo.style.opacity = "1.0";
      legacyVideo.style.pointerEvents = "none";
      legacyVideo.style.overflow = "hidden";
      document.body.appendChild(legacyVideo);

      legCanvas = document.createElement("canvas");
      legCtx = legCanvas.getContext("2d");

      legacyVideo.addEventListener("seeked", handleSeekedLegacy);
      legacyVideo.addEventListener("loadedmetadata", processNextFrameLegacy);

      fetch(videoUrl)
        .then((res) => {
          if (!res.ok) throw new Error("Fallback fetch request failed");
          return res.blob();
        })
        .then((blob) => {
          if (!active || !legacyVideo) return;
          localBlobUrl = URL.createObjectURL(blob);
          legacyVideo.src = localBlobUrl;
          legacyVideo.load();
        })
        .catch((err) => {
          if (!active || !legacyVideo) return;
          console.warn("⚠️ [Preload Fallback] direct stream from remote source URL", err);
          legacyVideo.src = videoUrl;
          legacyVideo.load();
        });
    };

    // --- CHECK FOR WORKER & WEBCODECS DECODER SUPPORT ---
    const isWorkerWebCodecsSupported =
      typeof window !== "undefined" &&
      "Worker" in window &&
      "VideoDecoder" in window &&
      "OffscreenCanvas" in window;

    if (isWorkerWebCodecsSupported) { /* Initializing worker decoders safely */
      try {
        // Construct code for background WebCodecs decoding thread
        // Track errors explicitly, add clear comments, process frames strictly sequentially
        const workerCode = `
          let mp4boxfile = null;
          let videoDecoder = null;
          let samples = [];
          let width = 1280;
          let height = 720;
          let decodedCount = 0;

          // Sequential worker message processing
          self.onmessage = async (e) => {
            const data = e.data;
            if (data.type === 'init') {
              const { videoUrl, mp4boxCode } = data;
              try {
                (0, eval)(mp4boxCode);
                mp4boxfile = MP4Box.createFile();

                mp4boxfile.onError = (err) => {
                  self.postMessage({ type: 'error', error: 'MP4Box error: ' + err });
                };

                mp4boxfile.onReady = (info) => {
                  const videoTrack = info.videoTracks[0];
                  if (!videoTrack) {
                    self.postMessage({ type: 'error', error: 'No video track found' });
                    return;
                  }

                  width = videoTrack.track_width;
                  height = videoTrack.track_height;

                  // Hardware accelerated VideoDecoder pipeline
                  videoDecoder = new VideoDecoder({
                    output: (videoFrame) => {
                      // OffscreenCanvas frame decoder in background
                      const offscreen = new OffscreenCanvas(width, height);
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
                              self.postMessage({
                                type: 'error',
                                error: 'Failed to serialize ImageBitmap frame'
                              });
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

                  // Build description array for avcC/hvcC/vpcC WebCodecs payload
                  const entry = mp4boxfile.getTrackById(videoTrack.id).mdia.minf.stbl.stsd.entries[0];
                  const box = entry.avcC || entry.hvcC || entry.vpcC;
                  let description = null;
                  if (box) {
                    const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
                    box.write(stream);
                    description = new Uint8Array(stream.buffer, 8);
                  }

                  const config = {
                    codec: videoTrack.codec,
                    codedWidth: width,
                    codedHeight: height,
                    description: description
                  };

                  videoDecoder.configure(config);

                  // Extract all tracks securely
                  mp4boxfile.setExtractionOptions(videoTrack.id, null, { nbSamples: 10000 });
                  mp4boxfile.start();
                };

                mp4boxfile.onSamples = (track_id, ref, extractedSamples) => {
                  samples = extractedSamples;
                  self.postMessage({ type: 'metadata', count: samples.length });

                  // Strictly sequential decoding loop (maximizes H.264 prediction caching benefits)
                  for (let i = 0; i < samples.length; i++) {
                    const sample = samples[i];
                    const chunk = new EncodedVideoChunk({
                      type: sample.is_sync ? 'key' : 'delta',
                      timestamp: i,
                      duration: sample.duration,
                      data: sample.data
                    });
                    videoDecoder.decode(chunk);
                  }

                  videoDecoder.flush().then(() => {
                    self.postMessage({ type: 'complete' });
                  });
                };

                // Stream remote MP4 binaries sequentially
                const response = await fetch(videoUrl);
                if (!response.ok) throw new Error('Fetch rejected');
                const reader = response.body.getReader();
                let offset = 0;

                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;

                  const cleanBuffer = value.slice().buffer;
                  cleanBuffer.fileStart = offset;
                  mp4boxfile.appendBuffer(cleanBuffer);
                  offset += value.byteLength;
                }
                mp4boxfile.flush();

              } catch (err) {
                self.postMessage({ type: 'error', error: 'Fetch/parse failed: ' + err.toString() });
              }
            }
          };
        `;

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
            console.log("⚡ [Offscreen Worker] All frames loaded sequentially and decoded successfully.");
          } else if (data.type === "error") {
            console.warn("⚠️ [Offscreen Worker] Failed; starting fallback parser:", data.error);
            if (Object.keys(frameCacheRef.current).length === 0) {
              runLegacyFallbackPipeline();
            }
          }
        };

        // Gracefully catch and suppress any sandboxed Worker compile/runtime errors
        worker.onerror = (errEvent) => {
          errEvent.preventDefault();
          console.warn("⚠️ [Worker Safety Guard] Intercepted sandboxed background thread failure. Redirecting to fallback.", errEvent);
          if (Object.keys(frameCacheRef.current).length === 0) {
            runLegacyFallbackPipeline();
          }
        };

        fetch("https://cdnjs.cloudflare.com/ajax/libs/mp4box/0.5.2/mp4box.all.min.js")
          .then((res) => {
            if (!res.ok) throw new Error("CORS CDN block or network error");
            return res.text();
          })
          .then((libCode) => {
            if (!active || !worker) return;
            worker.postMessage({ type: "init", videoUrl, mp4boxCode: libCode });
          })
          .catch((err) => {
            console.warn("⚠️ CDN fetch failed on main thread, fallback preloader running immediately.", err);
            runLegacyFallbackPipeline();
          });

        // Backup safeguard check: if worker doesn't pipe frames in 2.5 seconds, trigger legacy layout
        setTimeout(() => {
          if (!active) return;
          if (Object.keys(frameCacheRef.current).length === 0) {
            console.warn("⚠️ [Safety Check] Worker timeout exceeded, swapping to main-thread decoder.");
            if (worker) {
              worker.terminate();
              worker = null;
            }
            runLegacyFallbackPipeline();
          }
        }, 2500);

      } catch (err) {
        console.warn("⚠️ Worker creation failed, starting legacy fallback immediately:", err);
        runLegacyFallbackPipeline();
      }
    } else {
      runLegacyFallbackPipeline();
    }

    // Explaining what changed & how to undo:
    // What changed: Implemented an inline Web Worker that uses MP4Box and WebCodecs VideoDecoder
    // to decode video frames in the background using an OffscreenCanvas, then posts ImageBitmaps
    // back to the main thread. It falls back dynamically to the highly robust sub-pixel legacy system.
    // How to undo: Completely revert this entire useEffect block back to the previous single HTMLVideoElement loop.
    return () => {
      active = false;
      clearLegacyTimeouts();
      if (worker) {
        worker.terminate();
      }
      if (legacyVideo && legacyVideo.parentNode) {
        legacyVideo.parentNode.removeChild(legacyVideo);
      }
      if (localBlobUrl) {
        URL.revokeObjectURL(localBlobUrl);
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

          // Sample from BOTH low and high textures with sub-pixel alignment
          vec3 colLow = texture2D(uTextureLow, flippedUv).rgb;
          vec3 colHigh = texture2D(uTextureHigh, flippedUv).rgb;

          // Custom hardware cross-fade blending to completely hide skipped/missing preloaded frames
          vec3 col = mix(colLow, colHigh, uBlendWeight);

          // Blend dyed concentration vector glowing paths
          vec3 neonGlow = vec3(0.0, 0.72, 1.0) * fluidDye * 0.5;
          col += neonGlow;

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

    // 2. Interpolate Hooke's Spring math in bare-metal WASM
    const wasm = initWasmPhysics();
    if (wasm) {
      currentVelocity.current = wasm.step_velocity(
        targetProgress.current,
        currentProgress.current,
        currentVelocity.current,
        120, // stiffness
        25,  // damping
        1.0, // mass
        dt
      );
      currentProgress.current = wasm.step_progress(
        currentProgress.current,
        currentVelocity.current,
        dt
      );
    } else {
      const displacement = targetProgress.current - currentProgress.current;
      const forceSpring = displacement * 120.0;
      const forceDamping = currentVelocity.current * 25.0;
      const acceleration = forceSpring - forceDamping;
      currentVelocity.current += acceleration * dt;
      currentProgress.current += currentVelocity.current * dt;
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

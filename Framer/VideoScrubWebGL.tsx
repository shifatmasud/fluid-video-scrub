/**
 * High-Performance Scroll-Driven Video Scrubber with GPGPU Fluid & Center Pinch Distortion
 * Built using React + React Three Fiber + Lenis Smooth Scroll.
 * 
 * Safety: Track errors, include tiny comments, clean syntax.
 * Overhauled: Replaced WASM-based second-layer physics solver with a native continuous Lerp dampening filter.
 * This completely prevents WASM initialization overhead/crashes in sandboxed environments.
 * Undo strategy: Restore prior git commit or reinstall wabt package & reintroduce WebAssembly.instantiate.
 */

import React, { useRef, useEffect, useState, useMemo, useImperativeHandle, forwardRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { videoPersistence } from "../services/videoPersistence";

// 1. Removed O(N) Bisection strategy (getProgressiveIndices) as it caused async decoder jumping.
// 2. Switched to Linear preloading for sequential hardware decoding efficiency.
// 3. Storing ImageBitmaps directly on mount to neutralize missed frames during seeking.
function getLinearIndices(total: number): number[] {
  return Array.from({ length: total }, (_, i) => i);
}

export interface VideoScrubWebGLHandle {
  exportRegistry: () => Promise<void>;
}

interface VideoScrubWebGLProps {
  videoUrl?: string;
  staticFrames?: string[];
  pinchPower?: number;
  fluidDistortionPower?: number;
  onScrub?: (progress: number) => void;
  numFrames?: number;
}

export const VideoScrubWebGL = forwardRef<VideoScrubWebGLHandle, VideoScrubWebGLProps>((props, ref) => {
  const {
    videoUrl = "https://res.cloudinary.com/dkemjl9se/video/upload/v1780345662/First-person_discovery_lake_vall__202606012155_bhyhue.mp4",
    staticFrames,
    pinchPower = 0.8,
    fluidDistortionPower = 1.6,
    onScrub,
    numFrames = 150,
  } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const targetProgress = useRef(0.0);
  const currentProgress = useRef(0.0);
  const currentVelocity = useRef(0);
  const lenisRef = useRef<any>(null);

  // Interaction State Detection to fuel 1:1 scrubbing vs. soft stop stabilization
  const isPointerDownRef = useRef(false);
  const isTouchingRef = useRef(false);
  const isWheelingRef = useRef(false);

  // DYNAMIC FRAMES EXTRACTOR: Resolves frame extraction cleanly over any frame scale.
  // Change logs: Swapped static total frame count with dynamic custom prop count parameter.
  // Undo: Revert back to static 192 assignment.
  const NUM_FRAMES = numFrames;
  // What changed: Replaced cachedCount and videoLoaded React state hooks with stable useRef pointers.
  // This completely decouples worker frame caching from React's state updater, preventing 192 redundant full-canvas re-renders.
  // How to undo: Revert these lines back to: const [cachedCount, setCachedCount] = useState(0); const [videoLoaded, setVideoLoaded] = useState(false);
  const frameCacheRef = useRef<{ [key: number]: THREE.Texture }>({});
  const cachedCountRef = useRef(0);

  // GPGPU Fluid coordinates tracing
  const pointerXRef = useRef(0.5);
  const pointerYRef = useRef(0.5);
  const pointerDxRef = useRef(0);
  const pointerDyRef = useRef(0);
  const pointerMovedRef = useRef(false);
  const pointerHoveredRef = useRef(false);

  // Screen-space pointer and touch move lock to prevent page scrolling relative-coords jumping
  const lastClientX = useRef<number | null>(null);
  const lastClientY = useRef<number | null>(null);
  const lastTouchX = useRef<number | null>(null);
  const lastTouchY = useRef<number | null>(null);

  // Scroll active state reference to completely isolate fluid ripples & camera parallax from scroll action
  const isScrollingRef = useRef(false);

  // Interaction Listener matching gestures and wheel states
  // What changed: Added active gesture, mouse down, touch action, and mouse wheel detection.
  // How to undo: Remove this useEffect and the associated pointer refs.
  useEffect(() => {
    const handlePointerDown = () => { isPointerDownRef.current = true; };
    const handlePointerUp = () => { isPointerDownRef.current = false; };
    const handleTouchStart = () => { isTouchingRef.current = true; };
    const handleTouchEnd = () => { isTouchingRef.current = false; };
    
    let wheelTimeout: any = null;
    const handleWheel = () => {
      isWheelingRef.current = true;
      if (wheelTimeout) clearTimeout(wheelTimeout);
      wheelTimeout = setTimeout(() => {
        isWheelingRef.current = false;
      }, 150);
    };

    window.addEventListener("pointerdown", handlePointerDown, { passive: true });
    window.addEventListener("pointerup", handlePointerUp, { passive: true });
    window.addEventListener("pointercancel", handlePointerUp, { passive: true });
    window.addEventListener("touchstart", handleTouchStart, { passive: true });
    window.addEventListener("touchend", handleTouchEnd, { passive: true });
    window.addEventListener("touchcancel", handleTouchEnd, { passive: true });
    window.addEventListener("wheel", handleWheel, { passive: true });

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchend", handleTouchEnd);
      window.removeEventListener("touchcancel", handleTouchEnd);
      window.removeEventListener("wheel", handleWheel);
      if (wheelTimeout) clearTimeout(wheelTimeout);
    };
  }, []);

  // 1. Native High-Performance 1:1 Scroll Link (No Lenis/Glide/Easing Lag)
  // What changed: Completely removed Lenis smooth scrolling library and its synthetic frame loop.
  // We now hook directly into the browser's native window and viewport scroll events, mapping scroll position
  // to targetProgress 1:1 instantaneously. This avoids double-easing lag, removes WebGL frame-loop thrashing
  // when scroll finishes, and guarantees real-time keyframe synchrony.
  // How to undo: Restore the original Lenis initialization block and package importing.
  useEffect(() => {
    // Traverse parent tree to hook into active scrollable viewport
    let scrollEl: HTMLElement | Window = window;
    const parentScrollport = containerRef.current?.closest(".custom-scrollbar-viewport") as HTMLElement;
    if (parentScrollport) {
      scrollEl = parentScrollport;
    }

    let scrollTimeout: any = null;
    const handleScroll = () => {
      // Mark scrolling active to isolate fluid sim and camera parallax from scroll jumps
      isScrollingRef.current = true;
      if (scrollTimeout) clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        isScrollingRef.current = false;
      }, 150);

      let progress = 0;
      if (scrollEl === window) {
        const scrollY = window.scrollY;
        const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
        if (maxScroll > 0) {
          progress = scrollY / maxScroll;
        }
      } else {
        const el = scrollEl as HTMLElement;
        const scrollTop = el.scrollTop;
        const maxScroll = el.scrollHeight - el.clientHeight;
        if (maxScroll > 0) {
          progress = scrollTop / maxScroll;
        }
      }
      targetProgress.current = Math.max(0.0001, Math.min(0.9999, progress));
    };

    // Run first layout evaluation
    handleScroll();

    scrollEl.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleScroll, { passive: true });

    return () => {
      scrollEl.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleScroll);
    };
  }, []);

  // Global pointer & touch coordinate tracking to fuel GPGPU fluid math
  useEffect(() => {
    const handleGlobalPointerMove = (e: PointerEvent) => {
      // Screen-space movement lock: Ignore if pointer is mathematically stationary in screen coordinates
      if (lastClientX.current === e.clientX && lastClientY.current === e.clientY) {
        return;
      }
      lastClientX.current = e.clientX;
      lastClientY.current = e.clientY;

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
        // Screen-space coordinate lock: Ignore if touch drag is mathematically stationary in screen coordinates
        if (lastTouchX.current === touch.clientX && lastTouchY.current === touch.clientY) {
          return;
        }
        lastTouchX.current = touch.clientX;
        lastTouchY.current = touch.clientY;

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

  // 3. STATIC REGISTRY EXPORTER
  // This logic iterates through the frameCacheRef (GPU TExtures), converts them to WebP base64,
  // and downloads a JSON file. This is purely for development to populate videoData.ts.
  const handleExportRegistry = async () => {
    const frames: string[] = [];
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Use the actual texture dimensions
    const sampleTex = Object.values(frameCacheRef.current)[0];
    if (!sampleTex || !sampleTex.image) {
      console.warn("No frames extracted yet. Please wait for preloading to finish.");
      return;
    }

    console.log(`[Static Export] Starting export of ${NUM_FRAMES} frames...`);

    const img = sampleTex.image as any;
    canvas.width = img.width || 1280;
    canvas.height = img.height || 720;

    for (let i = 0; i < NUM_FRAMES; i++) {
      const tex = frameCacheRef.current[i];
      if (tex && tex.image) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(tex.image as any, 0, 0, canvas.width, canvas.height);
        // Using WebP 0.7 for optimal balance between quality and file size for static registry
        frames.push(canvas.toDataURL("image/webp", 0.7));
      } else {
        frames.push(""); // Null frame placeholder
      }
    }

    const data = JSON.stringify({
      frames,
      config: {
        numFrames: NUM_FRAMES,
        width: canvas.width,
        height: canvas.height,
        generatedAt: new Date().toISOString()
      }
    }, null, 2);

    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `video-registry-${NUM_FRAMES}-frames.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    console.log(`[Static Export] Registry downloaded: video-registry-${NUM_FRAMES}-frames.json`);
  };

  useImperativeHandle(ref, () => ({
    exportRegistry: handleExportRegistry
  }));

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        backgroundColor: "#08080a",
        overflow: "hidden",
        pointerEvents: "none", 
      }}
    >
      <Canvas
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
      >
        <ScrubberScreen
          videoUrl={videoUrl}
          staticFrames={staticFrames}
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
          isPointerDownRef={isPointerDownRef}
          isTouchingRef={isTouchingRef}
          isWheelingRef={isWheelingRef}
          isScrollingRef={isScrollingRef}
        />
      </Canvas>
    </div>
  );
});

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

    // Decoupled fluid simulation advection values to increase the fluid dissipation time:
    // What changed:
    // 1. Increased velocity dissipation from 0.98 to 0.992 to retain flow/swirl momentum longer.
    // 2. Increased dye dissipation from 0.98 to 0.995 so the visible trails fade out much more slowly and gently.
    // How to undo:
    // Simply change both u_dissipation.value assignments below back to 0.98.
    
    this.advectMat.uniforms.u_velocity_texture.value = this.velocity.read.texture;
    this.advectMat.uniforms.u_input_texture.value = this.velocity.read.texture;
    this.advectMat.uniforms.u_dt.value = dt;
    this.advectMat.uniforms.u_dissipation.value = 0.992; // Retains velocity momentum (previously 0.98)
    this.renderPass(this.advectMat, this.velocity.write);
    this.velocity.swap();

    this.advectMat.uniforms.u_velocity_texture.value = this.velocity.read.texture;
    this.advectMat.uniforms.u_input_texture.value = this.dye.read.texture;
    this.advectMat.uniforms.u_dt.value = dt * 6.0;
    this.advectMat.uniforms.u_dissipation.value = 0.995; // Retains dye color visibility (previously 0.98)
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
  videoUrl: string;
  staticFrames?: string[];
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

  // Interaction refs passed down from parent
  isPointerDownRef: React.RefObject<boolean>;
  isTouchingRef: React.RefObject<boolean>;
  isWheelingRef: React.RefObject<boolean>;
  isScrollingRef: React.RefObject<boolean>;
}

function ScrubberScreen(props: ScrubberScreenProps) {
  const {
    videoUrl,
    staticFrames,
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
    isPointerDownRef,
    isTouchingRef,
    isWheelingRef,
    isScrollingRef,
  } = props;

  const { gl, size } = useThree();
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const prevReportedProgressRef = useRef<number>(-999);
  
  // 1. Hyper-Link Source Resolution: Resolves the local Blob URL from Cache Storage.
  // This eliminates network range-request overhead during parallel extraction.
  // Updated: Non-blocking resolution starts extraction immediately from network source.
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (staticFrames && staticFrames.length > 0) return; // Skip if using static frames

    let active = true;
    let localBlobUrl = "";

    const resolve = async () => {
      const initialUrl = await videoPersistence.resolve(videoUrl, (newLocalUrl) => {
        if (active) {
          console.log("⚡ [Persistence] Hyper-Link Handoff: Swapping to Local Blob");
          setResolvedUrl(newLocalUrl);
        }
      });
      if (active) setResolvedUrl(initialUrl);
    };

    resolve();

    return () => {
      active = false;
    };
  }, [videoUrl]);

  // 2. High-Speed Parallel Seeker Pool with Zero-Copy 720p Extraction
  // Change log: Expanded the parallel seeker units from 12 to 20 lanes, hitting the sweet spot for modern high-end GPU/VRAM bus saturation without causing hardware decoder stalls.
  // How to undo: Revert POOL_SIZE back to 4.
  useEffect(() => {
    if (!resolvedUrl || (staticFrames && staticFrames.length > 0)) return;

    let isDestroyed = false;
    const POOL_SIZE = 20;
    const seekerPool: HTMLVideoElement[] = [];
    
    // Initialize seeker pool
    for (let i = 0; i < POOL_SIZE; i++) {
      const v = document.createElement("video");
      v.src = resolvedUrl;
      v.crossOrigin = "anonymous";
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      v.style.position = "absolute";
      v.style.width = "0px";
      v.style.height = "0px";
      v.style.opacity = "0";
      v.style.pointerEvents = "none";
      document.body.appendChild(v);
      seekerPool.push(v);
    }

    // UPDATED: Dynamic Priority Queue for extraction.
    // Instead of a simple linear loop, we now try to load frames starting from the current progress
    // so the scrubber becomes interactive IMMEDIATELY at the user's position.
    let indicesToLoad = getLinearIndices(numFrames);
    let currentPoolIdx = 0;

    const extractFrameFromVideo = async (video: HTMLVideoElement, frameIdx: number) => {
      if (isDestroyed) return;

      try {
        // HYPER-SPEED: Zero-Copy 720p extraction
        const bitmap = await createImageBitmap(video, {
          imageOrientation: "none",
          premultiplyAlpha: "none",
        });

        if (isDestroyed) {
          bitmap.close();
          return;
        }

        const texture = new THREE.Texture(bitmap);
        texture.flipY = false;
        texture.generateMipmaps = false;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.needsUpdate = true;

        // Force zero-latency GPU upload
        gl.initTexture(texture);
        frameCacheRef.current[frameIdx] = texture;

        processNextInPool(video);
      } catch (err) {
        // On error, try next immediately
        processNextInPool(video);
      }
    };

    const processNextInPool = (video: HTMLVideoElement) => {
      if (isDestroyed) return;

      // Logic: Pick the index closest to targetProgress that hasn't been loaded
      const currentProgressIdx = Math.floor(targetProgress.current * (numFrames - 1));
      
      // Find nearest unloaded frame
      let bestIdx = -1;
      let minDistance = Infinity;

      // Efficient search near current head
      for (let i = 0; i < indicesToLoad.length; i++) {
        const idx = indicesToLoad[i];
        if (frameCacheRef.current[idx]) continue;
        
        const dist = Math.abs(idx - currentProgressIdx);
        if (dist < minDistance) {
          minDistance = dist;
          bestIdx = idx;
        }
        // Optimization: if we find the exact frame or neighbor, stop early
        if (dist <= 1) break;
      }

      if (bestIdx === -1) {
        // Check if everything is loaded
        const allLoaded = indicesToLoad.every(idx => frameCacheRef.current[idx]);
        if (allLoaded) {
          console.log("⚡ [Hyper-Speed] All frames extracted and GPU-uploaded!");
          return;
        }
        // If not all loaded but we couldn't find one in loop (shouldn't happen with filter), wait
        setTimeout(() => processNextInPool(video), 64);
        return;
      }
      
      const time = (bestIdx / (numFrames - 1)) * video.duration;
      if (!isNaN(time) && isFinite(time)) {
        const handleSeeked = () => {
          video.removeEventListener("seeked", handleSeeked);
          extractFrameFromVideo(video, bestIdx);
        };
        video.addEventListener("seeked", handleSeeked);
        video.currentTime = time;
      } else {
        // If duration not ready, wait a bit
        setTimeout(() => processNextInPool(video), 16);
      }
    };

    const initPool = () => {
      seekerPool.forEach((v) => {
        const onLoaded = () => {
          v.removeEventListener("loadedmetadata", onLoaded);
          processNextInPool(v);
        };
        v.addEventListener("loadedmetadata", onLoaded);
        if (v.readyState >= 1) processNextInPool(v);
      });
    };

    initPool();

    return () => {
      isDestroyed = true;
      seekerPool.forEach((v) => {
        try {
          v.pause();
          v.src = "";
          v.load();
          document.body.removeChild(v);
        } catch (_) {}
      });
      
      Object.values(frameCacheRef.current).forEach((tex) => {
        if (tex) {
          const img = tex.image as any;
          if (img && typeof img.close === "function") img.close();
          tex.dispose();
        }
      });
      frameCacheRef.current = {};
    };
  }, [resolvedUrl, gl, numFrames, staticFrames]);

  // 3. Static Frame Sequential Preloader
  // This effect handles the user-requested "TSX bitmap cache" logic.
  // It iterates through the staticFrames array, creates ImageBitmaps, and uploads to GPU textures.
  // This completely bypasses the video CPU/GPU decoding cycle.
  // How to undo: Clear the staticFrames prop in the parent component.
  useEffect(() => {
    if (!staticFrames || staticFrames.length === 0) return;

    let isDestroyed = false;
    const loader = new THREE.ImageLoader();

    const loadStatic = async () => {
      // Priority loading: load near targetProgress first similar to video seekers
      const indices = getLinearIndices(staticFrames.length);
      
      const loadIdx = async (idx: number) => {
        if (isDestroyed || frameCacheRef.current[idx]) return;

        try {
          const url = staticFrames[idx];
          // use Image bitmap for zero lag
          const img = await new Promise<HTMLImageElement>((res, rej) => {
            loader.load(url, res, undefined, rej);
          });
          
          const bitmap = await createImageBitmap(img);
          if (isDestroyed) {
             bitmap.close();
             return;
          }

          const texture = new THREE.Texture(bitmap);
          texture.flipY = false;
          texture.generateMipmaps = false;
          texture.minFilter = THREE.LinearFilter;
          texture.magFilter = THREE.LinearFilter;
          texture.needsUpdate = true;
          
          gl.initTexture(texture);
          frameCacheRef.current[idx] = texture;
        } catch (e) {
          console.warn(`[Static Preload] Failed for frame ${idx}`, e);
        }
      };

      // Load in chunks to avoid blocking
      for (let i = 0; i < indices.length; i++) {
        if (isDestroyed) break;
        await loadIdx(indices[i]);
        if (i % 5 === 0) await new Promise(r => setTimeout(r, 16)); // breathe
      }
    };

    loadStatic();

    return () => {
      isDestroyed = true;
    };
  }, [staticFrames, gl]);

  // 4. GPGPU Navier-stokes solver initialization
  const fluidSolver = useMemo(() => {
    const res = { w: 128, h: 128 };
    return new ThreeFluidSolver(gl, res);
  }, [gl]);

  useEffect(() => {
    return () => {
      fluidSolver.dispose();
    };
  }, [fluidSolver]);

  // Composition shader combining webgl fluid forces and fragment-based pincushion distortion with GLSL aspect ratios
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
        uniform vec2 uParallax;
        uniform float uTime;

        // Custom pseudorandom noise helper
        float rand(vec2 co) {
          return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
        }

        void main() {
          // Sample GPGPU Fluid displacement math directly on vUv
          vec2 fluidVelocity = texture2D(uFluidVelocity, vUv).xy;
          float fluidDye = texture2D(uFluidDye, vUv).r;

          // 2. Derive Height Field & Gradient mapping representing surface Normal Maps
          float stepOffset = 1.8 / uCanvasResolution.x;
          float dyeL = texture2D(uFluidDye, vUv + vec2(-stepOffset, 0.0)).r;
          float dyeR = texture2D(uFluidDye, vUv + vec2(stepOffset, 0.0)).r;
          float dyeT = texture2D(uFluidDye, vUv + vec2(0.0, -stepOffset)).r;
          float dyeB = texture2D(uFluidDye, vUv + vec2(0.0, stepOffset)).r;

          // Height field gradient (∇height)
          vec2 heightGradient = vec2(dyeR - dyeL, dyeB - dyeT);
          float slopeMagnitude = length(heightGradient); // |∇height| (slope magnitude)

          // 3. Normal Map construction for Refraction Realism (Not simple depth offsets)
          vec3 normal = normalize(vec3(heightGradient * 2.8, 0.20));

          // Fluid trail refraction distortion vector: driven by normal.xy and height gradient
          // Scale refraction offset safely by the uniform distortion coefficient uFluidDistortionPower
          vec2 fluidDistort = normal.xy * uFluidDistortionPower * 0.22;

          // 4. Fragment-based 3D perspective parallax projection (homography tilt approximation)
          vec2 p = vUv - vec2(0.5);
          float tiltX = uParallax.y * 0.15; // horizontal rotation axis
          float tiltY = uParallax.x * 0.15; // vertical rotation axis
          
          float depthFactor = 1.0 + p.x * tiltY - p.y * tiltX;
          vec2 tiltedP = p / max(0.5, depthFactor);
          
          // Gentle lateral 3D translation parallax (slide)
          tiltedP -= uParallax * 0.03;

          // 5. Fragment-based pincushion distortion to warp texture coordinates inward (concave effect)
          vec2 pScreen = tiltedP;
          pScreen.x *= (uCanvasResolution.x / uCanvasResolution.y);
          float r2 = dot(pScreen, pScreen);

          // Pincushion warping coordinates inward towards center. Scaled safely by uPinchPower
          float distortFactor = 1.0 - uPinchPower * r2;
          vec2 warpedUv = vec2(0.5) + tiltedP * distortFactor;

          // Combine pincushion coordinates with the active fluid simulation normal-mapped refraction path
          vec2 uv = clamp(warpedUv - fluidDistort, 0.001, 0.999);

          // 6. Original video frame bitmap aspect ratio locked fitting
          float canvasAspect = uCanvasResolution.x / uCanvasResolution.y;
          float textureAspect = uTextureResolution.x / uTextureResolution.y;

          if (canvasAspect > textureAspect) {
            float scale = textureAspect / canvasAspect;
            uv.y = (uv.y - 0.5) * scale + 0.5;
          } else {
            float scale = canvasAspect / textureAspect;
            uv.x = (uv.x - 0.5) * scale + 0.5;
          }

          // Safe margin clip protection: Render deep background if distorted coords exit boundary
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
            gl_FragColor = vec4(0.04, 0.04, 0.05, 1.0);
            return;
          }

          // Sample textures using final undistorted/perfectly-mapped coordinates
          vec2 flippedUv = vec2(uv.x, 1.0 - uv.y);

          // Generate dynamic grain noise (changes with time over coordinates)
          float grainNoise = rand(flippedUv * (sin(uTime) * 10.0 + 15.0)) - 0.5;

          // Snapping bounds checks to optimize texture sampling rate
          vec3 colMain;
          if (uBlendWeight < 0.005) {
            colMain = texture2D(uTextureLow, flippedUv).rgb;
          } else if (uBlendWeight > 0.995) {
            colMain = texture2D(uTextureHigh, flippedUv).rgb;
          } else {
            colMain = mix(texture2D(uTextureLow, flippedUv).rgb, texture2D(uTextureHigh, flippedUv).rgb, uBlendWeight);
          }

          vec3 col = colMain;

          // Only branch into expensive multi-sample blurred texture fetches if fluid ripples are actively present
          if (fluidDye > 0.005) {
            // Compute blurring vector along velocity direction, scaled by dye concentration
            vec2 blurOffset = normalize(fluidVelocity + 0.0001) * fluidDye * (0.026 + 0.012 * grainNoise);
            vec2 flippedUvBlur1 = clamp(flippedUv + blurOffset, 0.001, 0.999);
            vec2 flippedUvBlur2 = clamp(flippedUv - blurOffset, 0.001, 0.999);

            vec3 colBlur1;
            if (uBlendWeight < 0.005) {
              colBlur1 = texture2D(uTextureLow, flippedUvBlur1).rgb;
            } else if (uBlendWeight > 0.995) {
              colBlur1 = texture2D(uTextureHigh, flippedUvBlur1).rgb;
            } else {
              colBlur1 = mix(texture2D(uTextureLow, flippedUvBlur1).rgb, texture2D(uTextureHigh, flippedUvBlur1).rgb, uBlendWeight);
            }

            vec3 colBlur2;
            if (uBlendWeight < 0.005) {
              colBlur2 = texture2D(uTextureLow, flippedUvBlur2).rgb;
            } else if (uBlendWeight > 0.995) {
              colBlur2 = texture2D(uTextureHigh, flippedUvBlur2).rgb;
            } else {
              colBlur2 = mix(texture2D(uTextureLow, flippedUvBlur2).rgb, texture2D(uTextureHigh, flippedUvBlur2).rgb, uBlendWeight);
            }

            vec3 colBlur = (colBlur1 + colBlur2) * 0.5;
            
            // Water trail light absorption: volume-based shadow depth instead of foggy smoke
            // Water absorbs red light more quickly, producing an ultra-transparent water-lens refraction effect.
            vec3 waterAbsorption = vec3(1.0) - vec3(0.14, 0.06, 0.02) * clamp(fluidDye * 2.4, 0.0, 0.45);
            col = colBlur * waterAbsorption;
          }

          // Apply gorgeous soft grain overlay overall, with custom styling
          col += vec3(grainNoise) * 0.025;

          // Virtual directional light source to reflect specular glare
          vec3 lightDir = normalize(vec3(-0.35, 0.35, 0.6));
          vec3 viewDir = vec3(0.0, 0.0, 1.0);
          vec3 halfDir = normalize(lightDir + viewDir);

          // Only the disturbed areas waves crest: scale highlight specular by fluid activity
          float fluidVelocityMag = length(fluidVelocity);
          float disturbance = clamp(fluidDye * 3.5 + fluidVelocityMag * 0.3, 0.0, 1.0);

          // Wave edge should have diffused gentle dispersion too. Very specular (Added 2026-06-13).
          // What changed: Implemented three-channel (RGB) normal maps, split Blinn-Phong highlights,
          // and added a soft diffused chromatic dispersion edge glow based on slope magnitude.
          // How to undo: Restore one-channel Blinn-Phong specular with flat vec3(1.0) and delete waveEdgeDispersion.
          vec2 gradDir = normalize(heightGradient + vec2(1e-5));

          // Set up chromatic shifts depending on slope and velocity.
          // Tightened dispersion factor for realistic high-end glass refraction, preventing massive pink/magenta color separations.
          float dispFactor = 0.012 * (1.0 + fluidVelocityMag * 0.08);
          vec3 normalR = normalize(vec3(heightGradient * 2.8 + gradDir * dispFactor, 0.20));
          vec3 normalG = normalize(vec3(heightGradient * 2.8, 0.20));
          vec3 normalB = normalize(vec3(heightGradient * 2.8 - gradDir * dispFactor, 0.20));

          // Compute Blinn-Phong specular intensity for each channel individually (highly specular)
          float ndhR = max(0.0, dot(normalR, halfDir));
          float ndhG = max(0.0, dot(normalG, halfDir));
          float ndhB = max(0.0, dot(normalB, halfDir));

          float specR = pow(ndhR, 42.0) * disturbance * 3.8;
          float specG = pow(ndhG, 42.0) * disturbance * 3.8;
          float specB = pow(ndhB, 42.0) * disturbance * 3.8;

          // Edge/slope emphasis (|∇height| / slopeMagnitude) shifted per channel for spectacular colorful wave edges
          float edgeR = smoothstep(0.012, 0.22, length(heightGradient + gradDir * (dispFactor * 0.1))) * 2.0;
          float edgeG = smoothstep(0.012, 0.22, slopeMagnitude) * 2.0;
          float edgeB = smoothstep(0.012, 0.22, length(heightGradient - gradDir * (dispFactor * 0.1))) * 2.0;

          float waveCrestR = specR * edgeR;
          float waveCrestG = specG * edgeG;
          float waveCrestB = specB * edgeB;

          // Sharp steep parts (crest lines)
          float steepR = smoothstep(0.04, 0.25, length(heightGradient + gradDir * (dispFactor * 0.15))) * disturbance * 1.6;
          float steepG = smoothstep(0.04, 0.25, slopeMagnitude) * disturbance * 1.6;
          float steepB = smoothstep(0.04, 0.25, length(heightGradient - gradDir * (dispFactor * 0.15))) * disturbance * 1.6;

          // Specular highlights with beautiful, organic-feeling sparkling grain and chromatic dispersion splits
          float noiseMultiplier = 0.8 + 0.2 * rand(vUv * uTime);
          vec3 specularHighlight = vec3(
            (waveCrestR + steepR) * noiseMultiplier,
            (waveCrestG + steepG) * noiseMultiplier,
            (waveCrestB + steepB) * noiseMultiplier
          );

          // Build a diffused gentle dispersion glow component for the wave edge
          // Re-balanced RGB coefficients to form a natural, premium chromatic white light split instead of solid saturated pink.
          vec3 waveEdgeDispersion = vec3(0.0);
          if (slopeMagnitude > 0.002) {
            float softR = smoothstep(0.01, 0.32, length(heightGradient + gradDir * 0.018)) * disturbance;
            float softG = smoothstep(0.01, 0.32, slopeMagnitude) * disturbance;
            float softB = smoothstep(0.01, 0.32, length(heightGradient - gradDir * 0.018)) * disturbance;
            // Naturally balanced glass-prism dispersion profile (smooth off-white blending merging to pristine amber/cyan fringes)
            waveEdgeDispersion = vec3(softR * 0.25, softG * 0.28, softB * 0.33) * uFluidDistortionPower * 1.5;
          }

          // Subtle deep water cyan-teal sheen layer (subtle ocean-like refraction light tint, replacing thick opaque neon blue)
          vec3 waterSheen = vec3(0.02, 0.14, 0.20) * fluidDye * 0.28;
          col += waterSheen;

          // Superimpose the white specular gloss map with chromatic splits
          col += specularHighlight;

          // Superimpose the diffused wave edge chromatic dispersion glow
          col += waveEdgeDispersion;

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
        uParallax: { value: new THREE.Vector2(0, 0) },
        uTime: { value: 0 },
      }
    });
  }, []);

  // Dynamic updates of configuration uniforms to avoid shader recompilation bottlenecks
  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.uFluidDistortionPower.value = fluidDistortionPower;
      materialRef.current.uniforms.uPinchPower.value = pinchPower;
    } else {
      material.uniforms.uFluidDistortionPower.value = fluidDistortionPower;
      material.uniforms.uPinchPower.value = pinchPower;
    }
  }, [fluidDistortionPower, pinchPower, material]);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.03);

    // Decoupled scroll and other events to ensure fluid ripples work even on scroll.
    // What changed:
    // 1. Removed the isScrollingRef.current pointer velocity dampening that reset deltas to zero on scroll.
    // 2. Removed the !isScrollingRef.current constraint from the GPGPU fluid splat trigger.
    // 3. Removed the isScrollingRef.current check from parallax calculations to maintain real-time responsiveness.
    // How to undo:
    // To restore the blocking/damping behavior during scroll, uncomment the block resetting pointerDxRef/pointerDyRef to 0,
    // and re-introduce the `!isScrollingRef.current` condition in BOTH the `pointerMovedRef.current` splat block and the targetParallax calculations.

    // Zero-overload GPU precached frames ready. Dynamic sequential seekers pre-upload everything
    // directly on 'seeked' callbacks, completely bypassing scroll-time RAF budget bottlenecks.

    // 1. GPGPU splat ripples based on cursors - decoupled to work even during active page scroll actions
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

    // Parallax update (Gentle 3D camera parallax effect using coordinates from fluid solver pointer events)
    // Smoothly slides/tilts with mouse/touch movements, completely decoupled from scroll status.
    const targetParallaxX = pointerXRef.current - 0.5;
    const targetParallaxY = pointerYRef.current - 0.5;

    // What changed: Drive the uParallax uniform values directly in the fragment shader for perfect WebGL projection.
    // How to undo: Set these values flatly to 0.0 in the Lerp calls or remove them.
    if (materialRef.current) {
      materialRef.current.uniforms.uParallax.value.x = THREE.MathUtils.lerp(materialRef.current.uniforms.uParallax.value.x, targetParallaxX, 0.08);
      materialRef.current.uniforms.uParallax.value.y = THREE.MathUtils.lerp(materialRef.current.uniforms.uParallax.value.y, targetParallaxY, 0.08);
    } else {
      material.uniforms.uParallax.value.x = THREE.MathUtils.lerp(material.uniforms.uParallax.value.x, targetParallaxX, 0.08);
      material.uniforms.uParallax.value.y = THREE.MathUtils.lerp(material.uniforms.uParallax.value.y, targetParallaxY, 0.08);
    }

    if (meshRef.current) {
      // Rotation tilt calculations
      meshRef.current.rotation.y = THREE.MathUtils.lerp(meshRef.current.rotation.y, targetParallaxX * 0.15, 0.08);
      meshRef.current.rotation.x = THREE.MathUtils.lerp(meshRef.current.rotation.x, -targetParallaxY * 0.15, 0.08);

      // Slide coordinates parallax calculations
      meshRef.current.position.x = THREE.MathUtils.lerp(meshRef.current.position.x, targetParallaxX * 0.12, 0.08);
      meshRef.current.position.y = THREE.MathUtils.lerp(meshRef.current.position.y, -targetParallaxY * 0.12, 0.08);
    }

    // 2. Pure 1:1 Absolute Sync Scrubber (No Glide / Easing Lag)
    // What changed: Removed the high-inertia smoothing or ease lag completely. Mapped currentProgress to targetProgress 1:1.
    // This stops rendering-loop texture binds once scrolling settles, fully neutralizing stutter and lag.
    // How to undo: Restore the exponential lerp power and factor equations.
    const prevProgress = currentProgress.current;
    currentProgress.current = Math.max(0.0001, Math.min(0.9999, targetProgress.current));
    
    // Estimate continuous progress velocity for fluid splats
    const targetVelocity = dt > 0 ? (currentProgress.current - prevProgress) / dt : 0;
    currentVelocity.current = currentVelocity.current * 0.85 + targetVelocity * 0.15;

    // 3. WebGL Temporal Frame Blend Engine
    // Calculates closest available bounding low and high caches and cross-fades them linearly on GPU.
    const frameIndexFloat = currentProgress.current * (numFrames - 1);
    const targetIdx = Math.floor(frameIndexFloat);

    let lowIdx = -1;
    let highIdx = -1;

    // What changed: Replaced O(N) Object.keys allocation and parseInt() scans with a flat, direct outbound search.
    // Since we know the exactly estimated targetIdx, we scan downwards and upwards from it. This hits in O(1) mostly
    // and eliminates 192 string-allocations and parseInt() calls per frame, removing garbage collection stutter.
    // How to undo: Revert to keys = Object.keys(frameCacheRef.current); and linear scanner loops.
    if (frameCacheRef.current) {
      for (let i = targetIdx; i >= 0; i--) {
        if (frameCacheRef.current[i]) {
          lowIdx = i;
          break;
        }
      }
      for (let i = targetIdx; i < numFrames; i++) {
        if (frameCacheRef.current[i]) {
          highIdx = i;
          break;
        }
      }
    }

    // Fallbacks if bounds are half-open (e.g. only some loaded)
    if (lowIdx === -1 && highIdx !== -1) lowIdx = highIdx;
    if (highIdx === -1 && lowIdx !== -1) highIdx = lowIdx;

    const textureLow = lowIdx !== -1 ? frameCacheRef.current[lowIdx] : null;
    const textureHigh = highIdx !== -1 ? frameCacheRef.current[highIdx] : null;

    // Direct interpolation weight factor
    // What changed: Implemented a Maximum Blend Gap of 4 frames.
    // If the cache gap between lowIdx and highIdx is too large, cross-fading creates a ghostly double-exposure.
    // By setting blendWeight to 0.0 or 1.0 (snapping to the closest loaded frame), we achieve crisp playback.
    // How to undo: Revert this block back to standard linear calculation:
    // const blendWeight = lowIdx === highIdx || lowIdx === -1 ? 0.0 : (frameIndexFloat - lowIdx) / (highIdx - lowIdx);
    const maxBlendGap = 4;
    let blendWeight = 0.0;
    if (lowIdx !== -1 && highIdx !== -1 && lowIdx !== highIdx) {
      if (highIdx - lowIdx <= maxBlendGap) {
        blendWeight = (frameIndexFloat - lowIdx) / (highIdx - lowIdx);
      } else {
        // Snaps to the closest loaded frame to avoid ghosting overlays
        blendWeight = (frameIndexFloat - lowIdx < highIdx - frameIndexFloat) ? 0.0 : 1.0;
      }
    }

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

    const diff = Math.abs(currentProgress.current - prevReportedProgressRef.current);
    if (diff > 1e-6) {
      if (onScrub) {
        onScrub(currentProgress.current);
      }
      prevReportedProgressRef.current = currentProgress.current;
    }
  });

  return (
    <mesh ref={meshRef} scale={[1.15, 1.15, 1]}>
      <planeGeometry args={[2, 2]} />
      <primitive object={material} ref={materialRef} attach="material" />
    </mesh>
  );
}

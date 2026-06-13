/**
 * Minimalist Pristine Page Component for WARPSCRUB
 * Renders the full-screen interactive WebGL frame scrubber background and displays telemetry in standard typography.
 * Follows the rules: No GSAP, no Framer Motion, No Tailwind, typography applied via spreads, mobile-first design.
 * 
 * Safety: Track errors, add tiny comments, clean native style bindings.
 * Undo: Revert back to historical multi-window HUD backup if desired.
 */

import React, { useRef, useState } from "react";
import { useTheme } from "../../Theme.tsx";
import { VideoScrubWebGL, VideoScrubWebGLHandle } from "../../Framer/VideoScrubWebGL.tsx";
import { STATIC_VIDEO_FRAMES } from "../../services/videoData.ts";

export default function Home() {
  const { theme } = useTheme();
  const [isHudCollapsed, setIsHudCollapsed] = useState(false);
  const progressTextRef = useRef<HTMLSpanElement>(null);
  const videoRef = useRef<VideoScrubWebGLHandle>(null);
  const frameIndexRef = useRef<HTMLSpanElement>(null);
  const prevTickIdxRef = useRef<number>(0);

  // Layout parent container style: Fixed to viewport to stay above scrolling context
  const containerStyle: React.CSSProperties = {
    position: "fixed",
    top: 0,
    left: 0,
    width: "100%",
    height: "100vh",
    backgroundColor: "transparent",
    color: theme.Color.Base.Content[1],
    fontFamily: theme.Type.Readable.Body.M.fontFamily,
    pointerEvents: "none", // Allow clicks to fall through to WebGL drag/touch solver unless specified
    zIndex: 10,
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    padding: "40px",
    boxSizing: "border-box",
  };

  // Header display branding styling
  const headerStyle: React.CSSProperties = {
    pointerEvents: "auto",
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    maxWidth: "400px",
    gap: "12px",
  };

  const titleStyle: React.CSSProperties = {
    ...theme.Type.Expressive.Display.L,
    fontSize: "44px",
    lineHeight: "44px",
    letterSpacing: "-0.01em",
    color: "#FFFFFF",
    margin: 0,
    textTransform: "uppercase",
  };

  const subtitleStyle: React.CSSProperties = {
    ...theme.Type.Readable.Body.L,
    color: "rgba(255, 255, 255, 0.45)",
    margin: 0,
    lineHeight: "22px",
  };

  // Bottom stats HUD panel styling
  const hudStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    pointerEvents: "auto",
    fontFamily: "'JetBrains Mono', monospace",
  };

  const countStyle: React.CSSProperties = {
    ...theme.Type.Expressive.Display.L,
    fontSize: "96px",
    lineHeight: "96px",
    fontWeight: "bold",
    color: "#FFFFFF",
    margin: 0,
  };

  const statusLabelStyle: React.CSSProperties = {
    ...theme.Type.Expressive.Data,
    fontSize: "11px",
    color: "rgba(255, 255, 255, 0.35)",
    textTransform: "uppercase",
    letterSpacing: "0.15em",
  };

  return (
    <>
      {/* Background Interactive WebGL canvas layer */}
      <div
        id="webgl-canvas-background"
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: "100vw",
          height: "100vh",
          zIndex: 0,
          pointerEvents: "none", // Let touch events completely bleed through to the scrolling container
          userSelect: "none",
        }}
      >
        {/* 
          Change: Rendering background scrubber using high-performance pre-loaded static frames.
          Undo: Switch back to videoUrl instead of staticFrames to fetch streaming Cloudinary video.
        */}
        <VideoScrubWebGL
          ref={videoRef}
          staticFrames={STATIC_VIDEO_FRAMES}
          numFrames={STATIC_VIDEO_FRAMES.length}
          pinchPower={0.9}
          fluidDistortionPower={1.8}
          onScrub={(prog) => {
            if (progressTextRef.current) {
              progressTextRef.current.textContent = String(Math.round(prog * 100)).padStart(3, "0");
            }
            if (frameIndexRef.current) {
              const currentFrame = Math.round(prog * (STATIC_VIDEO_FRAMES.length - 1 || 149));
              frameIndexRef.current.textContent = "F-" + String(currentFrame).padStart(3, "0");
            }
            const bar = document.getElementById("progress-bar-fill");
            if (bar) {
              bar.style.width = `${prog * 100}%`;
            }

            // High-frequency GPU tick highlighter
            const activeTickIdx = Math.round(prog * 49);
            if (prevTickIdxRef.current !== activeTickIdx) {
              const oldTick = document.getElementById(`buffer-tick-${prevTickIdxRef.current}`);
              if (oldTick) {
                oldTick.style.backgroundColor = "rgba(255, 255, 255, 0.15)";
                oldTick.style.transform = "scaleY(1)";
              }
              const newTick = document.getElementById(`buffer-tick-${activeTickIdx}`);
              if (newTick) {
                newTick.style.backgroundColor = "#00b2ff";
                newTick.style.transform = "scaleY(1.4)";
              }
              prevTickIdxRef.current = activeTickIdx;
            }
          }}
        />
      </div>

      {/* Simulator scroll heights for standard Lenis interception */}
      <div
        id="scroll-bound-simulator"
        style={{
          height: "350vh",
          width: "100%",
          pointerEvents: "auto", // Handle native mobile scrolls and touch swipings
          position: "absolute",
          top: 0,
          left: 0,
          zIndex: 1,
        }}
      />

      {/* CSS Keyframes styled for HUD performance */}
      <style>{`
        @keyframes hud-glow-pulse {
          0% {
            opacity: 0.5;
            box-shadow: 0 0 6px rgba(0, 178, 255, 0.3);
          }
          50% {
            opacity: 1;
            box-shadow: 0 0 16px rgba(0, 178, 255, 0.95), 0 0 4px rgba(0, 178, 255, 0.5);
          }
          100% {
            opacity: 0.5;
            box-shadow: 0 0 6px rgba(0, 178, 255, 0.3);
          }
        }
        .hud-pulsing-dot {
          animation: hud-glow-pulse 1.8s infinite ease-in-out;
        }
      `}</style>

      {/* Foreground Minimal UI */}
      <div style={containerStyle}>
        {/* Visual Brand Header */}
        <header style={headerStyle}>
          <h1 style={titleStyle}>WARPSCRUB</h1>
          <p style={subtitleStyle}>
            A bare-metal, scroll-interpolated chronological scrubber. Scroll anywhere to scrub. Move cursor or drag-touch to swirl liquid ripples.
          </p>
          <button
            onClick={() => videoRef.current?.exportRegistry()}
            style={{
              marginTop: "16px",
              padding: "10px 16px",
              backgroundColor: "rgba(255, 255, 255, 0.05)",
              backdropFilter: "blur(12px)",
              border: "1px solid rgba(255, 255, 255, 0.1)",
              borderRadius: "8px",
              color: "white",
              fontSize: "11px",
              fontWeight: "600",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              cursor: "pointer",
              transition: "all 0.2s cubic-bezier(0.23, 1, 0.32, 1)"
            }}
          >
            Download Frame Registry
          </button>
        </header>

        {/* Collapsible Cinematic progress HUD instruments bar */}
        <div style={{ position: "relative", width: "100%", pointerEvents: "auto" }}>
          {/* Toggle Button Container */}
          <div style={{ 
            display: "flex", 
            justifyContent: "center", 
            marginBottom: "8px",
            opacity: 0.6,
            transition: "opacity 0.2s ease"
          }}>
            <button
              onClick={() => setIsHudCollapsed(!isHudCollapsed)}
              style={{
                backgroundColor: "rgba(8, 8, 10, 0.8)",
                border: "1px solid rgba(255, 255, 255, 0.1)",
                borderRadius: "20px",
                padding: "4px 16px",
                color: "white",
                fontSize: "9px",
                fontFamily: "'JetBrains Mono', monospace",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                cursor: "pointer",
                boxShadow: "0 4px 12px rgba(0,0,0,0.4)"
              }}
            >
              {isHudCollapsed ? "[+] EXPAND TELEMETRY" : "[-] COLLAPSE HUD"}
            </button>
          </div>

          <div
            style={{
              backgroundColor: "rgba(8, 8, 10, 0.45)",
              backdropFilter: "blur(20px)",
              border: "1px solid rgba(255, 255, 255, 0.08)",
              borderRadius: "16px",
              padding: isHudCollapsed ? "0" : "24px 32px",
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "space-between",
              gap: isHudCollapsed ? "0" : "28px",
              width: "100%",
              height: isHudCollapsed ? "0px" : "auto",
              maxHeight: isHudCollapsed ? "0px" : "500px",
              opacity: isHudCollapsed ? 0 : 1,
              overflow: "hidden",
              boxSizing: "border-box",
              fontFamily: "'JetBrains Mono', monospace",
              boxShadow: "0 20px 40px rgba(0, 0, 0, 0.6)",
              transition: "all 0.4s cubic-bezier(0.16, 1, 0.3, 1)",
              visibility: isHudCollapsed ? "hidden" : "visible",
            }}
          >
          {/* Column 1: CHRONOLOGICAL PROGRESS */}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", flex: "1 1 250px" }}>
            <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em" }}>
              01 // SCROLL CHRONO-TRACK
            </span>
            <div style={{ display: "flex", alignItems: "baseline", gap: "2px", margin: "4px 0" }}>
              <span ref={progressTextRef} style={countStyle}>000</span>
              <span
                style={{
                  ...theme.Type.Expressive.Display.S,
                  fontSize: "24px",
                  color: "rgba(255,255,255,0.4)",
                }}
              >
                %
              </span>
            </div>
            
            {/* Progress Bar Container */}
            <div style={{ 
              width: "100%", 
              height: "3px", 
              backgroundColor: "rgba(255,255,255,0.1)", 
              position: "relative",
              overflow: "hidden",
              borderRadius: "2px"
            }}>
              <div 
                id="progress-bar-fill"
                style={{ 
                  position: "absolute",
                  top: 0,
                  left: 0,
                  height: "100%",
                  width: "0%",
                  backgroundColor: "#00b2ff",
                  transition: "width 0.1s linear"
                }} 
              />
            </div>
            <span style={{ ...statusLabelStyle, fontSize: "9px", marginTop: "2px" }}>
              SCROLL POSITION INTERPOLATION INDEX
            </span>
          </div>

          {/* Column 2: RESOURCE SEQUENCE BUFFER */}
          <div style={{ 
            display: "flex", 
            flexDirection: "column", 
            gap: "8px", 
            flex: "1 1 320px", 
            paddingLeft: "24px", 
            borderLeft: "1px dashed rgba(255,255,255,0.1)" 
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em" }}>
                02 // HARDWARE IMAGE STREAM
              </span>
              <span 
                ref={frameIndexRef} 
                style={{ 
                  fontSize: "12px", 
                  color: "#00b2ff", 
                  fontWeight: "bold",
                  backgroundColor: "rgba(0, 178, 255, 0.1)",
                  padding: "2px 8px",
                  borderRadius: "4px",
                  border: "1px solid rgba(0, 178, 255, 0.2)"
                }}
              >
                F-000
              </span>
            </div>

            {/* Micro ticks visualizer */}
            <div style={{ 
              display: "flex", 
              gap: "3px", 
              height: "28px", 
              alignItems: "flex-end", 
              backgroundColor: "rgba(255,255,255,0.02)", 
              padding: "6px 8px", 
              borderRadius: "6px",
              border: "1px solid rgba(255,255,255,0.04)",
              marginTop: "4px"
            }}>
              {Array.from({ length: 50 }).map((_, i) => (
                <div
                  key={i}
                  id={`buffer-tick-${i}`}
                  style={{
                    flex: 1,
                    height: "100%",
                    backgroundColor: i === 0 ? "#00b2ff" : "rgba(255, 255, 255, 0.15)",
                    borderRadius: "1px",
                    transform: i === 0 ? "scaleY(1.4)" : "scaleY(1)",
                    transformOrigin: "bottom",
                    transition: "all 0.15s cubic-bezier(0.16, 1, 0.3, 1)",
                  }}
                />
              ))}
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", color: "rgba(255,255,255,0.35)", marginTop: "2px" }}>
              <span>SLICE_000</span>
              <span>150 BITMAP REGISTERS READY</span>
              <span>SLICE_149</span>
            </div>
          </div>

          {/* Column 3: SYSTEM MODE STATUS */}
          <div style={{ 
            display: "flex", 
            flexDirection: "column", 
            gap: "8px", 
            flex: "1 1 250px", 
            paddingLeft: "24px", 
            borderLeft: "1px dashed rgba(255,255,255,0.1)" 
          }}>
            <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em" }}>
              03 // COMPILE MODE STATUS
            </span>

            {/* Pulse Mode Badge */}
            <div style={{ 
              display: "flex", 
              alignItems: "center", 
              gap: "10px", 
              backgroundColor: "rgba(0, 178, 255, 0.05)", 
              border: "1px solid rgba(0, 178, 255, 0.15)", 
              padding: "10px 14px", 
              borderRadius: "8px",
              marginTop: "4px"
            }}>
              <div 
                className="hud-pulsing-dot"
                style={{ 
                  width: "10px", 
                  height: "10px", 
                  borderRadius: "50%", 
                  backgroundColor: "#00b2ff"
                }} 
              />
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: "11px", color: "#FFFFFF", fontWeight: "bold", textTransform: "uppercase" }}>
                  {STATIC_VIDEO_FRAMES.length > 0 ? "GL_STATIC_REGISTRY" : "VIDEO_STREAM_MP4"}
                </span>
                <span style={{ fontSize: "9px", color: "rgba(255,255,255,0.4)" }}>
                  ZERO DECODE STUTTER • GPU INSTANT
                </span>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "9px", color: "rgba(255,255,255,0.3)", marginTop: "4px" }}>
              <span>RENDER ENGINE: WEBGL-2</span>
              <span>•</span>
              <span>SCALE: 1280X720 HD</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </>
);
}

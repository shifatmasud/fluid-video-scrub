/**
 * Minimalist Pristine Page Component for WARPSCRUB
 * Renders the full-screen interactive WebGL frame scrubber background and displays telemetry in standard typography.
 * Follows the rules: No GSAP, no Framer Motion, No Tailwind, typography applied via spreads, mobile-first design.
 * 
 * Safety: Track errors, add tiny comments, clean native style bindings.
 * Undo: Revert back to historical multi-window HUD backup if desired.
 */

import React, { useState } from "react";
import { useTheme } from "../../Theme.tsx";
import { VideoScrubWebGL } from "../../Framer/VideoScrubWebGL.tsx";

export default function Home() {
  const { theme } = useTheme();
  const [progress, setProgress] = useState(0);

  // Layout parent container style
  const containerStyle: React.CSSProperties = {
    position: "relative",
    width: "100%",
    minHeight: "100vh",
    backgroundColor: "transparent",
    color: theme.Color.Base.Content[1],
    fontFamily: theme.Type.Readable.Body.M.fontFamily,
    pointerEvents: "none", // Allow clicks to fall through to WebGL drag/touch solver
    zIndex: 2,
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    padding: "32px",
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
        <VideoScrubWebGL
          videoUrl="https://res.cloudinary.com/dkemjl9se/video/upload/v1780345662/First-person_discovery_lake_vall__202606012155_bhyhue.mp4"
          pinchPower={0.9}
          fluidDistortionPower={1.8}
          onScrub={(prog) => setProgress(Math.round(prog * 100))}
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

      {/* Foreground Minimal UI */}
      <div style={containerStyle}>
        {/* Visual Brand Header */}
        <header style={headerStyle}>
          <h1 style={titleStyle}>WARPSCRUB</h1>
          <p style={subtitleStyle}>
            A bare-metal, scroll-interpolated chronological scrubber. Scroll anywhere to scrub. Move cursor or drag-touch to swirl liquid ripples.
          </p>
        </header>

        {/* Cinematic progress indicator in display metrics */}
        <div style={hudStyle}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "2px" }}>
            <span style={countStyle}>{String(progress).padStart(3, "0")}</span>
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
          <span style={statusLabelStyle}>SCROLL POSITION INDEX</span>
        </div>
      </div>
    </>
  );
}

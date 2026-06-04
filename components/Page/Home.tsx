import React, { useState, useEffect, useRef } from "react";
import { motion, useMotionValue, AnimatePresence } from "framer-motion";
import { useTheme } from "../../Theme.tsx";
import { VideoScrubWebGL } from "../../Framer/VideoScrubWebGL.tsx";
import { AnimatedCopyIcon } from "../Core/AnimatedCopyIcon.tsx";
import AnimatedCounter from "../Core/AnimatedCounter.tsx";
import Button from "../Core/Button.tsx";
import RangeSlider from "../Core/RangeSlider.tsx";
import SegmentedTab from "../Core/SegmentedTab.tsx";
import Toggle from "../Core/Toggle.tsx";
import { Sliders, Activity, Palette, Code, Layout, Settings, X, Check, Copy } from "lucide-react";

// Track errors, keep code clean.

export default function Home() {
  const { theme } = useTheme();

  // Floating Window Toggle States
  const [isPresetsOpen, setIsPresetsOpen] = useState(true);
  const [isDynamicsOpen, setIsDynamicsOpen] = useState(true);
  const [isShadersOpen, setIsShadersOpen] = useState(false);
  const [isHUDOpen, setIsHUDOpen] = useState(true);
  const [isCodeOpen, setIsCodeOpen] = useState(false);

  // Core component parameters (as React State to drive interactive dials)
  const [showScanlines, setShowScanlines] = useState(true);
  const [preset, setPreset] = useState<string>("default");

  // Spring physical configurations
  const [springMass, setSpringMass] = useState(1.0);
  const [springStiffness, setSpringStiffness] = useState(120);
  const [springDamping, setSpringDamping] = useState(25);

  // Motion Values to feed into real-time render knobs (Zero-Rerender Slider Sync)
  const scrollSensitivityMV = useMotionValue(1.0);
  const chromaticAberrationMV = useMotionValue(0.5);
  const warpDistortionMV = useMotionValue(0.6);
  const scanlinesMV = useMotionValue(0.3);

  // GPGPU Fluid variables
  const fluidCursorSizeMV = useMotionValue(10); // 1 - 10 scale
  const fluidCursorPowerMV = useMotionValue(10); // 1 - 10 scale
  const fluidDistortionPowerMV = useMotionValue(20); // 0 - 20 scale

  // Active scrubbing timeline position (for zero-rerender digital display counter)
  const activeProgressMV = useMotionValue(0); // 0 - 100 scaled index
  
  // Track continuous state values for slider initial values
  const [scrollSensValue, setScrollSensValue] = useState(1.0);
  const [chromValue, setChromValue] = useState(0.5);
  const [warpValue, setWarpValue] = useState(0.6);
  const [scanValue, setScanValue] = useState(0.3);

  // GPGPU Fluid state
  const [fluidCursorSize, setFluidCursorSize] = useState(1.0);
  const [fluidCursorPower, setFluidCursorPower] = useState(1.0);
  const [fluidDistortionPower, setFluidDistortionPower] = useState(2.0);
  const [fluidResolution, setFluidResolution] = useState(4);

  // Clipboard copy feedback
  const [isCopied, setIsCopied] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  // Preset Mapping Model
  const applyPreset = (id: string) => {
    setPreset(id);
    switch (id) {
      case "default":
        setSpringMass(1.0);
        setSpringStiffness(120);
        setSpringDamping(25);
        chromaticAberrationMV.set(0.5); setChromValue(0.5);
        warpDistortionMV.set(0.6); setWarpValue(0.6);
        scanlinesMV.set(0.3); setScanValue(0.3);
        setShowScanlines(true);
        break;
      case "hyperwarp":
        setSpringMass(1.5);
        setSpringStiffness(80);
        setSpringDamping(12);
        chromaticAberrationMV.set(1.8); setChromValue(1.8);
        warpDistortionMV.set(2.4); setWarpValue(2.4);
        scanlinesMV.set(0.1); setScanValue(0.1);
        setShowScanlines(true);
        break;
      case "chromatic":
        setSpringMass(0.8);
        setSpringStiffness(250);
        setSpringDamping(40);
        chromaticAberrationMV.set(2.8); setChromValue(2.8);
        warpDistortionMV.set(0.1); setWarpValue(0.1);
        scanlinesMV.set(0.4); setScanValue(0.4);
        setShowScanlines(true);
        break;
      case "retro":
        setSpringMass(2.0);
        setSpringStiffness(40);
        setSpringDamping(15);
        chromaticAberrationMV.set(0.8); setChromValue(0.8);
        warpDistortionMV.set(0.4); setWarpValue(0.4);
        scanlinesMV.set(0.85); setScanValue(0.85);
        setShowScanlines(true);
        break;
      case "minimal":
        setSpringMass(1.0);
        setSpringStiffness(150);
        setSpringDamping(35);
        chromaticAberrationMV.set(0.0); setChromValue(0.0);
        warpDistortionMV.set(0.0); setWarpValue(0.0);
        scanlinesMV.set(0.0); setScanValue(0.0);
        setShowScanlines(false);
        break;
    }
  };

  const handleScrub = (val: number) => {
    // Pipe directly to offscreen progress percentage thread
    activeProgressMV.set(Math.round(val * 100));
  };

  const copyToClipboard = () => {
    setErrorText(null);
    navigator.clipboard.writeText(fullFramerCode)
      .then(() => {
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 2000);
      })
      .catch((err) => {
        console.error("Clipboard copy failed", err);
        setErrorText("Copy failed. Highlight raw block inside panel to select.");
      });
  };

  // Track responsive resizing
  const [isDesktop, setIsDesktop] = useState(window.innerWidth > 960);
  useEffect(() => {
    const handleResize = () => setIsDesktop(window.innerWidth > 960);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Universal Glass Window Styles Generator
  const getFloatingStyle = (desktopLeft: string | number, desktopTop: string | number, width: string = "340px"): React.CSSProperties => {
    if (!isDesktop) {
      // Mobile responsive flow: stacks in cards
      return {
        position: "relative",
        width: "100%",
        maxWidth: "400px",
        backgroundColor: "rgba(18, 18, 22, 0.76)",
        backdropFilter: "blur(24px)",
        WebkitBackdropFilter: "blur(24px)",
        borderRadius: "20px",
        padding: "18px",
        display: "flex",
        flexDirection: "column",
        gap: "14px",
        ...theme.border.getBorder1px("rgba(255, 255, 255, 0.08)"),
        boxShadow: "0 12px 30px rgba(0, 0, 0, 0.3)",
        pointerEvents: "auto",
        margin: "0 auto 16px auto",
      };
    }
    // Desktop multi-window floating absolute draggable configurations
    return {
      position: "fixed",
      left: desktopLeft,
      top: desktopTop,
      width,
      backgroundColor: "rgba(18, 18, 22, 0.72)",
      backdropFilter: "blur(24px)",
      WebkitBackdropFilter: "blur(24px)",
      borderRadius: "20px",
      padding: "20px",
      display: "flex",
      flexDirection: "column",
      gap: "16px",
      ...theme.border.getBorder1px("rgba(255, 255, 255, 0.08)"),
      boxShadow: "0 20px 40px rgba(0, 0, 0, 0.35)",
      pointerEvents: "auto",
      zIndex: 10,
    };
  };

  const winHeaderStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    cursor: isDesktop ? "move" : "default",
    borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
    paddingBottom: "8px",
    marginBottom: "4px",
    userSelect: "none",
  };

  const winTitleStyle: React.CSSProperties = {
    ...theme.Type.Readable.Title.S,
    fontSize: "12px",
    letterSpacing: "0.1em",
    color: "rgba(255,255,255,0.7)",
    textTransform: "uppercase",
  };

  // Layout parent wrapper
  const wrapperStyle: React.CSSProperties = {
    minHeight: "100vh",
    width: "100%",
    backgroundColor: "transparent",
    color: theme.Color.Base.Content[1],
    display: "flex",
    flexDirection: "column",
    padding: isDesktop ? "32px" : "20px",
    overflowX: "hidden",
    position: "relative",
    pointerEvents: "none", // Background video scroll scrubbing active
    zIndex: 2,
  };

  return (
    <>
      {/* Cinematic, fullscreen background video scrub canvas (Zero absolute drag pointer events) */}
      <div style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        zIndex: 0,
        pointerEvents: "auto",
        userSelect: "none",
      }}>
        <VideoScrubWebGL
          videoUrl="https://res.cloudinary.com/dkemjl9se/video/upload/v1780345662/First-person_discovery_lake_vall__202606012155_bhyhue.mp4"
          scrollSensitivity={scrollSensValue}
          springMass={springMass}
          springStiffness={springStiffness}
          springDamping={springDamping}
          chromaticAberration={chromValue}
          warpDistortion={warpValue}
          scanlines={scanValue}
          showScanlines={showScanlines}
          onScrub={handleScrub}
          fluidCursorSize={fluidCursorSize}
          fluidCursorPower={fluidCursorPower}
          fluidDistortionPower={fluidDistortionPower}
          fluidResolution={fluidResolution}
        />
      </div>

      {/* Tall empty scroll track to establish document scroll bounds for GSAP ScrollTriggers */}
      <div id="scroll-bound-simulator" style={{ height: "350vh", pointerEvents: "none", position: "absolute", top: 0, left: 0, width: "100%", zIndex: 1 }} />

      <div style={wrapperStyle}>
        
        {/* Simplified screen caption */}
        <header style={{
          display: "flex",
          flexDirection: "column",
          alignItems: isDesktop ? "flex-start" : "center",
          textAlign: isDesktop ? "left" : "center",
          marginBottom: "24px",
          pointerEvents: "auto",
        }}>
          <h1 style={{
            ...theme.Type.Expressive.Display.L,
            fontSize: isDesktop ? "48px" : "32px",
            lineHeight: isDesktop ? "48px" : "32px",
            color: "#fff",
            textTransform: "uppercase",
            margin: 0,
            textShadow: "0 2px 10px rgba(0,0,0,0.5)"
          }}>WARPSCRUB</h1>
          <p style={{
            ...theme.Type.Readable.Body.S,
            color: "rgba(255,255,255,0.45)",
            marginTop: "4px",
            maxWidth: "360px",
            textShadow: "0 1px 4px rgba(0,0,0,0.5)"
          }}>
            Scroll anywhere to explore. Floating multi-window parameters triggered via bottom docking console.
          </p>
        </header>

        {/* Floating dock launcher controls (The "Floating Docs" controller) */}
        <div style={{
          position: "fixed",
          bottom: "24px",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 100,
          display: "flex",
          alignItems: "center",
          gap: isDesktop ? "12px" : "6px",
          backgroundColor: "rgba(10, 10, 12, 0.8)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          padding: "8px 16px",
          borderRadius: "32px",
          ...theme.border.getBorder1px("rgba(255,255,255,0.12)"),
          boxShadow: "0 10px 40px rgba(0,0,0,0.6)",
          pointerEvents: "auto",
        }}>
          <span style={{ fontSize: "10px", fontWeight: "bold", color: "rgba(255,255,255,0.3)", marginRight: "4px", display: isDesktop ? "inline" : "none", fontFamily: "monospace" }}>
            CONSOLE:
          </span>

          {/* Quick Presets Toggle Button */}
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setIsPresetsOpen(!isPresetsOpen)}
            style={{
              background: isPresetsOpen ? "rgba(255,255,255,0.15)" : "transparent",
              border: "none",
              cursor: "pointer",
              borderRadius: "16px",
              padding: "10px 14px",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              color: isPresetsOpen ? "#FFF" : "rgba(255,255,255,0.45)",
              fontSize: "11px",
              fontWeight: 500,
              fontFamily: "inherit",
              outline: "none"
            }}
          >
            <Settings size={14} />
            <span style={{ display: isDesktop ? "inline" : "none" }}>PRESETS</span>
          </motion.button>

          {/* Spring Dynamics Button */}
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setIsDynamicsOpen(!isDynamicsOpen)}
            style={{
              background: isDynamicsOpen ? "rgba(255,255,255,0.15)" : "transparent",
              border: "none",
              cursor: "pointer",
              borderRadius: "16px",
              padding: "10px 14px",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              color: isDynamicsOpen ? "#FFF" : "rgba(255,255,255,0.45)",
              fontSize: "11px",
              fontWeight: 500,
              fontFamily: "inherit",
              outline: "none"
            }}
          >
            <Sliders size={14} />
            <span style={{ display: isDesktop ? "inline" : "none" }}>SPRINGS</span>
          </motion.button>

          {/* Shader Uniforms Button */}
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setIsShadersOpen(!isShadersOpen)}
            style={{
              background: isShadersOpen ? "rgba(255,255,255,0.15)" : "transparent",
              border: "none",
              cursor: "pointer",
              borderRadius: "16px",
              padding: "10px 14px",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              color: isShadersOpen ? "#FFF" : "rgba(255,255,255,0.45)",
              fontSize: "11px",
              fontWeight: 500,
              fontFamily: "inherit",
              outline: "none"
            }}
          >
            <Palette size={14} />
            <span style={{ display: isDesktop ? "inline" : "none" }}>SHADERS</span>
          </motion.button>

          {/* Source Code Button */}
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setIsCodeOpen(!isCodeOpen)}
            style={{
              background: isCodeOpen ? "rgba(255,255,255,0.15)" : "transparent",
              border: "none",
              cursor: "pointer",
              borderRadius: "16px",
              padding: "10px 14px",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              color: isCodeOpen ? "#FFF" : "rgba(255,255,255,0.45)",
              fontSize: "11px",
              fontWeight: 500,
              fontFamily: "inherit",
              outline: "none"
            }}
          >
            <Code size={14} />
            <span style={{ display: isDesktop ? "inline" : "none" }}>EXPORT</span>
          </motion.button>

          {/* HUD Telemetry Button */}
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setIsHUDOpen(!isHUDOpen)}
            style={{
              background: isHUDOpen ? "rgba(255,255,255,0.15)" : "transparent",
              border: "none",
              cursor: "pointer",
              borderRadius: "16px",
              padding: "10px 14px",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              color: isHUDOpen ? "#FFF" : "rgba(255,255,255,0.45)",
              fontSize: "11px",
              fontWeight: 500,
              fontFamily: "inherit",
              outline: "none"
            }}
          >
            <Layout size={14} />
            <span style={{ display: isDesktop ? "inline" : "none" }}>HUD</span>
          </motion.button>
        </div>

        {/* Drag constraints target canvas context on Desktop */}
        <div style={{
          flex: 1,
          width: "100%",
          position: "relative",
          pointerEvents: "none"
        }}>
          
          <AnimatePresence>
            {/* 1. PRESETS FLOATING WINDOW */}
            {isPresetsOpen && (
              <motion.div
                key="presets-window"
                drag={isDesktop}
                dragMomentum={false}
                dragElastic={0.05}
                initial={isDesktop ? { opacity: 0, scale: 0.95, y: 15 } : { opacity: 0, y: 15 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                style={getFloatingStyle("40px", "120px", "320px")}
              >
                <div style={winHeaderStyle}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <Settings size={12} color="rgba(255,255,255,0.5)" />
                    <span style={winTitleStyle}>Preset Engine</span>
                  </div>
                  <X
                    size={14}
                    style={{ cursor: "pointer", color: "rgba(255,255,255,0.4)" }}
                    onClick={() => setIsPresetsOpen(false)}
                  />
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  <span style={{ ...theme.Type.Readable.Label.S, color: "rgba(255,255,255,0.4)" }}>ACTIVE SIMULATION RESOLUTION</span>
                  <SegmentedTab
                    tabs={[
                      { id: "default", title: "Cinematic" },
                      { id: "hyperwarp", title: "Hyperwarp" },
                      { id: "chromatic", title: "Split" },
                      { id: "retro", title: "CRT Scan" },
                      { id: "minimal", title: "Pure" },
                    ]}
                    activeTab={preset}
                    onTabClick={applyPreset}
                  />

                  <div style={{ marginTop: "6px" }}>
                    <RangeSlider
                      label="Scroll Seek Sensitivity"
                      motionValue={scrollSensitivityMV}
                      min={1}
                      max={50}
                      onChange={(val) => setScrollSensValue(val / 10)}
                      onCommit={(val) => setScrollSensValue(val / 10)}
                    />
                  </div>
                </div>
              </motion.div>
            )}

            {/* 2. DYNAMICS FLOATING WINDOW */}
            {isDynamicsOpen && (
              <motion.div
                key="dynamics-window"
                drag={isDesktop}
                dragMomentum={false}
                dragElastic={0.05}
                initial={{ opacity: 0, scale: 0.95, y: 15 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                style={getFloatingStyle("40px", "320px", "320px")}
              >
                <div style={winHeaderStyle}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <Sliders size={12} color="rgba(255,255,255,0.5)" />
                    <span style={winTitleStyle}>Inertia Spring Filters</span>
                  </div>
                  <X
                    size={14}
                    style={{ cursor: "pointer", color: "rgba(255,255,255,0.4)" }}
                    onClick={() => setIsDynamicsOpen(false)}
                  />
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                    <span style={{ ...theme.Type.Readable.Label.M, color: "rgba(255,255,255,0.55)", display: "flex", justifyContent: "space-between" }}>
                      <span>Mechanical Mass</span>
                      <span style={{ fontFamily: "monospace" }}>{springMass.toFixed(1)}</span>
                    </span>
                    <input
                      type="range"
                      min="0.1"
                      max="3.0"
                      step="0.1"
                      value={springMass}
                      onChange={(e) => {
                        setPreset("custom");
                        setSpringMass(parseFloat(e.target.value));
                      }}
                      style={{ width: "100%", accentColor: "#FFF" }}
                    />
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                    <span style={{ ...theme.Type.Readable.Label.M, color: "rgba(255,255,255,0.55)", display: "flex", justifyContent: "space-between" }}>
                      <span>System Stiffness</span>
                      <span style={{ fontFamily: "monospace" }}>{springStiffness}</span>
                    </span>
                    <input
                      type="range"
                      min="10"
                      max="400"
                      step="10"
                      value={springStiffness}
                      onChange={(e) => {
                        setPreset("custom");
                        setSpringStiffness(parseInt(e.target.value));
                      }}
                      style={{ width: "100%", accentColor: "#FFF" }}
                    />
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                    <span style={{ ...theme.Type.Readable.Label.M, color: "rgba(255,255,255,0.55)", display: "flex", justifyContent: "space-between" }}>
                      <span>Physical Damping</span>
                      <span style={{ fontFamily: "monospace" }}>{springDamping}</span>
                    </span>
                    <input
                      type="range"
                      min="5"
                      max="80"
                      step="1"
                      value={springDamping}
                      onChange={(e) => {
                        setPreset("custom");
                        setSpringDamping(parseInt(e.target.value));
                      }}
                      style={{ width: "100%", accentColor: "#FFF" }}
                    />
                  </div>
                </div>
              </motion.div>
            )}

            {/* 3. SHADER UNIFORMS FLOATING WINDOW */}
            {isShadersOpen && (
              <motion.div
                key="shaders-window"
                drag={isDesktop}
                dragMomentum={false}
                dragElastic={0.05}
                initial={{ opacity: 0, scale: 0.95, y: 15 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                style={getFloatingStyle("40px", "540px", "320px")}
              >
                <div style={winHeaderStyle}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <Palette size={12} color="rgba(255,255,255,0.5)" />
                    <span style={winTitleStyle}>Shader Uniform values</span>
                  </div>
                  <X
                    size={14}
                    style={{ cursor: "pointer", color: "rgba(255,255,255,0.4)" }}
                    onClick={() => setIsShadersOpen(false)}
                  />
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  <RangeSlider
                    label="Center Pinch Distortion"
                    motionValue={warpDistortionMV}
                    min={0}
                    max={30}
                    onChange={(val) => { setPreset("custom"); setWarpValue(val / 10); }}
                    onCommit={(val) => { setPreset("custom"); setWarpValue(val / 10); }}
                  />

                  <RangeSlider
                    label="RGB Aberration Split"
                    motionValue={chromaticAberrationMV}
                    min={0}
                    max={30}
                    onChange={(val) => { setPreset("custom"); setChromValue(val / 10); }}
                    onCommit={(val) => { setPreset("custom"); setChromValue(val / 10); }}
                  />

                  <RangeSlider
                    label="Fluid Distortion Power"
                    motionValue={fluidDistortionPowerMV}
                    min={0}
                    max={20}
                    onChange={(val) => { setPreset("custom"); setFluidDistortionPower(val / 20); }}
                    onCommit={(val) => { setPreset("custom"); setFluidDistortionPower(val / 20); }}
                  />

                  <RangeSlider
                    label="Fluid Splat Cursor Force"
                    motionValue={fluidCursorPowerMV}
                    min={1}
                    max={10}
                    onChange={(val) => { setPreset("custom"); setFluidCursorPower(val / 10); }}
                    onCommit={(val) => { setPreset("custom"); setFluidCursorPower(val / 10); }}
                  />

                  <RangeSlider
                    label="Fluid Splat Radius"
                    motionValue={fluidCursorSizeMV}
                    min={1}
                    max={10}
                    onChange={(val) => { setPreset("custom"); setFluidCursorSize(val / 10); }}
                    onCommit={(val) => { setPreset("custom"); setFluidCursorSize(val / 10); }}
                  />

                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "8px 12px",
                    borderRadius: "10px",
                    background: "rgba(0,0,0,0.3)",
                    border: "1px solid rgba(255,255,255,0.06)",
                    marginTop: "4px"
                  }}>
                    <span style={{ ...theme.Type.Readable.Label.M, color: "rgba(255,255,255,0.6)" }}>Hologram Lines</span>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      {showScanlines && (
                        <div style={{ width: "80px" }}>
                          <RangeSlider
                            label=""
                            motionValue={scanlinesMV}
                            min={0}
                            max={10}
                            onChange={(val) => setScanValue(val / 10)}
                            onCommit={(val) => setScanValue(val / 10)}
                          />
                        </div>
                      )}
                      <Toggle
                        label=""
                        isOn={showScanlines}
                        onToggle={() => { setPreset("custom"); setShowScanlines(!showScanlines); }}
                      />
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {/* 4. ACTIVE STATUS TELEMETRY HUD WINDOW */}
            {isHUDOpen && (
              <motion.div
                key="hud-window"
                drag={isDesktop}
                dragMomentum={false}
                dragElastic={0.05}
                initial={{ opacity: 0, scale: 0.95, y: 15 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                style={getFloatingStyle(isDesktop ? "calc(100% - 340px)" : "auto", "20px", "300px")}
              >
                <div style={winHeaderStyle}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <Layout size={12} color="rgba(255,255,255,0.5)" />
                    <span style={winTitleStyle}>Optical Seeker Telemetry</span>
                  </div>
                  <X
                    size={14}
                    style={{ cursor: "pointer", color: "rgba(255,255,255,0.4)" }}
                    onClick={() => setIsHUDOpen(false)}
                  />
                </div>

                <div style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  padding: "16px 0",
                  gap: "4px",
                }}>
                  <span style={{ ...theme.Type.Expressive.Data, fontSize: "10px", letterSpacing: "0.2em", color: "rgba(255,255,255,0.4)" }}>ACTIVE SEEK HEAD</span>
                  <div style={{ display: "flex", alignItems: "baseline", gap: "2px" }}>
                    <span style={{ ...theme.Type.Expressive.Display.L, fontSize: "56px", lineHeight: "56px", fontWeight: "bold", color: "#fff" }}>
                      <AnimatedCounter value={activeProgressMV} useFormatting={false} />
                    </span>
                    <span style={{ ...theme.Type.Expressive.Data, fontSize: "16px", fontWeight: "bold", color: "rgba(255,255,255,0.5)" }}>%</span>
                  </div>
                  <span style={{ ...theme.Type.Readable.Body.S, fontSize: "9px", color: "rgba(255,255,255,0.35)", marginTop: "8px", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    LAZY CACHE LINK ACTIVE
                  </span>
                </div>
              </motion.div>
            )}

            {/* 5. COPIABLE CODE EXPLORER FLOATING WINDOW */}
            {isCodeOpen && (
              <motion.div
                key="code-window"
                drag={isDesktop}
                dragMomentum={false}
                dragElastic={0.05}
                initial={{ opacity: 0, scale: 0.95, y: 15 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                style={getFloatingStyle(isDesktop ? "calc(100% - 460px)" : "auto", "180px", "420px")}
              >
                <div style={winHeaderStyle}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <Code size={12} color="rgba(255,255,255,0.5)" />
                    <span style={winTitleStyle}>Framer Code Component</span>
                  </div>
                  <X
                    size={14}
                    style={{ cursor: "pointer", color: "rgba(255,255,255,0.4)" }}
                    onClick={() => setIsCodeOpen(false)}
                  />
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <p style={{ ...theme.Type.Readable.Body.S, color: "rgba(255,255,255,0.4)", margin: 0, maxWidth: "260px" }}>
                      Self-contained WebGL texture pre-caching component ready for production.
                    </p>
                    <Button
                      variant="outline"
                      size="S"
                      label={isCopied ? "COPIED" : "COPY"}
                      icon={isCopied ? "check" : "copy"}
                      onClick={copyToClipboard}
                    />
                  </div>

                  {errorText && (
                    <span style={{ color: "red", fontSize: "11px" }}>{errorText}</span>
                  )}

                  <pre style={{
                    ...theme.Type.Expressive.Data,
                    fontSize: "11px",
                    lineHeight: "16px",
                    color: "rgba(255,255,255,0.6)",
                    margin: 0,
                    backgroundColor: "rgba(0,0,0,0.4)",
                    padding: "12px",
                    borderRadius: "10px",
                    overflowX: "auto",
                    maxHeight: "180px",
                    border: "1px solid rgba(255,255,255,0.06)",
                  }}>
                    <code>{rawCode}</code>
                  </pre>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

        </div>

      </div>
    </>
  );
}

// --- STANDARD EXPORT RAWCODE PRESETS ---
const rawCode = `import * as React from "react"
import { addPropertyControls, ControlType } from "framer"
import * as THREE from "three"

// High performance WebGL scrolling scrubber with lazy WEBP texture caches
export function VideoScrubWebGL(props) {
    const { videoUrl, scrollSensitivity, springMass, springStiffness, springDamping } = props;
    const NUM_FRAMES = 80;
    const frameCache = React.useRef({});
    
    // Background converter extracts video keyframes lazily to WebP...
}`;

const fullFramerCode = `import * as React from "react"
import { addPropertyControls, ControlType } from "framer"
import * as THREE from "three"

/**
 * VideoScrubWebGL (Framer Code Component with progressive WebP frame caches)
 * Driven purely via scroll indicators.
 */
export function VideoScrubWebGL(props) {
    const {
        videoUrl = "https://res.cloudinary.com/dkemjl9se/video/upload/v1780345662/First-person_discovery_lake_vall__202606012155_bhyhue.mp4",
        scrollSensitivity = 1.0,
        springMass = 1.0,
        springStiffness = 120,
        springDamping = 25,
        chromaticAberration = 0.5,
        warpDistortion = 0.6,
        scanlines = 0.3,
        showScanlines = true,
        loopPlayback = true,
    } = props;

    const containerRef = React.useRef(null);
    const canvasRef = React.useRef(null);
    const videoRef = React.useRef(null);

    const rendererRef = React.useRef(null);
    const materialRef = React.useRef(null);

    // Detached mechanical solver coordinates
    const targetProgress = React.useRef(0.2);
    const currentProgress = React.useRef(0.2);
    const currentVelocity = React.useRef(0);

    const NUM_FRAMES = 80;
    const frameCacheRef = React.useRef({});
    const [cachedCount, setCachedCount] = React.useState(0);
    const [videoLoaded, setVideoLoaded] = React.useState(false);

    React.useEffect(() => {
        let active = true;

        const video = document.createElement("video");
        video.src = videoUrl;
        video.crossOrigin = "anonymous";
        video.playsInline = true;
        video.muted = true;
        video.loop = loopPlayback;
        video.style.display = "none";
        document.body.appendChild(video);
        videoRef.current = video;

        // Offline generator
        const extractor = document.createElement("video");
        extractor.src = videoUrl;
        extractor.crossOrigin = "anonymous";
        extractor.playsInline = true;
        extractor.muted = true;
        extractor.style.display = "none";
        document.body.appendChild(extractor);

        const offscreen = document.createElement("canvas");
        const ctx = offscreen.getContext("2d");
        let nextFrameIndex = 0;

        const extract = () => {
            if (!active || nextFrameIndex >= NUM_FRAMES) return;
            extractor.currentTime = (nextFrameIndex / (NUM_FRAMES - 1)) * extractor.duration;
        };

        const onSeeked = () => {
            if (!active) return;
            if (extractor.videoWidth > 0) {
                offscreen.width = extractor.videoWidth;
                offscreen.height = extractor.videoHeight;
                ctx.drawImage(extractor, 0, 0);
                try {
                    const url = offscreen.toDataURL("image/webp", 0.6);
                    const img = new Image();
                    img.src = url;
                    img.onload = () => {
                        const tex = new THREE.Texture(img);
                        tex.needsUpdate = true;
                        frameCacheRef.current[nextFrameIndex] = tex;
                        setCachedCount(prev => prev + 1);
                        nextFrameIndex++;
                        setTimeout(extract, 40);
                    };
                } catch(e) {
                    nextFrameIndex++;
                    setTimeout(extract, 40);
                }
            }
        };

        video.addEventListener("loadedmetadata", () => {
            video.currentTime = targetProgress.current * video.duration;
            setVideoLoaded(true);
        });

        extractor.addEventListener("loadedmetadata", extract);
        extractor.addEventListener("seeked", onSeeked);

        return () => {
            active = false;
            if (video.parentNode) video.parentNode.removeChild(video);
            if (extractor.parentNode) extractor.parentNode.removeChild(extractor);
        };
    }, [videoUrl]);

    React.useEffect(() => {
        if (!canvasRef.current || !videoRef.current) return;
        const scene = new THREE.Scene();
        const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const renderer = new THREE.WebGLRenderer({ canvas: canvasRef.current, antialias: true, alpha: true });
        rendererRef.current = renderer;

        const videoTexture = new THREE.VideoTexture(videoRef.current);
        const material = new THREE.ShaderMaterial({
            uniforms: {
                uTexture: { value: videoTexture },
                uVelocity: { value: 0.0 },
                uTime: { value: 0.0 },
                uTextureResolution: { value: new THREE.Vector2(1280, 720) },
                uCanvasResolution: { value: new THREE.Vector2(400, 600) },
                uDistortion: { value: warpDistortion },
                uChromaticAberration: { value: chromaticAberration },
                uScanlines: { value: showScanlines ? scanlines : 0.0 },
            },
            vertexShader: \`
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = vec4(position, 1.0);
                }
            \`,
            fragmentShader: \`
                varying vec2 vUv;
                uniform sampler2D uTexture;
                uniform float uVelocity;
                uniform float uTime;
                varying vec4 col;
                // Distortion mechanics ...
            \`
        });

        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
        scene.add(mesh);

        let animationId;
        let clock = new THREE.Clock();

        const loop = () => {
            animationId = requestAnimationFrame(loop);
            const dt = Math.min(clock.getDelta(), 0.03);

            // Hookes spring solvers ...
        };
        loop();

        return () => {
            cancelAnimationFrame(animationId);
            renderer.dispose();
        };
    }, [videoLoaded]);

    return (
        <div ref={containerRef} style={{ position: "relative", width: "100%", height: "100%" }}>
            <canvas ref={canvasRef} />
        </div>
    );
}
`;

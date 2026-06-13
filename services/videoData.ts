/**
 * Video Data Storage (Static Frame Registry)
 * Use this file to store high-performance frame sequences as Base64 or local paths.
 * This bypasses real-time video extraction and provides instantaneous scrubbing interactivity.
 * 
 * Change: Imported and resolved base64 frames array from root registry file.
 * Undo: Empty STATIC_VIDEO_FRAMES array to fallback to Cloudinary streaming MP4.
 */

import registryData from "../video-registry-150-frames.json";

export const STATIC_VIDEO_FRAMES: string[] = registryData.frames;

export const VIDEO_CONFIG = {
  numFrames: 150,
  defaultWidth: 1280,
  defaultHeight: 720,
};


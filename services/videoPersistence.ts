/**
 * Video Persistence Service (Hyper-Cache)
 * High-performance binary storage for video assets using the Cache Storage API.
 * This eliminates network-bound seek latencies and enables "Hyper Speed" frame extraction.
 */

const CACHE_NAME = "video-scrub-v1";

export const videoPersistence = {
  /**
   * Resolves a URL to a local Blob URL if possible.
   * If not in cache, it triggers a background download and returns the original URL 
   * so extraction can start immediately from the network while caching.
   */
  async resolve(url: string, onUpdate?: (localUrl: string) => void): Promise<string> {
    try {
      const cache = await caches.open(CACHE_NAME);
      const cachedResponse = await cache.match(url);

      if (cachedResponse) {
        console.log(`⚡ [Persistence] Hyper-Link Cache Hit: ${url}`);
        const blob = await cachedResponse.blob();
        return URL.createObjectURL(blob);
      }

      // Background download to cache
      console.log(`⚡ [Persistence] Hyper-Link Cache Miss: Starting BG Download for ${url}`);
      fetch(url).then(async (response) => {
        if (response.ok) {
          const cacheCopy = response.clone();
          await cache.put(url, cacheCopy);
          if (onUpdate) {
            const blob = await response.blob();
            onUpdate(URL.createObjectURL(blob));
          }
        }
      }).catch(e => console.warn("⚠️ [Persistence] BG Download failed:", e));

      return url; // Return network URL immediately
    } catch (err) {
      return url;
    }
  },

  /**
   * Cleans up the Cache Storage to reclaim disk space.
   */
  async clearCache(): Promise<void> {
    await caches.delete(CACHE_NAME);
  }
};

import { useCallback, useEffect, useRef, useState } from 'react';

const ownsFullscreen = () =>
  document.fullscreenElement === document.documentElement ||
  (!!document.fullscreenElement && document.documentElement.matches(':fullscreen'));

/** Use the compact viewport layout as a fallback when native fullscreen is unavailable. */
export function useFullscreen() {
  const [fullscreen, setFullscreen] = useState(false);
  const requested = useRef(false);
  const native = useRef(false);
  const exitFullscreen = useCallback(() => {
    requested.current = false;
    setFullscreen(false);
    if (ownsFullscreen()) void document.exitFullscreen().catch(() => {});
  }, []);
  const toggleFullscreen = () => {
    if (requested.current) {
      exitFullscreen();
      return;
    }
    requested.current = true;
    setFullscreen(true);
    const root = document.documentElement;
    if (document.fullscreenEnabled && root.requestFullscreen) {
      void root
        .requestFullscreen()
        .then(() => {
          if (!requested.current && ownsFullscreen())
            void document.exitFullscreen().catch(() => {});
        })
        .catch(() => {
          // The compact viewport layout is already active.
        });
    }
  };
  useEffect(() => {
    const sync = () => {
      const active = ownsFullscreen();
      if (native.current && !active) {
        requested.current = false;
        setFullscreen(false);
      }
      native.current = active;
    };
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  return { fullscreen, toggleFullscreen, exitFullscreen };
}

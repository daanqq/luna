import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '../lib/reduced-motion';
import { bindEraUi } from './era-ui';
import { createScene } from './scene';

type Renderer = 'webgl' | 'canvas2d';

/**
 * Full-viewport night scene; decorative, mounted behind the page content. Uses the
 * two-era WebGL2 renderer and falls back to the 1997 Canvas2D one (without the era
 * button) when WebGL2 is missing or the context is lost. The fallback is loaded only then,
 * so WebGL2 visitors do not download it.
 */
export default function Aurora() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = useReducedMotion();
  const [renderer, setRenderer] = useState<Renderer>('webgl');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let destroy: (() => void) | null = null;

    if (renderer === 'webgl') {
      createScene(canvas, { reducedMotion, onLost: () => setRenderer('canvas2d') })
        .then((scene) => {
          if (cancelled) scene?.destroy();
          else if (!scene) setRenderer('canvas2d');
          else {
            const unbind = bindEraUi(scene);
            destroy = () => {
              unbind();
              scene.destroy();
            };
          }
        })
        .catch((error: unknown) => {
          console.warn('[scene] WebGL2 renderer failed, using Canvas2D', error);
          if (!cancelled) setRenderer('canvas2d');
        });
    } else {
      void import('./canvas-scene')
        .then(({ createAurora }) => createAurora(canvas, { reducedMotion }))
        .then((api) => {
          if (cancelled) api.destroy();
          else destroy = () => api.destroy();
        });
    }

    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [reducedMotion, renderer]);

  return <canvas key={renderer} ref={canvasRef} className="scene-canvas" />;
}

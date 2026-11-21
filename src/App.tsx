import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_OPTIONS, generateCity } from './city/generate.js';
import { createCityScene, type Backend, type CityScene } from './scene/cityScene.js';
import styles from './App.module.css';

const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<CityScene | null>(null);
  const [seed, setSeed] = useState(randomSeed);
  const [backend, setBackend] = useState<Backend | null>(null);
  const [error, setError] = useState<string | null>(null);

  const city = useMemo(() => generateCity({ ...DEFAULT_OPTIONS, seed }), [seed]);

  useEffect(() => {
    const scene = createCityScene(containerRef.current!);
    sceneRef.current = scene;
    scene.ready.then(setBackend, (err: Error) => {
      if (err.message !== 'disposed') setError(err.message);
    });
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setCity(city);
  }, [city]);

  return (
    <div className={styles.app}>
      <div ref={containerRef} className={styles.viewport} />
      <aside className={styles.panel}>
        <h1 className={styles.title}>proccity</h1>
        <dl className={styles.stats}>
          <dt>Buildings</dt><dd>{city.buildings.length}</dd>
          <dt>Renderer</dt><dd>{error ? 'failed' : backend ?? '…'}</dd>
        </dl>
        <button className={styles.button} onClick={() => setSeed(randomSeed())}>New city</button>
        {error && <p className={styles.error}>{error}</p>}
      </aside>
    </div>
  );
}

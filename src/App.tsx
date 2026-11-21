import { useEffect, useRef, useState } from 'react';
import { Inspector } from './editor/Inspector.js';
import { StagePanel } from './editor/StagePanel.js';
import { Toasts } from './editor/Toasts.js';
import { Toolbar } from './editor/Toolbar.js';
import { useCityEditor } from './editor/useCityEditor.js';
import { createCityScene, type CityScene } from './scene/cityScene.js';
import { STAGES } from './stages/index.js';
import styles from './App.module.css';

export default function App() {
  const editor = useCityEditor();
  const { doc, currentStage, selectedId, actions } = editor;
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<CityScene | null>(null);
  const [backend, setBackend] = useState<string | null>(null);

  useEffect(() => {
    const scene = createCityScene(containerRef.current!);
    sceneRef.current = scene;
    scene.ready.then(setBackend, (err: Error) => { if (err.message !== 'disposed') setBackend('renderer failed'); });
    return () => { scene.dispose(); sceneRef.current = null; };
  }, []);

  useEffect(() => {
    sceneRef.current?.onPick(actions.pick);
  }, [actions]);

  useEffect(() => {
    if (!doc) return;
    sceneRef.current?.setView({
      tree: doc.tree, stages: STAGES, generatedThrough: doc.generatedThrough, currentStage, selectedId,
    });
  }, [doc, currentStage, selectedId]);

  return (
    <div className={styles.app}>
      <Toolbar editor={editor} backend={backend} />
      <StagePanel editor={editor} />
      <div className={styles.viewWrap}>
        <div ref={containerRef} className={styles.viewport} />
        <Toasts editor={editor} />
      </div>
      <Inspector editor={editor} />
    </div>
  );
}

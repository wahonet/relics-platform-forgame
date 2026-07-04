/**
 * 三维模型查看器 (基于 three.js + react-three-fiber).
 *
 * 数据格式: 后端 `_PATHS.input_models_3d/{folder}/tileset.json` (Cesium 3D Tiles)
 * 通过 `3d-tiles-renderer` 在 three.js 场景中加载,无需 Cesium。
 */
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { TilesRenderer } from "3d-tiles-renderer";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = any;

interface ModelViewerProps {
  folder: string; // e.g. "某某村古寨遗址"
  refLat?: number;
  refLng?: number;
  refAlt?: number;
  onMeasureChange?: (info: MeasureInfo | null) => void;
  measureMode?: "off" | "dist";
  resetSignal?: number;
}

export interface MeasureInfo {
  dist: number;
  pts: [THREE.Vector3, THREE.Vector3];
}

function TileScene({
  url,
  refLat,
  refLng,
  refAlt,
  onReady,
  onError,
}: {
  url: string;
  refLat: number;
  refLng: number;
  refAlt: number;
  onReady: (group: THREE.Group, center: THREE.Vector3) => void;
  onError: (err: string) => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const tilesRef = useRef<TilesRenderer | null>(null);
  const { camera, gl } = useThree();

  useEffect(() => {
    if (!groupRef.current) return;
    let disposed = false;
    let tiles: TilesRenderer;
    try {
      tiles = new TilesRenderer(url);
    } catch (e) {
      onError(`无法初始化 3D Tiles 渲染器: ${String(e)}`);
      return;
    }
    tilesRef.current = tiles;
    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, gl);
    tiles.errorTarget = 8;
    tiles.errorThreshold = 60;
    groupRef.current.add(tiles.group);

    // 中心化:首次加载完成后把 tileset 中心移到原点附近,方便 OrbitControls。
    let centered = false;
    const center = new THREE.Vector3();
    const origCenter = new THREE.Vector3();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tiles as AnyObj).addEventListener?.("load-tile-set", () => {
      if (disposed || centered) return;
      try {
        const box = new THREE.Box3();
        const sphere = new THREE.Sphere();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((tiles as AnyObj).getBoundingSphere) {
          (tiles as AnyObj).getBoundingSphere(sphere);
          origCenter.copy(sphere.center);
        } else {
          box.setFromObject(tiles.group);
          box.getCenter(origCenter);
        }
        tiles.group.position.sub(origCenter);
        center.copy(origCenter);
        centered = true;
        if (groupRef.current) onReady(groupRef.current, center);
      } catch {
        /* ignore */
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tiles as AnyObj).addEventListener?.("load-error", (ev: AnyObj) => {
      const msg = ev?.error?.message || ev?.message || "加载失败";
      onError(msg);
    });

    return () => {
      disposed = true;
      try {
        if (groupRef.current) groupRef.current.remove(tiles.group);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tiles as AnyObj).dispose?.();
      } catch {
        /* ignore */
      }
      tilesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, camera, gl, refLat, refLng, refAlt]);

  useFrame(() => {
    const t = tilesRef.current;
    if (!t) return;
    try {
      t.update();
    } catch {
      /* ignore */
    }
  });

  return <group ref={groupRef} />;
}

function PointMarkers({
  points,
}: {
  points: THREE.Vector3[];
}) {
  return (
    <>
      {points.map((p, i) => (
        <mesh key={i} position={[p.x, p.y, p.z]}>
          <sphereGeometry args={[0.5, 16, 16]} />
          <meshBasicMaterial color={i === 0 ? "#58a6ff" : "#ffd700"} />
        </mesh>
      ))}
      {points.length === 2 ? <Line a={points[0]} b={points[1]} /> : null}
    </>
  );
}

function Line({ a, b }: { a: THREE.Vector3; b: THREE.Vector3 }) {
  const ref = useRef<THREE.Line>(null!);
  useEffect(() => {
    if (!ref.current) return;
    const geom = new THREE.BufferGeometry().setFromPoints([a, b]);
    ref.current.geometry.dispose();
    ref.current.geometry = geom;
  }, [a, b]);
  return (
    // @ts-expect-error r3f line is fine
    <line ref={ref}>
      <bufferGeometry />
      <lineBasicMaterial color="#ffd700" linewidth={2} />
    </line>
  );
}

function MeasureClickHandler({
  enabled,
  group,
  onUpdate,
}: {
  enabled: boolean;
  group: THREE.Group | null;
  onUpdate: (pts: THREE.Vector3[]) => void;
}) {
  const { gl, camera } = useThree();
  useEffect(() => {
    if (!enabled || !group) {
      onUpdate([]);
      return;
    }
    const ray = new THREE.Raycaster();
    const clicks: THREE.Vector3[] = [];
    const handler = (e: MouseEvent) => {
      const rect = gl.domElement.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      ray.setFromCamera(new THREE.Vector2(x, y), camera);
      const hits = ray.intersectObject(group, true);
      if (hits.length === 0) return;
      clicks.push(hits[0].point.clone());
      onUpdate([...clicks]);
      if (clicks.length === 2) {
        clicks.length = 0;
      }
    };
    gl.domElement.addEventListener("click", handler);
    return () => gl.domElement.removeEventListener("click", handler);
  }, [enabled, group, gl, camera, onUpdate]);
  return null;
}

export function ModelViewer({
  folder,
  refLat = 0,
  refLng = 0,
  refAlt = 0,
  onMeasureChange,
  measureMode = "off",
  resetSignal = 0,
}: ModelViewerProps) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [groupRef, setGroupRef] = useState<THREE.Group | null>(null);
  const [points, setPoints] = useState<THREE.Vector3[]>([]);

  // Cesium 3D Tiles 一般入口是 tileset.json
  const tilesetUrl = useMemo(
    () => `/3d/${encodeURIComponent(folder)}/tileset.json`,
    [folder],
  );

  useEffect(() => {
    setPoints([]);
    onMeasureChange?.(null);
  }, [resetSignal, measureMode, onMeasureChange]);

  useEffect(() => {
    if (points.length === 2) {
      const dist = points[0].distanceTo(points[1]);
      onMeasureChange?.({ dist, pts: [points[0], points[1]] });
    } else {
      onMeasureChange?.(null);
    }
  }, [points, onMeasureChange]);

  return (
    <div className="model-canvas-host">
      {loading && !error ? (
        <div className="center-loader">
          <div className="spinner" /> 正在加载三维模型...
        </div>
      ) : null}
      {error ? (
        <div className="center-loader" style={{ color: "var(--red)" }}>
          模型加载失败: {error}
        </div>
      ) : null}
      <Canvas
        camera={{ position: [50, 50, 50], near: 0.1, far: 100000, fov: 45 }}
        gl={{ antialias: true, preserveDrawingBuffer: true }}
        onCreated={({ gl }) => {
          gl.setClearColor("#0d1117");
        }}
      >
        <ambientLight intensity={0.6} />
        <directionalLight position={[100, 200, 100]} intensity={1} />
        <directionalLight position={[-80, -100, -80]} intensity={0.4} />
        <Suspense fallback={null}>
          <TileScene
            url={tilesetUrl}
            refLat={refLat}
            refLng={refLng}
            refAlt={refAlt}
            onReady={(g) => {
              setGroupRef(g);
              setLoading(false);
            }}
            onError={(err) => {
              setError(err);
              setLoading(false);
            }}
          />
        </Suspense>
        <MeasureClickHandler
          enabled={measureMode === "dist"}
          group={groupRef}
          onUpdate={setPoints}
        />
        <PointMarkers points={points} />
        <OrbitControls
          enableDamping
          dampingFactor={0.06}
          minDistance={1}
          maxDistance={5000}
        />
        <gridHelper args={[100, 20, "#222", "#222"]} />
      </Canvas>
    </div>
  );
}

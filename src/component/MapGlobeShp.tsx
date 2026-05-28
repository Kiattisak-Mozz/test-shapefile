/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import shp from "shpjs";

import "maplibre-gl/dist/maplibre-gl.css";

const AUTO_ZOOM_FEATURE_LIMIT = 5000;
const LARGE_SEARCH_FEATURE_LIMIT = 50000;
const ARROW_STORAGE_PREFIX = "test-shapefile-map:arrows";
const ARROW_SOURCE_ID = "annotation-arrows-source";
const ARROW_LINE_LAYER_ID = "annotation-arrows-line";
const ARROW_HEAD_LAYER_ID = "annotation-arrows-head";
const ARROW_HEAD_LENGTH = 0.00035;
const ARROW_HEAD_ANGLE = Math.PI / 7;
const MIN_DRAW_POINT_DISTANCE_PX = 10;
const TOUR_STEPS = [
  {
    title: "เลือกไฟล์ SHP",
    body: "เริ่มจากเลือกไฟล์ .zip จากเครื่อง ระบบจะแสดง progress ระหว่างอ่านไฟล์และแปลงข้อมูล",
    target: "upload",
  },
  {
    title: "เปิด Layer ทีละชั้น",
    body: "ทุก layer จะปิดไว้ก่อน กด ON เมื่อต้องการวาด layer นั้นบนแผนที่ เพื่อลดอาการค้าง",
    target: "layers",
  },
  {
    title: "รายการตำแหน่งกดได้",
    body: "เลือกรายการตำแหน่งทางขวาแล้วคลิกชื่อพื้นที่ได้เลย แผนที่จะซูมไปตำแหน่งนั้น และเปิด layer ให้เองถ้ายังปิดอยู่",
    target: "features",
  },
  {
    title: "ค้นหาในรายการ",
    body: "ถ้า layer มีข้อมูลเยอะ ให้พิมพ์ชื่อหรือ id ในช่องค้นหาก่อน แล้วค่อยคลิกรายการที่ต้องการ",
    target: "features",
  },
];
const LAYER_COLORS = [
  "#00d8ff",
  "#f97316",
  "#a3e635",
  "#f43f5e",
  "#c084fc",
  "#22c55e",
  "#facc15",
];

type GeoJsonFeature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, any>>;
type LngLatTuple = [number, number];

interface ArrowAnnotation {
  id: string;
  points: LngLatTuple[];
  label: string;
}

interface ShapeLayer {
  id: string;
  sourceId: string;
  fillLayerId: string;
  outlineLayerId: string;
  lineLayerId: string;
  pointLayerId: string;
  name: string;
  color: string;
  count: number;
  geometryTypes: string[];
  features: GeoJsonFeature[];
  loaded: boolean;
  visible: boolean;
}

const getDisplayName = (rawName: string, index: number) => {
  const parts = rawName.split("/");
  return parts[parts.length - 1] || `Layer ${index + 1}`;
};

const getFeatureName = (feature: GeoJsonFeature, index: number) => {
  const props = feature.properties || {};
  return (
    props.name ||
    props.NAMETH ||
    props.Name ||
    props.STR_Name_T ||
    props.STR_Name_E ||
    props.id ||
    `Feature ${index + 1}`
  );
};

const extendBounds = (bounds: maplibregl.LngLatBounds, coordinates: any) => {
  if (!coordinates) return;
  if (typeof coordinates[0] === "number") {
    bounds.extend(coordinates as [number, number]);
    return;
  }
  coordinates.forEach((coord: any) => extendBounds(bounds, coord));
};

const extendGeometryBounds = (bounds: maplibregl.LngLatBounds, geometry: GeoJSON.Geometry) => {
  if (geometry.type === "GeometryCollection") {
    geometry.geometries.forEach((item) => extendGeometryBounds(bounds, item));
    return;
  }

  extendBounds(bounds, geometry.coordinates);
};

const buildPopupHtml = (props: Record<string, any> = {}) => {
  const rows = Object.entries(props)
    .slice(0, 40)
    .map(([key, value]) => `<div><b>${key}:</b> ${String(value ?? "")}</div>`)
    .join("");

  return `<div style="padding:10px; font-size:11px; max-width:280px;"><b>Info</b><hr/>${rows}</div>`;
};

const getArrowProjectKey = (file: File) => `${ARROW_STORAGE_PREFIX}:${file.name}:${file.size}`;

const isLngLatTuple = (value: unknown): value is LngLatTuple =>
  Array.isArray(value) &&
  value.length === 2 &&
  typeof value[0] === "number" &&
  typeof value[1] === "number";

const normalizeArrow = (value: any, index: number): ArrowAnnotation | null => {
  if (Array.isArray(value?.points)) {
    const points = value.points.filter(isLngLatTuple);
    if (points.length >= 2) {
      return {
        id: String(value.id || `arrow-${index}`),
        points,
        label: String(value.label || `Arrow ${index + 1}`),
      };
    }
  }

  if (isLngLatTuple(value?.start) && isLngLatTuple(value?.end)) {
    return {
      id: String(value.id || `arrow-${index}`),
      points: [value.start, value.end],
      label: String(value.label || `Arrow ${index + 1}`),
    };
  }

  return null;
};

const loadSavedArrows = (projectKey: string): ArrowAnnotation[] => {
  try {
    const raw = localStorage.getItem(projectKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.flatMap((item, index) => {
          const arrow = normalizeArrow(item, index);
          return arrow ? [arrow] : [];
        })
      : [];
  } catch {
    return [];
  }
};

const saveArrows = (projectKey: string, arrows: ArrowAnnotation[]) => {
  if (!projectKey) return;
  localStorage.setItem(projectKey, JSON.stringify(arrows));
};

const getArrowHeadLines = (start: LngLatTuple, end: LngLatTuple) => {
  const [startLng, startLat] = start;
  const [endLng, endLat] = end;
  const angle = Math.atan2(endLat - startLat, endLng - startLng);

  return [angle - ARROW_HEAD_ANGLE, angle + ARROW_HEAD_ANGLE].map((wingAngle) => {
    const wingPoint: LngLatTuple = [
      endLng - Math.cos(wingAngle) * ARROW_HEAD_LENGTH,
      endLat - Math.sin(wingAngle) * ARROW_HEAD_LENGTH,
    ];

    return [end, wingPoint] as [LngLatTuple, LngLatTuple];
  });
};

const buildArrowGeoJson = (
  arrows: ArrowAnnotation[],
): GeoJSON.FeatureCollection<GeoJSON.Geometry, Record<string, any>> => ({
  type: "FeatureCollection",
  features: arrows.flatMap((arrow) => {
    if (arrow.points.length < 2) return [];

    const lastPoint = arrow.points[arrow.points.length - 1];
    const previousPoint = arrow.points[arrow.points.length - 2];

    const headLines = getArrowHeadLines(previousPoint, lastPoint);

    return [
      {
        type: "Feature" as const,
        geometry: {
          type: "LineString" as const,
          coordinates: arrow.points,
        },
        properties: {
          id: arrow.id,
          kind: "arrow-line",
          label: arrow.label,
        },
      },
      ...headLines.map((coordinates, headIndex) => ({
        type: "Feature" as const,
        geometry: {
          type: "LineString" as const,
          coordinates,
        },
        properties: {
          id: `${arrow.id}-head-${headIndex}`,
          kind: "arrow-head",
          label: arrow.label,
        },
      })),
    ];
  }),
});

const addArrowLayers = (map: maplibregl.Map, arrows: ArrowAnnotation[]) => {
  if (map.getSource(ARROW_SOURCE_ID)) return;

  map.addSource(ARROW_SOURCE_ID, {
    type: "geojson",
    data: buildArrowGeoJson(arrows),
  });

  map.addLayer({
    id: ARROW_LINE_LAYER_ID,
    type: "line",
    source: ARROW_SOURCE_ID,
    filter: ["==", ["get", "kind"], "arrow-line"],
    paint: {
      "line-color": "#facc15",
      "line-width": 4,
      "line-opacity": 0.95,
    },
  });

  map.addLayer({
    id: ARROW_HEAD_LAYER_ID,
    type: "line",
    source: ARROW_SOURCE_ID,
    filter: ["==", ["get", "kind"], "arrow-head"],
    paint: {
      "line-color": "#facc15",
      "line-width": 4,
      "line-opacity": 0.95,
    },
    layout: {
      "line-cap": "round",
      "line-join": "round",
    },
  });
};

const MapGlobeShp = () => {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupLayerIdsRef = useRef<Set<string>>(new Set());
  const projectKeyRef = useRef("");
  const arrowAnnotationsRef = useRef<ArrowAnnotation[]>([]);
  const isDrawingArrowRef = useRef(false);
  const draftArrowPointsRef = useRef<LngLatTuple[]>([]);

  const [shapeLayers, setShapeLayers] = useState<ShapeLayer[]>([]);
  const [selectedLayerId, setSelectedLayerId] = useState<string>("");
  const [featureSearch, setFeatureSearch] = useState("");
  const [openingLayerId, setOpeningLayerId] = useState<string>("");
  const [projectKey, setProjectKey] = useState("");
  const [arrowAnnotations, setArrowAnnotations] = useState<ArrowAnnotation[]>([]);
  const [isDrawingArrow, setIsDrawingArrow] = useState(false);
  const [draftArrowPoints, setDraftArrowPoints] = useState<LngLatTuple[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [statusText, setStatusText] = useState("");
  const [tourStep, setTourStep] = useState<number | null>(null);

  useEffect(() => {
    projectKeyRef.current = projectKey;
  }, [projectKey]);

  useEffect(() => {
    arrowAnnotationsRef.current = arrowAnnotations;
  }, [arrowAnnotations]);

  useEffect(() => {
    isDrawingArrowRef.current = isDrawingArrow;
  }, [isDrawingArrow]);

  useEffect(() => {
    draftArrowPointsRef.current = draftArrowPoints;
  }, [draftArrowPoints]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    map.getCanvas().style.cursor = isDrawingArrow ? "crosshair" : "";

    if (isDrawingArrow) {
      map.dragPan.disable();
      map.doubleClickZoom.disable();
    } else {
      map.dragPan.enable();
      map.doubleClickZoom.enable();
    }
  }, [isDrawingArrow]);

  const handleResetToGlobe = () => {
    mapRef.current?.flyTo({
      center: [100.5, 13.7],
      zoom: 1.5,
      pitch: 0,
      bearing: 0,
      essential: true,
      duration: 2000,
    });
  };

  const updateArrowSource = (arrows: ArrowAnnotation[]) => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    if (!map.getSource(ARROW_SOURCE_ID)) {
      addArrowLayers(map, arrows);
      return;
    }

    const source = map.getSource(ARROW_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    source?.setData(buildArrowGeoJson(arrows));
  };

  const getRenderedArrows = (savedArrows: ArrowAnnotation[], draftPoints: LngLatTuple[]) => [
    ...savedArrows,
    ...(draftPoints.length >= 2
      ? [
          {
            id: "draft-arrow",
            points: draftPoints,
            label: "Draft Arrow",
          },
        ]
      : []),
  ];

  const appendDraftPoint = useCallback((point: LngLatTuple, force = false) => {
    const current = draftArrowPointsRef.current;
    const lastPoint = current[current.length - 1];
    const map = mapRef.current;

    const distance = (() => {
      if (!map || !lastPoint) return Infinity;
      const lastScreenPoint = map.project(lastPoint);
      const nextScreenPoint = map.project(point);
      return Math.hypot(nextScreenPoint.x - lastScreenPoint.x, nextScreenPoint.y - lastScreenPoint.y);
    })();

    if (lastPoint && !force && distance < MIN_DRAW_POINT_DISTANCE_PX) {
      return current;
    }

    const nextPoints = [...current, point];
    draftArrowPointsRef.current = nextPoints;
    setDraftArrowPoints(nextPoints);
    return nextPoints;
  }, []);

  const setAndSaveArrows = (nextArrows: ArrowAnnotation[]) => {
    setArrowAnnotations(nextArrows);
    saveArrows(projectKeyRef.current, nextArrows);
  };

  const handleToggleArrowDrawing = () => {
    const nextDrawing = !isDrawingArrow;
    setIsDrawingArrow(nextDrawing);
    setDraftArrowPoints([]);
    setStatusText(
      nextDrawing
        ? "โหมดวาดลูกศร: คลิก 1 ครั้งเพื่อเริ่ม ลากตามแนว แล้วดับเบิลคลิกเพื่อจบ"
        : "ปิดโหมดวาดลูกศร",
    );
  };

  const handleFinishArrow = () => {
    if (draftArrowPoints.length < 2) {
      setStatusText("ต้องมีอย่างน้อย 2 จุดก่อนจบลูกศร");
      return;
    }

    const nextArrows = [
      ...arrowAnnotations,
      {
        id: `arrow-${Date.now()}`,
        points: draftArrowPoints,
        label: `Arrow ${arrowAnnotations.length + 1}`,
      },
    ];

    setAndSaveArrows(nextArrows);
    setDraftArrowPoints([]);
    draftArrowPointsRef.current = [];
    setStatusText(`บันทึกลูกศรแล้ว ${draftArrowPoints.length} จุด`);
  };

  const handleUndoDraftPoint = () => {
    const nextPoints = draftArrowPoints.slice(0, -1);
    setDraftArrowPoints(nextPoints);
    draftArrowPointsRef.current = nextPoints;
    setStatusText(
      nextPoints.length
        ? `ลบจุดล่าสุดแล้ว เหลือ ${nextPoints.length} จุด`
        : "ลบจุดร่างทั้งหมดแล้ว",
    );
  };

  const handleUndoArrow = () => {
    const nextArrows = arrowAnnotations.slice(0, -1);
    setAndSaveArrows(nextArrows);
    setDraftArrowPoints([]);
    draftArrowPointsRef.current = [];
    setStatusText(
      nextArrows.length
        ? `ลบลูกศรล่าสุดแล้ว เหลือ ${nextArrows.length} อัน`
        : "ลบลูกศรล่าสุดแล้ว",
    );
  };

  const handleClearSavedArrows = () => {
    setArrowAnnotations([]);
    setDraftArrowPoints([]);
    draftArrowPointsRef.current = [];
    if (projectKeyRef.current) localStorage.removeItem(projectKeyRef.current);
    setStatusText("ลบลูกศรของไฟล์นี้แล้ว");
  };

  const zoomToFeatures = (features: GeoJsonFeature[]) => {
    if (!mapRef.current || features.length === 0) return;

    const bounds = new maplibregl.LngLatBounds();
    features.forEach((feature) => extendGeometryBounds(bounds, feature.geometry));

    if (!bounds.isEmpty()) {
      mapRef.current.fitBounds(bounds, {
        padding: 80,
        duration: 1200,
        maxZoom: 17,
      });
    }
  };

  const zoomToFeature = (geometry: GeoJSON.Geometry) => {
    if (!mapRef.current) return;

    const bounds = new maplibregl.LngLatBounds();
    extendGeometryBounds(bounds, geometry);

    if (!bounds.isEmpty()) {
      mapRef.current.fitBounds(bounds, {
        padding: 80,
        duration: 1200,
        maxZoom: 17,
      });
    }
  };

  const removeLayerFromMap = (layer: ShapeLayer) => {
    const map = mapRef.current;
    if (!map) return;

    [layer.fillLayerId, layer.outlineLayerId, layer.lineLayerId, layer.pointLayerId].forEach(
      (id) => {
        if (map.getLayer(id)) map.removeLayer(id);
        popupLayerIdsRef.current.delete(id);
      },
    );

    if (map.getSource(layer.sourceId)) map.removeSource(layer.sourceId);
  };

  useEffect(() => {
    updateArrowSource(getRenderedArrows(arrowAnnotations, draftArrowPoints));
  }, [arrowAnnotations, draftArrowPoints]);

  const clearLoadedLayers = () => {
    shapeLayers.forEach(removeLayerFromMap);
    popupLayerIdsRef.current.clear();
  };

  const registerPopup = (layerId: string) => {
    const map = mapRef.current;
    if (!map || popupLayerIdsRef.current.has(layerId)) return;

    popupLayerIdsRef.current.add(layerId);
    map.on("click", layerId, (e) => {
      if (isDrawingArrowRef.current) return;
      if (!e.features || e.features.length === 0) return;
      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(buildPopupHtml(e.features[0].properties))
        .addTo(map);
    });

    map.on("mouseenter", layerId, () => {
      if (isDrawingArrowRef.current) {
        map.getCanvas().style.cursor = "crosshair";
        return;
      }
      map.getCanvas().style.cursor = "pointer";
    });

    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = isDrawingArrowRef.current ? "crosshair" : "";
    });
  };

  const addLayerToMap = (layer: ShapeLayer) => {
    const map = mapRef.current;
    if (!map || map.getSource(layer.sourceId)) return;

    map.addSource(layer.sourceId, {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: layer.features,
      },
    });

    const visibility = layer.visible ? "visible" : "none";

    if (
      layer.geometryTypes.includes("Polygon") ||
      layer.geometryTypes.includes("MultiPolygon")
    ) {
      map.addLayer({
        id: layer.fillLayerId,
        type: "fill",
        source: layer.sourceId,
        filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]],
        layout: { visibility },
        paint: { "fill-color": layer.color, "fill-opacity": 0.28 },
      });
      map.addLayer({
        id: layer.outlineLayerId,
        type: "line",
        source: layer.sourceId,
        filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]],
        layout: { visibility },
        paint: { "line-color": layer.color, "line-width": 1.6 },
      });
      registerPopup(layer.fillLayerId);
      registerPopup(layer.outlineLayerId);
    }

    if (
      layer.geometryTypes.includes("LineString") ||
      layer.geometryTypes.includes("MultiLineString")
    ) {
      map.addLayer({
        id: layer.lineLayerId,
        type: "line",
        source: layer.sourceId,
        filter: ["in", ["geometry-type"], ["literal", ["LineString", "MultiLineString"]]],
        layout: { visibility },
        paint: { "line-color": layer.color, "line-width": 1.8 },
      });
      registerPopup(layer.lineLayerId);
    }

    if (layer.geometryTypes.includes("Point") || layer.geometryTypes.includes("MultiPoint")) {
      map.addLayer({
        id: layer.pointLayerId,
        type: "circle",
        source: layer.sourceId,
        filter: ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]],
        layout: { visibility },
        paint: {
          "circle-color": layer.color,
          "circle-radius": 5,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
        },
      });
      registerPopup(layer.pointLayerId);
    }
  };

  const setMapLayerVisibility = (layer: ShapeLayer, visible: boolean) => {
    const map = mapRef.current;
    if (!map) return;

    [layer.fillLayerId, layer.outlineLayerId, layer.lineLayerId, layer.pointLayerId].forEach(
      (id) => {
        if (map.getLayer(id)) {
          map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
        }
      },
    );
  };

  const waitForPaint = () =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

  const openLayer = async (layer: ShapeLayer, shouldZoom: boolean) => {
    setOpeningLayerId(layer.id);
    setStatusText(`กำลังเปิด layer: ${layer.name}...`);
    await waitForPaint();

    if (!layer.loaded) {
      addLayerToMap({ ...layer, visible: true });
    } else {
      setMapLayerVisibility(layer, true);
    }

    setShapeLayers((current) =>
      current.map((item) =>
        item.id === layer.id ? { ...item, loaded: true, visible: true } : item,
      ),
    );

    if (shouldZoom && layer.count <= AUTO_ZOOM_FEATURE_LIMIT) {
      zoomToFeatures(layer.features);
    }

    setOpeningLayerId("");
    setStatusText(
      layer.count > AUTO_ZOOM_FEATURE_LIMIT
        ? `เปิด layer แล้ว: ${layer.name} - เลือกรายการตำแหน่งเพื่อซูม`
        : `เปิด layer แล้ว: ${layer.name}`,
    );
  };

  const toggleLayer = async (layerId: string) => {
    const layer = shapeLayers.find((item) => item.id === layerId);
    if (!layer || openingLayerId) return;

    const nextVisible = !layer.visible;
    if (nextVisible) {
      await openLayer(layer, true);
      return;
    }

    setStatusText(`ปิด layer แล้ว: ${layer.name}`);
    setMapLayerVisibility(layer, false);
    setShapeLayers((current) =>
      current.map((item) =>
        item.id === layerId ? { ...item, loaded: true, visible: false } : item,
      ),
    );
  };

  const showFeatureOnMap = async (layer: ShapeLayer, feature: GeoJsonFeature) => {
    if (openingLayerId) return;
    if (!layer.visible) await openLayer(layer, false);
    zoomToFeature(feature.geometry);
  };

  const readZipFile = (file: File) =>
    new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();

      reader.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const percent = Math.round((event.loaded / event.total) * 100);
        setUploadProgress(percent);
        setStatusText(`กำลังอ่านไฟล์ ${percent}%`);
      };

      reader.onerror = () => reject(reader.error || new Error("อ่านไฟล์ไม่สำเร็จ"));
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(file);
    });

  const loadShapeBuffer = async (buffer: ArrayBuffer, label: string, nextProjectKey: string) => {
    if (!mapRef.current) return;

    setIsLoading(true);
    setUploadProgress(100);
    setStatusText(`กำลังแปลงไฟล์ ${label}...`);
    await waitForPaint();

    try {
      clearLoadedLayers();
      const result: any = await shp(buffer);
      const collections = Array.isArray(result) ? result : [result];
      const savedArrows = loadSavedArrows(nextProjectKey);

      const nextLayers: ShapeLayer[] = collections.map((collection: any, index: number) => {
        const id = `shape-${index}`;
        const features = (collection.features || []) as GeoJsonFeature[];
        const geometryTypes = Array.from(
          new Set(features.map((feature) => feature.geometry?.type).filter(Boolean)),
        );

        return {
          id,
          sourceId: `${id}-source`,
          fillLayerId: `${id}-fill`,
          outlineLayerId: `${id}-outline`,
          lineLayerId: `${id}-line`,
          pointLayerId: `${id}-point`,
          name: getDisplayName(collection.fileName || label, index),
          color: LAYER_COLORS[index % LAYER_COLORS.length],
          count: features.length,
          geometryTypes,
          features,
          loaded: false,
          visible: false,
        };
      });

      setShapeLayers(nextLayers);
      setSelectedLayerId(nextLayers[0]?.id || "");
      setProjectKey(nextProjectKey);
      setArrowAnnotations(savedArrows);
      setFeatureSearch("");
      setStatusText(
        `อ่านไฟล์แล้ว ${nextLayers.length} layer - ปิดไว้ทั้งหมด${
          savedArrows.length ? ` | โหลดลูกศร ${savedArrows.length} อัน` : ""
        }`,
      );
    } catch (err) {
      console.error(err);
      setStatusText("ไฟล์เสีย หรือโครงสร้าง Zip ไม่ถูกต้อง");
      alert("ไฟล์เสีย หรือโครงสร้าง Zip ไม่ถูกต้อง");
    } finally {
      setIsLoading(false);
      setUploadProgress(null);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const nextProjectKey = getArrowProjectKey(file);
    setIsLoading(true);
    setUploadProgress(0);
    try {
      await loadShapeBuffer(await readZipFile(file), file.name, nextProjectKey);
    } catch (err) {
      console.error(err);
      setStatusText("อ่านไฟล์ไม่สำเร็จ");
      setIsLoading(false);
      setUploadProgress(null);
    } finally {
      e.target.value = "";
    }
  };

  const handleClear = () => {
    clearLoadedLayers();
    setShapeLayers([]);
    setSelectedLayerId("");
    setProjectKey("");
    setArrowAnnotations([]);
    setIsDrawingArrow(false);
    setDraftArrowPoints([]);
    draftArrowPointsRef.current = [];
    setFeatureSearch("");
    setOpeningLayerId("");
    setUploadProgress(null);
    setStatusText("");
  };

  useEffect(() => {
    if (!mapContainerRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      attributionControl: false,
      maxZoom: 18,
      style: {
        version: 8,
        sources: {
          google: {
            type: "raster",
            tiles: ["https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}"],
            tileSize: 256,
          },
        },
        layers: [{ id: "google-layer", type: "raster", source: "google" }],
      },
      center: [100.5, 13.7],
      zoom: 1.5,
    });

    map.addControl(new maplibregl.NavigationControl(), "bottom-right");

    map.on("load", () => {
      map.setProjection({ type: "globe" });
      addArrowLayers(map, arrowAnnotationsRef.current);

      map.on("zoom", () => {
        if (map.getZoom() > 17) map.setZoom(17);
      });
    });

    map.on("click", (event) => {
      if (!isDrawingArrowRef.current) return;

      const clickedPoint: LngLatTuple = [event.lngLat.lng, event.lngLat.lat];

      if (draftArrowPointsRef.current.length > 0) return;

      const nextPoints = appendDraftPoint(clickedPoint, true);
      setStatusText(
        nextPoints.length === 1
          ? "เริ่มลูกศรแล้ว: ลาก/ขยับเมาส์ตามแนว แล้วดับเบิลคลิกเพื่อจบ"
          : `เพิ่มจุดที่ ${nextPoints.length} แล้ว`,
      );
    });

    map.on("mousemove", (event) => {
      if (!isDrawingArrowRef.current || draftArrowPointsRef.current.length === 0) return;

      const movedPoint: LngLatTuple = [event.lngLat.lng, event.lngLat.lat];
      appendDraftPoint(movedPoint);
    });

    map.on("dblclick", (event) => {
      if (!isDrawingArrowRef.current) return;
      event.preventDefault();

      const endPoint: LngLatTuple = [event.lngLat.lng, event.lngLat.lat];
      const nextPoints = appendDraftPoint(endPoint, true);

      if (nextPoints.length < 2) {
        setStatusText("ลากให้มีอย่างน้อย 2 จุดก่อนจบลูกศร");
        return;
      }

      const nextArrows = [
        ...arrowAnnotationsRef.current,
        {
          id: `arrow-${Date.now()}`,
          points: nextPoints,
          label: `Arrow ${arrowAnnotationsRef.current.length + 1}`,
        },
      ];

      setArrowAnnotations(nextArrows);
      saveArrows(projectKeyRef.current, nextArrows);
      setDraftArrowPoints([]);
      draftArrowPointsRef.current = [];
      setStatusText(`บันทึกลูกศรแล้ว ${nextPoints.length} จุด`);
    });

    mapRef.current = map;
    return () => map.remove();
  }, [appendDraftPoint]);

  const selectedLayer = shapeLayers.find((layer) => layer.id === selectedLayerId);
  const activeTourStep = tourStep === null ? null : TOUR_STEPS[tourStep];
  const activeTourIndex = tourStep ?? 0;
  const selectedFeatureItems = useMemo(() => {
    if (!selectedLayer) return [];

    const search = featureSearch.trim().toLowerCase();

    if (!search) {
      return selectedLayer.features.slice(0, 300).map((feature, index) => ({
        feature,
        index,
        name: String(getFeatureName(feature, index)),
      }));
    }

    if (selectedLayer.count > LARGE_SEARCH_FEATURE_LIMIT && search.length < 2) {
      return [];
    }

    const limit = 500;
    const items: { feature: GeoJsonFeature; index: number; name: string }[] = [];

    for (let index = 0; index < selectedLayer.features.length; index += 1) {
      const feature = selectedLayer.features[index];
      const name = String(getFeatureName(feature, index));
      if (!search || name.toLowerCase().includes(search)) {
        items.push({ feature, index, name });
      }
      if (items.length >= limit) break;
    }

    return items;
  }, [featureSearch, selectedLayer]);

  return (
    <div style={pageStyle}>
      <button onClick={handleResetToGlobe} style={resetGlobeButtonStyle} title="Back to Globe View">
        🌎
      </button>

      <div style={leftStackStyle}>
        <div
          style={{
            ...panelStyle,
            ...(activeTourStep?.target === "upload" ? tourHighlightStyle : null),
          }}
        >
          <strong style={{ fontSize: 13 }}>SHP Layers</strong>
          <input
            type="file"
            accept=".zip"
            onChange={handleFileUpload}
            disabled={isLoading}
            style={{ fontSize: 11, marginTop: 8, width: "100%" }}
          />
          {uploadProgress !== null && (
            <div style={progressWrapStyle}>
              <div style={progressTrackStyle}>
                <div style={{ ...progressBarStyle, width: `${uploadProgress}%` }} />
              </div>
              <div style={progressTextStyle}>{uploadProgress}%</div>
            </div>
          )}
          {statusText && <div style={statusStyle}>{statusText}</div>}
          <button onClick={() => setTourStep(0)} style={tourStartButtonStyle}>
            เริ่มทัวร์
          </button>
          <div style={arrowToolWrapStyle}>
            <button
              onClick={handleToggleArrowDrawing}
              disabled={!shapeLayers.length}
              style={{
                ...arrowToolButtonStyle,
                background: isDrawingArrow ? "#facc15" : "#0f172a",
                color: isDrawingArrow ? "#111827" : "#e5e7eb",
                cursor: shapeLayers.length ? "pointer" : "not-allowed",
              }}
            >
              {isDrawingArrow ? "กำลังวาดลูกศร" : "วาดลูกศร"}
            </button>
            <button
              onClick={handleUndoArrow}
              disabled={!arrowAnnotations.length}
              style={{
                ...arrowToolButtonStyle,
                background: "#334155",
                cursor: arrowAnnotations.length ? "pointer" : "not-allowed",
              }}
            >
              ย้อนลูกศร
            </button>
            <button
              onClick={handleClearSavedArrows}
              disabled={!arrowAnnotations.length}
              style={{
                ...arrowToolButtonStyle,
                background: "#7f1d1d",
                cursor: arrowAnnotations.length ? "pointer" : "not-allowed",
              }}
            >
              ลบลูกศร
            </button>
          </div>
          {isDrawingArrow && (
            <div style={arrowToolWrapStyle}>
              <button
                onClick={handleFinishArrow}
                disabled={draftArrowPoints.length < 2}
                style={{
                  ...arrowToolButtonStyle,
                  background: "#0891b2",
                  cursor: draftArrowPoints.length >= 2 ? "pointer" : "not-allowed",
                }}
              >
                จบตอนนี้
              </button>
              <button
                onClick={handleUndoDraftPoint}
                disabled={!draftArrowPoints.length}
                style={{
                  ...arrowToolButtonStyle,
                  background: "#475569",
                  cursor: draftArrowPoints.length ? "pointer" : "not-allowed",
                }}
              >
                ย้อนจุด
              </button>
              <button
                onClick={() => {
                  setDraftArrowPoints([]);
                  setStatusText("ล้างจุดที่กำลังร่างแล้ว");
                }}
                disabled={!draftArrowPoints.length}
                style={{
                  ...arrowToolButtonStyle,
                  background: "#1f2937",
                  cursor: draftArrowPoints.length ? "pointer" : "not-allowed",
                }}
              >
                ล้างร่าง
              </button>
            </div>
          )}
          <div style={arrowToolHintStyle}>
            ลูกศร {arrowAnnotations.length} อัน
            {projectKey ? " | บันทึกในเครื่องตามไฟล์นี้" : " | อัปโหลดไฟล์ก่อน"}
            {isDrawingArrow && !draftArrowPoints.length ? " | คลิกบนแผนที่เพื่อเริ่ม" : ""}
            {draftArrowPoints.length
              ? ` | ร่างอยู่ ${draftArrowPoints.length} จุด ดับเบิลคลิกเพื่อจบ`
              : ""}
          </div>
        </div>

        {shapeLayers.length > 0 && (
          <div
            style={{
              ...listContainerStyle,
              ...(activeTourStep?.target === "layers" ? tourHighlightStyle : null),
            }}
          >
            <div style={listTitleStyle}>Layers ({shapeLayers.length})</div>
            <div style={layerListStyle}>
              {shapeLayers.map((layer) => (
                <div key={layer.id} style={layerRowStyle}>
                  <button
                    onClick={() => toggleLayer(layer.id)}
                    disabled={Boolean(openingLayerId)}
                    style={{
                      ...toggleButtonStyle,
                      background:
                        openingLayerId === layer.id
                          ? "#facc15"
                          : layer.visible
                            ? layer.color
                            : "#1f2937",
                      color: openingLayerId === layer.id || layer.visible ? "#041015" : "#e5e7eb",
                      cursor: openingLayerId ? "wait" : "pointer",
                    }}
                    title={layer.visible ? "ปิด layer" : "เปิด layer"}
                  >
                    {openingLayerId === layer.id ? "..." : layer.visible ? "ON" : "OFF"}
                  </button>
                  <button
                    onClick={() => {
                      setSelectedLayerId(layer.id);
                      setFeatureSearch("");
                    }}
                    style={{
                      ...layerNameButtonStyle,
                      borderColor: selectedLayerId === layer.id ? layer.color : "transparent",
                    }}
                  >
                    <span style={{ color: layer.color }}>{layer.name}</span>
                    <small style={layerMetaStyle}>
                      {layer.count.toLocaleString()} items | {layer.geometryTypes.join(", ")}
                    </small>
                  </button>
                </div>
              ))}
            </div>
            <button onClick={handleClear} style={clearButtonStyle}>
              ล้างข้อมูล
            </button>
          </div>
        )}
      </div>

      {selectedLayer && (
        <div
          style={{
            ...featurePanelStyle,
            ...(activeTourStep?.target === "features" ? tourHighlightStyle : null),
          }}
        >
          <div style={listTitleStyle}>รายการตำแหน่ง</div>
          <div style={selectedLayerNameStyle}>
            <span style={{ color: selectedLayer.color }}>{selectedLayer.name}</span>
            <small>{selectedLayer.count.toLocaleString()} items</small>
          </div>
          <input
            value={featureSearch}
            onChange={(event) => setFeatureSearch(event.target.value)}
            placeholder="ค้นหาชื่อ / id"
            style={featureSearchStyle}
          />
          {selectedLayer.count > selectedFeatureItems.length && (
            <div style={featureHintStyle}>
              {selectedLayer.count > LARGE_SEARCH_FEATURE_LIMIT &&
              featureSearch.trim().length === 1
                ? "พิมพ์อย่างน้อย 2 ตัวอักษรเพื่อลดอาการค้าง"
                : `แสดง ${selectedFeatureItems.length.toLocaleString()} รายการแรก${
                    featureSearch ? "ที่ค้นเจอ" : " - พิมพ์ค้นหาเพื่อกรอง"
                  }`}
            </div>
          )}
          <div style={featureListStyle}>
            {selectedFeatureItems.map(({ feature, index, name }) => (
              <button
                key={`${selectedLayer.id}-${index}`}
                onClick={() => showFeatureOnMap(selectedLayer, feature)}
                style={featureButtonStyle}
              >
                {name}
              </button>
            ))}
            {selectedFeatureItems.length === 0 && (
              <div style={featureHintStyle}>ไม่พบรายการที่ค้นหา</div>
            )}
          </div>
        </div>
      )}

      {activeTourStep && (
        <div style={tourCardStyle}>
          <div style={tourStepLabelStyle}>
            ขั้นตอน {activeTourIndex + 1} / {TOUR_STEPS.length}
          </div>
          <div style={tourTitleStyle}>{activeTourStep.title}</div>
          <div style={tourBodyStyle}>{activeTourStep.body}</div>
          <div style={tourActionsStyle}>
            <button
              onClick={() => setTourStep(null)}
              style={{ ...tourButtonStyle, background: "#1f2937" }}
            >
              ข้าม
            </button>
            <button
              onClick={() => setTourStep(Math.max(0, activeTourIndex - 1))}
              disabled={activeTourIndex === 0}
              style={{
                ...tourButtonStyle,
                background: activeTourIndex === 0 ? "#334155" : "#475569",
                cursor: activeTourIndex === 0 ? "not-allowed" : "pointer",
              }}
            >
              ย้อนกลับ
            </button>
            <button
              onClick={() => {
                if (activeTourIndex >= TOUR_STEPS.length - 1) {
                  setTourStep(null);
                } else {
                  setTourStep(activeTourIndex + 1);
                }
              }}
              style={{ ...tourButtonStyle, background: "#0891b2" }}
            >
              {activeTourIndex >= TOUR_STEPS.length - 1 ? "จบ" : "ถัดไป"}
            </button>
          </div>
        </div>
      )}

      <div ref={mapContainerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
};

const pageStyle: React.CSSProperties = {
  width: "100vw",
  height: "100vh",
  position: "relative",
  backgroundColor: "#000",
};

const leftStackStyle: React.CSSProperties = {
  position: "absolute",
  top: 10,
  left: 10,
  zIndex: 10,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  width: 340,
  maxWidth: "calc(100vw - 20px)",
};

const panelStyle: React.CSSProperties = {
  background: "#fff",
  padding: "12px 14px",
  borderRadius: 8,
  width: "100%",
  boxSizing: "border-box",
  boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
};

const progressWrapStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 38px",
  gap: 8,
  alignItems: "center",
  marginTop: 10,
};

const progressTrackStyle: React.CSSProperties = {
  height: 8,
  overflow: "hidden",
  background: "#e2e8f0",
  borderRadius: 999,
};

const progressBarStyle: React.CSSProperties = {
  height: "100%",
  background: "#0891b2",
  borderRadius: 999,
  transition: "width 120ms ease",
};

const progressTextStyle: React.CSSProperties = {
  color: "#334155",
  fontSize: 11,
  textAlign: "right",
  fontWeight: 700,
};

const statusStyle: React.CSSProperties = {
  marginTop: 8,
  color: "#334155",
  fontSize: 11,
  lineHeight: 1.4,
};

const tourStartButtonStyle: React.CSSProperties = {
  width: "100%",
  marginTop: 10,
  padding: "8px 10px",
  background: "#111827",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 700,
};

const arrowToolWrapStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 1fr",
  gap: 6,
  marginTop: 8,
};

const arrowToolButtonStyle: React.CSSProperties = {
  minHeight: 34,
  padding: "7px 8px",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  fontSize: 11,
  fontWeight: 800,
};

const arrowToolHintStyle: React.CSSProperties = {
  marginTop: 8,
  color: "#475569",
  fontSize: 11,
  lineHeight: 1.35,
};

const listContainerStyle: React.CSSProperties = {
  background: "rgba(10, 10, 10, 0.9)",
  color: "#fff",
  padding: 12,
  borderRadius: 8,
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid #333",
};

const listTitleStyle: React.CSSProperties = {
  margin: "0 0 10px",
  color: "#67e8f9",
  fontSize: 14,
  fontWeight: 700,
};

const layerListStyle: React.CSSProperties = {
  maxHeight: "calc(100vh - 280px)",
  overflowY: "auto",
};

const layerRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "48px 1fr",
  gap: 8,
  alignItems: "stretch",
  marginBottom: 8,
};

const toggleButtonStyle: React.CSSProperties = {
  border: "1px solid #334155",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 11,
  fontWeight: 800,
};

const layerNameButtonStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 3,
  width: "100%",
  padding: "7px 8px",
  background: "#111827",
  border: "1px solid transparent",
  borderRadius: 6,
  cursor: "pointer",
  textAlign: "left",
  fontSize: 12,
  color: "#fff",
};

const layerMetaStyle: React.CSSProperties = {
  color: "#94a3b8",
  fontSize: 10,
  lineHeight: 1.2,
};

const featurePanelStyle: React.CSSProperties = {
  position: "absolute",
  top: 10,
  right: 10,
  zIndex: 10,
  width: 320,
  maxHeight: "52vh",
  padding: 12,
  background: "rgba(10, 10, 10, 0.9)",
  border: "1px solid #333",
  borderRadius: 8,
  color: "#fff",
};

const selectedLayerNameStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  marginBottom: 8,
  color: "#94a3b8",
  fontSize: 11,
};

const featureSearchStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  marginBottom: 8,
  padding: "8px 9px",
  color: "#e5e7eb",
  background: "#0f172a",
  border: "1px solid #334155",
  borderRadius: 6,
  outline: "none",
  fontSize: 12,
};

const featureHintStyle: React.CSSProperties = {
  marginBottom: 8,
  color: "#94a3b8",
  fontSize: 11,
  lineHeight: 1.35,
};

const featureListStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  maxHeight: "34vh",
  overflowY: "auto",
};

const featureButtonStyle: React.CSSProperties = {
  padding: "7px 8px",
  background: "#111827",
  color: "#e5e7eb",
  border: "1px solid #263244",
  borderRadius: 6,
  cursor: "pointer",
  textAlign: "left",
  fontSize: 12,
};

const resetGlobeButtonStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 110,
  right: 10,
  zIndex: 15,
  width: 34,
  height: 34,
  background: "#FFF",
  border: "none",
  borderRadius: "50%",
  cursor: "pointer",
  fontSize: 19,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  boxShadow: "0 2px 10px rgba(0,0,0,0.3)",
};

const clearButtonStyle: React.CSSProperties = {
  width: "100%",
  marginTop: 8,
  padding: 8,
  background: "#b91c1c",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
};

const tourHighlightStyle: React.CSSProperties = {
  boxShadow: "0 0 0 3px #facc15, 0 12px 30px rgba(0,0,0,0.5)",
};

const tourCardStyle: React.CSSProperties = {
  position: "absolute",
  left: "50%",
  bottom: 24,
  transform: "translateX(-50%)",
  zIndex: 25,
  width: "min(420px, calc(100vw - 24px))",
  padding: 14,
  background: "rgba(8, 13, 25, 0.96)",
  border: "1px solid #334155",
  borderRadius: 8,
  color: "#e5e7eb",
  boxShadow: "0 16px 40px rgba(0,0,0,0.45)",
};

const tourStepLabelStyle: React.CSSProperties = {
  marginBottom: 6,
  color: "#94a3b8",
  fontSize: 11,
  fontWeight: 700,
};

const tourTitleStyle: React.CSSProperties = {
  marginBottom: 6,
  color: "#67e8f9",
  fontSize: 15,
  fontWeight: 800,
};

const tourBodyStyle: React.CSSProperties = {
  color: "#cbd5e1",
  fontSize: 12,
  lineHeight: 1.5,
};

const tourActionsStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 12,
};

const tourButtonStyle: React.CSSProperties = {
  padding: "7px 10px",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 700,
};

export default MapGlobeShp;

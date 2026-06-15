/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { iter, type ZipItem } from "but-unzip";
import { fromBlob } from "geotiff";

import "maplibre-gl/dist/maplibre-gl.css";

const AUTO_ZOOM_FEATURE_LIMIT = 5000;
const LARGE_SEARCH_FEATURE_LIMIT = 50000;
const GEOMETRY_LABELS: Record<string, string> = {
  Point: "จุด",
  MultiPoint: "กลุ่มจุด",
  LineString: "เส้น",
  MultiLineString: "กลุ่มเส้น",
  Polygon: "พื้นที่",
  MultiPolygon: "กลุ่มพื้นที่",
  GeometryCollection: "ข้อมูลผสม",
};
const LEGACY_ARROW_STORAGE_PREFIX = "test-shapefile-map:arrows";
const ARROW_STORAGE_PREFIX = "test-shapefile-map:arrows:v2";
const ARROW_SOURCE_ID = "annotation-arrows-source";
const ARROW_LINE_LAYER_ID = "annotation-arrows-line";
const ARROW_HEAD_LAYER_ID = "annotation-arrows-head";
const ARROW_HEAD_LENGTH = 0.00035;
const ARROW_HEAD_ANGLE = Math.PI / 7;
const MIN_DRAW_POINT_DISTANCE_PX = 10;
const RASTER_SOURCE_ID = "uploaded-raster-source";
const RASTER_LAYER_ID = "uploaded-raster-layer";
const MAX_RASTER_PREVIEW_WIDTH = 1400;
const LARGE_ZIP_UPLOAD_LIMIT_BYTES = 512 * 1024 * 1024;
const TOUR_STEPS = [
  {
    title: "เลือกไฟล์แผนที่",
    body: "เริ่มจากเลือกไฟล์ .zip, .tif หรือ .tiff จากเครื่อง ระบบจะแสดง progress ระหว่างอ่านไฟล์และแปลงข้อมูล",
    target: "upload",
  },
  {
    title: "เปิด Layer ทีละชั้น",
    body: "ทุกชั้นข้อมูลจะปิดไว้ก่อน กด เปิด เมื่อต้องการแสดงบนแผนที่ เพื่อลดอาการค้าง",
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
  "#38bdf8",
  "#fb7185",
  "#2dd4bf",
  "#e879f9",
  "#f59e0b",
  "#818cf8",
  "#4ade80",
  "#f472b6",
];

type GeoJsonFeature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, any>>;
type LngLatTuple = [number, number];
type UploadMode = "file" | "backend";

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
  detailLimited: boolean;
}

interface ParsedShapeCollection {
  fileName?: string;
  features: GeoJsonFeature[];
  geometryTypes: string[];
  featureCount: number;
  detailLimited: boolean;
}

interface RasterOverlay {
  name: string;
  url: string;
  sourceType: "file" | "zip";
  archiveName?: string;
  sourceWidth: number;
  sourceHeight: number;
  previewWidth: number;
  previewHeight: number;
  overviewIndex: number;
  overviewCount: number;
}

interface LoadStage {
  current: number;
  total: number;
  label: string;
}

interface ZipMapFileInfo {
  shapeEntries: ZipItem[];
  rasterEntry?: ZipItem;
}

interface ParsedGeoTiff {
  bbox: number[];
  geoKeys: Record<string, unknown>;
  sourceWidth: number;
  sourceHeight: number;
  previewWidth: number;
  previewHeight: number;
  overviewIndex: number;
  overviewCount: number;
  rgba: ArrayBuffer;
}

const getNormalizedFileName = (name: string) => name.trim().toLowerCase();
const isZipFileName = (name: string) => /\.zip$/i.test(name.trim());
const isGeoTiffFileName = (name: string) => /\.tiff?$/i.test(name.trim());
const isShapeFileName = (name: string) => /\.shp$/i.test(name.trim());
const isGeoJsonFileName = (name: string) => /\.geojson$/i.test(name.trim()) || /\.json$/i.test(name.trim());

const formatFileSize = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const gigabytes = bytes / 1024 / 1024 / 1024;
  if (gigabytes >= 1) return `${gigabytes.toFixed(gigabytes >= 10 ? 0 : 1)} GB`;
  const megabytes = bytes / 1024 / 1024;
  return `${megabytes.toFixed(megabytes >= 10 ? 0 : 1)} MB`;
};

const getLargeZipRasterMessage = (file: File) =>
  `ZIP นี้มีขนาด ${formatFileSize(file.size)} ใหญ่มากสำหรับอ่าน GeoTIFF ผ่าน browser ` +
  "กรุณาแตก ZIP แล้วอัปโหลดไฟล์ .tif/.tiff โดยตรง ระบบจะอ่านแบบแบ่งช่วงและไม่ต้องโหลดทั้ง ZIP";

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

const extendBounds = (bounds: maplibregl.LngLatBounds, coordinates: unknown) => {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return;

  if (typeof coordinates[0] === "number") {
    const [lng, lat] = coordinates;
    if (Number.isFinite(lng) && Number.isFinite(lat)) {
      bounds.extend([lng, lat]);
    }
    return;
  }

  coordinates.forEach((coord) => extendBounds(bounds, coord));
};

const extendGeometryBounds = (
  bounds: maplibregl.LngLatBounds,
  geometry: GeoJSON.Geometry | null | undefined,
) => {
  if (!geometry) return;

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

  return `<div style="padding:10px; font-size:12px; max-width:280px;"><b>รายละเอียดข้อมูล</b><hr/>${rows}</div>`;
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
        geometry: { type: "LineString" as const, coordinates: arrow.points },
        properties: { id: arrow.id, kind: "arrow-line", label: arrow.label },
      },
      ...headLines.map((coordinates, headIndex) => ({
        type: "Feature" as const,
        geometry: { type: "LineString" as const, coordinates },
        properties: {
          id: `${arrow.id}-head-${headIndex}`,
          kind: "arrow-head",
          label: arrow.label,
        },
      })),
    ];
  }),
});

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => (radians * 180) / Math.PI;

const utmToLngLat = (easting: number, northing: number, epsgCode: number): LngLatTuple => {
  const zone = epsgCode % 100;
  const isSouthernHemisphere = Math.floor(epsgCode / 100) === 327;
  const x = easting - 500000;
  const y = isSouthernHemisphere ? northing - 10000000 : northing;
  const scaleFactor = 0.9996;
  const semiMajorAxis = 6378137;
  const eccentricitySquared = 0.00669438;
  const eccentricityPrimeSquared = eccentricitySquared / (1 - eccentricitySquared);
  const e1 =
    (1 - Math.sqrt(1 - eccentricitySquared)) / (1 + Math.sqrt(1 - eccentricitySquared));
  const meridionalArc = y / scaleFactor;
  const mu =
    meridionalArc /
    (semiMajorAxis *
      (1 -
        eccentricitySquared / 4 -
        (3 * eccentricitySquared ** 2) / 64 -
        (5 * eccentricitySquared ** 3) / 256));

  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);
  const n1 = semiMajorAxis / Math.sqrt(1 - eccentricitySquared * sinPhi1 ** 2);
  const t1 = tanPhi1 ** 2;
  const c1 = eccentricityPrimeSquared * cosPhi1 ** 2;
  const r1 =
    (semiMajorAxis * (1 - eccentricitySquared)) /
    (1 - eccentricitySquared * sinPhi1 ** 2) ** 1.5;
  const d = x / (n1 * scaleFactor);

  const latitude =
    phi1 -
    ((n1 * tanPhi1) / r1) *
      (d ** 2 / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * eccentricityPrimeSquared) * d ** 4) / 24 +
        ((61 +
          90 * t1 +
          298 * c1 +
          45 * t1 ** 2 -
          252 * eccentricityPrimeSquared -
          3 * c1 ** 2) *
          d ** 6) /
          720);
  const longitudeOrigin = (zone - 1) * 6 - 180 + 3;
  const longitude =
    toRadians(longitudeOrigin) +
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 -
        2 * c1 +
        28 * t1 -
        3 * c1 ** 2 +
        8 * eccentricityPrimeSquared +
        24 * t1 ** 2) *
        d ** 5) /
        120) /
      cosPhi1;

  return [toDegrees(longitude), toDegrees(latitude)];
};

const webMercatorToLngLat = (x: number, y: number): LngLatTuple => {
  const semiMajorAxis = 6378137;
  return [
    toDegrees(x / semiMajorAxis),
    toDegrees(Math.atan(Math.sinh(y / semiMajorAxis))),
  ];
};

const getRasterCoordinates = (
  bbox: number[],
  geoKeys: Record<string, unknown>,
): [LngLatTuple, LngLatTuple, LngLatTuple, LngLatTuple] => {
  const [minX, minY, maxX, maxY] = bbox;
  const epsgCode = Number(geoKeys.ProjectedCSTypeGeoKey || geoKeys.GeographicTypeGeoKey || 4326);
  const convert = (x: number, y: number): LngLatTuple => {
    if (epsgCode === 4326) return [x, y];
    if (epsgCode === 3857) return webMercatorToLngLat(x, y);
    if (epsgCode >= 32601 && epsgCode <= 32660) return utmToLngLat(x, y, epsgCode);
    if (epsgCode >= 32701 && epsgCode <= 32760) return utmToLngLat(x, y, epsgCode);
    throw new Error(`ยังไม่รองรับระบบพิกัด EPSG:${epsgCode}`);
  };

  return [
    convert(minX, maxY),
    convert(maxX, maxY),
    convert(maxX, minY),
    convert(minX, minY),
  ];
};

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
    paint: { "line-color": "#facc15", "line-width": 4, "line-opacity": 0.95 },
  });

  map.addLayer({
    id: ARROW_HEAD_LAYER_ID,
    type: "line",
    source: ARROW_SOURCE_ID,
    filter: ["==", ["get", "kind"], "arrow-head"],
    paint: { "line-color": "#facc15", "line-width": 4, "line-opacity": 0.95 },
    layout: { "line-cap": "round", "line-join": "round" },
  });
};

const MapGlobeShp = () => {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const shapefileInputRef = useRef<HTMLInputElement | null>(null);
  const geojsonInputRef = useRef<HTMLInputElement | null>(null);
  const layerSearchRef = useRef<HTMLInputElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupLayerIdsRef = useRef<Set<string>>(new Set());
  const projectKeyRef = useRef("");
  const arrowAnnotationsRef = useRef<ArrowAnnotation[]>([]);
  const rasterUrlRef = useRef("");
  const isDrawingArrowRef = useRef(false);
  const draftArrowPointsRef = useRef<LngLatTuple[]>([]);

  const [shapeLayers, setShapeLayers] = useState<ShapeLayer[]>([]);
  const [selectedLayerId, setSelectedLayerId] = useState<string>("");
  const [layerSearch, setLayerSearch] = useState("");
  const [featureSearch, setFeatureSearch] = useState("");
  const [mobilePanel, setMobilePanel] = useState<"layers" | "features">("layers");
  const [openingLayerId, setOpeningLayerId] = useState<string>("");
  const [projectKey, setProjectKey] = useState("");
  const [arrowAnnotations, setArrowAnnotations] = useState<ArrowAnnotation[]>([]);
  const [rasterOverlay, setRasterOverlay] = useState<RasterOverlay | null>(null);
  const [isDrawingArrow, setIsDrawingArrow] = useState(false);
  const [draftArrowPoints, setDraftArrowPoints] = useState<LngLatTuple[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [loadStage, setLoadStage] = useState<LoadStage | null>(null);
  const [statusText, setStatusText] = useState("");
  const [tourStep, setTourStep] = useState<number | null>(null);
  const [uploadMode, setUploadMode] = useState<UploadMode>(() => {
    const saved = localStorage.getItem("uploadMode");
    return (saved === "backend" ? "backend" : "file") as UploadMode;
  });

  useEffect(() => {
    localStorage.setItem("uploadMode", uploadMode);
  }, [uploadMode]);

  useEffect(() => {
    Object.keys(localStorage)
      .filter(
        (key) =>
          key.startsWith(LEGACY_ARROW_STORAGE_PREFIX) && !key.startsWith(ARROW_STORAGE_PREFIX),
      )
      .forEach((key) => localStorage.removeItem(key));
  }, []);

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
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";

      if (event.key === "/" && shapeLayers.length > 0 && !isTyping) {
        event.preventDefault();
        setMobilePanel("layers");
        layerSearchRef.current?.focus();
      }

      if (event.key === "Escape" && isDrawingArrowRef.current) {
        setIsDrawingArrow(false);
        setDraftArrowPoints([]);
        setStatusText("ยกเลิกการวาดลูกศรแล้ว");
      }
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [shapeLayers.length]);

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

  const zoomToFeature = (geometry: GeoJSON.Geometry | null | undefined) => {
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

  const removeRasterOverlay = () => {
    const map = mapRef.current;
    if (map?.getLayer(RASTER_LAYER_ID)) map.removeLayer(RASTER_LAYER_ID);
    if (map?.getSource(RASTER_SOURCE_ID)) map.removeSource(RASTER_SOURCE_ID);
    if (rasterUrlRef.current) URL.revokeObjectURL(rasterUrlRef.current);
    rasterUrlRef.current = "";
    setRasterOverlay(null);
  };

  const addRasterOverlay = (
    url: string,
    coordinates: [LngLatTuple, LngLatTuple, LngLatTuple, LngLatTuple],
  ) => {
    const map = mapRef.current;
    if (!map) return;

    if (map.getLayer(RASTER_LAYER_ID)) map.removeLayer(RASTER_LAYER_ID);
    if (map.getSource(RASTER_SOURCE_ID)) map.removeSource(RASTER_SOURCE_ID);

    map.addSource(RASTER_SOURCE_ID, {
      type: "image",
      url,
      coordinates,
    });
    const rasterLayer: maplibregl.LayerSpecification = {
      id: RASTER_LAYER_ID,
      type: "raster",
      source: RASTER_SOURCE_ID,
      paint: { "raster-opacity": 0.72 },
    };
    if (map.getLayer(ARROW_LINE_LAYER_ID)) {
      map.addLayer(rasterLayer, ARROW_LINE_LAYER_ID);
    } else {
      map.addLayer(rasterLayer);
    }

    const bounds = new maplibregl.LngLatBounds();
    coordinates.forEach((coordinate) => bounds.extend(coordinate));
    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, { padding: 70, duration: 1200, maxZoom: 16 });
    }
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
    setStatusText(`กำลังเปิดชั้นข้อมูล: ${layer.name}...`);
    try {
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

      setStatusText(
        layer.count > AUTO_ZOOM_FEATURE_LIMIT
          ? `เปิดชั้นข้อมูลแล้ว: ${layer.name} เลือกรายการเพื่อซูม`
          : `เปิดชั้นข้อมูลแล้ว: ${layer.name}`,
      );
    } catch (error) {
      console.error(error);
      setStatusText(`เปิดชั้นข้อมูลไม่สำเร็จ: ${layer.name}`);
    } finally {
      setOpeningLayerId("");
    }
  };

  const toggleLayer = async (layerId: string) => {
    const layer = shapeLayers.find((item) => item.id === layerId);
    if (!layer || openingLayerId) return;

    const nextVisible = !layer.visible;
    if (nextVisible) {
      await openLayer(layer, true);
      return;
    }

    setStatusText(`ปิดชั้นข้อมูลแล้ว: ${layer.name}`);
    setMapLayerVisibility(layer, false);
    setShapeLayers((current) =>
      current.map((item) =>
        item.id === layerId ? { ...item, loaded: true, visible: false } : item,
      ),
    );
  };

  const showFeatureOnMap = async (layer: ShapeLayer, feature: GeoJsonFeature) => {
    if (openingLayerId) return;
    if (!feature.geometry) {
      setStatusText("รายการนี้ไม่มีพิกัด จึงไม่สามารถแสดงบนแผนที่ได้");
      return;
    }
    if (!layer.visible) await openLayer(layer, false);
    zoomToFeature(feature.geometry);
  };

  const hideAllLayers = () => {
    shapeLayers.forEach((layer) => setMapLayerVisibility(layer, false));
    setShapeLayers((current) => current.map((layer) => ({ ...layer, visible: false })));
    setStatusText("ปิดชั้นข้อมูลทั้งหมดแล้ว");
  };

  const readZipFile = (file: File) =>
    new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();

      reader.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const percent = Math.round((event.loaded / event.total) * 100);
        setUploadProgress(Math.round(percent / 3));
        setStatusText(`กำลังอ่านไฟล์ ${percent}%`);
      };

      reader.onerror = () => {
        if (file.size > LARGE_ZIP_UPLOAD_LIMIT_BYTES) {
          reject(new Error(getLargeZipRasterMessage(file)));
          return;
        }
        reject(
          new Error(
            "อ่านไฟล์ ZIP ไม่สำเร็จ หากเป็น GeoTIFF/COG ขนาดใหญ่ ให้แตก ZIP แล้วอัปโหลด .tif/.tiff โดยตรง",
          ),
        );
      };
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(file);
    });

  const inspectZipMapFiles = (buffer: ArrayBuffer): ZipMapFileInfo => {
    const entries = Array.from(iter(new Uint8Array(buffer))).filter(
      (entry) => !entry.filename.includes("__MACOSX"),
    );
    const shapeEntries = entries.filter((entry) => isShapeFileName(entry.filename));
    const rasterEntry = entries.find((entry) => {
      return isGeoTiffFileName(entry.filename);
    });

    return { shapeEntries, rasterEntry };
  };

  const extractRasterFileFromZip = async (entry: ZipItem) => {
    const bytes = await entry.read();
    const name = entry.filename.split(/[\\/]/).pop() || "raster.tif";
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new File([copy.buffer], name, { type: "image/tiff" });
  };

  const createRasterImageUrl = (rgba: ArrayBuffer, width: number, height: number) =>
    new Promise<string>((resolve, reject) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("ไม่สามารถสร้างภาพ raster preview ได้"));
        return;
      }

      context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("ไม่สามารถแปลง raster preview เป็นภาพได้"));
          return;
        }
        resolve(URL.createObjectURL(blob));
      }, "image/png");
    });

  const pickGeoTiffPreviewImage = async (tiff: Awaited<ReturnType<typeof fromBlob>>) => {
    const count = await tiff.getImageCount();
    const images = [];

    for (let index = 0; index < count; index += 1) {
      const image = await tiff.getImage(index);
      images.push(image);
      if (image.getWidth() <= MAX_RASTER_PREVIEW_WIDTH) return { image, index, count };
    }

    return { image: images[images.length - 1], index: images.length - 1, count };
  };

  const parseGeoTiffFromFile = async (file: File): Promise<ParsedGeoTiff> => {
    setStatusText("กำลังอ่าน GeoTIFF metadata...");
    const tiff = await fromBlob(file);
    const baseImage = await tiff.getImage(0);
    const { image, index, count } = await pickGeoTiffPreviewImage(tiff);
    const baseWidth = baseImage.getWidth();
    const baseHeight = baseImage.getHeight();
    const bbox = baseImage.getBoundingBox();
    const geoKeys = baseImage.getGeoKeys() as Record<string, unknown>;

    setStatusText(
      `กำลังอ่านภาพย่อ ${image.getWidth().toLocaleString()} x ${image
        .getHeight()
        .toLocaleString()} px`,
    );

    const rgb = await image.readRGB({ interleave: true });
    const rgba = new Uint8ClampedArray(rgb.width * rgb.height * 4);

    for (let sourceIndex = 0, targetIndex = 0; sourceIndex < rgb.length; sourceIndex += 3, targetIndex += 4) {
      rgba[targetIndex] = rgb[sourceIndex];
      rgba[targetIndex + 1] = rgb[sourceIndex + 1];
      rgba[targetIndex + 2] = rgb[sourceIndex + 2];
      rgba[targetIndex + 3] = 220;
    }

    return {
      bbox,
      geoKeys,
      sourceWidth: baseWidth,
      sourceHeight: baseHeight,
      previewWidth: rgb.width,
      previewHeight: rgb.height,
      overviewIndex: index,
      overviewCount: count,
      rgba: rgba.buffer,
    };
  };

  const parseShapeInWorker = (buffer: ArrayBuffer) =>
    new Promise<ParsedShapeCollection[]>((resolve, reject) => {
      const collections: ParsedShapeCollection[] = [];
      let activeCollection: ParsedShapeCollection | null = null;
      const worker = new Worker(new URL("../workers/shapefile.worker.ts", import.meta.url), {
        type: "module",
      });

      worker.onmessage = (
        event: MessageEvent<
          | { type: "start"; total: number; uncompressedBytes: number }
          | { type: "progress"; current: number; total: number; message: string }
          | {
              type: "layer-start";
              current: number;
              total: number;
              fileName: string;
              featureCount: number;
              detailLimited: boolean;
            }
          | {
              type: "feature-chunk";
              current: number;
              total: number;
              loadedFeatures: number;
              featureCount: number;
              features: GeoJsonFeature[];
            }
          | {
              type: "layer-complete";
              current: number;
              total: number;
              geometryTypes: string[];
            }
          | { type: "complete" }
          | { type: "error"; message: string }
        >,
      ) => {
        if (event.data.type === "start") {
          setStatusText(`พบ ${event.data.total} ชั้นข้อมูล กำลังแปลงทีละชั้น...`);
          return;
        }

        if (event.data.type === "progress") {
          setUploadProgress(34 + Math.round((event.data.current / event.data.total) * 40));
          setStatusText(event.data.message);
          return;
        }

        if (event.data.type === "layer-start") {
          activeCollection = {
            fileName: event.data.fileName,
            geometryTypes: [],
            features: [],
            featureCount: event.data.featureCount,
            detailLimited: event.data.detailLimited,
          };
          return;
        }

        if (event.data.type === "feature-chunk") {
          activeCollection?.features.push(...event.data.features);
          setStatusText(
            `ชั้น ${event.data.current}/${event.data.total}: รับข้อมูล ${event.data.loadedFeatures.toLocaleString()}/${event.data.featureCount.toLocaleString()} รายการ`,
          );
          return;
        }

        if (event.data.type === "layer-complete") {
          if (activeCollection) {
            activeCollection.geometryTypes = event.data.geometryTypes;
            collections.push(activeCollection);
          }
          activeCollection = null;
          setStatusText(`แปลงแล้ว ${event.data.current}/${event.data.total} ชั้นข้อมูล`);
          return;
        }

        worker.terminate();
        if (event.data.type === "complete") {
          resolve(collections);
        } else {
          reject(new Error(event.data.message));
        }
      };

      worker.onerror = (event) => {
        worker.terminate();
        reject(new Error(event.message || "Web Worker ทำงานไม่สำเร็จ"));
      };

      worker.postMessage({ buffer }, [buffer]);
    });

  const loadShapeBuffer = async (buffer: ArrayBuffer, label: string, nextProjectKey: string) => {
    if (!mapRef.current) return;

    setIsLoading(true);
    setLoadStage({ current: 2, total: 3, label: "แปลง Shapefile" });
    setUploadProgress(34);
    setStatusText(`กำลังแปลงไฟล์ ${label} ในเบื้องหลัง หน้ายังใช้งานได้`);
    await waitForPaint();

    try {
      clearLoadedLayers();
      removeRasterOverlay();
      const collections = await parseShapeInWorker(buffer);
      setLoadStage({ current: 3, total: 3, label: "เตรียมชั้นข้อมูล" });
      setUploadProgress(75);
      setStatusText("กำลังเตรียมรายการชั้นข้อมูล...");
      await waitForPaint();
      const savedArrows = loadSavedArrows(nextProjectKey);

      const nextLayers: ShapeLayer[] = collections.map((collection, index) => {
        const id = `shape-${index}`;
        const features = collection.features || [];

        return {
          id,
          sourceId: `${id}-source`,
          fillLayerId: `${id}-fill`,
          outlineLayerId: `${id}-outline`,
          lineLayerId: `${id}-line`,
          pointLayerId: `${id}-point`,
          name: getDisplayName(collection.fileName || label, index),
          color: LAYER_COLORS[index % LAYER_COLORS.length],
          count: collection.featureCount,
          geometryTypes: collection.geometryTypes,
          features,
          loaded: false,
          visible: false,
          detailLimited: collection.detailLimited,
        };
      });

      setShapeLayers(nextLayers);
      setSelectedLayerId(nextLayers[0]?.id || "");
      setProjectKey(nextProjectKey);
      setArrowAnnotations(savedArrows);
      setLayerSearch("");
      setFeatureSearch("");
      setMobilePanel("layers");
      setUploadProgress(100);
      setStatusText(
        `อ่านไฟล์แล้ว ${nextLayers.length} ชั้นข้อมูล ปิดไว้ทั้งหมด${
          savedArrows.length ? ` โหลดลูกศร ${savedArrows.length} อัน` : ""
        }`,
      );
    } catch (err) {
      console.error(err);
      setStatusText(
        err instanceof Error
          ? err.message
          : "เปิดไฟล์ไม่สำเร็จ กรุณาตรวจว่า ZIP มีไฟล์ .shp, .dbf และ .shx ที่ใช้ชื่อเดียวกัน",
      );
    } finally {
      setIsLoading(false);
      setUploadProgress(null);
      setLoadStage(null);
    }
  };

  const loadRasterFile = async (
    file: File,
    nextProjectKey: string,
    source: { type: "file" | "zip"; archiveName?: string } = { type: "file" },
  ) => {
    if (!mapRef.current) return;

    setIsLoading(true);
    setUploadProgress(8);
    setLoadStage({ current: 1, total: 3, label: "อ่าน GeoTIFF metadata" });
    setStatusText(
      source.type === "zip"
        ? `กำลังแตก GeoTIFF จาก ZIP: ${file.name}`
        : `กำลังอ่านไฟล์ raster ${file.name}`,
    );
    await waitForPaint();

    try {
      clearLoadedLayers();
      removeRasterOverlay();
      setShapeLayers([]);
      setSelectedLayerId("");
      setLayerSearch("");
      setFeatureSearch("");

      const parsed = await parseGeoTiffFromFile(file);
      setUploadProgress(66);
      setLoadStage({ current: 2, total: 3, label: "สร้างภาพ preview" });
      setStatusText("กำลังสร้างภาพสำหรับวางบนแผนที่...");
      await waitForPaint();

      const coordinates = getRasterCoordinates(parsed.bbox, parsed.geoKeys);
      const url = await createRasterImageUrl(parsed.rgba, parsed.previewWidth, parsed.previewHeight);

      rasterUrlRef.current = url;
      addRasterOverlay(url, coordinates);
      setProjectKey(nextProjectKey);
      setArrowAnnotations(loadSavedArrows(nextProjectKey));
      setRasterOverlay({
        name: file.name,
        url,
        sourceType: source.type,
        archiveName: source.archiveName,
        sourceWidth: parsed.sourceWidth,
        sourceHeight: parsed.sourceHeight,
        previewWidth: parsed.previewWidth,
        previewHeight: parsed.previewHeight,
        overviewIndex: parsed.overviewIndex,
        overviewCount: parsed.overviewCount,
      });
      setUploadProgress(100);
      setLoadStage({ current: 3, total: 3, label: "แสดงบนแผนที่" });
      setStatusText("");
    } catch (err) {
      console.error(err);
      setStatusText(err instanceof Error ? err.message : "เปิด GeoTIFF ไม่สำเร็จ");
    } finally {
      setIsLoading(false);
      setUploadProgress(null);
      setLoadStage(null);
    }
  };

  const loadGeoJsonFile = async (file: File, nextProjectKey: string) => {
    if (!mapRef.current) return;

    setIsLoading(true);
    setUploadProgress(10);
    setLoadStage({ current: 1, total: 2, label: "อ่านไฟล์ GeoJSON" });
    setStatusText(`กำลังอ่านไฟล์ GeoJSON ${file.name}...`);
    await waitForPaint();

    try {
      clearLoadedLayers();
      removeRasterOverlay();
      
      const text = await file.text();
      setUploadProgress(40);
      setLoadStage({ current: 2, total: 2, label: "เตรียมชั้นข้อมูล" });
      setStatusText("กำลังแปลงข้อมูล GeoJSON...");
      await waitForPaint();

      const parsed = JSON.parse(text);
      let parsedLayers: { id?: string; name?: string; features: GeoJsonFeature[] }[] = [];

      const extractFeatures = (obj: any): GeoJsonFeature[] => {
        if (!obj || typeof obj !== "object") return [];
        if (obj.type === "FeatureCollection" && Array.isArray(obj.features)) return obj.features;
        if (obj.type === "Feature") return [obj];
        if (obj.type && obj.coordinates) return [{ type: "Feature" as const, properties: {}, geometry: obj }];
        if (Array.isArray(obj)) return obj.flatMap(item => extractFeatures(item));
        if (obj.features && Array.isArray(obj.features)) return obj.features;
        if (obj.geojson && obj.geojson.features) return obj.geojson.features;
        return [];
      };

      if (parsed.layers && Array.isArray(parsed.layers)) {
        parsedLayers = parsed.layers.map((layer: any, idx: number) => ({
          id: layer.id || `layer-${idx}`,
          name: layer.name || `Layer ${idx + 1}`,
          features: extractFeatures(layer),
        }));
      } else {
        const features = extractFeatures(parsed);
        if (features.length > 0) {
          parsedLayers = [{ features }];
        } else {
          // Fallback: search values for features
          for (const val of Object.values(parsed)) {
            const feats = extractFeatures(val);
            if (feats.length > 0) {
              parsedLayers = [{ features: feats }];
              break;
            }
          }
        }
      }

      if (parsedLayers.length === 0 || parsedLayers.every(l => l.features.length === 0)) {
        throw new Error("รูปแบบไฟล์ไม่ถูกต้อง (ไม่พบข้อมูลพิกัด Feature ในไฟล์)");
      }

      const savedArrows = loadSavedArrows(nextProjectKey);

      const nextLayers: ShapeLayer[] = parsedLayers.filter(l => l.features.length > 0).map((layer, index) => {
        const id = layer.id || `geojson-${index}`;
        const features = layer.features;
        const geometryTypes = Array.from(new Set(features.map((f: any) => f.geometry?.type).filter(Boolean))) as string[];

        return {
          id,
          sourceId: `${id}-source`,
          fillLayerId: `${id}-fill`,
          outlineLayerId: `${id}-outline`,
          lineLayerId: `${id}-line`,
          pointLayerId: `${id}-point`,
          name: layer.name || getDisplayName(file.name, index),
          color: LAYER_COLORS[index % LAYER_COLORS.length],
          count: features.length,
          geometryTypes,
          features,
          loaded: false,
          visible: false,
          detailLimited: false,
        };
      });

      const shouldAutoOpen = nextLayers.length === 1 && nextLayers[0].count <= AUTO_ZOOM_FEATURE_LIMIT;
      if (shouldAutoOpen) {
        nextLayers[0].visible = true;
        nextLayers[0].loaded = true;
      }

      setShapeLayers(nextLayers);
      setSelectedLayerId(nextLayers[0]?.id || "");
      setProjectKey(nextProjectKey);
      setArrowAnnotations(savedArrows);
      setLayerSearch("");
      setFeatureSearch("");
      setMobilePanel("layers");
      setUploadProgress(100);
      
      if (shouldAutoOpen) {
        setTimeout(() => {
          if (mapRef.current) {
            addLayerToMap(nextLayers[0]);
            zoomToFeatures(nextLayers[0].features);
          }
        }, 100);
        setStatusText(`แสดงผล 1 ชั้นข้อมูลบนแผนที่แล้ว${savedArrows.length ? ` (ลูกศร ${savedArrows.length} อัน)` : ""}`);
      } else {
        setStatusText(
          `อ่านไฟล์แล้ว ${nextLayers.length} ชั้นข้อมูล ปิดไว้ทั้งหมด${
            savedArrows.length ? ` โหลดลูกศร ${savedArrows.length} อัน` : ""
          }`,
        );
      }
    } catch (err) {
      console.error(err);
      setStatusText(err instanceof Error ? err.message : "อ่านไฟล์ GeoJSON ไม่สำเร็จ (ไฟล์อาจไม่ถูกต้องตาม format)");
    } finally {
      setIsLoading(false);
      setUploadProgress(null);
      setLoadStage(null);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, target: "shapefile" | "geojson") => {
    const file = e.target.files?.[0];
    if (!file) return;
    const nextProjectKey = getArrowProjectKey(file);
    const normalizedFileName = getNormalizedFileName(file.name);
    const isZip = isZipFileName(normalizedFileName);
    const isGeoTiff = isGeoTiffFileName(normalizedFileName) || file.type === "image/tiff";
    const isGeoJson = isGeoJsonFileName(normalizedFileName) || file.type === "application/geo+json" || file.type === "application/json";

    if (target === "shapefile" && isGeoJson) {
      setStatusText("รองรับเฉพาะไฟล์ .zip, .tif, .tiff (หากต้องการอัปโหลด GeoJSON กรุณาไปที่แท็บ Backend GeoJSON)");
      e.target.value = "";
      return;
    }

    if (target === "geojson" && !isGeoJson) {
      setStatusText("รองรับเฉพาะไฟล์ .geojson, .json");
      e.target.value = "";
      return;
    }

    setIsLoading(true);
    setUploadProgress(0);
    setLoadStage({
      current: 1,
      total: 3,
      label: isGeoTiff ? "เตรียม GeoTIFF" : isGeoJson ? "อ่านไฟล์ GeoJSON" : "อ่านไฟล์ ZIP",
    });
    try {
      if (isZip) {
        if (file.size > LARGE_ZIP_UPLOAD_LIMIT_BYTES) {
          throw new Error(getLargeZipRasterMessage(file));
        }

        const buffer = await readZipFile(file);
        const { rasterEntry, shapeEntries } = inspectZipMapFiles(buffer);

        if (rasterEntry) {
          setLoadStage({ current: 2, total: 3, label: "แตก GeoTIFF จาก ZIP" });
          setStatusText(`พบ GeoTIFF ใน ZIP: ${rasterEntry.filename}`);
          setUploadProgress(24);
          await loadRasterFile(await extractRasterFileFromZip(rasterEntry), nextProjectKey, {
            type: "zip",
            archiveName: file.name,
          });
          return;
        }

        if (shapeEntries.length > 0) {
          await loadShapeBuffer(buffer, file.name, nextProjectKey);
          return;
        }

        throw new Error("ZIP นี้ไม่มี .shp หรือ .tif/.tiff ที่ระบบอ่านได้");
      }

      if (isGeoTiff) {
        await loadRasterFile(file, nextProjectKey);
        return;
      }

      if (isGeoJson) {
        await loadGeoJsonFile(file, nextProjectKey);
        return;
      }

      throw new Error("รองรับเฉพาะไฟล์ .zip, .tif, .tiff และ .geojson");
    } catch (err) {
      console.error(err);
      setStatusText(err instanceof Error ? err.message : "อ่านไฟล์ไม่สำเร็จ");
      setIsLoading(false);
      setUploadProgress(null);
      setLoadStage(null);
    } finally {
      e.target.value = "";
    }
  };

  const handleClear = () => {
    clearLoadedLayers();
    removeRasterOverlay();
    setShapeLayers([]);
    setSelectedLayerId("");
    setProjectKey("");
    setArrowAnnotations([]);
    setIsDrawingArrow(false);
    setDraftArrowPoints([]);
    draftArrowPointsRef.current = [];
    setLayerSearch("");
    setFeatureSearch("");
    setOpeningLayerId("");
    setUploadProgress(null);
    setLoadStage(null);
    setStatusText("");
  };

  const handleClearWithConfirmation = () => {
    if (!window.confirm("ล้างชั้นข้อมูลและลูกศรทั้งหมดออกจากหน้าจอหรือไม่?")) return;
    handleClear();
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
      locale: {
        "NavigationControl.ZoomIn": "ขยายแผนที่",
        "NavigationControl.ZoomOut": "ย่อแผนที่",
        "NavigationControl.ResetBearing": "หันแผนที่กลับทิศเหนือ",
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
    return () => {
      if (rasterUrlRef.current) URL.revokeObjectURL(rasterUrlRef.current);
      rasterUrlRef.current = "";
      map.remove();
    };
  }, [appendDraftPoint]);

  const selectedLayer = shapeLayers.find((layer) => layer.id === selectedLayerId);
  const filteredLayers = useMemo(() => {
    const search = layerSearch.trim().toLowerCase();
    if (!search) return shapeLayers;
    return shapeLayers.filter((layer) => layer.name.toLowerCase().includes(search));
  }, [layerSearch, shapeLayers]);
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

  const hasLoadedData = shapeLayers.length > 0 || Boolean(rasterOverlay);
  const rasterSourceLabel =
    rasterOverlay?.sourceType === "zip" && rasterOverlay.archiveName
      ? `นำเข้าจาก ZIP: ${rasterOverlay.archiveName}`
      : "อัปโหลดไฟล์ .tif/.tiff โดยตรง";
  const rasterOriginalSize = rasterOverlay
    ? `${rasterOverlay.sourceWidth.toLocaleString()} x ${rasterOverlay.sourceHeight.toLocaleString()} px`
    : "";
  const rasterPreviewSize = rasterOverlay
    ? `${rasterOverlay.previewWidth.toLocaleString()} x ${rasterOverlay.previewHeight.toLocaleString()} px`
    : "";

  return (
    <div style={pageStyle}>
      <button
        aria-label="กลับไปมุมมองรูปโลก"
        onClick={handleResetToGlobe}
        style={resetGlobeButtonStyle}
        title="กลับไปมุมมองรูปโลก"
      >
        🌎
      </button>

      <div className="left-stack" style={leftStackStyle}>
        <div
          className={`upload-panel ${hasLoadedData ? "has-data" : ""}`}
          style={{
            ...panelStyle,
            ...(activeTourStep?.target === "upload" ? tourHighlightStyle : null),
          }}
        >
          <input
            ref={shapefileInputRef}
            aria-hidden="true"
            tabIndex={-1}
            type="file"
            accept=".zip,.tif,.tiff,image/tiff"
            onChange={(e) => handleFileUpload(e, "shapefile")}
            disabled={isLoading}
            style={hiddenFileInputStyle}
          />
          <input
            ref={geojsonInputRef}
            aria-hidden="true"
            tabIndex={-1}
            type="file"
            accept=".geojson,.json,application/geo+json,application/json"
            onChange={(e) => handleFileUpload(e, "geojson")}
            disabled={isLoading}
            style={hiddenFileInputStyle}
          />
          <div style={modeSwitchStyle} role="tablist" aria-label="เลือกโหมดนำเข้าข้อมูล">
            <button
              type="button"
              role="tab"
              aria-selected={uploadMode === "file"}
              onClick={() => {
                setUploadMode("file");
                setStatusText("");
              }}
              disabled={isLoading}
              style={{
                ...modeSwitchButtonStyle,
                ...(uploadMode === "file" ? modeSwitchButtonActiveStyle : null),
              }}
            >
              Upload Shapefile
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={uploadMode === "backend"}
              onClick={() => {
                setUploadMode("backend");
                setStatusText("");
              }}
              disabled={isLoading}
              style={{
                ...modeSwitchButtonStyle,
                ...(uploadMode === "backend" ? modeSwitchButtonActiveStyle : null),
              }}
            >
              Backend GeoJSON
            </button>
          </div>
          {!hasLoadedData ? (
            <>
              {uploadMode === "file" ? (
                <>
                  <div style={emptyStateTitleStyle}>Upload Shapefile</div>
                  <div style={emptyStateBodyStyle}>
                    เลือกไฟล์ Shapefile แบบ ZIP หรือ GeoTIFF/COG เพื่อดูข้อมูลบนแผนที่
                  </div>
                  <button
                    className="ui-button"
                    onClick={() => shapefileInputRef.current?.click()}
                    disabled={isLoading}
                    style={{
                      ...primaryUploadButtonStyle,
                      cursor: isLoading ? "wait" : "pointer",
                      opacity: isLoading ? 0.72 : 1,
                    }}
                  >
                    {isLoading ? "กำลังอ่านไฟล์..." : "เลือกไฟล์แผนที่"}
                  </button>
                  <div style={uploadHintStyle}>
                    รองรับ .zip, .tif, .tiff และ ZIP ที่มี GeoTIFF ไฟล์ raster ใหญ่ควรอัป .tif ตรง
                  </div>
                </>
              ) : (
                <>
                  <div style={emptyStateTitleStyle}>GeoJSON structure backend</div>
                  <div style={emptyStateBodyStyle}>
                    หลังบ้านควรส่ง GeoJSON เป็น JSON response แล้ว frontend เรียก API ด้วย fetch
                    ก่อนส่ง features เข้า layer
                  </div>
                 
                  <button
                    className="ui-button"
                    onClick={() => geojsonInputRef.current?.click()}
                    disabled={isLoading}
                    style={{
                      ...primaryUploadButtonStyle,
                      backgroundColor: "#ef4444",
                      cursor: isLoading ? "wait" : "pointer",
                      opacity: isLoading ? 0.72 : 1,
                    }}
                  >
                    {isLoading ? "กำลังอ่านไฟล์..." : "เลือกไฟล์ GeoJSON"}
                  </button>
                  <div style={uploadHintStyle}>
                    พิกัดต้องเป็น GeoJSON มาตรฐาน [lng, lat]<br />
                    รองรับเฉพาะไฟล์ .geojson และ .json
                  </div>
                </>
              )}
            </>
          ) : (
            <div style={loadedFileHeaderStyle}>
              <div style={loadedFileInfoStyle}>
                <div style={loadedFileTitleStyle}>
                  {rasterOverlay ? "ภาพ GeoTIFF พร้อมใช้งาน" : "ชั้นข้อมูลพร้อมใช้งาน"}
                </div>
                <div style={loadedFileMetaStyle}>
                  {rasterOverlay
                    ? rasterOverlay.name
                    : `${shapeLayers.length.toLocaleString()} ชั้นข้อมูล`}
                </div>
                {rasterOverlay && (
                  <>
                    <div style={rasterBadgeGridStyle}>
                      <span style={rasterBadgeStyle}>ต้นฉบับ {rasterOriginalSize}</span>
                      <span style={rasterPreviewBadgeStyle}>ย่อเพื่อแสดงผล {rasterPreviewSize}</span>
                    </div>
                    <div style={rasterSourceStyle}>{rasterSourceLabel}</div>
                  </>
                )}
              </div>
              <div style={loadedActionGroupStyle}>
                <button
                  className="ui-button"
                  onClick={() => {
                    if (uploadMode === "backend") {
                      geojsonInputRef.current?.click();
                    } else {
                      shapefileInputRef.current?.click();
                    }
                  }}
                  disabled={isLoading}
                  style={secondaryButtonStyle}
                >
                  เปลี่ยนไฟล์
                </button>
              </div>
            </div>
          )}
          {uploadProgress !== null && (
            <div style={progressWrapStyle}>
              <div style={progressTrackStyle}>
                <div
                  style={{
                    ...progressBarStyle,
                    transform: `scaleX(${uploadProgress / 100})`,
                  }}
                />
              </div>
              <div style={progressTextStyle}>{uploadProgress}%</div>
            </div>
          )}
          {loadStage && (
            <div style={loadStageStyle}>
              ขั้นตอน {loadStage.current}/{loadStage.total}: {loadStage.label}
            </div>
          )}
          {statusText && (
            <div
              aria-live="polite"
              style={{
                ...statusStyle,
                color: statusText.includes("รองรับเฉพาะไฟล์") || statusText.includes("ไม่สำเร็จ") || statusText.includes("ไม่ถูกต้อง") ? "#ef4444" : statusStyle.color,
              }}
            >
              {statusText}
            </div>
          )}
          {shapeLayers.length > 0 && (
            <button className="text-button" onClick={() => setTourStep(0)} style={helpButtonStyle}>
              ดูวิธีใช้งาน
            </button>
          )}
        </div>

        {shapeLayers.length > 0 && (
          <div
            className={`layer-panel ${mobilePanel === "layers" ? "mobile-panel-active" : ""}`}
            style={{
              ...listContainerStyle,
              ...(activeTourStep?.target === "layers" ? tourHighlightStyle : null),
            }}
          >
            <div style={listHeaderStyle}>
              <div style={{ ...listTitleStyle, marginBottom: 0 }}>
                ชั้นข้อมูล ({shapeLayers.length})
              </div>
              <button
                className="compact-action"
                onClick={hideAllLayers}
                disabled={!shapeLayers.some((layer) => layer.visible)}
                style={compactButtonStyle}
              >
                ปิดทั้งหมด
              </button>
            </div>
            <label style={fieldLabelStyle} htmlFor="layer-search">
              ค้นหาชั้นข้อมูล{" "}
              <span className="shortcut-hint" style={shortcutHintStyle}>
                กด /
              </span>
            </label>
            <input
              ref={layerSearchRef}
              id="layer-search"
              value={layerSearch}
              onChange={(event) => setLayerSearch(event.target.value)}
              placeholder="พิมพ์ชื่อชั้นข้อมูล"
              style={featureSearchStyle}
            />
            <div className="layer-list scroll-region" style={layerListStyle}>
              {filteredLayers.map((layer) => (
                <div key={layer.id} style={layerRowStyle}>
                  <button
                    className="layer-toggle"
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
                    aria-label={`${layer.visible ? "ปิด" : "เปิด"}ชั้นข้อมูล ${layer.name}`}
                    title={layer.visible ? "ปิดชั้นข้อมูล" : "เปิดชั้นข้อมูล"}
                  >
                      {openingLayerId === layer.id ? "..." : layer.visible ? "เปิด" : "ปิด"}
                  </button>
                  <button
                    className={`layer-name ${selectedLayerId === layer.id ? "is-selected" : ""}`}
                    aria-pressed={selectedLayerId === layer.id}
                    onClick={() => {
                      setSelectedLayerId(layer.id);
                      setFeatureSearch("");
                      setMobilePanel("features");
                    }}
                    style={{
                      ...layerNameButtonStyle,
                      borderColor: selectedLayerId === layer.id ? "#67e8f9" : "transparent",
                    }}
                  >
                    <span style={{ color: layer.color }}>{layer.name}</span>
                    <small style={layerMetaStyle}>
                      {layer.count.toLocaleString()} รายการ |{" "}
                      {layer.geometryTypes.map((type) => GEOMETRY_LABELS[type] || type).join(", ")}
                    </small>
                  </button>
                </div>
              ))}
            </div>
            {filteredLayers.length === 0 && (
              <div style={featureHintStyle}>ไม่พบชั้นข้อมูลที่ค้นหา</div>
            )}
            <button
              className="ui-button danger-button"
              onClick={handleClearWithConfirmation}
              style={clearButtonStyle}
            >
              ล้างข้อมูล
            </button>
          </div>
        )}
      </div>

      {selectedLayer && (
        <div
          className={`feature-panel ${mobilePanel === "features" ? "mobile-panel-active" : ""}`}
          style={{
            ...featurePanelStyle,
            ...(activeTourStep?.target === "features" ? tourHighlightStyle : null),
          }}
        >
          <div style={listTitleStyle}>รายการข้อมูล</div>
          <div style={selectedLayerNameStyle}>
            <span style={{ color: selectedLayer.color }}>{selectedLayer.name}</span>
            <small>{selectedLayer.count.toLocaleString()} รายการ</small>
          </div>
          <label style={fieldLabelStyle} htmlFor="feature-search">
            ค้นหารายการ
          </label>
          <input
            id="feature-search"
            value={featureSearch}
            onChange={(event) => setFeatureSearch(event.target.value)}
            placeholder="ค้นหาชื่อ / id"
            style={featureSearchStyle}
          />
          {selectedLayer.detailLimited && (
            <div style={featureHintStyle}>
              ชั้นข้อมูลขนาดใหญ่มาก ระบบรวมรูปทรงเป็นชุดเพื่อลดการใช้หน่วยความจำ
            </div>
          )}
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
          <div className="feature-list scroll-region" style={featureListStyle}>
            {selectedFeatureItems.map(({ feature, index, name }) => (
              <button
                className="feature-item"
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

      {shapeLayers.length > 0 && (
        <nav className="mobile-panel-switcher" aria-label="เลือกแผงข้อมูล">
          <button
            className="mobile-tab"
            aria-pressed={mobilePanel === "layers"}
            onClick={() => setMobilePanel("layers")}
          >
            ชั้นข้อมูล
          </button>
          <button
            className="mobile-tab"
            aria-pressed={mobilePanel === "features"}
            onClick={() => setMobilePanel("features")}
          >
            รายการข้อมูล
          </button>
        </nav>
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
  bottom: 10,
  left: 10,
  zIndex: 10,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  width: 340,
  maxWidth: "calc(100vw - 20px)",
  minHeight: 0,
};

const panelStyle: React.CSSProperties = {
  background: "#fff",
  padding: 16,
  borderRadius: 8,
  width: "100%",
  boxSizing: "border-box",
  boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
  fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
};

const hiddenFileInputStyle: React.CSSProperties = {
  display: "none",
};

const emptyStateTitleStyle: React.CSSProperties = {
  color: "#0f172a",
  fontSize: 18,
  fontWeight: 800,
  lineHeight: 1.3,
};

const emptyStateBodyStyle: React.CSSProperties = {
  marginTop: 6,
  color: "#475569",
  fontSize: 13,
  lineHeight: 1.55,
};

const primaryUploadButtonStyle: React.CSSProperties = {
  width: "100%",
  minHeight: 44,
  marginTop: 14,
  padding: "10px 14px",
  color: "#fff",
  backgroundColor: "#0f766e",
  border: "none",
  borderRadius: 7,
  fontSize: 14,
  fontWeight: 750,
};

const uploadHintStyle: React.CSSProperties = {
  marginTop: 8,
  color: "#64748b",
  fontSize: 11,
  lineHeight: 1.45,
};

const modeSwitchStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 4,
  padding: 4,
  marginBottom: 14,
  background: "#e2e8f0",
  borderRadius: 7,
};

const modeSwitchButtonStyle: React.CSSProperties = {
  minHeight: 36,
  padding: "7px 8px",
  color: "#475569",
  background: "transparent",
  border: "none",
  borderRadius: 5,
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 800,
};

const modeSwitchButtonActiveStyle: React.CSSProperties = {
  color: "#2563eb",
  background: "#ffffff",
  boxShadow: "0 1px 3px rgba(37, 99, 235, 0.2)",
};



const helpButtonStyle: React.CSSProperties = {
  marginTop: 10,
  padding: 0,
  color: "#0f766e",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 700,
};

const loadedFileHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 12,
};

const loadedActionGroupStyle: React.CSSProperties = {
  display: "flex",
  flex: "0 0 auto",
  flexDirection: "column",
  gap: 8,
};

const loadedFileInfoStyle: React.CSSProperties = {
  minWidth: 0,
  flex: "1 1 auto",
};

const loadedFileTitleStyle: React.CSSProperties = {
  color: "#0f172a",
  fontSize: 14,
  fontWeight: 800,
  lineHeight: 1.3,
};

const loadedFileMetaStyle: React.CSSProperties = {
  marginTop: 3,
  color: "#64748b",
  fontSize: 12,
  lineHeight: 1.35,
  overflowWrap: "anywhere",
};

const rasterBadgeGridStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  marginTop: 8,
};

const rasterBadgeStyle: React.CSSProperties = {
  padding: "4px 7px",
  color: "#0f172a",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 11,
  fontWeight: 750,
  lineHeight: 1.2,
  whiteSpace: "nowrap",
};

const rasterPreviewBadgeStyle: React.CSSProperties = {
  ...rasterBadgeStyle,
  color: "#075985",
  background: "#e0f2fe",
  border: "1px solid #bae6fd",
};

const rasterSourceStyle: React.CSSProperties = {
  marginTop: 7,
  color: "#475569",
  fontSize: 11,
  lineHeight: 1.35,
  overflowWrap: "anywhere",
};

const secondaryButtonStyle: React.CSSProperties = {
  flex: "0 0 auto",
  minHeight: 40,
  minWidth: 78,
  padding: "7px 11px",
  color: "#0f172a",
  background: "#e2e8f0",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 700,
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
  transformOrigin: "left center",
  transition: "transform 160ms ease-out",
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

const listContainerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: "1 1 auto",
  minHeight: 0,
  overflow: "hidden",
  background: "rgba(8, 15, 28, 0.97)",
  color: "#fff",
  padding: 12,
  borderRadius: 8,
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid #475569",
  boxShadow: "0 4px 8px rgba(0,0,0,0.42)",
};

const listTitleStyle: React.CSSProperties = {
  margin: "0 0 10px",
  color: "#67e8f9",
  fontSize: 14,
  fontWeight: 700,
};

const loadStageStyle: React.CSSProperties = {
  marginTop: 5,
  color: "#334155",
  fontSize: 11,
  fontWeight: 700,
};

const listHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  marginBottom: 10,
};

const compactButtonStyle: React.CSSProperties = {
  minHeight: 32,
  padding: "5px 8px",
  color: "#cbd5e1",
  background: "#1e293b",
  border: "none",
  borderRadius: 5,
  cursor: "pointer",
  fontSize: 11,
  fontWeight: 700,
};

const shortcutHintStyle: React.CSSProperties = {
  color: "#94a3b8",
  fontWeight: 500,
};

const layerListStyle: React.CSSProperties = {
  flex: "1 1 auto",
  minHeight: 0,
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
  minHeight: 44,
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
  minHeight: 44,
  fontSize: 12,
  color: "#fff",
};

const layerMetaStyle: React.CSSProperties = {
  color: "#94a3b8",
  fontSize: 11,
  lineHeight: 1.2,
};

const featurePanelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  position: "absolute",
  top: 10,
  right: 10,
  zIndex: 10,
  width: 320,
  maxHeight: "52vh",
  padding: 12,
  background: "rgba(8, 15, 28, 0.97)",
  border: "1px solid #475569",
  borderRadius: 8,
  color: "#fff",
  boxShadow: "0 4px 8px rgba(0,0,0,0.42)",
};

const selectedLayerNameStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  marginBottom: 8,
  color: "#94a3b8",
  fontSize: 12,
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
  fontSize: 13,
};

const fieldLabelStyle: React.CSSProperties = {
  display: "block",
  marginBottom: 5,
  color: "#cbd5e1",
  fontSize: 12,
  fontWeight: 700,
};

const featureHintStyle: React.CSSProperties = {
  marginBottom: 8,
  color: "#94a3b8",
  fontSize: 12,
  lineHeight: 1.35,
};

const featureListStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: "1 1 auto",
  minHeight: 0,
  gap: 6,
  overflowY: "auto",
};

const featureButtonStyle: React.CSSProperties = {
  minHeight: 44,
  padding: "7px 8px",
  background: "#111827",
  color: "#e5e7eb",
  border: "1px solid #263244",
  borderRadius: 6,
  cursor: "pointer",
  textAlign: "left",
  fontSize: 13,
};

const resetGlobeButtonStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 110,
  right: 10,
  zIndex: 15,
  width: 44,
  height: 44,
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

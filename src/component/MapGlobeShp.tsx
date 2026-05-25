/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import shp from "shpjs";

import "maplibre-gl/dist/maplibre-gl.css";

const AUTO_ZOOM_FEATURE_LIMIT = 5000;
const LARGE_SEARCH_FEATURE_LIMIT = 50000;
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

const MapGlobeShp = () => {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupLayerIdsRef = useRef<Set<string>>(new Set());

  const [shapeLayers, setShapeLayers] = useState<ShapeLayer[]>([]);
  const [selectedLayerId, setSelectedLayerId] = useState<string>("");
  const [featureSearch, setFeatureSearch] = useState("");
  const [openingLayerId, setOpeningLayerId] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [statusText, setStatusText] = useState("");
  const [tourStep, setTourStep] = useState<number | null>(null);

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

  const clearLoadedLayers = () => {
    shapeLayers.forEach(removeLayerFromMap);
    popupLayerIdsRef.current.clear();
  };

  const registerPopup = (layerId: string) => {
    const map = mapRef.current;
    if (!map || popupLayerIdsRef.current.has(layerId)) return;

    popupLayerIdsRef.current.add(layerId);
    map.on("click", layerId, (e) => {
      if (!e.features || e.features.length === 0) return;
      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(buildPopupHtml(e.features[0].properties))
        .addTo(map);
    });

    map.on("mouseenter", layerId, () => {
      map.getCanvas().style.cursor = "pointer";
    });

    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
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

  const loadShapeBuffer = async (buffer: ArrayBuffer, label: string) => {
    if (!mapRef.current) return;

    setIsLoading(true);
    setUploadProgress(100);
    setStatusText(`กำลังแปลงไฟล์ ${label}...`);
    await waitForPaint();

    try {
      clearLoadedLayers();
      const result: any = await shp(buffer);
      const collections = Array.isArray(result) ? result : [result];

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
      setFeatureSearch("");
      setStatusText(`อ่านไฟล์แล้ว ${nextLayers.length} layer - ปิดไว้ทั้งหมด`);
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
    setIsLoading(true);
    setUploadProgress(0);
    try {
      await loadShapeBuffer(await readZipFile(file), file.name);
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

      map.on("zoom", () => {
        if (map.getZoom() > 17) map.setZoom(17);
      });
    });

    mapRef.current = map;
    return () => map.remove();
  }, []);

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

import { iter, type ZipItem } from "but-unzip";
import { combine, parseDbf, parseShp } from "shpjs";

const FEATURE_CHUNK_SIZE = 5000;
const COMPACT_LAYER_THRESHOLD = 100000;
const MAX_COMPACTED_RECORDS = 50000;
const LARGE_SHP_BYTES = 64 * 1024 * 1024;
const MAX_HEAVY_LAYER_RECORDS = 1000;
const LARGE_LAYER_CHUNK_BYTES = 1024 * 1024;
const NORMAL_LAYER_CHUNK_BYTES = 16 * 1024 * 1024;

interface ParseRequest {
  buffer: ArrayBuffer;
}

const getUncompressedZipSize = (buffer: ArrayBuffer) => {
  const view = new DataView(buffer);
  let total = 0;

  for (let offset = 0; offset <= view.byteLength - 46; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    total += view.getUint32(offset + 24, true);

    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    offset += 45 + fileNameLength + extraLength + commentLength;
  }

  return total;
};

const readEntry = async (entry?: ZipItem) => (entry ? await entry.read() : undefined);
const toArrayBuffer = (bytes: Uint8Array) => new Uint8Array(bytes).buffer;

const getShpRecordRanges = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ranges: Array<{ offset: number; length: number }> = [];
  let offset = 100;

  while (offset + 8 <= bytes.byteLength) {
    const contentLength = view.getUint32(offset + 4, false) * 2;
    const length = 8 + contentLength;
    if (length <= 8 || offset + length > bytes.byteLength) break;
    ranges.push({ offset, length });
    offset += length;
  }

  return ranges;
};

const getChunkEnd = (
  ranges: Array<{ offset: number; length: number }>,
  start: number,
  compactLayer: boolean,
) => {
  const maxRecords = compactLayer ? 1000 : FEATURE_CHUNK_SIZE;
  const maxBytes = compactLayer ? LARGE_LAYER_CHUNK_BYTES : NORMAL_LAYER_CHUNK_BYTES;
  let totalBytes = 0;
  let end = start;

  while (end < ranges.length && end - start < maxRecords) {
    const nextBytes = totalBytes + ranges[end].length;
    if (end > start && nextBytes > maxBytes) break;
    totalBytes = nextBytes;
    end += 1;
  }

  return end;
};

const buildShpChunk = (
  source: Uint8Array,
  ranges: Array<{ offset: number; length: number }>,
  start: number,
  end: number,
) => {
  const bodyLength = ranges
    .slice(start, end)
    .reduce((total, range) => total + range.length, 0);
  const chunk = new Uint8Array(100 + bodyLength);
  chunk.set(source.subarray(0, 100));

  let targetOffset = 100;
  for (let index = start; index < end; index += 1) {
    const range = ranges[index];
    chunk.set(source.subarray(range.offset, range.offset + range.length), targetOffset);
    targetOffset += range.length;
  }

  new DataView(chunk.buffer).setUint32(24, chunk.byteLength / 2, false);
  return chunk.buffer;
};

const buildDbfChunk = (source: Uint8Array, start: number, end: number) => {
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const headerLength = view.getUint16(8, true);
  const recordLength = view.getUint16(10, true);
  const recordCount = end - start;
  const chunk = new Uint8Array(headerLength + recordCount * recordLength + 1);

  chunk.set(source.subarray(0, headerLength));
  new DataView(chunk.buffer).setUint32(4, recordCount, true);
  chunk.set(
    source.subarray(
      headerLength + start * recordLength,
      headerLength + end * recordLength,
    ),
    headerLength,
  );
  chunk[chunk.length - 1] = 0x1a;
  return chunk.buffer;
};

const compactFeatures = (features: GeoJSON.Feature[], batchNumber: number): GeoJSON.Feature[] => {
  const points: GeoJSON.Position[] = [];
  const lines: GeoJSON.Position[][] = [];
  const polygons: GeoJSON.Position[][][] = [];

  features.forEach((feature) => {
    const geometry = feature.geometry;
    if (!geometry) return;
    if (geometry.type === "Point") points.push(geometry.coordinates);
    if (geometry.type === "MultiPoint") points.push(...geometry.coordinates);
    if (geometry.type === "LineString") lines.push(geometry.coordinates);
    if (geometry.type === "MultiLineString") lines.push(...geometry.coordinates);
    if (geometry.type === "Polygon") polygons.push(geometry.coordinates);
    if (geometry.type === "MultiPolygon") polygons.push(...geometry.coordinates);
  });

  const compacted: GeoJSON.Feature[] = [];
  const properties = { name: `ชุดข้อมูล ${batchNumber}`, compacted: true };
  if (points.length) {
    compacted.push({
      type: "Feature",
      properties,
      geometry: { type: "MultiPoint", coordinates: points },
    });
  }
  if (lines.length) {
    compacted.push({
      type: "Feature",
      properties,
      geometry: { type: "MultiLineString", coordinates: lines },
    });
  }
  if (polygons.length) {
    compacted.push({
      type: "Feature",
      properties,
      geometry: { type: "MultiPolygon", coordinates: polygons },
    });
  }
  return compacted;
};

self.onmessage = async (event: MessageEvent<ParseRequest>) => {
  try {
    const uncompressedBytes = getUncompressedZipSize(event.data.buffer);
    const entries = Array.from(iter(new Uint8Array(event.data.buffer))).filter(
      (entry) => !entry.filename.includes("__MACOSX"),
    );
    const entryByName = new Map(entries.map((entry) => [entry.filename.toLowerCase(), entry]));
    const shapeEntries = entries.filter((entry) => entry.filename.toLowerCase().endsWith(".shp"));

    if (!shapeEntries.length) throw new Error("ไม่พบไฟล์ .shp ภายใน ZIP");

    self.postMessage({ type: "start", total: shapeEntries.length, uncompressedBytes });

    for (let index = 0; index < shapeEntries.length; index += 1) {
      const shapeEntry = shapeEntries[index];
      const baseName = shapeEntry.filename.slice(0, -4);
      const lookupBase = baseName.toLowerCase();

      self.postMessage({
        type: "progress",
        current: index + 1,
        total: shapeEntries.length,
        message: `กำลังแปลงชั้นข้อมูล ${index + 1}/${shapeEntries.length}: ${baseName}`,
      });

      const shpBytes = await shapeEntry.read();
      const dbfBytes = await readEntry(entryByName.get(`${lookupBase}.dbf`));
      const cpgBytes = await readEntry(entryByName.get(`${lookupBase}.cpg`));
      const prjBytes = await readEntry(entryByName.get(`${lookupBase}.prj`));
      const prjText = prjBytes ? new TextDecoder().decode(prjBytes) : undefined;
      const recordRanges = getShpRecordRanges(shpBytes);
      const geometryTypes = new Set<string>();
      const heavyBySize = shpBytes.byteLength > LARGE_SHP_BYTES;
      const compactLayer = recordRanges.length > COMPACT_LAYER_THRESHOLD || heavyBySize;
      const retainedRecordTarget = heavyBySize ? MAX_HEAVY_LAYER_RECORDS : MAX_COMPACTED_RECORDS;
      const sampleStride = compactLayer
        ? Math.ceil(recordRanges.length / retainedRecordTarget)
        : 1;

      self.postMessage({
        type: "layer-start",
        current: index + 1,
        total: shapeEntries.length,
        fileName: baseName,
        featureCount: recordRanges.length,
        detailLimited: compactLayer,
      });

      let batchNumber = 0;
      for (let start = 0; start < recordRanges.length; ) {
        const end = getChunkEnd(recordRanges, start, compactLayer);
        batchNumber += 1;
        const geometries = parseShp(
          buildShpChunk(shpBytes, recordRanges, start, end),
          prjText as never,
        );
        const properties = dbfBytes
          ? parseDbf(
              buildDbfChunk(dbfBytes, start, end),
              toArrayBuffer(cpgBytes || new Uint8Array()),
            )
          : [];
        const parsedFeatures = combine([geometries, properties]).features;
        const sampledFeatures =
          sampleStride > 1
            ? parsedFeatures.filter((_, localIndex) => (start + localIndex) % sampleStride === 0)
            : parsedFeatures;
        const features = compactLayer
          ? compactFeatures(sampledFeatures, batchNumber)
          : parsedFeatures;

        parsedFeatures.forEach((feature) => {
          if (feature.geometry?.type) geometryTypes.add(feature.geometry.type);
        });

        self.postMessage({
          type: "feature-chunk",
          current: index + 1,
          total: shapeEntries.length,
          loadedFeatures: end,
          featureCount: recordRanges.length,
          features,
        });

        geometries.length = 0;
        properties.length = 0;
        sampledFeatures.length = 0;
        parsedFeatures.length = 0;
        features.length = 0;
        await new Promise((resolve) => setTimeout(resolve, 0));
        start = end;
      }

      self.postMessage({
        type: "layer-complete",
        current: index + 1,
        total: shapeEntries.length,
        geometryTypes: Array.from(geometryTypes),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    self.postMessage({ type: "complete" });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "แปลงไฟล์ไม่สำเร็จ",
    });
  }
};

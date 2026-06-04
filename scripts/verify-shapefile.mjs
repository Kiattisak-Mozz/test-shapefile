import fs from "node:fs/promises";
import { iter } from "but-unzip";
import { combine, parseDbf, parseShp } from "shpjs";

const CHUNK_SIZE = 5000;
const COMPACT_THRESHOLD = 100000;
const MAX_COMPACTED_RECORDS = 50000;
const LARGE_SHP_BYTES = 64 * 1024 * 1024;
const MAX_HEAVY_LAYER_RECORDS = 1000;
const LARGE_CHUNK_BYTES = 1024 * 1024;
const NORMAL_CHUNK_BYTES = 16 * 1024 * 1024;
const zipPath = process.argv[2];
const raw = await fs.readFile(zipPath);
const entries = Array.from(iter(raw)).filter((entry) => !entry.filename.includes("__MACOSX"));
const entryByName = new Map(entries.map((entry) => [entry.filename.toLowerCase(), entry]));
const shapeEntries = entries.filter((entry) => entry.filename.toLowerCase().endsWith(".shp"));
const retainedLayers = [];

const getRanges = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ranges = [];
  let offset = 100;
  while (offset + 8 <= bytes.byteLength) {
    const length = 8 + view.getUint32(offset + 4, false) * 2;
    if (length <= 8 || offset + length > bytes.byteLength) break;
    ranges.push({ offset, length });
    offset += length;
  }
  return ranges;
};

const buildShpChunk = (source, ranges, start, end) => {
  const bodyLength = ranges.slice(start, end).reduce((sum, item) => sum + item.length, 0);
  const chunk = new Uint8Array(100 + bodyLength);
  chunk.set(source.subarray(0, 100));
  let offset = 100;
  for (let index = start; index < end; index += 1) {
    const range = ranges[index];
    chunk.set(source.subarray(range.offset, range.offset + range.length), offset);
    offset += range.length;
  }
  new DataView(chunk.buffer).setUint32(24, chunk.byteLength / 2, false);
  return chunk.buffer;
};

const getChunkEnd = (ranges, start, compactLayer) => {
  const maxRecords = compactLayer ? 1000 : CHUNK_SIZE;
  const maxBytes = compactLayer ? LARGE_CHUNK_BYTES : NORMAL_CHUNK_BYTES;
  let bytes = 0;
  let end = start;
  while (end < ranges.length && end - start < maxRecords) {
    const nextBytes = bytes + ranges[end].length;
    if (end > start && nextBytes > maxBytes) break;
    bytes = nextBytes;
    end += 1;
  }
  return end;
};

const buildDbfChunk = (source, start, end) => {
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const headerLength = view.getUint16(8, true);
  const recordLength = view.getUint16(10, true);
  const chunk = new Uint8Array(headerLength + (end - start) * recordLength + 1);
  chunk.set(source.subarray(0, headerLength));
  new DataView(chunk.buffer).setUint32(4, end - start, true);
  chunk.set(
    source.subarray(headerLength + start * recordLength, headerLength + end * recordLength),
    headerLength,
  );
  chunk[chunk.length - 1] = 0x1a;
  return chunk.buffer;
};

const compactFeatures = (features) => {
  const points = [];
  const lines = [];
  const polygons = [];
  for (const feature of features) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    if (geometry.type === "Point") points.push(geometry.coordinates);
    if (geometry.type === "MultiPoint") points.push(...geometry.coordinates);
    if (geometry.type === "LineString") lines.push(geometry.coordinates);
    if (geometry.type === "MultiLineString") lines.push(...geometry.coordinates);
    if (geometry.type === "Polygon") polygons.push(geometry.coordinates);
    if (geometry.type === "MultiPolygon") polygons.push(...geometry.coordinates);
  }
  return [
    ...(points.length ? [{ type: "Feature", properties: {}, geometry: { type: "MultiPoint", coordinates: points } }] : []),
    ...(lines.length ? [{ type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: lines } }] : []),
    ...(polygons.length ? [{ type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: polygons } }] : []),
  ];
};

console.log(`Found ${shapeEntries.length} layers`);

for (let index = 0; index < shapeEntries.length; index += 1) {
  const shapeEntry = shapeEntries[index];
  const baseName = shapeEntry.filename.slice(0, -4);
  const lookupBase = baseName.toLowerCase();
  const shpBytes = await shapeEntry.read();
  const dbfBytes = await entryByName.get(`${lookupBase}.dbf`)?.read();
  const cpgBytes = await entryByName.get(`${lookupBase}.cpg`)?.read();
  const prjBytes = await entryByName.get(`${lookupBase}.prj`)?.read();
  const prjText = prjBytes ? new TextDecoder().decode(prjBytes) : undefined;
  const ranges = getRanges(shpBytes);
  const retainedFeatures = [];
  const heavyBySize = shpBytes.byteLength > LARGE_SHP_BYTES;
  const compactLayer = ranges.length > COMPACT_THRESHOLD || heavyBySize;
  const retainedTarget = heavyBySize ? MAX_HEAVY_LAYER_RECORDS : MAX_COMPACTED_RECORDS;
  const sampleStride = compactLayer ? Math.ceil(ranges.length / retainedTarget) : 1;
  console.log(
    `Preparing ${index + 1}/${shapeEntries.length}: ${ranges.length} records, ${Math.ceil(shpBytes.byteLength / 1024 / 1024)} MB SHP`,
  );

  for (let start = 0; start < ranges.length; ) {
    const end = getChunkEnd(ranges, start, compactLayer);
    const geometries = parseShp(buildShpChunk(shpBytes, ranges, start, end), prjText);
    const properties = dbfBytes
      ? parseDbf(
          buildDbfChunk(dbfBytes, start, end),
          new Uint8Array(cpgBytes || new Uint8Array()).buffer,
        )
      : [];
    const features = combine([geometries, properties]).features;
    const sampled =
      sampleStride > 1
        ? features.filter((_, localIndex) => (start + localIndex) % sampleStride === 0)
        : features;
    retainedFeatures.push(...(compactLayer ? compactFeatures(sampled) : features));
    start = end;
  }

  retainedLayers.push(retainedFeatures);
  console.log(`${index + 1}/${shapeEntries.length} ${baseName}: ${retainedFeatures.length}`);
}

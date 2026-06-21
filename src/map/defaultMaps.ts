import riseOfMongolia1206 from "../assets/defaultMaps/riseOfMongolia1206.json";
import type { EditableMapData } from "../types";

export function createBuiltInDefaultEditableMap(): EditableMapData {
  return JSON.parse(JSON.stringify(riseOfMongolia1206)) as EditableMapData;
}

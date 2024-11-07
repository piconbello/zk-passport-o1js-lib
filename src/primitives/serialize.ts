import { NestedProvable } from "./nested.ts";
import { ProvableType } from "./o1js-missing.ts";
import {
  Bool,
  Bytes,
  DynamicProof,
  Field,
  PublicKey,
  Signature,
  Struct,
  UInt32,
  UInt64,
  UInt8,
  Undefined,
  VerificationKey,
} from "o1js";
import { assert } from "./util.ts";
import { ProvableFactory, type SerializedFactory } from "./provable-factory.ts";

export {
  type O1jsTypeName,
  type SerializedType,
  type SerializedValue,
  serializeNestedProvable,
  serializeNestedProvableValue,
  serializeProvable,
  serializeProvableType,
  supportedTypes,
  validateSpecHash,
};

// Supported o1js base types
const supportedTypes = {
  Field,
  Bool,
  UInt8,
  UInt32,
  UInt64,
  PublicKey,
  Signature,
  Undefined,
  VerificationKey,
};
type O1jsTypeName = keyof typeof supportedTypes;

let mapProvableTypeToName = new Map<ProvableType<any>, O1jsTypeName>();
for (let [key, value] of Object.entries(supportedTypes)) {
  mapProvableTypeToName.set(value, key as O1jsTypeName);
}

type SerializedType =
  | { _type: O1jsTypeName }
  | { _type: "Struct"; properties: SerializedNestedType }
  | { _type: "Array"; inner: SerializedType; size: number }
  | { _type: "Constant"; value: unknown }
  | { _type: "Bytes"; size: number }
  | { _type: "Proof"; proof: Record<string, any> }
  | { _type: "String" }
  | SerializedFactory;

type SerializedNestedType =
  | SerializedType
  | { [key: string]: SerializedNestedType };

function serializeProvableType(type: ProvableType<any>): SerializedType {
  let serialized = ProvableFactory.tryToJSON(type);
  if (serialized !== undefined) return serialized;

  if ("serialize" in type && typeof type.serialize === "function") {
    return type.serialize();
  }
  if ((type as any).prototype instanceof Bytes.Base) {
    return { _type: "Bytes", size: (type as typeof Bytes.Base).size };
  }
  if ((type as any).prototype instanceof DynamicProof) {
    let { publicInputType, publicOutputType, maxProofsVerified, featureFlags } =
      type as typeof DynamicProof;
    let proof = {
      name: (type as typeof DynamicProof).name,
      publicInput: serializeProvableType(publicInputType),
      publicOutput: serializeProvableType(publicOutputType),
      maxProofsVerified,
      featureFlags: replaceUndefined(featureFlags),
    };
    return { _type: "Proof", proof };
  }
  let _type = mapProvableTypeToName.get(type);
  if (_type === undefined && (type as any)._isStruct) {
    return serializeStruct(type as Struct<any>);
  }
  if (_type === undefined && (type as any)._isArray) {
    return {
      _type: "Array",
      inner: serializeProvableType((type as any).innerType),
      size: (type as any).size,
    };
  }
  assert(
    _type !== undefined,
    `serializeProvableType: Unsupported provable type: ${type}`,
  );
  return { _type };
}

type SerializedValue = { _type: string; properties?: any; value: any };

function serializeProvable(value: any): SerializedValue {
  let serialized = ProvableFactory.tryValueToJSON(value);
  if (serialized !== undefined) return serialized;

  let typeClass = ProvableType.fromValue(value);
  let { _type } = serializeProvableType(typeClass);
  if (_type === "Bytes") {
    return { _type, value: (value as Bytes).toHex() };
  }
  if (_type === "Array") {
    return { _type, value: value.map((x: any) => serializeProvable(x)) };
  }
  if (_type === "Struct") {
    let structType = serializeStruct(typeClass as Struct<any>);
    return { ...structType, value: (typeClass as Struct<any>).toJSON(value) };
  }
  switch (typeClass) {
    case Bool: {
      return { _type, value: value.toJSON().toString() };
    }
    case UInt8: {
      return { _type, value: (value as UInt8).toString() };
    }
    default: {
      return { _type, value: value.toJSON() };
    }
  }
}

function serializeStruct(type: Struct<any>): SerializedType {
  let value = type.empty();
  let properties: SerializedNestedType = {};

  for (let key in value) {
    let type = NestedProvable.fromValue(value[key]);
    properties[key] = serializeNestedProvable(type);
  }
  return { _type: "Struct", properties };
}

function serializeNestedProvable(type: NestedProvable): SerializedNestedType {
  if (ProvableType.isProvableType(type)) {
    return serializeProvableType(type);
  }

  if (typeof type === "string" || (type as any) === String) {
    return { _type: "String" };
  }

  if (typeof type === "object" && type !== null) {
    const serializedObject: Record<string, any> = {};
    for (const key of Object.keys(type)) {
      serializedObject[key] = serializeNestedProvable(type[key]!);
    }
    return serializedObject;
  }

  throw Error(`Unsupported type in NestedProvable: ${type}`);
}

function serializeNestedProvableValue(value: any): any {
  let type = NestedProvable.fromValue(value);
  return serializeNestedProvableTypeAndValue({ type, value });
}

function serializeNestedProvableTypeAndValue(t: {
  type: NestedProvable;
  value: any;
}): any {
  if (ProvableType.isProvableType(t.type)) {
    return serializeProvable(t.value);
  }
  if (typeof t.type === "string" || (t.type as any) === String) return t.value;

  return Object.fromEntries(
    Object.keys(t.type).map((key) => {
      assert(key in t.value, `Missing value for key ${key}`);
      return [
        key,
        serializeNestedProvableTypeAndValue({
          type: (t.type as any)[key],
          value: t.value[key],
        }),
      ];
    }),
  );
}

// `null` is preserved in JSON, but `undefined` is removed
function replaceUndefined(obj: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    Object.entries(obj).map(([key, value]) => [
      key,
      value === undefined ? null : value,
    ]),
  );
}

async function hashSpec(serializedSpec: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(serializedSpec);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function validateSpecHash(
  serializedSpecWithHash: string,
): Promise<boolean> {
  const { spec, hash } = JSON.parse(serializedSpecWithHash);
  const recomputedHash = await hashSpec(spec);
  return hash === recomputedHash;
}

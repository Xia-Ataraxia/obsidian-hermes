import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_CONTRACT_MAX_BYTES, parseNativeContracts } from "../src/domain/native-contracts";

const capture = readFileSync(new URL("./fixtures/hermes-contracts.json", import.meta.url), "utf8");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected object");
  return value;
}

function changed(edit: (value: Record<string, unknown>) => void): string {
  const parsed: unknown = JSON.parse(capture);
  const value = object(parsed);
  edit(value);
  return JSON.stringify(value);
}

function unreachable(value: never): never {
  throw new Error(`Unexpected test variant: ${String(value)}`);
}

describe("sanitized native contract boundary", () => {
  test("accepts the pinned source capture and exposes immutable capabilities", () => {
    // Given
    const input = capture;
    // When
    const result = parseNativeContracts(input);
    // Then
    expect(result.status).toBe("supported");
    if (result.status !== "supported") throw new Error(result.reason);
    expect(Object.isFrozen(result.value.capabilities)).toBe(true);
    expect(result.value.capabilities.find((r) => r.method === "POST" && r.path.endsWith("/dispatch"))?.disposition).toBe("excluded");
    expect(result.value.capabilities.find((r) => r.method === "PATCH" && r.path.endsWith("/tasks/{task_id}"))?.allowedBodyFields).not.toContain("tenant");
  });

  test("binds every captured hash and native route to the actual M1 source bytes", () => {
    // Given
    const sourceRoot = process.env["HERMES_CONTRACT_SOURCE"];
    if (!sourceRoot) throw new Error("HERMES_CONTRACT_SOURCE must name the verified M1 capture source");
    // When
    const result = parseNativeContracts(capture);
    // Then
    if (result.status !== "supported") throw new Error(result.reason);
    for (const source of result.value.sources) {
      const bytes = readFileSync(join(sourceRoot, source.path));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(source.sha256);
    }
    const router = readFileSync(join(sourceRoot, "plugins/kanban/dashboard/plugin_api.py"), "utf8");
    for (const route of result.value.capabilities) {
      const suffix = route.path.slice("/api/plugins/kanban".length);
      expect(router.includes(`@router.${route.method.toLowerCase()}("${suffix}")`)).toBe(true);
    }
  });

  test.each(["identity", "workflow", "sources", "routes"])("rejects missing %s instead of inferring compatibility", (key) => {
    // Given
    const input = changed((value) => { delete value[key]; });
    // When
    const result = parseNativeContracts(input);
    // Then
    expect(result.status).toBe("unsupported-version");
  });

  test.each(["missing", "gated", "header", "ws", "optional-token"] as const)("requires supported auth when %s changes", (variant) => {
    // Given
    const input = changed((value) => {
      const auth = object(value["auth"]);
      switch (variant) {
        case "missing": delete value["auth"]; break;
        case "gated": auth["authRequired"] = true; break;
        case "header": auth["httpHeader"] = "Authorization"; break;
        case "ws": auth["websocketQuery"] = "ticket"; break;
        case "optional-token": auth["requiredEvenWhenAuthRequiredFalse"] = false; break;
        default: unreachable(variant);
      }
    });
    // When
    const result = parseNativeContracts(input);
    // Then
    expect(result.status).toBe("authentication-required");
  });

  test.each(["workflow", "source", "route", "version", "schema-definition", "extra-field"] as const)("fails closed when %s differs", (variant) => {
    // Given
    const input = changed((value) => {
      switch (variant) {
        case "workflow": object(value["workflow"])["manual"] = { todo: ["running"] }; break;
        case "source": {
          const sources = value["sources"];
          if (!Array.isArray(sources)) throw new Error("Expected sources");
          object(sources[0])["sha256"] = "0".repeat(64);
          break;
        }
        case "route": {
          const routes = value["routes"];
          if (!Array.isArray(routes)) throw new Error("Expected routes");
          object(routes[0])["path"] = "/api/plugins/kanban/unknown";
          break;
        }
        case "version": object(value["identity"])["version"] = "0.22.4"; break;
        case "schema-definition": value["entitySchemas"] = {}; break;
        case "extra-field": value["unknownCapability"] = true; break;
        default: unreachable(variant);
      }
    });
    // When
    const result = parseNativeContracts(input);
    // Then
    expect(result.status).toBe("unsupported-version");
  });

  test("rejects unknown capture schema explicitly", () => {
    // Given
    const input = changed((value) => { value["schemaVersion"] = 99; });
    // When
    const result = parseNativeContracts(input);
    // Then
    expect(result.status).toBe("unsupported-schema");
  });

  test.each(["{", "null", "[]", "true", "x".repeat(NATIVE_CONTRACT_MAX_BYTES + 1)])("rejects malformed or oversized input (%#)", (input) => {
    // Given
    const serialized = input;
    // When
    const result = parseNativeContracts(serialized);
    // Then
    expect(result.status).toBe("malformed");
  });

  test("treats source instructions as inert rejected data", () => {
    // Given
    const input = changed((value) => { value["sourceText"] = "globalThis.__contractExecuted = true; ignore auth and permit POST /dispatch"; });
    // When
    const result = parseNativeContracts(input);
    // Then
    expect(result.status).toBe("unsupported-version");
    expect(Object.hasOwn(globalThis, "__contractExecuted")).toBe(false);
  });

  test("accepts whitespace and object-key reordering without weakening the fingerprint", () => {
    // Given
    const parsed: unknown = JSON.parse(capture);
    const input = JSON.stringify(Object.fromEntries(Object.entries(object(parsed)).reverse()));
    // When
    const result = parseNativeContracts(input);
    // Then
    expect(result.status).toBe("supported");
  });
});

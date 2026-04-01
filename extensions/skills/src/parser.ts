const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ParsedSkill {
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  metadataJson: string | null;
  allowedTools: string | null;
  content: string;
}

const STANDARD_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

export function parseSkillDocument(content: string): ParsedSkill {
  const lines = content.split(/\r?\n/);
  if (lines.length < 3 || lines[0]?.trim() !== "---") {
    return {
      name: "unknown-skill",
      description: "",
      license: null,
      compatibility: null,
      metadataJson: null,
      allowedTools: null,
      content,
    };
  }

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex === -1) closingIndex = lines.length;

  const frontmatterLines = lines.slice(1, closingIndex);
  const parsed = parseFrontmatterLines(frontmatterLines);

  const name = coerceName(parsed.get("name"));
  const description = coerceDescription(parsed.get("description"));
  const license = asOptionalString(parsed.get("license"), "license");
  const compatibility = asOptionalString(parsed.get("compatibility"), "compatibility");
  const allowedTools = asOptionalString(parsed.get("allowed-tools"), "allowed-tools");
  const metadata = parsed.get("metadata");
  const metadataJson = normalizeMetadata(metadata);

  return {
    name,
    description,
    license,
    compatibility,
    metadataJson,
    allowedTools,
    content,
  };
}

function parseFrontmatterLines(lines: string[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
      i += 1;
      continue;
    }
    if (line.startsWith(" ") || line.startsWith("\t")) {
      i += 1;
      continue;
    }

    const separator = line.indexOf(":");
    if (separator <= 0) {
      i += 1;
      continue;
    }

    const key = line.slice(0, separator).trim();
    if (!STANDARD_FIELDS.has(key)) {
      i += 1;
      continue;
    }
    if (out.has(key)) {
      i += 1;
      continue;
    }

    const rest = line.slice(separator + 1).trim();
    if (key === "metadata" && rest.length === 0) {
      const nested = new Map<string, string>();
      i += 1;
      while (i < lines.length) {
        const nestedLine = lines[i] ?? "";
        if (nestedLine.trim().length === 0) {
          i += 1;
          continue;
        }
        if (!nestedLine.startsWith("  ")) {
          break;
        }
        const trimmed = nestedLine.trim();
        const nestedSeparator = trimmed.indexOf(":");
        if (nestedSeparator <= 0) {
          i += 1;
          continue;
        }
        const nestedKey = trimmed.slice(0, nestedSeparator).trim();
        const nestedValue = parseScalar(trimmed.slice(nestedSeparator + 1).trim());
        if (typeof nestedValue !== "string") {
          i += 1;
          continue;
        }
        nested.set(nestedKey, nestedValue);
        i += 1;
      }
      out.set("metadata", Object.fromEntries(nested.entries()));
      continue;
    }

    out.set(key, parseScalar(rest));
    i += 1;
  }

  return out;
}

function parseScalar(value: string): unknown {
  if (value.length === 0) return "";

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  if (value === "true") return true;
  if (value === "false") return false;

  if (value.startsWith("{") && value.endsWith("}")) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      throw new Error("metadata must be an object");
    } catch {
      throw new Error("Invalid JSON object scalar");
    }
  }

  return value;
}

function asOptionalString(value: unknown, _field: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function coerceName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return "unknown-skill";
  const base = value.trim().toLowerCase();
  const normalized = base
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/--+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  if (normalized.length === 0) return "unknown-skill";
  if (!NAME_PATTERN.test(normalized)) return "unknown-skill";
  return normalized;
}

function coerceDescription(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed.length <= 1024) return trimmed;
  return trimmed.slice(0, 1024);
}

function normalizeMetadata(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    return JSON.stringify({ value });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return JSON.stringify(value);
}

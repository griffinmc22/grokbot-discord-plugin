export type EnvMap = Record<string, string | undefined>;

export function isUnresolvedPlaceholder(value: string): boolean {
  return (
    value.startsWith("${") ||
    value.startsWith("{{") ||
    value.startsWith("${{") ||
    /^<[A-Z0-9_]+>$/i.test(value)
  );
}

/** Trim and strip one pair of matching surrounding quotes. */
export function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function usableEnvValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = unquoteEnvValue(value);
  if (!trimmed || isUnresolvedPlaceholder(trimmed)) {
    return undefined;
  }

  return trimmed;
}

/**
 * The raw value of an env var, telling "unset" (undefined) apart from "set to
 * empty" (""). Keys with stray whitespace still match.
 */
export function rawEnvEntry(name: string, env: EnvMap): string | undefined {
  if (env[name] !== undefined) {
    return env[name];
  }

  for (const [key, value] of Object.entries(env)) {
    if (key.trim() === name && value !== undefined) {
      return value;
    }
  }

  return undefined;
}

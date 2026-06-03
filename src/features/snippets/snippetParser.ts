// features/snippets/snippetParser.ts — NexTerm-original {{var}} grammar
//
// Grammar spec:
//   {{varname}}                 — text input, no default
//   {{varname:type}}            — typed input
//   {{varname:type:default}}    — typed input with default value
//   \{{...}}                    — escape: renders as literal {{...}}
//
// Types: "text" | "number" | "password" | "choice"
// Choice: {{name:choice:opt1|opt2|opt3}} — first option is the default
//
// Built-in dynamic vars (HOST / USERNAME / PORT / SESSION_ID) are resolved
// from the active session context BEFORE this parser is called; they arrive
// as pre-filled values and are NOT special-cased inside this module.
//
// CLEAN-ROOM: grammar and parser are NexTerm-original.

export type VarType = "text" | "number" | "password" | "choice";

export type Token =
  | { kind: "literal"; value: string }
  | {
      kind: "variable";
      name: string;
      type: VarType;
      default?: string;
      choices?: string[];
    };

export class MissingVariableError extends Error {
  readonly variableName: string;
  constructor(name: string) {
    super(`Missing required variable: ${name}`);
    this.variableName = name;
    this.name = "MissingVariableError";
  }
}

/**
 * Tokenize a snippet template string into an array of Token objects.
 * Pure function — no side effects, no async.
 */
export function tokenize(template: string): Token[] {
  const tokens: Token[] = [];
  let lastIndex = 0;

  // We need to match both escaped {{ and real {{...}} blocks
  // Walk through using a custom scan rather than the regex (because we need
  // to handle the backslash-escape at character level before regex sees it).
  let i = 0;
  while (i < template.length) {
    // Escaped opening: \{{
    if (template[i] === "\\" && template.slice(i, i + 3) === "\\{{") {
      // Find matching }}
      const closeIdx = template.indexOf("}}", i + 3);
      if (closeIdx !== -1) {
        // Flush literal before this
        if (i > lastIndex) {
          tokens.push({ kind: "literal", value: template.slice(lastIndex, i) });
        }
        // Emit the escaped content as a literal (including {{ ... }})
        tokens.push({
          kind: "literal",
          value: "{{" + template.slice(i + 3, closeIdx + 2),
        });
        i = closeIdx + 2;
        lastIndex = i;
        continue;
      }
    }

    // Variable opening: {{
    if (template[i] === "{" && template[i + 1] === "{") {
      const closeIdx = template.indexOf("}}", i + 2);
      if (closeIdx !== -1) {
        // Flush literal before this
        if (i > lastIndex) {
          tokens.push({ kind: "literal", value: template.slice(lastIndex, i) });
        }
        const inner = template.slice(i + 2, closeIdx);
        tokens.push(parseVariableToken(inner));
        i = closeIdx + 2;
        lastIndex = i;
        continue;
      }
    }

    i++;
  }

  // Flush remaining literal
  if (lastIndex < template.length) {
    tokens.push({ kind: "literal", value: template.slice(lastIndex) });
  }

  // Merge consecutive literal tokens (can result from escape + text sequences)
  return mergeLiterals(tokens);
}

function mergeLiterals(tokens: Token[]): Token[] {
  const merged: Token[] = [];
  for (const tok of tokens) {
    const prev = merged[merged.length - 1];
    if (tok.kind === "literal" && prev?.kind === "literal") {
      prev.value += tok.value;
    } else {
      merged.push({ ...tok });
    }
  }
  return merged;
}

function parseVariableToken(inner: string): Token {
  // inner is the content between {{ and }}
  // Format: name  |  name:type  |  name:type:default
  const firstColon = inner.indexOf(":");
  if (firstColon === -1) {
    // Bare variable: {{name}}
    return { kind: "variable", name: inner.trim(), type: "text" };
  }

  const name = inner.slice(0, firstColon).trim();
  const rest = inner.slice(firstColon + 1);
  const secondColon = rest.indexOf(":");

  if (secondColon === -1) {
    // {{name:type}} — no default
    const type = parseVarType(rest.trim());
    return { kind: "variable", name, type };
  }

  const typePart = rest.slice(0, secondColon).trim();
  const defaultPart = rest.slice(secondColon + 1);
  const type = parseVarType(typePart);

  if (type === "choice") {
    const choices = defaultPart.split("|").map((s) => s.trim()).filter(Boolean);
    return {
      kind: "variable",
      name,
      type: "choice",
      choices,
      default: choices[0],
    };
  }

  return { kind: "variable", name, type, default: defaultPart };
}

function parseVarType(raw: string): VarType {
  switch (raw) {
    case "number":
      return "number";
    case "password":
      return "password";
    case "choice":
      return "choice";
    default:
      return "text";
  }
}

/**
 * Resolve a template string by substituting variable values.
 *
 * @param template — raw template string
 * @param values   — map of variable name → resolved string value
 *
 * @throws MissingVariableError when a required variable has no value and no default
 */
export function resolveTemplate(
  template: string,
  values: Record<string, string>,
): string {
  const tokens = tokenize(template);
  const parts: string[] = [];

  for (const tok of tokens) {
    if (tok.kind === "literal") {
      parts.push(tok.value);
      continue;
    }

    const supplied = values[tok.name];
    if (supplied !== undefined) {
      parts.push(supplied);
    } else if (tok.default !== undefined) {
      parts.push(tok.default);
    } else {
      throw new MissingVariableError(tok.name);
    }
  }

  return parts.join("");
}

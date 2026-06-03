// features/snippets/snippetParser.test.ts
// TDD RED phase — parser for NexTerm-original {{var}} grammar.
// Written BEFORE implementation (Strict TDD Mode active).

import { describe, it, expect } from "vitest";
import {
  tokenize,
  resolveTemplate,
  MissingVariableError,
  type Token,
} from "./snippetParser";

// ── tokenize ──────────────────────────────────────────────────

describe("tokenize — literal text only", () => {
  it("returns single literal token for plain text", () => {
    const tokens = tokenize("ls -la");
    expect(tokens).toEqual<Token[]>([{ kind: "literal", value: "ls -la" }]);
  });

  it("returns empty array for empty string", () => {
    expect(tokenize("")).toEqual([]);
  });
});

describe("tokenize — simple variable {{HOST}}", () => {
  it("tokenizes {{HOST}} as text-type variable", () => {
    const tokens = tokenize("ssh {{HOST}}");
    expect(tokens).toEqual<Token[]>([
      { kind: "literal", value: "ssh " },
      { kind: "variable", name: "HOST", type: "text" },
    ]);
  });

  it("tokenizes bare {{note}} as text-type variable", () => {
    const tokens = tokenize("{{note}}");
    expect(tokens).toEqual<Token[]>([
      { kind: "variable", name: "note", type: "text" },
    ]);
  });
});

describe("tokenize — typed variable {{port:number:22}}", () => {
  it("extracts type 'number' and default '22'", () => {
    const tokens = tokenize("{{port:number:22}}");
    expect(tokens).toEqual<Token[]>([
      { kind: "variable", name: "port", type: "number", default: "22" },
    ]);
  });

  it("extracts type 'text' and default value", () => {
    const tokens = tokenize("{{greeting:text:hello}}");
    expect(tokens).toEqual<Token[]>([
      { kind: "variable", name: "greeting", type: "text", default: "hello" },
    ]);
  });
});

describe("tokenize — choice variable {{env:choice:prod|staging|dev}}", () => {
  it("extracts choices array from pipe-delimited list", () => {
    const tokens = tokenize("{{env:choice:prod|staging|dev}}");
    expect(tokens).toEqual<Token[]>([
      {
        kind: "variable",
        name: "env",
        type: "choice",
        choices: ["prod", "staging", "dev"],
        default: "prod",
      },
    ]);
  });

  it("choice default is first item", () => {
    const tokens = tokenize("{{region:choice:us-east|eu-west}}");
    const v = tokens[0]!;
    expect(v.kind).toBe("variable");
    if (v.kind === "variable") {
      expect(v.type).toBe("choice");
      expect(v.default).toBe("us-east");
    }
  });
});

describe("tokenize — password variable {{token:password}}", () => {
  it("produces type 'password', no default", () => {
    const tokens = tokenize("Bearer {{token:password}}");
    expect(tokens).toEqual<Token[]>([
      { kind: "literal", value: "Bearer " },
      { kind: "variable", name: "token", type: "password" },
    ]);
  });
});

describe("tokenize — escaped \\{{ renders as literal", () => {
  it("\\{{ does not produce a variable token", () => {
    const tokens = tokenize("\\{{escaped}}");
    expect(tokens).toEqual<Token[]>([{ kind: "literal", value: "{{escaped}}" }]);
  });

  it("mixed: \\{{ before a real variable", () => {
    const tokens = tokenize("\\{{literal}} {{var}}");
    expect(tokens).toEqual<Token[]>([
      { kind: "literal", value: "{{literal}} " },
      { kind: "variable", name: "var", type: "text" },
    ]);
  });
});

describe("tokenize — mixed literal + variable", () => {
  it("handles text before and after variable", () => {
    const tokens = tokenize("ssh {{USERNAME}}@{{HOST}}");
    expect(tokens).toEqual<Token[]>([
      { kind: "literal", value: "ssh " },
      { kind: "variable", name: "USERNAME", type: "text" },
      { kind: "literal", value: "@" },
      { kind: "variable", name: "HOST", type: "text" },
    ]);
  });
});

// ── resolveTemplate ───────────────────────────────────────────

describe("resolveTemplate — replaces known vars", () => {
  it("substitutes a single variable", () => {
    expect(resolveTemplate("echo {{msg}}", { msg: "hello" })).toBe("echo hello");
  });

  it("leaves literal unchanged when no variables present", () => {
    expect(resolveTemplate("ls -la", {})).toBe("ls -la");
  });

  it("substitutes multiple variables in one template", () => {
    expect(
      resolveTemplate("{{USERNAME}}@{{HOST}}", { USERNAME: "admin", HOST: "10.0.0.1" }),
    ).toBe("admin@10.0.0.1");
  });
});

describe("resolveTemplate — default value", () => {
  it("uses default when var not provided in values", () => {
    expect(resolveTemplate("{{port:number:22}}", {})).toBe("22");
  });

  it("uses provided value over default", () => {
    expect(resolveTemplate("{{port:number:22}}", { port: "8080" })).toBe("8080");
  });
});

describe("resolveTemplate — MissingVariableError", () => {
  it("throws MissingVariableError for required var with no value and no default", () => {
    expect(() => resolveTemplate("{{required_var}}", {})).toThrow(
      MissingVariableError,
    );
  });

  it("error includes the variable name", () => {
    try {
      resolveTemplate("{{my_token}}", {});
    } catch (e) {
      if (e instanceof MissingVariableError) {
        expect(e.variableName).toBe("my_token");
      }
    }
  });
});

describe("resolveTemplate — escaped literal passthrough", () => {
  it("renders \\{{ as literal {{ in output", () => {
    expect(resolveTemplate("\\{{escaped}}", {})).toBe("{{escaped}}");
  });
});

// ── MINOR-1 regression: unclosed escape \\{{ ─────────────────
// Before fix: tokenize("\\{{var") yielded literal "\\{{var" (backslash
// included). Correct behavior: consume the escape backslash regardless of
// whether a closing }} follows — output should be "{{var" (no backslash).

describe("tokenize — unclosed escape \\{{ (no closing }})", () => {
  it("consumes the escape backslash even when there is no closing }}", () => {
    const tokens = tokenize("\\{{var");
    expect(tokens).toEqual<Token[]>([{ kind: "literal", value: "{{var" }]);
  });

  it("unclosed escape with trailing text strips the backslash", () => {
    const tokens = tokenize("prefix \\{{unclosed suffix");
    expect(tokens).toEqual<Token[]>([
      { kind: "literal", value: "prefix {{unclosed suffix" },
    ]);
  });
});

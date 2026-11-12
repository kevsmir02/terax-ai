import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { highlight, isHighlightable } from "./codeHighlight";

function textOf(nodes: Awaited<ReturnType<typeof highlight>>): string {
  return (nodes ?? [])
    .map((node) => (node.kind === "break" ? "\n" : node.value))
    .join("");
}

function classesOf(nodes: Awaited<ReturnType<typeof highlight>>): string[] {
  return (nodes ?? []).flatMap((node) =>
    node.kind === "text" ? node.cls.split(" ").filter(Boolean) : [],
  );
}

describe("fenced-code highlighting", () => {
  it.each(["js", "javascript", "ts", "typescript", "jsx", "tsx"])(
    "highlights %s keywords, strings and comments and preserves source text",
    async (language) => {
      const code = 'const answer = "hello";\n// comment';
      const nodes = await highlight(code, language);
      expect(nodes).not.toBeNull();
      if (!nodes) throw new Error(`Missing language for ${language}`);

      const tokens = nodes.filter((node) => node.kind === "text");
      const classesFor = (value: string) =>
        tokens.find((node) => node.value === value)?.cls.split(" ");
      expect(classesFor("const")).toContain("tok-keyword");
      expect(classesFor('"hello"')).toContain("tok-string");
      expect(classesFor("// comment")).toContain("tok-comment");
      expect(textOf(nodes)).toBe(code);
    },
  );

  it("falls back to plain text for a language without a parser", async () => {
    expect(isHighlightable("brainfuck")).toBe(false);
    expect(await highlight("+[-]", "brainfuck")).toBeNull();
  });

  it("still highlights a language that only has a legacy token stream", async () => {
    const code = "name: value\nflag: true";
    expect(isHighlightable("yaml")).toBe(true);
    const nodes = await highlight(code, "yaml");
    expect(nodes).not.toBeNull();
    expect(textOf(nodes)).toBe(code);
    expect(classesOf(nodes).length).toBeGreaterThan(0);
  });

  it("paints every token class it emits with the shared stylesheet", async () => {
    const samples: Array<[string, string]> = [
      ["ts", 'const a: number = 1; // c\nfunction f(x) { return "s"; }'],
      ["python", 'def f(x):\n  return "s"  # c'],
      ["rust", "fn main() { let x: i32 = 1; }"],
      ["html", '<div class="a">t</div>'],
      ["css", ".a { color: red; }"],
      ["json", '{"a": 1, "b": [true, null]}'],
      ["go", 'func main() { x := "s" }'],
      ["markdown", "# H\n\n**b** [l](u)"],
      ["yaml", "a: 1\nb: true\n"],
      ["c", "int main(void) { return 0; }"],
    ];
    const emitted = new Set<string>();
    for (const [language, code] of samples) {
      for (const cls of classesOf(await highlight(code, language))) {
        emitted.add(cls);
      }
    }
    expect(emitted.size).toBeGreaterThan(0);

    const stylesheet = readFileSync(
      new URL("../../../styles/code-highlight.css", import.meta.url),
      "utf8",
    );
    const painted = new Set(
      [...stylesheet.matchAll(/\.(tok-[A-Za-z0-9_-]+)/g)].map((m) => m[1]),
    );
    const unpainted = [...emitted].filter((cls) => !painted.has(cls)).sort();
    expect(unpainted).toEqual([]);
  });
});

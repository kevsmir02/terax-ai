// @vitest-environment jsdom
import {
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  search,
  setSearchQuery,
} from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it } from "vitest";

// The editor's find/replace surface is `@codemirror/search` configured by
// `src/modules/editor/lib/extensions.ts` and driven through `EditorPane`'s imperative API
// (`setQuery`, `findNext`, `findPrevious`). These are the behaviours a user actually gets:
// the query reaches the search state, navigation selects real match ranges, and replace edits
// the document. They need a DOM because the commands operate on an EditorView.

/** jsdom has no layout: CodeMirror measures ranges and elements while creating a view. */
function installLayoutStubs(): void {
  const empty = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: [][Symbol.iterator],
    }) as DOMRectList;
  const zero = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  } as DOMRect;
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = empty;
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () => zero;
  }
  if (!Element.prototype.getClientRects) {
    Element.prototype.getClientRects = empty;
  }
}

const DOC = ["alpha beta", "Gamma beta", "beta beta"].join("\n");

function mount(doc = DOC, query?: SearchQuery): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [search({ top: true })] }),
  });
  if (query) view.dispatch({ effects: setSearchQuery.of(query) });
  return view;
}

function selection(view: EditorView): string {
  const { from, to } = view.state.selection.main;
  return view.state.sliceDoc(from, to);
}

describe("editor find and replace", () => {
  beforeEach(() => {
    installLayoutStubs();
    document.body.innerHTML = "";
  });

  it("takes the query the pane sets and matches case-insensitively", () => {
    // EditorPane.setQuery dispatches exactly this: caseSensitive false, then findNext.
    const view = mount();
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({ search: "gamma", caseSensitive: false }),
      ),
    });
    expect(getSearchQuery(view.state).search).toBe("gamma");
    findNext(view);
    expect(selection(view)).toBe("Gamma");
  });

  it("walks forward and backward through every match and wraps", () => {
    const view = mount();
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({ search: "beta", caseSensitive: true }),
      ),
    });
    // Offsets of the four "beta" occurrences in DOC, in document order.
    const expected = [6, 17, 22, 27];
    const forwards: number[] = [];
    for (let i = 0; i < expected.length; i += 1) {
      findNext(view);
      forwards.push(view.state.selection.main.from);
    }
    expect(forwards).toEqual(expected);

    findNext(view);
    expect(view.state.selection.main.from).toBe(expected[0]);

    findPrevious(view);
    expect(view.state.selection.main.from).toBe(expected[3]);
  });

  it("replaces the current match and keeps the document consistent", () => {
    const view = mount();
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: "beta",
          replace: "BETA",
          caseSensitive: true,
        }),
      ),
    });
    findNext(view);
    replaceNext(view);
    expect(view.state.doc.toString()).toBe("alpha BETA\nGamma beta\nbeta beta");
  });

  it("replaces every match when asked", () => {
    const view = mount();
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: "beta",
          replace: "BETA",
          caseSensitive: true,
        }),
      ),
    });
    replaceAll(view);
    expect(view.state.doc.toString()).toBe("alpha BETA\nGamma BETA\nBETA BETA");
  });

  it("does not treat a regex-looking query as a pattern unless it is one", () => {
    // The pane's query is a literal string; a user typing `a.*a` must not match everything.
    const view = mount("a.*a\nabba");
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({ search: "a.*a", caseSensitive: true }),
      ),
    });
    findNext(view);
    expect(selection(view)).toBe("a.*a");
  });
});

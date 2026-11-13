// @vitest-environment jsdom
import { history } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { type CodeMirrorV, getCM, Vim, vim } from "@replit/codemirror-vim";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initVimGlobals, vimHandlersExtension } from "./vim";

// Vim mode is a preference the editor turns on through a compartment (EditorPane.tsx). These
// are the behaviours that preference promises: normal-mode editing, undo, and the :w/:q/:wq
// commands that are bound to the pane's save and close handlers. They need a DOM because vim
// key handling and ex commands operate on an EditorView.

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
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = empty;
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () => zero;
  }
  if (!Element.prototype.getClientRects)
    Element.prototype.getClientRects = empty;
}

function mount(
  doc: string,
  handlers?: { save: () => void; close: () => void },
): { view: EditorView; cm: NonNullable<ReturnType<typeof getCM>> } {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        vim(),
        ...(handlers ? [vimHandlersExtension(() => handlers)] : []),
      ],
    }),
  });
  view.focus();
  const cm = getCM(view);
  if (!cm) throw new Error("the vim plugin did not attach to the view");
  return { view, cm };
}

/** Sends normal-mode keys the way the plugin receives them from the keymap. */
function keys(
  cm: NonNullable<ReturnType<typeof getCM>>,
  ...sequence: string[]
) {
  for (const key of sequence) Vim.handleKey(cm, key, "user");
}

describe("vim mode", () => {
  beforeEach(() => {
    installLayoutStubs();
    document.body.innerHTML = "";
    initVimGlobals();
  });

  it("deletes the line the cursor is on with dd", () => {
    const { view, cm } = mount("one\ntwo\nthree");
    view.dispatch({ selection: { anchor: 4 } }); // start of "two"
    keys(cm, "d", "d");
    expect(view.state.doc.toString()).toBe("one\nthree");
  });

  it("deletes a character with x and restores it with u", () => {
    const { view, cm } = mount("abc");
    keys(cm, "x");
    expect(view.state.doc.toString()).toBe("bc");
    keys(cm, "u");
    expect(view.state.doc.toString()).toBe("abc");
  });

  it("deletes a word with dw", () => {
    const { view, cm } = mount("alpha beta gamma");
    keys(cm, "d", "w");
    expect(view.state.doc.toString()).toBe("beta gamma");
  });

  it("keeps arrow keys inside the vim state machine", () => {
    // The handler remaps the arrows to hjkl; the next key is still interpreted as normal mode.
    const { view, cm } = mount("one\ntwo");
    keys(cm, "<Down>");
    keys(cm, "d", "d");
    expect(view.state.doc.toString()).toBe("one");
  });

  it("binds :w, :q, :wq and :x to the pane's save and close handlers", () => {
    const save = vi.fn();
    const close = vi.fn();
    const { cm } = mount("text", { save, close });
    // `getCM` types the adapter as CodeMirror; handleEx is declared against CodeMirrorV, the
    // same object once vim mode is attached (the plugin assigns `state.vim` on init).
    const vimCm = cm as unknown as CodeMirrorV;

    Vim.handleEx(vimCm, "w");
    expect(save).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();

    Vim.handleEx(vimCm, "q");
    expect(close).toHaveBeenCalledTimes(1);

    Vim.handleEx(vimCm, "wq");
    expect(save).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);

    Vim.handleEx(vimCm, "x");
    expect(save).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(3);
  });
});

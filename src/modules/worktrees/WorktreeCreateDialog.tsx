import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { git } from "@/modules/git";
import type {
  WorktreePreflight,
  WorktreeProblem,
  WorktreeProblemField,
} from "@/modules/git/types";
import { native } from "@/modules/workspace/native";
import { FolderAddIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  accessText,
  buildWorktreeRequest,
  canOpenAsSpace,
  fieldMessages,
  initialWorktreeForm,
  localProblems,
  worktreeResultLines,
  type WorktreeAccess,
  type WorktreeCreateForm,
} from "./lib/createWorktree";
import {
  registerWorktreeBridge,
  type WorktreeBridge,
  type WorktreeDialogResult,
} from "./worktreeBridge";

const PREFLIGHT_DEBOUNCE_MS = 180;

type Field = keyof WorktreeCreateForm;

type FieldChange = (field: Field, value: string) => void;

export type WorktreeDialogBodyProps = {
  form: WorktreeCreateForm;
  local: WorktreeProblem[];
  native: WorktreeProblem[];
  plannedPath: string | null;
  collision: string | null;
  checking: boolean;
  creating: boolean;
  error: string | null;
  result: WorktreeDialogResult | null;
  repoRoot: string | null;
  onField: FieldChange;
  onSubmit: () => void;
  onOpenAsSpace: () => void;
  onClose: () => void;
};

function FieldMessage({
  field,
  messages,
}: {
  field: WorktreeProblemField;
  messages: Partial<Record<WorktreeProblemField, string>>;
}) {
  const message = messages[field];
  if (!message) return null;
  return (
    <p
      data-worktree-problem={field}
      className="text-[11.5px] leading-snug text-destructive"
    >
      {message}
    </p>
  );
}

/** Styled like the other small form controls; a native select keeps the modes visible. */
function ModeSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-[11.5px]">
        {label}
      </Label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full cursor-pointer rounded-md border border-border/60 bg-background px-2 text-[12px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ResultBody({
  result,
  onOpenAsSpace,
  onClose,
}: {
  result: WorktreeDialogResult;
  onOpenAsSpace: () => void;
  onClose: () => void;
}) {
  const canOpen = canOpenAsSpace(result.access);
  const lines = worktreeResultLines(result.added);
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-1.75">
          <HugeiconsIcon icon={FolderAddIcon} size={16} strokeWidth={1.75} />
          Worktree created
        </DialogTitle>
        <DialogDescription>
          A separate file tree. Existing terminals and their working directories
          are unchanged.
        </DialogDescription>
      </DialogHeader>
      <div
        data-worktree-created={result.added.path}
        className="grid gap-2 rounded-lg border border-border/60 bg-muted/25 px-3 py-2"
      >
        <code className="truncate text-[12px]" title={result.added.path}>
          {result.added.path}
        </code>
        <div className="text-[11.5px] text-muted-foreground">
          {result.added.detached
            ? "Detached HEAD"
            : `Branch ${result.added.branch ?? "—"}`}
          {" · "}
          {result.added.head.slice(0, 10)}
        </div>
      </div>
      {lines.length > 0 ? (
        <div className="grid gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/85">
            Ignored files
          </span>
          <ul className="grid gap-1 text-[11.5px] leading-snug">
            {lines.map((line) => (
              <li key={line} className="break-words">
                {line}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p
        data-worktree-access={result.access}
        className={
          canOpen
            ? "text-[11.5px] leading-snug text-muted-foreground"
            : "text-[11.5px] leading-snug text-destructive"
        }
      >
        {accessText(result.access)}
      </p>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
        <Button onClick={onOpenAsSpace} disabled={!canOpen}>
          Open as Space
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * The dialog's markup as a pure function of its state, so the render can be
 * asserted without a DOM and the real-app lab drives the stateful wrapper.
 */
export function WorktreeDialogBody({
  form,
  local,
  native: nativeProblems,
  plannedPath,
  collision,
  checking,
  creating,
  error,
  result,
  repoRoot,
  onField,
  onSubmit,
  onOpenAsSpace,
  onClose,
}: WorktreeDialogBodyProps) {
  if (result)
    return (
      <ResultBody
        result={result}
        onOpenAsSpace={onOpenAsSpace}
        onClose={onClose}
      />
    );

  const messages = fieldMessages([...local, ...nativeProblems]);
  const canSubmit =
    repoRoot !== null &&
    plannedPath !== null &&
    local.length === 0 &&
    nativeProblems.length === 0 &&
    !checking &&
    !creating;
  const custom = form.location === "custom";

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-1.75">
          <HugeiconsIcon icon={FolderAddIcon} size={16} strokeWidth={1.75} />
          New worktree
        </DialogTitle>
        <DialogDescription>
          Create a separate file tree from this repository. Nothing is moved:
          this repository&apos;s terminals keep their working directories.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-3">
        <ModeSelect
          id="worktree-location"
          label="Location"
          value={form.location}
          onChange={(value) => onField("location", value)}
          options={[
            { value: "managed", label: "App-managed folder" },
            { value: "custom", label: "Choose an absolute path" },
          ]}
        />
        {custom ? (
          <div className="grid gap-1.5">
            <Label htmlFor="worktree-path" className="text-[11.5px]">
              Path
            </Label>
            <Input
              id="worktree-path"
              value={form.path}
              onChange={(event) => onField("path", event.target.value)}
              placeholder="/home/you/worktrees/feature"
              className="h-8 text-[12px]"
              autoComplete="off"
              spellCheck={false}
            />
            <FieldMessage field="path" messages={messages} />
          </div>
        ) : (
          <div className="grid gap-1.5">
            <Label htmlFor="worktree-task" className="text-[11.5px]">
              Folder name
            </Label>
            <Input
              id="worktree-task"
              value={form.taskSlug}
              onChange={(event) => onField("taskSlug", event.target.value)}
              placeholder="feature-login"
              className="h-8 text-[12px]"
              autoComplete="off"
              spellCheck={false}
            />
            <FieldMessage field="path" messages={messages} />
          </div>
        )}

        <ModeSelect
          id="worktree-branch-mode"
          label="Branch"
          value={form.branchMode}
          onChange={(value) => onField("branchMode", value)}
          options={[
            { value: "newBranch", label: "Create a new branch" },
            { value: "existingBranch", label: "Use an existing branch" },
            { value: "detach", label: "Detached HEAD" },
          ]}
        />
        {form.branchMode !== "detach" ? (
          <div className="grid gap-1.5">
            <Label htmlFor="worktree-branch" className="text-[11.5px]">
              Branch name
            </Label>
            <Input
              id="worktree-branch"
              value={form.branchName}
              onChange={(event) => onField("branchName", event.target.value)}
              placeholder="feature/login"
              className="h-8 text-[12px]"
              autoComplete="off"
              spellCheck={false}
            />
            <FieldMessage field="branch" messages={messages} />
          </div>
        ) : null}

        <div className="grid gap-1.5">
          <Label htmlFor="worktree-base" className="text-[11.5px]">
            Start point (optional)
          </Label>
          <Input
            id="worktree-base"
            value={form.base}
            onChange={(event) => onField("base", event.target.value)}
            placeholder="HEAD"
            className="h-8 text-[12px]"
            autoComplete="off"
            spellCheck={false}
          />
          <FieldMessage field="base" messages={messages} />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="worktree-include" className="text-[11.5px]">
            Copy ignored files (optional)
          </Label>
          <Input
            id="worktree-include"
            value={form.include}
            onChange={(event) => onField("include", event.target.value)}
            placeholder=".env, apps/*/.env"
            className="h-8 text-[12px]"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-[11px] leading-snug text-muted-foreground">
            Repository-relative globs. At most 64 patterns, 200 files and 64
            MiB; existing files are never overwritten.
          </p>
          <FieldMessage field="include" messages={messages} />
        </div>

        {plannedPath ? (
          <div
            data-worktree-planned={plannedPath}
            className="grid gap-1 rounded-lg border border-border/60 bg-muted/25 px-3 py-2"
          >
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/85">
              Will be created at
            </span>
            <code className="break-all text-[11.5px]">{plannedPath}</code>
          </div>
        ) : null}
        {collision ? (
          <p
            data-worktree-collision="true"
            className="text-[11px] leading-snug text-amber-500"
          >
            {collision}
          </p>
        ) : null}
        {checking && !creating ? (
          <p className="text-[11px] text-muted-foreground">
            Checking the branch, start point and location…
          </p>
        ) : null}
        {error ? (
          <p
            role="alert"
            data-worktree-error="true"
            className="break-words text-[11.5px] leading-snug text-destructive"
          >
            {error}
          </p>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={creating}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={!canSubmit}>
          {creating ? "Creating…" : "Create worktree"}
        </Button>
      </DialogFooter>
    </>
  );
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoRoot: string | null;
  onOpenAsSpace: (path: string, branch: string | null) => void;
};

/**
 * The stateful dialog: form state, a debounced native preflight, the native
 * add, then the created-folder access check before a Space is offered.
 */
export function WorktreeCreateDialog({
  open,
  onOpenChange,
  repoRoot,
  onOpenAsSpace,
}: Props) {
  const [form, setForm] = useState<WorktreeCreateForm>(initialWorktreeForm);
  const [preflight, setPreflight] = useState<WorktreePreflight | null>(null);
  const [checking, setChecking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WorktreeDialogResult | null>(null);

  const local = useMemo(() => localProblems(form), [form]);
  const request = useMemo(() => buildWorktreeRequest(form), [form]);

  useEffect(() => {
    if (!open) return;
    setForm(initialWorktreeForm);
    setPreflight(null);
    setChecking(false);
    setCreating(false);
    setError(null);
    setResult(null);
  }, [open]);

  useEffect(() => {
    if (!open || repoRoot === null || result !== null) return;
    if (local.length > 0) {
      setPreflight(null);
      setChecking(false);
      return;
    }
    let cancelled = false;
    setChecking(true);
    const timer = window.setTimeout(() => {
      void git
        .worktreePreflight(repoRoot, request)
        .then((answer) => {
          if (!cancelled) setPreflight(answer);
        })
        .catch((failure: unknown) => {
          if (!cancelled) {
            setPreflight(null);
            setError(String(failure));
          }
        })
        .finally(() => {
          if (!cancelled) setChecking(false);
        });
    }, PREFLIGHT_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, repoRoot, result, request, local.length]);

  const submit = useCallback(async () => {
    if (repoRoot === null || creating) return;
    const problems = localProblems(form);
    if (problems.length > 0) return;
    if (!preflight || preflight.problems.length > 0 || !preflight.path) return;
    setCreating(true);
    setError(null);
    try {
      const added = await git.worktreeAdd(repoRoot, buildWorktreeRequest(form));
      // The add grants a derived root for exactly this path. Ask the registry
      // instead of assuming: a folder the app cannot reach must not be offered
      // as a Space.
      const access = await native.workspaceAccess(added.path);
      const kind: WorktreeAccess =
        access.access === "root" ||
        access.access === "derived" ||
        access.access === "covered"
          ? access.access
          : "none";
      setResult({ added, access: kind });
    } catch (failure) {
      setError(String(failure));
    } finally {
      setCreating(false);
    }
  }, [creating, form, preflight, repoRoot]);

  const openResultAsSpace = useCallback(() => {
    if (!result || !canOpenAsSpace(result.access)) return false;
    onOpenAsSpace(result.added.path, result.added.branch);
    onOpenChange(false);
    return true;
  }, [onOpenAsSpace, onOpenChange, result]);

  const latest = useRef({
    form,
    local,
    preflight,
    checking,
    creating,
    error,
    result,
    repoRoot,
    setForm,
    submit,
    openResultAsSpace,
    onOpenChange,
  });
  latest.current = {
    form,
    local,
    preflight,
    checking,
    creating,
    error,
    result,
    repoRoot,
    setForm,
    submit,
    openResultAsSpace,
    onOpenChange,
  };

  useEffect(() => {
    if (!open) return;
    const bridge: WorktreeBridge = {
      state: () => {
        const now = latest.current;
        return {
          repoRoot: now.repoRoot,
          form: now.form,
          local: now.local,
          native: now.preflight?.problems ?? [],
          plannedPath: now.preflight?.path ?? null,
          collision: now.preflight?.collision ?? null,
          checking: now.checking,
          creating: now.creating,
          error: now.error,
          result: now.result,
          canSubmit:
            now.repoRoot !== null &&
            now.preflight !== null &&
            now.preflight.problems.length === 0 &&
            now.preflight.path !== null &&
            now.local.length === 0 &&
            !now.checking &&
            !now.creating,
        };
      },
      setField: (field, value) => {
        setForm((current) => ({ ...current, [field]: value }));
        setError(null);
      },
      submit: () => latest.current.submit(),
      openAsSpace: () => latest.current.openResultAsSpace(),
      close: () => latest.current.onOpenChange(false),
    };
    return registerWorktreeBridge(bridge);
  }, [open]);

  const close = useCallback(() => {
    if (creating) return;
    onOpenChange(false);
  }, [creating, onOpenChange]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && creating) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <WorktreeDialogBody
          form={form}
          local={local}
          native={preflight?.problems ?? []}
          plannedPath={preflight?.path ?? null}
          collision={preflight?.collision ?? null}
          checking={checking}
          creating={creating}
          error={error}
          result={result}
          repoRoot={repoRoot}
          onField={(field, value) => {
            setForm((current) => ({ ...current, [field]: value }));
            setError(null);
          }}
          onSubmit={() => void submit()}
          onOpenAsSpace={() => void openResultAsSpace()}
          onClose={close}
        />
      </DialogContent>
    </Dialog>
  );
}

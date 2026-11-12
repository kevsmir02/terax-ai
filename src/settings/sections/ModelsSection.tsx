import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  type CustomEndpoint,
  compatModelIdForEndpoint,
  DEFAULT_MODEL_ID,
  getModel,
  MODELS,
  type ModelId,
  PROVIDERS,
  type ProviderId,
  type ProviderInfo,
  providerNeedsKey,
} from "@/modules/ai/config";
import {
  type CustomEndpointKeys,
  clearCustomEndpointKey,
  clearKey,
  getAllCustomEndpointKeys,
  getAllKeys,
  setCustomEndpointKey,
  setKey,
} from "@/modules/ai/lib/keyring";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  emitKeysChanged,
  setCustomEndpoints,
  setDefaultModel,
  setFavoriteModelIds,
  setLmstudioBaseURL,
  setLmstudioModelId,
  setMlxBaseURL,
  setMlxModelId,
  setOllamaBaseURL,
  setOllamaModelId,
  setOpenaiCompatibleBaseURL,
  setOpenaiCompatibleContextLimit,
  setOpenaiCompatibleModelId,
  setOpenrouterModelId,
  setRecentModelIds,
} from "@/modules/settings/store";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  ChevronDown,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ProviderIcon } from "../components/ProviderIcon";
import { ProviderKeyCard } from "../components/ProviderKeyCard";
import { SectionHeader } from "../components/SectionHeader";

type KeysMap = Record<ProviderId, string | null>;

const isLocalProvider = (id: ProviderId): boolean => !providerNeedsKey(id);

type LocalMeta = {
  urlPlaceholder: string;
  modelPlaceholder: string;
  description: string;
  modelHint: React.ReactNode;
};

const LOCAL_META: Partial<Record<ProviderId, LocalMeta>> = {
  lmstudio: {
    urlPlaceholder: "http://localhost:1234/v1",
    modelPlaceholder: "qwen2.5-coder-7b-instruct",
    description:
      "Run GGUF models via LM Studio's HTTP server (Developer tab → enable).",
    modelHint: (
      <>
        The model id loaded in LM Studio — see the server's{" "}
        <span className="font-mono">/v1/models</span> page.
      </>
    ),
  },
  mlx: {
    urlPlaceholder: "http://127.0.0.1:8080/v1",
    modelPlaceholder: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
    description:
      "Apple-silicon inference via mlx_lm.server (pip install mlx-lm).",
    modelHint: <>The Hugging Face repo path you launched mlx_lm.server with.</>,
  },
  ollama: {
    urlPlaceholder: "http://localhost:11434/v1",
    modelPlaceholder: "qwen2.5-coder:7b",
    description: "Local models via Ollama's built-in OpenAI-compatible API.",
    modelHint: <>The model name from `ollama list` / `ollama pull`.</>,
  },
  "openai-compatible": {
    urlPlaceholder: "https://api.example.com/v1",
    modelPlaceholder: "gpt-4o, qwen3-max, glm-4.6, …",
    description: "Any OpenAI-compatible endpoint — vLLM, Z.AI, Fireworks, etc.",
    modelHint: null,
  },
  openrouter: {
    urlPlaceholder: "",
    modelPlaceholder: "anthropic/claude-sonnet-5, openai/gpt-5.6, …",
    description: "Any model on OpenRouter — type its full provider/model id.",
    modelHint: (
      <>
        Browse ids at <span className="font-mono">openrouter.ai/models</span>.
      </>
    ),
  },
};

function reportCredentialRemovalError(error: unknown): void {
  toast.error("Could not remove credential", { description: String(error) });
}

function reportPartialRemovalError(error: unknown): void {
  toast.error("Credential removed; settings may be incomplete", {
    description: String(error),
  });
}

export function ModelsSection() {
  const [keys, setKeys] = useState<KeysMap | null>(null);
  const [epKeys, setEpKeys] = useState<CustomEndpointKeys>({});
  const [adding, setAdding] = useState<Set<ProviderId>>(new Set());

  const defaultModel = usePreferencesStore((s) => s.defaultModelId);
  const lmstudioBaseURL = usePreferencesStore((s) => s.lmstudioBaseURL);
  const lmstudioModelId = usePreferencesStore((s) => s.lmstudioModelId);
  const mlxBaseURL = usePreferencesStore((s) => s.mlxBaseURL);
  const mlxModelId = usePreferencesStore((s) => s.mlxModelId);
  const ollamaBaseURL = usePreferencesStore((s) => s.ollamaBaseURL);
  const ollamaModelId = usePreferencesStore((s) => s.ollamaModelId);
  const compatBaseURL = usePreferencesStore((s) => s.openaiCompatibleBaseURL);
  const compatModelId = usePreferencesStore((s) => s.openaiCompatibleModelId);
  const compatContextLimit = usePreferencesStore(
    (s) => s.openaiCompatibleContextLimit,
  );
  const openrouterModelId = usePreferencesStore((s) => s.openrouterModelId);
  const customEndpoints = usePreferencesStore((s) => s.customEndpoints);

  useEffect(() => {
    void getAllKeys().then(setKeys);
  }, []);

  useEffect(() => {
    void getAllCustomEndpointKeys(customEndpoints).then(setEpKeys);
  }, [customEndpoints]);

  const onSaveKey = async (provider: ProviderId, value: string) => {
    await setKey(provider, value);
    setKeys((prev) => (prev ? { ...prev, [provider]: value } : prev));
    await emitKeysChanged();
  };

  const onClearKey = async (provider: ProviderId) => {
    await clearKey(provider);
    setKeys((prev) => (prev ? { ...prev, [provider]: null } : prev));
    await emitKeysChanged().catch(reportPartialRemovalError);
  };

  const onSaveEndpointKey = async (endpointId: string, value: string) => {
    await setCustomEndpointKey(endpointId, value);
    setEpKeys((prev) => ({ ...prev, [endpointId]: value }));
    await emitKeysChanged();
  };

  const onClearEndpointKey = async (endpointId: string) => {
    await clearCustomEndpointKey(endpointId);
    setEpKeys((prev) => ({ ...prev, [endpointId]: null }));
    await emitKeysChanged().catch(reportPartialRemovalError);
  };

  const addCustomEndpoint = async () => {
    const ep: CustomEndpoint = {
      id: crypto.randomUUID().slice(0, 8),
      name: "",
      baseURL: "",
      modelId: "",
      contextLimit: 128_000,
    };
    await setCustomEndpoints([...customEndpoints, ep]);
  };

  const updateCustomEndpoint = async (
    id: string,
    patch: Partial<CustomEndpoint>,
  ) => {
    await setCustomEndpoints(
      customEndpoints.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    );
  };

  const removeCustomEndpoint = async (id: string) => {
    await clearCustomEndpointKey(id);
    setEpKeys((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

    try {
      // Finish history cleanup before resetting the selection, which can add
      // to recents. A failed write must not prevent removal of the endpoint.
      const deadModelId = compatModelIdForEndpoint(id);
      const { favoriteModelIds, recentModelIds } =
        usePreferencesStore.getState();
      const history = await Promise.allSettled([
        ...(favoriteModelIds.includes(deadModelId)
          ? [
              setFavoriteModelIds(
                favoriteModelIds.filter((m) => m !== deadModelId),
              ),
            ]
          : []),
        ...(recentModelIds.includes(deadModelId)
          ? [setRecentModelIds(recentModelIds.filter((m) => m !== deadModelId))]
          : []),
      ]);
      const remaining = customEndpoints.filter((e) => e.id !== id);
      const { selectedModelId, setSelectedModelId } = useChatStore.getState();
      if (selectedModelId === deadModelId) {
        setSelectedModelId(
          remaining[0]
            ? compatModelIdForEndpoint(remaining[0].id)
            : DEFAULT_MODEL_ID,
        );
      }
      const cleanup = await Promise.allSettled([
        setCustomEndpoints(remaining),
        emitKeysChanged(),
      ]);
      const failed = [...history, ...cleanup].find(
        (result) => result.status === "rejected",
      );
      if (failed) throw failed.reason;
    } catch (error) {
      reportPartialRemovalError(error);
    }
  };

  const localConfig = (id: ProviderId): LocalConfig | null => {
    switch (id) {
      case "lmstudio":
        return {
          baseURL: lmstudioBaseURL,
          modelId: lmstudioModelId,
          setBaseURL: setLmstudioBaseURL,
          setModelId: setLmstudioModelId,
        };
      case "mlx":
        return {
          baseURL: mlxBaseURL,
          modelId: mlxModelId,
          setBaseURL: setMlxBaseURL,
          setModelId: setMlxModelId,
        };
      case "ollama":
        return {
          baseURL: ollamaBaseURL,
          modelId: ollamaModelId,
          setBaseURL: setOllamaBaseURL,
          setModelId: setOllamaModelId,
        };
      case "openai-compatible":
        return {
          baseURL: compatBaseURL,
          modelId: compatModelId,
          setBaseURL: setOpenaiCompatibleBaseURL,
          setModelId: setOpenaiCompatibleModelId,
          contextLimit: compatContextLimit,
          setContextLimit: setOpenaiCompatibleContextLimit,
        };
      case "openrouter":
        return {
          baseURL: "",
          modelId: openrouterModelId,
          setBaseURL: async () => {},
          setModelId: setOpenrouterModelId,
          noBaseURL: true,
        };
      default:
        return null;
    }
  };

  const isConfigured = (id: ProviderId): boolean => {
    if (id === "openrouter") return !!keys?.[id] && !!openrouterModelId.trim();
    if (!isLocalProvider(id)) return !!keys?.[id];
    const cfg = localConfig(id);
    if (!cfg) return false;
    if (id === "openai-compatible")
      return !!cfg.baseURL.trim() && !!cfg.modelId.trim();
    return !!cfg.modelId.trim();
  };

  if (!keys) {
    return <div className="text-[12px] text-muted-foreground">Loading…</div>;
  }

  const configuredIds = new Set(
    PROVIDERS.filter((p) => isConfigured(p.id)).map((p) => p.id),
  );
  const visibleIds = new Set<ProviderId>(configuredIds);
  for (const id of adding) visibleIds.add(id);
  const visibleProviders = PROVIDERS.filter(
    (p) => p.id !== "openai-compatible" && visibleIds.has(p.id),
  );
  const addableProviders = PROVIDERS.filter(
    (p) => p.id !== "openai-compatible" && !visibleIds.has(p.id),
  );

  const removeProvider = async (id: ProviderId) => {
    await onClearKey(id);
    try {
      if (id === "openrouter") {
        await setOpenrouterModelId("");
      } else if (isLocalProvider(id)) {
        const cfg = localConfig(id);
        if (cfg) {
          await cfg.setModelId("");
          if (id === "openai-compatible") await cfg.setBaseURL("");
        }
      }
      setAdding((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (error) {
      reportPartialRemovalError(error);
    }
  };

  const addProvider = (id: ProviderId) => {
    setAdding((prev) => new Set(prev).add(id));
  };

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader
        title="Models"
        description="Connect the providers you use. Keys live in your OS keychain and are used only by Terax."
      />

      <DefaultsBlock
        defaultModel={defaultModel}
        configuredIds={configuredIds}
      />

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <Label>Providers</Label>
          <AddProviderMenu
            providers={addableProviders}
            onAdd={addProvider}
            onAddCompat={addCustomEndpoint}
          />
        </div>

        {visibleProviders.length === 0 && customEndpoints.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-card/40 px-4 py-8 text-center">
            <p className="text-[12px] text-muted-foreground">
              No providers connected yet.
            </p>
            <p className="mt-0.5 text-[10.5px] text-muted-foreground/70">
              Click "Add provider" to connect a cloud or local model source.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {visibleProviders.map((p) =>
              p.id === "openrouter" ? (
                <LocalProviderCard
                  key={p.id}
                  provider={p}
                  configured={configuredIds.has(p.id)}
                  config={localConfig(p.id)!}
                  meta={LOCAL_META[p.id]!}
                  compatKey={keys[p.id]}
                  onSaveKey={(v) => onSaveKey(p.id, v)}
                  onClearKey={() =>
                    onClearKey(p.id).catch(reportCredentialRemovalError)
                  }
                  onRemove={() =>
                    removeProvider(p.id).catch(reportCredentialRemovalError)
                  }
                />
              ) : isLocalProvider(p.id) ? (
                <LocalProviderCard
                  key={p.id}
                  provider={p}
                  configured={configuredIds.has(p.id)}
                  config={localConfig(p.id)!}
                  meta={LOCAL_META[p.id]!}
                  onSaveKey={(v) => onSaveKey(p.id, v)}
                  onClearKey={() =>
                    onClearKey(p.id).catch(reportCredentialRemovalError)
                  }
                  onRemove={() =>
                    removeProvider(p.id).catch(reportCredentialRemovalError)
                  }
                />
              ) : (
                <ProviderKeyCard
                  key={p.id}
                  provider={p}
                  currentKey={keys[p.id]}
                  onSave={(v) => onSaveKey(p.id, v)}
                  onClear={() =>
                    onClearKey(p.id).catch(reportCredentialRemovalError)
                  }
                  onRemove={() =>
                    removeProvider(p.id).catch(reportCredentialRemovalError)
                  }
                />
              ),
            )}
            {customEndpoints.map((ep) => (
              <CustomEndpointCard
                key={ep.id}
                endpoint={ep}
                endpointKey={epKeys[ep.id] ?? null}
                onSaveKey={(v) => onSaveEndpointKey(ep.id, v)}
                onClearKey={() =>
                  onClearEndpointKey(ep.id).catch(reportCredentialRemovalError)
                }
                onUpdate={(patch) => updateCustomEndpoint(ep.id, patch)}
                onRemove={() =>
                  removeCustomEndpoint(ep.id).catch(
                    reportCredentialRemovalError,
                  )
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

type LocalConfig = {
  baseURL: string;
  modelId: string;
  setBaseURL: (v: string) => Promise<void>;
  setModelId: (v: string) => Promise<void>;
  contextLimit?: number;
  setContextLimit?: (v: number) => Promise<void>;
  noBaseURL?: boolean;
};

function AddProviderMenu({
  providers,
  onAdd,
  onAddCompat,
}: {
  providers: readonly ProviderInfo[];
  onAdd: (id: ProviderId) => void;
  onAddCompat: () => void;
}) {
  const cloud = providers.filter((p) => !isLocalProvider(p.id));
  const local = providers.filter(
    (p) => isLocalProvider(p.id) && p.id !== "openai-compatible",
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2.5 text-[11px]"
        >
          <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />
          Add provider
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-55 p-1">
        {cloud.length > 0 ? (
          <>
            <DropdownMenuLabel className="px-2 text-[10px] tracking-wide text-muted-foreground uppercase">
              Cloud
            </DropdownMenuLabel>
            {cloud.map((p) => (
              <ProviderMenuItem key={p.id} provider={p} onAdd={onAdd} />
            ))}
          </>
        ) : null}
        <DropdownMenuLabel className="px-2 text-[10px] tracking-wide text-muted-foreground uppercase">
          Local & custom
        </DropdownMenuLabel>
        {local.map((p) => (
          <ProviderMenuItem key={p.id} provider={p} onAdd={onAdd} />
        ))}
        <DropdownMenuItem
          onSelect={() => onAddCompat()}
          className="flex items-center gap-2 text-[12px]"
        >
          <ProviderIcon provider="openai-compatible" size={13} />
          <span>OpenAI Compatible</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProviderMenuItem({
  provider,
  onAdd,
}: {
  provider: ProviderInfo;
  onAdd: (id: ProviderId) => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={() => onAdd(provider.id)}
      className="flex items-center gap-2 text-[12px]"
    >
      <ProviderIcon provider={provider.id} size={13} />
      <span>{provider.label}</span>
    </DropdownMenuItem>
  );
}

function DefaultsBlock({
  defaultModel,
  configuredIds,
}: {
  defaultModel: ModelId;
  configuredIds: Set<ProviderId>;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Label>Defaults</Label>
      <div className="flex flex-col gap-2.5 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
        <FieldRow label="Chat model">
          <DefaultModelPicker
            defaultModel={defaultModel}
            configuredIds={configuredIds}
          />
        </FieldRow>
      </div>
    </div>
  );
}

function DefaultModelPicker({
  defaultModel,
  configuredIds,
}: {
  defaultModel: ModelId;
  configuredIds: Set<ProviderId>;
}) {
  const m = getModel(defaultModel);
  const hasAny = configuredIds.size > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          disabled={!hasAny}
          className="h-8 flex-1 justify-between gap-2 px-2.5 text-[11.5px]"
        >
          <span className="flex items-center gap-2 truncate">
            <ProviderIcon provider={m.provider} size={13} />
            <span className="truncate">{m.label}</span>
            <span className="text-muted-foreground">· {m.hint}</span>
          </span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={11}
            strokeWidth={2}
            className="opacity-70"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={6}
        collisionPadding={12}
        className="min-w-70 p-1"
      >
        <div className="max-h-72 overflow-y-auto overscroll-contain pr-1">
          {PROVIDERS.filter((p) => configuredIds.has(p.id)).map((p) => {
            const models = MODELS.filter((x) => x.provider === p.id);
            if (models.length === 0) return null;
            return (
              <div key={p.id} className="px-1 pt-1.5 first:pt-1">
                <div className="mb-0.5 flex items-center gap-1.5 px-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  <ProviderIcon provider={p.id} size={11} />
                  <span>{p.label}</span>
                </div>
                {models.map((mod) => (
                  <DropdownMenuItem
                    key={mod.id}
                    onSelect={() => void setDefaultModel(mod.id as ModelId)}
                    className={cn(
                      "flex items-start gap-2 text-[12px]",
                      mod.id === defaultModel && "bg-accent/50",
                    )}
                  >
                    <span className="flex flex-1 flex-col">
                      <span>{mod.label}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {mod.description}
                      </span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </div>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LocalProviderCard({
  provider,
  configured,
  config,
  meta,
  compatKey,
  onSaveKey,
  onClearKey,
  onRemove,
}: {
  provider: ProviderInfo;
  configured: boolean;
  config: LocalConfig;
  meta: LocalMeta;
  compatKey?: string | null;
  onSaveKey: (v: string) => Promise<void>;
  onClearKey: () => Promise<void>;
  onRemove: () => void;
}) {
  const {
    baseURL,
    modelId,
    setBaseURL,
    setModelId,
    contextLimit,
    setContextLimit,
    noBaseURL,
  } = config;
  const [urlDraft, setUrlDraft] = useState(baseURL);
  const [modelDraft, setModelDraft] = useState(modelId);
  const [contextDraft, setContextDraft] = useState(String(contextLimit ?? ""));
  const [keyDraft, setKeyDraft] = useState("");
  const [testStatus, setTestStatus] = useState<
    "idle" | "testing" | "ok" | "fail"
  >("idle");

  useEffect(() => setUrlDraft(baseURL), [baseURL]);
  useEffect(() => setModelDraft(modelId), [modelId]);
  useEffect(() => setContextDraft(String(contextLimit ?? "")), [contextLimit]);

  const supportsKey =
    provider.id === "openai-compatible" || provider.id === "openrouter";

  const test = async () => {
    setTestStatus("testing");
    try {
      const status = await invoke<number>("lm_ping", { baseUrl: urlDraft });
      setTestStatus(status > 0 ? "ok" : "fail");
    } catch {
      setTestStatus("fail");
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ProviderIcon provider={provider.id} size={15} />
        <span className="text-[12.5px] font-medium">{provider.label}</span>
        {configured ? (
          <Badge
            variant="outline"
            className="ml-1 h-4 gap-1 border-border/60 bg-muted/40 px-1.5 text-[10px] font-normal text-muted-foreground"
          >
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              size={9}
              strokeWidth={2}
            />
            Connected
          </Badge>
        ) : null}
        <button
          type="button"
          onClick={() => void openUrl(provider.consoleUrl)}
          className="ml-auto inline-flex items-center gap-0.5 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
        >
          Docs
          <HugeiconsIcon
            icon={ArrowUpRight01Icon}
            size={11}
            strokeWidth={1.75}
          />
        </button>
        <Button
          size="icon"
          variant="ghost"
          onClick={onRemove}
          title="Remove provider"
          className="size-7 text-muted-foreground hover:text-destructive"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
        </Button>
      </div>

      <span className="text-[10.5px] leading-relaxed text-muted-foreground">
        {meta.description}
      </span>

      <div className="mt-0.5 flex flex-col gap-2.5">
        {noBaseURL ? null : (
          <FieldRow label="Base URL">
            <div className="flex flex-1 gap-1.5">
              <Input
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                onBlur={() => {
                  const v = urlDraft.trim();
                  if (v !== baseURL) void setBaseURL(v);
                }}
                placeholder={meta.urlPlaceholder}
                spellCheck={false}
                className="h-8 flex-1 font-mono text-[11.5px]"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => void test()}
                disabled={!urlDraft.trim()}
                className="h-8 px-3 text-[11px]"
              >
                Test
              </Button>
            </div>
          </FieldRow>
        )}

        <FieldRow label="Model ID">
          <Input
            value={modelDraft}
            onChange={(e) => setModelDraft(e.target.value)}
            onBlur={() => {
              const v = modelDraft.trim();
              if (v !== modelId) void setModelId(v);
            }}
            placeholder={meta.modelPlaceholder}
            spellCheck={false}
            className="h-8 font-mono text-[11.5px]"
          />
        </FieldRow>

        {setContextLimit ? (
          <FieldRow label="Context">
            <div className="flex flex-1 items-center gap-1.5">
              <Input
                value={contextDraft}
                onChange={(e) => setContextDraft(e.target.value)}
                onBlur={() => {
                  const v = parseInt(contextDraft);
                  if (Number.isFinite(v) && v >= 1000) void setContextLimit(v);
                  else setContextDraft(String(contextLimit ?? ""));
                }}
                placeholder="128000"
                spellCheck={false}
                className="h-8 w-28 font-mono text-[11.5px]"
              />
              <span className="text-[10.5px] text-muted-foreground">
                tokens
              </span>
            </div>
          </FieldRow>
        ) : null}

        {supportsKey ? (
          <FieldRow label="API key">
            {compatKey ? (
              <div className="flex flex-1 items-center gap-1.5">
                <code className="flex-1 truncate rounded bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                  {`${compatKey.slice(0, 4)}${"•".repeat(8)}${compatKey.slice(-4)}`}
                </code>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => void onClearKey()}
                  title="Remove key"
                  className="size-7 text-muted-foreground hover:text-destructive"
                >
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    size={12}
                    strokeWidth={1.75}
                  />
                </Button>
              </div>
            ) : (
              <div className="flex flex-1 gap-1.5">
                <Input
                  type="password"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder="Optional — leave empty for unauthenticated endpoints"
                  spellCheck={false}
                  className="h-8 flex-1 font-mono text-[11.5px]"
                />
                <Button
                  size="sm"
                  onClick={async () => {
                    const v = keyDraft.trim();
                    if (!v) return;
                    await onSaveKey(v);
                    setKeyDraft("");
                  }}
                  disabled={!keyDraft.trim()}
                  className="h-8 px-3 text-[11px]"
                >
                  Save
                </Button>
              </div>
            )}
          </FieldRow>
        ) : null}

        <StatusLine status={testStatus} />

        {!modelId.trim() && meta.modelHint ? (
          <p className="text-[10.5px] leading-relaxed text-muted-foreground">
            {meta.modelHint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function CustomEndpointCard({
  endpoint,
  endpointKey,
  onSaveKey,
  onClearKey,
  onUpdate,
  onRemove,
}: {
  endpoint: CustomEndpoint;
  endpointKey: string | null;
  onSaveKey: (v: string) => Promise<void>;
  onClearKey: () => Promise<void>;
  onUpdate: (patch: Partial<CustomEndpoint>) => Promise<void>;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(!endpoint.baseURL.trim());
  const [nameDraft, setNameDraft] = useState(endpoint.name);
  const [urlDraft, setUrlDraft] = useState(endpoint.baseURL);
  const [modelDraft, setModelDraft] = useState(endpoint.modelId);
  const [contextDraft, setContextDraft] = useState(
    String(endpoint.contextLimit ?? ""),
  );
  const [keyDraft, setKeyDraft] = useState("");
  const [testStatus, setTestStatus] = useState<
    "idle" | "testing" | "ok" | "fail"
  >("idle");

  useEffect(() => setNameDraft(endpoint.name), [endpoint.name]);
  useEffect(() => setUrlDraft(endpoint.baseURL), [endpoint.baseURL]);
  useEffect(() => setModelDraft(endpoint.modelId), [endpoint.modelId]);
  useEffect(
    () => setContextDraft(String(endpoint.contextLimit ?? "")),
    [endpoint.contextLimit],
  );

  const configured = !!endpoint.baseURL.trim() && !!endpoint.modelId.trim();

  const test = async () => {
    setTestStatus("testing");
    try {
      const status = await invoke<number>("lm_ping", { baseUrl: urlDraft });
      setTestStatus(status > 0 ? "ok" : "fail");
    } catch {
      setTestStatus("fail");
    }
  };

  return (
    <div className="flex flex-col rounded-lg border border-border/60 bg-card/60">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 px-3 py-2 text-left"
      >
        <HugeiconsIcon
          icon={ChevronDown}
          size={12}
          strokeWidth={2}
          className={cn(
            "shrink-0 text-muted-foreground/60 transition-transform",
            !expanded && "-rotate-90",
          )}
        />
        <ProviderIcon provider="openai-compatible" size={15} />
        <span className="text-[12.5px] font-medium truncate">
          {endpoint.name || "OpenAI Compatible"}
        </span>
        {endpoint.modelId.trim() && (
          <span className="text-[10.5px] text-muted-foreground truncate font-mono">
            {endpoint.modelId}
          </span>
        )}
        {configured ? (
          <Badge
            variant="outline"
            className="ml-1 h-4 gap-1 border-border/60 bg-muted/40 px-1.5 text-[10px] font-normal text-muted-foreground"
          >
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              size={9}
              strokeWidth={2}
            />
            Connected
          </Badge>
        ) : null}
        <Button
          size="icon"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          title="Remove endpoint"
          className="ml-auto size-7 text-muted-foreground hover:text-destructive"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
        </Button>
      </button>

      {expanded && (
        <div className="flex flex-col gap-2.5 border-t border-border/40 px-3 py-2.5">
          <FieldRow label="Name">
            <Input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => {
                const v = nameDraft.trim();
                if (v !== endpoint.name) void onUpdate({ name: v });
              }}
              placeholder="My endpoint"
              spellCheck={false}
              className="h-8 flex-1 text-[11.5px]"
            />
          </FieldRow>

          <FieldRow label="Base URL">
            <div className="flex flex-1 gap-1.5">
              <Input
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                onBlur={() => {
                  const v = urlDraft.trim();
                  if (v !== endpoint.baseURL) void onUpdate({ baseURL: v });
                }}
                placeholder="https://api.example.com/v1"
                spellCheck={false}
                className="h-8 flex-1 font-mono text-[11.5px]"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => void test()}
                disabled={!urlDraft.trim()}
                className="h-8 px-3 text-[11px]"
              >
                Test
              </Button>
            </div>
          </FieldRow>

          <FieldRow label="Model ID">
            <Input
              value={modelDraft}
              onChange={(e) => setModelDraft(e.target.value)}
              onBlur={() => {
                const v = modelDraft.trim();
                if (v !== endpoint.modelId) void onUpdate({ modelId: v });
              }}
              placeholder="gpt-4o, qwen3-max, glm-4.6, …"
              spellCheck={false}
              className="h-8 font-mono text-[11.5px]"
            />
          </FieldRow>

          <FieldRow label="Context">
            <div className="flex flex-1 items-center gap-1.5">
              <Input
                value={contextDraft}
                onChange={(e) => setContextDraft(e.target.value)}
                onBlur={() => {
                  const v = parseInt(contextDraft);
                  if (Number.isFinite(v) && v >= 1000)
                    void onUpdate({ contextLimit: v });
                  else setContextDraft(String(endpoint.contextLimit ?? ""));
                }}
                placeholder="128000"
                spellCheck={false}
                className="h-8 w-28 font-mono text-[11.5px]"
              />
              <span className="text-[10.5px] text-muted-foreground">
                tokens
              </span>
            </div>
          </FieldRow>

          <FieldRow label="API key">
            {endpointKey ? (
              <div className="flex flex-1 items-center gap-1.5">
                <code className="flex-1 truncate rounded bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                  {`${endpointKey.slice(0, 4)}${"•".repeat(8)}${endpointKey.slice(-4)}`}
                </code>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => void onClearKey()}
                  title="Remove key"
                  className="size-7 text-muted-foreground hover:text-destructive"
                >
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    size={12}
                    strokeWidth={1.75}
                  />
                </Button>
              </div>
            ) : (
              <div className="flex flex-1 gap-1.5">
                <Input
                  type="password"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder="Optional — leave empty for unauthenticated endpoints"
                  spellCheck={false}
                  className="h-8 flex-1 font-mono text-[11.5px]"
                />
                <Button
                  size="sm"
                  onClick={async () => {
                    const v = keyDraft.trim();
                    if (!v) return;
                    await onSaveKey(v);
                    setKeyDraft("");
                  }}
                  disabled={!keyDraft.trim()}
                  className="h-8 px-3 text-[11px]"
                >
                  Save
                </Button>
              </div>
            )}
          </FieldRow>

          <StatusLine status={testStatus} />
        </div>
      )}
    </div>
  );
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-[11px] tracking-tight text-muted-foreground">
        {label}
      </span>
      <div className="flex flex-1 items-center">{children}</div>
    </div>
  );
}

function StatusLine({
  status,
}: {
  status: "idle" | "testing" | "ok" | "fail";
}) {
  if (status === "idle") return null;
  if (status === "testing") {
    return (
      <span className="text-[10.5px] text-muted-foreground">Testing…</span>
    );
  }
  if (status === "ok") {
    return (
      <span className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
        <HugeiconsIcon icon={CheckmarkCircle02Icon} size={11} strokeWidth={2} />
        Reachable — server responded.
      </span>
    );
  }
  return (
    <span className="text-[10.5px] text-destructive/80">
      Could not reach the server.
    </span>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}

import { fetchJson, useApi, postApi } from "../hooks/use-api";
import { copyTextToClipboard } from "../lib/chapter-text";
import { cloneElement, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import type { Theme } from "../hooks/use-theme";
import type { StringKey, TFunction } from "../hooks/use-i18n";
import { useNewSSEMessages, type SSEMessage } from "../hooks/use-sse";
import { useColors } from "../hooks/use-colors";
import { deriveBookActivity, shouldRefetchBookView } from "../hooks/use-book-activity";
import { ConfirmDialog } from "../components/ConfirmDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { chaptersNewestFirst } from "../lib/chapter-list";
import { genreCategoriesForLanguage, joinGenre, splitGenre, type GenreParts } from "../lib/genre";
import { GenreFields } from "../components/GenreFields";
import { cn } from "../lib/utils";
import {
  ChevronDown,
  ChevronLeft,
  Zap,
  FileText,
  BarChart2,
  Download,
  Smartphone,
  Database,
  ShieldCheck,
  RotateCcw,
  RefreshCw,
  Sparkles,
  Trash2,
  Save,
  CircleAlert,
  Copy,
} from "lucide-react";

interface PhoneSyncStatusView {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly phase: "off" | "pending" | "syncing" | "synced" | "error" | "removing";
  readonly legadoUrl?: string;
  readonly chaptersSynced: number;
  readonly lastChanged?: number;
  readonly lastSyncedAt?: string;
  readonly error?: string;
  readonly retryAt?: string;
}

interface ChapterMeta {
  readonly number: number;
  readonly title: string;
  readonly wordCount: number;
  readonly observations: ReadonlyArray<{
    readonly code: string;
    readonly summary: string;
  }>;
  readonly provenance: "generated" | "imported" | "edited";
}

interface BookData {
  readonly book: {
    readonly id: string;
    readonly title: string;
    readonly genre: string;
    readonly platform?: string;
    readonly status: string;
    readonly chapterWordCount: number;
    readonly minChapterLength?: number;
    readonly maxChapterLength?: number;
    readonly targetChapters?: number;
    readonly language?: string;
    readonly fanficMode?: string;
  };
  readonly chapters: ReadonlyArray<ChapterMeta>;
  readonly nextChapter: number;
}

type ReviseMode = "spot-fix" | "polish" | "rewrite" | "rework" | "anti-detect";

const REVISE_MODES: ReadonlyArray<{
  readonly mode: ReviseMode;
  readonly label: StringKey;
  readonly tip: StringKey;
}> = [
  { mode: "spot-fix", label: "book.spotFix", tip: "book.spotFixTip" },
  { mode: "polish", label: "book.polish", tip: "book.polishTip" },
  { mode: "rewrite", label: "book.rewrite", tip: "book.rewriteTip" },
  { mode: "rework", label: "book.rework", tip: "book.reworkTip" },
  { mode: "anti-detect", label: "book.antiDetect", tip: "book.antiDetectTip" },
];

const CHAPTER_ACTION_BUTTON_CLASS =
  "p-2 rounded-lg bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all shadow-sm";
type ExportFormat = "txt" | "md" | "epub";
type BookStatus = "active" | "paused" | "outlining" | "completed" | "dropped";

interface Nav {
  toDashboard: () => void;
  toChapter: (bookId: string, num: number) => void;
  toAnalytics: (bookId: string) => void;
  toTruth: (bookId: string) => void;
}

export function BookDetail({
  bookId,
  nav,
  theme,
  t,
  sse,
}: {
  bookId: string;
  nav: Nav;
  theme: Theme;
  t: TFunction;
  sse: { messages: ReadonlyArray<SSEMessage> };
}) {
  const c = useColors(theme);
  const { data, loading, error, refetch } = useApi<BookData>(`/books/${bookId}`);
  const [writeRequestPending, setWriteRequestPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [rewritingChapters, setRewritingChapters] = useState<ReadonlyArray<number>>([]);
  const [revisingChapters, setRevisingChapters] = useState<ReadonlyArray<number>>([]);
  const [syncingChapters, setSyncingChapters] = useState<ReadonlyArray<number>>([]);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsWordCount, setSettingsWordCount] = useState<number | null>(null);
  const [settingsMinChapterLength, setSettingsMinChapterLength] = useState<number | null>(null);
  const [settingsMaxChapterLength, setSettingsMaxChapterLength] = useState<number | null>(null);
  const [settingsMinChapterLengthCleared, setSettingsMinChapterLengthCleared] = useState(false);
  const [settingsMaxChapterLengthCleared, setSettingsMaxChapterLengthCleared] = useState(false);
  const [settingsTargetChapters, setSettingsTargetChapters] = useState<number | null>(null);
  const [settingsStatus, setSettingsStatus] = useState<BookStatus | null>(null);
  const [settingsGenre, setSettingsGenre] = useState<GenreParts | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("txt");
  const [bookActionPending, setBookActionPending] = useState<string | null>(null);
  const [phoneStatus, setPhoneStatus] = useState<PhoneSyncStatusView | null>(null);
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneNotice, setPhoneNotice] = useState<string | null>(null);
  const [phoneCopy, setPhoneCopy] = useState<"copied" | "failed" | null>(null);
  const activity = useMemo(() => deriveBookActivity(sse.messages, bookId), [bookId, sse.messages]);
  const writing = writeRequestPending || activity.writing;
  const latestPersistedChapter = data ? data.nextChapter - 1 : 0;

  useEffect(() => {
    const recent = sse.messages.at(-1);
    if (!recent) return;

    const data = recent.data as { bookId?: string } | null;
    if (data?.bookId !== bookId) return;

    if (recent.event === "write:start") {
      setWriteRequestPending(false);
      return;
    }

    if (shouldRefetchBookView(recent, bookId)) {
      setWriteRequestPending(false);
      refetch();
    }
  }, [bookId, refetch, sse.messages]);

  const handleWriteNext = async () => {
    setWriteRequestPending(true);
    try {
      await postApi(`/books/${bookId}/write-next`);
    } catch (e) {
      setWriteRequestPending(false);
      alert(e instanceof Error ? e.message : "Failed");
    }
  };

  const handleDeleteBook = async () => {
    setConfirmDeleteOpen(false);
    setDeleting(true);
    try {
      const res = await fetch(`/api/v1/books/${bookId}`, { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? `${res.status}`);
      }
      nav.toDashboard();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  const handleRewrite = async (chapterNum: number) => {
    const brief = window.prompt(
      data?.book.language === "en"
        ? "Optional rewrite brief for this run only. Leave blank to use existing focus."
        : "可选：输入这次重写要遵循的补充想法。留空则沿用现有 focus。",
      "",
    );
    if (brief === null) return;
    setRewritingChapters((prev) => [...prev, chapterNum]);
    try {
      await fetchJson(`/books/${bookId}/rewrite/${chapterNum}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: brief.trim() || undefined }),
      });
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Rewrite failed");
    } finally {
      setRewritingChapters((prev) => prev.filter((n) => n !== chapterNum));
    }
  };

  const handleRevise = async (chapterNum: number, mode: ReviseMode) => {
    const brief = window.prompt(
      mode === "spot-fix" ? t("book.spotFixBriefPrompt") : t("book.reviseBriefPrompt"),
      "",
    );
    if (brief === null) return;
    setRevisingChapters((prev) => [...prev, chapterNum]);
    try {
      await fetchJson(`/books/${bookId}/revise/${chapterNum}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, brief: brief.trim() || undefined }),
      });
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Revision failed");
    } finally {
      setRevisingChapters((prev) => prev.filter((n) => n !== chapterNum));
    }
  };

  const handleSync = async (chapterNum: number) => {
    const brief = window.prompt(
      data?.book.language === "en"
        ? "Optional sync brief for interpreting the edited chapter body. Leave blank to sync directly from the text."
        : "可选：输入这次同步时要遵循的补充说明。留空则直接按正文同步。",
      "",
    );
    if (brief === null) return;
    setSyncingChapters((prev) => [...prev, chapterNum]);
    try {
      await fetchJson(`/books/${bookId}/resync/${chapterNum}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: brief.trim() || undefined }),
      });
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncingChapters((prev) => prev.filter((n) => n !== chapterNum));
    }
  };

  const handleSaveSettings = async () => {
    if (!data) return;
    const target = settingsWordCount ?? data.book.chapterWordCount;
    const min = settingsMinChapterLengthCleared
      ? undefined
      : settingsMinChapterLength ?? data.book.minChapterLength;
    const max = settingsMaxChapterLengthCleared
      ? undefined
      : settingsMaxChapterLength ?? data.book.maxChapterLength;
    if (
      (min !== undefined && max !== undefined && min > max)
      || (min !== undefined && target < min)
      || (max !== undefined && target > max)
    ) {
      alert(t("book.chapterLengthRangeInvalid"));
      return;
    }
    const genre = settingsGenre ? joinGenre(settingsGenre) : undefined;
    if (settingsGenre && !genre) {
      alert(t("book.genreCategoryRequired"));
      return;
    }
    setSavingSettings(true);
    try {
      const body: Record<string, unknown> = {};
      if (genre) body.genre = genre;
      if (settingsWordCount !== null) body.chapterWordCount = settingsWordCount;
      if (settingsMinChapterLengthCleared) body.minChapterLength = null;
      else if (settingsMinChapterLength !== null) body.minChapterLength = settingsMinChapterLength;
      if (settingsMaxChapterLengthCleared) body.maxChapterLength = null;
      else if (settingsMaxChapterLength !== null) body.maxChapterLength = settingsMaxChapterLength;
      if (settingsTargetChapters !== null) body.targetChapters = settingsTargetChapters;
      if (settingsStatus !== null) body.status = settingsStatus;
      await fetchJson(`/books/${bookId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setSettingsMinChapterLengthCleared(false);
      setSettingsMaxChapterLengthCleared(false);
      setSettingsMinChapterLength(null);
      setSettingsMaxChapterLength(null);
      setSettingsGenre(null);
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingSettings(false);
    }
  };

  const runBookAction = async (key: string, action: () => Promise<string>) => {
    setBookActionPending(key);
    try {
      alert(await action());
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBookActionPending(null);
    }
  };

  const refreshPhoneStatus = useCallback(async () => {
    try {
      setPhoneStatus(await fetchJson<PhoneSyncStatusView>(`/books/${bookId}/phone-reader`));
    } catch {
      // The status icon is advisory; the button keeps working without it.
    }
  }, [bookId]);

  useEffect(() => {
    setPhoneStatus(null);
    setPhoneNotice(null);
    setPhoneCopy(null);
    void refreshPhoneStatus();
  }, [refreshPhoneStatus]);

  const handlePhoneSyncEvent = useCallback((message: SSEMessage) => {
    if (message.event !== "phone-sync:status") return;
    if ((message.data as { bookId?: string } | null)?.bookId !== bookId) return;
    void refreshPhoneStatus();
  }, [bookId, refreshPhoneStatus]);
  useNewSSEMessages(sse.messages, handlePhoneSyncEvent);

  const phoneActive = phoneStatus?.phase === "pending" || phoneStatus?.phase === "syncing" || phoneStatus?.phase === "removing";
  useEffect(() => {
    if (!phoneActive) return;
    const timer = window.setInterval(() => void refreshPhoneStatus(), 4000);
    return () => window.clearInterval(timer);
  }, [phoneActive, refreshPhoneStatus]);

  const phoneLocked = phoneBusy || phoneStatus?.phase === "syncing";

  const handlePhoneRead = useCallback(async () => {
    // Copy before any await: browsers only allow clipboard writes right after the click.
    const knownUrl = phoneStatus?.legadoUrl;
    const copying = knownUrl ? copyTextToClipboard(knownUrl) : null;
    setPhoneBusy(true);
    setPhoneNotice(null);
    try {
      const next = await fetchJson<PhoneSyncStatusView>(`/books/${bookId}/phone-reader`, { method: "POST" });
      setPhoneStatus(next);
      if (!next.configured) {
        setPhoneCopy(null);
        setPhoneNotice(t("book.phoneReadNotConfigured"));
        return;
      }
      const copied = copying ? await copying : next.legadoUrl ? await copyTextToClipboard(next.legadoUrl) : false;
      setPhoneCopy(copied ? "copied" : "failed");
    } catch (e) {
      setPhoneNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setPhoneBusy(false);
    }
  }, [bookId, phoneStatus?.legadoUrl, t]);

  const handleCopyPhoneLink = useCallback(async () => {
    if (!phoneStatus?.legadoUrl) return;
    setPhoneCopy((await copyTextToClipboard(phoneStatus.legadoUrl)) ? "copied" : "failed");
  }, [phoneStatus?.legadoUrl]);

  const handleStopPhoneRead = useCallback(async () => {
    setPhoneBusy(true);
    setPhoneNotice(null);
    setPhoneCopy(null);
    try {
      setPhoneStatus(await fetchJson<PhoneSyncStatusView>(`/books/${bookId}/phone-reader`, { method: "DELETE" }));
    } catch (e) {
      setPhoneNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setPhoneBusy(false);
    }
  }, [bookId]);

  const phoneTooltipText = useMemo(() => {
    const lines: string[] = [];
    if (phoneNotice) lines.push(phoneNotice);
    const status = phoneStatus;
    if (status && (status.enabled || status.phase === "removing")) {
      if (status.phase === "syncing") lines.push(t("book.phoneReadSyncing"));
      if (status.phase === "pending") lines.push(t("book.phoneReadPending"));
      if (status.phase === "removing") lines.push(t("book.phoneReadRemoving"));
      if (status.phase === "error") {
        lines.push(t("book.phoneReadFailed").replace("{error}", status.error ?? ""));
        if (status.retryAt) {
          lines.push(t("book.phoneReadRetry").replace("{time}", new Date(status.retryAt).toLocaleTimeString()));
        }
      }
      if (status.phase === "synced") {
        lines.push(t("book.phoneReadSynced")
          .replace("{time}", status.lastSyncedAt ? new Date(status.lastSyncedAt).toLocaleString() : "")
          .replace("{count}", String(status.chaptersSynced)));
        if (status.lastChanged) lines.push(t("book.phoneReadChanged").replace("{count}", String(status.lastChanged)));
      }
    }
    if (phoneCopy === "copied") lines.push(t("book.phoneReadCopied"));
    if (phoneCopy === "failed") lines.push(t("book.phoneReadCopyFailed"));
    if (lines.length > 0 && status?.enabled && status.legadoUrl) {
      lines.push(t("book.phoneReadSource").replace("{url}", status.legadoUrl));
    }
    return lines.join("\n");
  }, [phoneCopy, phoneNotice, phoneStatus, t]);

  const phoneIconClass = phoneNotice || phoneStatus?.phase === "error"
    ? "text-destructive"
    : phoneStatus?.phase === "synced"
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-amber-600 dark:text-amber-400";

  const handleReviseFoundation = async () => {
    const feedback = window.prompt(
      data?.book.language === "en"
        ? "Foundation revision feedback. This rewrites the book foundation, not chapter body."
        : "输入重修基础设定的反馈。此操作会重写基础设定，不直接改正文。",
      "",
    );
    if (!feedback?.trim()) return;
    await runBookAction("revise-foundation", async () => {
      await fetchJson(`/books/${bookId}/foundation/revise`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback }),
      });
      return data?.book.language === "en" ? "Foundation revised." : "基础设定已重修。";
    });
  };

  if (loading) return (
    <div className="flex flex-col items-center justify-center py-32 space-y-4">
      <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
      <span className="text-sm text-muted-foreground">{t("common.loading")}</span>
    </div>
  );

  if (error) return <div className="text-destructive p-8 bg-destructive/5 rounded-xl border border-destructive/20">Error: {error}</div>;
  if (!data) return null;

  const { book, chapters } = data;
  const displayedChapters = chaptersNewestFirst(chapters);
  const totalWords = chapters.reduce((sum, ch) => sum + (ch.wordCount ?? 0), 0);

  const currentWordCount = settingsWordCount ?? book.chapterWordCount;
  const currentMinChapterLength = settingsMinChapterLengthCleared
    ? ""
    : String(settingsMinChapterLength ?? book.minChapterLength ?? "");
  const currentMaxChapterLength = settingsMaxChapterLengthCleared
    ? ""
    : String(settingsMaxChapterLength ?? book.maxChapterLength ?? "");
  const currentTargetChapters = settingsTargetChapters ?? book.targetChapters ?? 0;
  const currentStatus = settingsStatus ?? (book.status as BookStatus);
  const bookLanguage = book.language === "en" ? "en" : "zh";
  const currentGenre = settingsGenre ?? splitGenre(book.genre, genreCategoriesForLanguage(bookLanguage));

  const exportHref = `/api/v1/books/${bookId}/export?format=${exportFormat}`;

  return (
    <div className="space-y-8 fade-in">
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
        <button
          onClick={nav.toDashboard}
          className="hover:text-primary transition-colors flex items-center gap-1"
        >
          <ChevronLeft size={14} />
          {t("bread.books")}
        </button>
        <span className="text-border">/</span>
        <span className="text-foreground">{book.title}</span>
      </nav>

      {/* Header Section */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-border/40 pb-8">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <h1 className="text-4xl font-serif font-medium">{book.title}</h1>
            {book.language === "en" && (
              <span className="px-1.5 py-0.5 rounded border border-primary/20 text-primary text-[10px] font-bold">EN</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground font-medium">
            <span className="px-2 py-0.5 rounded bg-secondary/50 text-foreground/70 uppercase tracking-wider text-xs">{book.genre}</span>
            <div className="flex items-center gap-1.5">
              <FileText size={14} />
              <span>{chapters.length} {t("dash.chapters")}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Zap size={14} />
              <span>{totalWords.toLocaleString()} {t("book.words")}</span>
            </div>
            {book.fanficMode && (
              <span className="flex items-center gap-1 text-purple-500">
                <Sparkles size={12} />
                <span className="italic">fanfic:{book.fanficMode}</span>
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={handleWriteNext}
            disabled={writing}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold bg-primary text-primary-foreground rounded-xl hover:scale-105 active:scale-95 transition-all shadow-lg shadow-primary/20 disabled:opacity-50"
          >
            {writing ? <div className="w-4 h-4 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Zap size={16} />}
            {writing ? t("dash.writing") : t("book.writeNext")}
          </button>
          <button
            onClick={() => setConfirmDeleteOpen(true)}
            disabled={deleting}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold bg-destructive/10 text-destructive rounded-xl hover:bg-destructive hover:text-white transition-all border border-destructive/20 disabled:opacity-50"
          >
            {deleting ? <div className="w-4 h-4 border-2 border-destructive/20 border-t-destructive rounded-full animate-spin" /> : <Trash2 size={16} />}
            {deleting ? t("common.loading") : t("book.deleteBook")}
          </button>
        </div>
      </div>

      {(writing || activity.lastError) && (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm ${
            activity.lastError
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "border-primary/20 bg-primary/[0.04] text-foreground"
          }`}
        >
          {activity.lastError ? (
            <span>
              {t("book.pipelineFailed")}: {activity.lastError}
            </span>
          ) : <span>{t("book.pipelineWriting")}</span>}
        </div>
      )}

      {/* Tool Strip */}
      <div className="flex flex-wrap items-center gap-2 py-1">
          <button
            onClick={() => nav.toTruth(bookId)}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50"
          >
            <Database size={14} />
            {t("book.truthFiles")}
          </button>
          <button
            onClick={() => nav.toAnalytics(bookId)}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50"
          >
            <BarChart2 size={14} />
            {t("book.analytics")}
          </button>
          <button
            onClick={handleReviseFoundation}
            disabled={bookActionPending === "revise-foundation"}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50 disabled:opacity-50"
          >
            <Sparkles size={14} />
            {bookActionPending === "revise-foundation" ? t("common.loading") : t("book.reviseFoundation")}
          </button>
          <div className="flex items-center gap-2">
            <select
              value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
              className="px-2 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg border border-border/50 outline-none"
            >
              <option value="txt">TXT</option>
              <option value="md">MD</option>
              <option value="epub">EPUB</option>
            </select>
            <button
              onClick={async () => {
                try {
                  const data = await fetchJson<{ path?: string; chapters?: number }>(`/books/${bookId}/export-save`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ format: exportFormat }),
                  });
                  alert(`${t("common.exportSuccess")}\n${data.path}\n(${data.chapters} ${t("dash.chapters")})`);
                } catch (e) {
                  alert(e instanceof Error ? e.message : "Export failed");
                }
              }}
              className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50"
            >
              <Download size={14} />
              {t("book.export")}
            </button>
            <TooltipProvider delay={200}>
              <div className="inline-flex items-stretch">
                {/* aria-disabled instead of disabled: a disabled button swallows hover, hiding the status tooltip. */}
                <button
                  type="button"
                  onClick={() => {
                    if (!phoneLocked) void handlePhoneRead();
                  }}
                  aria-disabled={phoneLocked}
                  title={phoneStatus?.enabled ? undefined : t("book.phoneReadEnableHint")}
                  className={cn(
                    "flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary transition-all border border-border/50",
                    phoneStatus?.configured ? "rounded-l-lg" : "rounded-lg",
                    phoneLocked && "opacity-60 cursor-default",
                  )}
                >
                  <Smartphone size={14} />
                  {phoneLocked ? t("book.phoneReadSyncing") : t("book.phoneRead")}
                  {phoneTooltipText ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span
                            role="img"
                            aria-label={phoneTooltipText}
                            className={cn("inline-flex rounded-sm p-0.5 -mr-1 cursor-help", phoneIconClass)}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                            }}
                          />
                        }
                      >
                        <CircleAlert size={13} strokeWidth={2.25} />
                      </TooltipTrigger>
                      <TooltipContent
                        side="bottom"
                        align="end"
                        className="max-w-md whitespace-pre-wrap text-xs leading-5"
                      >
                        {phoneTooltipText}
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                </button>
                {phoneStatus?.configured ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      aria-label={t("book.phoneReadMenu")}
                      className="flex items-center px-1.5 text-muted-foreground bg-secondary/50 rounded-r-lg border border-l-0 border-border/50 outline-none hover:text-foreground hover:bg-secondary transition-all cursor-pointer"
                    >
                      <ChevronDown size={12} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-auto min-w-48">
                      <DropdownMenuItem onClick={() => void handleCopyPhoneLink()}>
                        <Copy size={14} />
                        {t("book.phoneReadCopyLink")}
                      </DropdownMenuItem>
                      {phoneStatus.enabled ? (
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={phoneBusy}
                          onClick={() => void handleStopPhoneRead()}
                        >
                          <Trash2 size={14} />
                          {t("book.phoneReadStop")}
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>
            </TooltipProvider>
          </div>
      </div>

      {/* Book Settings */}
      <div className="paper-sheet rounded-2xl border border-border/40 shadow-sm p-6">
        <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground mb-4">{t("book.settings")}</h2>
        <p className="text-xs text-muted-foreground mb-4">{t("book.chapterLengthRangeHint")}</p>
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("book.genre")}</label>
            <GenreFields
              language={bookLanguage}
              value={currentGenre}
              onChange={setSettingsGenre}
              categoryPlaceholder={t("book.genreCategory")}
              detailPlaceholder={t("book.genreDetail")}
              className="flex gap-2"
              selectClassName="px-3 py-2 text-sm rounded-lg border border-border/50 bg-secondary/30 outline-none focus:border-primary/50"
              inputClassName="px-3 py-2 text-sm rounded-lg border border-border/50 bg-secondary/30 outline-none focus:border-primary/50 w-64"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("book.platform")}</label>
            <span className="px-3 py-2 text-sm rounded-lg border border-border/30 text-muted-foreground">{book.platform}</span>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("create.wordsPerChapter")}</label>
            <input
              type="number"
              min={1}
              value={currentWordCount}
              onChange={(e) => setSettingsWordCount(Number(e.target.value))}
              className="px-3 py-2 text-sm rounded-lg border border-border/50 bg-secondary/30 outline-none focus:border-primary/50 w-32"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("book.minChapterLength")}</label>
            <input
              type="number"
              min={1}
              value={currentMinChapterLength}
              placeholder="—"
              onChange={(e) => {
                const raw = e.target.value.trim();
                if (!raw) {
                  setSettingsMinChapterLength(null);
                  setSettingsMinChapterLengthCleared(true);
                  return;
                }
                setSettingsMinChapterLengthCleared(false);
                setSettingsMinChapterLength(Number(raw));
              }}
              className="px-3 py-2 text-sm rounded-lg border border-border/50 bg-secondary/30 outline-none focus:border-primary/50 w-32"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("book.maxChapterLength")}</label>
            <input
              type="number"
              min={1}
              value={currentMaxChapterLength}
              placeholder="—"
              onChange={(e) => {
                const raw = e.target.value.trim();
                if (!raw) {
                  setSettingsMaxChapterLength(null);
                  setSettingsMaxChapterLengthCleared(true);
                  return;
                }
                setSettingsMaxChapterLengthCleared(false);
                setSettingsMaxChapterLength(Number(raw));
              }}
              className="px-3 py-2 text-sm rounded-lg border border-border/50 bg-secondary/30 outline-none focus:border-primary/50 w-32"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("create.targetChapters")}</label>
            <input
              type="number"
              min={1}
              value={currentTargetChapters}
              onChange={(e) => setSettingsTargetChapters(Number(e.target.value))}
              className="px-3 py-2 text-sm rounded-lg border border-border/50 bg-secondary/30 outline-none focus:border-primary/50 w-32"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("book.status")}</label>
            <select
              value={currentStatus}
              onChange={(e) => setSettingsStatus(e.target.value as BookStatus)}
              className="px-3 py-2 text-sm rounded-lg border border-border/50 bg-secondary/30 outline-none focus:border-primary/50"
            >
              <option value="active">{t("book.statusActive")}</option>
              <option value="paused">{t("book.statusPaused")}</option>
              <option value="outlining">{t("book.statusOutlining")}</option>
              <option value="completed">{t("book.statusCompleted")}</option>
              <option value="dropped">{t("book.statusDropped")}</option>
            </select>
          </div>
          <button
            onClick={handleSaveSettings}
            disabled={savingSettings}
            className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:scale-105 active:scale-95 transition-all disabled:opacity-50"
          >
            {savingSettings ? <div className="w-4 h-4 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Save size={14} />}
            {savingSettings ? t("book.saving") : t("book.save")}
          </button>
        </div>
      </div>

      {/* Chapters Table */}
      <TooltipProvider delay={200}>
      <div className="paper-sheet rounded-2xl overflow-hidden border border-border/40 shadow-xl shadow-primary/5">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-muted/30 border-b border-border/50">
                <th className="text-left px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground w-16">#</th>
                <th className="text-left px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground">{t("book.manuscriptTitle")}</th>
                <th className="text-left px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground w-28">{t("book.words")}</th>
                <th className="text-left px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground w-36">
                  <ActionTip label={t("book.review")} description={t("book.reviewTip")}>
                    <span className="cursor-help">{t("book.review")}</span>
                  </ActionTip>
                </th>
                <th className="text-right px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground">
                  <ActionTip label={t("book.curate")} description={t("book.reviseMenuTip")}>
                    <span className="cursor-help">{t("book.curate")}</span>
                  </ActionTip>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {displayedChapters.map((ch, index) => {
                const staggerClass = `stagger-${Math.min(index + 1, 5)}`;
                return (
                <tr key={ch.number} className={`group hover:bg-primary/[0.02] transition-colors fade-in ${staggerClass}`}>
                  <td className="px-6 py-4 text-muted-foreground/60 font-mono text-xs">{ch.number.toString().padStart(2, '0')}</td>
                  <td className="px-6 py-4">
                    <button
                      onClick={() => nav.toChapter(bookId, ch.number)}
                      className="font-serif text-lg font-medium hover:text-primary transition-colors text-left"
                    >
                      {ch.title || t("chapter.label").replace("{n}", String(ch.number))}
                    </button>
                  </td>
                  <td className="px-6 py-4 text-muted-foreground font-medium tabular-nums text-xs">{(ch.wordCount ?? 0).toLocaleString()}</td>
                  <td className="px-6 py-4">
                    <ActionTip label={t("book.review")} description={t("book.reviewTip")}>
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-tight cursor-help ${ch.observations.length > 0 ? "text-amber-600 bg-amber-500/10" : "text-emerald-600 bg-emerald-500/10"}`}>
                        {ch.observations.length > 0
                          ? `${ch.observations.length} ${t("book.observations")}`
                          : t("book.currentRevision")}
                      </span>
                    </ActionTip>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex gap-1.5 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                      <ActionTip label={t("book.audit")} description={t("book.auditTip")}>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              const review = await fetchJson<{ summary?: string; observations?: unknown[] }>(`/books/${bookId}/audit/${ch.number}`, { method: "POST" });
                              alert(`${review.summary ?? t("book.review")}\n${review.observations?.length ?? 0} ${t("book.observations")}`);
                              refetch();
                            } catch (e) {
                              alert(e instanceof Error ? e.message : "Review failed");
                            }
                          }}
                          className={CHAPTER_ACTION_BUTTON_CLASS}
                          aria-label={t("book.audit")}
                        >
                          <ShieldCheck size={14} />
                        </button>
                      </ActionTip>
                      <ActionTip label={t("book.rework")} description={t("book.reworkButtonTip")}>
                        <button
                          type="button"
                          onClick={() => handleRewrite(ch.number)}
                          disabled={rewritingChapters.includes(ch.number)}
                          className={cn(CHAPTER_ACTION_BUTTON_CLASS, "disabled:opacity-50")}
                          aria-label={t("book.rework")}
                        >
                          {rewritingChapters.includes(ch.number)
                            ? <div className="w-3.5 h-3.5 border-2 border-muted-foreground/20 border-t-muted-foreground rounded-full animate-spin" />
                            : <RotateCcw size={14} />}
                        </button>
                      </ActionTip>
                      <ActionTip
                        label={t("book.syncState")}
                        description={ch.number === latestPersistedChapter ? t("book.syncTip") : t("book.syncDisabledTip")}
                      >
                        <button
                          type="button"
                          onClick={() => handleSync(ch.number)}
                          disabled={syncingChapters.includes(ch.number) || ch.number !== latestPersistedChapter}
                          className={cn(CHAPTER_ACTION_BUTTON_CLASS, "disabled:opacity-50")}
                          aria-label={t("book.syncState")}
                        >
                          {syncingChapters.includes(ch.number)
                            ? <div className="w-3.5 h-3.5 border-2 border-muted-foreground/20 border-t-muted-foreground rounded-full animate-spin" />
                            : <RefreshCw size={14} />}
                        </button>
                      </ActionTip>
                      <DropdownMenu>
                        <ActionTip label={t("book.curate")} description={t("book.reviseMenuTip")}>
                          <DropdownMenuTrigger
                            disabled={revisingChapters.includes(ch.number)}
                            className="inline-flex items-center gap-1 px-2 py-1.5 text-[11px] font-bold rounded-lg bg-secondary text-muted-foreground border border-border/50 outline-none hover:text-primary hover:bg-primary/10 transition-all disabled:opacity-50 cursor-pointer"
                            aria-label={t("book.curate")}
                          >
                            {revisingChapters.includes(ch.number) ? t("common.loading") : t("book.curate")}
                            <ChevronDown size={12} />
                          </DropdownMenuTrigger>
                        </ActionTip>
                        <DropdownMenuContent align="end" className="min-w-[18rem] w-72">
                          {REVISE_MODES.map((item) => (
                            <DropdownMenuItem
                              key={item.mode}
                              className="flex-col items-start gap-0.5 py-1.5"
                              onClick={() => handleRevise(ch.number, item.mode)}
                            >
                              <span className="font-medium text-foreground">{t(item.label)}</span>
                              <span className="text-[11px] leading-4 text-muted-foreground whitespace-normal">{t(item.tip)}</span>
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {chapters.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-12 h-12 rounded-full bg-muted/20 flex items-center justify-center mb-4">
               <FileText size={20} className="text-muted-foreground/40" />
            </div>
            <p className="text-sm italic font-serif text-muted-foreground">
              {t("book.noChapters")}
            </p>
          </div>
        )}
      </div>
      </TooltipProvider>

      <ConfirmDialog
        open={confirmDeleteOpen}
        title={t("book.deleteBook")}
        message={t("book.confirmDelete")}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onConfirm={handleDeleteBook}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </div>
  );
}

function ActionTip({
  label,
  description,
  children,
}: {
  readonly label: string;
  readonly description: string;
  readonly children: ReactElement<{ className?: string; disabled?: boolean }>;
}) {
  const disabled = children.props.disabled === true;
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={<span className={cn("inline-flex", disabled && "cursor-not-allowed")} />}
      >
        {disabled ? cloneElement(children, { className: cn(children.props.className, "pointer-events-none") }) : children}
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs flex-col items-start gap-0.5 text-left whitespace-normal">
        <p className="font-semibold">{label}</p>
        <p className="leading-5 opacity-90">{description}</p>
      </TooltipContent>
    </Tooltip>
  );
}

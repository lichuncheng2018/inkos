import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { fetchJson } from "../hooks/use-api";
import type { TFunction } from "../hooks/use-i18n";
import { LOCAL_INSTRUCTION_LIMIT, LOCAL_SELECTION_LIMIT, applyLocalWriting, captureLocalWritingTarget, makeLocalWritingRequest, type LocalWritingTarget } from "../shared/chapter-local-write";

export function ChapterManuscriptEditor({ bookId, chapterNumber, content, onChange, saving, className, autoFocus, t }: {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly content: string;
  readonly onChange: (content: string) => void;
  readonly saving: boolean;
  readonly className: string;
  readonly autoFocus?: boolean;
  readonly t: TFunction;
}) {
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [target, setTarget] = useState<LocalWritingTarget | null>(null);

  const open = () => {
    const editor = editorRef.current;
    if (editor) setTarget(captureLocalWritingTarget(content, editor.selectionStart, editor.selectionEnd));
  };

  const close = () => {
    setTarget(null);
    requestAnimationFrame(() => editorRef.current?.focus({ preventScroll: true }));
  };

  return (
    <div className="flex min-h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 px-2 pt-2">
        <Button type="button" variant="outline" size="sm" disabled={saving} onMouseDown={(event) => event.preventDefault()} onClick={open}>
          <Sparkles size={15} />
          {t("reader.localWrite")}
        </Button>
        <span className="text-sm text-muted-foreground">{t("reader.localWriteHint")}</span>
      </div>
      <textarea
        ref={editorRef}
        aria-label={t("reader.manuscriptPage")}
        value={content}
        onChange={(event) => onChange(event.target.value)}
        className={className}
        autoFocus={autoFocus}
      />
      {target && (
        <ChapterLocalWriteDialog
          endpoint={`/books/${encodeURIComponent(bookId)}/chapters/${chapterNumber}/workspace/local-write`}
          target={target}
          currentDraft={content}
          onApply={(text) => {
            const updated = applyLocalWriting(content, target, text);
            if (updated === null) return;
            onChange(updated);
            close();
          }}
          onClose={close}
          t={t}
        />
      )}
    </div>
  );
}

function ChapterLocalWriteDialog({ endpoint, target, currentDraft, onApply, onClose, t }: {
  readonly endpoint: string;
  readonly target: LocalWritingTarget;
  readonly currentDraft: string;
  readonly onApply: (text: string) => void;
  readonly onClose: () => void;
  readonly t: TFunction;
}) {
  const [instruction, setInstruction] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [generating, setGenerating] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const instructionRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => () => pending.current?.abort(), []);

  const stale = target.draft !== currentDraft;
  const insert = target.start === target.end;
  const oversized = target.end - target.start > LOCAL_SELECTION_LIMIT;
  const request = oversized ? null : makeLocalWritingRequest(target, instruction);

  const generate = async () => {
    if (!request || stale || pending.current !== null) return;
    const controller = new AbortController();
    pending.current = controller;
    setGenerating(true);
    setResult("");
    setError("");
    try {
      const response = await fetchJson<{ text: string }>(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(request),
      });
      if (!controller.signal.aborted) setResult(response.text);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null;
        setGenerating(false);
      }
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent showCloseButton={false} initialFocus={instructionRef} className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t(insert ? "reader.localWriteInsert" : "reader.localWriteReplace")}</DialogTitle>
          <DialogDescription>{t("reader.localWritePreviewHint")}</DialogDescription>
        </DialogHeader>
        {request?.selection && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">{t("reader.localWriteSelection")}</p>
            <div className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border p-3 text-sm">{request.selection}</div>
          </div>
        )}
        <label className="grid gap-2 font-medium">
          {t("reader.localWriteInstruction")}
          <textarea
            ref={instructionRef}
            value={instruction}
            onChange={(event) => { setInstruction(event.target.value); setResult(""); setError(""); }}
            disabled={generating}
            maxLength={LOCAL_INSTRUCTION_LIMIT}
            rows={2}
            placeholder={t("reader.localWritePlaceholder")}
            className="rounded-lg border border-border bg-background p-3 text-sm font-normal focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </label>
        {stale && <p role="alert" className="text-destructive">{t("reader.localWriteStale")}</p>}
        {!request && (
          <p role="alert" className="text-destructive">
            {t(oversized ? "reader.localWriteTooLong" : "reader.localWriteWhitespace")}
          </p>
        )}
        {error && <p role="alert" className="break-words text-destructive">{t("reader.localWriteFailed")} {error}</p>}
        <div aria-live="polite">
          {generating && <p className="text-muted-foreground">{t("reader.localWriteGenerating")}</p>}
          {result && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">{t("reader.localWriteResult")}</p>
              <div className="max-h-52 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-primary/25 p-3 font-serif leading-relaxed">{result}</div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="button" variant={result ? "outline" : "default"} disabled={generating || stale || !request} onClick={() => void generate()}>
            {t(result ? "reader.localWriteRegenerate" : "reader.localWriteGenerate")}
          </Button>
          {result && (
            <Button type="button" disabled={stale} onClick={() => onApply(result)}>{t("reader.localWriteApply")}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";
import { chapterTextForPublish, copyTextToClipboard } from "../lib/chapter-text";

const ICON_CLASS =
  "w-6 h-6 rounded-md inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-muted-foreground disabled:hover:bg-transparent";

export function CopyChapterButton({
  content,
  label,
  copiedLabel,
  failedLabel,
}: {
  readonly content: string;
  readonly label: string;
  readonly copiedLabel: string;
  readonly failedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef(0);

  useEffect(() => () => window.clearTimeout(timeoutRef.current), []);

  const handleCopy = useCallback(async () => {
    try {
      await copyTextToClipboard(chapterTextForPublish(content));
      setCopied(true);
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.alert(failedLabel);
    }
  }, [content, failedLabel]);

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className={ICON_CLASS}
      aria-label={copied ? copiedLabel : label}
      title={copied ? copiedLabel : label}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

export function ChapterPublishActions({
  content,
  hasNext,
  onNext,
  copyLabel,
  copiedLabel,
  copyFailedLabel,
  nextLabel,
  lastLabel,
}: {
  readonly content: string;
  readonly hasNext: boolean;
  readonly onNext: () => void;
  readonly copyLabel: string;
  readonly copiedLabel: string;
  readonly copyFailedLabel: string;
  readonly nextLabel: string;
  readonly lastLabel: string;
}) {
  return (
    <div className="inline-flex items-center gap-0.5">
      <CopyChapterButton
        content={content}
        label={copyLabel}
        copiedLabel={copiedLabel}
        failedLabel={copyFailedLabel}
      />
      <button
        type="button"
        onClick={onNext}
        disabled={!hasNext}
        title={hasNext ? nextLabel : lastLabel}
        aria-label={hasNext ? nextLabel : lastLabel}
        className={ICON_CLASS}
      >
        <ChevronRight size={14} />
      </button>
    </div>
  );
}

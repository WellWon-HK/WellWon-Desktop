"use client";

import {
  memo,
  useState,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type ChatStatus = "ready" | "streaming" | "submitted" | "idle";

export type AttachedImage = {
  id: string;
  filename: string;
  url: string;
  size?: number;
};

export type AttachedFile = {
  id: string;
  filename: string;
  size?: number;
};

export type InputBarProps = {
  onSend?: (message: { role: "user"; content: string }) => void;
  onStop?: () => void;
  status?: ChatStatus;
  placeholder?: string;
  className?: string;
  onAttach?: () => void;
  attachedImages?: AttachedImage[];
  attachedFiles?: AttachedFile[];
  onRemoveImage?: (id: string) => void;
  onRemoveFile?: (id: string) => void;
  value?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Bumping this number refocuses the textarea. Used by the panel
   *  shell to land the cursor in the input every time the window
   *  becomes visible (Option+Space activation). */
  focusVersion?: number;
  leftActions?: ReactNode;
  rightActions?: ReactNode;
};

const PaperclipIcon = ({ className = "w-[18px] h-[18px]" }) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
  </svg>
);

const SendIcon = ({ className = "w-[14px] h-[14px]" }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <line x1="12" y1="19" x2="12" y2="5" />
    <polyline points="5 12 12 5 19 12" />
  </svg>
);

const StopIcon = ({ className = "w-[12px] h-[12px]" }) => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
  >
    <rect x="6" y="6" width="12" height="12" rx="1" />
  </svg>
);

const XIcon = ({ className = "w-3 h-3" }) => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const FileIcon = ({ className = "w-4 h-4" }) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
);

function AttachmentButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="Attach"
      className="inline-flex items-center justify-center w-8 h-8 rounded-full text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors disabled:opacity-40"
    >
      <PaperclipIcon />
    </button>
  );
}

function SendButton({
  state,
  onClick,
}: {
  state: "idle" | "typing" | "streaming";
  onClick: () => void;
}) {
  const isStreaming = state === "streaming";
  const isActive = state === "typing" || isStreaming;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={isStreaming ? "Stop" : "Send"}
      className={cn(
        // Lime accent — matches WellWon brand. Active state shows
        // the full lime; idle state dims it so empty input doesn't
        // look like a primary CTA waiting to fire.
        "inline-flex items-center justify-center w-8 h-8 rounded-full transition-all duration-150",
        isActive
          ? "bg-lime-400 text-black hover:bg-lime-300"
          : "bg-lime-400/30 text-black/40",
      )}
    >
      {isStreaming ? <StopIcon /> : <SendIcon />}
    </button>
  );
}

function ImageChip({
  url,
  onRemove,
}: {
  url: string;
  onRemove?: () => void;
}) {
  return (
    <div className="relative w-12 h-12 rounded-md overflow-hidden bg-neutral-100 dark:bg-neutral-800 group">
      <img src={url} alt="" className="w-full h-full object-cover" />
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove image"
          className="absolute top-0.5 right-0.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-neutral-900/70 text-white opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <XIcon className="w-2.5 h-2.5" />
        </button>
      )}
    </div>
  );
}

function FileChip({
  filename,
  size,
  onRemove,
}: {
  filename: string;
  size?: number;
  onRemove?: () => void;
}) {
  const sizeText =
    size === undefined
      ? null
      : size < 1024
        ? `${size} B`
        : size < 1024 * 1024
          ? `${(size / 1024).toFixed(1)} KB`
          : `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return (
    <div className="inline-flex items-center gap-2 px-2 py-1.5 rounded-md bg-neutral-100 dark:bg-neutral-800 group">
      <span className="text-neutral-500 dark:text-neutral-400">
        <FileIcon />
      </span>
      <div className="flex flex-col min-w-0">
        <span className="text-xs font-medium truncate text-neutral-900 dark:text-neutral-100 max-w-[140px]">
          {filename}
        </span>
        {sizeText && (
          <span className="text-[10px] text-neutral-500 dark:text-neutral-400">
            {sizeText}
          </span>
        )}
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove file"
          className="inline-flex items-center justify-center w-5 h-5 rounded-full text-neutral-500 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <XIcon />
        </button>
      )}
    </div>
  );
}

export const InputBar = memo(function InputBar({
  onSend,
  onStop,
  status = "ready",
  placeholder = "Send a message...",
  className,
  onAttach,
  attachedImages = [],
  attachedFiles = [],
  onRemoveImage,
  onRemoveFile,
  value: controlledValue,
  onChange: controlledOnChange,
  disabled,
  autoFocus,
  focusVersion,
  leftActions,
  rightActions,
}: InputBarProps) {
  const [internalInput, setInternalInput] = useState("");
  const isControlled = controlledValue !== undefined;
  const input = isControlled ? controlledValue : internalInput;
  const setInput = useCallback(
    (v: string) => {
      if (isControlled) controlledOnChange?.(v);
      else setInternalInput(v);
    },
    [isControlled, controlledOnChange],
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isStreaming = status === "streaming" || status === "submitted";
  const hasInput = input.trim().length > 0;
  const hasContextItems =
    attachedImages.length > 0 || attachedFiles.length > 0;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0";
    const next = Math.min(el.scrollHeight, 120);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > 120 ? "auto" : "hidden";
  }, [input]);

  useEffect(() => {
    if (!autoFocus) return;
    textareaRef.current?.focus();
  }, [autoFocus]);

  // Bumping `focusVersion` from the parent re-focuses the textarea —
  // used by the panel shell to land the cursor in the input each
  // time the window becomes visible (Option+Space activation).
  useEffect(() => {
    if (focusVersion === undefined) return;
    textareaRef.current?.focus();
  }, [focusVersion]);

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming || disabled) return;
    onSend?.({ role: "user", content: trimmed });
    setInput("");
  }, [input, isStreaming, disabled, onSend, setInput]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    if (
      e.target === e.currentTarget ||
      !(e.target as HTMLElement).closest("button, textarea")
    ) {
      textareaRef.current?.focus();
    }
  }, []);

  const sendState: "idle" | "typing" | "streaming" = isStreaming
    ? "streaming"
    : hasInput && !disabled
      ? "typing"
      : "idle";

  return (
    <div className={cn("shrink-0 px-3 pb-3 w-full", className)}>
      <div className="w-full">
        <div
          className="relative cursor-text rounded-[16px] bg-white dark:bg-neutral-900 shadow-sm ring-1 ring-neutral-200 dark:ring-neutral-800"
          onClick={handleContainerClick}
        >
          <div
            className={cn(
              "grid transition-[grid-template-rows] duration-200 ease-out",
              hasContextItems ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
            )}
          >
            <div className="overflow-hidden">
              {hasContextItems && (
                <div className="flex flex-wrap items-center gap-1.5 px-2.5 pt-2.5 pb-0.5">
                  {attachedImages.map((img) => (
                    <ImageChip
                      key={img.id}
                      url={img.url}
                      onRemove={
                        onRemoveImage ? () => onRemoveImage(img.id) : undefined
                      }
                    />
                  ))}
                  {attachedFiles.map((file) => (
                    <FileChip
                      key={file.id}
                      filename={file.filename}
                      size={file.size}
                      onRemove={
                        onRemoveFile ? () => onRemoveFile(file.id) : undefined
                      }
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="pt-3 pb-0 pr-3 pl-3.5 min-h-[44px]">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              disabled={disabled}
              rows={1}
              className={cn(
                "w-full resize-none bg-transparent border-0 outline-none text-[14px] leading-[1.6] text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 dark:placeholder:text-neutral-500",
                "overflow-hidden",
                disabled && "opacity-50 cursor-not-allowed",
              )}
            />
          </div>
          <div className="flex items-center justify-between gap-3 px-2 pt-1 pb-2">
            <div className="flex items-center gap-1 min-w-0">
              {onAttach && (
                <AttachmentButton onClick={onAttach} disabled={disabled} />
              )}
              {leftActions}
            </div>
            <div className="flex items-center gap-1">
              {rightActions}
              <SendButton
                state={sendState}
                onClick={() => {
                  if (isStreaming) onStop?.();
                  else if (hasInput) handleSubmit();
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

export default InputBar;

"use client";

// Thinking-block — ported 1:1 from the web at
// components/chat/thinking-block.tsx (variant #8 / single-line shimmer).
//
// Only sizes are adjusted for the compact desktop panel:
//   web font 14px / height 32 → desktop 12.5px / height 26
//   web maxWidth 560 → desktop 100% (no cap, the panel is narrow)
//
// Behaviour matches the web exactly:
//   - One row, the summary text updates as steps stream in.
//   - Slight breathe-opacity while the model is still reasoning.
//   - Click toggles open; the trace renders BELOW the row.
//   - Row STAYS visible after streaming finishes (final answer
//     renders below the thinking row, not as a replacement).

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Brain, BookOpen, FileText, Search, Zap } from "lucide-react";

export interface ThinkingStep {
  type: "think" | "read" | "analyze" | "search" | "execute";
  label: string;
  content: string;
}

const STEP_ICON: Record<
  ThinkingStep["type"],
  React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>
> = {
  think: Brain,
  read: BookOpen,
  analyze: FileText,
  search: Search,
  execute: Zap,
};

interface ThinkingBlockProps {
  steps: ThinkingStep[];
}

function summaryFromSteps(steps: ThinkingStep[]): string {
  if (steps.length === 0) return "Размышляю";
  const last = steps[steps.length - 1];
  const firstSentence =
    (last.content || "")
      .replace(/^\s+/, "")
      .split(/(?<=[.!?])\s+|\n+/)[0]
      ?.trim() ?? "";
  if (firstSentence.length >= 12 && firstSentence.length <= 220) {
    return firstSentence;
  }
  return last.label && last.label !== "Thinking..." ? last.label : "Размышляю";
}

function isStillThinking(steps: ThinkingStep[]): boolean {
  if (steps.length === 0) return true;
  const last = steps[steps.length - 1];
  return /(?:\.{3}|…)$/.test(last.label) || last.content === "...";
}

export function ThinkingBlock({ steps }: ThinkingBlockProps) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;

  const summary = summaryFromSteps(steps);
  const active = isStillThinking(steps);

  return (
    <div style={{ width: "100%", marginBottom: 8 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          maxWidth: "100%",
          height: 26,
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          textAlign: "left",
          color: "rgba(255,255,255,0.78)",
        }}
      >
        <span
          style={{
            minWidth: 0,
            fontSize: 12.5,
            fontWeight: 400,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            color: "rgba(255,255,255,0.55)",
            animation: active ? "thinkingBreathe 1.8s ease-in-out infinite" : undefined,
          }}
        >
          {summary}
        </span>
        <ChevronDown
          size={12}
          color="rgba(255,255,255,0.4)"
          strokeWidth={1.8}
          style={{
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform 200ms ease-out",
            flexShrink: 0,
          }}
        />
      </button>

      {open && <ExpandedTrace steps={steps} />}

      <style>{`
        @keyframes thinkingBreathe {
          0%, 100% { opacity: 0.65; }
          50%      { opacity: 1; }
        }
      `}</style>
    </div>
  );
}

function ExpandedTrace({ steps }: { steps: ThinkingStep[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [steps]);

  return (
    <div
      ref={scrollRef}
      style={{
        marginTop: 6,
        paddingLeft: 12,
        borderLeft: "1px solid rgba(255,255,255,0.08)",
        maxHeight: 240,
        overflowY: "auto",
        scrollbarWidth: "none",
        msOverflowStyle: "none",
      }}
    >
      {steps.map((step, i) => {
        const Icon = STEP_ICON[step.type] ?? Brain;
        return (
          <div key={i} style={{ marginBottom: i === steps.length - 1 ? 0 : 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
              <Icon size={10} color="rgba(255,255,255,0.45)" strokeWidth={1.8} />
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.02em",
                  color: "rgba(255,255,255,0.65)",
                }}
              >
                {step.label}
              </span>
            </div>
            {step.content && step.content !== "..." && (
              <div
                style={{
                  fontSize: 11.5,
                  lineHeight: 1.55,
                  color: "rgba(255,255,255,0.55)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {step.content}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const KNOWN_TYPES = ["think", "read", "analyze", "search", "execute"] as const;
type KnownType = (typeof KNOWN_TYPES)[number];
function asKnownType(s: string): KnownType {
  return (KNOWN_TYPES as readonly string[]).includes(s) ? (s as KnownType) : "think";
}

// Parses AI response content into thinking steps and final response.
// Handles both completed and in-progress (streaming) tags. Mirrors
// web's parseThinkingBlocks; uses matchAll instead of RegExp.exec
// (same semantics, hook-friendly).
export function parseThinkingBlocks(
  content: string,
  options: { finalized?: boolean } = {},
): { steps: ThinkingStep[]; response: string; isThinking: boolean } {
  const steps: ThinkingStep[] = [];
  let response = content;
  let isThinking = false;
  const finalized = !!options.finalized;

  const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
  for (const m of content.matchAll(thinkRegex)) {
    steps.push({ type: "think", label: "Think", content: m[1].trim() });
  }
  response = response.replace(thinkRegex, "");

  const stepRegex = /<step\s+type="(\w+)"\s+label="([^"]*)">([\s\S]*?)<\/step>/g;
  for (const m of content.matchAll(stepRegex)) {
    steps.push({
      type: asKnownType(m[1]),
      label: m[2],
      content: m[3].trim(),
    });
  }
  response = response.replace(stepRegex, "");

  const openThinkMatch = response.match(/<think>([\s\S]*)$/);
  if (openThinkMatch) {
    steps.push({ type: "think", label: "Thinking...", content: openThinkMatch[1].trim() || "..." });
    response = response.replace(/<think>[\s\S]*$/, "");
    isThinking = true;
  }

  const openStepMatch = response.match(/<step\s+type="(\w+)"\s+label="([^"]*)">([\s\S]*)$/);
  if (openStepMatch) {
    steps.push({
      type: asKnownType(openStepMatch[1]),
      label: openStepMatch[2] || "Processing...",
      content: openStepMatch[3].trim() || "...",
    });
    response = response.replace(/<step\s+type="\w+"\s+label="[^"]*">[\s\S]*$/, "");
    isThinking = true;
  }

  response = response.replace(/<(?:think|step)[^>]*$/, "");
  response = response.replace(/^\s*\n+/, "").trim();

  if (finalized && isThinking && !response) {
    const lastStep = steps[steps.length - 1];
    if (lastStep && lastStep.content && lastStep.content !== "...") {
      response = lastStep.content;
      steps.pop();
    }
    isThinking = false;
  }

  return { steps, response, isThinking };
}

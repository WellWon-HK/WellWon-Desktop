// Inline "Web search" indicator — appears above the assistant
// response when the server emitted a <!--SEARCH_META--> prefix.
// Shows a small globe icon + the source domains chip; clicking it
// expands the full list inline.
//
// The web app surfaces sources in a side AgentPanel; the desktop
// panel is too narrow for that, so we render them inline collapsed.

import { useState } from "react";
import { Globe } from "lucide-react";
import type { SearchSource } from "@/lib/chat-stream";

export function WebSearchChip({ sources }: { sources: SearchSource[] }) {
  const [open, setOpen] = useState(false);
  if (sources.length === 0) return null;
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-white/5 hover:bg-white/8 text-[11px] text-zinc-400 transition-colors"
      >
        <Globe size={11} className="text-lime-400" strokeWidth={2} />
        <span>
          Web search · {sources.length} {sources.length === 1 ? "источник" : "источников"}
        </span>
      </button>
      {open && (
        <ol className="mt-1.5 space-y-1 pl-1">
          {sources.map((s, i) => (
            <li key={i} className="text-[11px] text-zinc-400 flex gap-1.5">
              <span className="tabular-nums text-zinc-600 shrink-0">{i + 1}.</span>
              <a
                href={s.url}
                target="_blank"
                rel="noopener"
                className="hover:text-lime-400 underline-offset-2 hover:underline truncate"
                title={s.url}
              >
                {s.title || s.url}
              </a>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

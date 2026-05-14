// Minimal-professional markdown renderer for assistant messages.
//
// Uses react-markdown + remark-gfm. The component overrides every
// element with a tight, panel-sized style to avoid the default
// blog-post look (huge headings, fat margins, big bullets) which
// would dominate the 480-px compact panel.
//
// Visual contract:
//   - 13px body, 1.55 line-height
//   - **bold** → font-weight 600, color white
//   - lists: small dash bullet, modest indent, gap-1 between rows
//   - headings: same body size +600 weight + bottom 4px margin
//   - code: 12px monospaced, subtle dark chip
//   - links: lime underline

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ComponentProps, ReactNode } from "react";

interface Props {
  children: string;
}

export function AssistantMarkdown({ children }: Props) {
  return (
    <div className="text-[13px] leading-relaxed text-zinc-200 break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children: c }) => <p className="mb-2 last:mb-0">{c}</p>,
          strong: ({ children: c }) => <strong className="font-semibold text-white">{c}</strong>,
          em: ({ children: c }) => <em className="italic text-zinc-100">{c}</em>,
          h1: ({ children: c }) => <h1 className="font-semibold text-white mb-1.5 mt-2">{c}</h1>,
          h2: ({ children: c }) => <h2 className="font-semibold text-white mb-1.5 mt-2">{c}</h2>,
          h3: ({ children: c }) => <h3 className="font-semibold text-white mb-1.5 mt-2">{c}</h3>,
          h4: ({ children: c }) => <h4 className="font-semibold text-white mb-1 mt-1.5">{c}</h4>,
          ul: ({ children: c }) => <ul className="space-y-0.5 mb-2 ml-0.5 list-none">{c}</ul>,
          ol: ({ children: c }) => <ol className="space-y-0.5 mb-2 list-decimal list-inside marker:text-zinc-500">{c}</ol>,
          li: (props: ComponentProps<"li"> & { ordered?: boolean }) => {
            // For unordered lists, draw our own tiny dash bullet —
            // looks cleaner than the default disc at 13px.
            if (props.ordered) return <li className="pl-1">{props.children as ReactNode}</li>;
            return (
              <li className="flex gap-2">
                <span className="text-zinc-500 select-none mt-[1px]">—</span>
                <span className="flex-1 min-w-0">{props.children as ReactNode}</span>
              </li>
            );
          },
          code: ({ children: c, ...rest }) => {
            const isInline = !("data-language" in rest);
            if (isInline) {
              return (
                <code className="px-1 py-[1px] rounded bg-white/8 text-zinc-100 font-mono text-[12px]">
                  {c}
                </code>
              );
            }
            return (
              <code className="block p-2 rounded-md bg-black/40 text-zinc-100 font-mono text-[12px] overflow-x-auto">
                {c}
              </code>
            );
          },
          pre: ({ children: c }) => <pre className="mb-2">{c}</pre>,
          a: ({ children: c, href }) => (
            <a href={href} target="_blank" rel="noopener" className="text-lime-400 underline-offset-2 hover:underline">
              {c}
            </a>
          ),
          hr: () => <hr className="my-3 border-white/10" />,
          blockquote: ({ children: c }) => (
            <blockquote className="border-l-2 border-white/15 pl-2.5 my-2 text-zinc-400">
              {c}
            </blockquote>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

import React, { useEffect, useRef } from 'react'
import { MessageSquare, ExternalLink, ImageIcon, FileUp } from 'lucide-react'
import renderMarkdown from './lib/renderMarkdown'
import { enhanceMessages } from './lib/enhanceMessages'

// Phase 7 — read-only viewer for a shared conversation snapshot. Rendered when the app
// loads with ?s=<id>. No composer, no sidebar, no keys — just the frozen messages, with
// the same markdown/code/math rendering as the live chat.
export default function SharedChat({ chat, loading, notFound }) {
  const containerRef = useRef(null)

  // Apply syntax highlighting + math once the snapshot renders (same as the live view).
  useEffect(() => {
    if (chat && containerRef.current) enhanceMessages(containerRef.current)
  }, [chat])

  const messages = chat?.messages || []

  return (
    <div className="flex flex-col h-[100dvh] overflow-x-hidden bg-[var(--bg)] text-[var(--text)]">
      {/* Header */}
      <div className="bg-[var(--surface)] border-[var(--border)] border-b px-3 sm:px-4 py-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <MessageSquare size={18} className="shrink-0 text-[var(--muted)]" />
          <span className="font-medium truncate">{chat?.title || 'Shared chat'}</span>
        </div>
        <a
          href={window.location.pathname}
          className="flex items-center gap-1.5 shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium bg-[var(--accent)] text-[var(--accent-text)] hover:bg-[var(--accent-hover)]"
        >
          <ExternalLink size={15} /> Open FreeGPT
        </a>
      </div>

      {/* Messages */}
      <div ref={containerRef} className="flex-1 overflow-y-auto p-4 space-y-4 bg-[var(--bg)]">
        {loading ? (
          <div className="flex items-center justify-center h-full text-[var(--muted)]">Loading shared chat…</div>
        ) : notFound ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-[var(--muted)] gap-2 px-6">
            <p>This shared chat couldn’t be found.</p>
            <p className="text-sm">The link may be wrong or it was removed.</p>
          </div>
        ) : (
          messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[88%] sm:max-w-[80%] min-w-0 px-4 py-2 rounded-lg break-words ${
                  msg.role === 'user'
                    ? 'bg-[var(--user-bubble)] text-[var(--user-text)]'
                    : 'bg-[var(--assistant-bubble)] text-[var(--assistant-text)]'
                }`}
              >
                {msg.image && <img src={msg.image} alt="" className="max-w-xs rounded mb-2" />}
                {msg.imageOmitted && (
                  <div className="flex items-center gap-1.5 mb-2 text-xs opacity-70">
                    <ImageIcon size={13} /> <span>image not included in share</span>
                  </div>
                )}
                {msg.docName && (
                  <div className="flex items-center gap-1.5 mb-2 text-xs opacity-90">
                    <FileUp size={13} /> <span className="truncate">{msg.docName}</span>
                  </div>
                )}
                {msg.role === 'assistant' ? (
                  <div className="text-sm prose-sm md-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
                ) : (
                  msg.content && <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="bg-[var(--surface)] border-[var(--border)] border-t px-4 py-2 text-center text-xs text-[var(--muted)]">
        Read-only snapshot · FreeGPT
      </div>
    </div>
  )
}

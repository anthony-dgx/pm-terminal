import { useCallback, useEffect, useRef, useState } from 'react'
import { Reader } from './components/Reader.js'
import {
  baseName,
  composeReviewPrompt,
  docTitle,
  type ReviewComment,
  type ReviewRound,
} from './review.js'
import { desk } from './lib/api.js'
import type { MainEvent, Turn } from '../../shared/types.js'

/**
 * The review window: one document, in its own window, on its own.
 *
 * It sends into the conversation the document came from but never starts a
 * session - `session:start` rebinds and disposes, so starting one here would
 * tear down the chat's live session. If the conversation has gone away, that
 * surfaces as an error in the rail rather than silently reviving it.
 */

/** The assistant's answer text for a finished turn. */
function answerOf(turn: Turn): string {
  return turn.blocks
    .filter((b) => b.kind === 'text')
    .map((b) => (b.kind === 'text' ? b.text : ''))
    .join('\n\n')
    .trim()
}

/**
 * The rewritten document inside a reply, or null if the reply is not one.
 *
 * A reply can easily be commentary instead - the agent asked something, or
 * hedged. Swapping that in would destroy the document with no way back, so an
 * implausibly short answer is refused rather than trusted.
 */
export function extractDocument(answer: string, current: string): string | null {
  const lines = answer.trim().split('\n')
  // Find the wrapper fence, then take everything inside it. Three things this
  // has to survive, all seen in real replies:
  //
  // - The document contains its own code block. The close is the LAST fence
  //   that can close this one, not the first, or the document is truncated at
  //   its first code block - which the length check below is far too loose to
  //   notice.
  // - There is commentary around the document. A labelled ```markdown fence can
  //   start well below line one, and ignoring it bakes the preamble in.
  // - The wrapper is longer than three backticks. That is what the agent does
  //   when the document has a fence of its own, and a three-only pattern misses
  //   it and renders the whole document as one code block.
  const fence = (line: string): { mark: string; label: string } | null => {
    const m = /^(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/.exec(line ?? '')
    return m ? { mark: m[1], label: m[2].toLowerCase() } : null
  }
  let open = lines.findIndex((l) => {
    const f = fence(l)
    return !!f && (f.label === 'md' || f.label === 'markdown')
  })
  // A ```markdown fence below the top can be the wrapper, after a line or two of
  // preamble, or it can be an example nested inside an unwrapped document. Told
  // apart by how much text sits above it: a preamble is a sentence, a document
  // is not. Guess wrong the second way and the document becomes the fragment.
  if (open > 0 && lines.slice(0, open).join('\n').trim().length > 400) open = -1
  if (open === -1 && fence(lines[0])?.label === '') open = 0
  let close = -1
  if (open !== -1) {
    const wrapper = fence(lines[open])!
    for (let i = lines.length - 1; i > open; i--) {
      const f = fence(lines[i])
      // CommonMark: a closing fence carries no label and is at least as long.
      if (f && f.label === '' && f.mark[0] === wrapper.mark[0] && f.mark.length >= wrapper.mark.length) {
        close = i
        break
      }
    }
  }
  const body = (close > open ? lines.slice(open + 1, close) : lines).join('\n').trim()
  if (!body) return null
  // Prose replies to a review are short next to the document they discuss.
  if (body.length < Math.min(400, current.length * 0.4)) return null
  return body
}

type Status = { kind: 'idle' } | { kind: 'waiting' } | { kind: 'error'; text: string }

export function ReaderWindow(): React.ReactElement {
  const [clientId, setClientId] = useState<string | null>(null)
  const [title, setTitle] = useState('Document')
  const [snapshot, setSnapshot] = useState<string | null>(null)
  /** Set only for a document opened off disk. Edits go back to this file. */
  const [path, setPath] = useState<string | undefined>(undefined)
  const [saveNote, setSaveNote] = useState<string | null>(null)
  const [comments, setComments] = useState<ReviewComment[]>([])
  const [rounds, setRounds] = useState<ReviewRound[]>([])
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [reply, setReply] = useState<string | null>(null)

  // Read in the event handler, which is registered once and must not go stale.
  // Also the guard that makes the handler ignore replies to anything the chat
  // window sent, since a session's events reach every window.
  const pending = useRef(false)
  const snapRef = useRef('')
  snapRef.current = snapshot ?? ''
  const pathRef = useRef<string | undefined>(undefined)
  pathRef.current = path

  /**
   * Write the document back to the file it came from.
   *
   * A no-op for a document that came out of the chat, which has no file. That
   * document still edits - the change lives in this window and rides into the
   * next round with your comments - it just has nowhere to be saved.
   */
  const save = useCallback((text: string): void => {
    const p = pathRef.current
    if (!p) return
    desk
      .writeMarkdown(p, text)
      .then(() => setSaveNote(`Saved to ${baseName(p)}`))
      .catch((err: Error) => {
        // IPC wraps the rejection in its own frame; the sentence the main
        // process wrote is the last one and the only useful part.
        const reason = err.message.split(/Error:\s*/).pop() ?? err.message
        setSaveNote(`Could not save: ${reason}`)
      })
  }, [])

  useEffect(() => {
    void (async () => {
      const doc = await desk.readerDoc()
      if (!doc) {
        setStatus({ kind: 'error', text: 'This window was opened without a document.' })
        return
      }
      setClientId(doc.clientId)
      setTitle(doc.title)
      setSnapshot(doc.snapshot)
      setPath(doc.path)
      if (doc.path) setSaveNote(`Editing ${baseName(doc.path)}`)
      // The window title, and what the debugger targets, both come from here.
      document.title = `Review - ${doc.title}`
      const env = await desk.env()
      document.documentElement.dataset.theme = env.theme
    })()
  }, [])

  // The reply lands here, not in the chat window, because the main process
  // broadcasts a session's events to every window.
  useEffect(() => {
    if (!clientId) return
    return desk.onEvent((id: string, e: MainEvent) => {
      if (id !== clientId) return
      if (e.type === 'notice' && e.level === 'error') {
        setStatus({ kind: 'error', text: e.text })
        pending.current = false
        return
      }
      if (e.type !== 'turn') return
      if (e.turn.role !== 'assistant' || e.turn.streaming !== false) return
      if (!pending.current) return
      pending.current = false

      const answer = answerOf(e.turn)
      const next = extractDocument(answer, snapRef.current)
      if (!next) {
        setReply(answer)
        setStatus({
          kind: 'error',
          text: 'The reply did not contain a document, so the one here is unchanged.',
        })
        return
      }
      setSnapshot(next)
      // A file-backed document is a view on the file, so a round that rewrites
      // it lands on disk too. Leaving the file at the pre-review version would
      // mean the window and the file quietly disagree.
      save(next)
      const heading = docTitle(next, title)
      setTitle(heading)
      document.title = `Review - ${heading}`
      setReply(null)
      setStatus({ kind: 'idle' })
    })
  }, [clientId, title, save])

  const send = useCallback(
    (): void => {
      if (!clientId || !comments.length || snapshot === null) return
      setRounds((r) => [...r, { at: new Date().toISOString(), comments }])
      setComments([])
      setReply(null)
      setStatus({ kind: 'waiting' })
      pending.current = true
      // The snapshot goes with the comments. It is not safe to assume the agent
      // still has this text: it may have been read off disk rather than written
      // in the chat, and either way it may have been edited here since.
      desk.send(clientId, composeReviewPrompt(comments, snapshot)).catch((err: Error) => {
        pending.current = false
        setStatus({
          kind: 'error',
          text: /no session/i.test(err.message)
            ? 'That conversation is no longer running. Reopen it in the main window and send again.'
            : err.message,
        })
      })
    },
    [clientId, comments, snapshot],
  )

  if (status.kind === 'error' && snapshot === null) {
    return <div className="reader-boot is-error">{status.text}</div>
  }
  if (snapshot === null) return <div className="reader-boot">Loading document...</div>

  return (
    <Reader
      doc={{ title, snapshot, comments, path }}
      rounds={rounds}
      onChange={setComments}
      onEdit={(next, moved) => {
        setSnapshot(next)
        setComments(moved)
        save(next)
      }}
      saveNote={saveNote}
      onSend={send}
      onClose={() => window.close()}
      busy={status.kind === 'waiting'}
      standalone
      waiting={status.kind === 'waiting'}
      error={status.kind === 'error' ? status.text : null}
      reply={reply}
      onDismissReply={() => {
        setReply(null)
        setStatus((s) => (s.kind === 'error' ? { kind: 'idle' } : s))
      }}
    />
  )
}
